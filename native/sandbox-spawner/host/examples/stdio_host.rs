//! 監督行程整合測試用的小宿主：照控制通道的協定握手（同 `examples/fake_host.rs`），再用**真的** `nexus_host::mcp::stdio::spawn` 起一個 MCP server 行程。
//! 為 #2920 存在：測「宿主死了、被殺或自己結束，監督行程把宿主那個 session 裡的行程收掉」要真的 `stdio.rs` 起法，宿主本體還沒接上 MCP 橋（PR-E）。
//! 編在 `nexus-host` 這個 package（要用 `nexus_host::mcp`），由 spawner 的 `tests/supervisor.rs` 從共用的 target 目錄起。只在 Linux 跑。
//!
//! ```text
//! stdio_host [--spawn-before-ready] [--exit-after-spawn[=<碼>]] [--spawn-thread=short] [--no-ready] [--env K=V]... -- <指令> [參數]... --socket <路徑>
//! ```
//!
//! `--socket <路徑>` 是監督行程接在最後的，所以測試用 `--host-arg` 給的是前面那段（含 `--` 與指令）。
//!
//! - 握手同 `fake_host`：送 `hello`，等監督行程的 `hello`；之後的命令（`grant`、`revoke`）一律忽略。
//! - 預設送 `ready` **之後**才 spawn。`--spawn-before-ready`：spawn 完成之後才送 `ready`。「spawn 之後、`ready` 之前被殺」由測試去殺，旗標不自己模擬。
//! - `--exit-after-spawn[=<碼>]`：spawn 完、送 `ready` 後以 `std::process::exit(<碼>)` 結束，預設 9。不收線、不讓 `ChildGuard::drop` 跑，否則子行程會被宿主自己收掉，掃描就測不到了。
//! - `--no-ready`：永遠不送 `ready`（配 `--spawn-before-ready`，測宿主 `ready` 之前就被殺）。
//! - `--spawn-thread=short`：在另一條執行緒上 spawn，那條執行緒起完就結束，主執行緒繼續活；預設在主執行緒的 current-thread runtime 上 spawn。
//!   `PR_SET_PDEATHSIG` 綁的是起子行程的那條執行緒，短命執行緒上 spawn 的子行程會跟著那條執行緒一起被收，所以預設一定在主執行緒上。
//! - `<指令> [參數]...` 放在 `--` 之後，交給 `stdio::spawn`；`--env K=V` 可重複，預設空（`spawn` 會清環境，server 腳本用絕對路徑）。
//! - 不印 stdout（那是控制通道）。在 `<socket 路徑>.log` 記 `start <pid>`、`spawned <領頭 pid>`、`eof`。孫行程的 pid 由 server 腳本自己寫檔。
//! - 拿到的 `Spawned` 一直握著、永不 `reap`；讀 stdin 到被殺為止，EOF 也不結束；SIGTERM 不特別處理。

use nexus_host::mcp::config::Stdio;
use nexus_host::mcp::stdio::{self, Spawned};
use nexus_sandbox_spawner::protocol::{frame, take_frame};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_host_command, encode_host_report, HostCommand, HostReport, PROTOCOL_VERSION,
};
use std::io::{Read, Write};
use std::time::Duration;

