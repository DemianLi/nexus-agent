//! 監督行程整合測試用的假宿主：照控制通道的協定握手、記下收到的身分表，不收連線。真的宿主是 `nexus-host`。
//!
//! ```text
//! fake_host [--version <n>] [--exit-before-ready <碼>] [--no-ready] [--crash-once <標記檔>] [--unregistered-once <標記檔>] [--violate-conversations] [--violate-twice] [--then-unregistered <理由>] [--report-strangers] [--stale-generation] [--zero-generation] [--then-zero-generation] [--deaf-on <thread>] --socket <路徑>
//! ```
//!
//! - 一起來送 `hello`（版本照 `--version`，預設 [`PROTOCOL_VERSION`]），等到監督行程的 `hello` 才往下。
//! - `--exit-before-ready`：收到 `hello` 就以這個碼結束。`--no-ready`：不送 `ready`，一直等到 stdin EOF。
//! - `--crash-once`：送 `ready`、收到第一筆身分之後，標記檔不在就建它、以 9 結束；在就照常。
//! - `--unregistered-once`：收到第一筆對話行程的身分之後，標記檔不在就建它、對那個 pid 回報 `unregistered`、以 9 結束；在就照常。
//! - `--violate-conversations`：每收到一筆對話行程的身分，就對那個 pid 回報 `violation`（理由「測試違規」），照常跑下去。
//! - `--violate-twice`：同上，但每一筆連報兩次。
//! - `--then-unregistered`：同 `--violate-conversations`，報完 `violation` 再對同一個 pid 報一筆 `unregistered`，理由照給的。
//! - `--report-strangers`：同 `--violate-conversations`，但先對 pid 0 各報一筆 `violation`（理由「測試違規」）與 `unregistered`（理由「沒有登記」）。
//! - `--stale-generation`：每收到一筆對話行程的身分，就對那個 pid 回報一筆序號比那一筆大 1 的 `violation`（理由「舊序號的違規」），照常跑下去。
//! - `--zero-generation`：同 `--violate-conversations`，但那一筆 `violation` 帶序號 0（宿主表上沒有那個 pid 時，還沒送 `hello` 的連線報的就是 0）。
//! - `--then-zero-generation`：同 `--violate-conversations`，報完 `violation` 再對同一個 pid 報一筆序號 0 的 `violation`（理由「表上沒有了」）：
//!   撤銷之後宿主表上沒有它，還沒送 `hello` 的連線出事時報的就是 0。
//! - `--deaf-on`：收到綁那條 thread 的對話行程身分時關掉 stdin、記一行 `deaf`，之後一直睡到被殺：監督行程再寫控制通道就是 EPIPE。
//! - 上面幾種之外的 `violation` 都帶那一筆的序號（pid 0 的帶 0）。
//! - 每件事記一行到 `<socket 路徑>.log`：`start <pid>`、`grant <pid> <front|conversation> <thread>`、`revoke <pid>`、`hello again`（監督行程又送了一次 `hello`）、`eof`、`deaf`。

use nexus_sandbox_spawner::protocol::{frame, take_frame};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_host_command, encode_host_report, HostCommand, HostReport, Role, PROTOCOL_VERSION,
};
use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let value = |flag: &str| {
        args.iter()
            .position(|a| a == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let socket = value("--socket").expect("--socket");
    let version: u32 = value("--version").map_or(PROTOCOL_VERSION, |v| v.parse().unwrap());
    let exit_before_ready: Option<i32> = value("--exit-before-ready").map(|v| v.parse().unwrap());
    let no_ready = args.iter().any(|a| a == "--no-ready");
    let crash_once = value("--crash-once");
    let unregistered_once = value("--unregistered-once");
    let violate_twice = args.iter().any(|a| a == "--violate-twice");
    let then_unregistered = value("--then-unregistered");
    let report_strangers = args.iter().any(|a| a == "--report-strangers");
    let stale_generation = args.iter().any(|a| a == "--stale-generation");
    let zero_generation = args.iter().any(|a| a == "--zero-generation");
    let then_zero_generation = args.iter().any(|a| a == "--then-zero-generation");
    let deaf_on = value("--deaf-on");
    let violate_conversations = violate_twice
        || then_unregistered.is_some()
        || report_strangers
        || zero_generation
        || then_zero_generation
        || args.iter().any(|a| a == "--violate-conversations");

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
                HostCommand::Grant {
                    pid,
                    generation,
                    role,
                    thread,
                    ..
                } => {
                    let role = match role {
                        Role::Front => "front",
                        Role::Conversation => "conversation",
                    };
                    log(&format!(
                        "grant {pid} {role} {}",
                        String::from_utf8_lossy(&thread)
                    ));
                    if role == "conversation"
                        && deaf_on.as_deref().map(str::as_bytes) == Some(&thread[..])
                    {
                        // SAFETY：只關自己的 fd 0，之後不再讀它。
                        unsafe { libc::close(0) };
                        log("deaf");
                        loop {
                            std::thread::sleep(std::time::Duration::from_secs(60));
                        }
                    }
                    if report_strangers && role == "conversation" {
                        report(&HostReport::Violation {
                            pid: 0,
                            generation: 0,
                            reason: "測試違規".as_bytes().to_vec(),
                        });
                        report(&HostReport::Unregistered {
                            pid: 0,
                            conn: 7,
                            reason: "沒有登記".as_bytes().to_vec(),
                        });
                    }
                    if stale_generation && role == "conversation" {
                        let generation = generation.wrapping_add(1);
                        report(&HostReport::Violation {
                            pid,
                            generation,
                            reason: "舊序號的違規".as_bytes().to_vec(),
                        });
                    }
                    if violate_conversations && role == "conversation" {
                        let generation = if zero_generation { 0 } else { generation };
                        for _ in 0..if violate_twice { 2 } else { 1 } {
                            report(&HostReport::Violation {
                                pid,
                                generation,
                                reason: "測試違規".as_bytes().to_vec(),
                            });
                        }
                        if let Some(reason) = &then_unregistered {
                            report(&HostReport::Unregistered {
                                pid,
                                conn: 7,
                                reason: reason.as_bytes().to_vec(),
                            });
                        }
                        if then_zero_generation {
                            report(&HostReport::Violation {
                                pid,
                                generation: 0,
                                reason: "表上沒有了".as_bytes().to_vec(),
                            });
                        }
                    }
                    if let Some(marker) = unregistered_once
                        .as_ref()
                        .filter(|_| role == "conversation")
                    {
                        if std::fs::metadata(marker).is_err() {
                            std::fs::write(marker, b"").unwrap();
                            report(&HostReport::Unregistered {
                                pid,
                                conn: 7,
                                reason: "沒有登記".as_bytes().to_vec(),
                            });
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
