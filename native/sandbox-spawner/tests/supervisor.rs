//! 真的監督行程、真的子行程（#2340）。只在 Linux 跑。
//!
//! 前台與對話行程是兩支假程式：`fake_front`（`examples/`）把監督行程的前台通道轉到這裡聽著的 Unix socket，測試就站在前台的位置；
//! `fake_conversation`（`host/examples/`，要用宿主的協定）照協定回 `ready`／`bound`，之後照 thread id 做事、把收到的 EOF 與 SIGTERM 記進 `<socket>.log`。
//! 等待一律寫成「最多等多久、條件成立就過」，不拿牆鐘時間當斷言。空轉測試例外：固定量兩秒的 CPU tick。

#![cfg(target_os = "linux")]

use nexus_sandbox_spawner::protocol::{frame, take_frame};
use nexus_sandbox_spawner::supervisor::sweep;
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_front_event, encode_front_request, DeathCause, FrontEvent, FrontRequest, OpenMode,
    PROTOCOL_VERSION,
};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::MetadataExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const SUPERVISOR: &str = env!("CARGO_BIN_EXE_nexus-supervisor");
const WAIT: Duration = Duration::from_secs(20);

fn example(name: &str) -> PathBuf {
    Path::new(SUPERVISOR)
        .parent()
        .unwrap()
        .join("examples")
        .join(name)
}

fn temp_dir(tag: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("nsup-{tag}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn wait_until(mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + WAIT;
    while Instant::now() < deadline {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    done()
}

/// 行程不在了，或已經死了、只剩還沒被收的 zombie。
/// 「死了」寫在這裡、不叫 `Member::dead()`：測試的判斷要獨立於被測的判斷。`Z` 而且還有執行緒的行程沒死（主執行緒結束、其他執行緒在跑）。
/// 讀不了不是「不在」：`read_member` 回錯就 panic。
fn gone(pid: i32) -> bool {
    match sweep::read_member(pid).unwrap() {
        None => true,
        Some(member) => member.zombie && member.threads <= 1,
    }
}

/// 這個行程累計用掉的 CPU（clock tick）。
fn cpu_ticks(pid: u32) -> u64 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields: Vec<&str> = stat.rsplit_once(") ").unwrap().1.split(' ').collect();
    // 括號後第 12、13 欄是 utime、stime（stat 的第 14、15 欄）。
    fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap()
}

fn kill(pid: u32, signal: i32) {
    // SAFETY：只送訊號。
    unsafe { libc::kill(pid as i32, signal) };
}

struct Options {
    conversation: PathBuf,
    conversation_args: Vec<String>,
    eof_grace_ms: u64,
    term_grace_ms: u64,
    /// 多給監督行程的參數。
    extra: Vec<&'static str>,
    /// 監督行程的 stderr 丟掉，不寫進 `supervisor.err`。
    discard_stderr: bool,
    /// 監督行程的 stderr 接一條讀端已經關掉的管線：每次寫都是 EPIPE。
    broken_stderr: bool,
    /// 監督行程的 stderr 接一條管線，讀端留在 `Harness::stderr`，測試不讀它就會滿。
    piped_stderr: bool,
    /// 前台連上之後送的 `hello` 版本；`None` 是不送（測試自己送）。
    front_hello: Option<u32>,
    /// 讀到 `stop-admission` 時回 `admission-stopped`（並略過它，不交給測試）。
    answer_stop_admission: bool,
    /// `--host` 與它的 `--host-arg`；`None` 是不起宿主。
    host: Option<(PathBuf, Vec<String>)>,
    /// 多給監督行程的環境變數。
    env: Vec<(&'static str, PathBuf)>,
    /// `--composition`；`None` 是一條對話一個行程。
    composition: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            conversation: example("fake_conversation"),
            conversation_args: Vec::new(),
            eof_grace_ms: 300,
            term_grace_ms: 300,
            extra: Vec::new(),
            discard_stderr: false,
            broken_stderr: false,
            piped_stderr: false,
            front_hello: Some(PROTOCOL_VERSION),
            answer_stop_admission: true,
            host: None,
            env: Vec::new(),
            composition: None,
        }
    }
}

struct Harness {
    child: Child,
    listener: UnixListener,
    front: Option<UnixStream>,
    inbox: Vec<u8>,
    dir: PathBuf,
    stderr: Option<std::fs::File>,
    front_hello: Option<u32>,
    answer_stop_admission: bool,
    /// 前台最近一次收到的 `hello` 帶的 token。
    front_token: Vec<u8>,
}

impl Harness {
    fn start(options: Options) -> Harness {
        let dir = temp_dir("h");
        let listener = UnixListener::bind(dir.join("front.sock")).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut cmd = Command::new(SUPERVISOR);
        cmd.arg("--run-dir").arg(dir.join("run"));
        cmd.arg("--audit").arg(dir.join("audit.jsonl"));
        cmd.arg("--front")
            .arg(example("fake_front"))
            .arg("--front-arg")
            .arg(dir.join("front.sock"));
        cmd.arg("--conversation").arg(&options.conversation);
        for arg in &options.conversation_args {
            cmd.arg("--conversation-arg").arg(arg);
        }
        cmd.args(["--eof-grace-ms", &options.eof_grace_ms.to_string()]);
        cmd.args([
            "--term-grace-ms",
            &options.term_grace_ms.to_string(),
            "--front-restart-ms",
            "100",
        ]);
        // 預熱池與定時的 `stats` 預設關掉，免得每條測試多一個行程、多出沒預期的訊息；容量固定，不跟著跑測試那台的記憶體變。要測它們的測試從 `extra` 蓋過去。
        cmd.args(["--warm", "0", "--capacity", "64", "--stats-ms", "0"]);
        // 停機時不等前台回答 `stop-admission`：多數測試不讀前台的訊息，等了只會慢；要測它的從 `extra` 蓋過去。
        cmd.args(["--admission-timeout-ms", "0"]);
        if let Some((host, args)) = &options.host {
            cmd.arg("--host").arg(host);
            for arg in args {
                cmd.arg("--host-arg").arg(arg);
            }
            // 退避縮短，免得要測重起的測試等滿一秒。
            cmd.args(["--host-backoff-ms", "50", "--host-backoff-max-ms", "200"]);
        }
        if let Some(composition) = &options.composition {
            cmd.arg("--composition").arg(composition);
        }
        cmd.args(&options.extra);
        cmd.envs(options.env.iter().map(|(name, value)| (name, value)));
        let mut stderr_read = None;
        let stderr = if options.piped_stderr {
            let mut fds = [0; 2];
            // SAFETY：拿一對新的 pipe。
            assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
            // SAFETY：兩端都是剛拿到的，各交給一個擁有者。
            stderr_read =
                Some(unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fds[0]) });
            Stdio::from(unsafe {
                <std::os::fd::OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fds[1])
            })
        } else if options.broken_stderr {
            let mut fds = [0; 2];
            // SAFETY：拿一對新的 pipe，讀端當場關掉。
            assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
            // SAFETY：fds 是剛拿到的。
            unsafe { libc::close(fds[0]) };
            // SAFETY：寫端交給 Stdio 擁有。
            Stdio::from(unsafe {
                <std::os::fd::OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fds[1])
            })
        } else if options.discard_stderr {
            Stdio::null()
        } else {
            Stdio::from(std::fs::File::create(dir.join("supervisor.err")).unwrap())
        };
        let child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(stderr)
            .spawn()
            .unwrap();
        let mut harness = Harness {
            child,
            listener,
            front: None,
            inbox: Vec::new(),
            dir,
            stderr: stderr_read,
            front_hello: options.front_hello,
            answer_stop_admission: options.answer_stop_admission,
            front_token: Vec::new(),
        };
        harness.accept_front();
        harness
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 等前台（`fake_front`）連進來；照 `front_hello` 送 `hello`，並收下監督行程的 `hello`。
    fn accept_front(&mut self) {
        self.accept_front_raw();
        if let Some(version) = self.front_hello {
            self.request(&FrontRequest::Hello { version });
            match self.event() {
                FrontEvent::Hello {
                    version: PROTOCOL_VERSION,
                    token,
                } => self.front_token = token,
                other => panic!("前台的第一框要是 hello，拿到 {other:?}"),
            }
        }
    }

    fn accept_front_raw(&mut self) {
        let deadline = Instant::now() + WAIT;
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream
                        .set_read_timeout(Some(Duration::from_millis(100)))
                        .unwrap();
                    self.front = Some(stream);
                    self.inbox.clear();
                    return;
                }
                Err(err) if err.kind() == ErrorKind::WouldBlock && Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(err) => panic!("前台沒連進來：{err}"),
            }
        }
    }

    fn ensure(&mut self, thread: &str) {
        self.ensure_open(thread, OpenMode::Run);
    }

    fn ensure_open(&mut self, thread: &str, open: OpenMode) {
        self.request(&FrontRequest::Ensure {
            thread_id: thread.as_bytes().to_vec(),
            open,
        });
    }

    fn release(&mut self, thread: &str) {
        self.request(&FrontRequest::Release {
            thread_id: thread.as_bytes().to_vec(),
        });
    }

    fn request(&mut self, request: &FrontRequest) {
        self.front
            .as_mut()
            .unwrap()
            .write_all(&frame(&encode_front_request(request)))
            .unwrap();
    }

    /// 只讀開啟，等到 `up`。
    fn up_read_only(&mut self, thread: &str) -> PathBuf {
        self.ensure_open(thread, OpenMode::ReadOnly);
        self.up_of(thread)
    }

    /// 下一則給前台的訊息；前台的連線斷了（監督行程收掉了前台）回 `None`。
    fn next_event(&mut self) -> Option<FrontEvent> {
        let deadline = Instant::now() + WAIT;
        let front = self.front.as_mut().unwrap();
        loop {
            if let Some(payload) = take_frame(&mut self.inbox).unwrap() {
                let event = decode_front_event(&payload).unwrap();
                if event == FrontEvent::StopAdmission && self.answer_stop_admission {
                    let _ = front.write_all(&frame(&encode_front_request(
                        &FrontRequest::AdmissionStopped,
                    )));
                    continue;
                }
                return Some(event);
            }
            let mut buf = [0u8; 4096];
            match front.read(&mut buf) {
                Ok(0) => return None,
                Ok(n) => self.inbox.extend_from_slice(&buf[..n]),
                Err(err) if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
                    assert!(Instant::now() < deadline, "等不到給前台的訊息");
                }
                Err(_) => return None,
            }
        }
    }

    fn event(&mut self) -> FrontEvent {
        self.next_event().expect("前台的連線斷了")
    }

    /// 要一條 thread、等到 `up`，回 socket 路徑。
    fn up(&mut self, thread: &str) -> PathBuf {
        self.ensure(thread);
        self.up_of(thread)
    }

    /// 等到 `thread` 的 `up`，回 socket 路徑。別的 thread 的 `up` 收下略過：逐出之後替等待的 thread 起的行程，`up` 在它綁好時才送，
    /// 可能排在測試後來要的那條 thread 的 `up` 前面，先後取決於測試多快送出下一個請求。
    fn up_of(&mut self, thread: &str) -> PathBuf {
        loop {
            match self.event() {
                FrontEvent::Up { thread_id, socket } if thread_id == thread.as_bytes() => {
                    return PathBuf::from(String::from_utf8(socket).unwrap());
                }
                FrontEvent::Up { .. } => {}
                other => panic!("要 {thread} 的 up，拿到 {other:?}"),
            }
        }
    }

    /// 要一條 thread、等到 `down`（中間可以先有 `up`），回死因。
    fn down(&mut self, thread: &str) -> DeathCause {
        self.ensure(thread);
        self.down_of(thread)
    }

    fn down_of(&mut self, thread: &str) -> DeathCause {
        loop {
            match self.event() {
                FrontEvent::Down { thread_id, cause } if thread_id == thread.as_bytes() => {
                    return cause
                }
                FrontEvent::Up { thread_id, .. } if thread_id == thread.as_bytes() => {}
                other => panic!("要 {thread} 的 down，拿到 {other:?}"),
            }
        }
    }

    fn audit(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("audit.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(String::from)
            .collect()
    }

    /// 等到稽核裡有一行含 `needle`，回那一行。
    fn audit_line(&self, needle: &str) -> String {
        let mut found = None;
        assert!(
            wait_until(|| {
                found = self.audit().into_iter().find(|line| line.contains(needle));
                found.is_some()
            }),
            "稽核裡沒有含 {needle} 的行：{:?}",
            self.audit()
        );
        found.unwrap()
    }

    fn wait_exit(&mut self) -> ExitStatus {
        let mut status = None;
        assert!(wait_until(|| {
            status = self.child.try_wait().unwrap();
            status.is_some()
        }));
        status.unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 假對話行程的紀錄，濾掉 `hello` 那一行，其他測試照行號比對；要看它用 [`raw_log`]。
fn log(socket: &Path) -> Vec<String> {
    raw_log(socket)
        .into_iter()
        .filter(|line| !line.starts_with("hello "))
        .collect()
}

fn raw_log(socket: &Path) -> Vec<String> {
    std::fs::read_to_string(format!("{}.log", socket.display()))
        .unwrap_or_default()
        .lines()
        .map(String::from)
        .collect()
}

fn logged_pid(socket: &Path, key: &str) -> i32 {
    let mut pid = None;
    assert!(wait_until(|| {
        pid = log(socket).iter().find_map(|line| {
            line.strip_prefix(&format!("{key} "))
                .map(|p| p.parse().unwrap())
        });
        pid.is_some()
    }));
    pid.unwrap()
}

#[test]
fn ensure_binds_and_reports_the_socket_in_a_private_run_dir() {
    let mut h = Harness::start(Options::default());
    let socket = h.up("a");
    assert_eq!(socket.parent().unwrap(), h.dir.join("run"));
    assert_eq!(
        std::fs::metadata(h.dir.join("run")).unwrap().mode() & 0o777,
        0o700
    );
    assert_eq!(log(&socket)[1], "bind a");
    // 已經 up 的再要一次：同一個行程、同一個 socket。
    assert_eq!(h.up("a"), socket);
    assert_eq!(
        log(&socket)
            .iter()
            .filter(|l| l.starts_with("pid "))
            .count(),
        1
    );
    assert!(h.audit().is_empty());
    // 監督行程只有一條執行緒：PDEATHSIG 跟著起子行程的那條執行緒走。
    assert_eq!(
        std::fs::read_dir(format!("/proc/{}/task", h.pid()))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn nonzero_exit_is_crash_and_audited_with_turns() {
    let mut h = Harness::start(Options::default());
    assert_eq!(h.down("x,turn,turn,exit:3"), DeathCause::Crash);
    let line = h.audit_line("\"thread\":\"x,turn,turn,exit:3\"");
    assert!(line.contains("\"role\":\"conversation\""), "{line}");
    assert!(line.contains("\"cause\":\"crash\""), "{line}");
    assert!(line.contains("\"turns\":2"), "{line}");
    assert!(line.contains("\"exit_code\":3,\"signal\":null"), "{line}");
}

#[test]
fn unasked_clean_exit_is_crash() {
    let mut h = Harness::start(Options::default());
    assert_eq!(h.down("x,exit:0"), DeathCause::Crash);
    assert!(h.audit_line("x,exit:0").contains("\"exit_code\":0"));
}

#[test]
fn killed_by_signal_is_crash() {
    let mut h = Harness::start(Options::default());
    assert_eq!(h.down("x,signal:9"), DeathCause::Crash);
    assert!(h
        .audit_line("x,signal:9")
        .contains("\"exit_code\":null,\"signal\":9"));
}

#[test]
fn dying_before_ready_is_crash_without_up() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--die-before-ready".into()],
        ..Options::default()
    });
    h.ensure("early");
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: b"early".to_vec(),
            cause: DeathCause::Crash
        }
    );
    assert!(h.audit_line("early").contains("\"exit_code\":7"));
}

#[test]
fn failing_to_spawn_is_crash_with_the_error_audited() {
    let mut h = Harness::start(Options {
        conversation: PathBuf::from("/nonexistent/conversation"),
        ..Options::default()
    });
    h.ensure("nope");
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: b"nope".to_vec(),
            cause: DeathCause::Crash
        }
    );
    let line = h.audit_line("nope");
    assert!(
        line.contains("\"pid\":0") && line.contains("\"error\":"),
        "{line}"
    );
}

#[test]
fn undecodable_frame_gets_killed_as_crash() {
    let mut h = Harness::start(Options::default());
    h.ensure("g,garbage");
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: b"g,garbage".to_vec(),
            cause: DeathCause::Crash
        }
    );
    assert!(h.audit_line("g,garbage").contains("\"signal\":9"));
}

#[test]
fn binding_the_wrong_thread_gets_killed_as_crash() {
    let mut h = Harness::start(Options::default());
    h.ensure("w,wrong-bound");
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: b"w,wrong-bound".to_vec(),
            cause: DeathCause::Crash
        }
    );
}

#[test]
fn leader_exit_takes_its_process_group_with_it() {
    let mut h = Harness::start(Options::default());
    let socket = h.up("p,grandchild");
    let grandchild = logged_pid(&socket, "grandchild");
    assert!(!gone(grandchild));
    h.ensure("q,exit:5");
    assert_eq!(h.down_of("q,exit:5"), DeathCause::Crash);
    assert!(!gone(grandchild), "別條對話的群組不受影響");
    // 讓 p 自己結束：它的孫行程跟著群組一起被殺。
    kill(logged_pid(&socket, "pid") as u32, libc::SIGKILL);
    assert_eq!(h.down_of("p,grandchild"), DeathCause::Crash);
    assert!(wait_until(|| gone(grandchild)), "孫行程 {grandchild} 還在");
}

#[test]
fn shutdown_walks_the_teardown_ladder() {
    let mut h = Harness::start(Options::default());
    let plain = h.up("plain");
    let eof = h.up("e,ignore-eof");
    let term = h.up("t,ignore-term,grandchild");
    let grandchild = logged_pid(&term, "grandchild");
    kill(h.pid(), libc::SIGTERM);
    let mut downs = Vec::new();
    for _ in 0..3 {
        match h.event() {
            FrontEvent::Down { thread_id, cause } => {
                downs.push((String::from_utf8(thread_id).unwrap(), cause))
            }
            other => panic!("要 down，拿到 {other:?}"),
        }
    }
    downs.sort_by(|a, b| a.0.cmp(&b.0));
    let names: Vec<&str> = downs.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(names, ["e,ignore-eof", "plain", "t,ignore-term,grandchild"]);
    assert!(
        downs
            .iter()
            .all(|(_, cause)| *cause == DeathCause::Shutdown),
        "{downs:?}"
    );
    // 對話行程都收完才收前台：前台讀到 EOF、結束，連線斷掉。
    assert_eq!(h.next_event(), None);
    assert!(h.wait_exit().success());

    // plain 讀到 EOF 就結束；寬限只有幾百毫秒，忙的機器上它可能先收到 SIGTERM，所以只驗第一件事。
    assert_eq!(log(&plain)[2], "eof");
    assert_eq!(log(&eof)[2..], ["eof", "sigterm"]);
    assert_eq!(
        log(&term)[2..],
        [
            "grandchild ".to_string() + &grandchild.to_string(),
            "eof".to_string()
        ]
    );
    assert!(wait_until(|| gone(grandchild)));
    assert!(h
        .audit_line("\"thread\":\"plain\"")
        .contains("\"cause\":\"shutdown\""));
    assert!(h.audit_line("e,ignore-eof").contains("\"exit_code\":0"));
    assert!(h.audit_line("t,ignore-term").contains("\"signal\":9"));
    assert!(h
        .audit_line("\"role\":\"front\"")
        .contains("\"exit_code\":0"));
}

#[test]
fn second_stop_signal_kills_at_once() {
    let mut h = Harness::start(Options {
        eof_grace_ms: 600_000,
        term_grace_ms: 600_000,
        ..Options::default()
    });
    let socket = h.up("t,ignore-term");
    kill(h.pid(), libc::SIGTERM);
    assert!(wait_until(|| log(&socket).contains(&"eof".to_string())));
    kill(h.pid(), libc::SIGINT);
    assert_eq!(h.down_of("t,ignore-term"), DeathCause::Shutdown);
    assert!(h.wait_exit().success());
    assert!(h.audit_line("t,ignore-term").contains("\"signal\":9"));
}

/// 等前台回 `admission-stopped` 的那一段再收到停止訊號：這時停機還沒開始收對話行程，被當場殺掉的照樣是停機收的，
/// 回 `down(shutdown)`、稽核記 `shutdown`，不算成 `crash`（#2827）。
#[test]
fn a_second_stop_signal_before_the_front_answers_is_down_shutdown() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        extra: vec!["--admission-timeout-ms", "20000"],
        ..Options::default()
    });
    h.up("a");
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.event(), FrontEvent::StopAdmission);
    kill(h.pid(), libc::SIGINT);
    assert_eq!(h.down_of("a"), DeathCause::Shutdown);
    h.request(&FrontRequest::AdmissionStopped);
    assert!(h.wait_exit().success());
    let line = h.audit_line("\"thread\":\"a\"");
    assert!(
        line.contains("\"cause\":\"shutdown\"") && line.contains("\"signal\":9"),
        "{line}"
    );
}

/// 等前台回答的那一段自己結束的對話行程不是停機收的：照樣是 `crash`。死因在決定收的那一刻才記，不是停機一開始就全部記成 `shutdown`。
/// `--admission-timeout-ms` 拉長：等前台的那一段要蓋住它結束的時刻，不然停機已經開始收它、先記了 `shutdown`。
#[test]
fn a_conversation_that_dies_by_itself_before_the_front_answers_is_a_crash() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        extra: vec!["--admission-timeout-ms", "20000"],
        ..Options::default()
    });
    let thread = "a,wait-go,exit:3";
    let a = h.up(thread);
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.event(), FrontEvent::StopAdmission);
    std::fs::write(format!("{}.go", a.display()), b"").unwrap();
    assert_eq!(h.down_of(thread), DeathCause::Crash);
    h.request(&FrontRequest::AdmissionStopped);
    assert!(h.wait_exit().success());
}

