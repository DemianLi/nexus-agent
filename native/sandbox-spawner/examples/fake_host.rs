//! 監督行程整合測試用的假宿主：照控制通道的協定握手、記下收到的身分表，不收連線。真的宿主是 `nexus-host`。
//!
//! ```text
//! fake_host [--version <n>] [--exit-before-ready <碼>] [--no-ready] [--crash-once <標記檔>] [--unregistered-once <標記檔>] [--violate-conversations] --socket <路徑>
//! ```
//!
//! - 一起來送 `hello`（版本照 `--version`，預設 [`PROTOCOL_VERSION`]），等到監督行程的 `hello` 才往下。
//! - `--exit-before-ready`：收到 `hello` 就以這個碼結束。`--no-ready`：不送 `ready`，一直等到 stdin EOF。
//! - `--crash-once`：送 `ready`、收到第一筆身分之後，標記檔不在就建它、以 9 結束；在就照常。
//! - `--unregistered-once`：收到第一筆對話行程的身分之後，標記檔不在就建它、對那個 pid 回報 `unregistered`、以 9 結束；在就照常。
//! - `--violate-conversations`：每收到一筆對話行程的身分，就對那個 pid 回報 `violation`（理由「測試違規」），照常跑下去。
//! - 每件事記一行到 `<socket 路徑>.log`：`start <pid>`、`grant <pid> <front|conversation> <thread>`、`revoke <pid>`、`hello again`（監督行程又送了一次 `hello`）、`eof`。

use nexus_sandbox_spawner::protocol::{frame, take_frame};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_host_command, encode_host_report, HostCommand, HostReport, Role, PROTOCOL_VERSION,
};
use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let socket = value("--socket").expect("--socket");
    let version: u32 = value("--version").map_or(PROTOCOL_VERSION, |v| v.parse().unwrap());
    let exit_before_ready: Option<i32> = value("--exit-before-ready").map(|v| v.parse().unwrap());
    let no_ready = args.iter().any(|a| a == "--no-ready");
    let crash_once = value("--crash-once");
    let unregistered_once = value("--unregistered-once");
    let violate_conversations = args.iter().any(|a| a == "--violate-conversations");

    let mut log_file = std::fs::OpenOptions::new().create(true).append(true).open(format!("{socket}.log")).unwrap();
    let mut log = move |line: &str| {
        log_file.write_all(format!("{line}\n").as_bytes()).unwrap();
    };
    log(&format!("start {}", std::process::id()));

    let report = |report: &HostReport| {
        let mut out = std::io::stdout().lock();
        out.write_all(&frame(&encode_host_report(report))).unwrap();
        out.flush().unwrap();
    };
    report(&HostReport::Hello { version });

    let mut input = Vec::new();
    let mut buf = [0u8; 4096];
    let mut helloed = false;
    loop {
        let n = std::io::stdin().read(&mut buf).unwrap();
        if n == 0 {
            log("eof");
            return;
        }
        input.extend_from_slice(&buf[..n]);
        while let Some(payload) = take_frame(&mut input).unwrap() {
            match decode_host_command(&payload).unwrap() {
                HostCommand::Hello { .. } if !helloed => {
                    helloed = true;
                    if let Some(code) = exit_before_ready {
                        std::process::exit(code);
                    }
                    if !no_ready {
                        report(&HostReport::Ready);
                    }
                }
                HostCommand::Hello { .. } => log("hello again"),
                HostCommand::Grant { pid, role, thread, .. } => {
                    let role = match role {
                        Role::Front => "front",
                        Role::Conversation => "conversation",
                    };
                    log(&format!("grant {pid} {role} {}", String::from_utf8_lossy(&thread)));
                    if violate_conversations && role == "conversation" {
                        report(&HostReport::Violation { pid, reason: "測試違規".as_bytes().to_vec() });
                    }
                    if let Some(marker) = unregistered_once.as_ref().filter(|_| role == "conversation") {
                        if std::fs::metadata(marker).is_err() {
                            std::fs::write(marker, b"").unwrap();
                            report(&HostReport::Unregistered { pid });
                            std::process::exit(9);
                        }
                    }
                    if let Some(marker) = &crash_once {
                        if std::fs::metadata(marker).is_err() {
                            std::fs::write(marker, b"").unwrap();
                            std::process::exit(9);
                        }
                    }
                }
                HostCommand::Revoke { pid } => log(&format!("revoke {pid}")),
            }
        }
    }
}
