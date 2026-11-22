//! 手寫的 Streamable HTTP MCP server，掛在 [`super::TlsServer`] 上：每個 POST 回一則 `application/json`；
//! 開了 [`FakeMcp::sse`] 就改把那一則包成一個 SSE 事件回（`text/event-stream`）。
//! `tools/call` 呼叫名叫 `slow` 的工具時先睡 3 秒（測逾時與取消）；叫 `big` 時回一段 `arguments.bytes` 位元組的文字，
//! 由 [`BIG_PATTERN`] 重複而成（引號、反斜線與多位元組字元都有）；叫 `odd` 時回 [`odd_result`]（規格外的欄位與內容區塊型別）。
//! 新協定答 `server/discover`；舊協定對 `server/discover` 回「方法不存在」，客戶端退回 `initialize`。
//! 給了 [`FakeMcp::sessions`]，舊協定的 `initialize` 發 `fake-session-N`，之後帶著別的 session id 的 POST 回 404（模擬 server 重啟、忘掉 session）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::{Handler, Request, Response};

/// 這台假 server 怎麼回。
#[derive(Clone, Default)]
pub struct FakeMcp {
    /// 講新協定（`server/discover`）。
    pub modern: bool,
    /// `tools/list` 的分頁：cursor（第一頁是空字串）→（工具名, 下一頁的 cursor）。
    pub pages: HashMap<String, (Vec<String>, Option<String>)>,
    pub instructions: Option<String>,
    /// `tools/list` 一律回 JSON-RPC 錯誤。
    pub list_fails: bool,
    /// 回應改用 SSE：一則回應一個 `message` 事件。
    pub sse: bool,
    /// 舊協定的 session 帳；`None` 就不發、不查 session id。
    pub sessions: Option<Arc<Sessions>>,
}

/// 舊協定 server 的 session 帳：`initialize` 發 `fake-session-N`，只有最近發的、沒被 [`Sessions::forget`] 的那一個有效。
#[derive(Default)]
pub struct Sessions {
    issued: AtomicU64,
    valid: AtomicU64,
    reject_all: AtomicBool,
}

impl Sessions {
    /// server 重啟、忘掉所有 session：之後帶舊 session id 的 POST 回 404，新的 `initialize` 發新的。
    pub fn forget(&self) {
        self.valid.store(0, Ordering::SeqCst);
    }

    /// 之後發出去的 session 也一律無效：每個帶 session id 的 POST 都回 404。
    pub fn reject_all(&self) {
        self.reject_all.store(true, Ordering::SeqCst);
    }

    /// 已經發了幾個 session。
    pub fn issued(&self) -> u64 {
        self.issued.load(Ordering::SeqCst)
    }

    fn issue(&self) -> String {
        let n = self.issued.fetch_add(1, Ordering::SeqCst) + 1;
        if !self.reject_all.load(Ordering::SeqCst) {
            self.valid.store(n, Ordering::SeqCst);
        }
        format!("fake-session-{n}")
    }

    fn accepts(&self, id: &str) -> bool {
        let n = id
            .strip_prefix("fake-session-")
            .and_then(|n| n.parse::<u64>().ok());
        !self.reject_all.load(Ordering::SeqCst)
            && n.is_some_and(|n| n == self.valid.load(Ordering::SeqCst))
    }
}

impl FakeMcp {
    /// 一頁、這些工具。
    pub fn with_tools(modern: bool, tools: &[&str]) -> FakeMcp {
        let mut pages = HashMap::new();
        pages.insert(
            String::new(),
            (tools.iter().map(|t| t.to_string()).collect(), None),
        );
        FakeMcp {
            modern,
            pages,
            ..FakeMcp::default()
        }
    }
}

/// `big` 的文字一段一段重複的內容：6 個位元組。
pub const BIG_PATTERN: &str = "\"\\中x";

/// `big` 回的文字：`bytes` 無條件捨去到 [`BIG_PATTERN`] 長度的倍數。
pub fn big_text(bytes: usize) -> String {
    BIG_PATTERN.repeat(bytes / BIG_PATTERN.len())
}

/// `odd` 回的結果：頂層與內容區塊各多一個欄位，`arguments.unknown` 為真時再加一個不認得型別的內容區塊。
pub fn odd_result(unknown: bool) -> Value {
    let mut content = vec![json!({ "type": "text", "text": "t", "extra": 1 })];
    if unknown {
        content.push(json!({ "type": "x-future", "data": "d" }));
    }
    json!({ "content": content, "isError": false, "x-top": 2 })
}

