//! `nexus_host::mcp::redact`：MCP 憑證值的檢查與遮蔽（#2570）。
//! 先跑共用樣本 `credentials-vectors.json` 的 `mcpValue` 與 `redact`（TS 的 `credentials-vectors.test.ts` 跑同一份 `mcpValue`），
//! 再經真的橋證明成功結果、工具清單與錯誤都從單一出口遮掉。規則見 `docs/credentials-file.md`〈MCP 憑證值的遮蔽〉。

mod common;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::fake_mcp::{handler, FakeMcp};
use common::{fixture, Handler, Request, Response, TlsServer};
use nexus_host::mcp::bridge::{Bridge, Command, Outcome};
use nexus_host::mcp::config::Server;
use nexus_host::mcp::redact::{check_value, Redactor, Use, MIN_VALUE_CODE_POINTS};
use nexus_host::proxy::ProxyPolicy;
use nexus_host::tls::{client_config, http_client};
use serde_json::{json, Value};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../credentials-vectors.json");
    let text = std::fs::read_to_string(path).expect("讀樣本檔");
    serde_json::from_str(&text).expect("樣本檔是 JSON")
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("陣列")
        .iter()
        .map(|v| v.as_str().expect("字串").to_string())
        .collect()
}

#[test]
fn 門檻是八個_code_point() {
    assert_eq!(MIN_VALUE_CODE_POINTS, 8);
}

#[test]
fn 值檢查樣本() {
    let all = vectors();
    let list = all["mcpValue"].as_array().expect("mcpValue");
    assert!(!list.is_empty());
    for vector in list {
        let name = vector["name"].as_str().expect("名字");
        let using = match vector["use"].as_str().expect("use") {
            "env" => Use::Env,
            "header" => Use::Header,
            other => panic!("{name}：認不得的 use {other}"),
        };
        let got = check_value(vector["value"].as_str().expect("value"), using);
        if vector["accept"].as_bool().expect("accept") {
            assert_eq!(
                got.as_deref(),
                Ok(vector["trimmed"].as_str().expect("trimmed")),
                "{name}"
            );
        } else {
            let reason = vector["reason"].as_str().expect("reason");
            let rejection = got.expect_err(name);
            assert_eq!(rejection.code(), reason, "{name}");
            if let Some(secret) = vector["secret"].as_str() {
                assert!(
                    !rejection.message("X（來自檔）").contains(secret),
                    "{name}：訊息不能含值"
                );
            }
        }
    }
}

#[test]
fn 拒收訊息只講名字_來源層與規則() {
    let message = nexus_host::mcp::redact::Rejection::TooShort
        .message("DB_PASSWORD（來自受管憑證檔 /home/FAKE/.credentials.yaml）");
    assert!(message.contains("DB_PASSWORD（來自受管憑證檔 /home/FAKE/.credentials.yaml）"));
    assert!(message.contains("不到 8 個字元"));
}

#[test]
fn 遮蔽樣本() {
    let all = vectors();
    let list = all["redact"].as_array().expect("redact");
    assert!(!list.is_empty());
    for vector in list {
        let name = vector["name"].as_str().expect("名字");
        let redactor = Redactor::new(strings(&vector["values"]));
        let text = vector["text"].as_str().expect("text");
        let got = match vector["scope"].as_str().unwrap_or("result") {
            "result" => redactor.redact_text(text),
            "error" => redactor.scrub_text(text),
            other => panic!("{name}：認不得的 scope {other}"),
        };
        assert_eq!(got, vector["expect"].as_str().expect("expect"), "{name}");
        for absent in strings(vector.get("absent").unwrap_or(&json!([]))) {
            assert!(!got.contains(&absent), "{name}：{absent} 還在輸出裡");
        }
    }
}

