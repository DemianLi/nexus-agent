//! 插件 `mcp`：apply 時起一座 [`Bridge`]，expose 過橋的服務 [`SERVICE`]，讓對話行程經宿主連線用 HTTP 與 stdio 的 MCP server。
//!
//! 設定：`{ "roots": <PEM 檔路徑>, "proxy"?: <ProxyPolicy> }`。根憑證只信這個檔（[`crate::tls`]），代理照 [`crate::proxy`]。
//!
//! | 方法 | 種類 | payload | 做什麼 |
//! | --- | --- | --- | --- |
//! | `open` | 串流 | `{ "server": <一台 server 的設定>, "elicitation"?: bool }` | 向池取這份設定的連線，送清單，之後一直掛著當綁定 |
//! | `call` | 串流 | `{ "open": <同一條連線上 open 的呼叫編號>, "method": <方法>, "params": <JSON 文字> }` | 送一次請求到那份連線，送回結果 |
//!
//! **MCP 的酬載一律是 JSON 文字**，切成字串塊送：宿主的框有巢狀與大小上限，MCP 的酬載不受它們限。
//!
//! - `open` 的塊：先是一份 JSON 文字 `{"tools": [...], "instructions": "...", "warning": "..." | null}` 切成的字串塊，接著一塊
//!   `{"ready": {"chunks": n, "bytes": b}}`（物件，跟字串塊分得開；`n`、`b` 是前面字串塊的塊數與 UTF-8 位元組數），之後不再送塊、
//!   不收尾，直到呼叫端取消或斷線，那時放掉綁定。取用失敗（寫了 `failOnStartupError`）以服務的錯收尾。
//! - `call` 的塊：server 回的結果的 JSON 文字切成的字串塊；收尾的值是 `{"chunks": n, "bytes": b}`。`method` 只收
//!   [`REQUEST_METHODS`]，`open` 要指到同一條連線上已經送出 `ready` 的綁定。呼叫端取消就送 `notifications/cancelled` 給 server。
//! - 切塊在 UTF-8 字元的邊界上，一塊最多 [`PIECE_BYTES`] 位元組，一步最多送 [`PIECES_PER_STEP`] 塊：一塊編成框最壞是 6 倍
//!   （控制字元寫成 `\u00XX`）加上框頭，仍小於一框；一步四塊仍小於宿主一步的上限（`crate::host::calls::OUTBOX_PAUSE`）。
//! - 一份 JSON 文字最多 [`MAX_TEXT_BYTES`]，跟 server 一則回應的上限相同；超過的以服務的錯收尾，不送任何塊。
//! - 橋的日誌（監督者的進度與放棄）寫 stderr，前綴 `nexus-host: mcp`。
//! - 卸載時丟掉橋：送收橋、不等它收完（宿主結束時不卸載插件，連線隨行程結束）。

use std::collections::{HashMap, VecDeque};
use std::os::fd::RawFd;
use std::path::PathBuf;
use std::time::Instant;

use super::bridge::{Bridge, Command, Opened, Outcome, REQUEST_METHODS};
use super::config::Server;
use super::connection::MAX_RESPONSE_BYTES;
use crate::json::Value;
use crate::kernel::{
    Applied, CallKey, ConfigError, Cx, Fault, Fields, MethodKind, Plugin, PluginError, Progress,
    Remote, Service, Spec,
};
use crate::proxy::ProxyPolicy;
use crate::tls::{client_config, http_client};

pub static SPEC: Spec = Spec {
    name: "mcp",
    inject: &[],
    required: false,
    build,
};

/// 過橋的服務名。
pub const SERVICE: &str = "mcp/client";
/// 一塊字串最多幾個 UTF-8 位元組。
pub const PIECE_BYTES: usize = 32 * 1024;
/// 一步最多送幾塊。
pub const PIECES_PER_STEP: usize = 4;
/// 一份 JSON 文字最多幾個位元組。
pub const MAX_TEXT_BYTES: usize = MAX_RESPONSE_BYTES;

/// 把 `text` 在 UTF-8 字元的邊界上切成每塊最多 `max` 位元組（`max` 至少 4）。空字串切成零塊。
pub fn pieces(text: &str, max: usize) -> VecDeque<String> {
    let mut out = VecDeque::new();
    let mut rest = text;
    while !rest.is_empty() {
        let mut end = rest.len().min(max);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (head, tail) = rest.split_at(end);
        out.push_back(head.to_string());
        rest = tail;
    }
    out
}

