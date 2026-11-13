//! `nexus_host::mcp` 的 stdio（#2570 D2b-2）：設定怎麼收、環境怎麼交給子行程、成功結果裡的憑證值遮掉、收線不留子行程。
//! 假 server 是一段 `/bin/sh`：照行讀 JSON-RPC、回罐頭回應，不依賴別的執行環境。

mod common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::fixture;
use nexus_host::mcp::bridge::{Bridge, Command, Outcome};
use nexus_host::mcp::config::{Connection, Server};
use nexus_host::mcp::stdio::{self, STDIN_GRACE};
use nexus_host::proxy::ProxyPolicy;
use nexus_host::tls::{client_config, http_client};
use serde_json::{json, Value};

const SECRET: &str = "FAKE-secret-value-0001";
const PLAIN: &str = "plain-value-xyz";

/// 一個回罐頭的 MCP server：`server/discover` 回「方法不存在」（退回 `initialize`），`tools/call` 把自己的環境回顯在文字裡。
const FAKE_SERVER: &str = r#"
echo $$ > "$PIDFILE"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"server/discover"'*)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id";;
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"0"}}}\n' "$id";;
    *'"method":"tools/list"'*)
      if [ -n "$STALL_LIST" ]; then : > "$MARK"; else
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}}\n' "$id"; fi;;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"secret=%s plain=%s probe=%s"}],"isError":false}}\n' "$id" "$FAKE_SECRET" "$PLAIN" "${NEXUS_STDIO_TEST_PROBE-unset}";;
  esac
done
"#;

fn pid_file(tag: &str) -> String {
    format!(
        "{}/nexus-host-stdio-{}-{tag}.pid",
        std::env::temp_dir().display(),
        std::process::id()
    )
}

/// 假 server 的設定。`PATH` 給 `sed` 用；`NEXUS_STDIO_TEST_PROBE` 故意不給（測試行程自己有設），驗證宿主沒有把自己的環境帶進去。
fn fake_config(pid_file: &str) -> Value {
    fake_config_with(pid_file, &[])
}

fn fake_config_with(pid_file: &str, extra_env: &[(&str, &str)]) -> Value {
    let mut config = json!({
        "serverName": "fake",
        "connection": {
            "transport": "stdio",
            "command": "/bin/sh",
            "args": ["-c", FAKE_SERVER],
            "env": {
                "PATH": "/usr/bin:/bin",
                "PIDFILE": pid_file,
                "FAKE_SECRET": SECRET,
                "PLAIN": PLAIN,
            },
            "credentialEnv": ["FAKE_SECRET"],
        },
    });
    for (name, value) in extra_env {
        config["connection"]["env"][*name] = json!(value);
    }
    config
}

fn parse_err(connection: Value) -> String {
    Server::parse(&json!({ "serverName": "a", "connection": connection })).expect_err("要拒絕")
}

#[test]
fn 設定_形狀與憑證值的檢查() {
    let ok = json!({
        "transport": "stdio", "command": "/bin/true", "args": ["a"], "cwd": "/",
        "env": { "PATH": "/bin", "TOKEN_X": "abcdefgh-1234" }, "credentialEnv": ["TOKEN_X"],
    });
    let server = Server::parse(&json!({ "serverName": "a", "connection": ok })).expect("收");
    let Connection::Stdio(stdio) = &server.connection else {
        panic!("要是 stdio");
    };
    assert_eq!(stdio.command, "/bin/true");
    assert_eq!(stdio.credential_env, ["TOKEN_X"]);

    let with = |patch: Value| {
        let mut connection = ok.clone();
        for (k, v) in patch.as_object().expect("物件") {
            connection[k] = v.clone();
        }
        parse_err(connection)
    };
    assert!(with(json!({ "command": "true" })).contains("connection.command"));
    assert!(with(json!({ "command": "/bin/tr\0ue" })).contains("connection.command"));
    assert!(with(json!({ "args": "a" })).contains("connection.args"));
    assert!(with(json!({ "args": [1] })).contains("connection.args"));
    assert!(with(json!({ "cwd": "relative" })).contains("connection.cwd"));
    assert!(with(json!({ "env": ["PATH"] })).contains("connection.env"));
    assert!(with(json!({ "env": { "A=B": "x" } })).contains("connection.env"));
    assert!(with(json!({ "env": { "A": 1 } })).contains("connection.env.A"));
    assert!(with(json!({ "extra": 1 })).contains("不認得的欄位 extra"));
    assert!(with(json!({ "credentialEnv": [1] })).contains("credentialEnv"));

    // 標成憑證的名字一定要在 env 裡。
    let missing = with(json!({ "credentialEnv": ["NOT_THERE"] }));
    assert!(
        missing.contains("NOT_THERE") && missing.contains("不在 connection.env"),
        "{missing}"
    );
    // 憑證值照 D2b-1 的門檻：不到 8 個字元、含 NUL、修完是空的都拒；沒標成憑證的短值不管。
    for (value, want) in [
        ("short", "不到 8"),
        ("a\0bcdefghij", "NUL"),
        ("   ", "空白"),
    ] {
        let err = with(json!({ "env": { "TOKEN_X": value }, "credentialEnv": ["TOKEN_X"] }));
        assert!(err.contains(want) && err.contains("TOKEN_X"), "{err}");
        assert!(
            !err.contains(value.trim()) || value.trim().is_empty(),
            "{err}"
        );
    }
    Server::parse(&json!({ "serverName": "a", "connection": with_short_literal() }))
        .expect("沒標成憑證的短值照收");
}

