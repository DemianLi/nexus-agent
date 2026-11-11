//! 宿主的 MCP 對官方 server 的符合性：真的起 `packages/nexus-plugin-mcp/src/conformance-server.ts`（node 子行程，
//! 四種對手見該檔檔頭），經宿主的橋連上去，斷言 **server 那一側收到的東西**：握手走哪一條、封套鍵、標頭、分頁、取消。
//! 手寫的假 server（`tests/common/fake_mcp.rs`）不檢查這些，綠的測試證明不了宿主照規格送。
//!
//! 全部標 `#[ignore]`：要 node 與 `pnpm install` 過的相依，CI 在 `./.github/actions/setup` 之後另跑一步帶 `--ignored`
//! 並核對跑到的測試數（`.github/scripts/test_ci_workflow.py` 釘住那一步）。

#![cfg(unix)]

mod common;

use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command as Process, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::fixture;
use nexus_host::mcp::bridge::{Bridge, Command, Outcome};
use nexus_host::mcp::config::Server;
use nexus_host::proxy::ProxyPolicy;
use nexus_host::tls::{client_config, http_client};
use serde_json::{json, Value};

const PROTOCOL_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
const CLIENT_INFO_KEY: &str = "io.modelcontextprotocol/clientInfo";

/// 一台跑著的對手。丟掉就關 stdin 並殺掉子行程。
struct Node {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Arc<Mutex<Vec<Value>>>,
    url: String,
}