#[test]
fn 樣本檔本身() {
    let all = vectors();
    let names: Vec<&str> = all["mcpValue"]
        .as_array()
        .expect("mcpValue")
        .iter()
        .chain(all["redact"].as_array().expect("redact"))
        .map(|v| v["name"].as_str().expect("名字"))
        .collect();
    let unique: std::collections::HashSet<&&str> = names.iter().collect();
    assert_eq!(unique.len(), names.len(), "名字不重複");
    let reasons: std::collections::HashSet<&str> = all["mcpValue"]
        .as_array()
        .expect("mcpValue")
        .iter()
        .filter_map(|v| v["reason"].as_str())
        .collect();
    assert_eq!(
        reasons,
        ["empty", "too-short", "nul", "header-chars"]
            .into_iter()
            .collect(),
        "每種拒絕原因至少一條"
    );
}

#[test]
fn json_樹的字串遮_鍵與識別欄位不動() {
    let redactor = Redactor::new(["FAKE-token-0001".to_string()]);
    let mut tree = json!({
        "FAKE-token-0001": [1, true, null, "x FAKE-token-0001 y"],
        "nested": { "text": "\"FAKE-token-0001\"", "uri": "docs://FAKE-token-0001/a" },
        "uriTemplate": "docs://FAKE-token-0001/{id}",
        "uri": { "text": "FAKE-token-0001" },
        "n": 12345678,
    });
    redactor.redact_json(&mut tree);
    assert_eq!(
        tree,
        json!({
            "FAKE-token-0001": [1, true, null, "x [redacted] y"],
            "nested": { "text": "\"[redacted]\"", "uri": "docs://FAKE-token-0001/a" },
            "uriTemplate": "docs://FAKE-token-0001/{id}",
            "uri": { "text": "[redacted]" },
            "n": 12345678,
        })
    );
}

#[test]
fn 工具清單_工具的_name_不遮_其餘照遮() {
    let redactor = Redactor::new(["FAKE-token-0001".to_string()]);
    let mut tools = json!([{
        "name": "lookup-FAKE-token-0001",
        "description": "查 FAKE-token-0001",
        "inputSchema": { "properties": { "FAKE-token-0001": { "description": "FAKE-token-0001", "name": "FAKE-token-0001" } } },
    }]);
    redactor.redact_tool_list(&mut tools);
    assert_eq!(
        tools,
        json!([{
            "name": "lookup-FAKE-token-0001",
            "description": "查 [redacted]",
            "inputSchema": { "properties": { "FAKE-token-0001": { "description": "[redacted]", "name": "[redacted]" } } },
        }])
    );
}

fn header_server(headers: Value) -> Server {
    Server::parse(&json!({
        "serverName": "fake",
        "connection": { "transport": "http", "url": "https://h/x", "headers": headers },
    }))
    .expect("設定")
}

#[test]
fn authorization_另收_scheme_後面的_token() {
    for name in ["Authorization", "Proxy-Authorization"] {
        let secrets = header_server(json!({ (name): "Bearer tok-FAKE-0001-xyz" })).secrets();
        assert!(
            secrets.contains(&"Bearer tok-FAKE-0001-xyz".to_string()),
            "{secrets:?}"
        );
        assert!(
            secrets.contains(&"tok-FAKE-0001-xyz".to_string()),
            "{secrets:?}"
        );
    }
    let other = header_server(json!({ "X-Auth": "Bearer tok-FAKE-0002-xyz" })).secrets();
    assert_eq!(
        other,
        ["Bearer tok-FAKE-0002-xyz"],
        "不是 Authorization 的不拆"
    );
}

#[test]
fn 協定層的_header_不收_其餘照收() {
    let secrets = header_server(json!({
        "Accept": "application/json, text/event-stream",
        "content-TYPE": "application/json",
        "User-Agent": "FAKE-agent/1.0",
        "Accept-Language": "en-US,en;q=0.9",
        "MCP-Protocol-Version": "2025-11-25",
        "X-Tenant": "acme-corp-prod",
    }))
    .secrets();
    assert_eq!(secrets, ["acme-corp-prod"]);
}

