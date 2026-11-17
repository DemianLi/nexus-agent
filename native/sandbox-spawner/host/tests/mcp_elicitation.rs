//! 反問（elicitation）的多輪在宿主這一側：server 第一輪回 `input_required`，呼叫方帶 `inputResponses` 與 `requestState` 再叫一次 `tools/call`。
//! 宿主的橋一次 `call` 就是一輪，多輪由呼叫方驅動；這裡證明兩個方向的欄位都過得去。
//! 假 server 是一段 `/bin/sh`（同 `mcp_stdio.rs`）：第一輪回測試給的 `FIRST`（`tools/call` 的 `result` 原文），收到帶 `inputResponses` 的呼叫就回最終結果，
//! 每一次 `tools/call` 收到的整行 JSON 都附進 `LOG`，測試靠它看「宿主送了什麼」。握手走舊協定（`server/discover` 回方法不存在）。

mod common;

use std::time::{Duration, Instant};

use common::fixture;
use nexus_host::mcp::bridge::{Bridge, Command, Outcome};
use nexus_host::mcp::config::Server;
use nexus_host::proxy::ProxyPolicy;
use nexus_host::tls::{client_config, http_client};
use serde_json::{json, Value};

const FAKE_SERVER: &str = r##"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"server/discover"'*)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id";;
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"0"}}}\n' "$id";;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"ask","inputSchema":{"type":"object"}}]}}\n' "$id";;
    *'"method":"tools/call"'*)
      printf '%s\n' "$line" >> "$LOG"
      case "$line" in
        *'"inputResponses"'*)
          printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"done"}],"isError":false}}\n' "$id";;
        *)
          printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$id" "$FIRST";;
      esac;;
  esac
done
"##;

/// 表單題：`message` 與 `requestedSchema`。
fn form_question() -> Value {
    json!({
        "method": "elicitation/create",
        "params": {
            "mode": "form",
            "message": "請問怎麼稱呼？",
            "requestedSchema": {
                "type": "object",
                "properties": { "name": { "type": "string", "title": "名字" } },
                "required": ["name"]
            }
        }
    })
}

/// 網址題：`mode: "url"` 帶 `url` 與 `elicitationId`。
fn url_question() -> Value {
    json!({
        "method": "elicitation/create",
        "params": {
            "mode": "url",
            "message": "請到這個網址授權",
            "url": "https://example.test/authorize?state=abc",
            "elicitationId": "elicit-1"
        }
    })
}

fn input_required(questions: Value, state: Value) -> Value {
    json!({
        "resultType": "input_required",
        "inputRequests": questions,
        "requestState": state
    })
}

fn client() -> reqwest::Client {
    let config = client_config(&fixture("ca-a.pem")).expect("根");
    http_client(config, &ProxyPolicy::direct()).expect("客戶端")
}

fn wait_for(bridge: &Bridge, want: impl Fn(&Outcome) -> bool) -> Outcome {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        for outcome in bridge.take() {
            if want(&outcome) {
                return outcome;
            }
        }
        let left = deadline.saturating_duration_since(Instant::now());
        assert!(!left.is_zero(), "等不到結果");
        let mut fd = libc::pollfd {
            fd: bridge.wake_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: 指向這個 frame 上一個活著的 pollfd，nfds 是 1。
        unsafe { libc::poll(&mut fd, 1, left.as_millis() as libc::c_int) };
    }
}

/// 一台假 server 加一座橋。收掉時（`drop`）收線並刪 `LOG`。
struct Rig {
    bridge: Bridge,
    log: String,
}

impl Rig {
    /// `first` 是 server 第一輪 `tools/call` 的 `result`。橋用 `elicitation: true` 開。
    fn start(tag: &str, first: &Value) -> Rig {
        let log = format!(
            "{}/nexus-host-elicit-{}-{tag}.log",
            std::env::temp_dir().display(),
            std::process::id()
        );
        let _ = std::fs::remove_file(&log);
        let config = json!({
            "serverName": "fake",
            "connection": {
                "transport": "stdio",
                "command": "/bin/sh",
                "args": ["-c", FAKE_SERVER],
                "env": { "PATH": "/usr/bin:/bin", "LOG": log, "FIRST": first.to_string() },
            },
        });
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        bridge.send(Command::Open {
            open: 1,
            server: Box::new(Server::parse(&config).expect("設定")),
            elicitation: true,
        });
        match wait_for(&bridge, |o| matches!(o, Outcome::Opened { .. })) {
            Outcome::Opened { result, .. } => {
                result.expect("連得上");
            }
            _ => unreachable!(),
        }
        Rig { bridge, log }
    }

    /// 一輪 `tools/call`：`extra` 的欄位併進 `params`（第二輪放 `inputResponses`、`requestState`）。
    fn call(&self, id: u64, extra: Value) -> Result<String, String> {
        let mut params = json!({ "name": "ask", "arguments": {} });
        for (key, value) in extra.as_object().expect("物件") {
            params[key] = value.clone();
        }
        self.bridge.send(Command::Request {
            id,
            open: 1,
            method: "tools/call".into(),
            params,
        });
        match wait_for(
            &self.bridge,
            |o| matches!(o, Outcome::Done { id: n, .. } if *n == id),
        ) {
            Outcome::Done { result, .. } => result,
            _ => unreachable!(),
        }
    }

