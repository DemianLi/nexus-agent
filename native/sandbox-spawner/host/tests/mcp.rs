//! `nexus_host::mcp::config`：一台 HTTP server 的設定解析，與錯誤訊息裡的秘密遮蔽；
//! `nexus_host::mcp::pool`：一份設定共用一份連線，一代怎麼連換成記憶體裡的假 [`Connector`](nexus_host::mcp::pool::Connector)。

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

    let err = Server::parse(&json!({
        "serverName": "a",
        "connection": { "transport": "http", "url": "https://h/", "headers": { "A": "line\nbreak-secret" } },
    }))
    .expect_err("要拒絕");
    assert!(!err.contains("break-secret"), "錯誤不帶 header 值：{err}");
}

#[test]
fn 遮蔽先換長的() {
    let secrets = vec!["ab".to_string(), "abcd".to_string(), String::new()];
    assert_eq!(scrub("x abcd y ab", &secrets), "x [redacted] y [redacted]");
}

#[test]
fn debug_不印秘密() {
    let s = Server::parse(&json!({
        "serverName": "a",
        "connection": {
            "transport": "http",
            "url": "https://u-55:p-66@h/x?k=q-77",
            "headers": { "Authorization": "Bearer hdr-88" },
        },
    }))
    .expect("設定");
    let shown = format!("{s:?}");
    for secret in ["u-55", "p-66", "q-77", "hdr-88"] {
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
