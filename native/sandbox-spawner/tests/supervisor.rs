//! 真的監督行程、真的子行程（#2340）。只在 Linux 跑。
//!
//! 前台與對話行程是 `examples/` 的兩支假程式：`fake_front` 把監督行程的前台通道轉到這裡聽著的 Unix socket，測試就站在前台的位置；
//! `fake_conversation` 照協定回 `ready`／`bound`，之後照 thread id 做事、把收到的 EOF 與 SIGTERM 記進 `<socket>.log`。
//! 等待一律寫成「最多等多久、條件成立就過」，不拿牆鐘時間當斷言。

#![cfg(target_os = "linux")]

use nexus_sandbox_spawner::protocol::{frame, take_frame};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_front_event, encode_front_request, DeathCause, FrontEvent, FrontRequest, OpenMode,
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
    Path::new(SUPERVISOR).parent().unwrap().join("examples").join(name)
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

/// 行程不在了，或只剩 zombie（父行程已經不是監督行程，收不收屍不歸它管）。
fn gone(pid: i32) -> bool {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Err(_) => true,
        Ok(stat) => stat.rsplit_once(") ").is_some_and(|(_, rest)| rest.starts_with('Z')),
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
}

impl Default for Options {
    fn default() -> Self {
        Options { conversation: example("fake_conversation"), conversation_args: Vec::new(), eof_grace_ms: 300, term_grace_ms: 300 }
    }
}

struct Harness {
    child: Child,
    listener: UnixListener,
    front: Option<UnixStream>,
    inbox: Vec<u8>,
    dir: PathBuf,
}

impl Harness {
    fn start(options: Options) -> Harness {
        let dir = temp_dir("h");
        let listener = UnixListener::bind(dir.join("front.sock")).unwrap();
        listener.set_nonblocking(true).unwrap();
        let mut cmd = Command::new(SUPERVISOR);
        cmd.arg("--run-dir").arg(dir.join("run"));
        cmd.arg("--audit").arg(dir.join("audit.jsonl"));
        cmd.arg("--front").arg(example("fake_front")).arg("--front-arg").arg(dir.join("front.sock"));
        cmd.arg("--conversation").arg(&options.conversation);
        for arg in &options.conversation_args {
            cmd.arg("--conversation-arg").arg(arg);
        }
        cmd.args(["--eof-grace-ms", &options.eof_grace_ms.to_string()]);
        cmd.args(["--term-grace-ms", &options.term_grace_ms.to_string(), "--front-restart-ms", "100"]);
        let child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).spawn().unwrap();
        let mut harness = Harness { child, listener, front: None, inbox: Vec::new(), dir };
        harness.accept_front();
        harness
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 等前台（`fake_front`）連進來。
    fn accept_front(&mut self) {
        let deadline = Instant::now() + WAIT;
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(Duration::from_millis(100))).unwrap();
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
        let request = FrontRequest::Ensure { thread_id: thread.as_bytes().to_vec(), open: OpenMode::Run };
        self.front.as_mut().unwrap().write_all(&frame(&encode_front_request(&request))).unwrap();
    }

    /// 下一則給前台的訊息；前台的連線斷了（監督行程收掉了前台）回 `None`。
    fn next_event(&mut self) -> Option<FrontEvent> {
        let deadline = Instant::now() + WAIT;
        let front = self.front.as_mut().unwrap();
        loop {
            if let Some(payload) = take_frame(&mut self.inbox).unwrap() {
                return Some(decode_front_event(&payload).unwrap());
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
                FrontEvent::Down { thread_id, cause } if thread_id == thread.as_bytes() => return cause,
                FrontEvent::Up { thread_id, .. } if thread_id == thread.as_bytes() => {}
                other => panic!("要 {thread} 的 down，拿到 {other:?}"),
            }
        }
    }

    fn audit(&self) -> Vec<String> {
        std::fs::read_to_string(self.dir.join("audit.jsonl")).unwrap_or_default().lines().map(String::from).collect()
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

fn log(socket: &Path) -> Vec<String> {
    std::fs::read_to_string(format!("{}.log", socket.display())).unwrap_or_default().lines().map(String::from).collect()
}

fn logged_pid(socket: &Path, key: &str) -> i32 {
    let mut pid = None;
    assert!(wait_until(|| {
        pid = log(socket).iter().find_map(|line| line.strip_prefix(&format!("{key} ")).map(|p| p.parse().unwrap()));
        pid.is_some()
    }));
    pid.unwrap()
}

#[test]
fn ensure_binds_and_reports_the_socket_in_a_private_run_dir() {
    let mut h = Harness::start(Options::default());
    let socket = h.up("a");
    assert_eq!(socket.parent().unwrap(), h.dir.join("run"));
    assert_eq!(std::fs::metadata(h.dir.join("run")).unwrap().mode() & 0o777, 0o700);
    assert_eq!(log(&socket)[1], "bind a");
    // 已經 up 的再要一次：同一個行程、同一個 socket。
    assert_eq!(h.up("a"), socket);
    assert_eq!(log(&socket).iter().filter(|l| l.starts_with("pid ")).count(), 1);
    assert!(h.audit().is_empty());
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
    assert!(h.audit_line("x,signal:9").contains("\"exit_code\":null,\"signal\":9"));
}

#[test]
fn dying_before_ready_is_crash_without_up() {
    let mut h = Harness::start(Options { conversation_args: vec!["--die-before-ready".into()], ..Options::default() });
    h.ensure("early");
    assert_eq!(h.event(), FrontEvent::Down { thread_id: b"early".to_vec(), cause: DeathCause::Crash });
    assert!(h.audit_line("early").contains("\"exit_code\":7"));
}

#[test]
fn failing_to_spawn_is_crash_with_the_error_audited() {
    let mut h = Harness::start(Options { conversation: PathBuf::from("/nonexistent/conversation"), ..Options::default() });
    h.ensure("nope");
    assert_eq!(h.event(), FrontEvent::Down { thread_id: b"nope".to_vec(), cause: DeathCause::Crash });
    let line = h.audit_line("nope");
    assert!(line.contains("\"pid\":0") && line.contains("\"error\":"), "{line}");
}

#[test]
fn undecodable_frame_gets_killed_as_crash() {
    let mut h = Harness::start(Options::default());
    h.ensure("g,garbage");
    assert_eq!(h.event(), FrontEvent::Down { thread_id: b"g,garbage".to_vec(), cause: DeathCause::Crash });
    assert!(h.audit_line("g,garbage").contains("\"signal\":9"));
}

#[test]
fn binding_the_wrong_thread_gets_killed_as_crash() {
    let mut h = Harness::start(Options::default());
    h.ensure("w,wrong-bound");
    assert_eq!(h.event(), FrontEvent::Down { thread_id: b"w,wrong-bound".to_vec(), cause: DeathCause::Crash });
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
            FrontEvent::Down { thread_id, cause } => downs.push((String::from_utf8(thread_id).unwrap(), cause)),
            other => panic!("要 down，拿到 {other:?}"),
        }
    }
    downs.sort_by(|a, b| a.0.cmp(&b.0));
    let names: Vec<&str> = downs.iter().map(|(t, _)| t.as_str()).collect();
    assert_eq!(names, ["e,ignore-eof", "plain", "t,ignore-term,grandchild"]);
    assert!(downs.iter().all(|(_, cause)| *cause == DeathCause::Shutdown), "{downs:?}");
    // 對話行程都收完才收前台：前台讀到 EOF、結束，連線斷掉。
    assert_eq!(h.next_event(), None);
    assert!(h.wait_exit().success());

    assert_eq!(log(&plain)[2..], ["eof"]);
    assert_eq!(log(&eof)[2..], ["eof", "sigterm"]);
    assert_eq!(log(&term)[2..], ["grandchild ".to_string() + &grandchild.to_string(), "eof".to_string()]);
    assert!(gone(grandchild));
    assert!(h.audit_line("\"thread\":\"plain\"").contains("\"cause\":\"shutdown\""));
    assert!(h.audit_line("e,ignore-eof").contains("\"exit_code\":0"));
    assert!(h.audit_line("t,ignore-term").contains("\"signal\":9"));
    assert!(h.audit_line("\"role\":\"front\"").contains("\"exit_code\":0"));
}