/// 已經被逐出、還在收的對話行程（不理 EOF 與 SIGTERM），停機中再收到停止訊號時被當場殺掉：死因還是原來的 `evicted`，不被蓋成 `shutdown`。
#[test]
fn a_second_stop_signal_keeps_the_cause_of_a_conversation_already_being_collected() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        eof_grace_ms: 600_000,
        term_grace_ms: 600_000,
        extra: vec!["--capacity", "1", "--admission-timeout-ms", "20000"],
        ..Options::default()
    });
    let thread = "a,idle:1000,ignore-term";
    let a = h.up(thread);
    h.ensure("b");
    // 先等到 `eof` 才送停止訊號：`drained` 在停機開始之後才讀到的不記 `evicted`。
    assert!(wait_until(|| log(&a).contains(&"eof".to_string())));
    kill(h.pid(), libc::SIGTERM);
    let mut events = Vec::new();
    loop {
        let event = h.event();
        let last = event == FrontEvent::StopAdmission;
        events.push(event);
        if last {
            break;
        }
    }
    kill(h.pid(), libc::SIGINT);
    loop {
        let event = h.event();
        let last =
            matches!(&event, FrontEvent::Down { thread_id, .. } if thread_id == thread.as_bytes());
        events.push(event);
        if last {
            break;
        }
    }
    assert_eq!(
        events.last(),
        Some(&FrontEvent::Down {
            thread_id: thread.as_bytes().to_vec(),
            cause: DeathCause::Evicted
        }),
        "{events:?}"
    );
    h.request(&FrontRequest::AdmissionStopped);
    assert!(h.wait_exit().success());
    let line = h.audit_line("\"thread\":\"a,idle:1000,ignore-term\"");
    assert!(
        line.contains("\"cause\":\"evicted\"") && line.contains("\"signal\":9"),
        "{line}"
    );
}

#[test]
fn ensure_during_shutdown_is_answered_with_shutdown() {
    let mut h = Harness::start(Options {
        eof_grace_ms: 600_000,
        term_grace_ms: 600_000,
        ..Options::default()
    });
    let socket = h.up("t,ignore-term");
    kill(h.pid(), libc::SIGTERM);
    assert!(wait_until(|| log(&socket).contains(&"eof".to_string())));
    h.ensure("late");
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: b"late".to_vec(),
            cause: DeathCause::Shutdown
        }
    );
}

#[test]
fn sigkilled_supervisor_leaves_no_orphan_conversations() {
    let mut h = Harness::start(Options::default());
    let a = logged_pid(&h.up("a"), "pid");
    let b = logged_pid(&h.up("b,ignore-term"), "pid");
    kill(h.pid(), libc::SIGKILL);
    h.wait_exit();
    assert!(
        wait_until(|| gone(a) && gone(b)),
        "對話行程 {a} 或 {b} 還在"
    );
    // 前台也一樣：它的連線斷了。
    assert_eq!(h.next_event(), None);
}

#[test]
fn restarted_front_hears_up_for_every_live_conversation() {
    let mut h = Harness::start(Options::default());
    let a = h.up("a");
    let b = h.up("b");
    // 關掉這一側，假前台讀到 EOF 就結束；監督行程重起一個，新的前台再連進來。
    h.front = None;
    h.accept_front();
    let mut ups = vec![h.event(), h.event()];
    ups.sort_by_key(|e| format!("{e:?}"));
    let socket = |p: &PathBuf| p.as_os_str().as_encoded_bytes().to_vec();
    assert_eq!(
        ups,
        [
            FrontEvent::Up {
                thread_id: b"a".to_vec(),
                socket: socket(&a)
            },
            FrontEvent::Up {
                thread_id: b"b".to_vec(),
                socket: socket(&b)
            },
        ]
    );
    assert!(h
        .audit_line("\"role\":\"front\"")
        .contains("\"exit_code\":0"));
    // 對話行程沒受影響：還是同一個。
    assert_eq!(h.up("a"), a);
}

#[test]
fn closed_conversation_stdout_does_not_spin() {
    let mut h = Harness::start(Options::default());
    let socket = h.up("c,close-stdout");
    assert!(!gone(logged_pid(&socket, "pid")));
    std::thread::sleep(Duration::from_millis(200));
    let before = cpu_ticks(h.pid());
    std::thread::sleep(Duration::from_secs(2));
    let used = cpu_ticks(h.pid()) - before;
    // 空轉兩秒大約是 200 tick（USER_HZ 100）；正常是 0。
    assert!(used < 20, "監督行程兩秒內用了 {used} tick");
}

#[test]
fn unusable_audit_path_refuses_to_start() {
    let dir = temp_dir("bad");
    let status = Command::new(SUPERVISOR)
        .args([
            "--run-dir",
            dir.join("run").to_str().unwrap(),
            "--audit",
            "/nonexistent/dir/audit.jsonl",
        ])
        .args(["--front", "/bin/true", "--conversation", "/bin/true"])
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1));
}

#[test]
fn bad_arguments_exit_2() {
    let status = Command::new(SUPERVISOR)
        .arg("--nope")
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(2));
}

#[test]
fn flooding_conversation_does_not_starve_the_others() {
    let mut h = Harness::start(Options::default());
    h.up("f,flood");
    // 狂寫的那條還在寫，別的照樣起、照樣收。
    h.up("b");
    h.ensure("x,exit:3");
    assert_eq!(h.down_of("x,exit:3"), DeathCause::Crash);
    kill(h.pid(), libc::SIGTERM);
    let mut downs = vec![h.event(), h.event()];
    downs.sort_by_key(|event| match event {
        FrontEvent::Down { thread_id, .. } => thread_id.clone(),
        other => panic!("要 down，拿到 {other:?}"),
    });
    assert_eq!(
        downs,
        [
            FrontEvent::Down {
                thread_id: b"b".to_vec(),
                cause: DeathCause::Shutdown
            },
            FrontEvent::Down {
                thread_id: b"f,flood".to_vec(),
                cause: DeathCause::Shutdown
            },
        ]
    );
    assert!(h.wait_exit().success());
}

/// 等它結束（最多 `WAIT`），回結束碼；到時還在跑就殺掉、回 `None`。
fn exit_code(mut child: Child) -> Option<i32> {
    let mut code = None;
    if wait_until(|| {
        child
            .try_wait()
            .unwrap()
            .map(|status| code = status.code())
            .is_some()
    }) {
        return code;
    }
    kill(child.id(), libc::SIGKILL);
    child.wait().unwrap();
    None
}

fn supervisor_with_audit(dir: &Path, audit: &Path) -> Child {
    Command::new(SUPERVISOR)
        .args([
            "--run-dir",
            dir.join("run").to_str().unwrap(),
            "--audit",
            audit.to_str().unwrap(),
        ])
        .args(["--front", "/bin/true", "--conversation", "/bin/true"])
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

#[test]
fn audit_file_must_be_own_private_regular_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("audit");
    let readable = dir.join("readable.jsonl");
    std::fs::write(&readable, "").unwrap();
    std::fs::set_permissions(&readable, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(exit_code(supervisor_with_audit(&dir, &readable)), Some(1));

    let target = dir.join("target.jsonl");
    std::fs::write(&target, "").unwrap();
    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
    let link = dir.join("link.jsonl");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert_eq!(exit_code(supervisor_with_audit(&dir, &link)), Some(1));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "");

    // 自己的、0600 的照常用：前台（/bin/true）一結束就寫進去。
    let mut child = supervisor_with_audit(&dir, &target);
    assert!(wait_until(|| std::fs::read_to_string(&target)
        .unwrap()
        .contains("\"role\":\"front\"")));
    kill(child.id(), libc::SIGKILL);
    child.wait().unwrap();
}

fn supervisor_stderr(h: &Harness) -> String {
    String::from_utf8_lossy(&std::fs::read(h.dir.join("supervisor.err")).unwrap()).into_owned()
}

/// 邊界：4000 警告、4001 與預設不警告；警告的那個照常起得來。
#[test]
fn a_small_stall_ms_warns_at_startup_and_still_starts() {
    let mut small = Harness::start(Options {
        extra: vec!["--stall-ms", "4000"],
        ..Options::default()
    });
    assert!(
        supervisor_stderr(&small).contains("--stall-ms 4000 "),
        "{}",
        supervisor_stderr(&small)
    );
    small.up("w,small-stall");
    kill(small.pid(), libc::SIGTERM);
    let mut plain = Harness::start(Options::default());
    plain.up("w,default-stall");
    assert!(
        !supervisor_stderr(&plain).contains("--stall-ms"),
        "{}",
        supervisor_stderr(&plain)
    );
    let mut large = Harness::start(Options {
        extra: vec!["--stall-ms", "4001"],
        ..Options::default()
    });
    large.up("w,large-stall");
    assert!(!supervisor_stderr(&large).contains("--stall-ms"));
    kill(plain.pid(), libc::SIGTERM);
    kill(large.pid(), libc::SIGTERM);
}

#[test]
fn abort_with_the_v8_heap_message_is_heap() {
    let mut h = Harness::start(Options::default());
    assert_eq!(h.down("h,heap"), DeathCause::Heap);
    let line = h.audit_line("\"thread\":\"h,heap\"");
    assert!(
        line.contains("\"cause\":\"heap\"") && line.contains("\"signal\":6"),
        "{line}"
    );
    // stderr 原樣轉到監督行程的 stderr。
    assert!(wait_until(
        || supervisor_stderr(&h).contains("Reached heap limit")
    ));
    // 沒有那段訊息的 SIGABRT 是 crash。
    assert_eq!(h.down("a,signal:6"), DeathCause::Crash);
}

#[test]
fn heap_message_still_in_the_pipe_at_exit_is_read() {
    let mut h = Harness::start(Options {
        discard_stderr: true,
        ..Options::default()
    });
    // 監督行程停著的時候，對話行程把超過一次讀取上限的填充與 heap 訊息寫進管線、死掉；收屍時要把管線讀完才分類。
    let thread = "late,wait-go,stderr-junk:512,heap";
    let socket = h.up(thread);
    let pid = logged_pid(&socket, "pid");
    kill(h.pid(), libc::SIGSTOP);
    std::fs::write(format!("{}.go", socket.display()), "").unwrap();
    let died = wait_until(|| gone(pid));
    kill(h.pid(), libc::SIGCONT);
    assert!(died);
    assert_eq!(h.down_of(thread), DeathCause::Heap);
}

#[test]
fn rss_over_the_limit_is_memory_and_spares_the_others() {
    let mut h = Harness::start(Options {
        extra: vec!["--rss-limit-mb", "64", "--rss-poll-ms", "50"],
        ..Options::default()
    });
    let small = h.up("small");
    assert_eq!(h.down("big,alloc:200"), DeathCause::Memory);
    let line = h.audit_line("\"thread\":\"big,alloc:200\"");
    assert!(
        line.contains("\"cause\":\"memory\"") && line.contains("\"signal\":9"),
        "{line}"
    );
    let rss: u64 = line
        .split("\"rss_kb\":")
        .nth(1)
        .unwrap()
        .split(',')
        .next()
        .unwrap()
        .parse()
        .unwrap();
    assert!(rss > 64 * 1024, "{line}");
    // 沒超過的那條還是同一個行程。
    assert_eq!(h.up("small"), small);
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.down_of("small"), DeathCause::Shutdown);
    assert!(!h
        .audit_line("\"thread\":\"small\"")
        .contains("\"rss_kb\":0,"));
}

#[test]
fn flooding_stderr_does_not_starve_the_others() {
    let mut h = Harness::start(Options {
        discard_stderr: true,
        ..Options::default()
    });
    h.up("s,stderr-flood");
    h.up("b");
    h.ensure("x,exit:3");
    assert_eq!(h.down_of("x,exit:3"), DeathCause::Crash);
    kill(h.pid(), libc::SIGTERM);
    let mut downs = vec![h.event(), h.event()];
    downs.sort_by_key(|event| match event {
        FrontEvent::Down { thread_id, .. } => thread_id.clone(),
        other => panic!("要 down，拿到 {other:?}"),
    });
    assert_eq!(
        downs,
        [
            FrontEvent::Down {
                thread_id: b"b".to_vec(),
                cause: DeathCause::Shutdown
            },
            FrontEvent::Down {
                thread_id: b"s,stderr-flood".to_vec(),
                cause: DeathCause::Shutdown
            },
        ]
    );
    assert!(h.wait_exit().success());
}

#[test]
fn stderr_that_cannot_be_written_does_not_take_the_supervisor_down() {
    let mut h = Harness::start(Options {
        broken_stderr: true,
        ..Options::default()
    });
    // 綁錯 thread：監督行程自己印一行再殺掉它，那一行寫到 EPIPE。
    assert_eq!(h.down("a,wrong-bound"), DeathCause::Crash);
    h.up("b");
    assert!(h.child.try_wait().unwrap().is_none(), "監督行程不該結束");
}

fn audit_number(line: &str, key: &str) -> u64 {
    line.split(&format!("\"{key}\":"))
        .nth(1)
        .unwrap()
        .split([',', '}'])
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

#[test]
fn reports_stopping_after_bind_is_stalled() {
    // RSS 輪詢放到一分鐘：只有 stall 的期限會叫醒 poll。兩段寬限各 5 s：走拆除梯度的話 down 要 10 s 後才到。
    let mut h = Harness::start(Options {
        extra: vec![
            "--stall-ms",
            "300",
            "--rss-poll-ms",
            "60000",
            "--eof-grace-ms",
            "5000",
            "--term-grace-ms",
            "5000",
        ],
        ..Options::default()
    });
    h.up("x,ignore-term,hang");
    let silent_since = Instant::now();
    assert_eq!(h.down_of("x,ignore-term,hang"), DeathCause::Stalled);
    assert!(
        silent_since.elapsed() < Duration::from_millis(2_000),
        "{:?}",
        silent_since.elapsed()
    );
    let line = h.audit_line("\"thread\":\"x,ignore-term,hang\"");
    assert!(line.contains("\"cause\":\"stalled\""), "{line}");
    assert!(audit_number(&line, "max_silence_ms") < 300, "{line}");
}

#[test]
fn a_silence_shorter_than_the_limit_is_not_stalled() {
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "1500"],
        ..Options::default()
    });
    let socket = h.up("q,silent:600");
    // 沉默過去之後還是同一個行程。
    assert!(wait_until(|| log(&socket).len() >= 2));
    std::thread::sleep(Duration::from_millis(1_200));
    assert_eq!(h.up("q,silent:600"), socket);
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.down_of("q,silent:600"), DeathCause::Shutdown);
    let silence = audit_number(
        &h.audit_line("\"thread\":\"q,silent:600\""),
        "max_silence_ms",
    );
    assert!((600..1500).contains(&silence), "{silence}");
}

/// 行程狀態那一欄（`R`、`S`、`T`、`Z`…）；行程不在了回 `None`。
fn state(pid: i32) -> Option<char> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(") ")?.1.chars().next()
}

/// 壓制的參數：沉默 300 ms 起判，每一輪跑 25 ms、停 `stop_ms`；schedstat 每 50 ms 取樣。
fn throttle(stop_ms: &'static str) -> Vec<&'static str> {
    vec![
        "--throttle-ms",
        "300",
        "--throttle-run-ms",
        "25",
        "--throttle-stop-ms",
        stop_ms,
        "--rss-poll-ms",
        "50",
    ]
}

#[test]
fn a_silent_spinning_leader_is_held_until_it_speaks_again() {
    let mut h = Harness::start(Options {
        extra: throttle("75"),
        ..Options::default()
    });
    let socket = h.up("s,spin:2000");
    let pid = logged_pid(&socket, "pid");
    assert!(
        wait_until(|| state(pid) == Some('T')),
        "空轉的 {pid} 一直沒被停住"
    );
    // 轉完、心跳回來就放開：之後不再停住，也還是同一個行程。
    assert!(
        wait_until(|| supervisor_stderr(&h).contains("不再壓它")),
        "{}",
        supervisor_stderr(&h)
    );
    std::thread::sleep(Duration::from_millis(300));
    assert_ne!(state(pid), Some('T'));
    assert_eq!(h.up("s,spin:2000"), socket);
}

#[test]
fn a_silent_sleeping_leader_is_not_held() {
    // execSync 那類：事件迴圈睡著等，不吃 CPU。
    let mut h = Harness::start(Options {
        extra: throttle("75"),
        ..Options::default()
    });
    let socket = h.up("q,silent:1500");
    let pid = logged_pid(&socket, "pid");
    let until = Instant::now() + Duration::from_millis(1_500);
    while Instant::now() < until {
        assert_ne!(state(pid), Some('T'));
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        !supervisor_stderr(&h).contains("開始壓住"),
        "{}",
        supervisor_stderr(&h)
    );
}

#[test]
fn while_held_stalled_only_counts_the_time_it_was_let_run() {
    // 沉默 300 ms 起壓、只放四分之一：要放它跑滿 1 s 才判 stalled，牆鐘約 300 + 700 × 4 ≈ 3.1 s。不壓的話 1 s 就殺。
    let mut extra = throttle("75");
    extra.extend(["--stall-ms", "1000"]);
    let mut h = Harness::start(Options {
        extra,
        ..Options::default()
    });
    h.up("x,spin:0");
    let silent_since = Instant::now();
    assert_eq!(h.down_of("x,spin:0"), DeathCause::Stalled);
    assert!(
        silent_since.elapsed() >= Duration::from_millis(2_000),
        "{:?}",
        silent_since.elapsed()
    );
}

#[test]
fn sigkilled_supervisor_while_holding_leaves_nothing_stopped() {
    // 停的那段拉到一分鐘：送 SIGKILL 時 leader 一定是停住的。
    let mut h = Harness::start(Options {
        extra: throttle("60000"),
        ..Options::default()
    });
    let socket = h.up("o,grandchild,spin:0");
    let (pid, grandchild) = (
        logged_pid(&socket, "pid"),
        logged_pid(&socket, "grandchild"),
    );
    assert!(wait_until(|| state(pid) == Some('T')));
    kill(h.pid(), libc::SIGKILL);
    h.wait_exit();
    assert!(wait_until(|| gone(pid)), "leader {pid} 還在");
    // 同群組的子行程不歸壓制管：沒被停住，留下來也是醒著的。
    let left = state(grandchild);
    kill(grandchild as u32, libc::SIGKILL);
    assert_ne!(left, Some('T'), "子行程 {grandchild} 停在 T");
}

#[test]
fn teardown_lets_a_held_leader_run_first() {
    // 停的那段一分鐘、SIGTERM 之後的寬限十分鐘：沒先 SIGCONT 的話，它收不到 SIGTERM，要等很久才被 SIGKILL。
    let mut h = Harness::start(Options {
        term_grace_ms: 600_000,
        extra: throttle("60000"),
        ..Options::default()
    });
    let socket = h.up("t,spin:0");
    let pid = logged_pid(&socket, "pid");
    assert!(wait_until(|| state(pid) == Some('T')));
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.down_of("t,spin:0"), DeathCause::Shutdown);
    assert!(
        log(&socket).contains(&"sigterm".to_string()),
        "{:?}",
        log(&socket)
    );
}

#[test]
fn drain_lets_a_held_leader_run_first() {
    // 開頭的 `idle:0` 讓 release 當場送 `drain`；空轉的它不會回答，但不能停在那裡。
    let mut h = Harness::start(Options {
        extra: throttle("60000"),
        ..Options::default()
    });
    let socket = h.up_read_only("d,idle:0,spin:0");
    let pid = logged_pid(&socket, "pid");
    assert!(wait_until(|| state(pid) == Some('T')));
    h.release("d,idle:0,spin:0");
    assert!(
        wait_until(|| state(pid) != Some('T')),
        "送了 drain，{pid} 還停著"
    );
}

#[test]
fn supervisor_blocked_on_its_own_stderr_does_not_stall_the_healthy_ones() {
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "300"],
        piped_stderr: true,
        ..Options::default()
    });
    let socket = h.up("a");
    // j 往 stderr 倒 1000 KiB，監督行程轉送時把測試沒在讀的那條管線寫滿，卡在寫上遠超過 300 ms。
    h.ensure("j,stderr-junk:1000");
    std::thread::sleep(Duration::from_millis(1_500));
    let mut stderr = h.stderr.take().unwrap();
    std::thread::spawn(move || std::io::copy(&mut stderr, &mut std::io::sink()));
    // a 的回報這段時間都在管線裡：醒來之後不能被判 stalled。
    h.ensure("a");
    loop {
        match h.event() {
            FrontEvent::Up {
                thread_id,
                socket: up,
            } if thread_id == b"a" => {
                assert_eq!(PathBuf::from(String::from_utf8(up).unwrap()), socket);
                break;
            }
            FrontEvent::Up { .. } => {}
            other => panic!("要 a 的 up，拿到 {other:?}"),
        }
    }
}

#[test]
fn a_whole_tree_frozen_past_the_limit_is_not_stalled() {
    // RSS 輪詢放到一分鐘：計時器只剩 stall 的期限與它的四分之一。
    // stall 取 2 秒：監督行程醒來把沉默歸零之後，到 a 恢復並送出第一次心跳之前，這段延遲要短於 stall。
    // 它含測試執行緒送出 SIGCONT 與 a 被排到的時間，忙的機器上可以到幾百毫秒。
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "2000", "--rss-poll-ms", "60000"],
        ..Options::default()
    });
    let socket = h.up("a");
    let a = logged_pid(&socket, "pid");
    kill(h.pid(), libc::SIGSTOP);
    // SAFETY：只送訊號，對 a 的群組。
    unsafe { libc::kill(-a, libc::SIGSTOP) };
    // 只比 N 多一點：監督行程的 poll 不是最多等 N 的四分之一的話，准許等的時間會蓋掉大半的停頓，比准許的晚不到 N 的一半，認不出自己被停住過。
    std::thread::sleep(Duration::from_millis(2_300));
    // 監督行程先醒；等到它判定自己被停住過才放 a，醒來那一刻一定還沒有 a 的心跳，不靠固定的睡眠湊先後。
    // 這裡依賴監督行程 `check_resumed` 寫到 stderr 的那句「判定自己被停住過」（README 與 `src/supervisor/mod.rs` 的文件也用這個詞）；改了那句話，這裡的字串要一起改。
    kill(h.pid(), libc::SIGCONT);
    assert!(
        wait_until(|| supervisor_stderr(&h).contains("判定自己被停住過")),
        "{}",
        supervisor_stderr(&h)
    );
    // SAFETY：同上。
    unsafe { libc::kill(-a, libc::SIGCONT) };
    // 超過 stall：歸零沒做、或 a 的沉默沒有重新起算的話，這段時間裡就會被判 stalled。
    std::thread::sleep(Duration::from_millis(2_100));
    assert_eq!(h.up("a"), socket);
}

/// 監督行程沒停住過時，卡死的照樣在 stall 到期後不久被殺，而且不會把自己判成停住過（判了就會把沉默歸零，卡死的要多等）。
#[test]
fn a_stalled_one_is_killed_on_time_without_the_supervisor_judging_itself_stopped() {
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "2000", "--rss-poll-ms", "60000"],
        ..Options::default()
    });
    h.up("x,hang");
    let silent_since = Instant::now();
    assert_eq!(h.down_of("x,hang"), DeathCause::Stalled);
    // 上界留給忙的機器；有沒有把沉默歸零過，靠下一條斷言分辨。stall 取 2 秒：門檻是它的一半，忙的機器上一輪的處理不會花到 1 秒。
    assert!(
        silent_since.elapsed() < Duration::from_millis(3_500),
        "{:?}",
        silent_since.elapsed()
    );
    assert!(
        !supervisor_stderr(&h).contains("判定自己被停住過"),
        "{}",
        supervisor_stderr(&h)
    );
}