/// 正在分步送的一份 JSON 文字。
struct Sending {
    pieces: VecDeque<String>,
    chunks: u64,
    bytes: u64,
}

impl Sending {
    fn new(text: &str) -> Result<Sending, String> {
        if text.len() > MAX_TEXT_BYTES {
            return Err(format!(
                "結果有 {} 位元組，超過上限 {MAX_TEXT_BYTES}",
                text.len()
            ));
        }
        Ok(Sending {
            pieces: pieces(text, PIECE_BYTES),
            chunks: 0,
            bytes: 0,
        })
    }

    /// 送這一步的塊；送完了回 `true`。
    fn step(&mut self, chunks: &mut Vec<Value>) -> bool {
        for _ in 0..PIECES_PER_STEP {
            let Some(piece) = self.pieces.pop_front() else {
                break;
            };
            self.chunks += 1;
            self.bytes += piece.len() as u64;
            chunks.push(Value::String(piece));
        }
        self.pieces.is_empty()
    }

    fn summary(&self) -> Value {
        serde_json::json!({ "chunks": self.chunks, "bytes": self.bytes })
    }
}

enum OpenPhase {
    Waiting,
    Arrived(Result<Opened, String>),
    Sending(Sending),
    Bound,
}

struct Open {
    bridge: u64,
    phase: OpenPhase,
}

enum CallPhase {
    Waiting,
    Arrived(Result<String, String>),
    Sending(Sending),
}

struct Request {
    bridge: u64,
    phase: CallPhase,
}

/// 過橋的服務：`open`／`call` 對到橋上的綁定與請求。
pub struct Client {
    bridge: Bridge,
    next: u64,
    opens: HashMap<CallKey, Open>,
    requests: HashMap<CallKey, Request>,
    /// 橋上的編號對回宿主那一次呼叫。
    by_bridge: HashMap<u64, CallKey>,
}

impl Service for Client {
    const NAME: &'static str = SERVICE;
}

impl Client {
    fn new(bridge: Bridge) -> Client {
        Client {
            bridge,
            next: 0,
            opens: HashMap::new(),
            requests: HashMap::new(),
            by_bridge: HashMap::new(),
        }
    }

    fn next_id(&mut self, key: CallKey) -> u64 {
        self.next += 1;
        self.by_bridge.insert(self.next, key);
        self.next
    }

    fn start_open(&mut self, key: CallKey, payload: &Value) -> Progress {
        let Some(server) = payload.get("server") else {
            return Progress::Err(Fault::BadPayload, "缺少 server".into());
        };
        let elicitation = match payload.get("elicitation") {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(_) => return Progress::Err(Fault::BadPayload, "elicitation 要是布林".into()),
        };
        if let Some(extra) = unknown_field(payload, &["server", "elicitation"]) {
            return Progress::Err(Fault::BadPayload, format!("open 不認得的欄位 {extra}"));
        }
        let server = match Server::parse(server) {
            Ok(server) => Box::new(server),
            Err(error) => return Progress::Err(Fault::BadPayload, error),
        };
        let open = self.next_id(key);
        self.bridge.send(Command::Open {
            open,
            server,
            elicitation,
        });
        self.opens.insert(
            key,
            Open {
                bridge: open,
                phase: OpenPhase::Waiting,
            },
        );
        Progress::Pending
    }

    fn start_call(&mut self, key: CallKey, payload: &Value) -> Progress {
        let Some(open) = payload.get("open").and_then(Value::as_u64) else {
            return Progress::Err(Fault::BadPayload, "open 要是非負整數".into());
        };
        let Some(method) = payload.get("method").and_then(Value::as_str) else {
            return Progress::Err(Fault::BadPayload, "method 要是字串".into());
        };
        if !REQUEST_METHODS.contains(&method) {
            return Progress::Err(Fault::BadPayload, format!("不支援的方法 {method}"));
        }
        let Some(params) = payload.get("params").and_then(Value::as_str) else {
            return Progress::Err(Fault::BadPayload, "params 要是 JSON 文字".into());
        };
        if let Some(extra) = unknown_field(payload, &["open", "method", "params"]) {
            return Progress::Err(Fault::BadPayload, format!("call 不認得的欄位 {extra}"));
        }
        let params: Value = match serde_json::from_str(params) {
            Ok(params) => params,
            Err(error) => {
                return Progress::Err(Fault::BadPayload, format!("params 解不開：{error}"))
            }
        };
        let target = CallKey {
            conn: key.conn,
            id: open,
        };
        let bound = match self.opens.get(&target) {
            Some(Open {
                bridge,
                phase: OpenPhase::Bound,
            }) => *bridge,
            _ => {
                return Progress::Err(
                    Fault::BadPayload,
                    format!("這條連線上沒有已經 ready 的綁定 {open}"),
                )
            }
        };
        let id = self.next_id(key);
        self.bridge.send(Command::Request {
            id,
            open: bound,
            method: method.to_string(),
            params,
        });
        self.requests.insert(
            key,
            Request {
                bridge: id,
                phase: CallPhase::Waiting,
            },
        );
        Progress::Pending
    }