    /// server 收到的每一次 `tools/call` 的 `params`，依序。
    fn received(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .map(|line| {
                let message: Value = serde_json::from_str(line).expect("server 收到的是 JSON");
                message["params"].clone()
            })
            .collect()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.bridge.send(Command::Shutdown);
        wait_for(&self.bridge, |o| matches!(o, Outcome::Closed));
        let _ = std::fs::remove_file(&self.log);
    }
}

fn json_of(result: Result<String, String>) -> Value {
    serde_json::from_str(&result.expect("呼叫成功")).expect("結果是 JSON")
}

/// R1：第一輪的表單題原樣回給呼叫方：`resultType`、題目的 `method` 與 `params`（含 `message`、`requestedSchema`）、`requestState` 逐欄位等於 server 送的。
#[test]
fn r1_第一輪的表單題原樣回給呼叫方() {
    let questions = json!({ "q1": form_question() });
    let rig = Rig::start("r1", &input_required(questions.clone(), json!("state-1")));
    let result = json_of(rig.call(10, json!({})));
    assert_eq!(result["resultType"], "input_required", "{result}");
    assert_eq!(result["inputRequests"], questions, "{result}");
    assert_eq!(result["requestState"], "state-1", "{result}");
}

/// R2：第二輪帶的 `inputResponses` 與 `requestState`，server 收到的與送的逐字相同，而且第二輪還是同一個 `tools/call`（工具名與引數不變）；呼叫方拿到最終結果。
#[test]
fn r2_第二輪的答案與狀態原樣送到_server() {
    let rig = Rig::start(
        "r2",
        &input_required(json!({ "q1": form_question() }), json!("state-1")),
    );
    let arguments = json!({ "topic": "天氣" });
    rig.call(10, json!({ "arguments": arguments }))
        .expect("第一輪");
    let responses = json!({ "q1": { "action": "accept", "content": { "name": "小明" } } });
    let result = json_of(rig.call(
        11,
        json!({ "arguments": arguments, "inputResponses": responses, "requestState": "state-1" }),
    ));
    assert_eq!(result["content"][0]["text"], "done", "{result}");
    let received = rig.received();
    assert_eq!(
        received.len(),
        2,
        "server 收到兩次 tools/call：{received:?}"
    );
    assert_eq!(
        received[1]["name"], "ask",
        "第二輪還是同一個工具：{received:?}"
    );
    assert_eq!(
        received[1]["arguments"], arguments,
        "第二輪引數不變：{received:?}"
    );
    assert_eq!(received[0]["arguments"], arguments, "{received:?}");
    assert_eq!(received[1]["inputResponses"], responses, "{received:?}");
    assert_eq!(received[1]["requestState"], "state-1", "{received:?}");
}

/// R3：網址題（`mode: "url"`、`url`、`elicitationId`）同 R1 原樣回來。
#[test]
fn r3_第一輪的網址題原樣回給呼叫方() {
    let questions = json!({ "u1": url_question() });
    let rig = Rig::start("r3", &input_required(questions.clone(), json!("state-u")));
    let result = json_of(rig.call(10, json!({})));
    assert_eq!(result["resultType"], "input_required", "{result}");
    assert_eq!(result["inputRequests"], questions, "{result}");
    assert_eq!(result["requestState"], "state-u", "{result}");
}

/// R4a：題目的 `params` 帶 rmcp 型別沒有的欄位：額外欄位現況會被丟掉，整題照樣回來。只釘現況，不決定要不要改宿主。
#[test]
fn r4a_題目帶型別沒有的欄位() {
    let mut question = form_question();
    question["params"]["futureField"] = json!({ "x": 1 });
    let rig = Rig::start(
        "r4a",
        &input_required(json!({ "q1": question }), json!("state-1")),
    );
    let result = json_of(rig.call(10, json!({})));
    assert_eq!(result["resultType"], "input_required", "{result}");
    assert!(
        result["inputRequests"]["q1"]["params"]
            .get("futureField")
            .is_none(),
        "額外欄位現況會被丟掉：{result}"
    );
    assert_eq!(
        result["inputRequests"]["q1"]["params"]["message"], "請問怎麼稱呼？",
        "題目其餘的欄位還在：{result}"
    );
}

/// R4b：題目不是 `elicitation/create`（例如 `sampling/createMessage`）：現況是整包原樣回給呼叫方（`resultType`、`inputRequests`、`requestState` 逐欄位等於 server 送的），宿主不擋。只釘現況。
#[test]
fn r4b_題目不是反問_整包原樣回來() {
    let questions = json!({ "q1": {
        "method": "sampling/createMessage",
        "params": { "messages": [], "maxTokens": 10 }
    } });
    let rig = Rig::start("r4b", &input_required(questions.clone(), json!("state-1")));
    let result = json_of(rig.call(10, json!({})));
    assert_eq!(result["resultType"], "input_required", "{result}");
    assert_eq!(result["inputRequests"], questions, "{result}");
    assert_eq!(result["requestState"], "state-1", "{result}");
}

/// R5′：`requestState` 不是字串（數字、物件）：rmcp 的欄位是 `Option<String>`，現況是整包原樣回給呼叫方，`requestState` 與 `inputRequests` 都等於 server 送的。只釘現況。
#[test]
fn r5_request_state_不是字串_原樣回來() {
    for (tag, state) in [("r5n", json!(7)), ("r5o", json!({ "step": 1 }))] {
        let questions = json!({ "q1": form_question() });
        let rig = Rig::start(tag, &input_required(questions.clone(), state.clone()));
        let result = json_of(rig.call(10, json!({})));
        assert_eq!(result["requestState"], state, "{result}");
        assert_eq!(result["inputRequests"], questions, "{result}");
    }
}