/// 整棵樹凍過上限，而監督行程停下來的那一刻不在 poll 裡：停在 `hook` 指的位置（`test-hooks`，見 `src/supervisor/mod.rs` 的 `test_stop`）。
fn freeze_with_the_supervisor_stopped_at(hook: &'static str) {
    let marker = temp_dir("stop").join("now");
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "2000", "--rss-poll-ms", "60000"],
        env: vec![(hook, marker.clone())],
        ..Options::default()
    });
    let socket = h.up("a");
    let a = logged_pid(&socket, "pid");
    // 先停 a：監督行程停下來時，管線裡幾乎不會留著它還沒讀的心跳（只剩寫 marker 時它正好在處理事件的那個窗口）。a 不出聲之後監督行程最晚 stall 的四分之一醒一次，那一輪走到 hook 就停。
    // SAFETY：只送訊號，對 a 的群組。
    unsafe { libc::kill(-a, libc::SIGSTOP) };
    std::fs::write(&marker, b"").unwrap();
    assert!(
        wait_until(|| state(h.pid() as i32) == Some('T')),
        "{}",
        supervisor_stderr(&h)
    );
    std::thread::sleep(Duration::from_millis(2_300));
    kill(h.pid(), libc::SIGCONT);
    assert!(
        wait_until(|| supervisor_stderr(&h).contains("判定自己被停住過")),
        "{}",
        supervisor_stderr(&h)
    );
    // SAFETY：同上。
    unsafe { libc::kill(-a, libc::SIGCONT) };
    // 超過 stall：a 的沉默沒有重新起算的話，這段時間裡就會被判 stalled。
    std::thread::sleep(Duration::from_millis(2_100));
    assert_eq!(h.up("a"), socket);
}

#[test]
fn a_freeze_that_starts_while_handling_events_is_not_stalled() {
    freeze_with_the_supervisor_stopped_at("NEXUS_SUPERVISOR_TEST_STOP_AFTER_EVENTS");
}

#[test]
fn a_freeze_that_starts_before_the_poll_is_not_stalled() {
    freeze_with_the_supervisor_stopped_at("NEXUS_SUPERVISOR_TEST_STOP_BEFORE_POLL");
}

#[test]
fn stalled_counts_from_ready_not_from_spawn() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-after-ms".into(), "800".into()],
        extra: vec!["--stall-ms", "300"],
        ..Options::default()
    });
    let socket = h.up("r");
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(h.up("r"), socket);
}

#[test]
fn silence_during_the_teardown_ladder_is_not_cut_short_as_stalled() {
    let mut h = Harness::start(Options {
        eof_grace_ms: 1_000,
        term_grace_ms: 1_000,
        extra: vec!["--stall-ms", "300"],
        ..Options::default()
    });
    // 收到 EOF 之後心跳就停，要等到 SIGTERM 那一步才結束。
    let socket = h.up("e,ignore-eof");
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.down_of("e,ignore-eof"), DeathCause::Shutdown);
    assert!(
        log(&socket).iter().any(|line| line == "sigterm"),
        "{:?}",
        log(&socket)
    );
}

fn capacity(thread: &str, current: u32, limit: u32) -> FrontEvent {
    FrontEvent::Capacity {
        thread_id: thread.as_bytes().to_vec(),
        current,
        limit,
    }
}

/// `drain` 記在 `eof` 之前。只驗順序：寬限只有幾百毫秒，忙的機器上 `eof` 之後還可能多一行 `sigterm`。
fn drain_then_eof(socket: &Path) -> bool {
    let lines = log(socket);
    let at = |name: &str| lines.iter().position(|line| line == name);
    matches!((at("drain"), at("eof")), (Some(drain), Some(eof)) if drain < eof)
}

/// 等到 `socket` 的假對話行程記下 `drain`。
fn saw_drain(socket: &Path) -> bool {
    wait_until(|| log(socket).iter().any(|line| line == "drain"))
}

#[test]
fn full_with_nothing_idle_answers_capacity() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "1"],
        ..Options::default()
    });
    let a = h.up("a");
    h.ensure("b");
    assert_eq!(h.event(), capacity("b", 1, 1));
    assert_eq!(h.up("a"), a);
    assert!(
        !log(&a).contains(&"drain".to_string()),
        "不閒置的不送 drain"
    );
}

#[test]
fn full_evicts_the_longest_idle_and_then_starts_the_waiting_thread() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "2"],
        ..Options::default()
    });
    let old = h.up("old,idle:5000");
    let new = h.up("new,idle:1000");
    h.ensure("c");
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: b"old,idle:5000".to_vec(),
            cause: DeathCause::Evicted
        }
    );
    match h.event() {
        FrontEvent::Up { thread_id, .. } => assert_eq!(thread_id, b"c"),
        other => panic!("要 c 的 up，拿到 {other:?}"),
    }
    assert!(drain_then_eof(&old), "{:?}", log(&old));
    assert_eq!(h.up("new,idle:1000"), new);
    assert!(h
        .audit_line("old,idle:5000")
        .contains("\"cause\":\"evicted\""));
}

#[test]
fn the_one_idle_longest_goes_first_not_the_one_started_first() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "2"],
        ..Options::default()
    });
    let early = h.up("early,wait-go,idle:0");
    let late = h.up("late,idle:0");
    assert!(wait_until(|| log(&late).contains(&"idle".to_string())));
    // 先起的那條比較晚才變閒置。
    std::thread::sleep(Duration::from_millis(200));
    std::fs::write(format!("{}.go", early.display()), b"").unwrap();
    assert!(wait_until(|| log(&early).contains(&"idle".to_string())));
    h.ensure("c");
    assert_eq!(h.down_of("late,idle:0"), DeathCause::Evicted);
    assert_eq!(h.up("early,wait-go,idle:0"), early);
}

#[test]
fn read_only_is_evicted_before_a_longer_idle_run() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "2"],
        ..Options::default()
    });
    let run = h.up("run,idle:60000");
    h.up_read_only("ro,idle:10");
    h.ensure("c");
    assert_eq!(h.down_of("ro,idle:10"), DeathCause::Evicted);
    assert_eq!(h.up("run,idle:60000"), run);
}

#[test]
fn ensure_hitting_an_idle_conversation_moves_it_to_the_back_of_the_queue() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "2"],
        ..Options::default()
    });
    h.up("a,idle:5000");
    h.up("b,idle:1000");
    // 剛被要過的 a 不再是閒置最久的。
    h.up("a,idle:5000");
    h.ensure("c");
    assert_eq!(h.down_of("b,idle:1000"), DeathCause::Evicted);
}

#[test]
fn busy_answer_to_drain_keeps_it_and_answers_capacity() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "1"],
        ..Options::default()
    });
    let a = h.up("a,idle:1000,busy-on-drain");
    h.ensure("b");
    assert_eq!(h.event(), capacity("b", 1, 1));
    assert!(log(&a).contains(&"drain".to_string()));
    assert_eq!(h.up("a,idle:1000,busy-on-drain"), a);
}

#[test]
fn unanswered_drain_times_out_as_not_idle() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "1", "--drain-timeout-ms", "300"],
        ..Options::default()
    });
    let a = h.up("a,idle:1000,ignore-drain");
    h.ensure("b");
    assert_eq!(h.event(), capacity("b", 1, 1));
    assert!(saw_drain(&a));
    assert_eq!(h.up("a,idle:1000,ignore-drain"), a);
    assert!(
        supervisor_stderr(&h).contains("沒回答 drain"),
        "{}",
        supervisor_stderr(&h)
    );
}

#[test]
fn ensure_while_waiting_for_the_drain_answer_gets_up_when_it_stays() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "1", "--drain-timeout-ms", "500"],
        ..Options::default()
    });
    let a = h.up("a,idle:1000,ignore-drain");
    h.ensure("b");
    assert!(saw_drain(&a));
    h.ensure("a,idle:1000,ignore-drain");
    let mut events = [h.event(), h.event()];
    events.sort_by_key(|e| matches!(e, FrontEvent::Capacity { .. }));
    assert_eq!(
        events[0],
        FrontEvent::Up {
            thread_id: b"a,idle:1000,ignore-drain".to_vec(),
            socket: a.to_str().unwrap().as_bytes().to_vec()
        }
    );
    assert_eq!(events[1], capacity("b", 1, 1));
}

#[test]
fn idle_past_the_limit_is_evicted() {
    let mut h = Harness::start(Options {
        extra: vec!["--idle-ms", "300"],
        ..Options::default()
    });
    let socket = h.up("a,idle:0");
    assert_eq!(h.down_of("a,idle:0"), DeathCause::Evicted);
    assert!(drain_then_eof(&socket), "{:?}", log(&socket));
}

#[test]
fn read_only_uses_the_short_idle_limit_until_it_runs_a_turn() {
    let mut h = Harness::start(Options {
        extra: vec!["--idle-ms", "0", "--read-only-idle-ms", "400"],
        ..Options::default()
    });
    let run = h.up("run,idle:0");
    let turned = h.up_read_only("turned,turn,idle:0");
    let asked = h.up_read_only("asked,idle:0");
    h.up("asked,idle:0");
    // 最後開的只讀那條先被逐出，比它早開的兩條就都已經不照只讀算了。
    h.up_read_only("ro,idle:0");
    assert_eq!(h.down_of("ro,idle:0"), DeathCause::Evicted);
    assert_eq!(h.up("run,idle:0"), run);
    assert_eq!(h.up("turned,turn,idle:0"), turned);
    assert_eq!(h.up("asked,idle:0"), asked);
}

#[test]
fn release_drains_now_if_idle_or_once_it_becomes_idle() {
    let mut h = Harness::start(Options::default());
    h.up_read_only("a,idle:0");
    h.release("a,idle:0");
    assert_eq!(h.down_of("a,idle:0"), DeathCause::Evicted);
    let b = h.up_read_only("b,wait-go,idle:0");
    h.release("b,wait-go,idle:0");
    std::thread::sleep(Duration::from_millis(200));
    assert!(
        !log(&b).contains(&"drain".to_string()),
        "還沒閒置不送 drain"
    );
    std::fs::write(format!("{}.go", b.display()), b"").unwrap();
    assert_eq!(h.down_of("b,wait-go,idle:0"), DeathCause::Evicted);
}

#[test]
fn release_leaves_one_turned_into_a_run_to_the_idle_limit() {
    let mut h = Harness::start(Options {
        extra: vec!["--idle-ms", "1500"],
        ..Options::default()
    });
    let turned = h.up_read_only("turned,turn,idle:0");
    // release 走前台的 fd、`turn(begin)` 走對話行程的管線，兩邊沒有先後保證：等它送完後面的 `idle`，再留一點時間讓監督行程讀到。沒讀到就送 release，走的是記著再作廢那條，
    // 這支就不再釘住「轉成一般的不理」。
    assert!(wait_until(|| log(&turned).contains(&"idle".to_string())));
    std::thread::sleep(Duration::from_millis(200));
    h.release("turned,turn,idle:0");
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        !log(&turned).contains(&"drain".to_string()),
        "轉成一般的，release 不收"
    );
    assert_eq!(h.down_of("turned,turn,idle:0"), DeathCause::Evicted);
}

#[test]
fn release_before_a_turn_is_dropped_once_it_turns_into_a_run() {
    let mut h = Harness::start(Options::default());
    let socket = h.up_read_only("late,wait-go,turn,idle:0");
    h.release("late,wait-go,turn,idle:0");
    // 等監督行程讀到 release 才放它跑：release 要早於 `turn(begin)`，否則走的是不理那條，這支就不再釘住 `turn(begin)` 清掉記著的 release。
    std::thread::sleep(Duration::from_millis(200));
    std::fs::write(format!("{}.go", socket.display()), b"").unwrap();
    assert!(wait_until(|| log(&socket).contains(&"idle".to_string())));
    std::thread::sleep(Duration::from_millis(500));
    assert!(
        !log(&socket).contains(&"drain".to_string()),
        "只讀時記著的 release，轉成一般之後作廢"
    );
}

#[test]
fn warm_pool_is_ready_before_ensure_and_refilled() {
    let mut h = Harness::start(Options {
        extra: vec!["--warm", "1", "--stall-ms", "300"],
        ..Options::default()
    });
    let first = h.dir.join("run/c1.sock");
    assert!(wait_until(|| log(&first).len() == 1), "預熱的行程沒起來");
    // 預熱池裡的還沒綁、不送心跳，超過 stall 也不能被殺。
    std::thread::sleep(Duration::from_millis(900));
    assert_eq!(h.up("a"), first);
    assert_eq!(log(&first)[1], "bind a");
    let second = h.dir.join("run/c2.sock");
    assert!(wait_until(|| log(&second).len() == 1), "預熱池沒補");
    assert!(h.audit().is_empty(), "{:?}", h.audit());
}

#[test]
fn warm_pool_counts_against_capacity() {
    let mut h = Harness::start(Options {
        extra: vec!["--warm", "1", "--capacity", "2"],
        ..Options::default()
    });
    assert!(wait_until(|| log(&h.dir.join("run/c1.sock")).len() == 1));
    h.up("a");
    assert!(wait_until(|| log(&h.dir.join("run/c2.sock")).len() == 1));
    h.up("b");
    h.ensure("c");
    assert_eq!(h.event(), capacity("c", 2, 2));
    assert!(!h.dir.join("run/c3.sock.log").exists(), "滿了不補預熱池");
}

#[test]
fn a_crashing_warm_pool_backs_off() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--die-before-ready".into()],
        extra: vec!["--warm", "1"],
        ..Options::default()
    });
    std::thread::sleep(Duration::from_millis(1_000));
    let audited = h.audit().len();
    // `--front-restart-ms 100`、每次失敗加倍：一秒內約 0、100、300、700 毫秒各一次，四行。沒有退避的話是十行上下，上界 6 要每輪多花 65 毫秒以上才漏得掉；
    // 機器慢只會讓行數變少，下界不動。
    eprintln!("[預熱池退避] 一秒內稽核 {audited} 行");
    assert!((2..=6).contains(&audited), "{audited} 行");
    assert!(h.audit()[0].contains("\"thread\":\"\""), "{:?}", h.audit());
    h.ensure("x");
    assert_eq!(h.down_of("x"), DeathCause::Crash);
}

/// 量測（#2815）：一條 thread 的行程每次都在 `ready` 之前死，前台緊密地要、等 `down`、再要，跑 2 秒；只印、斷言只放很鬆的下界。
/// 印的是 2 秒內收到幾則 `down`、稽核多幾行；通過時 stderr 被收走，要看數字加 `-- --nocapture`。
fn measure_a_tight_loop(label: &str, options: Options) {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--die-before-ready".into()],
        ..options
    });
    let until = Instant::now() + Duration::from_secs(2);
    let mut downs = 0;
    while Instant::now() < until {
        h.ensure("a");
        assert_eq!(h.down_of("a"), DeathCause::Crash);
        downs += 1;
    }
    eprintln!(
        "[量測 M-緊 {label}] 2 秒內收到 {downs} 則 down，稽核 {} 行",
        h.audit().len()
    );
    assert!(downs >= 1);
}

#[test]
fn measure_a_tight_loop_on_a_crashing_thread() {
    measure_a_tight_loop("不成對", Options::default());
}

#[test]
fn measure_a_tight_loop_on_a_crashing_pair() {
    measure_a_tight_loop("成對", paired());
}

/// 量測（#2815）：一條 thread 的行程 `bound` 之後馬上結束（等於 `up` 之後立刻死），前台照估計的節奏（250–500 毫秒，取中間 375，沒有量過真的前台）
/// 要、等 `down`、睡、再要，跑 10 秒；只印、斷言只放很鬆的下界。印的是起了幾次 `up`、收到幾則 `down`、稽核幾行
/// （`down` 次數減 `up` 次數，是被閘回掉的加上起不來的）。
fn measure_a_web_paced_retry_loop(label: &str, options: Options) {
    let mut h = Harness::start(options);
    let until = Instant::now() + Duration::from_secs(10);
    let (mut ups, mut downs) = (0, 0);
    while Instant::now() < until {
        h.ensure("w,exit:7");
        loop {
            match h.event() {
                FrontEvent::Up { thread_id, .. } if thread_id == b"w,exit:7" => ups += 1,
                FrontEvent::Down { thread_id, .. } if thread_id == b"w,exit:7" => {
                    downs += 1;
                    break;
                }
                other => panic!("要 w,exit:7 的 up 或 down，拿到 {other:?}"),
            }
        }
        std::thread::sleep(Duration::from_millis(375));
    }
    eprintln!(
        "[量測 M-web {label}] 10 秒內 up {ups} 次、down {downs} 則，稽核 {} 行",
        h.audit().len()
    );
    assert!(downs >= 1);
}

#[test]
fn measure_a_web_paced_retry_loop_on_a_thread_that_dies_right_after_up() {
    measure_a_web_paced_retry_loop("100 毫秒", Options::default());
}

/// 同上，用出廠的 `--front-restart-ms 1000`（harness 預設 100 是為了讓要測重起的測試不用等）。
#[test]
fn measure_a_web_paced_retry_loop_with_the_shipped_restart_interval() {
    measure_a_web_paced_retry_loop(
        "1000 毫秒",
        Options {
            extra: vec!["--front-restart-ms", "1000"],
            ..Options::default()
        },
    );
}

/// 稽核裡不是 `backoff` 的行數：起行程、死亡的紀錄，被閘擋下的請求不會讓它增加。
fn audit_without_backoff(h: &Harness) -> usize {
    h.audit()
        .iter()
        .filter(|line| !line.contains("\"event\":\"backoff\""))
        .count()
}

/// 成對時 `down` 比組合行程的死亡紀錄早到：等行數兩次讀都一樣（隔 200 毫秒）才算數。
fn settled_audit_lines(h: &Harness) -> usize {
    let mut last = audit_without_backoff(h);
    loop {
        std::thread::sleep(Duration::from_millis(200));
        let now = audit_without_backoff(h);
        if now == last {
            return now;
        }
        last = now;
    }
}

fn backoff_lines(h: &Harness) -> Vec<String> {
    h.audit()
        .into_iter()
        .filter(|line| line.contains("\"event\":\"backoff\""))
        .collect()
}

/// 一條 thread 的行程每次都在 `ready` 之前死（#2815）：第一次失敗不等，第二次起連續失敗開窗；窗內的 `ensure` 當場回 `down`、
/// 不起行程（稽核沒有新的行程紀錄、只有一行 `backoff`）；窗過了才又起。
fn assert_a_failing_thread_is_turned_away_within_the_window(options: Options) {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--die-before-ready".into()],
        extra: vec!["--front-restart-ms", "1500"],
        ..options
    });
    h.ensure("a");
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    h.ensure("a");
    assert_eq!(h.down_of("a"), DeathCause::Crash, "第二次照樣去起");
    let started = settled_audit_lines(&h);
    assert!(backoff_lines(&h).is_empty());

    for _ in 0..3 {
        h.ensure("a");
        assert_eq!(h.down_of("a"), DeathCause::Crash);
    }
    assert_eq!(settled_audit_lines(&h), started, "窗內沒有起行程");
    let lines = backoff_lines(&h);
    assert_eq!(lines.len(), 1, "每個窗一行：{lines:?}");
    assert!(
        lines[0].contains("\"thread\":\"a\"")
            && lines[0].contains("\"cause\":\"crash\"")
            && lines[0].contains("\"failures\":2")
            && lines[0].contains("\"wait_ms\":1500"),
        "{lines:?}"
    );

    std::thread::sleep(Duration::from_millis(1_600));
    h.ensure("a");
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    assert!(settled_audit_lines(&h) > started, "窗過了又起了行程");
}

#[test]
fn a_failing_thread_is_turned_away_within_the_window() {
    assert_a_failing_thread_is_turned_away_within_the_window(Options::default());
}

#[test]
fn a_failing_pair_is_turned_away_within_the_window() {
    assert_a_failing_thread_is_turned_away_within_the_window(paired());
}

/// 一條 thread 在窗裡，別條 thread 照常起、照常 `up`。
#[test]
fn a_thread_in_the_window_does_not_hold_back_the_others() {
    let mut h = Harness::start(Options {
        extra: vec!["--front-restart-ms", "1500"],
        ..Options::default()
    });
    for _ in 0..2 {
        h.ensure("x,exit:3");
        assert_eq!(h.down_of("x,exit:3"), DeathCause::Crash);
    }
    h.ensure("x,exit:3");
    assert_eq!(h.down_of("x,exit:3"), DeathCause::Crash);
    assert_eq!(backoff_lines(&h).len(), 1);

    h.up("ok");
    let started = settled_audit_lines(&h);
    h.ensure("x,exit:3");
    assert_eq!(h.down_of("x,exit:3"), DeathCause::Crash);
    assert_eq!(backoff_lines(&h).len(), 1, "同一個窗不再寫");
    assert_eq!(settled_audit_lines(&h), started, "被擋的沒有起行程");
}

#[test]
fn stats_counts_live_warm_rss_and_deaths() {
    let mut h = Harness::start(Options {
        extra: vec!["--warm", "1", "--stats-ms", "200"],
        ..Options::default()
    });
    h.ensure("a");
    h.ensure("x,exit:3");
    let deadline = Instant::now() + WAIT;
    loop {
        assert!(Instant::now() < deadline, "等不到預期的 stats");
        if let FrontEvent::Stats {
            live,
            warm,
            rss_kib,
            deaths,
        } = h.event()
        {
            if deaths[DeathCause::Crash as usize - 1] == 1 && live == 2 && warm == 1 && rss_kib > 0
            {
                return;
            }
        }
    }
}

#[test]
fn pending_threads_are_answered_with_shutdown() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "1", "--drain-timeout-ms", "60000"],
        ..Options::default()
    });
    let a = h.up("a,idle:1000,ignore-drain");
    h.ensure("b");
    assert!(saw_drain(&a));
    kill(h.pid(), libc::SIGTERM);
    let mut downs = vec![h.event(), h.event()];
    downs.sort_by_key(|e| format!("{e:?}"));
    assert_eq!(
        downs,
        [
            FrontEvent::Down {
                thread_id: b"a,idle:1000,ignore-drain".to_vec(),
                cause: DeathCause::Shutdown
            },
            FrontEvent::Down {
                thread_id: b"b".to_vec(),
                cause: DeathCause::Shutdown
            },
        ]
    );
}