    fn poll_open(&mut self, key: CallKey, chunks: &mut Vec<Value>) -> Progress {
        let Some(open) = self.opens.get_mut(&key) else {
            return Progress::Err(Fault::Failed, "不認得這一次呼叫".into());
        };
        if let OpenPhase::Arrived(_) = open.phase {
            let OpenPhase::Arrived(result) = std::mem::replace(&mut open.phase, OpenPhase::Waiting)
            else {
                unreachable!()
            };
            match result.and_then(|opened| Sending::new(&document(&opened))) {
                Ok(sending) => open.phase = OpenPhase::Sending(sending),
                Err(error) => {
                    let bridge = open.bridge;
                    self.forget_open(key, bridge);
                    return Progress::Err(Fault::Failed, error);
                }
            }
        }
        if let OpenPhase::Sending(sending) = &mut open.phase {
            if sending.step(chunks) && chunks.len() < PIECES_PER_STEP {
                chunks.push(serde_json::json!({ "ready": sending.summary() }));
                open.phase = OpenPhase::Bound;
            }
        }
        Progress::Pending
    }

    fn poll_call(&mut self, key: CallKey, chunks: &mut Vec<Value>) -> Progress {
        let Some(request) = self.requests.get_mut(&key) else {
            return Progress::Err(Fault::Failed, "不認得這一次呼叫".into());
        };
        if let CallPhase::Arrived(_) = request.phase {
            let CallPhase::Arrived(result) =
                std::mem::replace(&mut request.phase, CallPhase::Waiting)
            else {
                unreachable!()
            };
            match result.and_then(|text| Sending::new(&text)) {
                Ok(sending) => request.phase = CallPhase::Sending(sending),
                Err(error) => {
                    self.forget_request(key);
                    return Progress::Err(Fault::Failed, error);
                }
            }
        }
        let CallPhase::Sending(sending) = &mut request.phase else {
            return Progress::Pending;
        };
        if !sending.step(chunks) {
            return Progress::Pending;
        }
        let summary = sending.summary();
        self.forget_request(key);
        Progress::Ok(summary)
    }

    /// 放掉一個綁定：橋上那個編號也忘掉。
    fn forget_open(&mut self, key: CallKey, bridge: u64) {
        self.opens.remove(&key);
        self.by_bridge.remove(&bridge);
        self.bridge.send(Command::Release { open: bridge });
    }

    fn forget_request(&mut self, key: CallKey) {
        if let Some(request) = self.requests.remove(&key) {
            self.by_bridge.remove(&request.bridge);
        }
    }

    fn deliver(&mut self, outcome: Outcome) {
        match outcome {
            Outcome::Opened { open, result } => {
                let target = self.by_bridge.get(&open).copied();
                match target.and_then(|key| self.opens.get_mut(&key)) {
                    Some(entry) => entry.phase = OpenPhase::Arrived(result),
                    // 呼叫端在取用落定之前就取消了：橋那邊已經記下，要放掉。
                    None => self.bridge.send(Command::Release { open }),
                }
            }
            Outcome::Done { id, result } => {
                let target = self.by_bridge.get(&id).copied();
                if let Some(request) = target.and_then(|key| self.requests.get_mut(&key)) {
                    request.phase = CallPhase::Arrived(result);
                }
            }
            Outcome::Log { error, line } => {
                let level = if error { "錯誤" } else { "資訊" };
                eprintln!("nexus-host: mcp {level}：{line}");
            }
            Outcome::Closed => {}
        }
    }
}

/// `open` 送的那一份 JSON 文字。`tools` 已經是 JSON 文字，原樣嵌進去，不再解一次。
fn document(opened: &Opened) -> String {
    let instructions = serde_json::to_string(&opened.instructions).unwrap_or_default();
    let warning = serde_json::to_string(&opened.warning).unwrap_or_default();
    format!(
        r#"{{"tools":{},"instructions":{instructions},"warning":{warning}}}"#,
        opened.tools
    )
}

