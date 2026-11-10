//! `nexus_host::mcp::config`：一台 HTTP server 的設定解析，與錯誤訊息裡的秘密遮蔽；
//! `nexus_host::mcp::pool`：一份設定共用一份連線，一代怎麼連換成記憶體裡的假 [`Connector`](nexus_host::mcp::pool::Connector)；
//! `nexus_host::mcp::connection`：對本機 HTTPS 假 server（新、舊兩種協定）連一代，與經池的冒煙測試。

mod common;

use std::time::Duration;

use nexus_host::mcp::config::{scrub, Server};
use serde_json::json;

#[test]
fn 設定_預設與拒絕() {
    let s = Server::parse(&json!({
        "serverName": "ok_1-x",
        "connection": { "transport": "http", "url": "http://mcp.nexus.test/x" },
        "livenessTimeoutMs": 10,
    }))
    .expect("最少的設定");
    assert_eq!(s.tool_call_timeout, Duration::from_secs(60));
    assert_eq!(s.max_instruction_bytes, 32_768);
    assert!(!s.fail_on_startup_error);
    assert!(s.elicitation);
    assert_eq!(s.label(), "mcp-client(ok_1-x)");

    let base =
        json!({ "serverName": "a", "connection": { "transport": "http", "url": "https://h/" } });
    let reject = |patch: serde_json::Value, expect: &str| {
        let mut config = base.clone();
        for (k, v) in patch.as_object().expect("物件") {
            config[k] = v.clone();
        }
        let err = Server::parse(&config).expect_err("要拒絕");
        assert!(err.contains(expect), "{err} 不含 {expect}");
    };
    reject(json!({ "serverName": "bad name" }), "serverName");
    reject(json!({ "serverName": "x".repeat(33) }), "serverName");
    reject(json!({ "approval": {} }), "不認得的欄位 approval");
    reject(
        json!({ "connection": { "transport": "stdio", "command": "x" } }),
        "stdio",
    );
    reject(
        json!({ "connection": { "transport": "http", "url": "ftp://h/" } }),
        "connection.url",
    );
    reject(
        json!({ "connection": { "transport": "http", "url": "https://h/", "headers": { "A": { "credential": "c" } } } }),
        "是憑證引用：宿主還不支援",
    );
    reject(
        json!({ "connection": { "transport": "http", "url": "https://h/", "headers": { "A": "line\nbreak-secret" } } }),
        "connection.headers.A",
    );
    reject(json!({ "toolCallTimeoutMs": 0 }), "toolCallTimeoutMs");
    reject(json!({ "elicitation": "yes" }), "elicitation");
    reject(json!({ "reconnect": { "maxAttempts": 0 } }), "maxAttempts");
    reject(json!({ "livenessTimeoutMs": -1 }), "livenessTimeoutMs");
    reject(json!({ "toolCallTimeoutMs": 1.5 }), "toolCallTimeoutMs");

    // 整數欄位的上限同 zod：`int()` 只收安全整數，`livenessTimeoutMs` 另有 2^31−1。
    let safe = (1_u64 << 53) - 1;
    for field in ["toolCallTimeoutMs", "maxInstructionBytes"] {
        reject(json!({ field: safe + 1 }), field);
        let mut config = base.clone();
        config[field] = json!(safe);
        Server::parse(&config).unwrap_or_else(|e| panic!("{field} 收 2^53−1：{e}"));
    }
    reject(
        json!({ "livenessTimeoutMs": 2_147_483_648_u64 }),
        "livenessTimeoutMs",
    );
    let mut config = base.clone();
    config["livenessTimeoutMs"] = json!(2_147_483_647);
    Server::parse(&config).expect("livenessTimeoutMs 收 2^31−1");

    let err = Server::parse(&json!({
        "serverName": "a",
        "connection": { "transport": "http", "url": "https://h/", "headers": { "A": "line\nbreak-secret" } },
    }))
    .expect_err("要拒絕");
    assert!(!err.contains("break-secret"), "錯誤不帶 header 值：{err}");
}

#[test]
fn 池的鍵_預設值與數字寫法不分() {
    let key = |config: serde_json::Value| Server::parse(&config).expect("設定").pool_key(true);
    let minimal = key(json!({
        "serverName": "a",
        "connection": { "transport": "http", "url": "https://h/" },
    }));
    let explicit = key(json!({
        "elicitation": true,
        "reconnect": { "maxAttempts": 10.0, "initialDelayMs": 500.0, "enabled": true, "maxDelayMs": 30000 },
        "maxInstructionBytes": 32768.0,
        "failOnStartupError": false,
        "livenessTimeoutMs": 15000.0,
        "toolCallTimeoutMs": 60000.0,
        "connection": { "url": "https://h/", "transport": "http" },
        "serverName": "a",
    }));
    assert_eq!(
        minimal, explicit,
        "省略跟寫出預設值、500 跟 500.0、鍵的順序，都是同一份"
    );
    let partial = key(json!({
        "serverName": "a",
        "connection": { "transport": "http", "url": "https://h/" },
        "reconnect": { "initialDelayMs": 500 },
    }));
    assert_eq!(minimal, partial, "reconnect 只寫一部分，其餘照預設");

    let base =
        json!({ "serverName": "a", "connection": { "transport": "http", "url": "https://h/" } });
    for (field, value) in [
        ("toolCallTimeoutMs", json!(60001)),
        ("livenessTimeoutMs", json!(15001)),
        ("maxInstructionBytes", json!(1)),
        ("failOnStartupError", json!(true)),
        ("elicitation", json!(false)),
        ("reconnect", json!({ "maxAttempts": 3 })),
    ] {
        let mut config = base.clone();
        config[field] = value;
        assert_ne!(minimal, key(config), "{field} 不同就是另一份");
    }
    let mut with_headers = base.clone();
    with_headers["connection"]["headers"] = json!({});
    assert_ne!(
        minimal,
        key(with_headers),
        "headers 寫了空物件跟沒寫不同，同 zod 的 optional"
    );
    assert_ne!(
        Server::parse(&base).expect("設定").pool_key(false),
        minimal,
        "elicitation 旗標不同就是另一份"
    );
}