#[test]
fn ensure_while_waiting_for_the_drain_answer_is_answered_when_it_drains() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "1"],
        ..Options::default()
    });
    let a = h.up("a,idle:1000,slow-drain:300");
    h.ensure("b");
    assert!(saw_drain(&a), "{:?} {}", log(&a), supervisor_stderr(&h));
    h.ensure("a,idle:1000,slow-drain:300");
    let mut events: Vec<String> = (0..3).map(|_| format!("{:?}", h.event())).collect();
    events.sort();
    let a_bytes = format!("{:?}", b"a,idle:1000,slow-drain:300".to_vec());
    // 名額給先排的 b；a 收掉之後要的新行程沒有名額，回 `capacity`，不會一直懸著。
    assert!(
        events[0].starts_with("Capacity") && events[0].contains(&a_bytes),
        "{events:?}"
    );
    assert!(
        events[1].starts_with("Down")
            && events[1].contains(&a_bytes)
            && events[1].contains("Evicted"),
        "{events:?}"
    );
    assert!(
        events[2].starts_with("Up") && events[2].contains(&format!("{:?}", b"b".to_vec())),
        "{events:?}"
    );
}

/// 名額 2：a 閒置、`release` 之後慢慢回答 `drain`；這段期間又要 a，然後另一條 b 結束了。
/// b 讓出的名額不能拿去給 a 起第二個行程：a 回答之前，a 要的仍是它自己那個。
fn ensure_while_waiting_for_the_drain_answer_and_another_ends(
    answer: &str,
) -> (Harness, PathBuf, String) {
    let thread = format!("a,idle:1000,slow-drain:800{answer}");
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "2"],
        ..Options::default()
    });
    let a = h.up_read_only(&thread);
    let b = h.up("b,wait-go,exit:3");
    h.release(&thread);
    assert!(saw_drain(&a));
    h.ensure(&thread);
    std::fs::write(format!("{}.go", b.display()), b"").unwrap();
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: b"b,wait-go,exit:3".to_vec(),
            cause: DeathCause::Crash
        }
    );
    (h, a, thread)
}

#[test]
fn a_thread_waiting_for_its_drain_answer_is_not_started_twice_when_it_stays() {
    let (mut h, a, thread) =
        ensure_while_waiting_for_the_drain_answer_and_another_ends(",busy-on-drain");
    assert_eq!(
        h.event(),
        FrontEvent::Up {
            thread_id: thread.as_bytes().to_vec(),
            socket: a.to_str().unwrap().as_bytes().to_vec()
        }
    );
    std::thread::sleep(Duration::from_millis(300));
    assert!(!h.dir.join("run/c3.sock.log").exists(), "a 起了第二個行程");
}

#[test]
fn a_thread_waiting_for_its_drain_answer_gets_a_new_one_only_after_it_is_down() {
    let (mut h, a, thread) = ensure_while_waiting_for_the_drain_answer_and_another_ends("");
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: thread.as_bytes().to_vec(),
            cause: DeathCause::Evicted
        }
    );
    match h.event() {
        FrontEvent::Up { thread_id, socket } => {
            assert_eq!(thread_id, thread.as_bytes());
            assert_ne!(socket, a.to_str().unwrap().as_bytes());
        }
        other => panic!("要 a 的新 up，拿到 {other:?}"),
    }
}

#[test]
fn ensure_run_while_waiting_for_the_drain_answer_opens_the_new_one_as_a_run() {
    // 只讀的照時限送 `drain`，一般的不照時間送：新行程有沒有被送 `drain`，就看出它是哪種開啟。
    let mut h = Harness::start(Options {
        extra: vec!["--idle-ms", "0", "--read-only-idle-ms", "300"],
        ..Options::default()
    });
    let thread = "a,idle:0,slow-drain:800";
    let old = h.up_read_only(thread);
    assert!(saw_drain(&old));
    h.ensure_open(thread, OpenMode::ReadOnly);
    h.ensure(thread);
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: thread.as_bytes().to_vec(),
            cause: DeathCause::Evicted
        }
    );
    let new = match h.event() {
        FrontEvent::Up { thread_id, socket } if thread_id == thread.as_bytes() => {
            PathBuf::from(String::from_utf8(socket).unwrap())
        }
        other => panic!("要 a 的新 up，拿到 {other:?}"),
    };
    assert_ne!(new, old);
    std::thread::sleep(Duration::from_millis(1_000));
    assert!(
        !log(&new).contains(&"drain".to_string()),
        "排著時要過 run，新行程照只讀收了"
    );
}

#[test]
fn ensure_run_while_the_drained_one_is_stopping_opens_the_new_one_as_a_run() {
    // `ignore-eof` 加長的 `--eof-grace-ms` 撐開「回了 `drained`、還在收」那段，`ensure(run)` 落在這段裡。
    let mut h = Harness::start(Options {
        eof_grace_ms: 1_500,
        extra: vec!["--idle-ms", "0", "--read-only-idle-ms", "300"],
        ..Options::default()
    });
    let thread = "a,idle:0,slow-drain:300,ignore-eof";
    let old = h.up_read_only(thread);
    assert!(saw_drain(&old));
    h.ensure_open(thread, OpenMode::ReadOnly);
    assert!(wait_until(|| log(&old).contains(&"eof".to_string())));
    h.ensure(thread);
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: thread.as_bytes().to_vec(),
            cause: DeathCause::Evicted
        }
    );
    let new = match h.event() {
        FrontEvent::Up { thread_id, socket } if thread_id == thread.as_bytes() => {
            PathBuf::from(String::from_utf8(socket).unwrap())
        }
        other => panic!("要 a 的新 up，拿到 {other:?}"),
    };
    assert_ne!(new, old);
    std::thread::sleep(Duration::from_millis(1_000));
    assert!(
        !log(&new).contains(&"drain".to_string()),
        "收的期間要過 run，新行程照只讀收了"
    );
}

#[test]
fn ensure_while_it_is_stopping_is_answered_by_a_single_new_one() {
    // `ignore-eof` 加長的 `--eof-grace-ms` 撐開「回了 `drained`、還在收」那段。這條沒在排，`ensure` 落在這段裡也要等到 `up`。
    let mut h = Harness::start(Options {
        eof_grace_ms: 1_500,
        extra: vec!["--idle-ms", "300"],
        ..Options::default()
    });
    let thread = "a,idle:0,ignore-eof";
    let old = h.up(thread);
    assert!(wait_until(|| log(&old).contains(&"eof".to_string())));
    h.ensure(thread);
    assert_eq!(
        h.event(),
        FrontEvent::Down {
            thread_id: thread.as_bytes().to_vec(),
            cause: DeathCause::Evicted
        }
    );
    match h.event() {
        FrontEvent::Up { thread_id, socket } if thread_id == thread.as_bytes() => {
            assert_ne!(socket, old.to_str().unwrap().as_bytes())
        }
        other => panic!("要 a 的新 up，拿到 {other:?}"),
    }
    std::thread::sleep(Duration::from_millis(300));
    assert!(
        !h.dir.join("run/c3.sock.log").exists(),
        "起了不只一個新行程"
    );
}

#[test]
fn ensure_while_it_is_stopping_is_answered_capacity_when_the_slot_went_to_another() {
    // 名額 2：a 一直不閒置；c 排著，x 被逐出讓名額給它。x 還在收時又要 x，讓出的名額只有一個，x 要回 `capacity`，不能一直懸著。
    let mut h = Harness::start(Options {
        eof_grace_ms: 1_500,
        extra: vec!["--capacity", "2"],
        ..Options::default()
    });
    h.up("a,wait-go");
    let x = h.up_read_only("x,idle:0,ignore-eof");
    h.ensure("c");
    assert!(wait_until(|| log(&x).contains(&"eof".to_string())));
    h.ensure("x,idle:0,ignore-eof");
    assert_eq!(h.event(), capacity("x,idle:0,ignore-eof", 2, 2));
}

#[test]
fn release_while_waiting_for_the_drain_answer_is_kept_after_busy() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "1"],
        ..Options::default()
    });
    let thread = "a,idle:1000,slow-drain:500,busy-then-idle";
    let a = h.up_read_only(thread);
    h.ensure("b");
    assert!(saw_drain(&a));
    h.release(thread);
    // 回 `busy`：b 沒有名額；接著回報閒置，記著的 `release` 這時送 `drain`，回 `drained` 收掉。
    assert_eq!(h.event(), capacity("b", 1, 1));
    assert_eq!(h.down_of(thread), DeathCause::Evicted);
}

#[test]
fn a_thread_waiting_for_its_drain_answer_is_not_answered_capacity() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "2"],
        ..Options::default()
    });
    let thread = "a,idle:1000,slow-drain:800,busy-on-drain";
    let a = h.up(thread);
    h.up("x");
    h.ensure("u");
    assert!(saw_drain(&a));
    h.ensure(thread);
    h.ensure("w");
    let mut events: Vec<FrontEvent> = (0..3).map(|_| h.event()).collect();
    events.sort_by_key(|e| format!("{e:?}"));
    // a 在等自己的回答，跟自己的行程互抵；名額只能讓排著的 u、w 回 `capacity`，回 `busy` 之後 a 回 `up`。
    assert_eq!(
        events,
        vec![
            capacity("u", 2, 2),
            capacity("w", 2, 2),
            FrontEvent::Up {
                thread_id: thread.as_bytes().to_vec(),
                socket: a.to_str().unwrap().as_bytes().to_vec()
            },
        ]
    );
}

#[test]
fn shutdown_answers_a_thread_waiting_for_its_drain_answer_once() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "2", "--drain-timeout-ms", "60000"],
        ..Options::default()
    });
    let thread = "a,idle:1000,ignore-drain";
    let a = h.up(thread);
    let x = h.up("x");
    h.ensure("b");
    assert!(saw_drain(&a));
    h.ensure(thread);
    // 前台的要求照順序處理：x 回了 `up`，前一個 `ensure` 就已經排進去了。
    assert_eq!(h.up("x"), x);
    kill(h.pid(), libc::SIGTERM);
    let mut events = Vec::new();
    while let Some(event) = h.next_event() {
        events.push(event);
    }
    events.sort_by_key(|e| format!("{e:?}"));
    assert_eq!(
        events,
        [
            FrontEvent::Down {
                thread_id: b"x".to_vec(),
                cause: DeathCause::Shutdown
            },
            FrontEvent::Down {
                thread_id: thread.as_bytes().to_vec(),
                cause: DeathCause::Shutdown
            },
            FrontEvent::Down {
                thread_id: b"b".to_vec(),
                cause: DeathCause::Shutdown
            },
        ]
    );
}

/// 停機時排著的那條 thread，自己原來的行程被逐出、還在收：它收完回的 `down(evicted)` 前台不當回答，所以停機當場回 `down(shutdown)`（#2799）。
/// `ignore-eof` 加長的 `--eof-grace-ms` 撐開「回了 `drained`、還在收」那段；`b` 的 `capacity` 回來就表示前面那則 `ensure(a)` 已經排進去了。
#[test]
fn shutdown_answers_a_thread_queued_behind_its_own_evicted_one() {
    let mut h = Harness::start(Options {
        eof_grace_ms: 2_000,
        extra: vec!["--idle-ms", "300", "--capacity", "1"],
        ..Options::default()
    });
    let thread = "a,idle:0,ignore-eof";
    let old = h.up(thread);
    assert!(wait_until(|| log(&old).contains(&"eof".to_string())));
    h.ensure(thread);
    h.ensure("b");
    assert_eq!(h.next_event(), Some(capacity("b", 1, 1)));
    kill(h.pid(), libc::SIGTERM);
    let mut events = Vec::new();
    while let Some(event) = h.next_event() {
        events.push(event);
    }
    // 先回答排著的，被逐出的那個收完才回它自己的 `down`。
    assert_eq!(
        events,
        [
            FrontEvent::Down {
                thread_id: thread.as_bytes().to_vec(),
                cause: DeathCause::Shutdown
            },
            FrontEvent::Down {
                thread_id: thread.as_bytes().to_vec(),
                cause: DeathCause::Evicted
            },
        ]
    );
}

/// 停機時排著的那條 thread，自己原來的行程還沒回答 `drain`；前台還沒回 `admission-stopped` 的這段它才回 `drained`。
/// 這時不算逐出：照停機的順序收，回的是 `down(shutdown)`，排著的那則 `ensure` 才有回答（#2799）。
/// 前台不回 `admission-stopped`，`--admission-timeout-ms` 把那段撐到 2.5 秒；`slow-drain:1000` 讓 `drained` 落在裡面；
/// `--drain-timeout-ms` 拉長，免得 `drain` 先逾時。
#[test]
fn a_drain_answered_during_shutdown_is_down_shutdown_not_evicted() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        extra: vec![
            "--capacity",
            "2",
            "--admission-timeout-ms",
            "2500",
            "--drain-timeout-ms",
            "60000",
        ],
        ..Options::default()
    });
    let thread = "a,idle:1000,slow-drain:1000";
    let a = h.up(thread);
    let x = h.up("x");
    h.ensure("b");
    assert!(saw_drain(&a));
    h.ensure(thread);
    // 前台的要求照順序處理：x 回了 `up`，前一個 `ensure` 就已經排進去了。
    assert_eq!(h.up("x"), x);
    kill(h.pid(), libc::SIGTERM);
    let mut events = Vec::new();
    while let Some(event) = h.next_event() {
        events.push(event);
    }
    let downs_of_a: Vec<_> = events
        .iter()
        .filter(
            |e| matches!(e, FrontEvent::Down { thread_id, .. } if thread_id == thread.as_bytes()),
        )
        .collect();
    assert_eq!(
        downs_of_a,
        [&FrontEvent::Down {
            thread_id: thread.as_bytes().to_vec(),
            cause: DeathCause::Shutdown
        }],
        "{events:?}"
    );
}

/// 過了閒置上限被送 `drain`、停機中才回 `drained`：不收，它還閒置著也不再送 `drain`（停機不送）；照停機收，回 `down(shutdown)`。
/// `slow-drain:800` 讓回答落在前台還沒回 `admission-stopped` 的那段；再被送 `drain` 的話，它的紀錄會多一行。
#[test]
fn a_drain_answered_during_shutdown_is_not_sent_again() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        extra: vec!["--idle-ms", "300", "--admission-timeout-ms", "2500"],
        ..Options::default()
    });
    let thread = "a,idle:0,slow-drain:800";
    let a = h.up(thread);
    assert!(saw_drain(&a));
    kill(h.pid(), libc::SIGTERM);
    let mut events = Vec::new();
    while let Some(event) = h.next_event() {
        events.push(event);
    }
    assert_eq!(
        events,
        [
            FrontEvent::StopAdmission,
            FrontEvent::Down {
                thread_id: thread.as_bytes().to_vec(),
                cause: DeathCause::Shutdown
            },
        ]
    );
    let drains = log(&a).iter().filter(|line| *line == "drain").count();
    assert_eq!(drains, 1, "{:?}", log(&a));
}

/// 停機不送 `drain`：前台還沒回 `admission-stopped` 的那段，`release` 一條閒置的、或先前 `release` 過的這時才回報閒置，都不送；
/// 兩條都照停機收。
#[test]
fn release_during_shutdown_sends_no_drain() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        extra: vec!["--admission-timeout-ms", "1500"],
        ..Options::default()
    });
    let late = "late,wait-go,idle:0";
    let b = h.up_read_only(late);
    h.release(late);
    let c = h.up_read_only("c,idle:0");
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.event(), FrontEvent::StopAdmission);
    h.release("c,idle:0");
    std::fs::write(format!("{}.go", b.display()), b"").unwrap();
    assert!(wait_until(|| log(&b).contains(&"idle".to_string())));
    let mut downs = Vec::new();
    while let Some(event) = h.next_event() {
        downs.push(event);
    }
    downs.sort_by_key(|e| format!("{e:?}"));
    assert_eq!(
        downs,
        [
            FrontEvent::Down {
                thread_id: late.as_bytes().to_vec(),
                cause: DeathCause::Shutdown
            },
            FrontEvent::Down {
                thread_id: b"c,idle:0".to_vec(),
                cause: DeathCause::Shutdown
            },
        ]
    );
    for socket in [&b, &c] {
        assert!(
            !log(socket).contains(&"drain".to_string()),
            "{:?}",
            log(socket)
        );
    }
}

/// 宿主在另一個 package，跟監督行程編進同一個 target 目錄。
fn host_bin() -> PathBuf {
    Path::new(SUPERVISOR).parent().unwrap().join("nexus-host")
}

fn children(pid: u32) -> Vec<u32> {
    std::fs::read_to_string(format!("/proc/{pid}/task/{pid}/children"))
        .unwrap_or_default()
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect()
}

fn proc_file(pid: u32, name: &str) -> Vec<u8> {
    std::fs::read(format!("/proc/{pid}/{name}")).unwrap_or_default()
}

fn fake_host(args: &[&str]) -> Option<(PathBuf, Vec<String>)> {
    Some((
        example("fake_host"),
        args.iter().map(|a| a.to_string()).collect(),
    ))
}

/// 真宿主：對話行程不等宿主 `ready` 就起，第一次連線可能早於宿主 bind，拿到 `host error 2`（ENOENT）；用它起宿主的測試，
/// 第一個連線都走 `host-retry`，不是在斷言第一次就連得上。
/// 重試的 15 秒要比 `WAIT`（20 秒）短：重試先放棄、把最後一次的回答寫進紀錄，`wait_until` 才看得到失敗的理由；改其中一個要看另一個。
fn real_host() -> Option<(PathBuf, Vec<String>)> {
    Some((host_bin(), Vec::new()))
}

/// 假宿主的紀錄（`examples/fake_host.rs`）。
fn host_log(h: &Harness) -> Vec<String> {
    raw_log(&h.dir.join("run/host.sock"))
}

fn host_lines(h: &Harness) -> Vec<String> {
    h.audit()
        .into_iter()
        .filter(|line| line.contains("\"role\":\"host\""))
        .collect()
}

fn running_host(h: &Harness) -> Option<u32> {
    children(h.pid())
        .into_iter()
        .find(|&pid| String::from_utf8_lossy(&proc_file(pid, "cmdline")).contains("nexus-host"))
}

/// 版本不符含上一版（`PROTOCOL_VERSION - 1`）：上一版的子行程照樣被擋下。版本對、沒宣告 loop 在自己這裡的也擋。
#[test]
fn a_conversation_whose_first_frame_is_not_a_matching_hello_is_down_protocol() {
    let previous = (PROTOCOL_VERSION - 1).to_string();
    for args in [
        ["--hello-version", "99"].as_slice(),
        ["--hello-version", &previous].as_slice(),
        ["--no-loop"].as_slice(),
        ["--skip-hello"].as_slice(),
    ] {
        let mut h = Harness::start(Options {
            conversation_args: args.iter().map(|a| a.to_string()).collect(),
            ..Options::default()
        });
        assert_eq!(h.down("a"), DeathCause::Protocol, "{args:?}");
        let line = h.audit_line("\"cause\":\"protocol\"");
        assert!(line.contains("\"thread\":\"a\""), "{line}");
    }
}

#[test]
fn a_front_whose_first_frame_is_not_a_matching_hello_stops_everything_with_3() {
    let wrong = [
        FrontRequest::Hello {
            version: PROTOCOL_VERSION + 1,
        },
        FrontRequest::Hello {
            version: PROTOCOL_VERSION - 1,
        },
        FrontRequest::Ensure {
            thread_id: b"a".to_vec(),
            open: OpenMode::Run,
        },
    ];
    for first in wrong {
        let mut h = Harness::start(Options {
            front_hello: None,
            ..Options::default()
        });
        h.request(&first);
        assert_eq!(h.wait_exit().code(), Some(3), "{first:?}");
    }
}

/// 假對話行程只照 `--host-socket` 連宿主，連得上就表示傳下去的路徑是宿主 bind 的那一個；沒給 `--host` 就不帶這個參數。
#[test]
fn conversations_get_the_socket_the_host_binds_only_when_there_is_a_host() {
    let mut h = Harness::start(Options {
        host: real_host(),
        ..Options::default()
    });
    let socket = h.up("a,host-retry:15000");
    assert!(
        wait_until(|| log(&socket).contains(&"host hello".to_string())),
        "{:?}",
        raw_log(&socket)
    );
    let mut h = Harness::start(Options::default());
    let socket = h.up("b,host-hello");
    assert!(
        wait_until(|| log(&socket).contains(&"host no-socket".to_string())),
        "{:?}",
        raw_log(&socket)
    );
}

/// token 只走控制通道：不在任何子行程的 argv 與環境變數，也不在稽核與監督行程的 stderr。
#[test]
fn the_token_travels_only_on_the_control_channel() {
    let mut h = Harness::start(Options {
        host: real_host(),
        ..Options::default()
    });
    let socket = h.up("a,host-retry:15000");
    assert!(
        wait_until(|| log(&socket).contains(&"host hello".to_string())),
        "{:?}",
        raw_log(&socket)
    );
    assert!(
        raw_log(&socket).contains(&"hello 32".to_string()),
        "對話行程收到的 token 要是 32 個字元"
    );
    let token = h.front_token.clone();
    assert_eq!(token.len(), 32);
    assert!(token.iter().all(u8::is_ascii_hexdigit));
    let contains = |haystack: &[u8]| haystack.windows(token.len()).any(|w| w == token.as_slice());
    let mut pids = vec![h.pid()];
    pids.extend(children(h.pid()));
    assert!(pids.len() >= 4, "監督行程、前台、宿主、對話行程：{pids:?}");
    for pid in pids {
        assert!(
            !contains(&proc_file(pid, "cmdline")),
            "pid {pid} 的 argv 有 token"
        );
        assert!(
            !contains(&proc_file(pid, "environ")),
            "pid {pid} 的環境變數有 token"
        );
    }
    assert!(!contains(
        &std::fs::read(h.dir.join("audit.jsonl")).unwrap_or_default()
    ));
    assert!(!contains(
        &std::fs::read(h.dir.join("supervisor.err")).unwrap_or_default()
    ));
}

/// 真的宿主：對話行程用監督行程給的 token 連得上；token 不對、框太大的被斷線、寫稽核、隔離到它結束，那個對話行程照跑。
#[test]
fn conversations_reach_the_host_and_violations_are_audited_and_quarantined() {
    let mut h = Harness::start(Options {
        host: real_host(),
        ..Options::default()
    });
    let a = h.up("a,host-retry:15000");
    assert!(
        wait_until(|| log(&a).contains(&"host hello".to_string())),
        "{:?}",
        log(&a)
    );

    let b = h.up("b,host-bad-token,host-hello");
    assert!(wait_until(|| log(&b).len() >= 4), "{:?}", log(&b));
    assert_eq!(
        log(&b)[2..],
        ["host rejected token 不對", "host rejected 沒有登記"]
    );
    let line = h.audit_line("token 不對");
    assert!(
        line.contains("\"event\":\"protocol\"") && line.contains("\"role\":\"conversation\""),
        "{line}"
    );
    assert!(
        line.contains("\"thread\":\"b,host-bad-token,host-hello\""),
        "{line}"
    );

    let g = h.up("g,host-garbage");
    assert!(
        wait_until(|| log(&g).contains(&"host rejected 框太大".to_string())),
        "{:?}",
        log(&g)
    );
    h.audit_line("框太大");

    assert!(!gone(logged_pid(&b, "pid")), "被隔離的對話行程照跑");
    assert!(
        host_lines(&h).is_empty(),
        "宿主不因為任何一條連線結束：{:?}",
        h.audit()
    );
    assert!(
        !supervisor_stderr(&h).contains("警告：宿主拒了"),
        "違規不記那行警告：{}",
        supervisor_stderr(&h)
    );
}

