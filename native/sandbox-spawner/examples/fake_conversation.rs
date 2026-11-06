//! 監督行程整合測試用的假對話行程：照控制面協定送 `ready`，收到 `bind` 回 `bound`，之後照 thread id 做事。
//!
//! ```text
//! fake_conversation [--die-before-ready] [--ready-after-ms <毫秒>] --socket <路徑>
//! ```
//!
//! - `--die-before-ready`：一起來就以 7 結束。
//! - `--ready-after-ms`：等這麼久才送 `ready`。
//! - thread id 以逗號分段，第一段是名字，之後每段是一個動作，回 `bound` 之後依序做：
//!   `exit:<碼>`、`signal:<號>`（對自己送）、`turn`（送一次 `turn(begin)` 與 `turn(end)`）、`grandchild`（fork 一個睡著的子行程，
//!   同一個群組）、`close-stdout`、`ignore-eof`（stdin EOF 之後不結束，心跳也停）、`ignore-term`（再加上不理 SIGTERM）、
//!   `wrong-bound`（回別的 thread id，取代正常的 `bound`）、`flood`（之後不停往 stdout 寫 `heartbeat`，不再讀 stdin）、`stderr-flood`（之後不停往 stderr 寫填充，不再讀 stdin）、
//!   `heap`（往 stderr 寫 V8 heap 用完的訊息再 SIGABRT）、`alloc:<MiB>`（配置並碰過這麼多記憶體，留著不放）、`garbage`（送一個超過上限的框長，取代正常的 `bound`）、
//!   `wait-go`（等 `<socket 路徑>.go` 出現）、`stderr-junk:<KiB>`（stderr 的管線放大到 1 MiB，寫這麼多填充、以換行結尾；KiB ≤ 1024 時不等人讀）、
//!   `hang`（停掉心跳，之後什麼都不做、不讀 stdin）、`silent:<毫秒>`（心跳停這麼久、主執行緒也睡這麼久，
//!   之後恢復）、`idle:<毫秒>`（送 `idle`，帶這個毫秒數）、`busy-on-drain`（收到 `drain` 回 `busy`）、`ignore-drain`（收到 `drain` 不回）、`slow-drain:<毫秒>`（收到 `drain` 等這麼久才回）。
//! - 收到 `drain` 預設回 `drained`，記一行 `drain`。
//! - 收到 `bind` 起就有一條執行緒每 [`HEARTBEAT`] 送一次 `heartbeat`，跟真的對話行程一樣一綁上就一直送。
//! - 每件事記一行到 `<socket 路徑>.log`：`pid <n>`、`bind <thread>`、`grandchild <n>`、`idle`（送出之後）、`drain`、`eof`、`sigterm`。

use nexus_sandbox_spawner::protocol::{frame, take_frame};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_conversation_command, encode_conversation_report, ConversationCommand, ConversationReport, TurnPhase,
};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::time::Duration;

static LOG_FD: AtomicI32 = AtomicI32::new(-1);
/// 心跳先停：`hang`、`silent`、`close-stdout` 設它；`ignore-eof` 在收到 EOF 時設它。
static QUIET: AtomicBool = AtomicBool::new(false);
const HEARTBEAT: Duration = Duration::from_millis(50);

fn log(line: &str) {
    let text = format!("{line}\n");
    // SAFETY：寫一個開著的 fd。
    unsafe { libc::write(LOG_FD.load(Ordering::SeqCst), text.as_ptr().cast(), text.len()) };
}

extern "C" fn on_sigterm(_: libc::c_int) {
    let text = b"sigterm\n";
    // SAFETY：handler 裡只用 async-signal-safe 的 write 與 _exit。
    unsafe {
        libc::write(LOG_FD.load(Ordering::SeqCst), text.as_ptr().cast(), text.len());
        libc::_exit(0);
    }
}

fn report(report: &ConversationReport) {
    let mut out = std::io::stdout().lock();
    out.write_all(&frame(&encode_conversation_report(report))).unwrap();
    out.flush().unwrap();
}

