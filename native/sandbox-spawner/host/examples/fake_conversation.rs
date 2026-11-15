//! 監督行程整合測試用的假對話行程：照控制面協定送 `ready`（當一對裡的葉子時不送，見 `--pair-socket`），收到 `bind` 回 `bound`，
//! 之後照 thread id 做事。
//! 編在 `nexus-host` 這個 package（要用 `nexus_host::host_protocol`），由 spawner 的 `tests/supervisor.rs` 從共用的 target 目錄起。
//!
//! ```text
//! fake_conversation [--die-before-ready] [--ready-after-ms <毫秒>] [--hello-version <版本>] [--no-loop] [--skip-hello] --socket <路徑> [--host-socket <路徑>]
//!                   [--pair-socket <路徑> [--no-register] [--ready-before-register] [--die-on-attach | --refuse-attach | --ignore-attach] [--heartbeat-early]]
//! ```
//!
//! `--pair-socket`：當一對裡的葉子（#2583）。控制通道上不送 `ready`（`--ready-before-register` 例外），其餘照下面；連橋、交換 `hello`、`register` 一個工具，
//! 組合行程叫 `attach` 時當成收到那條 thread 的 `bind`（下面的動作照做，控制通道上那一則 `bound` 監督行程不看）：
//! 把 `bind` 排給主迴圈就回 `attach` 成功，不等主迴圈做完。
//! 另外在 `--socket` 上收資料連線：每條先寫一行 `leaf <pid>`，之後收到什麼回什麼。
//! `--no-register`：不連橋。`--ready-before-register`：先在控制通道送 `ready`、記一行 `ready`，等 `<socket 路徑>.go` 出現才連橋。
//! `--die-on-attach`：收到 `attach` 不回，當場以 9 結束。`--refuse-attach`：回錯；`--ignore-attach`：不回。這兩個都不當成收到 `bind`，所以心跳不會開始，
//! 要心跳照送就加 `--heartbeat-early`（連橋的才有用：送完 `hello` 就開始，不等 `bind`）。
//!
//! - 第一框送 `hello`（版本照 `--hello-version`，預設是 [`PROTOCOL_VERSION`]；宣告 loop 在自己這裡，`--no-loop` 不宣告）；`--skip-hello` 不送，直接送 `ready`。
//!   收到監督行程的 `hello` 記一行 `hello <token 的長度>`（不記值），token 留著給連宿主的動作用。
//! - `--die-before-ready`：一起來就以 7 結束。
//! - `--ready-after-ms`：等這麼久才送 `ready`。
//! - thread id 以逗號分段，第一段是名字，之後每段是一個動作，回 `bound` 之後依序做：
//!   `exit:<碼>`、`signal:<號>`（對自己送）、`turn`（送一次 `turn(begin)` 與 `turn(end)`）、`grandchild`（fork 一個睡著的子行程，
//!   同一個群組）、`close-stdout`、`ignore-eof`（stdin EOF 之後不結束，心跳也停）、`ignore-term`（再加上不理 SIGTERM）、
//!   `wrong-bound`（回別的 thread id，取代正常的 `bound`）、`flood`（之後不停往 stdout 寫 `heartbeat`，不再讀 stdin）、`stderr-flood`（之後不停往 stderr 寫填充，不再讀 stdin）、
//!   `heap`（往 stderr 寫 V8 heap 用完的訊息再 SIGABRT）、`alloc:<MiB>`（配置並碰過這麼多記憶體，留著不放）、`garbage`（送一個超過上限的框長，取代正常的 `bound`）、
//!   `wait-go`（等 `<socket 路徑>.go` 出現）、`stderr-junk:<KiB>`（stderr 的管線放大到 1 MiB，寫這麼多填充、以換行結尾；KiB ≤ 1024 時不等人讀）、
//!   `hang`（停掉心跳，之後什麼都不做、不讀 stdin）、`silent:<毫秒>`（心跳停這麼久、主執行緒也睡這麼久，
//!   之後恢復）、`spin:<毫秒>`（心跳停這麼久、主執行緒空轉這麼久，之後恢復；0 是一直轉）、`idle:<毫秒>`（送 `idle`，帶這個毫秒數）、`busy-on-drain`（收到 `drain` 回 `busy`）、`ignore-drain`（收到 `drain` 不回）、`slow-drain:<毫秒>`（收到 `drain` 等這麼久才回）、
//!   `busy-then-idle`（第一次收到 `drain` 回 `busy`，接著送 `idle(0)`、記一行 `idle`；之後的照預設回 `drained`）。
//!   連宿主（`--host-socket` 給的路徑；沒給就不連，記一行 `host no-socket`），回答記一行（`common/host_client.rs` 的格式）：`host-hello`（用監督行程給的 token）、
//!   `host-bad-token`（用別的 token）、`host-garbage`（送一個超過上限的框長）、`host-retry:<毫秒>`（每 50 ms 送一次 `hello`，
//!   直到宿主收下或過了這麼久，只記最後一次）。
//! - 緊接在名字後面的 `idle:<毫秒>` 例外，在 `bound` 之前送：監督行程照順序讀同一條管線，前台收到 `up` 時它已經讀到這幾個 `idle`。
//! - 收到 `drain` 預設回 `drained`，記一行 `drain`。
//! - 收到 `bind` 起就有一條執行緒每 [`HEARTBEAT`] 送一次 `heartbeat`，跟真的對話行程一樣一綁上就一直送。
//! - 每件事記一行到 `<socket 路徑>.log`：`pid <n>`、`bind <thread>`、`grandchild <n>`、`idle`（送出之後）、`drain`、`eof`、`sigterm`。