#[test]
fn 非_ascii_的_header_值不丟() {
    let secrets = header_server(json!({ "X-Name": "密碼-FAKE-0003" })).secrets();
    assert!(
        secrets.contains(&"密碼-FAKE-0003".to_string()),
        "{secrets:?}"
    );
    let latin = header_server(json!({ "X-Name": "caf\u{e9}-FAKE-0004" })).secrets();
    assert!(
        latin.contains(&"caf\u{e9}-FAKE-0004".to_string()),
        "{latin:?}"
    );
    assert!(
        latin.contains(&"caf\u{c3}\u{a9}-FAKE-0004".to_string()),
        "線上送的位元組當 Latin-1 的樣子也收：{latin:?}"
    );
}

#[test]
fn 沒有值就原樣() {
    let redactor = Redactor::new(Vec::<String>::new());
    let tree = json!({ "a": "b" });
    assert_eq!(redactor.redact_json(&tree), tree);
    assert_eq!(redactor.scrub_text("abc"), "abc");
}

mod bridge {
    use super::*;

    const TOKEN: &str = "Bearer s3cret-token";

    fn client() -> reqwest::Client {
        let config = client_config(&fixture("ca-a.pem")).expect("根");
        http_client(config, &ProxyPolicy::direct()).expect("客戶端")
    }

    fn start(fake: FakeMcp) -> u16 {
        let log: Arc<Mutex<Vec<Request>>> = Arc::default();
        TlsServer::start(handler(fake, log)).port
    }

    fn server(port: u16, headers: Value) -> Box<Server> {
        Box::new(
            Server::parse(&json!({
                "serverName": "fake",
                "connection": {
                    "transport": "http",
                    "url": format!("https://localhost:{port}/mcp"),
                    "headers": headers,
                },
            }))
            .expect("設定"),
        )
    }