fn with_short_literal() -> Value {
    json!({ "transport": "stdio", "command": "/bin/true", "env": { "LANG": "C" } })
}

#[test]
fn 只有標成憑證的值進遮蔽器() {
    let server = Server::parse(&fake_config("/tmp/x")).expect("收");
    assert_eq!(server.secrets(), [SECRET], "PATH、PLAIN 這類字面值不進");
    let shown = format!("{server:?}");
    assert!(
        !shown.contains(SECRET) && !shown.contains(PLAIN) && !shown.contains("-c"),
        "Debug 不印 env 的值與 args：{shown}"
    );
}

#[test]
fn 池的鍵_同一份成品同一把_換了憑證換一把() {
    let key = |config: Value| Server::parse(&config).expect("收").pool_key(true);
    let a = fake_config("/tmp/x");
    assert_eq!(key(a.clone()), key(a.clone()));
    let mut reordered = a.clone();
    reordered["connection"]["credentialEnv"] = json!(["FAKE_SECRET", "FAKE_SECRET"]);
    assert_eq!(
        key(a.clone()),
        key(reordered),
        "credentialEnv 重複的名字不改鍵"
    );
    let mut rotated = a.clone();
    rotated["connection"]["env"]["FAKE_SECRET"] = json!("FAKE-secret-value-0002");
    assert_ne!(key(a.clone()), key(rotated), "換了憑證是另一份");
    let mut unmarked = a.clone();
    unmarked["connection"]["credentialEnv"] = json!([]);
    assert_ne!(key(a), key(unmarked), "標不標成憑證是另一份");
}

mod bridge {
    use super::*;

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

    fn open(bridge: &Bridge, config: &Value) -> Result<nexus_host::mcp::bridge::Opened, String> {
        bridge.send(Command::Open {
            open: 1,
            server: Box::new(Server::parse(config).expect("設定")),
            elicitation: false,
        });
        match wait_for(bridge, |o| matches!(o, Outcome::Opened { .. })) {
            Outcome::Opened { result, .. } => result,
            _ => unreachable!(),
        }
    }

    fn call(bridge: &Bridge, id: u64) -> String {
        bridge.send(Command::Request {
            id,
            open: 1,
            method: "tools/call".into(),
            params: json!({ "name": "echo", "arguments": {} }),
        });
        match wait_for(
            bridge,
            |o| matches!(o, Outcome::Done { id: n, .. } if *n == id),
        ) {
            Outcome::Done { result, .. } => result.expect("呼叫成功"),
            _ => unreachable!(),
        }
    }

    fn gone(pid: i32) -> bool {
        // SAFETY: 訊號 0 只查行程在不在；沒被 `wait` 的殭屍查得到，所以這個查得到就是沒收乾淨。
        unsafe { libc::kill(pid, 0) == -1 }
    }