#[path = "common/host_client.rs"]
mod host_client;

use nexus_host::host_protocol::{CallError, ErrorCode};
use nexus_host::pair_protocol::{
    self, PairMessage, RejectCode, METHOD_ATTACH, PAIR_PROTOCOL_VERSION, RETRY_BACKOFF_MIN,
};
use nexus_sandbox_spawner::protocol::{frame, take_frame, take_frame_within};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_conversation_command, encode_conversation_command, encode_conversation_report,
    ConversationCommand, ConversationReport, TurnPhase, PROTOCOL_VERSION,
};
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

static LOG_FD: AtomicI32 = AtomicI32::new(-1);
/// 心跳先停：`hang`、`silent`、`spin`、`close-stdout` 設它；`ignore-eof` 在收到 EOF 時設它。
static QUIET: AtomicBool = AtomicBool::new(false);
const HEARTBEAT: Duration = Duration::from_millis(50);

fn log(line: &str) {
    let text = format!("{line}\n");
    // SAFETY：寫一個開著的 fd。
    unsafe {
        libc::write(
            LOG_FD.load(Ordering::SeqCst),
            text.as_ptr().cast(),
            text.len(),
        )
    };
}

extern "C" fn on_sigterm(_: libc::c_int) {
    let text = b"sigterm\n";
    // SAFETY：handler 裡只用 async-signal-safe 的 write 與 _exit。
    unsafe {
        libc::write(
            LOG_FD.load(Ordering::SeqCst),
            text.as_ptr().cast(),
            text.len(),
        );
        libc::_exit(0);
    }
}

fn report(report: &ConversationReport) {
    let mut out = std::io::stdout().lock();
    out.write_all(&frame(&encode_conversation_report(report)))
        .unwrap();
    out.flush().unwrap();
}

fn idle(ms: &str) {
    report(&ConversationReport::Idle {
        idle_ms: ms.parse().unwrap(),
    });
    log("idle");
}

fn start_heartbeat() {
    std::thread::spawn(|| loop {
        std::thread::sleep(HEARTBEAT);
        if QUIET.load(Ordering::SeqCst) {
            continue;
        }
        // 一則框在同一把 stdout 鎖裡寫完，不會跟主執行緒的框交錯；寫不出去（stdout 關了）就不寫。
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(&frame(&encode_conversation_report(
            &ConversationReport::Heartbeat,
        )));
        let _ = out.flush();
    });
}

/// 成對時主迴圈讀的那條管線的寫端：監督行程送來的框與橋上 `attach` 換成的 `bind` 都從這裡進去，一次一整框。
/// 監督行程那邊 EOF 就拿掉，主迴圈跟著讀到 EOF。
static CONTROL: Mutex<Option<std::fs::File>> = Mutex::new(None);
/// [`CONTROL`] 的 fd：`grandchild` fork 出去的子行程要關掉自己那一份，不然主迴圈讀不到 EOF。沒有是 -1。
static CONTROL_FD: AtomicI32 = AtomicI32::new(-1);