/// 被隔離的對話行程之後每一次被拒都再寫一行稽核，`role` 仍是 `conversation`，身分不再回來：新連線送壞框（`violation`）
/// 與再送 `hello`（`unregistered`）都一樣。它已經被隔離，所以不算「表還在路上」，不記那行警告。
#[test]
fn a_quarantined_conversation_is_audited_on_every_later_rejection() {
    let mut h = Harness::start(Options {
        host: real_host(),
        ..Options::default()
    });
    // b 的第一個動作就是被拒的連線，不能前面加重試；先起 a 連到宿主收下，再起 b，那時宿主一定 bind 了。
    let a = h.up("a,host-retry:15000");
    assert!(
        wait_until(|| log(&a).contains(&"host hello".to_string())),
        "{:?}",
        raw_log(&a)
    );
    let b = h.up("b,host-bad-token,host-garbage,host-hello");
    assert!(wait_until(|| log(&b).len() >= 5), "{:?}", log(&b));
    assert_eq!(
        log(&b)[2..],
        [
            "host rejected token 不對",
            "host rejected 框太大",
            "host rejected 沒有登記"
        ]
    );
    let pid = format!("\"pid\":{},", logged_pid(&b, "pid"));
    let lines = || {
        h.audit()
            .into_iter()
            .filter(|l| l.contains("\"event\":\"protocol\"") && l.contains(&pid))
            .collect::<Vec<_>>()
    };
    assert!(wait_until(|| lines().len() == 3), "{:?}", h.audit());
    for (line, reason) in lines().iter().zip(["token 不對", "框太大", "沒有登記"]) {
        assert!(
            line.contains("\"role\":\"conversation\"") && line.contains(reason),
            "{line} / {:?}",
            lines()
        );
    }
    assert!(
        !supervisor_stderr(&h).contains("警告：宿主拒了"),
        "{}",
        supervisor_stderr(&h)
    );
}

/// 不是我們起的行程連真的宿主：送 `hello` 報 `unregistered`（`host/examples/host_client.rs`：這支測試連不到 `nexus_host` 的編碼器）、
/// 送壞框報 `violation`（測試行程自己），監督行程兩種都寫稽核、`role` 記 `unknown`，不隔離任何人，也不記那行警告。
#[test]
fn a_connection_from_a_pid_that_is_not_ours_is_audited_as_unknown() {
    let mut h = Harness::start(Options {
        host: real_host(),
        ..Options::default()
    });
    let a = h.up("a,host-retry:15000,wait-go,host-hello");
    assert!(
        wait_until(|| log(&a).contains(&"host hello".to_string())),
        "{:?}",
        log(&a)
    );
    let socket = h.dir.join("run/host.sock");
    let client = Command::new(example("host_client"))
        .arg(&socket)
        .arg("0".repeat(32))
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let client_pid = client.id();
    let out = client.wait_with_output().unwrap();
    assert!(out.status.success(), "{out:?}");
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    stream.write_all(&frame(&[0xff])).unwrap();
    let mut rest = Vec::new();
    let _ = stream.read_to_end(&mut rest);
    let pids = [
        format!("\"pid\":{client_pid},"),
        format!("\"pid\":{},", std::process::id()),
    ];
    let lines = || {
        h.audit()
            .into_iter()
            .filter(|l| l.contains("\"event\":\"protocol\"") && pids.iter().any(|p| l.contains(p)))
            .collect::<Vec<_>>()
    };
    assert!(wait_until(|| lines().len() == 2), "{:?}", h.audit());
    assert!(
        lines().iter().all(|l| l.contains("\"role\":\"unknown\"")),
        "{:?}",
        lines()
    );
    assert!(lines()[0].contains("沒有登記"), "{:?}", lines());
    assert!(
        !supervisor_stderr(&h).contains("警告：宿主拒了"),
        "{}",
        supervisor_stderr(&h)
    );
    std::fs::write(format!("{}.go", a.display()), b"").unwrap();
    assert!(
        wait_until(|| log(&a).iter().filter(|l| *l == "host hello").count() == 2),
        "a 沒被波及，之後照樣連得上：{:?}",
        log(&a)
    );
    assert!(
        log(&a).iter().all(|l| !l.contains("rejected")),
        "{:?}",
        log(&a)
    );
}

/// 停機順序：前台停准入（等它回答）→ 對話行程 → 宿主 → 前台。
#[test]
fn shutdown_stops_admission_first_then_conversations_then_the_host_then_the_front() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        extra: vec!["--admission-timeout-ms", "20000"],
        host: fake_host(&[]),
        ..Options::default()
    });
    let a = h.up("a");
    assert!(
        wait_until(|| host_log(&h).iter().any(|l| l.ends_with(" conversation a"))),
        "{:?}",
        host_log(&h)
    );
    let a_pid = logged_pid(&a, "pid");
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.event(), FrontEvent::StopAdmission);
    // 前台還沒回答：對話行程與宿主都還不能收。
    std::thread::sleep(Duration::from_millis(500));
    assert!(!log(&a).contains(&"eof".to_string()), "{:?}", log(&a));
    assert!(!host_log(&h).contains(&"eof".to_string()));
    h.request(&FrontRequest::AdmissionStopped);
    assert_eq!(h.down_of("a"), DeathCause::Shutdown);
    assert_eq!(h.next_event(), None);
    assert!(h.wait_exit().success());

    let audit = h.audit();
    let at = |needle: &str| {
        audit
            .iter()
            .position(|line| line.contains(needle))
            .unwrap_or_else(|| panic!("{needle}：{audit:?}"))
    };
    assert!(at("\"cause\":\"shutdown\"") < at("\"role\":\"host\""));
    assert!(at("\"role\":\"host\"") < at("\"role\":\"front\""));
    let log = host_log(&h);
    let revoke = log
        .iter()
        .position(|l| *l == format!("revoke {a_pid}"))
        .unwrap_or_else(|| panic!("{log:?}"));
    assert!(
        revoke < log.iter().position(|l| l == "eof").unwrap(),
        "收對話行程時撤掉它，之後宿主才收：{log:?}"
    );
}

#[test]
fn the_admission_wait_is_bounded() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        extra: vec!["--admission-timeout-ms", "300"],
        ..Options::default()
    });
    h.up("a");
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.event(), FrontEvent::StopAdmission);
    assert_eq!(h.down_of("a"), DeathCause::Shutdown);
    assert!(h.wait_exit().success());
}

#[test]
fn a_host_that_keeps_failing_before_ready_stops_everything_with_4() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--exit-before-ready", "1"]),
        extra: vec!["--host-start-failures", "3"],
        // 整台很快就停：不寫前台，免得撞上已經關掉的連線。
        front_hello: None,
        ..Options::default()
    });
    assert_eq!(h.wait_exit().code(), Some(4));
    let hosts = host_lines(&h);
    assert_eq!(hosts.len(), 3, "{hosts:?}");
    assert!(
        hosts
            .iter()
            .all(|line| line.contains("\"ready\":false") && line.contains("\"exit_code\":1")),
        "{hosts:?}"
    );
}

#[test]
fn a_host_that_never_gets_ready_is_killed_and_counts_as_a_failure() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--no-ready"]),
        extra: vec![
            "--host-ready-timeout-ms",
            "200",
            "--host-start-failures",
            "2",
        ],
        front_hello: None,
        ..Options::default()
    });
    assert_eq!(h.wait_exit().code(), Some(4));
    let hosts = host_lines(&h);
    assert_eq!(hosts.len(), 2, "{hosts:?}");
    assert!(
        hosts.iter().all(|line| line.contains("ready 之前逾時")),
        "{hosts:?}"
    );
}

#[test]
fn a_host_with_the_wrong_version_stops_everything_with_3() {
    for version in ["99".to_string(), (PROTOCOL_VERSION - 1).to_string()] {
        let mut h = Harness::start(Options {
            host: fake_host(&["--version", &version]),
            front_hello: None,
            ..Options::default()
        });
        assert_eq!(h.wait_exit().code(), Some(3), "{version}");
        assert_eq!(host_lines(&h).len(), 1, "{version}：{:?}", h.audit());
    }
}

/// 設定錯每次重起都一樣：真的宿主讀到壞掉的 `--plugins` 回 4，監督行程不重起、不算失敗，整台以 5 停機。
#[test]
fn a_host_with_a_broken_plugin_list_stops_everything_with_5_without_restarting_it() {
    let list = temp_dir("plugins").join("host-plugins.json");
    std::fs::write(&list, r#"[{"name":"沒有這支"}]"#).unwrap();
    let mut h = Harness::start(Options {
        host: Some((
            host_bin(),
            vec!["--plugins".to_string(), list.display().to_string()],
        )),
        extra: vec!["--host-start-failures", "3"],
        front_hello: None,
        ..Options::default()
    });
    assert_eq!(h.wait_exit().code(), Some(5));
    let hosts = host_lines(&h);
    assert_eq!(hosts.len(), 1, "只起過一次：{hosts:?}");
    assert!(
        hosts[0].contains("\"exit_code\":4")
            && hosts[0].contains("宿主設定壞了：")
            && hosts[0].contains("沒有叫 沒有這支 的插件"),
        "{hosts:?}"
    );
    let stderr = supervisor_stderr(&h);
    assert!(
        stderr.contains("宿主設定壞了") && stderr.contains("沒有叫 沒有這支 的插件"),
        "{stderr}"
    );
}

/// 起一台帶 `--plugins` 的真宿主，先用好的清單讓它 `ready`、起一條對話連上它，再把清單換成壞的、殺掉宿主。
fn break_the_list_after_ready(start_failures: &'static str) -> (Harness, PathBuf, PathBuf, i32) {
    let list = temp_dir("plugins").join("host-plugins.json");
    std::fs::write(&list, r#"[{"name":"test-echo"}]"#).unwrap();
    let mut h = Harness::start(Options {
        host: Some((
            host_bin(),
            vec!["--plugins".to_string(), list.display().to_string()],
        )),
        extra: vec!["--host-start-failures", start_failures],
        ..Options::default()
    });
    // 第一個連線可能早於宿主 bind，見 `real_host`。
    let a = h.up("a,host-retry:15000");
    assert!(
        wait_until(|| log(&a).contains(&"host hello".to_string())),
        "{:?}",
        raw_log(&a)
    );
    let a_pid = logged_pid(&a, "pid");
    let host = running_host(&h).expect("宿主在跑");
    std::fs::write(&list, r#"[{"name":"沒有這支"}]"#).unwrap();
    kill(host, libc::SIGKILL);
    (h, list, a, a_pid)
}

/// 宿主 `ready` 過之後清單才壞：照退避重起，每次失敗稽核都寫設定壞了與原文，對話行程照跑、整台不停；改好清單，下一次重起就接上。
#[test]
fn a_list_that_breaks_after_ready_restarts_the_host_and_conversations_keep_running() {
    let (mut h, list, _a, a_pid) = break_the_list_after_ready("100");
    let broken = |h: &Harness| {
        host_lines(h)
            .into_iter()
            .filter(|l| l.contains("宿主設定壞了：") && l.contains("沒有叫 沒有這支 的插件"))
            .count()
    };
    assert!(wait_until(|| broken(&h) >= 2), "{:?}", host_lines(&h));
    let hosts = host_lines(&h);
    assert!(
        hosts[0].contains("\"ready\":true") && !hosts[0].contains("宿主設定壞了"),
        "被殺的那一個：{hosts:?}"
    );
    assert!(
        hosts[1..]
            .iter()
            .all(|l| l.contains("\"exit_code\":4") && l.contains("\"ready\":false")),
        "{hosts:?}"
    );
    assert!(
        h.child.try_wait().unwrap().is_none(),
        "ready 過之後設定壞了不停機"
    );
    assert!(!gone(a_pid), "宿主不在時對話行程照跑");
    assert!(
        supervisor_stderr(&h).contains("照退避重起"),
        "{}",
        supervisor_stderr(&h)
    );

    std::fs::write(&list, r#"[{"name":"test-echo"}]"#).unwrap();
    let b = h.up("b,host-retry:15000");
    assert!(
        wait_until(|| log(&b).contains(&"host hello".to_string())),
        "{:?}",
        raw_log(&b)
    );
    assert!(h.child.try_wait().unwrap().is_none());
}

/// ready 過之後重起時一直設定壞了：不算進連續失敗的次數，超過 `--host-start-failures` 也不停機，對話照常跑；改好清單，宿主又 ready。
#[test]
fn a_list_that_stays_broken_after_ready_never_counts_toward_the_failure_limit() {
    let (mut h, list, _a, a_pid) = break_the_list_after_ready("2");
    let broken = |h: &Harness| {
        host_lines(h)
            .into_iter()
            .filter(|l| l.contains("宿主設定壞了："))
            .count()
    };
    assert!(wait_until(|| broken(&h) >= 3), "{:?}", host_lines(&h));
    assert!(
        h.child.try_wait().unwrap().is_none(),
        "設定壞了不算失敗，到不了上限：{}",
        supervisor_stderr(&h)
    );
    assert!(!gone(a_pid), "宿主不在時對話行程照跑");
    std::fs::write(&list, r#"[{"name":"test-echo"}]"#).unwrap();
    let b = h.up("b,host-retry:15000");
    assert!(
        wait_until(|| log(&b).contains(&"host hello".to_string())),
        "{:?}",
        raw_log(&b)
    );
    assert!(h.child.try_wait().unwrap().is_none());
}

/// `ready` 之後死了只退避重起，不算進整台退出的計數（上限 1 也不會停機）；新的宿主拿到整張表，之後的身分照常增減。
/// 假宿主的紀錄切成一段一段：每個 `start <pid>` 開一段，裡面是那個宿主行程收到的身分表指令（`grant …`、`synced`、`revoke …`）。
fn host_segments(h: &Harness) -> Vec<Vec<String>> {
    let mut segments: Vec<Vec<String>> = Vec::new();
    for line in host_log(h) {
        if line.starts_with("start ") {
            segments.push(Vec::new());
        } else if let Some(segment) = segments.last_mut() {
            segment.push(line);
        }
    }
    segments
}

/// 身分表送完要有記號：表（前台的 `grant`）在 `synced` 前面，之後才登記的對話行程在後面，整段只有一筆 `synced`。
#[test]
fn the_table_is_followed_by_exactly_one_synced_and_later_grants_come_after_it() {
    let mut h = Harness::start(Options {
        host: fake_host(&[]),
        ..Options::default()
    });
    assert!(
        wait_until(|| host_log(&h).iter().any(|l| l == "synced")),
        "{:?}",
        host_log(&h)
    );
    h.up("a");
    assert!(
        wait_until(|| host_log(&h).iter().any(|l| l.ends_with(" conversation a"))),
        "{:?}",
        host_log(&h)
    );
    let segments = host_segments(&h);
    assert_eq!(segments.len(), 1, "{segments:?}");
    let segment = &segments[0];
    let synced: Vec<usize> = (0..segment.len())
        .filter(|&i| segment[i] == "synced")
        .collect();
    assert_eq!(synced.len(), 1, "{segment:?}");
    let at = synced[0];
    assert!(
        segment[..at]
            .iter()
            .any(|l| l.starts_with("grant ") && l.contains(" front")),
        "前台的 grant 在表裡，要在 synced 前面：{segment:?}"
    );
    let conversation = segment
        .iter()
        .position(|l| l.ends_with(" conversation a"))
        .unwrap();
    assert!(
        conversation > at,
        "ready 之後才起的對話行程在 synced 後面：{segment:?}"
    );
}

/// 宿主重起、而且表是空的（前台不在、沒有對話行程）：`synced` 照樣送，前面沒有任何 `grant`；不送的話宿主永遠不讀連線。
#[test]
fn a_restarted_host_with_an_empty_table_is_still_synced() {
    let mut h = Harness::start(Options {
        host: fake_host(&[]),
        extra: vec!["--front-restart-ms", "600000"],
        ..Options::default()
    });
    assert!(
        wait_until(|| host_log(&h).iter().any(|l| l == "synced")),
        "{:?}",
        host_log(&h)
    );
    h.front = None;
    h.audit_line("\"role\":\"front\"");
    let first = nth_logged(&h, "start", 0);
    kill(first as u32, libc::SIGKILL);
    assert!(
        wait_until(
            || host_segments(&h).len() == 2 && host_segments(&h)[1].iter().any(|l| l == "synced")
        ),
        "{:?}",
        host_log(&h)
    );
    assert_eq!(host_segments(&h)[1], vec!["synced"], "{:?}", host_log(&h));
}

#[test]
fn a_host_that_dies_after_ready_restarts_with_the_whole_table_and_never_stops_everything() {
    let marker = temp_dir("marker").join("crashed");
    let mut h = Harness::start(Options {
        host: fake_host(&["--crash-once", marker.to_str().unwrap()]),
        extra: vec!["--host-start-failures", "1"],
        ..Options::default()
    });
    let front_grant = |l: &String| l.starts_with("grant ") && l.contains(" front");
    assert!(
        wait_until(|| {
            let log = host_log(&h);
            let second = log
                .iter()
                .enumerate()
                .filter(|(_, l)| l.starts_with("start "))
                .nth(1)
                .map(|(i, _)| i);
            second.is_some_and(|i| log[i..].iter().any(front_grant))
        }),
        "{:?}",
        host_log(&h)
    );
    let a = h.up("a");
    assert!(
        wait_until(|| host_log(&h).iter().any(|l| l.ends_with(" conversation a"))),
        "{:?}",
        host_log(&h)
    );
    let b = h.up("b,exit:3");
    let b_pid = logged_pid(&b, "pid");
    assert_eq!(h.down_of("b,exit:3"), DeathCause::Crash);
    assert!(
        wait_until(|| host_log(&h).contains(&format!("revoke {b_pid}"))),
        "{:?}",
        host_log(&h)
    );
    assert!(
        h.child.try_wait().unwrap().is_none(),
        "ready 之後的失敗不讓整台結束"
    );
    let hosts = host_lines(&h);
    assert_eq!(hosts.len(), 1, "{hosts:?}");
    assert!(
        hosts[0].contains("\"ready\":true") && hosts[0].contains("\"exit_code\":9"),
        "{hosts:?}"
    );
    assert!(!gone(logged_pid(&a, "pid")));
}

/// 停機中再收到停止訊號：宿主與對話行程一起被 SIGKILL，之後收對話行程時不把寫端已關的宿主當成「收不下撤銷」而再殺一次。
#[test]
fn a_second_stop_signal_sends_no_revoke_to_the_host_it_just_killed() {
    let mut h = Harness::start(Options {
        eof_grace_ms: 600_000,
        term_grace_ms: 600_000,
        host: fake_host(&[]),
        ..Options::default()
    });
    let socket = h.up("t,ignore-term");
    let granted = |h: &Harness| {
        let log = host_log(h);
        let grants = log
            .iter()
            .filter(|l| l.ends_with(" conversation t,ignore-term"));
        grants.count()
    };
    assert!(wait_until(|| granted(&h) == 1), "{:?}", host_log(&h));
    kill(h.pid(), libc::SIGTERM);
    assert!(wait_until(|| log(&socket).contains(&"eof".to_string())));
    kill(h.pid(), libc::SIGINT);
    assert_eq!(h.down_of("t,ignore-term"), DeathCause::Shutdown);
    assert!(h.wait_exit().success());
    let err = std::fs::read(h.dir.join("supervisor.err")).unwrap();
    let err = String::from_utf8_lossy(&err);
    assert!(!err.contains("收不下撤銷"), "{err}");
}

/// 宿主收不下撤銷時殺掉它，同一輪收屍裡後面的身分不再往它送：只印一次「收不下撤銷」，之後宿主照退避重起。
#[test]
fn a_host_that_cannot_take_a_revoke_is_killed_once_per_reap_and_restarts() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--deaf-on", "b"]),
        extra: vec!["--host-backoff-ms", "100"],
        ..Options::default()
    });
    let a = logged_pid(&h.up("a"), "pid");
    let b = logged_pid(&h.up("b"), "pid");
    assert!(wait_until(|| host_log(&h).contains(&"deaf".to_string())));
    // 監督行程停著的時候讓兩個對話行程都成了殭屍，醒來之後同一輪收屍收到兩個身分。
    kill(h.pid(), libc::SIGSTOP);
    kill(a as u32, libc::SIGKILL);
    kill(b as u32, libc::SIGKILL);
    let died = wait_until(|| gone(a) && gone(b));
    kill(h.pid(), libc::SIGCONT);
    assert!(died);
    let mut downs = Vec::new();
    while downs.len() < 2 {
        if let FrontEvent::Down { thread_id, .. } = h.event() {
            downs.push(thread_id);
        }
    }
    downs.sort();
    assert_eq!(downs, [b"a".to_vec(), b"b".to_vec()]);
    let started = |h: &Harness| {
        host_log(h)
            .iter()
            .filter(|l| l.starts_with("start "))
            .count()
    };
    assert!(wait_until(|| started(&h) == 2), "{:?}", host_log(&h));
    let err = std::fs::read(h.dir.join("supervisor.err")).unwrap();
    let err = String::from_utf8_lossy(&err);
    assert_eq!(err.matches("收不下撤銷").count(), 1, "{err}");
}

/// 宿主對活著的對話行程回報 `unregistered`：那是它那一筆還沒寫進宿主的 pipe（宿主剛起來或剛重起、或還排在監督行程這邊），
/// 或撤銷之前就連上的連線（pid 被重用、上一個行程留下的，或重用得比宿主讀 pipe 快、新行程先連上的）。不隔離、不寫稽核，下一個宿主照樣拿到它；運作 log 記一行警告，只帶 pid 與宿主的連線編號。
#[test]
fn an_unregistered_report_for_a_live_conversation_neither_quarantines_nor_audits() {
    let marker = temp_dir("marker").join("unregistered");
    let mut h = Harness::start(Options {
        host: fake_host(&["--unregistered-once", marker.to_str().unwrap()]),
        ..Options::default()
    });
    let a = h.up("a");
    let a_pid = logged_pid(&a, "pid");
    assert!(
        wait_until(|| {
            let log = host_log(&h);
            let second = log
                .iter()
                .enumerate()
                .filter(|(_, l)| l.starts_with("start "))
                .nth(1)
                .map(|(i, _)| i);
            second.is_some_and(|i| log[i..].iter().any(|l| l.ends_with(" conversation a")))
        }),
        "{:?}",
        host_log(&h)
    );
    let expected = format!("[nexus-supervisor] 警告：宿主拒了 pid {a_pid} 的連線 #7：表還在路上，或是撤銷之前就連上的連線；不隔離、不寫稽核");
    assert!(
        wait_until(|| supervisor_stderr(&h).lines().any(|l| l == expected)),
        "{}",
        supervisor_stderr(&h)
    );
    assert_eq!(
        h.audit()
            .iter()
            .filter(|l| l.contains("\"event\":\"protocol\""))
            .count(),
        0,
        "{:?}",
        h.audit()
    );
}

/// 宿主對活著的對話行程回報 `violation`：監督行程寫稽核（`role` 是 `conversation`）、不殺它，並經控制通道對那個 pid 送 `revoke`；
/// 行程還活著，所以這筆撤銷來自隔離，不是收屍前那一筆。撤銷排在還沒寫出去的 `grant` 後面，靠的是同一條通道先進先出，這裡沒有造出 `grant` 還排著的情況。
#[test]
fn a_violation_revokes_the_live_identity_on_the_host() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--violate-conversations"]),
        ..Options::default()
    });
    let a = h.up("a");
    let a_pid = logged_pid(&a, "pid");
    assert!(
        wait_until(|| host_log(&h).contains(&format!("revoke {a_pid}"))),
        "{:?}",
        host_log(&h)
    );
    let line = h.audit_line("測試違規");
    assert!(line.contains("\"role\":\"conversation\""), "{line}");
    assert!(!gone(a_pid), "被隔離的對話行程照跑");
}

