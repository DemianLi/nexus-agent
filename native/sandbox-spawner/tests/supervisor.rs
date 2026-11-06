//! 真的監督行程、真的子行程（#2340）。只在 Linux 跑。
//!
//! 前台與對話行程是 `examples/` 的兩支假程式：`fake_front` 把監督行程的前台通道轉到這裡聽著的 Unix socket，測試就站在前台的位置；
//! `fake_conversation` 照協定回 `ready`／`bound`，之後照 thread id 做事、把收到的 EOF 與 SIGTERM 記進 `<socket>.log`。
//! 等待一律寫成「最多等多久、條件成立就過」，不拿牆鐘時間當斷言。空轉測試例外：固定量兩秒的 CPU tick。

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

/// 行程不在了，或已經死了、只剩還沒被收的 zombie。
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
    /// 多給監督行程的參數。
    extra: Vec<&'static str>,
    /// 監督行程的 stderr 丟掉，不寫進 `supervisor.err`。
    discard_stderr: bool,
    /// 監督行程的 stderr 接一條讀端已經關掉的管線：每次寫都是 EPIPE。
    broken_stderr: bool,
    /// 監督行程的 stderr 接一條管線，讀端留在 `Harness::stderr`，測試不讀它就會滿。
    piped_stderr: bool,
}

impl Default for Options {
    fn default() -> Self {
        Options { conversation: example("fake_conversation"), conversation_args: Vec::new(), eof_grace_ms: 300, term_grace_ms: 300, extra: Vec::new(), discard_stderr: false, broken_stderr: false, piped_stderr: false }
    }
}

struct Harness {
    child: Child,
    listener: UnixListener,
    front: Option<UnixStream>,
    inbox: Vec<u8>,
    dir: PathBuf,
    stderr: Option<std::fs::File>,
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
        cmd.args(&options.extra);
        let mut stderr_read = None;
        let stderr = if options.piped_stderr {
            let mut fds = [0; 2];
            // SAFETY：拿一對新的 pipe。
            assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
            // SAFETY：兩端都是剛拿到的，各交給一個擁有者。
            stderr_read = Some(unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fds[0]) });
            Stdio::from(unsafe { <std::os::fd::OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fds[1]) })
        } else if options.broken_stderr {
            let mut fds = [0; 2];
            // SAFETY：拿一對新的 pipe，讀端當場關掉。
            assert_eq!(unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) }, 0);
            // SAFETY：fds 是剛拿到的。
            unsafe { libc::close(fds[0]) };
            // SAFETY：寫端交給 Stdio 擁有。
            Stdio::from(unsafe { <std::os::fd::OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fds[1]) })
        } else if options.discard_stderr {
            Stdio::null()
        } else {
            Stdio::from(std::fs::File::create(dir.join("supervisor.err")).unwrap())
        };
        let child = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(stderr).spawn().unwrap();
        let mut harness = Harness { child, listener, front: None, inbox: Vec::new(), dir, stderr: stderr_read };
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
    // 監督行程只有一條執行緒：PDEATHSIG 跟著起子行程的那條執行緒走。
    assert_eq!(std::fs::read_dir(format!("/proc/{}/task", h.pid())).unwrap().count(), 1);
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

    // plain 讀到 EOF 就結束；寬限只有幾百毫秒，忙的機器上它可能先收到 SIGTERM，所以只驗第一件事。
    assert_eq!(log(&plain)[2], "eof");
    assert_eq!(log(&eof)[2..], ["eof", "sigterm"]);
    assert_eq!(log(&term)[2..], ["grandchild ".to_string() + &grandchild.to_string(), "eof".to_string()]);
    assert!(wait_until(|| gone(grandchild)));
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
            FrontEvent::Down { thread_id: b"b".to_vec(), cause: DeathCause::Shutdown },
            FrontEvent::Down { thread_id: b"f,flood".to_vec(), cause: DeathCause::Shutdown },
        ]
    );
    assert!(h.wait_exit().success());
}

/// 等它結束（最多 `WAIT`），回結束碼；到時還在跑就殺掉、回 `None`。
fn exit_code(mut child: Child) -> Option<i32> {
    let mut code = None;
    if wait_until(|| child.try_wait().unwrap().map(|status| code = status.code()).is_some()) {
        return code;
    }
    kill(child.id(), libc::SIGKILL);
    child.wait().unwrap();
    None
}

fn supervisor_with_audit(dir: &Path, audit: &Path) -> Child {
    Command::new(SUPERVISOR)
        .args(["--run-dir", dir.join("run").to_str().unwrap(), "--audit", audit.to_str().unwrap()])
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
    assert!(wait_until(|| std::fs::read_to_string(&target).unwrap().contains("\"role\":\"front\"")));
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
    assert!(line.contains("\"cause\":\"heap\"") && line.contains("\"signal\":6"), "{line}");
    // stderr 原樣轉到監督行程的 stderr。
    assert!(wait_until(|| supervisor_stderr(&h).contains("Reached heap limit")));
    // 沒有那段訊息的 SIGABRT 是 crash。
    assert_eq!(h.down("a,signal:6"), DeathCause::Crash);
}

#[test]
fn heap_message_still_in_the_pipe_at_exit_is_read() {
    let mut h = Harness::start(Options { discard_stderr: true, ..Options::default() });
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
    let mut h = Harness::start(Options { extra: vec!["--rss-limit-mb", "64", "--rss-poll-ms", "50"], ..Options::default() });
    let small = h.up("small");
    assert_eq!(h.down("big,alloc:200"), DeathCause::Memory);
    let line = h.audit_line("\"thread\":\"big,alloc:200\"");
    assert!(line.contains("\"cause\":\"memory\"") && line.contains("\"signal\":9"), "{line}");
    let rss: u64 = line.split("\"rss_kb\":").nth(1).unwrap().split(',').next().unwrap().parse().unwrap();
    assert!(rss > 64 * 1024, "{line}");
    // 沒超過的那條還是同一個行程。
    assert_eq!(h.up("small"), small);
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.down_of("small"), DeathCause::Shutdown);
    assert!(!h.audit_line("\"thread\":\"small\"").contains("\"rss_kb\":0,"));
}