fn feed_control(framed: &[u8]) {
    if let Some(pipe) = CONTROL.lock().unwrap().as_mut() {
        let _ = pipe.write_all(framed);
    }
}

/// 把 fd 0 換成一條自己的管線，原本的 stdin 由一條執行緒逐框轉進去。
fn splice_control() {
    let mut fds = [0; 2];
    // SAFETY：開一條管線、複製 fd 0、把讀端換到 fd 0；拿到的 fd 各交給一個擁有者。
    let mut supervisor = unsafe {
        assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
        let original = libc::dup(0);
        assert!(original >= 0 && libc::dup2(fds[0], 0) == 0);
        libc::close(fds[0]);
        CONTROL_FD.store(fds[1], Ordering::SeqCst);
        *CONTROL.lock().unwrap() = Some(<std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(
            fds[1],
        ));
        <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(original)
    };
    std::thread::spawn(move || {
        let mut input = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = supervisor.read(&mut buf).unwrap_or(0);
            if n == 0 {
                CONTROL_FD.store(-1, Ordering::SeqCst);
                *CONTROL.lock().unwrap() = None;
                return;
            }
            input.extend_from_slice(&buf[..n]);
            while let Some(payload) = take_frame(&mut input).unwrap() {
                feed_control(&frame(&payload));
            }
        }
    });
}

/// 資料 socket：每條連線先報自己是誰，之後原樣回。
fn serve_data(socket: &str) {
    let listener = UnixListener::bind(socket).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            std::thread::spawn(move || {
                let _ = stream.write_all(format!("leaf {}\n", std::process::id()).as_bytes());
                let mut buf = [0u8; 4096];
                while let Ok(n) = stream.read(&mut buf) {
                    if n == 0 || stream.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            });
        }
    });
}

fn pair_send(stream: &mut UnixStream, message: &PairMessage) {
    let _ = stream.write_all(&frame(&pair_protocol::encode(message)));
}

/// 橋上的下一框；連線關了是 `None`。
fn pair_read(stream: &mut UnixStream, input: &mut Vec<u8>) -> Option<PairMessage> {
    let mut buf = [0u8; 4096];
    loop {
        if let Some(payload) = take_frame_within(input, pair_protocol::MAX_FRAME).unwrap() {
            return Some(pair_protocol::decode(&payload).unwrap());
        }
        match stream.read(&mut buf) {
            Ok(n) if n > 0 => input.extend_from_slice(&buf[..n]),
            _ => return None,
        }
    }
}

/// 連橋到交換完 `hello`：還連不上、或被要求稍後再試，就照協定的下限等了再連。
fn join_bridge(path: &str) -> (UnixStream, Vec<u8>) {
    loop {
        if let Ok(mut stream) = UnixStream::connect(path) {
            let mut input = Vec::new();
            pair_send(
                &mut stream,
                &PairMessage::Hello {
                    version: PAIR_PROTOCOL_VERSION,
                },
            );
            match pair_read(&mut stream, &mut input) {
                Some(PairMessage::Hello { .. }) => return (stream, input),
                Some(PairMessage::Rejected {
                    code: RejectCode::RetryLater,
                    ..
                })
                | None => {}
                Some(other) => panic!("橋沒收葉子：{other:?}"),
            }
        }
        std::thread::sleep(RETRY_BACKOFF_MIN);
    }
}

/// 收到 `attach` 怎麼辦。
#[derive(Clone, Copy, PartialEq)]
enum OnAttach {
    Bind,
    Die,
    Refuse,
    Ignore,
}