/// 收掉對話行程 a，再起一條 b、等 b 那一筆 `grant` 進宿主：pipe 照順序，這時 a 的 `revoke` 都已經進宿主的 log。回 a 的 `revoke` 筆數。
fn revokes_after_reaping(h: &mut Harness, a_pid: i32) -> usize {
    kill(a_pid as u32, libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    let b = h.up("b");
    let b_grant = format!("grant {} conversation b", logged_pid(&b, "pid"));
    assert!(
        wait_until(|| host_log(h).contains(&b_grant)),
        "{:?}",
        host_log(h)
    );
    let revoke = format!("revoke {a_pid}");
    host_log(h).iter().filter(|l| **l == revoke).count()
}

/// 已經隔離的對話行程又被報違規：再寫一行稽核，但不補送第二次 `revoke`：`revoke` 只有隔離那一次與收屍那一次。
#[test]
fn a_second_violation_for_a_quarantined_conversation_is_audited_but_not_revoked_again() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--violate-twice"]),
        ..Options::default()
    });
    let a = h.up("a");
    let a_pid = logged_pid(&a, "pid");
    let pid = format!("\"pid\":{a_pid},");
    let lines = || {
        h.audit()
            .into_iter()
            .filter(|l| l.contains("測試違規") && l.contains(&pid))
            .collect::<Vec<_>>()
    };
    assert!(wait_until(|| lines().len() == 2), "{:?}", h.audit());
    assert!(
        lines()
            .iter()
            .all(|l| l.contains("\"role\":\"conversation\"")),
        "{:?}",
        lines()
    );
    assert!(!gone(a_pid));
    assert_eq!(
        revokes_after_reaping(&mut h, a_pid),
        2,
        "{:?}",
        host_log(&h)
    );
}

/// 違規帶的序號不是現在那個行程的（同一個 pid 號碼上一個行程的回報，在號碼被重用之後才讀到）：只寫稽核、`role` 記 `unknown`，
/// 不隔離、不補送 `revoke`：`revoke` 只有收屍那一次。
#[test]
fn a_violation_with_a_stale_generation_neither_quarantines_nor_revokes() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--stale-generation"]),
        ..Options::default()
    });
    let a = h.up("a");
    let a_pid = logged_pid(&a, "pid");
    let pid = format!("\"pid\":{a_pid},");
    let lines = || {
        h.audit()
            .into_iter()
            .filter(|l| l.contains("舊序號的違規") && l.contains(&pid))
            .collect::<Vec<_>>()
    };
    assert!(wait_until(|| !lines().is_empty()), "{:?}", h.audit());
    assert!(
        lines().iter().all(|l| l.contains("\"role\":\"unknown\"")),
        "{:?}",
        lines()
    );
    assert_eq!(
        revokes_after_reaping(&mut h, a_pid),
        1,
        "{:?}",
        host_log(&h)
    );
}

/// 沒被隔離的對話行程被報序號 0 的違規：只寫稽核、`role` 記 `unknown`，不隔離、不補送 `revoke`。宿主在上一個行程收屍之前回報的 0，
/// 讀到時重用同一個 pid 的新行程正是這個狀態；那一筆還沒寫進宿主 pipe 的活行程，報的也是 0，同樣不隔離。
#[test]
fn a_zero_generation_violation_for_a_conversation_that_is_not_quarantined_is_only_audited() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--zero-generation"]),
        ..Options::default()
    });
    let a = h.up("a");
    let a_pid = logged_pid(&a, "pid");
    let pid = format!("\"pid\":{a_pid},");
    let lines = || {
        h.audit()
            .into_iter()
            .filter(|l| l.contains("\"event\":\"protocol\"") && l.contains(&pid))
            .collect::<Vec<_>>()
    };
    assert!(wait_until(|| !lines().is_empty()), "{:?}", h.audit());
    assert!(
        lines().iter().all(|l| l.contains("\"role\":\"unknown\"")),
        "{:?}",
        lines()
    );
    assert_eq!(
        revokes_after_reaping(&mut h, a_pid),
        1,
        "只有收屍那一次：{:?}",
        host_log(&h)
    );
}

/// 已經隔離的對話行程被報序號 0 的違規（撤銷之後宿主表上沒有它，還沒送 `hello` 的連線出事時就報 0）：照它的身分寫稽核，不補送第二次 `revoke`。
#[test]
fn a_zero_generation_violation_for_a_quarantined_conversation_keeps_its_role() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--then-zero-generation"]),
        ..Options::default()
    });
    let a = h.up("a");
    let a_pid = logged_pid(&a, "pid");
    let pid = format!("\"pid\":{a_pid},");
    let lines = || {
        h.audit()
            .into_iter()
            .filter(|l| l.contains("\"event\":\"protocol\"") && l.contains(&pid))
            .collect::<Vec<_>>()
    };
    assert!(wait_until(|| lines().len() == 2), "{:?}", h.audit());
    for (line, reason) in lines().iter().zip(["測試違規", "表上沒有了"]) {
        assert!(
            line.contains("\"role\":\"conversation\"") && line.contains(reason),
            "{line} / {:?}",
            lines()
        );
    }
    assert_eq!(
        revokes_after_reaping(&mut h, a_pid),
        2,
        "隔離一次、收屍一次：{:?}",
        host_log(&h)
    );
}

/// 已經隔離的對話行程被報 `unregistered`：照違規寫稽核，理由是宿主回給那條連線的，不是寫死的「沒有登記」；不記那行警告。
#[test]
fn an_unregistered_report_for_a_quarantined_conversation_is_audited_with_the_hosts_reason() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--then-unregistered", "框太大"]),
        ..Options::default()
    });
    let a = h.up("a");
    let a_pid = logged_pid(&a, "pid");
    let pid = format!("\"pid\":{a_pid},");
    let lines = || {
        h.audit()
            .into_iter()
            .filter(|l| l.contains("\"event\":\"protocol\"") && l.contains(&pid))
            .collect::<Vec<_>>()
    };
    assert!(wait_until(|| lines().len() == 2), "{:?}", h.audit());
    for (line, reason) in lines().iter().zip(["測試違規", "框太大"]) {
        assert!(
            line.contains("\"role\":\"conversation\"") && line.contains(reason),
            "{line} / {:?}",
            lines()
        );
    }
    assert!(
        !supervisor_stderr(&h).contains("警告：宿主拒了"),
        "{}",
        supervisor_stderr(&h)
    );
    assert_eq!(
        revokes_after_reaping(&mut h, a_pid),
        2,
        "隔離一次、收屍一次：{:?}",
        host_log(&h)
    );
}

/// 不是我們的 pid（這裡是 0：宿主讀不到連線的 pid，或對方 uid 跟它不同時報的）被報 `violation` 與 `unregistered`：兩筆都寫稽核、`role` 是 `unknown`，
/// 不送 `revoke`、不記那行警告。假宿主接著對 a 報違規，a 的 `revoke` 出現時，排在它前面的 pid 0 那兩筆早就處理完了。
#[test]
fn reports_for_a_pid_that_is_not_ours_send_no_revoke() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--report-strangers"]),
        ..Options::default()
    });
    let a = h.up("a");
    let revoke = format!("revoke {}", logged_pid(&a, "pid"));
    assert!(
        wait_until(|| host_log(&h).contains(&revoke)),
        "{:?}",
        host_log(&h)
    );
    assert!(
        !host_log(&h).contains(&"revoke 0".to_string()),
        "{:?}",
        host_log(&h)
    );
    let lines: Vec<String> = h
        .audit()
        .into_iter()
        .filter(|l| l.contains("\"event\":\"protocol\"") && l.contains("\"pid\":0,"))
        .collect();
    assert_eq!(lines.len(), 2, "{:?}", h.audit());
    assert!(
        lines.iter().all(|l| l.contains("\"role\":\"unknown\"")),
        "{lines:?}"
    );
    assert!(
        lines[0].contains("測試違規") && lines[1].contains("沒有登記"),
        "{lines:?}"
    );
    assert!(
        !supervisor_stderr(&h).contains("警告：宿主拒了"),
        "{}",
        supervisor_stderr(&h)
    );
}

/// 隔離到行程結束：宿主重起之後重送的表裡沒有它。之後才起的對話行程 c 那一筆排在整張表後面，它出現時表已經送完了。
#[test]
fn a_quarantined_conversation_is_left_out_of_the_table_sent_to_a_restarted_host() {
    let mut h = Harness::start(Options {
        host: fake_host(&["--violate-conversations"]),
        ..Options::default()
    });
    let a = h.up("a");
    let a_pid = logged_pid(&a, "pid");
    assert!(
        wait_until(|| host_log(&h).contains(&format!("revoke {a_pid}"))),
        "{:?}",
        host_log(&h)
    );
    let fake = children(h.pid())
        .into_iter()
        .find(|&pid| String::from_utf8_lossy(&proc_file(pid, "cmdline")).contains("fake_host"))
        .expect("假宿主");
    kill(fake, libc::SIGKILL);
    let after_restart = |h: &Harness| {
        let log = host_log(h);
        let second = log
            .iter()
            .enumerate()
            .filter(|(_, l)| l.starts_with("start "))
            .nth(1)
            .map(|(i, _)| i);
        second.map(|i| log[i..].to_vec()).unwrap_or_default()
    };
    assert!(
        wait_until(|| after_restart(&h)
            .iter()
            .any(|l| l.starts_with("grant ") && l.contains(" front"))),
        "{:?}",
        host_log(&h)
    );
    h.up("c");
    assert!(
        wait_until(|| after_restart(&h)
            .iter()
            .any(|l| l.ends_with(" conversation c"))),
        "{:?}",
        host_log(&h)
    );
    let regranted = format!("grant {a_pid} ");
    assert!(
        after_restart(&h).iter().all(|l| !l.starts_with(&regranted)),
        "{:?}",
        after_restart(&h)
    );
    assert!(!gone(a_pid), "被隔離的對話行程照跑");
}

/// 真的宿主被殺掉重起：對話行程用原本的 token 重連得上，因為監督行程把整張表重送給新的宿主。
#[test]
fn after_a_host_restart_conversations_reconnect_with_the_same_token() {
    let mut h = Harness::start(Options {
        host: real_host(),
        ..Options::default()
    });
    let a = h.up("a,wait-go,host-retry:15000");
    let mut old = None;
    assert!(wait_until(|| {
        old = running_host(&h);
        old.is_some()
    }));
    let old = old.unwrap();
    kill(old, libc::SIGKILL);
    h.audit_line("\"role\":\"host\"");
    std::fs::write(format!("{}.go", a.display()), b"").unwrap();
    assert!(
        wait_until(|| log(&a).contains(&"host hello".to_string())),
        "{:?}",
        log(&a)
    );
    assert!(running_host(&h).is_some_and(|pid| pid != old));
}

/// 稽核裡帶 `pair` 的行（一對裡每個行程結束各一行），照寫入的順序。
fn pair_audit(h: &Harness) -> Vec<String> {
    h.audit()
        .into_iter()
        .filter(|line| line.contains("\"pair\":"))
        .collect()
}

/// 一對（#2583）：真的 `nexus-composition`，葉子是 `fake_conversation --pair-socket`。
fn paired() -> Options {
    Options {
        composition: Some(
            Path::new(SUPERVISOR)
                .parent()
                .unwrap()
                .join("nexus-composition"),
        ),
        ..Options::default()
    }
}

/// 從 `up` 給的 socket（組合行程的）推出葉子自己的 socket；假葉子的紀錄在它旁邊。
fn leaf_socket(up: &Path) -> PathBuf {
    let name = up.to_str().unwrap().strip_suffix(".sock").unwrap();
    PathBuf::from(format!("{name}.l.sock"))
}

/// 假葉子的紀錄裡最後一個 `pid`：補起的葉子接著同一個檔寫。
fn last_leaf_pid(leaf: &Path) -> u32 {
    log(leaf)
        .iter()
        .rev()
        .find_map(|line| line.strip_prefix("pid "))
        .unwrap()
        .parse()
        .unwrap()
}

/// 收前台在這個 socket 上的組合行程。
fn composition_pid(h: &Harness, up: &Path) -> u32 {
    let wanted = up.to_str().unwrap().to_string();
    children(h.pid())
        .into_iter()
        .find(|&pid| {
            let cmdline = proc_file(pid, "cmdline");
            let mut args = cmdline.split(|b| *b == 0).map(String::from_utf8_lossy);
            args.next()
                .is_some_and(|program| program.ends_with("nexus-composition"))
                && args.any(|arg| arg == wanted)
        })
        .expect("找不到組合行程")
}

/// 經前台連的 socket 連進去，回葉子在那條連線上報的 pid；順便送一段，要原樣回來。
fn leaf_behind(up: &Path) -> u32 {
    let mut stream = UnixStream::connect(up).unwrap();
    stream.set_read_timeout(Some(WAIT)).unwrap();
    stream.write_all(b"ping").unwrap();
    let mut got = Vec::new();
    let mut buf = [0u8; 256];
    while !got.ends_with(b"ping") {
        let n = stream.read(&mut buf).unwrap();
        assert!(n > 0, "連線先關了：{:?}", String::from_utf8_lossy(&got));
        got.extend_from_slice(&buf[..n]);
    }
    let text = String::from_utf8(got).unwrap();
    let (pid, echoed) = text
        .strip_prefix("leaf ")
        .unwrap()
        .split_once('\n')
        .unwrap();
    assert_eq!(echoed, "ping");
    pid.parse().unwrap()
}

/// 停機，回這之後前台收到的每一則。
fn shut_down(h: &mut Harness) -> Vec<FrontEvent> {
    kill(h.pid(), libc::SIGTERM);
    let mut events = Vec::new();
    while let Some(event) = h.next_event() {
        events.push(event);
    }
    assert!(h.wait_exit().success());
    events
}

/// 起一對：`up` 的 socket 是組合行程的，經它連得到葉子、回得來；`bind` 是經橋到葉子的。
#[test]
fn a_pair_is_up_on_the_composition_socket_and_reaches_the_leaf() {
    let mut h = Harness::start(paired());
    let socket = h.up("a");
    assert_eq!(socket, h.dir.join("run/c1.sock"));
    let leaf = leaf_socket(&socket);
    // 葉子把 `bind` 排給主迴圈就回 `attach`，記那一行可能晚於 `up`。
    assert!(wait_until(|| log(&leaf)
        .get(1)
        .is_some_and(|line| line == "bind a")));
    assert_eq!(leaf_behind(&socket), last_leaf_pid(&leaf));
    // 已經 up 的再要一次：同一對。
    assert_eq!(h.up("a"), socket);
    assert!(pair_audit(&h).is_empty());
}

/// 組合行程的 `hello` 宣告 loop 在自己這裡（拿假對話行程當組合行程）：`protocol`，葉子不起。
#[test]
fn a_composition_that_claims_the_loop_is_down_protocol() {
    let mut h = Harness::start(Options {
        composition: Some(example("fake_conversation")),
        ..Options::default()
    });
    assert_eq!(h.down("a"), DeathCause::Protocol);
    let line = h.audit_line("\"role\":\"composition\"");
    assert!(
        line.contains("\"cause\":\"protocol\"") && line.contains("\"pair\":1"),
        "{line}"
    );
    assert_eq!(shut_down(&mut h), []);
    assert_eq!(pair_audit(&h).len(), 1, "{:?}", pair_audit(&h));
}

/// 葉子的 `hello` 沒宣告 loop：`protocol`，葉子先收、組合行程連帶收，`down` 只一次。
#[test]
fn a_leaf_that_does_not_claim_the_loop_takes_the_pair_down_protocol() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--no-loop".into()],
        ..paired()
    });
    assert_eq!(h.down("a"), DeathCause::Protocol);
    h.audit_line("\"role\":\"composition\"");
    assert_eq!(shut_down(&mut h), []);
    let audit = pair_audit(&h);
    assert_eq!(audit.len(), 2, "{audit:?}");
    assert!(
        audit[0].contains("\"role\":\"conversation\"")
            && audit[0].contains("\"cause\":\"protocol\"")
            && audit[0].contains("\"pair\":1"),
        "{audit:?}"
    );
    assert!(
        audit[1].contains("\"role\":\"composition\"")
            && audit[1].contains("\"cause\":\"peer\"")
            && audit[1].contains("\"pair\":1"),
        "{audit:?}"
    );
}

/// 成對時 `ready` 看組合行程的：葉子自己在控制通道送的 `ready` 不觸發 `bind`。葉子送完 `ready`、等測試放行才去橋上登記，
/// 所以它的 `ready` 寫在組合行程的之前；到收完為止葉子只收過一次 `bind`（經橋來的那一次）。
#[test]
fn a_leaf_ready_on_the_control_channel_does_not_bind() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-before-register".into()],
        ..paired()
    });
    h.ensure("a");
    let leaf = h.dir.join("run/c1.l.sock");
    assert!(wait_until(|| log(&leaf).contains(&"ready".to_string())));
    std::fs::write(format!("{}.go", leaf.display()), b"").unwrap();
    assert_eq!(h.up_of("a"), h.dir.join("run/c1.sock"));
    // 葉子把 `bind` 排給主迴圈就回 `attach`，記那一行可能晚於 `up`：等它收完再數。
    shut_down(&mut h);
    let binds = log(&leaf).iter().filter(|line| *line == "bind a").count();
    assert_eq!(binds, 1, "{:?}", log(&leaf));
}

/// 一對在等前台回 `admission-stopped` 的那一段被第二次停止訊號當場殺掉：組合行程與葉子的稽核都是 `shutdown`，這條 thread 只回一次 `down(shutdown)`（#2827）。
#[test]
fn a_second_stop_signal_before_the_front_answers_collects_a_pair_as_shutdown() {
    let mut h = Harness::start(Options {
        answer_stop_admission: false,
        extra: vec!["--admission-timeout-ms", "20000"],
        ..paired()
    });
    h.up("a");
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.event(), FrontEvent::StopAdmission);
    kill(h.pid(), libc::SIGINT);
    assert_eq!(h.down_of("a"), DeathCause::Shutdown);
    h.request(&FrontRequest::AdmissionStopped);
    assert_eq!(h.next_event(), None);
    assert!(h.wait_exit().success());
    let pair: Vec<String> = h
        .audit()
        .into_iter()
        .filter(|line| line.contains("\"pair\":1,"))
        .collect();
    assert_eq!(pair.len(), 2, "{pair:?}");
    assert!(
        pair.iter()
            .all(|line| line.contains("\"cause\":\"shutdown\"")),
        "{pair:?}"
    );
}

/// 不成對的對話行程一直不送 `ready`（假對話行程在 `hello` 之前睡著）：過了 `--start-timeout-ms` 被殺，前台拿到 `down(stalled)`，
/// 稽核是 `stalled` 加逾時的 `error`、沒有 `pair`；名額讓出來，第二條 thread 也是同樣的結局，不是 `capacity`。
#[test]
fn an_unpaired_conversation_that_never_says_ready_is_killed_at_the_start_deadline() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-after-ms".into(), "600000".into()],
        extra: vec!["--start-timeout-ms", "1000", "--capacity", "1"],
        ..Options::default()
    });
    h.ensure("a");
    let first = logged_pid(&h.dir.join("run/c1.sock"), "pid");
    assert_eq!(h.down_of("a"), DeathCause::Stalled);
    assert!(wait_until(|| gone(first)));
    let line = h.audit_line("\"error\":\"ready 之前逾時\"");
    assert!(
        line.contains("\"role\":\"conversation\"")
            && line.contains("\"cause\":\"stalled\"")
            && !line.contains("\"pair\""),
        "{line}"
    );
    // 名額只有一個：沒讓出來的話這裡回的是 `capacity`。
    assert_eq!(h.down("b"), DeathCause::Stalled);
    assert_eq!(shut_down(&mut h), []);
}

/// `--start-timeout-ms 0` 不是「馬上逾時」：不送 `ready` 的行程留著，停機時回一次 `down(shutdown)`。
#[test]
fn an_unpaired_conversation_that_never_says_ready_stays_when_the_start_deadline_is_off() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-after-ms".into(), "600000".into()],
        extra: vec!["--start-timeout-ms", "0"],
        ..Options::default()
    });
    h.ensure("a");
    let pid = logged_pid(&h.dir.join("run/c1.sock"), "pid");
    std::thread::sleep(Duration::from_millis(1_500));
    assert!(!gone(pid));
    assert!(
        h.audit()
            .iter()
            .all(|line| !line.contains("ready 之前逾時")),
        "{:?}",
        h.audit()
    );
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: b"a".to_vec(),
            cause: DeathCause::Shutdown
        }]
    );
}

/// 期限內 `ready` 的不受影響：過了 `--start-timeout-ms` 還是同一個行程，沒有人被判 `stalled`。
#[test]
fn an_unpaired_conversation_that_is_ready_in_time_outlives_the_start_deadline() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-after-ms".into(), "300".into()],
        extra: vec!["--start-timeout-ms", "1500"],
        ..Options::default()
    });
    let socket = h.up("a");
    std::thread::sleep(Duration::from_millis(2_000));
    assert_eq!(h.up("a"), socket);
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: b"a".to_vec(),
            cause: DeathCause::Shutdown
        }]
    );
    assert!(
        h.audit()
            .iter()
            .all(|line| !line.contains("ready 之前逾時")),
        "{:?}",
        h.audit()
    );
}