    #[test]
    fn 連上_環境只有交來的那份_憑證值被遮_收線不留子行程() {
        let pid_file = pid_file("bridge");
        let _ = std::fs::remove_file(&pid_file);
        std::env::set_var("NEXUS_STDIO_TEST_PROBE", "from-the-host-env");
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        let opened = open(&bridge, &fake_config(&pid_file)).expect("連得上");
        assert!(opened.tools.contains("\"echo\""), "{}", opened.tools);

        let text = call(&bridge, 10);
        let result: Value = serde_json::from_str(&text).expect("JSON");
        let shown = result["content"][0]["text"].as_str().expect("文字");
        assert_eq!(
            shown,
            format!("secret=[redacted] plain={PLAIN} probe=unset"),
            "憑證值遮掉、字面值照舊、宿主自己的環境變數沒有帶進去"
        );

        let pid: i32 = std::fs::read_to_string(&pid_file)
            .expect("子行程寫了 pid")
            .trim()
            .parse()
            .expect("pid");
        bridge.send(Command::Shutdown);
        wait_for(&bridge, |o| matches!(o, Outcome::Closed));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !gone(pid) {
            assert!(Instant::now() < deadline, "子行程 {pid} 沒有被收掉");
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = std::fs::remove_file(&pid_file);
    }

    fn read_pid(pid_file: &str) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(pid) = std::fs::read_to_string(pid_file)
                .ok()
                .and_then(|text| text.trim().parse().ok())
            {
                return pid;
            }
            assert!(Instant::now() < deadline, "子行程沒寫 pid");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_exists(path: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !Path::new(path).exists() {
            assert!(Instant::now() < deadline, "等不到 {path}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn assert_reaped(pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !gone(pid) {
            assert!(Instant::now() < deadline, "子行程 {pid} 沒有被收掉");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// 握手還在等 server 回的時候橋關閉：連線的 future 被丟下，子行程要被殺掉並 `wait` 掉。
    #[test]
    fn 握手中途被丟下_子行程被殺並收掉() {
        let pid_file = pid_file("handshake-drop");
        let _ = std::fs::remove_file(&pid_file);
        let config = json!({
            "serverName": "fake",
            "connection": {
                "transport": "stdio",
                "command": "/bin/sh",
                "args": ["-c", "echo $$ > \"$PIDFILE\"; exec sleep 300"],
                "env": { "PIDFILE": pid_file },
            },
        });
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        bridge.send(Command::Open {
            open: 1,
            server: Box::new(Server::parse(&config).expect("設定")),
            elicitation: false,
        });
        let pid = read_pid(&pid_file);
        bridge.send(Command::Shutdown);
        wait_for(&bridge, |o| matches!(o, Outcome::Closed));
        assert_reaped(pid);
        let _ = std::fs::remove_file(&pid_file);
    }

    /// 握手過了、`tools/list` 還在等 server 回的時候橋關閉：這一代被丟下，子行程要收掉。
    #[test]
    fn 列工具中途被丟下_子行程收掉() {
        let pid_file = pid_file("list-drop");
        let mark = format!("{pid_file}.mark");
        let _ = std::fs::remove_file(&pid_file);
        let _ = std::fs::remove_file(&mark);
        let config = fake_config_with(&pid_file, &[("STALL_LIST", "1"), ("MARK", &mark)]);
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        bridge.send(Command::Open {
            open: 1,
            server: Box::new(Server::parse(&config).expect("設定")),
            elicitation: false,
        });
        wait_exists(&mark);
        let pid = read_pid(&pid_file);
        bridge.send(Command::Shutdown);
        wait_for(&bridge, |o| matches!(o, Outcome::Closed));
        assert_reaped(pid);
        let _ = std::fs::remove_file(&pid_file);
        let _ = std::fs::remove_file(&mark);
    }

    /// server 讀了 stdin 卻不回：超過啟動上限就殺掉子行程、回連線失敗，不等到橋關閉。上限改成 300 ms，免得測試要等 30 秒。
    #[test]
    fn 啟動逾時_殺掉子行程並收掉_回逾時的訊息() {
        let pid_file = pid_file("startup-timeout");
        let _ = std::fs::remove_file(&pid_file);
        let config = json!({
            "serverName": "fake",
            "connection": {
                "transport": "stdio",
                "command": "/bin/sh",
                "args": ["-c", "echo $$ > \"$PIDFILE\"; exec cat > /dev/null"],
                "env": { "PIDFILE": pid_file },
            },
        });
        let mut server = Server::parse(&config).expect("設定");
        let Connection::Stdio(spec) = &mut server.connection else {
            unreachable!();
        };
        spec.startup_timeout = Duration::from_millis(300);
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        bridge.send(Command::Open {
            open: 1,
            server: Box::new(server),
            elicitation: false,
        });
        let opened = match wait_for(&bridge, |o| matches!(o, Outcome::Opened { .. })) {
            Outcome::Opened { result, .. } => result.expect("沒寫 failOnStartupError 照樣 Ok"),
            _ => unreachable!(),
        };
        let warning = opened.warning.expect("帶原因");
        assert!(
            warning.contains("Failed to connect to stdio server \"fake\"")
                && warning.contains("timed out after 300ms"),
            "{warning}"
        );
        assert_reaped(read_pid(&pid_file));
        bridge.send(Command::Shutdown);
        wait_for(&bridge, |o| matches!(o, Outcome::Closed));
        let _ = std::fs::remove_file(&pid_file);
    }

    #[test]
    fn 起不來的行程_回連線失敗的訊息_不帶憑證值() {
        let config = json!({
            "serverName": "fake",
            "connection": {
                "transport": "stdio",
                "command": "/nonexistent/prog",
                "env": { "FAKE_SECRET": SECRET },
                "credentialEnv": ["FAKE_SECRET"],
            },
        });
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        let opened = open(&bridge, &config).expect("沒寫 failOnStartupError 照樣 Ok");
        let warning = opened.warning.expect("帶原因");
        assert!(
            warning.contains("Failed to connect to stdio server \"fake\""),
            "{warning}"
        );
        assert!(!warning.contains(SECRET), "{warning}");
        bridge.send(Command::Shutdown);
        wait_for(&bridge, |o| matches!(o, Outcome::Closed));
    }
}

/// 子行程不理 stdin 的 EOF：等滿 [`STDIN_GRACE`] 之後 SIGTERM，收乾淨才回來。
#[test]
fn reap_收掉不理_eof_的子行程() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("執行環境");
    let spec = match Server::parse(&json!({
        "serverName": "a",
        "connection": {
            "transport": "stdio", "command": "/bin/sleep", "args": ["30"], "env": {},
        },
    }))
    .expect("收")
    .connection
    {
        Connection::Stdio(spec) => spec,
        Connection::Http { .. } => unreachable!(),
    };
    runtime.block_on(async {
        let stdio::Spawned { child, transport } = stdio::spawn(&spec).expect("起得來");
        let pid = child.id().expect("還沒收走") as i32;
        drop(transport);
        let started = Instant::now();
        stdio::reap(child).await;
        let took = started.elapsed();
        assert!(took >= STDIN_GRACE, "還沒到寬限就動手了：{took:?}");
        assert!(took < Duration::from_secs(10), "收太久：{took:?}");
        // SAFETY: 訊號 0 只查行程在不在；`reap` 回來時已經 `wait` 過，查不到才對。
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "子行程還在");
    });
}

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../credentials-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("讀樣本檔")).expect("樣本檔是 JSON")
}