fn tool(name: &str) -> Value {
    // 鍵故意不照字母順序：過橋之後要照 server 送的順序。
    let schema: Value =
        serde_json::from_str(r#"{"type":"object","properties":{"zeta":{},"alpha":{}}}"#)
            .expect("JSON");
    json!({ "name": name, "description": format!("tool {name}"), "inputSchema": schema })
}

fn reply(id: &Value, body: Value) -> Response {
    let mut message = json!({ "jsonrpc": "2.0", "id": id });
    let key = if body.get("code").is_some() {
        "error"
    } else {
        "result"
    };
    message[key] = body;
    Response::new(200, "application/json", message.to_string())
}

/// 記下每個請求、照 `fake` 回。
pub fn handler(fake: FakeMcp, log: Arc<Mutex<Vec<Request>>>) -> Handler {
    Arc::new(move |request: &Request| {
        log.lock().expect("鎖").push(request.clone());
        let response = respond(&fake, request);
        let json = response
            .headers
            .iter()
            .any(|(k, v)| k == "Content-Type" && v == "application/json");
        if !(fake.sse && json) {
            return response;
        }
        let mut body = b"event: message\ndata: ".to_vec();
        body.extend_from_slice(&response.body);
        body.extend_from_slice(b"\n\n");
        let mut sse = Response::new(response.status, "text/event-stream", body);
        sse.headers.extend(
            response
                .headers
                .into_iter()
                .filter(|(k, _)| k != "Content-Type"),
        );
        sse
    })
}

fn respond(fake: &FakeMcp, request: &Request) -> Response {
    match request.method.as_str() {
        "POST" => {}
        "DELETE" => return Response::empty(200),
        _ => return Response::empty(405),
    }
    let Ok(message) = serde_json::from_slice::<Value>(&request.body) else {
        return Response::empty(400);
    };
    if let (Some(sessions), Some(id)) = (&fake.sessions, request.header("mcp-session-id")) {
        if !sessions.accepts(id) {
            return Response::empty(404);
        }
    }
    let Some(id) = message.get("id") else {
        return Response::empty(202);
    };
    let method = message["method"].as_str().unwrap_or("");
    let params = &message["params"];
    let complete = |mut result: Value| {
        if fake.modern {
            result["resultType"] = json!("complete");
        }
        result
    };
    match method {
        "server/discover" if fake.modern => {
            let mut result = json!({
                "resultType": "complete",
                "supportedVersions": ["2026-07-28"],
                "capabilities": { "tools": {} },
                "ttlMs": 0,
                "cacheScope": "private",
                "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "fake", "version": "0" } },
            });
            if let Some(text) = &fake.instructions {
                result["instructions"] = json!(text);
            }
            reply(id, result)
        }
        "initialize" if !fake.modern => {
            let mut result = json!({
                "protocolVersion": "2025-11-25",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "fake", "version": "0" },
            });
            if let Some(text) = &fake.instructions {
                result["instructions"] = json!(text);
            }
            let mut response = reply(id, result);
            let session = fake
                .sessions
                .as_ref()
                .map_or("fake-session".into(), |s| s.issue());
            response.headers.push(("Mcp-Session-Id".into(), session));
            response
        }
        "tools/list" if fake.list_fails => {
            reply(id, json!({ "code": -32603, "message": "list exploded" }))
        }
        "tools/list" => {
            let cursor = params["cursor"].as_str().unwrap_or("");
            let Some((names, next)) = fake.pages.get(cursor) else {
                return reply(id, json!({ "code": -32602, "message": "bad cursor" }));
            };
            let mut result = json!({ "tools": names.iter().map(|n| tool(n)).collect::<Vec<_>>() });
            if let Some(next) = next {
                result["nextCursor"] = json!(next);
            }
            reply(id, complete(result))
        }
        "tools/call" if params["name"] == "odd" => reply(
            id,
            complete(odd_result(params["arguments"]["unknown"] == true)),
        ),
        "tools/call" => {
            if params["name"] == "slow" {
                std::thread::sleep(std::time::Duration::from_secs(3));
            }
            let text = if params["name"] == "big" {
                big_text(params["arguments"]["bytes"].as_u64().unwrap_or(0) as usize)
            } else {
                format!("{}:{}", params["name"], params["arguments"])
            };
            reply(
                id,
                complete(
                    json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
                ),
            )
        }
        _ => reply(id, json!({ "code": -32601, "message": "Method not found" })),
    }
}