/// 在呼叫的這條執行緒上、自己建的 current-thread runtime 裡 spawn。呼叫的執行緒就是 `PR_SET_PDEATHSIG` 綁的那一條。
fn spawn_here(spec: &Stdio) -> Spawned {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let spawned = runtime
        .block_on(async { stdio::spawn(spec) })
        .expect("spawn");
    // runtime 留到行程結束：管線的 `AsyncFd` 登記在它上面。主執行緒的永遠不收；短命執行緒的隨那條執行緒一起沒了，之後不再用到管線。
    std::mem::forget(runtime);
    spawned
}

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    // 監督行程把 `--socket <路徑>` 接在 `--host-arg` 的最後面，所以它在 `--` 之後的指令後面：先摘掉。
    let socket = {
        let at = args.len().checked_sub(2).expect("--socket <路徑> 在最後");
        assert_eq!(args[at], "--socket", "--socket <路徑> 在最後");
        let path = args.pop().unwrap();
        args.pop();
        path
    };
    let command_at = args.iter().position(|a| a == "--");
    let command: Vec<String> = match command_at {
        Some(at) => args.split_off(at + 1),
        None => Vec::new(),
    };
    args.pop();
    assert!(!command.is_empty(), "要在 -- 之後給 MCP server 的指令");
    let spawn_before_ready = args.iter().any(|a| a == "--spawn-before-ready");
    let exit_after_spawn: Option<i32> = args.iter().find_map(|a| {
        if a == "--exit-after-spawn" {
            Some(9)
        } else {
            a.strip_prefix("--exit-after-spawn=")
                .map(|code| code.parse().expect("--exit-after-spawn 的碼"))
        }
    });
    let no_ready = args.iter().any(|a| a == "--no-ready");
    assert!(
        !no_ready || spawn_before_ready,
        "--no-ready 要搭 --spawn-before-ready：不搭的話 ready 沒送，卻還是會在之後 spawn，測不出「ready 之前被殺」"
    );
    let short_thread = args.iter().any(|a| a == "--spawn-thread=short");
    let env: Vec<(String, String)> = args
        .windows(2)
        .filter(|pair| pair[0] == "--env")
        .map(|pair| {
            let (key, val) = pair[1].split_once('=').expect("--env K=V");
            (key.to_string(), val.to_string())
        })
        .collect();
    let spec = Stdio {
        command: command[0].clone(),
        args: command[1..].to_vec(),
        cwd: None,
        env,
        credential_env: Vec::new(),
        startup_timeout: Duration::from_secs(30),
    };

    let mut log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(format!("{socket}.log"))
        .unwrap();
    let mut log = move |line: &str| {
        log_file.write_all(format!("{line}\n").as_bytes()).unwrap();
    };
    log(&format!("start {}", std::process::id()));

    let report = |report: &HostReport| {
        let mut out = std::io::stdout().lock();
        out.write_all(&frame(&encode_host_report(report))).unwrap();
        out.flush().unwrap();
    };
    report(&HostReport::Hello {
        version: PROTOCOL_VERSION,
    });

    // 拿到的 `Spawned` 放在這裡握到被殺為止（永不 `reap`、永不 drop）。
    let mut held: Option<Spawned> = None;
    let mut spawn = |log: &mut dyn FnMut(&str)| {
        let spawned = if short_thread {
            let spec = spec.clone();
            std::thread::Builder::new()
                .name("stdio-host-short".into())
                .spawn(move || spawn_here(&spec))
                .expect("thread")
                .join()
                .expect("spawn thread")
        } else {
            spawn_here(&spec)
        };
        log(&format!(
            "spawned {}",
            spawned.child.id().expect("領頭 pid")
        ));
        held = Some(spawned);
    };

    let mut input = Vec::new();
    let mut buf = [0u8; 4096];
    let mut helloed = false;
    loop {
        let n = std::io::stdin().read(&mut buf).unwrap();
        if n == 0 {
            log("eof");
            // EOF 也不結束：模擬卡住的宿主，一直睡到被殺。`held` 握到這裡。
            let _keep = &held;
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
        input.extend_from_slice(&buf[..n]);
        while let Some(payload) = take_frame(&mut input).unwrap() {
            if let HostCommand::Hello { .. } = decode_host_command(&payload).unwrap() {
                if helloed {
                    continue;
                }
                helloed = true;
                if spawn_before_ready {
                    spawn(&mut log);
                }
                if !no_ready {
                    report(&HostReport::Ready);
                }
                if !spawn_before_ready {
                    spawn(&mut log);
                }
                if let Some(code) = exit_after_spawn {
                    // 不走 drop：`Spawned` 的 `ChildGuard` 一 drop 就會 SIGKILL 子行程。
                    std::process::exit(code);
                }
            }
        }
    }
}