/// 預熱池裡不成對的行程逾時：沒有 thread，不回 `down`、稽核有逾時那一行，之後補一個新的（換了 pid）。
#[test]
fn a_warm_unpaired_conversation_past_the_start_deadline_is_collected_and_refilled() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-after-ms".into(), "600000".into()],
        extra: vec!["--warm", "1", "--start-timeout-ms", "1000"],
        ..Options::default()
    });
    let first = logged_pid(&h.dir.join("run/c1.sock"), "pid");
    assert!(wait_until(|| gone(first)));
    let line = h.audit_line("\"error\":\"ready 之前逾時\"");
    assert!(
        line.contains("\"cause\":\"stalled\"") && !line.contains("\"pair\""),
        "{line}"
    );
    let second = logged_pid(&h.dir.join("run/c2.sock"), "pid");
    assert_ne!(first, second);
    assert_eq!(shut_down(&mut h), []);
}

/// 等到稽核裡有第 `serial` 對起動逾時的樣子：組合行程那一行是 `stalled`、帶逾時的 `error`；`with_leaf` 時它後面是葉子連帶收的那一行，
/// 沒有葉子的就不該再有別行。
fn assert_start_timed_out(h: &Harness, serial: u32, with_leaf: bool) {
    let pair = format!("\"pair\":{serial},");
    let mut lines = Vec::new();
    wait_until(|| {
        lines = h
            .audit()
            .into_iter()
            .filter(|line| line.contains(&pair))
            .skip_while(|line| !line.contains("\"role\":\"composition\""))
            .collect();
        lines.len() > usize::from(with_leaf)
    });
    assert_eq!(lines.len(), 1 + usize::from(with_leaf), "{:?}", h.audit());
    assert!(
        lines[0].contains("\"cause\":\"stalled\"")
            && lines[0].contains("\"error\":\"ready 之前逾時\""),
        "{lines:?}"
    );
    if with_leaf {
        assert!(
            lines[1].contains("\"role\":\"conversation\"")
                && lines[1].contains("\"cause\":\"peer\""),
            "{lines:?}"
        );
    }
}

/// 葉子一直不在橋上登記（#2801）：過了 `--start-timeout-ms` 整對被收，前台拿到一則 `down(stalled)`；名額讓出來，下一條 thread 起得來。
#[test]
fn a_leaf_that_never_registers_is_collected_at_the_start_deadline() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-before-register".into()],
        extra: vec!["--start-timeout-ms", "3000", "--capacity", "1"],
        ..paired()
    });
    h.ensure("a");
    let leaf = logged_pid(&h.dir.join("run/c1.l.sock"), "pid");
    assert_eq!(h.down_of("a"), DeathCause::Stalled);
    assert!(wait_until(|| gone(leaf)));
    assert_start_timed_out(&h, 1, true);

    // 名額只有一個：沒讓出來的話這裡回的是 `capacity`。這一對的葉子一起來就放行。
    std::fs::write(h.dir.join("run/c2.l.sock.go"), b"").unwrap();
    assert_eq!(h.up("b"), h.dir.join("run/c2.sock"));
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: b"b".to_vec(),
            cause: DeathCause::Shutdown
        }]
    );
}

/// `--start-timeout-ms 0` 不是「馬上逾時」：不登記的葉子留著，停機時回一次 `down(shutdown)`。
#[test]
fn a_leaf_that_never_registers_stays_when_the_start_deadline_is_off() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--no-register".into()],
        extra: vec!["--start-timeout-ms", "0"],
        ..paired()
    });
    h.ensure("a");
    let leaf = logged_pid(&h.dir.join("run/c1.l.sock"), "pid");
    std::thread::sleep(Duration::from_millis(500));
    assert!(!gone(leaf));
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: b"a".to_vec(),
            cause: DeathCause::Shutdown
        }]
    );
}

/// 組合行程一直不送 `hello`（拿不送 `hello` 的假對話行程當組合行程）：葉子不會起，過了 `--start-timeout-ms` 一樣被收。
#[test]
fn a_composition_that_never_says_hello_is_collected_at_the_start_deadline() {
    let mut h = Harness::start(Options {
        composition: Some(example("fake_conversation")),
        extra: vec![
            "--composition-arg",
            "--skip-hello",
            "--composition-arg",
            "--no-register",
            "--start-timeout-ms",
            "1000",
        ],
        ..Options::default()
    });
    assert_eq!(h.down("a"), DeathCause::Stalled);
    assert_start_timed_out(&h, 1, false);
    assert_eq!(shut_down(&mut h), []);
    assert_eq!(pair_audit(&h).len(), 1, "{:?}", pair_audit(&h));
}

/// 預熱池裡的一對起動逾時：沒有 thread，不回 `down`；之後再補一對。
#[test]
fn a_warm_pair_past_the_start_deadline_is_collected_and_refilled() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--no-register".into()],
        extra: vec!["--warm", "1", "--start-timeout-ms", "1000"],
        ..paired()
    });
    let first = logged_pid(&h.dir.join("run/c1.l.sock"), "pid");
    let second = logged_pid(&h.dir.join("run/c2.l.sock"), "pid");
    assert!(wait_until(|| gone(first)));
    assert_ne!(first, second);
    assert_start_timed_out(&h, 1, true);
    assert_eq!(shut_down(&mut h), []);
}

/// 期限內登記完的不受影響：過了 `--start-timeout-ms` 還是同一對、同一個葉子，沒有人被判 `stalled`。
#[test]
fn a_pair_that_is_ready_in_time_outlives_the_start_deadline() {
    let mut h = Harness::start(Options {
        extra: vec!["--start-timeout-ms", "3000"],
        ..paired()
    });
    let socket = h.up("a");
    let leaf = last_leaf_pid(&leaf_socket(&socket));
    std::thread::sleep(Duration::from_millis(3_500));
    assert_eq!(h.up("a"), socket);
    assert_eq!(leaf_behind(&socket), leaf);
    shut_down(&mut h);
    let audit = h.audit();
    assert!(
        !audit.iter().any(|line| line.contains("stalled")),
        "{audit:?}"
    );
}

/// `bind` 還沒回 `bound` 葉子就死了：整對收（分不出組合行程那邊的 `bind` 還留不留著），`down` 一次。
#[test]
fn a_leaf_that_dies_before_bound_takes_the_pair_with_it() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--die-on-attach".into()],
        ..paired()
    });
    assert_eq!(h.down("a"), DeathCause::Crash);
    let line = h.audit_line("\"role\":\"composition\"");
    assert!(line.contains("\"cause\":\"peer\""), "{line}");
    assert_eq!(shut_down(&mut h), []);
}

/// 葉子收到 `attach` 不回、也沒有開始送心跳（真的葉子在綁定裡才起心跳）：`bind` 起算的沉默到了 `--stall-ms`，葉子被判 `stalled`，
/// 整對收。
#[test]
fn a_leaf_that_never_answers_attach_without_a_heartbeat_is_stalled() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ignore-attach".into()],
        extra: vec!["--stall-ms", "3000"],
        ..paired()
    });
    assert_eq!(h.down("a"), DeathCause::Stalled);
    let line = h.audit_line("\"role\":\"composition\"");
    assert!(line.contains("\"cause\":\"peer\""), "{line}");
    assert_eq!(shut_down(&mut h), []);
}

/// 葉子回 `attach` 錯：組合行程自己以 4 結束，整對當場收。心跳照送，所以沒有沉默可判；`--stall-ms` 開到比 [`WAIT`] 長，
/// 等得到 `down` 就不是沉默判出來的。
#[test]
fn a_leaf_that_refuses_attach_with_a_heartbeat_takes_the_pair_down_at_once() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--refuse-attach".into(), "--heartbeat-early".into()],
        extra: vec!["--stall-ms", "60000"],
        ..paired()
    });
    assert_eq!(h.down("a"), DeathCause::Crash);
    let line = h.audit_line("\"role\":\"composition\"");
    assert!(
        line.contains("\"cause\":\"crash\"") && line.contains("\"exit_code\":4"),
        "{line}"
    );
    let line = h.audit_line("\"role\":\"conversation\"");
    assert!(line.contains("\"cause\":\"peer\""), "{line}");
    assert_eq!(shut_down(&mut h), []);
}

/// 已知限制：葉子收到 `attach` 一直不回、心跳照送（冷開不結束），這一對留在 `Binding`，沒有期限。等 1.5 倍 `--stall-ms`
/// 沒有 `up` 也沒有 `down`，停機才回 `down(shutdown)`。
#[test]
fn a_leaf_that_never_answers_attach_with_a_heartbeat_stays_until_shutdown() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ignore-attach".into(), "--heartbeat-early".into()],
        extra: vec!["--stall-ms", "3000"],
        ..paired()
    });
    h.ensure("a");
    let leaf = h.dir.join("run/c1.l.sock");
    assert!(wait_until(|| log(&leaf)
        .iter()
        .any(|l| l == "attach ignored")));
    std::thread::sleep(Duration::from_millis(4_500));
    assert_eq!(pair_audit(&h), Vec::<String>::new());
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: b"a".to_vec(),
            cause: DeathCause::Shutdown,
        }]
    );
}

/// 殺葉子：前台讀到 `down`，組合行程留著。留著的見證：停機時它那一行的死因是 `shutdown`，不是被葉子連帶收掉的 `peer`。
#[test]
fn killing_the_leaf_is_down_and_the_composition_stays() {
    let mut h = Harness::start(paired());
    let socket = h.up("a");
    let composition = composition_pid(&h, &socket);
    kill(last_leaf_pid(&leaf_socket(&socket)), libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    assert!(!gone(composition as i32));
    let audit = pair_audit(&h);
    assert_eq!(audit.len(), 1, "{audit:?}");
    assert!(
        audit[0].contains("\"role\":\"conversation\"")
            && audit[0].contains("\"cause\":\"crash\"")
            && audit[0].contains("\"pair\":1"),
        "{audit:?}"
    );
    assert_eq!(shut_down(&mut h), []);
    let audit = pair_audit(&h);
    assert_eq!(audit.len(), 2, "{audit:?}");
    assert!(
        audit[1].contains("\"role\":\"composition\"")
            && audit[1].contains("\"cause\":\"shutdown\""),
        "{audit:?}"
    );
}

/// 殺葉子再 `ensure`：`down` 然後 `up`，socket 不變（同一個組合行程），連進去到的是新葉子。
#[test]
fn ensure_after_the_leaf_died_refills_the_leaf_behind_the_same_socket() {
    let mut h = Harness::start(paired());
    let socket = h.up("a");
    let leaf = leaf_socket(&socket);
    let composition = composition_pid(&h, &socket);
    let old = last_leaf_pid(&leaf);
    kill(old, libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    assert_eq!(h.up("a"), socket);
    let new = last_leaf_pid(&leaf);
    assert_ne!(new, old);
    assert_eq!(leaf_behind(&socket), new);
    assert_eq!(composition_pid(&h, &socket), composition);
}

/// 起一對、讓第一個葉子登記完（`--ready-before-register` 的葉子等 `.go` 才連橋），再殺掉它並要回同一條 thread：
/// 回來時補起的葉子已經起來、還沒連橋。回前台連的 socket 與葉子的 socket。
fn refilled_leaf_waiting_to_register(h: &mut Harness) -> (PathBuf, PathBuf) {
    h.ensure("a");
    let leaf = h.dir.join("run/c1.l.sock");
    let go = format!("{}.go", leaf.display());
    let readies = |leaf: &Path| log(leaf).iter().filter(|line| *line == "ready").count();
    assert!(wait_until(|| readies(&leaf) == 1));
    std::fs::write(&go, b"").unwrap();
    let socket = h.up_of("a");
    std::fs::remove_file(&go).unwrap();
    kill(last_leaf_pid(&leaf), libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    h.ensure("a");
    assert!(wait_until(|| readies(&leaf) == 2));
    (socket, leaf)
}

/// 補起的葉子登記得慢（超過 `--stall-ms`）：登記之前不算它的沉默，登記完照常 `up`。
#[test]
fn a_refilled_leaf_slow_to_register_is_not_stalled() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-before-register".into()],
        extra: vec!["--stall-ms", "3000"],
        ..paired()
    });
    let (socket, leaf) = refilled_leaf_waiting_to_register(&mut h);
    let new = last_leaf_pid(&leaf);
    std::thread::sleep(Duration::from_millis(3_500));
    assert!(!gone(new as i32));
    std::fs::write(format!("{}.go", leaf.display()), b"").unwrap();
    assert_eq!(h.up_of("a"), socket);
    assert_eq!(leaf_behind(&socket), new);
    shut_down(&mut h);
    let audit = h.audit();
    assert!(
        !audit.iter().any(|line| line.contains("stalled")),
        "{audit:?}"
    );
}

/// 補起的葉子一直沒登記：`--stall-ms` 不判它（起動期限還沒到），停機時跟組合行程一起收掉。
#[test]
fn shutdown_collects_a_refilled_leaf_that_never_registered() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-before-register".into()],
        extra: vec!["--stall-ms", "3000"],
        ..paired()
    });
    let (_, leaf) = refilled_leaf_waiting_to_register(&mut h);
    let new = last_leaf_pid(&leaf);
    std::thread::sleep(Duration::from_millis(3_500));
    assert!(!gone(new as i32));
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: b"a".to_vec(),
            cause: DeathCause::Shutdown
        }]
    );
    assert!(gone(new as i32));
    let audit = h.audit();
    assert!(
        !audit.iter().any(|line| line.contains("stalled")),
        "{audit:?}"
    );
}

/// 補起的葉子一直不登記（#2801）：從補的那一刻起過了 `--start-timeout-ms` 整對被收，`down(stalled)` 一次；再要就起新的一對。
#[test]
fn a_refilled_leaf_that_never_registers_is_collected_at_the_start_deadline() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-before-register".into()],
        extra: vec!["--start-timeout-ms", "3000"],
        ..paired()
    });
    let (socket, leaf) = refilled_leaf_waiting_to_register(&mut h);
    let composition = composition_pid(&h, &socket);
    let new = last_leaf_pid(&leaf);
    assert_eq!(h.down_of("a"), DeathCause::Stalled);
    assert!(wait_until(|| gone(composition as i32) && gone(new as i32)));
    assert_start_timed_out(&h, 1, true);

    // 這條連續死了兩次（補葉子之前的 crash、這次的 stalled），窗是 harness 的 `--front-restart-ms 100`；窗內再要只會拿到 `down`。
    std::thread::sleep(Duration::from_millis(250));
    std::fs::write(h.dir.join("run/c2.l.sock.go"), b"").unwrap();
    assert_eq!(h.up("a"), h.dir.join("run/c2.sock"));
}

/// 補起的葉子在期限內登記完的不受影響：過了 `--start-timeout-ms` 還是那個葉子。
#[test]
fn a_refilled_leaf_that_is_ready_in_time_outlives_the_start_deadline() {
    let mut h = Harness::start(Options {
        extra: vec!["--start-timeout-ms", "3000"],
        ..paired()
    });
    let socket = h.up("a");
    let leaf = leaf_socket(&socket);
    kill(last_leaf_pid(&leaf), libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    assert_eq!(h.up("a"), socket);
    let new = last_leaf_pid(&leaf);
    std::thread::sleep(Duration::from_millis(3_500));
    assert_eq!(h.up("a"), socket);
    assert_eq!(leaf_behind(&socket), new);
    shut_down(&mut h);
    let audit = h.audit();
    assert!(
        !audit.iter().any(|line| line.contains("stalled")),
        "{audit:?}"
    );
}

/// 補起的葉子還沒登記就死：前台拿到這條 thread 的一則 `down`，組合行程連帶收；再要就起新的一對。
#[test]
fn a_refilled_leaf_killed_before_it_registers_takes_the_pair_down_once() {
    let mut h = Harness::start(Options {
        conversation_args: vec!["--ready-before-register".into()],
        ..paired()
    });
    let (socket, leaf) = refilled_leaf_waiting_to_register(&mut h);
    let composition = composition_pid(&h, &socket);
    kill(last_leaf_pid(&leaf), libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    assert!(wait_until(|| gone(composition as i32)));

    // 這條連續死了兩次（先殺的第一個葉子、這次的補起葉子），窗是 harness 的 `--front-restart-ms 100`；窗內再要只會拿到 `down`。
    std::thread::sleep(Duration::from_millis(250));
    h.ensure("a");
    let next = h.dir.join("run/c2.l.sock");
    assert!(wait_until(|| log(&next).contains(&"ready".to_string())));
    std::fs::write(format!("{}.go", next.display()), b"").unwrap();
    // 中間再來一則 `down` 的話 `up_of` 會當場失敗。
    assert_eq!(h.up_of("a"), h.dir.join("run/c2.sock"));
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: b"a".to_vec(),
            cause: DeathCause::Shutdown
        }]
    );
}

/// 補起的葉子登記、綁定之後卡住：照 `--stall-ms` 被收，跟第一個葉子一樣。
#[test]
fn a_refilled_leaf_that_hangs_after_bound_is_stalled() {
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "3000"],
        ..paired()
    });
    let socket = h.up("a,hang");
    let leaf = leaf_socket(&socket);
    let old = last_leaf_pid(&leaf);
    assert_eq!(h.down_of("a,hang"), DeathCause::Stalled);
    assert_eq!(h.up("a,hang"), socket);
    assert_ne!(last_leaf_pid(&leaf), old);
    assert_eq!(h.down_of("a,hang"), DeathCause::Stalled);
    let stalled = |h: &Harness| {
        pair_audit(h)
            .iter()
            .filter(|line| {
                line.contains("\"cause\":\"stalled\"") && line.contains("\"role\":\"conversation\"")
            })
            .count()
    };
    assert!(wait_until(|| stalled(&h) == 2), "{:?}", pair_audit(&h));
}

/// 補起的葉子在舊葉子收屍之後才起：舊葉子留在同一個群組的子孫，新葉子 `up` 時已經不在了。
#[test]
fn the_leaf_is_refilled_after_the_old_one_is_reaped() {
    let mut h = Harness::start(paired());
    let thread = "a,grandchild";
    let socket = h.up(thread);
    let leaf = leaf_socket(&socket);
    let grandchild = logged_pid(&leaf, "grandchild");
    kill(last_leaf_pid(&leaf), libc::SIGKILL);
    assert_eq!(h.down_of(thread), DeathCause::Crash);
    assert_eq!(h.up(thread), socket);
    assert!(gone(grandchild));
}

/// 殺組合行程：整對收，`down` 只一次、死因是組合行程的；稽核兩行同一個 `pair`，葉子那行是 `peer`。
#[test]
fn killing_the_composition_takes_the_pair_down_once() {
    let mut h = Harness::start(paired());
    let socket = h.up("a");
    let leaf = last_leaf_pid(&leaf_socket(&socket));
    kill(composition_pid(&h, &socket), libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    h.audit_line("\"role\":\"conversation\"");
    assert!(gone(leaf as i32));
    assert_eq!(shut_down(&mut h), []);
    let audit = pair_audit(&h);
    assert_eq!(audit.len(), 2, "{audit:?}");
    assert!(
        audit[0].contains("\"role\":\"composition\"")
            && audit[0].contains("\"cause\":\"crash\"")
            && audit[0].contains("\"signal\":9")
            && audit[0].contains("\"pair\":1"),
        "{audit:?}"
    );
    assert!(
        audit[1].contains("\"role\":\"conversation\"")
            && audit[1].contains("\"cause\":\"peer\"")
            && audit[1].contains("\"pair\":1"),
        "{audit:?}"
    );
}

/// 兩個行程各看各的沉默：葉子停住只殺葉子（`stalled`），組合行程的心跳沒斷、留著（停機時它那一行是 `shutdown`）。
/// `--stall-ms` 要比組合行程的心跳間隔（1 秒）長。
#[test]
fn a_stalled_leaf_is_killed_alone() {
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "3000"],
        ..paired()
    });
    h.up("a,hang");
    let line = h.audit_line("\"cause\":\"stalled\"");
    assert!(line.contains("\"role\":\"conversation\""), "{line}");
    shut_down(&mut h);
    let audit = pair_audit(&h);
    assert_eq!(audit.len(), 2, "{audit:?}");
    assert!(
        audit[1].contains("\"role\":\"composition\"")
            && audit[1].contains("\"cause\":\"shutdown\""),
        "{audit:?}"
    );
}

/// 葉子死後沒人再要：留了 `--idle-ms` 就收掉組合行程，不再送一次 `down`。
#[test]
fn a_leafless_composition_is_collected_after_the_idle_limit() {
    let mut h = Harness::start(Options {
        extra: vec!["--idle-ms", "300"],
        ..paired()
    });
    let socket = h.up("a");
    kill(last_leaf_pid(&leaf_socket(&socket)), libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    let line = h.audit_line("\"role\":\"composition\"");
    assert!(line.contains("\"cause\":\"peer\""), "{line}");
    assert!(
        supervisor_stderr(&h).contains("沒有葉子已經 300 ms"),
        "{}",
        supervisor_stderr(&h)
    );
    assert_eq!(shut_down(&mut h), []);
}

/// 停機時排著的那條 thread 只剩一個不會再回 `down` 的行程（這裡是被連帶收、還沒收完的組合行程）：當場回 `down(shutdown)`。
/// 組合行程先停住，讀不到 EOF，被收時留在拆除梯度上；`b` 的 `capacity` 回來就表示前面那則 `ensure(a)` 已經排進去了。
#[test]
fn shutdown_answers_a_thread_queued_behind_a_composition_that_will_not_tell_down() {
    let mut h = Harness::start(Options {
        eof_grace_ms: 3_000,
        extra: vec!["--idle-ms", "300", "--capacity", "1"],
        ..paired()
    });
    let socket = h.up("a");
    kill(composition_pid(&h, &socket), libc::SIGSTOP);
    kill(last_leaf_pid(&leaf_socket(&socket)), libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    assert!(wait_until(
        || supervisor_stderr(&h).contains("沒有葉子已經 300 ms")
    ));
    h.ensure("a");
    h.ensure("b");
    assert_eq!(h.next_event(), Some(capacity("b", 1, 1)));
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: b"a".to_vec(),
            cause: DeathCause::Shutdown
        }]
    );
}

/// 成對時也一樣（#2799）：被逐出、還在收的是葉子，它收完回的是 `down(evicted)`；組合行程等它收完才連帶收、不回 `down`。
/// 兩個都不是排著那則 `ensure` 的回答，所以停機當場回 `down(shutdown)`。
#[test]
fn shutdown_answers_a_thread_queued_behind_its_own_evicted_leaf() {
    let mut h = Harness::start(Options {
        eof_grace_ms: 2_000,
        extra: vec!["--idle-ms", "300", "--capacity", "1"],
        ..paired()
    });
    let thread = "a,idle:0,ignore-eof";
    let socket = h.up(thread);
    let leaf = leaf_socket(&socket);
    assert!(wait_until(|| log(&leaf).contains(&"eof".to_string())));
    h.ensure(thread);
    h.ensure("b");
    assert_eq!(h.next_event(), Some(capacity("b", 1, 1)));
    assert_eq!(
        shut_down(&mut h),
        [
            FrontEvent::Down {
                thread_id: thread.as_bytes().to_vec(),
                cause: DeathCause::Shutdown
            },
            FrontEvent::Down {
                thread_id: thread.as_bytes().to_vec(),
                cause: DeathCause::Evicted
            },
        ]
    );
}

