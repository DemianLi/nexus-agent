//! 真的監督行程、真的子行程（#2340）。只在 Linux 跑。
//!
//! 前台與對話行程是兩支假程式：`fake_front`（`examples/`）把監督行程的前台通道轉到這裡聽著的 Unix socket，測試就站在前台的位置；
//! `fake_conversation`（`host/examples/`，要用宿主的協定）照協定回 `ready`／`bound`，之後照 thread id 做事、把收到的 EOF 與 SIGTERM 記進 `<socket>.log`。
//! 等待一律寫成「最多等多久、條件成立就過」，不拿牆鐘時間當斷言。空轉測試例外：固定量兩秒的 CPU tick。

#![cfg(target_os = "linux")]

use nexus_sandbox_spawner::protocol::{frame, take_frame};
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
fn gone(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat
            .rsplit_once(") ")
            .is_some_and(|(_, rest)| rest.starts_with('Z')),
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
        cmd.args(&options.extra);
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
        match self.event() {
            FrontEvent::Up { thread_id, socket } if thread_id == thread.as_bytes() => {
                PathBuf::from(String::from_utf8(socket).unwrap())
            }
            other => panic!("要 {thread} 的 up，拿到 {other:?}"),
        }
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
        match self.event() {
            FrontEvent::Up { thread_id, socket } => {
                assert_eq!(thread_id, thread.as_bytes());
                PathBuf::from(String::from_utf8(socket).unwrap())
            }
            other => panic!("要 up，拿到 {other:?}"),
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
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "1000", "--rss-poll-ms", "60000"],
        ..Options::default()
    });
    let socket = h.up("a");
    let a = logged_pid(&socket, "pid");
    kill(h.pid(), libc::SIGSTOP);
    // SAFETY：只送訊號，對 a 的群組。
    unsafe { libc::kill(-a, libc::SIGSTOP) };
    // 只比 N 多一點：監督行程不是最晚 N 的四分之一就醒一次的話，醒來時比預定晚不到 N 的一半，認不出自己被停住過。
    std::thread::sleep(Duration::from_millis(1_300));
    // 監督行程先醒，a 晚 200 ms：監督行程醒來那一刻還沒有 a 的心跳。
    kill(h.pid(), libc::SIGCONT);
    std::thread::sleep(Duration::from_millis(200));
    // SAFETY：同上。
    unsafe { libc::kill(-a, libc::SIGCONT) };
    std::thread::sleep(Duration::from_millis(1_500));
    assert_eq!(h.up("a"), socket);
    assert!(
        supervisor_stderr(&h).contains("判定自己被停住過"),
        "{}",
        supervisor_stderr(&h)
    );
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
    // `--front-restart-ms 100`：一秒最多十幾次，不是一直 fork。
    assert!((2..=20).contains(&audited), "{audited} 行");
    assert!(h.audit()[0].contains("\"thread\":\"\""), "{:?}", h.audit());
    h.ensure("x");
    assert_eq!(h.down_of("x"), DeathCause::Crash);
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

/// 版本不符含上一版（`PROTOCOL_VERSION - 1`）：上一版的子行程照樣被擋下。
#[test]
fn a_conversation_whose_first_frame_is_not_a_matching_hello_is_down_protocol() {
    let previous = (PROTOCOL_VERSION - 1).to_string();
    for args in [
        ["--hello-version", "99"].as_slice(),
        ["--hello-version", &previous].as_slice(),
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
    let socket = h.up("a,host-hello");
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
    let socket = h.up("a,host-hello");
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
    let a = h.up("a,host-hello");
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
    let a = h.up("a,host-hello,wait-go,host-hello");
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
            .filter(|l| {
                l.contains("\"event\":\"protocol\"") && pids.iter().any(|p| l.contains(p))
            })
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
    let a = h.up("a,host-hello");
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