    fn wait_for(bridge: &Bridge, want: impl Fn(&Outcome) -> bool) -> Outcome {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            for outcome in bridge.take() {
                if want(&outcome) {
                    return outcome;
                }
            }
            let left = deadline.saturating_duration_since(std::time::Instant::now());
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

    fn open(bridge: &Bridge, port: u16, headers: Value) -> nexus_host::mcp::bridge::Opened {
        bridge.send(Command::Open {
            open: 1,
            server: server(port, headers),
            elicitation: false,
        });
        match wait_for(bridge, |o| matches!(o, Outcome::Opened { .. })) {
            Outcome::Opened { result, .. } => result.expect("連得上"),
            _ => unreachable!(),
        }
    }

    fn echo(bridge: &Bridge, id: u64, arguments: Value) -> Result<String, String> {
        bridge.send(Command::Request {
            id,
            open: 1,
            method: "tools/call".into(),
            params: json!({ "name": "echo", "arguments": arguments }),
        });
        match wait_for(
            bridge,
            |o| matches!(o, Outcome::Done { id: n, .. } if *n == id),
        ) {
            Outcome::Done { result, .. } => result,
            _ => unreachable!(),
        }
    }

    /// server 把收到的參數回顯在成功的結果裡：header 的值是已解析的憑證值，成功結果也要遮。
    #[test]
    fn 成功結果裡的憑證值被遮掉() {
        let port = start(FakeMcp::with_tools(true, &["echo"]));
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open(&bridge, port, json!({ "Authorization": TOKEN }));
        let text = echo(&bridge, 10, json!({ "x": TOKEN })).expect("呼叫成功");
        assert!(!text.contains("s3cret-token"), "{text}");
        let result: Value = serde_json::from_str(&text).expect("遮完還是合法的 JSON");
        assert_eq!(result["content"][0]["text"], r#""echo":{"x":"[redacted]"}"#);
    }

    #[test]
    fn 編碼過的憑證值也被遮掉() {
        let port = start(FakeMcp::with_tools(true, &["echo"]));
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open(&bridge, port, json!({ "Authorization": TOKEN }));
        let text = echo(
            &bridge,
            11,
            json!({ "x": "Bearer%20s3cret-token", "y": "Bearer+s3cret-token" }),
        )
        .expect("呼叫成功");
        assert!(!text.contains("s3cret-token"), "{text}");
    }

    /// 代理的帳密這種橋層級的秘密走同一個出口。
    #[test]
    fn 橋層級的秘密也遮成功結果() {
        let port = start(FakeMcp::with_tools(true, &["echo"]));
        let bridge = Bridge::start(client(), vec!["proxy-pass-FAKE-01".to_string()]).expect("起橋");
        open(&bridge, port, json!({}));
        let text = echo(&bridge, 12, json!({ "x": "proxy-pass-FAKE-01" })).expect("呼叫成功");
        assert!(!text.contains("proxy-pass-FAKE-01"), "{text}");
    }

    /// 短的字面值（這裡是 header 的 `ab`）不會把成功結果改壞。
    #[test]
    fn 短的字面值不動成功結果() {
        let port = start(FakeMcp::with_tools(true, &["echo"]));
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open(&bridge, port, json!({ "X-Mode": "ab" }));
        let text = echo(&bridge, 13, json!({ "x": "ab" })).expect("呼叫成功");
        let result: Value = serde_json::from_str(&text).expect("JSON");
        assert_eq!(result["content"][0]["text"], r#""echo":{"x":"ab"}"#);
    }

    fn custom(fake: FakeMcp) -> u16 {
        let base = handler(fake, Arc::default());
        let wrapped: Handler = Arc::new(move |request: &Request| {
            if request.method == "POST" {
                if let Ok(m) = serde_json::from_slice::<Value>(&request.body) {
                    let reply = |mut result: Value| {
                        result["resultType"] = json!("complete");
                        let body = json!({ "jsonrpc": "2.0", "id": m["id"], "result": result });
                        Response::new(200, "application/json", body.to_string())
                    };
                    match m["method"].as_str().unwrap_or("") {
                        "resources/list" => {
                            return reply(json!({ "resources": [{
                                "uri": "docs://s3cret-token/readme",
                                "name": "readme s3cret-token",
                            }] }))
                        }
                        "resources/read" => {
                            return reply(json!({ "contents": [{
                                "uri": m["params"]["uri"],
                                "text": "body s3cret-token",
                            }] }))
                        }
                        "tools/call" if m["params"]["name"] == "fail" => {
                            return reply(json!({
                                "content": [{ "type": "text", "text": "bad s3cret-token" }],
                                "isError": true,
                            }))
                        }
                        _ => {}
                    }
                }
            }
            base(request)
        });
        TlsServer::start(wrapped).port
    }

    fn request(bridge: &Bridge, id: u64, method: &str, params: Value) -> Result<String, String> {
        bridge.send(Command::Request {
            id,
            open: 1,
            method: method.into(),
            params,
        });
        match wait_for(
            bridge,
            |o| matches!(o, Outcome::Done { id: n, .. } if *n == id),
        ) {
            Outcome::Done { result, .. } => result,
            _ => unreachable!(),
        }
    }

    /// server 只回顯 `Authorization: Bearer <token>` 的 token。
    #[test]
    fn 只回顯_token_也遮掉() {
        let port = start(FakeMcp::with_tools(true, &["echo"]));
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open(&bridge, port, json!({ "Authorization": TOKEN }));
        let text = echo(&bridge, 20, json!({ "x": "s3cret-token" })).expect("呼叫成功");
        let result: Value = serde_json::from_str(&text).expect("JSON");
        assert_eq!(result["content"][0]["text"], r#""echo":{"x":"[redacted]"}"#);
    }

    /// 協定層的 header 值不遮，自訂 header 的值照遮。
    #[test]
    fn 協定層_header_的值不遮_自訂的照遮() {
        let port = start(FakeMcp::with_tools(true, &["echo"]));
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open(
            &bridge,
            port,
            json!({ "Accept-Language": "en-US,en;q=0.9", "X-Tenant": "acme-corp-prod" }),
        );
        let text = echo(
            &bridge,
            21,
            json!({ "lang": "en-US,en;q=0.9", "tenant": "acme-corp-prod" }),
        )
        .expect("呼叫成功");
        let result: Value = serde_json::from_str(&text).expect("JSON");
        assert_eq!(
            result["content"][0]["text"],
            r#""echo":{"lang":"en-US,en;q=0.9","tenant":"[redacted]"}"#
        );
    }

    /// 名稱含 header 字面值的工具：清單裡 `name` 原樣、描述遮掉，照這個名字還叫得動。
    #[test]
    fn 名稱含字面值的工具_列出後叫得動() {
        let port = start(FakeMcp::with_tools(true, &["acme-corp-prod-lookup"]));
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        let listed = open(&bridge, port, json!({ "X-Tenant": "acme-corp-prod" }));
        let tools: Value = serde_json::from_str(&listed.tools).expect("JSON");
        assert_eq!(tools[0]["name"], "acme-corp-prod-lookup");
        assert_eq!(tools[0]["description"], "tool [redacted]-lookup");
        let name = tools[0]["name"].as_str().expect("名字").to_string();
        bridge.send(Command::Request {
            id: 22,
            open: 1,
            method: "tools/call".into(),
            params: json!({ "name": name, "arguments": {} }),
        });
        let called = match wait_for(&bridge, |o| matches!(o, Outcome::Done { id: 22, .. })) {
            Outcome::Done { result, .. } => result,
            _ => unreachable!(),
        };
        assert!(called.is_ok(), "{called:?}");
    }

    #[test]
    fn instructions_也遮() {
        let fake = FakeMcp {
            instructions: Some("請帶著 s3cret-token 來".into()),
            ..FakeMcp::with_tools(true, &["echo"])
        };
        let port = start(fake);
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        let listed = open(&bridge, port, json!({ "Authorization": TOKEN }));
        assert!(
            !listed.instructions.contains("s3cret-token"),
            "{}",
            listed.instructions
        );
        assert!(
            listed.instructions.contains("[redacted]"),
            "{}",
            listed.instructions
        );
    }

    #[test]
    fn is_error_的結果也遮() {
        let port = custom(FakeMcp::with_tools(true, &["fail"]));
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open(&bridge, port, json!({ "Authorization": TOKEN }));
        let text = request(
            &bridge,
            23,
            "tools/call",
            json!({ "name": "fail", "arguments": {} }),
        )
        .expect("isError 也是成功的回應");
        let result: Value = serde_json::from_str(&text).expect("JSON");
        assert_eq!(result["isError"], true);
        assert_eq!(result["content"][0]["text"], "bad [redacted]");
    }

    /// resources：內容與名稱遮，`uri` 原樣（之後 `resources/read` 要用它）。
    #[test]
    fn resources_的內容遮_uri_不動() {
        let port = custom(FakeMcp::with_tools(true, &["echo"]));
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open(&bridge, port, json!({ "Authorization": TOKEN }));
        let listed = request(&bridge, 24, "resources/list", json!({})).expect("列得到");
        let listed: Value = serde_json::from_str(&listed).expect("JSON");
        assert_eq!(listed["resources"][0]["uri"], "docs://s3cret-token/readme");
        assert_eq!(listed["resources"][0]["name"], "readme [redacted]");
        let uri = listed["resources"][0]["uri"]
            .as_str()
            .expect("uri")
            .to_string();
        let read = request(&bridge, 25, "resources/read", json!({ "uri": uri })).expect("讀得到");
        let read: Value = serde_json::from_str(&read).expect("JSON");
        assert_eq!(read["contents"][0]["uri"], "docs://s3cret-token/readme");
        assert_eq!(read["contents"][0]["text"], "body [redacted]");
    }
}