impl Node {
    fn start(kind: &str) -> Node {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/nexus-plugin-mcp");
        let mut child = Process::new("node")
            .args(["--import", "tsx", "src/conformance-server.ts", kind])
            .current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("起 node");
        let stdout = child.stdout.take().expect("stdout");
        let stdin = child.stdin.take();
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = Arc::clone(&events);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    sink.lock().expect("鎖").push(value);
                }
            }
        });
        let mut node = Node {
            child,
            stdin,
            events,
            url: String::new(),
        };
        let listening = node.wait_event(30, |e| e["event"] == "listening");
        node.url = listening["url"].as_str().expect("url").to_string();
        node
    }

    /// 等到有一則符合的記錄；等不到就把到目前為止的記錄全印出來。
    fn wait_event(&self, secs: u64, want: impl Fn(&Value) -> bool) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            if let Some(found) = self.events.lock().expect("鎖").iter().find(|e| want(e)) {
                return found.clone();
            }
            assert!(
                Instant::now() < deadline,
                "等不到符合的記錄，server 端到目前為止的記錄：\n{}",
                self.dump()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn dump(&self) -> String {
        self.events
            .lock()
            .expect("鎖")
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// server 收到的請求（依到達順序）。
    fn requests(&self) -> Vec<Value> {
        self.events
            .lock()
            .expect("鎖")
            .iter()
            .filter(|e| e["event"] == "request")
            .cloned()
            .collect()
    }

    /// 每則 JSON-RPC 訊息配上它所在的請求記錄，依到達順序。
    fn messages(&self) -> Vec<(Value, Value)> {
        let mut out = Vec::new();
        for request in self.requests() {
            for message in request["messages"].as_array().cloned().unwrap_or_default() {
                out.push((request.clone(), message));
            }
        }
        out
    }

    fn methods(&self) -> Vec<String> {
        self.messages()
            .iter()
            .filter_map(|(_, m)| m["method"].as_str().map(str::to_string))
            .collect()
    }
}

impl Drop for Node {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn client() -> reqwest::Client {
    let config = client_config(&fixture("ca-a.pem")).expect("根");
    http_client(config, &ProxyPolicy::direct()).expect("客戶端")
}

fn wait_for(bridge: &Bridge, want: impl Fn(&Outcome) -> bool) -> Outcome {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        for outcome in bridge.take() {
            if want(&outcome) {
                return outcome;
            }
        }
        assert!(Instant::now() < deadline, "等不到橋的結果");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// 連上 `url` 並列工具，回工具名。
fn open(bridge: &Bridge, url: &str) -> Vec<String> {
    open_with(bridge, url, None)
}

/// 同 [`open`]，可指定一次 `tools/call` 的逾時毫秒。
fn open_with(bridge: &Bridge, url: &str, timeout_ms: Option<u64>) -> Vec<String> {
    let mut config = json!({
        "serverName": "conf",
        "connection": { "transport": "http", "url": url },
    });
    if let Some(ms) = timeout_ms {
        config["toolCallTimeoutMs"] = json!(ms);
    }
    let server = Server::parse(&config).expect("設定");
    bridge.send(Command::Open {
        open: 1,
        server: Box::new(server),
        elicitation: false,
    });
    let outcome = wait_for(bridge, |o| matches!(o, Outcome::Opened { open: 1, .. }));
    let Outcome::Opened { result, .. } = outcome else {
        unreachable!()
    };
    let opened = result.expect("連得上");
    let tools: Value = serde_json::from_str(&opened.tools).expect("JSON");
    tools
        .as_array()
        .expect("陣列")
        .iter()
        .map(|t| t["name"].as_str().expect("name").to_string())
        .collect()
}

fn send(bridge: &Bridge, id: u64, method: &str, params: Value) {
    bridge.send(Command::Request {
        id,
        open: 1,
        method: method.into(),
        params,
    });
}

fn done(bridge: &Bridge, id: u64) -> Result<String, String> {
    let outcome = wait_for(bridge, |o| matches!(o, Outcome::Done { id: n, .. } if *n == id));
    let Outcome::Done { result, .. } = outcome else {
        unreachable!()
    };
    result
}

fn request(bridge: &Bridge, id: u64, method: &str, params: Value) -> Value {
    send(bridge, id, method, params);
    let text = done(bridge, id).unwrap_or_else(|e| panic!("{method} 失敗：{e}"));
    serde_json::from_str(&text).expect("JSON")
}

/// 連上、列工具，再把 `tools/call` 與三個 resources 方法各打一遍；回工具名。
fn exercise(node: &Node, bridge: &Bridge) -> Vec<String> {
    let mut names = open(bridge, &node.url);
    names.sort();
    let echo = json!({ "name": "echo", "arguments": { "x": 1 } });
    let echoed = request(bridge, 10, "tools/call", echo);
    assert!(echoed["content"][0]["text"].as_str().is_some(), "{echoed}");
    let listed = request(bridge, 11, "resources/list", json!({}));
    assert_eq!(listed["resources"][0]["uri"], "memo://readme", "{listed}");
    let templates = request(bridge, 12, "resources/templates/list", json!({}));
    assert_eq!(
        templates["resourceTemplates"][0]["uriTemplate"],
        "memo://note/{id}",
        "{templates}"
    );
    let read = request(bridge, 13, "resources/read", json!({ "uri": "memo://readme" }));
    assert!(read["contents"][0]["text"].as_str().is_some(), "{read}");
    names
}

/// 官方 server：`fail` 回 `isError`，不是協定層的錯。
fn assert_tool_error(bridge: &Bridge) {
    let failed = request(bridge, 14, "tools/call", json!({ "name": "fail", "arguments": {} }));
    assert_eq!(failed["isError"], true, "{failed}");
}

const OFFICIAL_TOOLS: [&str; 3] = ["echo", "fail", "hang"];

/// 新協定：握手、封套鍵、標頭。
fn assert_modern(node: &Node) {
    let methods = node.methods();
    assert_eq!(methods.first().map(String::as_str), Some("server/discover"), "{methods:?}");
    assert!(!methods.iter().any(|m| m == "initialize"), "{methods:?}");
    // 每個請求都要帶 clientCapabilities；缺的方法收齊一起報，不停在第一個。
    let mut without_capabilities = Vec::new();
    for (record, message) in node.messages() {
        let method = message["method"].as_str().unwrap_or_default();
        let ctx = format!("{method}\n{}", node.dump());
        assert_eq!(record["protocolVersion"], "2026-07-28", "標頭 MCP-Protocol-Version：{ctx}");
        assert_eq!(record["mcpMethod"], method, "標頭 Mcp-Method：{ctx}");
        let meta = &message["params"]["_meta"];
        assert_eq!(meta[PROTOCOL_KEY], "2026-07-28", "_meta 的 protocolVersion：{ctx}");
        if method == "server/discover" {
            continue;
        }
        if !meta[CAPABILITIES_KEY].is_object() {
            without_capabilities.push(method.to_string());
        }
        let info = &meta[CLIENT_INFO_KEY]["name"];
        assert_eq!(info, "@nexus/plugin-mcp", "_meta 的 clientInfo：{ctx}");
        let named = match method {
            "tools/call" => Some(&message["params"]["name"]),
            "resources/read" => Some(&message["params"]["uri"]),
            _ => None,
        };
        if let Some(name) = named {
            assert_eq!(&record["mcpName"], name, "Mcp-Name：{ctx}");
        }
    }
    assert!(
        without_capabilities.is_empty(),
        "這些請求的 _meta 沒有 clientCapabilities：{without_capabilities:?}\n{}",
        node.dump()
    );
}

/// 舊協定：先試新協定被拒，再 `initialize`；之後的請求帶協商到的版本，沒有新協定的封套與標頭。
fn assert_legacy(node: &Node, version: &str) {
    let methods = node.methods();
    let at = |name: &str| methods.iter().position(|m| m == name);
    let (discover, init, initialized, list) = (
        at("server/discover"),
        at("initialize"),
        at("notifications/initialized"),
        at("tools/list"),
    );
    assert!(
        discover < init && init < initialized && initialized < list && discover.is_some(),
        "握手順序：{methods:?}"
    );
    let messages = node.messages();
    let init_message = &messages[init.expect("initialize")].1;
    assert_eq!(init_message["params"]["protocolVersion"], "2025-11-25");
    assert_eq!(init_message["params"]["clientInfo"]["name"], "@nexus/plugin-mcp");
    for (record, message) in &messages[init.expect("initialize") + 1..] {
        let ctx = format!("{}\n{}", message["method"], node.dump());
        assert_eq!(record["protocolVersion"], version, "握手之後的標頭：{ctx}");
        assert!(record["mcpMethod"].is_null(), "舊協定不帶 Mcp-Method：{ctx}");
        assert!(message["params"]["_meta"][PROTOCOL_KEY].is_null(), "舊協定沒有封套：{ctx}");
    }
}

#[test]
#[ignore = "要 node 與裝好的相依，CI 另一步帶 --ignored 跑"]
fn 新協定_官方二點三點一() {
    let node = Node::start("modern");
    let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
    assert_eq!(exercise(&node, &bridge), OFFICIAL_TOOLS);
    assert_tool_error(&bridge);
    assert_modern(&node);
}

#[test]
#[ignore = "要 node 與裝好的相依，CI 另一步帶 --ignored 跑"]
fn 舊協定_官方二點三點一只講舊協定() {
    let node = Node::start("legacy-2x");
    let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
    assert_eq!(exercise(&node, &bridge), OFFICIAL_TOOLS);
    assert_tool_error(&bridge);
    assert_legacy(&node, "2025-11-25");
}

#[test]
#[ignore = "要 node 與裝好的相依，CI 另一步帶 --ignored 跑"]
fn 舊協定_單包_sdk_一點三十二() {
    let node = Node::start("legacy-1x");
    let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
    assert_eq!(exercise(&node, &bridge), OFFICIAL_TOOLS);
    assert_tool_error(&bridge);
    assert_legacy(&node, "2025-11-25");
}

#[test]
#[ignore = "要 node 與裝好的相依，CI 另一步帶 --ignored 跑"]
fn 舊協定_server_回_2025_06_18_分頁走完() {
    let node = Node::start("handwritten");
    let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
    assert_eq!(exercise(&node, &bridge), OFFICIAL_TOOLS, "兩頁走完");
    let cursors: Vec<Value> = node
        .messages()
        .into_iter()
        .filter(|(_, m)| m["method"] == "tools/list")
        .map(|(_, m)| m["params"]["cursor"].clone())
        .collect();
    assert_eq!(cursors, [Value::Null, json!("p2")], "第二頁帶上一頁給的 cursor");
    assert_legacy(&node, "2025-06-18");
}

/// 對 `hang` 發一次呼叫，等 server 開始處理，再取消。
fn cancel_hang(node: &Node, bridge: &Bridge) {
    open(bridge, &node.url);
    send(bridge, 20, "tools/call", json!({ "name": "hang", "arguments": {} }));
    node.wait_event(10, |e| e["event"] == "hang-started");
    bridge.send(Command::Cancel { id: 20 });
    assert_eq!(done(bridge, 20), Err("cancelled".into()));
}

/// `tools/call` 那則 POST 的回應連線在寫完之前就關了：client 中止了串流，不是 server 自己收尾。
fn aborted_call(event: &Value) -> bool {
    event["event"] == "response-closed"
        && event["finished"] == false
        && event["rpcMethods"]
            .as_array()
            .is_some_and(|ms| ms.iter().any(|m| m == "tools/call"))
}

#[test]
#[ignore = "要 node 與裝好的相依，CI 另一步帶 --ignored 跑"]
fn 新協定_取消時_server_看到請求被中止() {
    let node = Node::start("modern");
    let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
    cancel_hang(&node, &bridge);
    node.wait_event(5, |e| e["event"] == "hang-aborted");
    node.wait_event(5, aborted_call);
    assert!(
        !node.methods().iter().any(|m| m == "notifications/cancelled"),
        "新協定的 HTTP 取消是中止那則請求，不送通知：\n{}",
        node.dump()
    );
}

#[test]
#[ignore = "要 node 與裝好的相依，CI 另一步帶 --ignored 跑"]
fn 舊協定_取消時_server_收到取消通知() {
    for kind in ["legacy-2x", "legacy-1x"] {
        let node = Node::start(kind);
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        cancel_hang(&node, &bridge);
        let seen = node.wait_event(5, |e| {
            e["messages"]
                .as_array()
                .is_some_and(|ms| ms.iter().any(|m| m["method"] == "notifications/cancelled"))
        });
        let notice = seen["messages"]
            .as_array()
            .and_then(|ms| ms.iter().find(|m| m["method"] == "notifications/cancelled"))
            .expect("取消通知");
        assert!(!notice["params"]["requestId"].is_null(), "{kind}：{notice}");
    }
}

/// 逾時後 server 看到什麼：**只記錄、不斷言**（`--nocapture` 下印出）。印出的有取消通知、`tools/call` 那則 POST
/// 是不是被中止、`hang` 的訊號有沒有觸發。
#[test]
#[ignore = "要 node 與裝好的相依，CI 另一步帶 --ignored 跑"]
fn 逾時後_server_看到什麼_只記錄() {
    for kind in ["modern", "legacy-2x", "legacy-1x"] {
        let node = Node::start(kind);
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open_with(&bridge, &node.url, Some(500));
        send(&bridge, 30, "tools/call", json!({ "name": "hang", "arguments": {} }));
        node.wait_event(10, |e| e["event"] == "hang-started");
        let outcome = done(&bridge, 30);
        std::thread::sleep(Duration::from_secs(2));
        let events = node.events.lock().expect("鎖").clone();
        let cancelled = events.iter().any(|e| {
            e["messages"]
                .as_array()
                .is_some_and(|ms| ms.iter().any(|m| m["method"] == "notifications/cancelled"))
        });
        println!(
            "[逾時記錄] {kind}：呼叫端結果={outcome:?} 收到取消通知={cancelled} POST 被中止={} hang 訊號觸發={}",
            events.iter().any(aborted_call),
            events.iter().any(|e| e["event"] == "hang-aborted"),
        );
        println!("[逾時記錄] {kind} 全部記錄：\n{}", node.dump());
    }
}