#[test]
fn second_stop_signal_kills_at_once() {
    let mut h = Harness::start(Options { eof_grace_ms: 600_000, term_grace_ms: 600_000, ..Options::default() });
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
    let mut h = Harness::start(Options { eof_grace_ms: 600_000, term_grace_ms: 600_000, ..Options::default() });
    let socket = h.up("t,ignore-term");
    kill(h.pid(), libc::SIGTERM);
    assert!(wait_until(|| log(&socket).contains(&"eof".to_string())));
    h.ensure("late");
    assert_eq!(h.event(), FrontEvent::Down { thread_id: b"late".to_vec(), cause: DeathCause::Shutdown });
}

#[test]
fn sigkilled_supervisor_leaves_no_orphan_conversations() {
    let mut h = Harness::start(Options::default());
    let a = logged_pid(&h.up("a"), "pid");
    let b = logged_pid(&h.up("b,ignore-term"), "pid");
    kill(h.pid(), libc::SIGKILL);
    h.wait_exit();
    assert!(wait_until(|| gone(a) && gone(b)), "對話行程 {a} 或 {b} 還在");
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
            FrontEvent::Up { thread_id: b"a".to_vec(), socket: socket(&a) },
            FrontEvent::Up { thread_id: b"b".to_vec(), socket: socket(&b) },
        ]
    );
    assert!(h.audit_line("\"role\":\"front\"").contains("\"exit_code\":0"));
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
        .args(["--run-dir", dir.join("run").to_str().unwrap(), "--audit", "/nonexistent/dir/audit.jsonl"])
        .args(["--front", "/bin/true", "--conversation", "/bin/true"])
        .stderr(Stdio::null())
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(1));
}

#[test]
fn bad_arguments_exit_2() {
    let status = Command::new(SUPERVISOR).arg("--nope").stderr(Stdio::null()).status().unwrap();
    assert_eq!(status.code(), Some(2));
}