fn unknown_field<'a>(payload: &'a Value, known: &[&str]) -> Option<&'a str> {
    payload
        .as_object()?
        .keys()
        .map(String::as_str)
        .find(|k| !known.contains(k))
}

impl Remote for Client {
    fn method(&self, name: &str) -> Option<MethodKind> {
        matches!(name, "open" | "call").then_some(MethodKind::Stream)
    }

    fn start(
        &mut self,
        key: CallKey,
        method: &str,
        payload: Value,
        _now: Instant,
        _chunks: &mut Vec<Value>,
    ) -> Progress {
        if !payload.is_object() {
            return Progress::Err(Fault::BadPayload, "payload 要是物件".into());
        }
        match method {
            "open" => self.start_open(key, &payload),
            "call" => self.start_call(key, &payload),
            _ => Progress::Err(Fault::Failed, "沒有這個方法".into()),
        }
    }

    fn poll(&mut self, key: CallKey, _now: Instant, chunks: &mut Vec<Value>) -> Progress {
        if self.opens.contains_key(&key) {
            self.poll_open(key, chunks)
        } else {
            self.poll_call(key, chunks)
        }
    }

    fn cancel(&mut self, key: CallKey) {
        if let Some(bridge) = self.opens.get(&key).map(|open| open.bridge) {
            self.forget_open(key, bridge);
        }
        if let Some(request) = self.requests.get(&key) {
            self.bridge.send(Command::Cancel { id: request.bridge });
            self.forget_request(key);
        }
    }

    fn wake_fd(&self) -> Option<RawFd> {
        Some(self.bridge.wake_fd())
    }

    fn woken(&mut self) {
        for outcome in self.bridge.take() {
            self.deliver(outcome);
        }
    }
}

struct Plug {
    roots: PathBuf,
    proxy: ProxyPolicy,
}

fn build(value: &Value) -> Result<Box<dyn Plugin>, ConfigError> {
    let mut fields = Fields::new(value)?;
    let roots = PathBuf::from(fields.str("roots")?);
    let proxy = match fields.value("proxy") {
        None => ProxyPolicy::direct(),
        Some(proxy) => ProxyPolicy::parse(proxy).map_err(ConfigError)?,
    };
    fields.finish()?;
    Ok(Box::new(Plug { roots, proxy }))
}

impl Plugin for Plug {
    fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
        let config = client_config(&self.roots).map_err(PluginError)?;
        let http = http_client(config, &self.proxy).map_err(PluginError)?;
        let bridge = Bridge::start(http, self.proxy.secrets())
            .map_err(|error| PluginError(format!("MCP 的橋起不來：{error}")))?;
        cx.expose(Client::new(bridge))?;
        Ok(Applied::Done)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 切在字元邊界上_接回來不變() {
        // 「中」是三個位元組：每塊四個位元組時，切點會落在字元中間。
        let text = "a中中中\"\\é\u{1F600}x".repeat(50);
        let parts = pieces(&text, 4);
        assert!(parts.iter().all(|p| !p.is_empty() && p.len() <= 4));
        assert_eq!(parts.iter().map(String::as_str).collect::<String>(), text);
        assert!(pieces("", 4).is_empty());
    }

    #[test]
    fn 最壞的塊編成框仍小於一框_一步仍小於上限() {
        use crate::host::calls::OUTBOX_PAUSE;
        use crate::host_protocol::{encode_host_message, HostMessage, Side, MAX_FRAME};
        let worst = "\u{1}".repeat(PIECE_BYTES);
        let frame = encode_host_message(&HostMessage::Chunk {
            side: Side::Client,
            id: u64::MAX,
            seq: u64::MAX,
            payload: Value::String(worst),
        });
        assert!(frame.len() <= MAX_FRAME, "{}", frame.len());
        assert!(frame.len() * PIECES_PER_STEP <= OUTBOX_PAUSE);
    }

    #[test]
    fn 清單文件是合法的_json() {
        let opened = Opened {
            tools: r#"[{"name":"a"}]"#.into(),
            instructions: "說明\n\"引號\"".into(),
            warning: Some("連不上".into()),
        };
        let value: Value = serde_json::from_str(&document(&opened)).expect("JSON");
        assert_eq!(value["tools"][0]["name"], "a");
        assert_eq!(value["instructions"], "說明\n\"引號\"");
        assert_eq!(value["warning"], "連不上");
    }
}