/// 名額滿時先收沒有葉子的那一對，排著的才起得來。
#[test]
fn a_leafless_composition_is_the_first_to_make_room() {
    let mut h = Harness::start(Options {
        extra: vec!["--capacity", "1"],
        ..paired()
    });
    let socket = h.up("a");
    kill(last_leaf_pid(&leaf_socket(&socket)), libc::SIGKILL);
    assert_eq!(h.down_of("a"), DeathCause::Crash);
    assert_eq!(h.up("b"), h.dir.join("run/c2.sock"));
    assert!(
        supervisor_stderr(&h).contains("先收沒有葉子的組合行程"),
        "{}",
        supervisor_stderr(&h)
    );
    let line = h.audit_line("\"role\":\"composition\"");
    assert!(
        line.contains("\"cause\":\"peer\"") && line.contains("\"pair\":1"),
        "{line}"
    );
}

/// 停機：先葉子後組合行程。葉子不理 EOF、要等到 SIGTERM 才走；組合行程那一行還是排在它後面。
#[test]
fn shutdown_collects_the_leaf_before_the_composition() {
    let mut h = Harness::start(paired());
    let thread = "a,ignore-eof";
    h.up(thread);
    assert_eq!(
        shut_down(&mut h),
        [FrontEvent::Down {
            thread_id: thread.as_bytes().to_vec(),
            cause: DeathCause::Shutdown
        }]
    );
    let audit = pair_audit(&h);
    assert_eq!(audit.len(), 2, "{audit:?}");
    assert!(
        audit[0].contains("\"role\":\"conversation\"")
            && audit[0].contains("\"cause\":\"shutdown\""),
        "{audit:?}"
    );
    assert!(
        audit[1].contains("\"role\":\"composition\"") && audit[1].contains("\"cause\":\"peer\""),
        "{audit:?}"
    );
}

/// 預熱一對：`ensure` 用池裡那一對（第一個序號），不另起；用掉之後池子補回一對。
#[test]
fn ensure_takes_the_warm_pair() {
    let mut h = Harness::start(Options {
        extra: vec!["--warm", "1"],
        ..paired()
    });
    assert_eq!(h.up("a"), h.dir.join("run/c1.sock"));
    logged_pid(&h.dir.join("run/c2.l.sock"), "pid");
    assert_eq!(h.up("b"), h.dir.join("run/c2.sock"));
}

/// 不給 `--composition`：稽核那一行沒有 `pair`。
#[test]
fn an_unpaired_conversation_has_no_pair_in_the_audit() {
    let mut h = Harness::start(Options::default());
    assert_eq!(h.down("x,exit:3"), DeathCause::Crash);
    let line = h.audit_line("\"thread\":\"x,exit:3\"");
    assert!(!line.contains("pair"), "{line}");
}

// ---- 宿主死掉時掃它 session 裡的行程（#2920） ----
//
// 宿主是 `host/examples/stdio_host.rs`：用真的 `stdio::spawn` 起一個 MCP server（`sh` 腳本），腳本再起一個孫行程。
// server 與孫行程各自成一組、都留在宿主的 session 裡。每支測試結尾對監督行程 SIGTERM 並等它結束：停機會再掃一次，
// 不留 `sleep` 在測試機上（腳本的 `sleep` 只有 60 秒，是最後一道保險）。

/// 一個 MCP server 的腳本：起一個孫行程、把孫行程的 pid 寫進 `$1`。`$2` 是模式：
/// `threads-outlive-leader` server 本身換成 `leader_exits member`（主執行緒結束、執行緒還在；pid 檔寫的是 server 自己，沒有孫行程）；
/// `leader-exits` 領頭先結束；`setsid` 孫行程自己開 session；`ignore-term` 領頭與孫行程都忽略 SIGTERM（忽略跨 `exec` 繼承），
/// 這樣「保底層改送 SIGTERM」的改動收不掉它們。
fn server_script(dir: &Path) -> PathBuf {
    let path = dir.join("server.sh");
    std::fs::write(
        &path,
        format!(
            "#!/bin/sh\ncase \"$2\" in\n  threads-outlive-leader) exec '{}' member \"$1\" ;;\nesac\n",
            example("leader_exits").display()
        ) + "\
         case \"$2\" in\n\
           ignore-term) trap '' TERM ;;\n\
         esac\n\
         case \"$2\" in\n\
           setsid) setsid /bin/sleep 60 & ;;\n\
           *) /bin/sleep 60 & ;;\n\
         esac\n\
         echo $! > \"$1\"\n\
         case \"$2\" in\n\
           leader-exits) exit 0 ;;\n\
           *) exec /bin/sleep 60 ;;\n\
         esac\n",
    )
    .unwrap();
    path
}

/// server 的包法：`stdio::spawn` 直接起 `sh`，或被 spawner 的 `--guard`／`--exec` 包起來。
#[derive(Clone, Copy, PartialEq)]
enum Wrap {
    Bare,
    Guard,
    Exec,
}

/// 用 `stdio_host` 起宿主：`flags` 是它自己的旗標，之後接 `-- [<spawner> --guard|--exec …] /bin/sh <腳本> <孫行程 pid 檔> [<模式>]`。
/// 回宿主設定、孫行程 pid 檔與暫存目錄。
fn stdio_host(
    flags: &[&str],
    mode: Option<&str>,
) -> (Option<(PathBuf, Vec<String>)>, PathBuf, PathBuf) {
    stdio_host_wrapped(flags, mode, Wrap::Bare)
}

fn stdio_host_wrapped(
    flags: &[&str],
    mode: Option<&str>,
    wrap: Wrap,
) -> (Option<(PathBuf, Vec<String>)>, PathBuf, PathBuf) {
    // 先轉成真實路徑：`--exec` 的 Landlock 規則吃真實路徑。
    let dir = std::fs::canonicalize(temp_dir("sh")).unwrap();
    let script = server_script(&dir);
    let grandchild_file = dir.join("grandchild.pid");
    let mut args: Vec<String> = flags.iter().map(|f| f.to_string()).collect();
    args.push("--".into());
    let spawner = Path::new(SUPERVISOR)
        .parent()
        .unwrap()
        .join("nexus-sandbox-spawner");
    match wrap {
        Wrap::Bare => {}
        Wrap::Guard => {
            args.extend([spawner.display().to_string(), "--guard".into(), "--".into()]);
        }
        Wrap::Exec => {
            args.extend([spawner.display().to_string(), "--exec".into()]);
            for root in ["/usr", "/bin", "/lib", "/lib64"] {
                if let Ok(real) = std::fs::canonicalize(root) {
                    args.extend(["--read".into(), real.display().to_string()]);
                }
            }
            args.extend(["--write".into(), dir.display().to_string(), "--".into()]);
        }
    }
    args.extend(["/bin/sh".into(), script.display().to_string()]);
    args.push(grandchild_file.display().to_string());
    args.extend(mode.map(String::from));
    (Some((example("stdio_host"), args)), grandchild_file, dir)
}

fn host_socket_log(h: &Harness) -> PathBuf {
    h.dir.join("run/host.sock")
}

/// 宿主紀錄裡第 `n`（從 0）個 `<key> <pid>` 的 pid。
fn nth_logged(h: &Harness, key: &str, n: usize) -> i32 {
    let mut pid = None;
    assert!(
        wait_until(|| {
            pid = log(&host_socket_log(h))
                .iter()
                .filter_map(|line| line.strip_prefix(&format!("{key} ")))
                .nth(n)
                .map(|p| p.parse().unwrap());
            pid.is_some()
        }),
        "{:?}",
        raw_log(&host_socket_log(h))
    );
    pid.unwrap()
}

fn grandchild_pid(file: &Path) -> i32 {
    let mut pid = None;
    assert!(wait_until(|| {
        pid = std::fs::read_to_string(file)
            .ok()
            .and_then(|t| t.trim().parse().ok());
        pid.is_some()
    }));
    pid.unwrap()
}

/// `/proc/<pid>/stat` 的 session 欄（括號後第 4 欄）；行程不在或讀不到是 `None`。
fn session_of(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(3)?
        .parse()
        .ok()
}

/// 宿主已經起了 server 與孫行程，兩個都還活著；回（宿主 pid、server 領頭 pid、孫行程 pid）。
fn host_with_members(h: &Harness, file: &Path) -> (i32, i32, i32) {
    let host = nth_logged(h, "start", 0);
    let leader = nth_logged(h, "spawned", 0);
    let grandchild = grandchild_pid(file);
    assert!(!gone(leader) && !gone(grandchild));
    (host, leader, grandchild)
}

fn sweep_line(h: &Harness) -> String {
    h.audit_line("\"event\":\"sweep\"")
}

/// 測試結尾：停機（會再掃一次，宿主重起後新起的 server 也收掉）並等監督行程結束。
fn finish(mut h: Harness) {
    kill(h.pid(), libc::SIGTERM);
    assert!(h.wait_exit().success());
}

/// 稽核 `sweep` 那一行的 `"signalled":[…]`，逐個 pid 取出來比，不用整行 `contains`（pid 可能剛好是時間戳或別的欄位的一段）。
fn signalled_pids(line: &str) -> Vec<i32> {
    let rest = line
        .split("\"signalled\":[")
        .nth(1)
        .unwrap_or_else(|| panic!("sweep 行沒有 signalled：{line}"));
    let list = rest.split(']').next().unwrap();
    list.split(',')
        .filter(|pid| !pid.is_empty())
        .map(|pid| pid.parse().unwrap())
        .collect()
}

/// 掃描只收宿主 session 裡的行程：已經 `up` 的對話行程（監督行程自己起的，不在宿主的 session）掃完還活著。
/// 宿主死了不會連帶收對話行程，所以選這一種，不選「`signalled` 等於成員數」（那個數字含宿主重起時新起的 server，不穩）。
fn assert_sweep_left_the_conversation_alone(conversation_pid: i32, line: &str) {
    assert!(
        !gone(conversation_pid),
        "對話行程 {conversation_pid} 被誤殺：{line}"
    );
    assert!(
        !signalled_pids(line).contains(&conversation_pid),
        "sweep 把對話行程列進 signalled：{line}"
    );
}

/// 宿主被殺，它 session 裡的 server 領頭與孫行程都被收掉，稽核有 `sweep`；同時已 `up` 的對話行程不受影響。
/// server 與孫行程都忽略 SIGTERM，所以只有掃描送的 SIGKILL 收得掉它們（`sweep::kill_member`）。
#[test]
fn s1_a_killed_host_takes_its_mcp_server_and_grandchild_with_it() {
    let (host, file, _dir) = stdio_host(&[], Some("ignore-term"));
    let mut h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let socket = h.up("a");
    let conversation = logged_pid(&socket, "pid");
    let (host, leader, grandchild) = host_with_members(&h, &file);
    kill(host as u32, libc::SIGKILL);
    assert!(
        wait_until(|| gone(leader) && gone(grandchild)),
        "{leader} {grandchild}"
    );
    let line = sweep_line(&h);
    let signalled = signalled_pids(&line);
    assert!(
        signalled.contains(&leader) && signalled.contains(&grandchild),
        "{line}"
    );
    assert!(line.contains("\"left\":[]"), "{line}");
    assert_sweep_left_the_conversation_alone(conversation, &line);
    finish(h);
}

/// 等到成員真的是「主執行緒結束、其他執行緒還在」：`stat` 是 `Z`、執行緒數至少 2。不等的話掃到的是主執行緒還沒結束的普通行程，
/// 測試會綠，卻沒測到主執行緒已結束、執行緒還在的成員（#2942）。
fn wait_until_zombie_with_threads(pid: i32) {
    assert!(
        wait_until(|| sweep::read_member(pid)
            .unwrap()
            .is_some_and(|m| m.zombie && m.threads >= 2)),
        "{pid} 沒變成主執行緒結束、執行緒還在的樣子：{:?}",
        sweep::read_member(pid)
    );
}

/// 自成 session 的 `leader_exits leader`：收尾時殺它那一組（成員也在組內）再收屍，測試中途 panic 也照跑。
struct SessionLeader(Child);

impl Drop for SessionLeader {
    fn drop(&mut self) {
        let pid = self.0.id() as i32;
        // SAFETY：只送訊號給這個測試自己起的行程與它那一組。
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// 真的 `/proc`、真的 `pidfd`：session 裡有一個主執行緒已結束、執行緒還在的成員，掃要送到它、收得掉它，不當成殭屍濾掉。
#[test]
fn zu5_a_member_whose_main_thread_exited_is_swept_in_a_real_session() {
    let file = temp_dir("zu5").join("member.pid");
    let leader = SessionLeader(
        Command::new(example("leader_exits"))
            .arg("leader")
            .arg(&file)
            .spawn()
            .unwrap(),
    );
    let leader_pid = leader.0.id() as i32;
    let member = grandchild_pid(&file);
    wait_until_zombie_with_threads(member);
    assert_eq!(session_of(member), Some(leader_pid));
    assert!(!gone(member));
    let result = sweep::sweep(leader_pid, sweep::list_members, |m| {
        sweep::kill_member(leader_pid, m)
    });
    assert!(result.signalled.contains(&member), "{result:?}");
    assert!(
        result.left.is_empty() && result.error.is_none() && !result.fallback,
        "{result:?}"
    );
    assert!(wait_until(|| gone(member)), "{member} 還在：{result:?}");
}

/// 整條路：宿主被殺，它 session 裡主執行緒已結束、執行緒還在的 server 照樣被收，稽核的 `signalled` 有它。
/// 這支的斷言有兩半：`gone`（行程真的死了）與稽核 `signalled`（掃真的送到了，不靠 `gone` 的判斷）。
#[test]
fn zs1_a_server_whose_main_thread_exited_is_swept_when_the_host_dies() {
    let (host, file, _dir) = stdio_host(&[], Some("threads-outlive-leader"));
    let mut h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let socket = h.up("a");
    let conversation = logged_pid(&socket, "pid");
    let host = nth_logged(&h, "start", 0);
    let server = grandchild_pid(&file);
    assert_eq!(
        server,
        nth_logged(&h, "spawned", 0),
        "pid 檔寫的該是 server 自己"
    );
    wait_until_zombie_with_threads(server);
    assert!(!gone(server));
    kill(host as u32, libc::SIGKILL);
    assert!(wait_until(|| gone(server)), "{server} 還在");
    let line = sweep_line(&h);
    assert!(signalled_pids(&line).contains(&server), "{line}");
    assert!(line.contains("\"left\":[]"), "{line}");
    assert_sweep_left_the_conversation_alone(conversation, &line);
    finish(h);
}

/// 宿主自己結束（不經收線），結果同宿主被殺。
#[test]
fn s1e_a_host_that_exits_by_itself_leaves_nothing_behind() {
    let (host, file, _dir) = stdio_host(&["--exit-after-spawn"], None);
    let h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let leader = nth_logged(&h, "spawned", 0);
    let grandchild = grandchild_pid(&file);
    assert!(
        wait_until(|| gone(leader) && gone(grandchild)),
        "{leader} {grandchild}"
    );
    assert!(sweep_line(&h).contains("\"left\":[]"));
    finish(h);
}

/// 領頭先走、孫行程成了孤兒，宿主死後孫行程照樣被收（它還在宿主的 session 裡）。
#[test]
fn s1g_an_orphaned_grandchild_is_swept_after_its_leader_is_gone() {
    let (host, file, _dir) = stdio_host(&[], Some("leader-exits"));
    let h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let host = nth_logged(&h, "start", 0);
    let grandchild = grandchild_pid(&file);
    let leader = nth_logged(&h, "spawned", 0);
    assert!(wait_until(|| gone(leader)));
    assert!(!gone(grandchild));
    kill(host as u32, libc::SIGKILL);
    assert!(wait_until(|| gone(grandchild)), "孤兒 {grandchild} 還在");
    finish(h);
}

/// 被 spawner 的 `--guard` 包起來的 server 與它的孫行程，宿主被殺後都不在。
#[test]
fn a_guard_wrapped_server_and_its_grandchild_are_swept() {
    let (host, file, _dir) = stdio_host_wrapped(&[], None, Wrap::Guard);
    let h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let (host, leader, grandchild) = host_with_members(&h, &file);
    kill(host as u32, libc::SIGKILL);
    assert!(
        wait_until(|| gone(leader) && gone(grandchild)),
        "{leader} {grandchild}"
    );
    sweep_line(&h);
    finish(h);
}

/// 被 spawner 的 `--exec` 包起來的 server 與它的孫行程，宿主被殺後都不在。這條路在領頭不是 session 長時會走 `tty_nr` 的判斷
/// （宿主自己是 session 長、沒有控制終端，所以放行），要有 Landlock 的核心才起得來；沒有時這支紅，不跳過。
#[test]
fn an_exec_wrapped_server_and_its_grandchild_are_swept() {
    let (host, file, _dir) = stdio_host_wrapped(&[], None, Wrap::Exec);
    let h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let (host, leader, grandchild) = host_with_members(&h, &file);
    assert_eq!(
        session_of(leader),
        Some(host),
        "包 --exec 的 server 要留在宿主的 session"
    );
    kill(host as u32, libc::SIGKILL);
    assert!(
        wait_until(|| gone(leader) && gone(grandchild)),
        "{leader} {grandchild}"
    );
    sweep_line(&h);
    finish(h);
}

/// 停機收宿主時也掃：前台還在的那條路（對照 s3 前台已不在）。
#[test]
fn s2_shutdown_sweeps_the_host_session_too() {
    let (host, file, _dir) = stdio_host(&[], None);
    let h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let (_, leader, grandchild) = host_with_members(&h, &file);
    finish_checking(h, leader, grandchild);
}

/// 同 `finish`，另外確認 server 與孫行程都被收掉、稽核有 `sweep`。
fn finish_checking(h: Harness, leader: i32, grandchild: i32) {
    let socket_log = h.dir.clone();
    kill(h.pid(), libc::SIGTERM);
    let mut h = h;
    assert!(h.wait_exit().success());
    assert!(
        wait_until(|| gone(leader) && gone(grandchild)),
        "{leader} {grandchild} {socket_log:?}"
    );
    sweep_line(&h);
}

/// 前台已經不在了才停機：照樣掃。前台不在時監督行程不送 `stop-admission`、也不等它（`advance_shutdown` 的 `front_admitting`），
/// 所以 `--admission-timeout-ms` 設成 20 秒，停機還是要在幾秒內結束，才證明走的是「前台不在」這條路，不是等逾時。
/// `--front-restart-ms` 拉長，前台不會在殺掉之後立刻被重起。
#[test]
fn s3_shutdown_with_the_front_already_gone_still_sweeps() {
    let (host, file, _dir) = stdio_host(&[], None);
    let mut h = Harness::start(Options {
        host,
        extra: vec![
            "--admission-timeout-ms",
            "20000",
            "--front-restart-ms",
            "600000",
        ],
        ..Options::default()
    });
    let (_, leader, grandchild) = host_with_members(&h, &file);
    h.front = None;
    // 等監督行程認出前台沒了：稽核裡有前台那一行（行程結束的紀錄）。
    h.audit_line("\"role\":\"front\"");
    let started = Instant::now();
    kill(h.pid(), libc::SIGTERM);
    assert!(h.wait_exit().success());
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "停機等了 {:?}：前台不在不該等 stop-admission 的回答",
        started.elapsed()
    );
    assert!(
        wait_until(|| gone(leader) && gone(grandchild)),
        "{leader} {grandchild}"
    );
    sweep_line(&h);
}

/// 宿主被殺後重起，舊宿主的成員先收乾淨，新宿主有自己的一組。
#[test]
fn s4_a_restarted_host_starts_from_a_clean_session() {
    let (host, file, _dir) = stdio_host(&[], None);
    let h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let (host, leader, grandchild) = host_with_members(&h, &file);
    kill(host as u32, libc::SIGKILL);
    assert!(wait_until(|| gone(leader) && gone(grandchild)));
    let new_host = nth_logged(&h, "start", 1);
    let new_leader = nth_logged(&h, "spawned", 1);
    assert_ne!(new_host, host);
    assert_ne!(new_leader, leader);
    assert!(!gone(new_leader), "新宿主的 server 不能被舊的掃描帶走");
    finish(h);
}

/// 宿主還沒 `ready` 就被殺，也要掃：server 已經起了。
#[test]
fn a_host_killed_before_ready_is_still_swept() {
    let (host, file, _dir) = stdio_host(&["--spawn-before-ready", "--no-ready"], None);
    let h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let (host, leader, grandchild) = host_with_members(&h, &file);
    kill(host as u32, libc::SIGKILL);
    assert!(
        wait_until(|| gone(leader) && gone(grandchild)),
        "{leader} {grandchild}"
    );
    finish(h);
}

/// 自己 `setsid` 的後代掃不到，這是已知的界線（`docs/host-mcp.md`）；這條釘住它，改了要連文件一起改。
/// 殺宿主之前先等孫行程的 session 欄真的換掉，不靠 pid 檔出現：腳本是先寫 pid、`setsid` 才換，不等的話孫行程可能還在宿主的 session 裡、被掃掉，測試就靠運氣才綠。
#[test]
fn l1_a_descendant_that_calls_setsid_is_out_of_reach() {
    let (host, file, _dir) = stdio_host(&[], Some("setsid"));
    let h = Harness::start(Options {
        host,
        ..Options::default()
    });
    let (host, leader, grandchild) = host_with_members(&h, &file);
    assert!(
        wait_until(|| session_of(grandchild).is_some_and(|session| session != host)),
        "孫行程 {grandchild} 的 session 一直沒換掉：{:?}",
        session_of(grandchild)
    );
    kill(host as u32, libc::SIGKILL);
    assert!(wait_until(|| gone(leader)));
    sweep_line(&h);
    let survived = !gone(grandchild);
    kill(grandchild as u32, libc::SIGKILL);
    // 宿主重起後新一代的 server 也有一個自己 `setsid` 的孫行程：停機前先收掉，不留在測試機上。
    let _ = nth_logged(&h, "spawned", 1);
    assert!(wait_until(|| {
        let next = grandchild_pid(&file);
        next != grandchild && session_of(next) == Some(next)
    }));
    kill(grandchild_pid(&file) as u32, libc::SIGKILL);
    finish(h);
    assert!(survived, "自己開 session 的後代不在掃描範圍");
}