#[test]
fn 遮蔽先換長的() {
    let secrets = vec!["ab".to_string(), "abcd".to_string(), String::new()];
    assert_eq!(scrub("x abcd y ab", &secrets), "x [redacted] y [redacted]");
}

#[test]
fn 帶帳密的網址拒絕_訊息不帶帳密() {
    for (url, secrets) in [
        ("https://alice:pw-9f2@h/x", &["alice", "pw-9f2"][..]),
        ("https://bob-31@h/x", &["bob-31"][..]),
        ("https://:pw-42@h/x", &["pw-42"][..]),
        (
            "https://al%69ce:p%77-9f2@h/x",
            &["al%69ce", "alice", "p%77-9f2", "pw-9f2"][..],
        ),
    ] {
        let err = Server::parse(&json!({
            "serverName": "a",
            "connection": { "transport": "http", "url": url },
        }))
        .expect_err(url);
        assert_eq!(err, "connection.url 不能帶帳號或密碼");
        for secret in secrets {
            assert!(!err.contains(secret), "{err}");
        }
    }
}

#[test]
fn debug_不印秘密() {
    let s = Server::parse(&json!({
        "serverName": "a",
        "connection": {
            "transport": "http",
            "url": "https://h/x?k=q-77",
            "headers": { "Authorization": "Bearer hdr-88" },
        },
    }))
    .expect("設定");
    let shown = format!("{s:?}");
    for secret in ["q-77", "hdr-88"] {
        assert!(!shown.contains(secret), "{shown}");
    }
    assert!(shown.contains("authorization"), "{shown}");
}

mod pool {
    use std::collections::VecDeque;
    use std::sync::{Arc, Mutex};

    use super::*;
    use nexus_host::mcp::pool::{Connector, Generation, Log, Pool};
    use nexus_host::mcp::supervisor::State;
    use tokio::sync::Notify;

