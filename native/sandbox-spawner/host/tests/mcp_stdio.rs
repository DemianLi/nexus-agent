//! `nexus_host::mcp` 的 stdio（#2570 D2b-2）：設定怎麼收、環境怎麼交給子行程、成功結果裡的憑證值遮掉、收線不留子行程。
//! 假 server 是一段 `/bin/sh`：照行讀 JSON-RPC、回罐頭回應，不依賴別的執行環境。

mod common;
/// spawner 在另一個 package，見 `spawner_common::built`。
#[cfg(target_os = "linux")]
#[path = "../../tests/common/mod.rs"]
mod spawner_common;

use std::path::Path;
use std::time::{Duration, Instant};

use common::fixture;
use nexus_host::mcp::bridge::{Bridge, Command, Outcome};
use nexus_host::mcp::config::{Connection, Server};
use nexus_host::mcp::stdio::{self, REAP_BUDGET, STDIN_GRACE, TERM_GRACE};
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
# 讀到 EOF 不結束：收到 SIGTERM 才留記號、結束。測「收線走 SIGTERM 梯度」用。
if [ -n "$HANG_ON_EOF" ]; then
  trap ': > "$TERM_MARK"; exit 0' TERM
  while :; do sleep 0.05; done
fi
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
        let started = Instant::now();
        while !gone(pid) {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "子行程 {pid} 等了 {:?} 還沒被收掉",
                started.elapsed()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// 橋正常關閉：server 讀到 EOF 不結束，要等 `reap` 的 SIGTERM 才結束並留記號。收線走完 SIGTERM 梯度、領頭才收；
    /// 不是橋的執行緒一結束就被 `PR_SET_PDEATHSIG` 搶先殺（那樣沒有記號）。
    #[test]
    fn 橋正常關閉_server_走_sigterm_梯度() {
        let pid_file = pid_file("bridge-term");
        let mark = format!("{pid_file}.term");
        let _ = std::fs::remove_file(&pid_file);
        let _ = std::fs::remove_file(&mark);
        let config = fake_config_with(&pid_file, &[("HANG_ON_EOF", "1"), ("TERM_MARK", &mark)]);
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        open(&bridge, &config).expect("連得上");
        let pid = read_pid(&pid_file);
        bridge.send(Command::Shutdown);
        wait_for(&bridge, |o| matches!(o, Outcome::Closed));
        assert!(
            Path::new(&mark).exists(),
            "server 沒收到 SIGTERM：收線沒有走梯度，或被搶先殺了"
        );
        assert_reaped(pid);
        let _ = std::fs::remove_file(&pid_file);
        let _ = std::fs::remove_file(&mark);
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
    /// 橋關閉時 `serve` 回來、執行環境跟著拆掉，背景 task 來不及跑完梯度，最後收尾的是 `ChildGuard` 的 drop；
    /// 這條釘的是那個收尾（`CancelOnDrop` 由下一條釘，它要執行環境還活著才看得到）。
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

    /// 握手過了、`tools/list` 還在等的時候撞到啟動上限，**橋還活著**：連線的 future 被丟下，這一代沒走 `close`。
    /// 握手之後子行程的擁有者是背景 task，正常路徑是 `CancelOnDrop` 喊停、服務迴圈結束、背景 task 照梯度收；
    /// 沒有喊停，那個 task 永遠等不到結束，子行程就活到橋關閉（執行環境被拆時才落到 `ChildGuard` 的 drop）。
    /// 所以這條要在橋關閉之前就看到子行程被收掉。
    #[test]
    fn 列工具撞到啟動上限_橋還活著_子行程由喊停收掉() {
        let pid_file = pid_file("list-timeout");
        let mark = format!("{pid_file}.mark");
        let _ = std::fs::remove_file(&pid_file);
        let _ = std::fs::remove_file(&mark);
        let config = fake_config_with(&pid_file, &[("STALL_LIST", "1"), ("MARK", &mark)]);
        let mut server = Server::parse(&config).expect("設定");
        let Connection::Stdio(spec) = &mut server.connection else {
            unreachable!();
        };
        // 握手要在上限內完成才會走到列工具；假 server 回得很快，2 秒留給慢的 runner。
        spec.startup_timeout = Duration::from_secs(2);
        let bridge = Bridge::start(client(), Vec::new()).expect("起橋");
        bridge.send(Command::Open {
            open: 1,
            server: Box::new(server),
            elicitation: false,
        });
        // 先拿 pid：連線失敗後監督者會重連，pid 檔之後會被新的子行程覆寫。
        wait_exists(&mark);
        let pid = read_pid(&pid_file);
        let opened = match wait_for(&bridge, |o| matches!(o, Outcome::Opened { .. })) {
            Outcome::Opened { result, .. } => result.expect("沒寫 failOnStartupError 照樣 Ok"),
            _ => unreachable!(),
        };
        assert!(
            opened
                .warning
                .is_some_and(|w| w.contains("timed out after 2s")),
            "要是啟動上限逾時"
        );
        assert_reaped(pid);
        bridge.send(Command::Shutdown);
        wait_for(&bridge, |o| matches!(o, Outcome::Closed));
        let _ = std::fs::remove_file(&pid_file);
        let _ = std::fs::remove_file(&mark);
    }

    /// server 讀了 stdin 卻不回（`3>&1` 先把宿主讀的 stdout 管線留在 fd 3：直接把 fd 1 導走，管線沒人寫，宿主會立刻讀到 EOF）：超過啟動上限就殺掉子行程、回連線失敗，不等到橋關閉。上限改成 300 ms，免得測試要等 30 秒。
    #[test]
    fn 啟動逾時_殺掉子行程並收掉_回逾時的訊息() {
        let pid_file = pid_file("startup-timeout");
        let _ = std::fs::remove_file(&pid_file);
        let config = json!({
            "serverName": "fake",
            "connection": {
                "transport": "stdio",
                "command": "/bin/sh",
                "args": ["-c", "echo $$ > \"$PIDFILE\"; exec cat 3>&1 > /dev/null"],
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

/// 起一個 stdio 子行程（沒有憑證、沒有環境），回起好的行程與它的 pid。
fn spawn_for_reap(command: &str, args: &[&str]) -> (stdio::Spawned, i32) {
    let spec = match Server::parse(&json!({
        "serverName": "a",
        "connection": {
            "transport": "stdio", "command": command, "args": args, "env": {},
        },
    }))
    .expect("收")
    .connection
    {
        Connection::Stdio(spec) => spec,
        Connection::Http { .. } => unreachable!(),
    };
    let spawned = stdio::spawn(&spec).expect("起得來");
    let pid = spawned.child.id().expect("還沒收走") as i32;
    (spawned, pid)
}

fn reap_runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("執行環境")
}

/// 子行程不理 stdin 的 EOF：等滿 [`STDIN_GRACE`] 之後 SIGTERM，收乾淨才回來。
#[test]
fn reap_收掉不理_eof_的子行程() {
    reap_runtime().block_on(async {
        let (stdio::Spawned { child, transport }, pid) = spawn_for_reap("/bin/sleep", &["30"]);
        drop(transport);
        let started = Instant::now();
        stdio::reap(child).await;
        let took = started.elapsed();
        assert!(took >= STDIN_GRACE, "還沒到寬限就動手了：{took:?}");
        // `sleep` 收到 SIGTERM 就結束：回來的時間是 STDIN_GRACE 加一點，不是再等滿 TERM_GRACE 走到 SIGKILL。
        assert!(
            took < STDIN_GRACE + Duration::from_secs(1),
            "SIGTERM 沒有立刻生效：{took:?}"
        );
        // SAFETY: 訊號 0 只查行程在不在；`reap` 回來時已經 `wait` 過，查不到才對。
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "子行程還在");
    });
}

/// 子行程忽略 SIGTERM（`exec` 之後忽略的處置照樣保留）：要等滿 STDIN_GRACE 與 TERM_GRACE 才 SIGKILL，
/// 回來時行程已經不在，而且沒超過 [`REAP_BUDGET`] 加餘裕。
#[test]
fn reap_收掉忽略_sigterm_的子行程() {
    reap_runtime().block_on(async {
        let (stdio::Spawned { child, transport }, pid) =
            spawn_for_reap("/bin/sh", &["-c", "trap '' TERM; exec sleep 30"]);
        drop(transport);
        let started = Instant::now();
        stdio::reap(child).await;
        let took = started.elapsed();
        assert!(
            took >= STDIN_GRACE + TERM_GRACE,
            "SIGTERM 之後沒有等滿 TERM_GRACE 就 SIGKILL：{took:?}"
        );
        assert!(
            took < REAP_BUDGET + Duration::from_millis(500),
            "超過收線預算：{took:?}"
        );
        // SAFETY: 訊號 0 只查行程在不在；`reap` 回來時已經 `wait` 過，查不到才對。
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "子行程還在");
    });
}

/// 整組收線的測試：用 `/proc` 與 `setsid`，只在 Linux 上編。
#[cfg(target_os = "linux")]
mod group {
    use super::*;

    /// 這個行程有沒有控制終端：`/proc/self/stat` 的 `tty_nr` 不是 0。讀不到也當成有（保守，不跳過）。
    fn has_controlling_terminal() -> bool {
        std::fs::read_to_string("/proc/self/stat")
            .ok()
            .and_then(|stat| {
                stat.rsplit_once(')')?
                    .1
                    .split_whitespace()
                    .nth(4)?
                    .parse::<i64>()
                    .ok()
            })
            .is_none_or(|tty| tty != 0)
    }

    /// 孫行程的 pid 檔：孫行程是 `sh -c 'echo $$ > 檔; exec sleep 300'`，所以檔裡的 pid 就是那個 `sleep`。
    fn grandchild_script(file: &str, prefix: &str) -> String {
        format!("{prefix}/bin/sh -c 'echo $$ > {file}; exec /bin/sleep 300' & ")
    }

    /// 等孫行程把 pid 寫進檔。等不到就明確失敗，不跳過（`setsid` 不在的環境也在這裡紅）。
    fn read_grandchild(file: &str) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(pid) = std::fs::read_to_string(file)
                .ok()
                .and_then(|text| text.trim().parse::<i32>().ok())
            {
                return pid;
            }
            assert!(
            Instant::now() < deadline,
            "孫行程 5 秒內沒有寫下 pid（腳本沒跑起來；包 `--exec` 的測試多半是 spawner 起不來，用到 setsid 的測試要確認它在 PATH 上）：{file}"
        );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// 行程不在了（Linux）：沒有 `/proc/<pid>`，或已是殭屍（孤兒的收屍者在容器裡可能不收）。
    fn process_gone(pid: i32) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            Err(_) => true,
            Ok(stat) => stat
                .rsplit(')')
                .next()
                .is_some_and(|rest| rest.trim_start().starts_with('Z')),
        }
    }

    fn wait_gone(pid: i32, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if process_gone(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        process_gone(pid)
    }

    /// 領頭不理 stdin 的 EOF、孫行程也在同一組：SIGTERM 送整組，兩個都要收掉。
    #[test]
    fn reap_收掉領頭與同組的孫行程() {
        let file = pid_file("group-term");
        let _ = std::fs::remove_file(&file);
        reap_runtime().block_on(async {
            let script = format!("{}wait", grandchild_script(&file, ""));
            let (stdio::Spawned { child, transport }, leader) =
                spawn_for_reap("/bin/sh", &["-c", &script]);
            let grandchild = read_grandchild(&file);
            drop(transport);
            stdio::reap(child).await;
            assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
            // SAFETY: 訊號 0 只查行程在不在；`reap` 回來時領頭已經 `wait` 過，查不到才對。
            assert_eq!(unsafe { libc::kill(leader, 0) }, -1, "領頭還在");
        });
        let _ = std::fs::remove_file(&file);
    }

    /// 領頭讀到 EOF 自己結束，孫行程還活著：領頭一結束就整組 SIGKILL，不再等寬限。
    #[test]
    fn reap_領頭自己結束時仍收掉孫行程() {
        let file = pid_file("group-leader-exit");
        let _ = std::fs::remove_file(&file);
        reap_runtime().block_on(async {
            let script = format!("{}read line", grandchild_script(&file, ""));
            let (stdio::Spawned { child, transport }, _) =
                spawn_for_reap("/bin/sh", &["-c", &script]);
            let grandchild = read_grandchild(&file);
            drop(transport);
            let started = Instant::now();
            stdio::reap(child).await;
            let took = started.elapsed();
            assert!(took < STDIN_GRACE, "領頭已經結束還在等寬限：{took:?}");
            assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
        });
        let _ = std::fs::remove_file(&file);
    }

    /// 領頭與孫行程都忽略 SIGTERM：等滿兩段寬限之後整組 SIGKILL。
    #[test]
    fn reap_孫行程忽略_sigterm_也被_sigkill_收掉() {
        let file = pid_file("group-kill");
        let _ = std::fs::remove_file(&file);
        reap_runtime().block_on(async {
            let script = format!("{}wait", grandchild_script(&file, "trap '' TERM; "));
            let (stdio::Spawned { child, transport }, _) =
                spawn_for_reap("/bin/sh", &["-c", &script]);
            let grandchild = read_grandchild(&file);
            drop(transport);
            let started = Instant::now();
            stdio::reap(child).await;
            let took = started.elapsed();
            assert!(
                took >= STDIN_GRACE + TERM_GRACE,
                "SIGTERM 之後沒有等滿 TERM_GRACE 就 SIGKILL：{took:?}"
            );
            assert!(
                took < REAP_BUDGET + Duration::from_millis(500),
                "超過收線預算：{took:?}"
            );
            assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
        });
        let _ = std::fs::remove_file(&file);
    }

    /// guard 被丟下（例如連線的 future 在握手中途被丟下）：drop 把整組收掉。
    #[test]
    fn drop_守衛時整組收掉() {
        let file = pid_file("group-drop");
        let _ = std::fs::remove_file(&file);
        reap_runtime().block_on(async {
            let script = format!("{}wait", grandchild_script(&file, ""));
            let (spawned, leader) = spawn_for_reap("/bin/sh", &["-c", &script]);
            let grandchild = read_grandchild(&file);
            drop(spawned);
            assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
            assert!(wait_gone(leader, Duration::from_secs(3)), "領頭還在");
        });
        let _ = std::fs::remove_file(&file);
    }

    /// 領頭先結束、孫行程還在時 drop：一樣整組收掉（不能因為領頭已結束就放過孫行程）。
    #[test]
    fn drop_守衛時領頭已結束仍收掉孫行程() {
        let file = pid_file("group-drop-exited");
        let _ = std::fs::remove_file(&file);
        reap_runtime().block_on(async {
            let script = grandchild_script(&file, "");
            let (spawned, leader) = spawn_for_reap("/bin/sh", &["-c", &format!("{script}exit 0")]);
            let grandchild = read_grandchild(&file);
            // 領頭已結束但還沒被 `wait`（殭屍）。
            let deadline = Instant::now() + Duration::from_secs(3);
            while !std::fs::read_to_string(format!("/proc/{leader}/stat")).is_ok_and(|stat| {
                stat.rsplit(')')
                    .next()
                    .is_some_and(|r| r.trim_start().starts_with('Z'))
            }) {
                assert!(Instant::now() < deadline, "領頭沒有結束");
                std::thread::sleep(Duration::from_millis(20));
            }
            drop(spawned);
            assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
        });
        let _ = std::fs::remove_file(&file);
    }

    /// 起行程的執行緒結束，領頭收到 SIGKILL（`PR_SET_PDEATHSIG`）。server 沒包 spawner、這條路上也沒有別人送訊號，所以領頭死了只能是宿主自己設的這個設定；
    /// 只殺領頭：孫行程還在（靠監督行程掃 session，不在這裡）。
    #[test]
    fn spawn_起行程的執行緒結束_領頭被殺_孫行程還在() {
        let file = pid_file("pdeathsig");
        let _ = std::fs::remove_file(&file);
        let script = format!("{}wait", grandchild_script(&file, "trap '' TERM; "));
        let spawner = {
            let file = file.clone();
            std::thread::spawn(move || {
                let runtime = reap_runtime();
                // 管線登記在這個執行環境上，在它還在的時候放掉。
                let (child, leader) = runtime.block_on(async {
                    let (stdio::Spawned { child, transport }, leader) =
                        spawn_for_reap("/bin/sh", &["-c", &script]);
                    drop(transport);
                    (child, leader)
                });
                // 孫行程要在這條執行緒結束之前就起來，不然領頭可能還沒 fork 就被殺。
                let grandchild = read_grandchild(&file);
                (child, leader, grandchild)
            })
        };
        let (child, leader, grandchild) = spawner.join().expect("起行程的執行緒");
        assert!(
            wait_gone(leader, Duration::from_secs(3)),
            "起行程的執行緒結束了，領頭還在"
        );
        assert!(!process_gone(grandchild), "孫行程不該跟著死");
        // 收尾：整組 SIGKILL，孫行程也收掉。
        drop(child);
        assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
        let _ = std::fs::remove_file(&file);
    }

    /// `reap` 的 SIGTERM 也送給孫行程，不只領頭：領頭與孫行程之後都會被 SIGKILL，所以要靠孫行程自己在收到 SIGTERM 時留記號才看得出來。
    /// 領頭忽略 SIGTERM，孫行程有整段 [`TERM_GRACE`] 寫記號（領頭一收到就死的話，下一次輪詢就 SIGKILL，記號時有時無）。
    #[test]
    fn reap_的_sigterm_也送給孫行程() {
        let file = pid_file("group-sigterm");
        let mark = format!("{file}.term");
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_file(&mark);
        reap_runtime().block_on(async {
            // 領頭要在孫行程起來「之後」才忽略 SIGTERM：忽略的處置會傳給孫行程，而「起動時就被忽略」的訊號 shell 沒辦法再設 trap。
            let script = format!(
                "/bin/sh -c 'echo $$ > {file}; trap \": > {mark}\" TERM; while :; do sleep 0.05; done' & trap '' TERM; wait"
            );
            let (stdio::Spawned { child, transport }, _) =
                spawn_for_reap("/bin/sh", &["-c", &script]);
            let grandchild = read_grandchild(&file);
            // 讓孫行程裝好 trap（pid 寫完之後才裝）。
            std::thread::sleep(Duration::from_millis(300));
            drop(transport);
            stdio::reap(child).await;
            assert!(
                Path::new(&mark).exists(),
                "孫行程沒收到 SIGTERM：收線只對領頭送了"
            );
            assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
        });
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_file(&mark);
    }

    /// 測試行程裡沒有人替別人收屍（`mcp/stdio.rs`「領頭不先收屍」的前提）：SIGCHLD 沒被設成忽略，領頭結束之後一直是殭屍、直到自己 `wait`。
    /// 只看這個測試行程自己：宿主 `main` 的啟動碼動 SIGCHLD 這裡看不到，那條由 `clippy.toml` 禁 `signal`／`sigaction` 擋。
    #[test]
    fn 領頭結束後一直是殭屍_sigchld_沒被忽略() {
        let ignored = std::fs::read_to_string("/proc/self/status")
            .expect("讀 /proc/self/status")
            .lines()
            .find_map(|line| line.strip_prefix("SigIgn:"))
            .map(|hex| u64::from_str_radix(hex.trim(), 16).expect("SigIgn 是十六進位"))
            .expect("有 SigIgn");
        assert_eq!(
            ignored & (1 << (libc::SIGCHLD - 1)),
            0,
            "SIGCHLD 被設成忽略"
        );
        reap_runtime().block_on(async {
            let (spawned, leader) = spawn_for_reap("/bin/sh", &["-c", "exit 0"]);
            let zombie = || {
                std::fs::read_to_string(format!("/proc/{leader}/stat")).is_ok_and(|stat| {
                    stat.rsplit(')')
                        .next()
                        .is_some_and(|rest| rest.trim_start().starts_with('Z'))
                })
            };
            let deadline = Instant::now() + Duration::from_secs(3);
            while !zombie() {
                assert!(
                    Instant::now() < deadline,
                    "領頭沒有變成殭屍（被別人收了？）"
                );
                std::thread::sleep(Duration::from_millis(20));
            }
            std::thread::sleep(Duration::from_millis(500));
            assert!(zombie(), "領頭在沒人 wait 的時候不見了：有人替它收屍");
            drop(spawned);
        });
    }

    /// 子行程自成一組、留在宿主的 session：領頭是組長，組不是宿主的；session 還是宿主的（不是自己的）。
    #[test]
    fn spawn_子行程自成一組但留在宿主的_session() {
        reap_runtime().block_on(async {
            let (stdio::Spawned { child, transport }, pid) = spawn_for_reap("/bin/sleep", &["30"]);
            // SAFETY: 只查行程群組 id。
            let (group, own) = unsafe { (libc::getpgid(pid), libc::getpgid(0)) };
            assert_eq!(group, pid, "子行程不是自己那一組的領頭");
            assert_ne!(group, own, "子行程跟宿主同一組");
            // SAFETY: 只查 session id。
            let (session, own_session) = unsafe { (libc::getsid(pid), libc::getsid(0)) };
            assert_eq!(session, own_session, "子行程自己開了 session");
            assert_ne!(session, pid, "子行程成了 session 長");
            drop(transport);
            stdio::reap(child).await;
        });
    }

    /// 被 spawner 的單次模式包起來的 server：`--exec` 的 `setsid` 在領頭是組長、不是 session 長時回 `EPERM`，
    /// 沒有控制終端就留在宿主的 session 裡跑（#2920）。起得來、孫行程也收得掉。核心沒有 Landlock 時 `--exec` 起不來，這裡紅，不跳過。
    /// 測試行程有控制終端時（從終端機直接跑 `cargo test`）spawner 會拒絕，這條跳過並印原因；`CI` 有設時不跳過、直接紅。
    #[test]
    fn reap_收掉被_spawner_exec_包起來的整組() {
        // 測試行程自己有控制終端時（從終端機直接跑 `cargo test`），spawner 照設計拒絕：跳過並說明原因。
        // `CI` 有設就不跳過、直接往下跑到紅，免得 CI 上靜靜跳過；要在終端機跑它用 `setsid cargo test`（`docs/host-mcp.md`）。
        if has_controlling_terminal() {
            assert!(
                std::env::var_os("CI").is_none(),
                "CI 環境的測試行程有控制終端：spawner 會拒絕包 --exec 的 server，這一支測不了"
            );
            eprintln!("跳過：測試行程有控制終端，spawner 的 --exec 會拒絕留在這個 session（用 `setsid cargo test` 跑）");
            return;
        }
        let file = pid_file("group-exec");
        let _ = std::fs::remove_file(&file);
        let dir = std::path::Path::new(&file).parent().unwrap();
        let write_root = std::fs::canonicalize(dir).expect("寫根");
        let spawner = spawner_common::built("nexus-sandbox-spawner");
        let mut args: Vec<String> = vec!["--exec".into()];
        for root in ["/usr", "/bin", "/lib", "/lib64"] {
            if let Ok(real) = std::fs::canonicalize(root) {
                args.extend(["--read".into(), real.to_string_lossy().into_owned()]);
            }
        }
        args.extend(["--write".into(), write_root.to_string_lossy().into_owned()]);
        let script = format!("{}wait", grandchild_script(&file, ""));
        args.extend(["--".into(), "/bin/sh".into(), "-c".into(), script]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        reap_runtime().block_on(async {
            let (stdio::Spawned { child, transport }, _) =
                spawn_for_reap(spawner.to_str().unwrap(), &args);
            let grandchild = read_grandchild(&file);
            drop(transport);
            stdio::reap(child).await;
            assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
        });
        let _ = std::fs::remove_file(&file);
    }

    /// 被 spawner 的 `--guard` 包起來的 server：guard 不 `setsid`，整組照樣收得掉。
    #[test]
    fn reap_收掉被_spawner_guard_包起來的整組() {
        let file = pid_file("group-guard");
        let _ = std::fs::remove_file(&file);
        let spawner = spawner_common::built("nexus-sandbox-spawner");
        let script = format!("{}wait", grandchild_script(&file, ""));
        reap_runtime().block_on(async {
            let (stdio::Spawned { child, transport }, _) = spawn_for_reap(
                spawner.to_str().unwrap(),
                &["--guard", "--", "/bin/sh", "-c", &script],
            );
            let grandchild = read_grandchild(&file);
            drop(transport);
            stdio::reap(child).await;
            assert!(wait_gone(grandchild, Duration::from_secs(3)), "孫行程還在");
        });
        let _ = std::fs::remove_file(&file);
    }

    /// 負向：孫行程自己 `setsid` 換了組，收不到。這是接受的限制（`docs/host-mcp.md` 寫明），測試釘住行為，也防止哪天誤以為收得到。
    /// `setsid` 不在 PATH 上時紅（[`read_grandchild`] 等不到 pid），不跳過。
    #[test]
    fn reap_孫行程自己_setsid_收不到() {
        let file = pid_file("group-setsid");
        let _ = std::fs::remove_file(&file);
        reap_runtime().block_on(async {
            let script = format!("{}wait", grandchild_script(&file, "setsid "));
            let (stdio::Spawned { child, transport }, _) =
                spawn_for_reap("/bin/sh", &["-c", &script]);
            let grandchild = read_grandchild(&file);
            drop(transport);
            stdio::reap(child).await;
            let survived = !process_gone(grandchild);
            // SAFETY: 清掉這個測試自己造出來的行程，不留洩漏。
            unsafe { libc::kill(grandchild, libc::SIGKILL) };
            assert!(
                survived,
                "換了組的孫行程被收掉了：group 收得到的範圍變了，文件要跟著改"
            );
        });
        let _ = std::fs::remove_file(&file);
    }
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