fn run_bridge(path: String, go: Option<String>, on_attach: OnAttach) {
    std::thread::spawn(move || {
        if let Some(go) = go {
            while !std::path::Path::new(&go).exists() {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        let (mut stream, mut input) = join_bridge(&path);
        pair_send(
            &mut stream,
            &PairMessage::Register {
                tools: vec!["tool".into()],
                hooks: Vec::new(),
            },
        );
        while let Some(message) = pair_read(&mut stream, &mut input) {
            let PairMessage::Call {
                call,
                method,
                payload,
                ..
            } = message
            else {
                continue;
            };
            if method != METHOD_ATTACH {
                continue;
            }
            match on_attach {
                OnAttach::Bind => {}
                OnAttach::Die => std::process::exit(9),
                OnAttach::Refuse => {
                    log("attach refused");
                    pair_send(
                        &mut stream,
                        &PairMessage::Result {
                            call,
                            outcome: Err(CallError {
                                code: ErrorCode::ServiceError,
                                message: "不綁".into(),
                            }),
                        },
                    );
                    continue;
                }
                OnAttach::Ignore => {
                    log("attach ignored");
                    continue;
                }
            }
            let thread = payload["threadId"].as_str().unwrap_or_default();
            feed_control(&frame(&encode_conversation_command(
                &ConversationCommand::Bind {
                    thread_id: thread.as_bytes().to_vec(),
                },
            )));
            pair_send(
                &mut stream,
                &PairMessage::Result {
                    call,
                    outcome: Ok(nexus_host::json::Value::Null),
                },
            );
        }
    });
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--die-before-ready") {
        std::process::exit(7);
    }
    let socket = args
        .iter()
        .position(|a| a == "--socket")
        .and_then(|i| args.get(i + 1))
        .expect("--socket")
        .clone();
    let host_socket = args
        .iter()
        .position(|a| a == "--host-socket")
        .and_then(|i| args.get(i + 1))
        .map(std::path::PathBuf::from);
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(format!("{socket}.log"))
        .unwrap();
    LOG_FD.store(std::os::fd::IntoRawFd::into_raw_fd(file), Ordering::SeqCst);
    // SAFETY：不留 core 檔（`signal:6`、`heap` 會 abort）。
    unsafe {
        libc::setrlimit(
            libc::RLIMIT_CORE,
            &libc::rlimit {
                rlim_cur: 0,
                rlim_max: 0,
            },
        )
    };
    // SAFETY：裝 handler。
    unsafe {
        libc::signal(
            libc::SIGTERM,
            on_sigterm as extern "C" fn(libc::c_int) as libc::sighandler_t,
        )
    };
    log(&format!("pid {}", std::process::id()));
    if let Some(ms) = args
        .iter()
        .position(|a| a == "--ready-after-ms")
        .and_then(|i| args.get(i + 1))
    {
        std::thread::sleep(Duration::from_millis(ms.parse().unwrap()));
    }
    if !args.iter().any(|a| a == "--skip-hello") {
        let version = args
            .iter()
            .position(|a| a == "--hello-version")
            .and_then(|i| args.get(i + 1))
            .map_or(PROTOCOL_VERSION, |v| v.parse().unwrap());
        report(&ConversationReport::Hello {
            version,
            runs_loop: !args.iter().any(|a| a == "--no-loop"),
        });
    }
    let pair_socket = args
        .iter()
        .position(|a| a == "--pair-socket")
        .and_then(|i| args.get(i + 1))
        .cloned();
    match pair_socket {
        None => report(&ConversationReport::Ready),
        Some(pair_socket) => {
            splice_control();
            serve_data(&socket);
            let early = args.iter().any(|a| a == "--ready-before-register");
            if early {
                report(&ConversationReport::Ready);
                log("ready");
            }
            if !args.iter().any(|a| a == "--no-register") {
                let has = |flag: &str| args.iter().any(|a| a == flag);
                let on_attach = if has("--die-on-attach") {
                    OnAttach::Die
                } else if has("--refuse-attach") {
                    OnAttach::Refuse
                } else if has("--ignore-attach") {
                    OnAttach::Ignore
                } else {
                    OnAttach::Bind
                };
                if has("--heartbeat-early") {
                    start_heartbeat();
                }
                run_bridge(
                    pair_socket,
                    early.then(|| format!("{socket}.go")),
                    on_attach,
                );
            }
        }
    }
    let mut token = Vec::new();

    let mut ignore_eof = false;
    let mut on_drain = Some(ConversationReport::Drained);
    let mut drain_delay = Duration::ZERO;
    let mut busy_then_idle = false;
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
                ConversationCommand::Hello { token: given, .. } => {
                    token = given;
                    log(&format!("hello {}", token.len()));
                    continue;
                }
                ConversationCommand::Bind { thread_id } => thread_id,
                ConversationCommand::Leaf { .. } => continue,
                ConversationCommand::Drain => {
                    log("drain");
                    std::thread::sleep(drain_delay);
                    if std::mem::take(&mut busy_then_idle) {
                        report(&ConversationReport::Busy);
                        report(&ConversationReport::Idle { idle_ms: 0 });
                        log("idle");
                    } else if let Some(answer) = &on_drain {
                        report(answer);
                    }
                    continue;
                }
            };
            let thread = String::from_utf8(thread_id.clone()).unwrap();
            log(&format!("bind {thread}"));
            start_heartbeat();
            let mut actions: Vec<&str> = thread.split(',').skip(1).collect();
            if actions.contains(&"garbage") {
                let mut out = std::io::stdout().lock();
                out.write_all(&u32::MAX.to_le_bytes()).unwrap();
                out.flush().unwrap();
                continue;
            }
            let bound = if actions.contains(&"wrong-bound") {
                b"someone-else".to_vec()
            } else {
                thread_id
            };
            let leading_idle = actions
                .iter()
                .take_while(|action| action.starts_with("idle:"))
                .count();
            for action in actions.drain(..leading_idle) {
                idle(&action["idle:".len()..]);
            }
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
                        report(&ConversationReport::Turn {
                            phase: TurnPhase::Begin,
                        });
                        report(&ConversationReport::Turn {
                            phase: TurnPhase::End,
                        });
                    }
                    // SAFETY：fork 之後子行程只關一個 fd、然後睡。
                    ("grandchild", _) => unsafe {
                        let pid = libc::fork();
                        if pid == 0 {
                            let control = CONTROL_FD.load(Ordering::SeqCst);
                            if control >= 0 {
                                libc::close(control);
                            }
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
                    ("spin", ms) => {
                        QUIET.store(true, Ordering::SeqCst);
                        let ms: u64 = ms.parse().unwrap();
                        let start = std::time::Instant::now();
                        while ms == 0 || start.elapsed() < Duration::from_millis(ms) {
                            std::hint::spin_loop();
                        }
                        QUIET.store(false, Ordering::SeqCst);
                    }
                    ("ignore-eof", _) => ignore_eof = true,
                    ("idle", ms) => idle(ms),
                    ("busy-on-drain", _) => on_drain = Some(ConversationReport::Busy),
                    ("ignore-drain", _) => on_drain = None,
                    ("busy-then-idle", _) => busy_then_idle = true,
                    ("slow-drain", ms) => drain_delay = Duration::from_millis(ms.parse().unwrap()),
                    ("ignore-term", _) => {
                        ignore_eof = true;
                        // SAFETY：改訊號處置。
                        unsafe { libc::signal(libc::SIGTERM, libc::SIG_IGN) };
                    }
                    ("wrong-bound", _) => {}
                    (action, _) if action.starts_with("host-") && host_socket.is_none() => {
                        log("host no-socket")
                    }
                    ("host-hello", _) => log(&host_client::hello_line(
                        host_socket.as_deref().unwrap(),
                        &String::from_utf8_lossy(&token),
                    )),
                    ("host-bad-token", _) => log(&host_client::hello_line(
                        host_socket.as_deref().unwrap(),
                        &"f".repeat(token.len()),
                    )),
                    ("host-garbage", _) => {
                        let too_long = nexus_host::host_protocol::MAX_FRAME as u32 + 1;
                        log(&host_client::send_line(
                            host_socket.as_deref().unwrap(),
                            &too_long.to_le_bytes(),
                        ));
                    }
                    ("host-retry", ms) => {
                        let host_socket = host_socket.as_deref().unwrap();
                        let until =
                            std::time::Instant::now() + Duration::from_millis(ms.parse().unwrap());
                        let token = String::from_utf8_lossy(&token).into_owned();
                        let line = loop {
                            let line = host_client::hello_line(host_socket, &token);
                            if line == "host hello" || std::time::Instant::now() > until {
                                break line;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        };
                        log(&line);
                    }
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
                    ("alloc", mib) => std::mem::forget(std::hint::black_box(vec![
                        1u8;
                        mib.parse::<usize>().unwrap()
                            << 20
                    ])),
                    ("flood", _) => {
                        let batch: Vec<u8> = (0..65536)
                            .flat_map(|_| {
                                frame(&encode_conversation_report(&ConversationReport::Heartbeat))
                            })
                            .collect();
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