#[test]
fn flooding_stderr_does_not_starve_the_others() {
    let mut h = Harness::start(Options { discard_stderr: true, ..Options::default() });
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
            FrontEvent::Down { thread_id: b"b".to_vec(), cause: DeathCause::Shutdown },
            FrontEvent::Down { thread_id: b"s,stderr-flood".to_vec(), cause: DeathCause::Shutdown },
        ]
    );
    assert!(h.wait_exit().success());
}

#[test]
fn stderr_that_cannot_be_written_does_not_take_the_supervisor_down() {
    let mut h = Harness::start(Options { broken_stderr: true, ..Options::default() });
    // 綁錯 thread：監督行程自己印一行再殺掉它，那一行寫到 EPIPE。
    assert_eq!(h.down("a,wrong-bound"), DeathCause::Crash);
    h.up("b");
    assert!(h.child.try_wait().unwrap().is_none(), "監督行程不該結束");
}

/// 一個行程每條執行緒的 nice 值。
fn thread_nices(pid: i32) -> Vec<i64> {
    std::fs::read_dir(format!("/proc/{pid}/task"))
        .map(|tasks| {
            tasks
                .filter_map(|task| std::fs::read_to_string(task.ok()?.path().join("stat")).ok())
                .map(|stat| stat.rsplit_once(") ").unwrap().1.split(' ').nth(16).unwrap().parse().unwrap())
                .collect()
        })
        .unwrap_or_default()
}

fn audit_number(line: &str, key: &str) -> u64 {
    line.split(&format!("\"{key}\":")).nth(1).unwrap().split([',', '}']).next().unwrap().parse().unwrap()
}

#[test]
fn reports_stopping_after_bind_is_stalled() {
    // RSS 輪詢放到一分鐘：只有 stall 的期限會叫醒 poll。兩段寬限各 5 s：走拆除梯度的話 down 要 10 s 後才到。
    let mut h = Harness::start(Options {
        extra: vec!["--stall-ms", "300", "--rss-poll-ms", "60000", "--eof-grace-ms", "5000", "--term-grace-ms", "5000"],
        ..Options::default()
    });
    h.up("x,ignore-term,hang");
    let silent_since = Instant::now();
    assert_eq!(h.down_of("x,ignore-term,hang"), DeathCause::Stalled);
    assert!(silent_since.elapsed() < Duration::from_millis(2_000), "{:?}", silent_since.elapsed());
    let line = h.audit_line("\"thread\":\"x,ignore-term,hang\"");
    assert!(line.contains("\"cause\":\"stalled\""), "{line}");
    assert!(audit_number(&line, "max_silence_ms") < 300, "{line}");
}

#[test]
fn a_silence_shorter_than_the_limit_is_not_stalled() {
    let mut h = Harness::start(Options { extra: vec!["--stall-ms", "1500"], ..Options::default() });
    let socket = h.up("q,silent:600");
    // 沉默過去之後還是同一個行程。
    assert!(wait_until(|| log(&socket).len() >= 2));
    std::thread::sleep(Duration::from_millis(1_200));
    assert_eq!(h.up("q,silent:600"), socket);
    kill(h.pid(), libc::SIGTERM);
    assert_eq!(h.down_of("q,silent:600"), DeathCause::Shutdown);
    let silence = audit_number(&h.audit_line("\"thread\":\"q,silent:600\""), "max_silence_ms");
    assert!((600..1500).contains(&silence), "{silence}");
}

#[test]
fn supervisor_blocked_on_its_own_stderr_does_not_stall_the_healthy_ones() {
    let mut h = Harness::start(Options { extra: vec!["--stall-ms", "300"], piped_stderr: true, ..Options::default() });
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
            FrontEvent::Up { thread_id, socket: up } if thread_id == b"a" => {
                assert_eq!(PathBuf::from(String::from_utf8(up).unwrap()), socket);
                break;
            }
            FrontEvent::Up { .. } => {}
            other => panic!("要 a 的 up，拿到 {other:?}"),
        }
    }
}

#[test]
fn a_conversation_spinning_the_cpu_is_reniced_with_all_its_threads() {
    let mut h = Harness::start(Options { extra: vec!["--cpu-busy-ms", "300", "--rss-poll-ms", "50"], ..Options::default() });
    let idle = logged_pid(&h.up("q"), "pid");
    let spin = logged_pid(&h.up("s,spin"), "pid");
    assert!(wait_until(|| {
        let nices = thread_nices(spin);
        nices.len() >= 2 && nices.iter().all(|&n| n == 19)
    }), "{:?}", thread_nices(spin));
    let base = thread_nices(h.pid() as i32)[0];
    assert_ne!(base, 19);
    assert!(thread_nices(idle).iter().all(|&n| n == base), "{:?}", thread_nices(idle));
    kill(h.pid(), libc::SIGTERM);
    for _ in 0..2 {
        assert!(matches!(h.event(), FrontEvent::Down { cause: DeathCause::Shutdown, .. }));
    }
    assert!(h.audit_line("\"thread\":\"s,spin\"").contains("\"reniced\":true"));
    assert!(h.audit_line("\"thread\":\"q\"").contains("\"reniced\":false"));
}