fn parse_connection(connection: &Value) -> Result<Server, String> {
    Server::parse(&json!({ "serverName": "a", "connection": connection }))
}

/// TS 的 `hostStdioConnection` 輸出的那一列，宿主一律收（TS 的 `mcp-host-stdio-row.test.ts` 跑同一份 `stdioRow`）。
#[test]
fn 樣本_stdio_row_ts_交出的列宿主收得下() {
    let doc = vectors();
    let mut seen = 0;
    for vector in doc["stdioRow"].as_array().expect("stdioRow") {
        let name = vector["name"].as_str().expect("name");
        let Some(row) = vector["ts"].get("row") else {
            assert!(
                vector["ts"]["error"].is_string(),
                "{name}：要有 row 或 error"
            );
            continue;
        };
        let server = parse_connection(row).unwrap_or_else(|e| panic!("{name}：{e}"));
        let Connection::Stdio(stdio) = &server.connection else {
            panic!("{name}：要是 stdio");
        };
        assert_eq!(
            stdio.credential_env,
            row["credentialEnv"]
                .as_array()
                .expect("credentialEnv")
                .iter()
                .map(|v| v.as_str().expect("字串").to_string())
                .collect::<Vec<_>>(),
            "{name}"
        );
        seen += 1;
    }
    assert!(seen >= 5, "有 row 的樣本太少：{seen}");
}

#[test]
fn 樣本_stdio_host_宿主自己的拒絕() {
    let doc = vectors();
    for vector in doc["stdioHost"].as_array().expect("stdioHost") {
        let name = vector["name"].as_str().expect("name");
        let result = parse_connection(&vector["connection"]);
        match vector["error"].as_str() {
            None => {
                result.unwrap_or_else(|e| panic!("{name}：{e}"));
            }
            Some(want) => {
                let err = result.err().unwrap_or_else(|| panic!("{name}：要拒絕"));
                assert!(err.contains(want), "{name}：{err} 不含 {want}");
            }
        }
    }
}