    /// 假連線每一次嘗試怎麼結束。
    enum Step {
        Up(&'static [&'static str]),
        /// 等 `Notify` 叫了才連上。
        UpAfter(Arc<Notify>, &'static [&'static str]),
        Fail(&'static str),
        /// 握手卡住，直到被丟下。
        Hang,
    }

    /// 照腳本一步一步回的假連線；腳本用完就一律連上、列出 `a`。
    #[derive(Clone, Default)]
    struct Fake {
        steps: Arc<Mutex<VecDeque<Step>>>,
        /// 每次嘗試收到的 `secrets`。
        attempts: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl Fake {
        fn new(steps: impl IntoIterator<Item = Step>) -> Fake {
            Fake {
                steps: Arc::new(Mutex::new(steps.into_iter().collect())),
                ..Fake::default()
            }
        }

        fn attempts(&self) -> usize {
            self.attempts.lock().expect("鎖").len()
        }
    }

    struct FakeGeneration {
        attempt: usize,
        tools: Vec<String>,
        lost: Arc<Notify>,
    }

    impl Connector for Fake {
        type Generation = FakeGeneration;

        async fn connect(&self, _: &Server, secrets: &[String]) -> Result<FakeGeneration, String> {
            let attempt = {
                let mut attempts = self.attempts.lock().expect("鎖");
                attempts.push(secrets.to_vec());
                attempts.len()
            };
            let step = self.steps.lock().expect("鎖").pop_front();
            let tools = match step.unwrap_or(Step::Up(&["a"])) {
                Step::Up(tools) => tools,
                Step::UpAfter(gate, tools) => {
                    gate.notified().await;
                    tools
                }
                Step::Fail(error) => return Err(error.to_string()),
                Step::Hang => std::future::pending().await,
            };
            Ok(FakeGeneration {
                attempt,
                tools: tools.iter().map(|t| t.to_string()).collect(),
                lost: Arc::default(),
            })
        }
    }

    impl Generation for FakeGeneration {
        type Peer = usize;
        type Listed = Vec<String>;

        fn peer(&self) -> usize {
            self.attempt
        }

        fn listed(&self) -> Vec<String> {
            self.tools.clone()
        }

        fn lost_signal(&self) -> Arc<Notify> {
            Arc::clone(&self.lost)
        }

        async fn down(&self) {
            self.lost.notified().await;
        }

        async fn close(self) {}
    }

    fn logs() -> (Log, Arc<Mutex<Vec<String>>>) {
        let lines: Arc<Mutex<Vec<String>>> = Arc::default();
        let (a, b) = (Arc::clone(&lines), Arc::clone(&lines));
        let log = Log {
            info: Arc::new(move |m: &str| a.lock().expect("鎖").push(m.to_string())),
            error: Arc::new(move |m: &str| b.lock().expect("鎖").push(format!("ERROR {m}"))),
        };
        (log, lines)
    }

    fn pool(fake: &Fake) -> (Pool<Fake>, Arc<Mutex<Vec<String>>>) {
        let (log, lines) = logs();
        (Pool::new(fake.clone(), Vec::new(), log, None), lines)
    }

    fn server(extra: serde_json::Value) -> Server {
        let mut config = json!({
            "serverName": "fake",
            "connection": {
                "transport": "http",
                "url": "https://mcp.nexus.test/mcp",
                "headers": { "Authorization": "Bearer s3cret-token" },
            },
        });
        for (k, v) in extra.as_object().expect("物件") {
            config[k] = v.clone();
        }
        Server::parse(&config).expect("設定")
    }

    async fn until(what: &str, mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("等不到：{what}");
    }

    #[tokio::test]
    async fn 同一份設定共用一條_旗標不同就分開() {
        let fake = Fake::default();
        let (log, _) = logs();
        let pool = Pool::new(fake.clone(), vec!["proxy-pw".into()], log, None);
        let s = server(json!({}));
        let (one, two) = tokio::join!(pool.acquire(&s, true), pool.acquire(&s, true));
        let (one, two) = (one.expect("取得到"), two.expect("取得到"));
        assert!(Arc::ptr_eq(&one.shared, &two.shared));
        assert!(one.error.is_none() && two.error.is_none());
        assert_eq!(fake.attempts(), 1, "同時取用只連一次");
        assert_eq!(
            fake.attempts.lock().expect("鎖")[0][..2],
            ["proxy-pw", "Bearer s3cret-token"],
            "池的秘密加上這份設定的"
        );
        let three = pool.acquire(&s, false).await.expect("取得到");
        assert!(!Arc::ptr_eq(&one.shared, &three.shared));
        assert_eq!(fake.attempts(), 2);
        assert_eq!(*one.shared.listed().expect("有清單"), ["a"]);
        // 同一份設定、鍵的順序不同，還是同一份連線。
        let reordered: serde_json::Value = serde_json::from_str(
            r#"{"connection":{"headers":{"Authorization":"Bearer s3cret-token"},"url":"https://mcp.nexus.test/mcp","transport":"http"},"serverName":"fake"}"#,
        )
        .expect("JSON");
        let reordered = Server::parse(&reordered).expect("設定");
        let four = pool.acquire(&reordered, true).await.expect("取得到");
        assert!(Arc::ptr_eq(&one.shared, &four.shared));
        assert_eq!(fake.attempts(), 2);
        pool.close().await;
        assert!(pool
            .acquire(&s, true)
            .await
            .is_err_and(|e| e == "MCP 連線池已經關了"));
    }

    #[tokio::test]
    async fn 掉線之後重連_空窗裡清單照留() {
        let gate = Arc::new(Notify::new());
        let fake = Fake::new([Step::Up(&["a"]), Step::UpAfter(Arc::clone(&gate), &["b"])]);
        let (pool, lines) = pool(&fake);
        let s = server(json!({ "reconnect": { "initialDelayMs": 20, "maxDelayMs": 40 } }));
        let got = pool.acquire(&s, true).await.expect("取得到");
        let live = got.shared.current().expect("連著");
        assert_eq!((live.generation, live.peer), (1, 1));
        live.lost();
        until("第二次嘗試開始", || fake.attempts() == 2).await;
        assert!(got.shared.current().is_none(), "空窗裡沒有活著的一代");
        assert_eq!(*got.shared.listed().expect("空窗裡清單照留"), ["a"]);
        gate.notify_one();
        until("第二代連上", || {
            got.shared.state() == State::Up { generation: 2 }
        })
        .await;
        assert_eq!(got.shared.current().expect("連著").generation, 2);
        assert_eq!(*got.shared.listed().expect("有清單"), ["b"]);
        let lines = lines.lock().expect("鎖").clone();
        assert!(
            lines.contains(
                &"mcp-client(fake): connection lost; reconnecting in 20ms (attempt 1/10)"
                    .to_string()
            ),
            "{lines:?}"
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn 第一次就失敗而且要求失敗就回錯_池裡不留() {
        let fake = Fake::new([Step::Fail("refused"), Step::Fail("refused again")]);
        let (pool, _) = pool(&fake);
        let s = server(json!({ "failOnStartupError": true }));
        let err = pool.acquire(&s, true).await.err().expect("要失敗");
        assert_eq!(err, "refused");
        let again = pool
            .acquire(&s, true)
            .await
            .err()
            .expect("再取用重新連一次");
        assert_eq!(again, "refused again");
        assert_eq!(fake.attempts(), 2);
        pool.close().await;
    }

    #[tokio::test]
    async fn 放棄之後下一次取用重開一份() {
        let fake = Fake::new([Step::Fail("refused")]);
        let (pool, lines) = pool(&fake);
        let s = server(json!({ "reconnect": { "enabled": false } }));
        let first = pool.acquire(&s, true).await.expect("沒要求失敗就照樣回");
        assert!(first.error.is_some());
        until("放棄", || first.shared.state() == State::Stopped).await;
        let second = pool.acquire(&s, true).await.expect("重開");
        assert!(!Arc::ptr_eq(&first.shared, &second.shared));
        assert!(second.error.is_none(), "重開的那一份連上了");
        assert_eq!(fake.attempts(), 2);
        let lines = lines.lock().expect("鎖").clone();
        assert!(
            lines.iter().any(|l| l.contains("reconnect is disabled")),
            "{lines:?}"
        );
        pool.close().await;
    }

    #[tokio::test]
    async fn 建立那一份的等待上限() {
        let fake = Fake::new([Step::Hang]);
        let (log, _) = logs();
        let pool = Pool::new(fake, Vec::new(), log, Some(Duration::from_millis(100)));
        let got = tokio::time::timeout(
            Duration::from_secs(5),
            pool.acquire(&server(json!({})), true),
        )
        .await
        .expect("建立那一份照上限回")
        .expect("照樣回");
        assert_eq!(
            got.error.as_deref(),
            Some("mcp-client(fake): still connecting after 100ms — this assembly goes without its tools; the connection keeps trying in the background")
        );
        tokio::time::timeout(Duration::from_secs(6), pool.close())
            .await
            .expect("關池不等卡住的握手");
    }
}

mod http {
    use std::sync::{Arc, Mutex};

    use super::common::fake_mcp::{handler, FakeMcp};
    use super::common::{fixture, Request, Response, TlsServer};
    use super::*;
    use nexus_host::mcp::connection::{call_meta, connect, instructions_of, Http};
    use nexus_host::mcp::pool::{Generation as _, Log, Pool};
    use nexus_host::proxy::ProxyPolicy;
    use nexus_host::tls::{client_config, http_client};
    use rmcp::model::CallToolRequestParams;

    fn client() -> reqwest::Client {
        let config = client_config(&fixture("ca-a.pem")).expect("根");
        http_client(config, &ProxyPolicy::direct()).expect("客戶端")
    }

    fn start(fake: FakeMcp) -> (u16, Arc<Mutex<Vec<Request>>>) {
        let log: Arc<Mutex<Vec<Request>>> = Arc::default();
        let server = TlsServer::start(handler(fake, Arc::clone(&log)));
        (server.port, log)
    }

    fn server(port: u16, extra: serde_json::Value) -> Server {
        let mut config = json!({
            "serverName": "fake",
            "connection": {
                "transport": "http",
                "url": format!("https://localhost:{port}/mcp"),
                "headers": { "Authorization": "Bearer s3cret-token" },
            },
        });
        for (k, v) in extra.as_object().expect("物件") {
            config[k] = v.clone();
        }
        Server::parse(&config).expect("設定")
    }

    fn names(tools: &[rmcp::model::Tool]) -> Vec<String> {
        tools.iter().map(|t| t.name.to_string()).collect()
    }

    /// 收到的 POST 裡，`method` 是 `name` 的有幾則。
    fn count(log: &Mutex<Vec<Request>>, name: &str) -> usize {
        log.lock()
            .expect("鎖")
            .iter()
            .filter(|r| r.method == "POST")
            .filter_map(|r| serde_json::from_slice::<serde_json::Value>(&r.body).ok())
            .filter(|m| m["method"] == name)
            .count()
    }

    fn closed_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("綁埠");
        listener.local_addr().expect("位址").port()
    }

    /// 每個請求都回 403，主體照抄請求的路徑（含 query）與 `x-key` 標頭：server 把秘密反射回錯誤裡。
    fn echoing_forbidden() -> u16 {
        let server = TlsServer::start(Arc::new(|request: &Request| {
            let body = format!(
                "denied {} {}",
                request.path,
                request.header("x-key").unwrap_or("")
            );
            Response::new(403, "text/plain", body)
        }));
        server.port
    }

    fn quiet() -> Log {
        Log {
            info: Arc::new(|_: &str| {}),
            error: Arc::new(|_: &str| {}),
        }
    }

    #[tokio::test]
    async fn 舊協定_分頁走完並帶上設定的標頭() {
        let mut fake = FakeMcp::with_tools(false, &["a"]);
        fake.pages.insert(
            String::new(),
            (vec!["a".into(), String::new()], Some("p2".into())),
        );
        fake.pages
            .insert("p2".into(), (vec!["b".into()], Some("p2".into())));
        fake.instructions = Some("use me  \n\n".into());
        let (port, log) = start(fake);
        let s = server(port, json!({}));
        let generation = connect(&s, &client(), &s.secrets()).await.expect("連得上");
        assert!(!generation.caller.modern);
        assert_eq!(
            names(&generation.listed.tools),
            ["a", "b"],
            "空名略過、重複的 cursor 就停"
        );
        assert_eq!(
            generation.listed.instructions,
            "### MCP server: fake\n\nuse me"
        );
        assert!(
            call_meta(generation.caller.modern, true).is_none(),
            "舊協定不在每次呼叫帶能力"
        );
        let seen = log.lock().expect("鎖").clone();
        let posts: Vec<&Request> = seen.iter().filter(|r| r.method == "POST").collect();
        assert!(posts
            .iter()
            .all(|r| r.header("authorization") == Some("Bearer s3cret-token")));
        let messages: Vec<serde_json::Value> = posts
            .iter()
            .map(|r| serde_json::from_slice(&r.body).expect("JSON"))
            .collect();
        assert_eq!(messages[0]["method"], "server/discover", "先試新協定");
        let init = messages
            .iter()
            .find(|m| m["method"] == "initialize")
            .expect("再退回 initialize");
        assert_eq!(init["params"]["clientInfo"]["name"], "@nexus/plugin-mcp");
        assert_eq!(init["params"]["protocolVersion"], "2025-11-25");
        tokio::time::timeout(Duration::from_secs(5), generation.close())
            .await
            .expect("收得掉");
    }

    #[tokio::test]
    async fn 新協定_每次呼叫自己帶反問能力() {
        let (port, _log) = start(FakeMcp::with_tools(true, &["x", "y"]));
        let s = server(port, json!({}));
        let generation = connect(&s, &client(), &s.secrets()).await.expect("連得上");
        assert!(generation.caller.modern);
        assert_eq!(names(&generation.listed.tools), ["x", "y"]);
        assert_eq!(generation.listed.instructions, "");
        let meta = call_meta(generation.caller.modern, true).expect("新協定要帶");
        assert_eq!(
            serde_json::to_value(&meta).expect("編")["io.modelcontextprotocol/clientCapabilities"],
            json!({ "elicitation": { "form": {}, "url": {} } })
        );
        assert!(
            call_meta(generation.caller.modern, false).is_none(),
            "關了反問就不帶"
        );
        tokio::time::timeout(Duration::from_secs(5), generation.close())
            .await
            .expect("收得掉");
    }

    #[tokio::test]
    async fn 指引超過上限就連不上() {
        let mut fake = FakeMcp::with_tools(false, &["a"]);
        fake.instructions = Some("x".repeat(100));
        let (port, _log) = start(fake);
        let s = server(port, json!({ "maxInstructionBytes": 64 }));
        let err = connect(&s, &client(), &s.secrets())
            .await
            .err()
            .expect("要失敗");
        assert_eq!(err, "server instructions exceed maxInstructionBytes (64)");
    }

    #[test]
    fn 指引_空白當沒有_剛好到上限照收() {
        let s = |max: u64| {
            Server::parse(&json!({
                "serverName": "ab",
                "connection": { "transport": "http", "url": "https://h/" },
                "maxInstructionBytes": max,
            }))
            .expect("設定")
        };
        assert_eq!(instructions_of(None, &s(64)), Ok(String::new()));
        assert_eq!(instructions_of(Some(" \n\t "), &s(64)), Ok(String::new()));
        // 標頭 `### MCP server: ab\n\n` 20 個位元組，加「中」3 個。
        assert_eq!(
            instructions_of(Some("中 \n"), &s(23)),
            Ok("### MCP server: ab\n\n中".to_string())
        );
        assert!(instructions_of(Some("中"), &s(22)).is_err());
    }

    #[tokio::test]
    async fn 列工具失敗的訊息照_ts() {
        let mut fake = FakeMcp::with_tools(true, &[]);
        fake.list_fails = true;
        let (port, _log) = start(fake);
        let s = server(port, json!({}));
        let err = connect(&s, &client(), &s.secrets())
            .await
            .err()
            .expect("要失敗");
        assert!(
            err.starts_with("Failed to load tools from server \"fake\": "),
            "{err}"
        );
        assert!(err.contains("list exploded"), "{err}");
    }

    /// 舊協定的假 server 會發 session：連線回錯的當下，那一代已經收掉、送過 session DELETE，不留給背景。
    #[tokio::test]
    async fn 握手之後失敗_回錯前先收掉那一代() {
        for case in ["列工具失敗", "指引超過上限"] {
            let mut fake = FakeMcp::with_tools(false, &["a"]);
            let mut extra = json!({});
            if case == "列工具失敗" {
                fake.list_fails = true;
            } else {
                fake.instructions = Some("x".repeat(100));
                extra = json!({ "maxInstructionBytes": 64 });
            }
            let (port, log) = start(fake);
            let s = server(port, extra);
            connect(&s, &client(), &s.secrets())
                .await
                .err()
                .expect("要失敗");
            let deletes = log
                .lock()
                .expect("鎖")
                .iter()
                .filter(|r| r.method == "DELETE")
                .count();
            assert_eq!(deletes, 1, "{case}");
        }
    }

    #[tokio::test]
    async fn 連不上的訊息照_ts_而且不帶秘密() {
        let port = closed_port();
        let config = json!({
            "serverName": "gone",
            "connection": {
                "transport": "http",
                "url": format!("https://127.0.0.1:{port}/mcp?token=q-77"),
                "headers": { "X-Key": "hdr-41a" },
            },
        });
        let s = Server::parse(&config).expect("設定");
        let err = connect(&s, &client(), &s.secrets())
            .await
            .err()
            .expect("要失敗");
        let prefix = format!(
            "Failed to connect to streamable HTTP server \"gone, url: https://127.0.0.1:{port}/mcp\" in auto mode: "
        );
        assert!(err.starts_with(&prefix), "{err}");
        for secret in ["q-77", "hdr-41a"] {
            assert!(!err.contains(secret), "{err}");
        }
    }

    #[tokio::test]
    async fn server_回非_2xx_錯誤不帶秘密() {
        let port = echoing_forbidden();
        let s = Server::parse(&json!({
            "serverName": "deny",
            "connection": {
                "transport": "http",
                "url": format!("https://localhost:{port}/mcp?token=q-77"),
                "headers": { "X-Key": "hdr-41a" },
            },
        }))
        .expect("設定");
        let err = connect(&s, &client(), &s.secrets())
            .await
            .err()
            .expect("要失敗");
        assert!(
            err.starts_with("Failed to connect to streamable HTTP server \"deny, url: "),
            "{err}"
        );
        assert!(err.contains("[redacted]"), "反射回來的秘密要換掉：{err}");
        for secret in ["q-77", "hdr-41a"] {
            assert!(!err.contains(secret), "{err}");
        }
    }

    #[tokio::test]
    async fn 只信設定的根() {
        let (port, _log) = start(FakeMcp::with_tools(false, &["a"]));
        let s = server(port, json!({}));
        let config = client_config(&fixture("ca-b.pem")).expect("根");
        let http = http_client(config, &ProxyPolicy::direct()).expect("客戶端");
        let err = connect(&s, &http, &s.secrets())
            .await
            .err()
            .expect("要失敗");
        assert!(
            err.starts_with("Failed to connect to streamable HTTP server"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn 呼叫端判斷線就算掉線() {
        let (port, _log) = start(FakeMcp::with_tools(false, &["a"]));
        let s = server(port, json!({}));
        let generation = connect(&s, &client(), &s.secrets()).await.expect("連得上");
        let pending = tokio::time::timeout(Duration::from_millis(100), generation.down()).await;
        assert!(pending.is_err(), "還連著");
        generation.lost_signal().notify_one();
        tokio::time::timeout(Duration::from_secs(5), generation.down())
            .await
            .expect("判斷線之後 down 要完成");
        tokio::time::timeout(Duration::from_secs(5), generation.close())
            .await
            .expect("收得掉");
    }

    #[tokio::test]
    async fn 池經真連線_取用呼叫重連與關池() {
        let (port, log) = start(FakeMcp::with_tools(false, &["a"]));
        let pool = Pool::new(Http::new(client()), Vec::new(), quiet(), None);
        let s = server(
            port,
            json!({ "reconnect": { "initialDelayMs": 20, "maxDelayMs": 40 } }),
        );
        let (one, two) = tokio::join!(pool.acquire(&s, true), pool.acquire(&s, true));
        let (one, two) = (one.expect("取得到"), two.expect("取得到"));
        assert!(Arc::ptr_eq(&one.shared, &two.shared));
        assert!(one.error.is_none() && two.error.is_none());
        assert_eq!(count(&log, "initialize"), 1, "同一份設定只握手一次");
        assert_eq!(names(&one.shared.listed().expect("有清單").tools), ["a"]);

        let live = one.shared.current().expect("連著");
        assert!(!live.peer.modern);
        let result = live
            .peer
            .peer
            .call_tool_once(CallToolRequestParams::new("a"))
            .await
            .expect("呼叫得到");
        let text = format!("{result:?}");
        assert!(text.contains(r#"\"a\":null"#), "{text}");

        live.lost();
        for _ in 0..400 {
            if one.shared.current().is_some_and(|l| l.generation == 2) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            one.shared.current().expect("重連上").generation,
            2,
            "lost() 之後重連"
        );
        assert_eq!(count(&log, "initialize"), 2);

        let (modern_port, _modern_log) = start(FakeMcp::with_tools(true, &["m"]));
        let modern = pool
            .acquire(&server(modern_port, json!({})), true)
            .await
            .expect("取得到");
        assert!(modern.shared.current().expect("連著").peer.modern);

        let deletes = || {
            log.lock()
                .expect("鎖")
                .iter()
                .filter(|r| r.method == "DELETE")
                .count()
        };
        assert_eq!(deletes(), 1, "換代時收掉的那一代刪了它的 session");
        tokio::time::timeout(Duration::from_secs(5), pool.close())
            .await
            .expect("關池在期限內返回");
        assert_eq!(deletes(), 2, "關池刪掉活著那一代的 session");
    }

    #[tokio::test]
    async fn 池經真連線_錯誤照樣遮蔽() {
        let port = echoing_forbidden();
        let pool = Pool::new(Http::new(client()), Vec::new(), quiet(), None);
        let s = Server::parse(&json!({
            "serverName": "deny",
            "connection": {
                "transport": "http",
                "url": format!("https://localhost:{port}/mcp?token=q-77"),
                "headers": { "X-Key": "hdr-41a" },
            },
            "failOnStartupError": true,
        }))
        .expect("設定");
        let err = pool.acquire(&s, true).await.err().expect("要失敗");
        assert!(err.starts_with("Failed to connect"), "{err}");
        for secret in ["q-77", "hdr-41a"] {
            assert!(!err.contains(secret), "{err}");
        }
        tokio::time::timeout(Duration::from_secs(5), pool.close())
            .await
            .expect("關池在期限內返回");
    }

    mod bridge {
        use super::*;
        use nexus_host::mcp::bridge::{Bridge, Command, Outcome};

        /// 等喚醒 fd 可讀、取走結果，直到 `want` 挑中一則；其餘的（日誌等）丟掉。
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
                // SAFETY: 一個 pollfd。
                unsafe { libc::poll(&mut fd, 1, left.as_millis() as libc::c_int) };
            }
        }

        fn opened(bridge: &Bridge, open: u64) -> Result<nexus_host::mcp::bridge::Opened, String> {
            match wait_for(
                bridge,
                |o| matches!(o, Outcome::Opened { open: n, .. } if *n == open),
            ) {
                Outcome::Opened { result, .. } => result,
                _ => unreachable!(),
            }
        }

        fn done(bridge: &Bridge, id: u64) -> Result<String, String> {
            match wait_for(
                bridge,
                |o| matches!(o, Outcome::Done { id: n, .. } if *n == id),
            ) {
                Outcome::Done { result, .. } => result,
                _ => unreachable!(),
            }
        }

        fn call(bridge: &Bridge, id: u64, open: u64, tool: &str) {
            bridge.send(Command::Request {
                id,
                open,
                method: "tools/call".into(),
                params: json!({ "name": tool, "arguments": { "x": 1 } }),
            });
        }

        /// rmcp 把結果解成自己的型別再序列化：認得的形狀丟掉規格外的欄位；有不認得的內容區塊型別時整個結果認不得，原樣交回。
        #[test]
        fn 規格外的欄位_認得的形狀丟掉_認不得的原樣() {
            let (port, _log) = start(FakeMcp::with_tools(false, &["odd"]));
            let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
            bridge.send(Command::Open {
                open: 1,
                server: Box::new(server(port, json!({}))),
                elicitation: false,
            });
            opened(&bridge, 1).expect("連得上");
            for (id, unknown) in [(10, false), (11, true)] {
                bridge.send(Command::Request {
                    id,
                    open: 1,
                    method: "tools/call".into(),
                    params: json!({ "name": "odd", "arguments": { "unknown": unknown } }),
                });
                let result: serde_json::Value =
                    serde_json::from_str(&done(&bridge, id).expect("呼叫成功")).expect("JSON 文字");
                if unknown {
                    assert_eq!(result, common::fake_mcp::odd_result(true));
                } else {
                    assert_eq!(result.get("x-top"), None);
                    assert_eq!(result["content"][0].get("extra"), None);
                }
            }
        }

        #[test]
        fn 綁定_呼叫_收橋() {
            let (port, log) = start(FakeMcp::with_tools(true, &["echo", "slow"]));
            let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
            bridge.send(Command::Open {
                open: 1,
                server: Box::new(server(port, json!({}))),
                elicitation: true,
            });
            let listed = opened(&bridge, 1).expect("連得上");
            assert!(listed.warning.is_none());
            let tools: serde_json::Value = serde_json::from_str(&listed.tools).expect("JSON 文字");
            let names: Vec<&str> = tools
                .as_array()
                .expect("陣列")
                .iter()
                .map(|t| t["name"].as_str().expect("名字"))
                .collect();
            assert_eq!(names, ["echo", "slow"]);
            // 工具定義的鍵照 server 送的順序，不排序。
            assert!(
                listed
                    .tools
                    .contains(r#""properties":{"zeta":{},"alpha":{}}"#),
                "{}",
                listed.tools
            );

            call(&bridge, 10, 1, "echo");
            let result: serde_json::Value =
                serde_json::from_str(&done(&bridge, 10).expect("呼叫成功")).expect("JSON 文字");
            assert_eq!(result["content"][0]["text"], r#""echo":{"x":1}"#);
            let sent = log
                .lock()
                .expect("鎖")
                .iter()
                .map(|r| serde_json::from_slice::<serde_json::Value>(&r.body).unwrap_or_default())
                .find(|m| m["method"] == "tools/call")
                .expect("送了 tools/call");
            assert_eq!(
                sent["params"]["_meta"]["io.modelcontextprotocol/clientCapabilities"],
                json!({ "elicitation": { "form": {}, "url": {} } }),
                "新協定每次呼叫帶反問能力"
            );

            call(&bridge, 11, 99, "echo");
            assert!(done(&bridge, 11).is_err_and(|e| e.contains("99")));
            bridge.send(Command::Request {
                id: 12,
                open: 1,
                method: "prompts/list".into(),
                params: json!({}),
            });
            assert!(done(&bridge, 12).is_err_and(|e| e.contains("prompts/list")));

            bridge.send(Command::Shutdown);
            wait_for(&bridge, |o| *o == Outcome::Closed);
        }

        #[test]
        fn 取消當場回_逾時回錯() {
            let (port, log) = start(FakeMcp::with_tools(false, &["slow"]));
            let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
            bridge.send(Command::Open {
                open: 1,
                server: Box::new(server(port, json!({ "toolCallTimeoutMs": 300 }))),
                elicitation: false,
            });
            opened(&bridge, 1).expect("連得上");
            let started = std::time::Instant::now();
            call(&bridge, 1, 1, "slow");
            let err = done(&bridge, 1).expect_err("逾時");
            assert!(err.contains("timeout"), "{err}");
            assert!(started.elapsed() < Duration::from_secs(2));

            bridge.send(Command::Open {
                open: 2,
                server: Box::new(server(port, json!({}))),
                elicitation: false,
            });
            opened(&bridge, 2).expect("連得上");
            let started = std::time::Instant::now();
            call(&bridge, 2, 2, "slow");
            bridge.send(Command::Cancel { id: 2 });
            assert_eq!(done(&bridge, 2), Err("cancelled".into()));
            assert!(started.elapsed() < Duration::from_secs(2));
            let notified = (0..100).any(|_| {
                std::thread::sleep(Duration::from_millis(10));
                log.lock().expect("鎖").iter().any(|r| {
                    let m =
                        serde_json::from_slice::<serde_json::Value>(&r.body).unwrap_or_default();
                    m["method"] == "notifications/cancelled" && m["params"]["reason"] == "cancelled"
                })
            });
            assert!(notified, "取消要通知 server");
            drop(bridge);
        }

        #[test]
        fn 連不上照樣綁定_呼叫回斷線() {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("綁埠");
            let port = listener.local_addr().expect("位址").port();
            drop(listener);
            let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
            bridge.send(Command::Open {
                open: 1,
                server: Box::new(server(port, json!({ "reconnect": { "enabled": false } }))),
                elicitation: true,
            });
            let listed = opened(&bridge, 1).expect("沒要求失敗就照樣綁定");
            assert_eq!(listed.tools, "[]");
            let warning = listed.warning.expect("帶原因");
            assert!(warning.starts_with("Failed to connect"), "{warning}");
            assert!(!warning.contains("s3cret-token"));
            call(&bridge, 1, 1, "echo");
            let err = done(&bridge, 1).expect_err("斷線");
            assert!(
                err.starts_with("mcp-client(fake): server is disconnected"),
                "{err}"
            );

            bridge.send(Command::Open {
                open: 2,
                server: Box::new(server(port, json!({ "failOnStartupError": true }))),
                elicitation: true,
            });
            let err = opened(&bridge, 2).expect_err("要求失敗就回錯");
            assert!(err.starts_with("Failed to connect"), "{err}");
        }

        #[test]
        fn sse_一則事件超過上限只讓這一則失敗_剛好不超過照收_同一代照用() {
            let mut fake = FakeMcp::with_tools(true, &["big", "echo"]);
            fake.sse = true;
            let (port, log) = start(fake);
            let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
            bridge.send(Command::Open {
                open: 1,
                server: Box::new(server(port, json!({}))),
                elicitation: false,
            });
            opened(&bridge, 1).expect("連得上");
            let big = |id: u64, bytes: usize| {
                bridge.send(Command::Request {
                    id,
                    open: 1,
                    method: "tools/call".into(),
                    params: json!({ "name": "big", "arguments": { "bytes": bytes } }),
                });
                done(&bridge, id)
            };
            // BIG_PATTERN 6 個位元組，編進 JSON 字串是 8 個：事件大小約是 bytes 的 4/3，±6 KiB 落在 16 MiB 兩側 8 KiB。
            let limit = 12 * 1024 * 1024;
            let err = big(1, limit + 6 * 1024).expect_err("超過上限");
            assert_eq!(
                err,
                "mcp-client(fake): response stream closed before its final response"
            );
            call(&bridge, 2, 1, "echo");
            done(&bridge, 2).expect("超限之後同一代照用，沒有斷線空窗");
            let bytes = limit - 6 * 1024;
            let result: serde_json::Value =
                serde_json::from_str(&big(3, bytes).expect("剛好不超過照收")).expect("JSON 文字");
            assert_eq!(
                result["content"][0]["text"],
                common::fake_mcp::big_text(bytes).as_str()
            );
            let handshakes = log
                .lock()
                .expect("鎖")
                .iter()
                .filter(|r| {
                    serde_json::from_slice::<serde_json::Value>(&r.body).unwrap_or_default()
                        ["method"]
                        == "server/discover"
                })
                .count();
            assert_eq!(handshakes, 1, "超限不判掉線，不重連");
        }

        /// server 對 `tools/call` 的 `reflect` 回 403，主體照抄 query 與 `x-key` 標頭：橋回的錯要換掉這一列的秘密。
        #[test]
        fn 呼叫的錯誤不帶秘密() {
            let log: Arc<Mutex<Vec<Request>>> = Arc::default();
            let inner = handler(FakeMcp::with_tools(true, &["reflect"]), log);
            let tls = TlsServer::start(Arc::new(move |request: &Request| {
                let message =
                    serde_json::from_slice::<serde_json::Value>(&request.body).unwrap_or_default();
                if message["params"]["name"] == "reflect" {
                    let body = format!(
                        "denied {} {}",
                        request.path,
                        request.header("x-key").unwrap_or("")
                    );
                    return Response::new(403, "text/plain", body);
                }
                inner(request)
            }));
            let s = Server::parse(&json!({
                "serverName": "deny",
                "connection": {
                    "transport": "http",
                    "url": format!("https://localhost:{}/mcp?token=q-77", tls.port),
                    "headers": { "X-Key": "hdr-41a" },
                },
            }))
            .expect("設定");
            let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
            bridge.send(Command::Open {
                open: 1,
                server: Box::new(s),
                elicitation: false,
            });
            opened(&bridge, 1).expect("連得上");
            call(&bridge, 1, 1, "reflect");
            let err = done(&bridge, 1).expect_err("403");
            assert!(err.contains("[redacted]"), "反射回來的秘密要換掉：{err}");
            for secret in ["q-77", "hdr-41a"] {
                assert!(!err.contains(secret), "{err}");
            }
        }
    }
}