fn start_heartbeat() {
    std::thread::spawn(|| loop {
        std::thread::sleep(HEARTBEAT);
        if QUIET.load(Ordering::SeqCst) {
            continue;
        }
        // 一則框在同一把 stdout 鎖裡寫完，不會跟主執行緒的框交錯；寫不出去（stdout 關了）就不寫。
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(&frame(&encode_conversation_report(&ConversationReport::Heartbeat)));
        let _ = out.flush();
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--die-before-ready") {
        std::process::exit(7);
    }
    let socket = args.iter().position(|a| a == "--socket").and_then(|i| args.get(i + 1)).expect("--socket").clone();
    let file = std::fs::OpenOptions::new().create(true).append(true).open(format!("{socket}.log")).unwrap();
    LOG_FD.store(std::os::fd::IntoRawFd::into_raw_fd(file), Ordering::SeqCst);
    // SAFETY：不留 core 檔（`signal:6`、`heap` 會 abort）。
    unsafe { libc::setrlimit(libc::RLIMIT_CORE, &libc::rlimit { rlim_cur: 0, rlim_max: 0 }) };
    // SAFETY：裝 handler。
    unsafe { libc::signal(libc::SIGTERM, on_sigterm as extern "C" fn(libc::c_int) as libc::sighandler_t) };
    log(&format!("pid {}", std::process::id()));
    if let Some(ms) = args.iter().position(|a| a == "--ready-after-ms").and_then(|i| args.get(i + 1)) {
        std::thread::sleep(Duration::from_millis(ms.parse().unwrap()));
    }
    report(&ConversationReport::Ready);

    let mut ignore_eof = false;
    let mut on_drain = Some(ConversationReport::Drained);
    let mut drain_delay = Duration::ZERO;
    let mut input = Vec::new();
    let mut buf = [0u8; 4096];
    let mut stdin = std::io::stdin().lock();
    loop {
        let n = stdin.read(&mut buf).unwrap_or(0);
        if n == 0 {
            log("eof");
            if !ignore_eof {
                std::process::exit(0);
            }
            QUIET.store(true, Ordering::SeqCst);
            loop {
                // SAFETY：等訊號。
                unsafe { libc::pause() };
            }
        }
        input.extend_from_slice(&buf[..n]);
        while let Some(payload) = take_frame(&mut input).unwrap() {
            let thread_id = match decode_conversation_command(&payload).unwrap() {
                ConversationCommand::Bind { thread_id } => thread_id,
                ConversationCommand::Drain => {
                    log("drain");
                    std::thread::sleep(drain_delay);
                    if let Some(answer) = &on_drain {
                        report(answer);
                    }
                    continue;
                }
            };
            let thread = String::from_utf8(thread_id.clone()).unwrap();
            log(&format!("bind {thread}"));
            start_heartbeat();
            let actions: Vec<&str> = thread.split(',').skip(1).collect();
            if actions.contains(&"garbage") {
                let mut out = std::io::stdout().lock();
                out.write_all(&u32::MAX.to_le_bytes()).unwrap();
                out.flush().unwrap();
                continue;
            }
            let bound = if actions.contains(&"wrong-bound") { b"someone-else".to_vec() } else { thread_id };
            report(&ConversationReport::Bound { thread_id: bound });
            for action in actions {
                match action.split_once(':').unwrap_or((action, "")) {
                    ("exit", code) => std::process::exit(code.parse().unwrap()),
                    // SAFETY：對自己送訊號。
                    ("signal", signal) => unsafe {
                        libc::signal(signal.parse().unwrap(), libc::SIG_DFL);
                        libc::raise(signal.parse().unwrap());
                    },
                    ("turn", _) => {
                        report(&ConversationReport::Turn { phase: TurnPhase::Begin });
                        report(&ConversationReport::Turn { phase: TurnPhase::End });
                    }
                    // SAFETY：fork 之後子行程只睡。
                    ("grandchild", _) => unsafe {
                        let pid = libc::fork();
                        if pid == 0 {
                            loop {
                                libc::pause();
                            }
                        }
                        log(&format!("grandchild {pid}"));
                    },
                    // SAFETY：關掉 stdout。先設 `QUIET`、拿著 stdout 的鎖再關：心跳寫到一半的那一框先寫完；已經過了 `QUIET` 檢查的那一次
                    // 會寫到關掉的 fd，寫不出去就丟掉。
                    ("close-stdout", _) => unsafe {
                        QUIET.store(true, Ordering::SeqCst);
                        let _lock = std::io::stdout().lock();
                        libc::close(1);
                    },
                    ("hang", _) => {
                        QUIET.store(true, Ordering::SeqCst);
                        loop {
                            // SAFETY：等訊號。
                            unsafe { libc::pause() };
                        }
                    }
                    ("silent", ms) => {
                        QUIET.store(true, Ordering::SeqCst);
                        std::thread::sleep(Duration::from_millis(ms.parse().unwrap()));
                        QUIET.store(false, Ordering::SeqCst);
                    }
                    ("ignore-eof", _) => ignore_eof = true,
                    ("idle", ms) => {
                        report(&ConversationReport::Idle { idle_ms: ms.parse().unwrap() });
                        log("idle");
                    }
                    ("busy-on-drain", _) => on_drain = Some(ConversationReport::Busy),
                    ("ignore-drain", _) => on_drain = None,
                    ("slow-drain", ms) => drain_delay = Duration::from_millis(ms.parse().unwrap()),
                    ("ignore-term", _) => {
                        ignore_eof = true;
                        // SAFETY：改訊號處置。
                        unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
                    }
                    ("wrong-bound", _) => {}
                    ("stderr-flood", _) => {
                        let batch = vec![b'e'; 1 << 20];
                        let mut err = std::io::stderr().lock();
                        while err.write_all(&batch).is_ok() {}
                        loop {
                            // SAFETY：等訊號。
                            unsafe { libc::pause() };
                        }
                    }
                    // SAFETY：還原預設處置再對自己送 SIGABRT。
                    ("heap", _) => unsafe {
                        eprintln!("FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory");
                        libc::signal(libc::SIGABRT, libc::SIG_DFL);
                        libc::raise(libc::SIGABRT);
                    },
                    ("wait-go", _) => {
                        while !std::path::Path::new(&format!("{socket}.go")).exists() {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                    }
                    ("stderr-junk", kib) => {
                        // SAFETY：改 fd 2 那條管線的容量。
                        assert!(unsafe { libc::fcntl(2, libc::F_SETPIPE_SZ, 1 << 20) } >= 1 << 20);
                        let mut junk = vec![b'j'; (kib.parse::<usize>().unwrap() << 10) - 1];
                        junk.push(b'\n');
                        std::io::stderr().lock().write_all(&junk).unwrap();
                    }
                    // black_box：免得最佳化把沒人讀的配置整個省掉。
                    ("alloc", mib) => std::mem::forget(std::hint::black_box(vec![1u8; mib.parse::<usize>().unwrap() << 20])),
                    ("flood", _) => {
                        let batch: Vec<u8> = (0..65536).flat_map(|_| frame(&encode_conversation_report(&ConversationReport::Heartbeat))).collect();
                        let mut out = std::io::stdout().lock();
                        while out.write_all(&batch).is_ok() {}
                        loop {
                            // SAFETY：等訊號。
                            unsafe { libc::pause() };
                        }
                    }
                    (other, _) => panic!("不認得的動作 {other}"),
                }
            }
        }
    }
}
