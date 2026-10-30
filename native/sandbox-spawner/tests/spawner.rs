//! 真的 spawner、真的核心（#1946）。只在 Linux 跑；核心沒有 Landlock 時整組跳過，
//! 但設了 `NEXUS_REQUIRE_LANDLOCK=1`（CI）就改成紅，免得跳過看起來跟綠燈一樣。
//!
//! 需要 `--features test-hooks`（partial 那條用它把 ABI 壓低，啟動前訊號那條用它延後子行程的 setsid）。

use nexus_sandbox_spawner::protocol::{self, Event, FailKind, Mode, Request, Spawn};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

const SPAWNER: &str = env!("CARGO_BIN_EXE_nexus-sandbox-spawner");

/// 探針複製到暫存目錄再用：建置目錄可能在 virtiofs 之類的掛載上（Docker Desktop 的 bind mount），Landlock 在那裡授權不到。
/// 用外部的 `cp` 複製：寫入的 fd 若開在測試行程裡，別的測試執行緒這時 fork 出去的子行程會帶著它，exec 探針就拿到 ETXTBSY。
fn probe() -> PathBuf {
    static COPY: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    COPY.get_or_init(|| {
        let built = Path::new(SPAWNER).parent().unwrap().join("examples/probe");
        let dir = temp_dir("probe");
        let copy = dir.join("probe");
        assert!(Command::new("cp").arg(&built).arg(&copy).status().unwrap().success());
        copy
    })
    .clone()
}

/// S5 的窄讀清單（`.docs/nexus-cordis-rust-feasibility-2026-10-22.md` 的 S5），加上探針所在的目錄。
fn readable() -> Vec<Vec<u8>> {
    let mut roots: Vec<Vec<u8>> = ["/usr", "/bin", "/lib", "/lib64", "/etc", "/proc"]
        .iter()
        .filter(|p| Path::new(p).exists())
        .map(|p| p.as_bytes().to_vec())
        .collect();
    roots.push(probe().parent().unwrap().to_str().unwrap().as_bytes().to_vec());
    roots
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nexus-spawner-{tag}-{}-{:?}", std::process::id(), Instant::now()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// 一個跑著的 spawner。
struct Spawner {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    socket: PathBuf,
    events: Vec<Event>,
    /// `Ready` 帶來的 Landlock ABI；沒有 `Ready` 就是 0。
    landlock_abi: u32,
}

/// 起 spawner，回它和第一筆事件（`Ready` 或 `Unavailable`）。`outer` 是在 exec spawner 之前先裝的外層過濾器（測試設施專用）。
fn start_with(envs: &[(&str, &str)], outer: Option<Vec<libc::sock_filter>>) -> (Spawner, Event) {
    let dir = temp_dir("sock");
    let socket = dir.join("s");
    let mut cmd = Command::new(SPAWNER);
    cmd.arg("--listen").arg(&socket).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    cmd.env("SPAWNER_OWN_ENV", "leak");
    for (k, v) in envs {
        cmd.env(k, v);
    }
    if let Some(filter) = outer {
        // SAFETY：pre_exec 裡只做兩個 prctl；filter 在 fork 之前就配置好了。
        unsafe {
            cmd.pre_exec(move || {
                let fprog = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_ptr() as *mut _ };
                if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
                    || libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &fprog as *const _) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = cmd.spawn().unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut s = Spawner { child, stdin, stdout, socket, events: Vec::new(), landlock_abi: 0 };
    let first = s.next_event();
    if let Event::Ready { landlock_abi, .. } = first {
        s.landlock_abi = landlock_abi;
    }
    (s, first)
}

impl Spawner {
    fn next_event(&mut self) -> Event {
        let mut len = [0u8; 4];
        self.stdout.read_exact(&mut len).expect("spawner 的 stdout 斷了");
        let mut payload = vec![0u8; u32::from_le_bytes(len) as usize];
        self.stdout.read_exact(&mut payload).unwrap();
        protocol::decode_event(&payload).unwrap()
    }

    /// 等到 `id` 的下一筆事件；別的 id 的事件先收著。
    fn event_for(&mut self, id: u32) -> Event {
        if let Some(i) = self.events.iter().position(|e| event_id(e) == Some(id)) {
            return self.events.remove(i);
        }
        loop {
            let e = self.next_event();
            if event_id(&e) == Some(id) {
                return e;
            }
            self.events.push(e);
        }
    }

    fn send(&mut self, request: &Request) {
        self.stdin.write_all(&protocol::frame(&protocol::encode_request(request))).unwrap();
    }

    fn connect(&self, id: u32, fd: u32) -> UnixStream {
        let mut s = UnixStream::connect(&self.socket).unwrap();
        s.write_all(&[id.to_le_bytes(), fd.to_le_bytes()].concat()).unwrap();
        s
    }

    /// 送一個要求、接上 stdout（與 stdin，要的話），回 stdout 的連線與 `Started`／`Failed`。
    fn launch(&mut self, spawn: Spawn) -> (Option<UnixStream>, Option<UnixStream>, Event) {
        let id = spawn.id;
        let pipes = spawn.pipes;
        self.send(&Request::Spawn(spawn));
        let stdin = (pipes & 1 != 0).then(|| self.connect(id, 0));
        let stdout = (pipes & 2 != 0).then(|| self.connect(id, 1));
        let event = self.event_for(id);
        (stdin, stdout, event)
    }

    /// 跑完一支指令，回 stdout 與結束事件。
    fn run(&mut self, spawn: Spawn) -> (String, Event) {
        let id = spawn.id;
        let (_, stdout, started) = self.launch(spawn);
        assert!(matches!(started, Event::Started { .. }), "{started:?}");
        let mut out = String::new();
        stdout.unwrap().read_to_string(&mut out).unwrap();
        (out, self.event_for(id))
    }
}

fn event_id(e: &Event) -> Option<u32> {
    match e {
        Event::Started { id, .. } | Event::Failed { id, .. } | Event::Exited { id, .. } => Some(*id),
        _ => None,
    }
}

fn bytes(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

fn request(id: u32, ws: &Path, argv: &[&str]) -> Spawn {
    Spawn {
        id,
        mode: Mode::WorkspaceWrite,
        pipes: 0b010,
        cwd: bytes(ws.to_str().unwrap()),
        readable: readable(),
        writable: vec![bytes(ws.to_str().unwrap())],
        argv: argv.iter().map(|a| bytes(a)).collect(),
        env: vec![bytes("PATH=/usr/bin:/bin")],
    }
}

/// 起一個正常的 spawner；核心沒有 Landlock 時回 None（`NEXUS_REQUIRE_LANDLOCK=1` 時直接紅）。
fn start() -> Option<Spawner> {
    let (s, first) = start_with(&[], None);
    match first {
        Event::Ready { filter_insns, landlock_abi } => {
            assert!(filter_insns > 10 && landlock_abi >= 1);
            Some(s)
        }
        Event::Unavailable { .. } if std::env::var("NEXUS_REQUIRE_LANDLOCK").as_deref() != Ok("1") => {
            eprintln!("跳過：這個核心沒有 Landlock（{first:?}）");
            None
        }
        other => panic!("spawner 沒有準備好：{other:?}"),
    }
}

macro_rules! spawner {
    () => {
        match start() {
            Some(s) => s,
            None => return,
        }
    };
}

fn probe_line(s: &mut Spawner, id: u32, ws: &Path, args: &[&str]) -> String {
    let p = probe();
    let argv: Vec<&str> = std::iter::once(p.to_str().unwrap()).chain(args.iter().copied()).collect();
    let (out, exit) = s.run(request(id, ws, &argv));
    assert!(matches!(exit, Event::Exited { code: 0, .. }), "{args:?}: {exit:?}");
    out.trim().to_string()
}

/// 還活著（存在、而且不是等人收屍的殭屍）。容器裡的 PID 1 不一定會收孤兒，殭屍不算活著。
fn alive(pid: &str) -> bool {
    std::fs::read_to_string(format!("/proc/{pid}/stat"))
        .map(|stat| stat.rsplit(") ").next().is_some_and(|rest| !rest.starts_with('Z')))
        .unwrap_or(false)
}

/// 訊號送出之後要一小段時間才生效：行程先關掉檔案（讀的一方因此看到 EOF），之後才變成殭屍。
fn dies_soon(pid: &str) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    while alive(pid) {
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    true
}

fn errno_line(e: i32) -> String {
    format!("errno={e}")
}

#[test]
fn s5_writes_inside_the_workspace_and_blocks_outside_secret_tcp_and_udp() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let outside = temp_dir("outside");
    std::fs::write(outside.join("token"), "secret").unwrap();
    let inside = ws.join("t");
    assert_eq!(probe_line(&mut s, 1, &ws, &["write", inside.to_str().unwrap()]), "ok");
    assert_eq!(std::fs::read_to_string(&inside).unwrap(), "x");
    assert_eq!(
        probe_line(&mut s, 2, &ws, &["write", outside.join("w").to_str().unwrap()]),
        errno_line(libc::EACCES)
    );
    assert_eq!(
        probe_line(&mut s, 3, &ws, &["read", outside.join("token").to_str().unwrap()]),
        errno_line(libc::EACCES)
    );
    assert_eq!(probe_line(&mut s, 4, &ws, &["tcp"]), errno_line(libc::EACCES));
    assert_eq!(probe_line(&mut s, 5, &ws, &["udp"]), errno_line(libc::EACCES));
    assert_eq!(probe_line(&mut s, 6, &ws, &["udp6"]), errno_line(libc::EACCES));
}

#[test]
fn read_only_mode_ignores_the_writable_roots() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let p = probe();
    let target = ws.join("t");
    let mut r = request(1, &ws, &[p.to_str().unwrap(), "write", target.to_str().unwrap()]);
    r.mode = Mode::ReadOnly;
    r.readable.push(bytes(ws.to_str().unwrap()));
    let (out, _) = s.run(r);
    assert_eq!(out.trim(), errno_line(libc::EACCES));
    assert!(!target.exists());
}

#[test]
fn s1_rules_fire_inside_the_child() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let eperm = errno_line(libc::EPERM);
    let cases: Vec<(&str, String)> = vec![
        ("unix", eperm.clone()),
        ("vsock", eperm.clone()),
        ("socketpair", "ok".into()),
        ("uring", errno_line(libc::EACCES)),
        ("uring-enter", eperm.clone()),
        ("uring-register", eperm.clone()),
        ("unshare", eperm.clone()),
        ("setns", eperm.clone()),
        ("clone-newuser", eperm.clone()),
        ("clone3", errno_line(libc::ENOSYS)),
        ("thread", "ok".into()),
    ];
    for (i, (what, want)) in cases.iter().enumerate() {
        assert_eq!(&probe_line(&mut s, 10 + i as u32, &ws, &[what]), want, "{what}");
    }
    // mount 系列 10 條：參數全是 -1，沒被擋的話核心回的是 EBADF／EINVAL／EFAULT，不是 EPERM。
    for (i, nr) in nexus_sandbox_spawner::seccomp::MOUNT_SYSCALLS.iter().enumerate() {
        assert_eq!(probe_line(&mut s, 100 + i as u32, &ws, &["syscall", &nr.to_string()]), eperm, "nr {nr}");
    }
}

#[cfg(target_arch = "x86_64")]
#[test]
fn x32_and_i386_calls_kill_the_child() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let p = probe();
    for (id, what) in [(1, "x32"), (2, "i386")] {
        let (_, exit) = s.run(request(id, &ws, &[p.to_str().unwrap(), what]));
        assert_eq!(exit, Event::Exited { id, code: -1, signal: libc::SIGSYS }, "{what}");
    }
}

#[test]
fn stdin_and_stdout_reach_the_child_and_the_exit_code_comes_back() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let mut r = request(1, &ws, &["/bin/sh", "-c", "cat; exit 3"]);
    r.pipes = 0b011;
    let (stdin, stdout, started) = s.launch(r);
    assert!(matches!(started, Event::Started { id: 1, partial: false, .. }), "{started:?}");
    let mut stdin = stdin.unwrap();
    stdin.write_all(b"a\tb\nc").unwrap();
    drop(stdin);
    let mut out = String::new();
    stdout.unwrap().read_to_string(&mut out).unwrap();
    assert_eq!(out, "a\tb\nc");
    assert_eq!(s.event_for(1), Event::Exited { id: 1, code: 3, signal: 0 });
}

#[test]
fn the_child_gets_exactly_the_requested_environment() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let mut r = request(1, &ws, &["env"]);
    r.env.push(bytes("ONLY=this"));
    let (out, _) = s.run(r);
    let mut lines: Vec<&str> = out.lines().collect();
    lines.sort();
    assert_eq!(lines, vec!["ONLY=this", "PATH=/usr/bin:/bin"]);
}

#[test]
fn a_missing_start_dir_is_not_reported_as_sandbox_unavailable() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let mut r = request(1, &ws, &["/bin/true"]);
    r.cwd = bytes(ws.join("gone").to_str().unwrap());
    let (_, _, event) = s.launch(r);
    assert!(matches!(event, Event::Failed { id: 1, kind: FailKind::StartDir, errno: libc::ENOENT, .. }), "{event:?}");
}

#[test]
fn an_unopenable_grant_fails_closed_instead_of_shrinking() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let mut r = request(1, &ws, &["/bin/true"]);
    r.writable.push(bytes(ws.join("missing").to_str().unwrap()));
    let (_, _, event) = s.launch(r);
    assert!(matches!(event, Event::Failed { id: 1, kind: FailKind::SandboxUnavailable, .. }), "{event:?}");
}

#[test]
fn exec_failures_carry_the_execvp_errno() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    std::fs::write(ws.join("not-exec"), "#!/bin/sh\n").unwrap();
    let cases = [
        (1, "no-such-tool".to_string(), libc::ENOENT),
        (2, ws.join("not-exec").to_str().unwrap().to_string(), libc::EACCES),
    ];
    for (id, argv0, want) in cases {
        let (_, _, event) = s.launch(request(id, &ws, &[&argv0]));
        assert!(matches!(event, Event::Failed { kind: FailKind::Exec, errno, .. } if errno == want), "{argv0}: {event:?}");
    }
    // 沒有 `/` 的 argv[0] 照要求帶來的 PATH 找。
    let (out, _) = s.run(request(3, &ws, &["echo", "found"]));
    assert_eq!(out, "found\n");
}

#[test]
fn signals_reach_the_whole_group_and_the_group_dies_with_the_leader() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    // leader 收到 SIGTERM 後還活 3 秒：背景成員要在這段時間內就死，才證明訊號送到了整個群組，而不是 leader 結束時順便收掉。
    let (_, stdout, _) = s.launch(request(1, &ws, &["/bin/sh", "-c", "trap 'sleep 3' TERM; sleep 100 & echo $!; wait"]));
    let mut stdout = stdout.unwrap();
    let mut line = [0u8; 32];
    let n = stdout.read(&mut line).unwrap();
    let background: i32 = String::from_utf8_lossy(&line[..n]).trim().parse().unwrap();
    // 等背景成員 exec 成 sleep 再送：dash fork 出來、還沒清掉 trap 的那一小段，SIGTERM 會被 trap 接走、清 trap 時丟掉。
    let deadline = Instant::now() + Duration::from_secs(5);
    while std::fs::read_to_string(format!("/proc/{background}/comm")).map_or(true, |c| c.trim() != "sleep") {
        assert!(Instant::now() < deadline, "背景成員沒有 exec 成 sleep");
        std::thread::sleep(Duration::from_millis(5));
    }
    s.send(&Request::Signal { id: 1, signo: libc::SIGTERM });
    assert!(dies_soon(&background.to_string()), "背景成員還在");
    assert!(matches!(s.event_for(1), Event::Exited { id: 1, .. }));

    // leader 自己先結束：留在背景的成員一起收掉，stdout 也因此關上（沒收掉的話 sleep 抓著 stdout，讀到期限就紅）。
    let (_, stdout, _) = s.launch(request(2, &ws, &["/bin/sh", "-c", "sleep 100 & echo $!"]));
    let mut stdout = stdout.unwrap();
    stdout.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let mut out = String::new();
    stdout.read_to_string(&mut out).expect("stdout 沒有關上");
    assert_eq!(s.event_for(2), Event::Exited { id: 2, code: 0, signal: 0 });
    assert!(dies_soon(out.trim()), "背景成員還在");
}

#[test]
fn protocol_errors_get_a_failed_event() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let (_, _, event) = s.launch(Spawn { argv: vec![], ..request(1, &ws, &[]) });
    assert!(matches!(event, Event::Failed { id: 1, kind: FailKind::Protocol, .. }), "{event:?}");
    let (_, _, event) = s.launch(Spawn { argv: vec![b"a\0b".to_vec()], ..request(2, &ws, &[]) });
    assert!(matches!(event, Event::Failed { id: 2, kind: FailKind::Protocol, .. }), "{event:?}");
    let (_, _, event) = s.launch(Spawn { argv: vec![vec![]], ..request(4, &ws, &[]) });
    assert!(matches!(event, Event::Failed { id: 4, kind: FailKind::Protocol, .. }), "{event:?}");
    // 同一個 id 還在跑時再要一次。
    let (_, _, started) = s.launch(request(3, &ws, &["sleep", "100"]));
    assert!(matches!(started, Event::Started { .. }));
    let (_, _, event) = s.launch(request(3, &ws, &["/bin/true"]));
    assert!(matches!(event, Event::Failed { id: 3, kind: FailKind::Protocol, .. }), "{event:?}");
}

#[test]
fn connections_from_another_process_are_rejected_and_the_request_times_out() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    s.send(&Request::Spawn(request(1, &ws, &["/bin/true"])));
    // 別的行程替 id 1 接 stdout：spawner 核 SO_PEERCRED 的 pid 不是自己的父行程，直接關掉。
    let mut intruder = Command::new(probe()).args(["connect", s.socket.to_str().unwrap(), "1", "1"]).spawn().unwrap();
    let started = Instant::now();
    let event = s.event_for(1);
    intruder.kill().ok();
    intruder.wait().ok();
    assert!(matches!(event, Event::Failed { id: 1, kind: FailKind::Protocol, .. }), "{event:?}");
    assert!(started.elapsed() >= Duration::from_secs(4), "應該是等到期限才失敗");
}

#[test]
fn many_concurrent_spawns_all_finish() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let mut outs = Vec::new();
    for id in 0..32 {
        let (_, stdout, started) = s.launch(request(id, &ws, &["echo", &id.to_string()]));
        assert!(matches!(started, Event::Started { .. }), "{started:?}");
        outs.push((id, stdout.unwrap()));
    }
    for (id, mut stdout) in outs {
        let mut out = String::new();
        stdout.read_to_string(&mut out).unwrap();
        assert_eq!(out, format!("{id}\n"));
        assert_eq!(s.event_for(id), Event::Exited { id, code: 0, signal: 0 });
    }
    // fork 之後子行程會配置記憶體，只有單執行緒才安全：跑過一輪之後 spawner 還是只有一條執行緒。
    let status = std::fs::read_to_string(format!("/proc/{}/status", s.child.id())).unwrap();
    assert!(status.lines().any(|l| l == "Threads:\t1"), "{status}");
}

#[test]
fn partial_landlock_still_runs_and_says_so() {
    let (mut s, first) = start_with(&[("NEXUS_SPAWNER_TEST_ABI_CAP", "3")], None);
    if !matches!(first, Event::Ready { .. }) {
        assert_ne!(std::env::var("NEXUS_REQUIRE_LANDLOCK").as_deref(), Ok("1"), "{first:?}");
        return;
    }
    assert!(matches!(first, Event::Ready { landlock_abi: 3, .. }), "{first:?}");
    let ws = temp_dir("ws");
    let (_, stdout, started) = s.launch(request(1, &ws, &["echo", "hi"]));
    assert!(matches!(started, Event::Started { partial: true, .. }), "{started:?}");
    let mut out = String::new();
    stdout.unwrap().read_to_string(&mut out).unwrap();
    assert_eq!(out, "hi\n");
    // 全權模式不上 Landlock，談不上部分生效。
    let (_, _, started) = s.launch(full_access(2, &ws, &["echo", "hi"]));
    assert!(matches!(started, Event::Started { id: 2, partial: false, .. }), "{started:?}");
}

/// 測試設施的外層過濾器：`nr` 這條 syscall（第一個參數等於 `arg0` 時）回 `err`，其餘放行。
fn outer_filter(nr: i64, arg0: Option<u32>, err: i32) -> Vec<libc::sock_filter> {
    let f = |code: u16, jt: u8, jf: u8, k: u32| libc::sock_filter { code, jt, jf, k };
    let ret = 0x0005_0000 | err as u32;
    match arg0 {
        None => vec![f(0x20, 0, 0, 0), f(0x15, 0, 1, nr as u32), f(0x06, 0, 0, ret), f(0x06, 0, 0, 0x7fff_0000)],
        Some(v) => vec![
            f(0x20, 0, 0, 0),
            f(0x15, 0, 3, nr as u32),
            f(0x20, 0, 0, 16),
            f(0x15, 0, 1, v),
            f(0x06, 0, 0, ret),
            f(0x06, 0, 0, 0x7fff_0000),
        ],
    }
}

/// 全權模式的要求：不帶讀根、寫根，工作目錄是 `ws`。
fn full_access(id: u32, ws: &Path, argv: &[&str]) -> Spawn {
    Spawn { mode: Mode::FullAccess, readable: Vec::new(), writable: Vec::new(), ..request(id, ws, argv) }
}

/// 全權模式不上 Landlock：工作區外寫得進、讀得到；seccomp 照樣擋網路與 namespace。
fn assert_full_access_skips_landlock_but_not_seccomp(s: &mut Spawner) {
    let ws = temp_dir("ws");
    let outside = temp_dir("outside");
    std::fs::write(outside.join("token"), "secret").unwrap();
    let p = probe();
    let p = p.to_str().unwrap();
    let target = outside.join("w");
    let (_, stdout, started) = s.launch(full_access(1, &ws, &[p, "write", target.to_str().unwrap()]));
    assert!(matches!(started, Event::Started { id: 1, partial: false, .. }), "{started:?}");
    let mut out = String::new();
    stdout.unwrap().read_to_string(&mut out).unwrap();
    assert_eq!(out.trim(), "ok");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "x");
    let (out, _) = s.run(full_access(2, &ws, &[p, "read", outside.join("token").to_str().unwrap()]));
    assert_eq!(out.trim(), "ok");
    for (id, what) in [(3, "tcp"), (4, "udp")] {
        let (out, _) = s.run(full_access(id, &ws, &[p, what]));
        assert_eq!(out.trim(), errno_line(libc::EACCES), "{what}");
    }
    let (out, _) = s.run(full_access(5, &ws, &[p, "unshare"]));
    assert_eq!(out.trim(), errno_line(libc::EPERM));
}

#[test]
fn full_access_skips_landlock_but_keeps_seccomp() {
    let mut s = spawner!();
    assert_full_access_skips_landlock_but_not_seccomp(&mut s);
}

#[test]
fn without_landlock_only_full_access_starts() {
    let (mut s, first) = start_with(&[], Some(outer_filter(libc::SYS_landlock_create_ruleset, None, libc::ENOSYS)));
    assert!(matches!(first, Event::Ready { landlock_abi: 0, .. }), "{first:?}");
    let ws = temp_dir("ws");
    for (id, mode) in [(10, Mode::ReadOnly), (11, Mode::WorkspaceWrite)] {
        let (_, _, event) = s.launch(Spawn { mode, ..request(id, &ws, &["/bin/true"]) });
        assert!(
            matches!(event, Event::Failed { kind: FailKind::SandboxUnavailable, errno: libc::ENOSYS, .. }),
            "{mode:?}: {event:?}"
        );
    }
    assert_full_access_skips_landlock_but_not_seccomp(&mut s);
}

/// 訊號只送得到同一個 Landlock domain 裡的行程（ABI 6 起）；ABI 壓到 5 就沒有這一層。
#[test]
fn abi_6_keeps_signals_inside_the_tool() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let (out, _) = s.run(request(1, &ws, &["/bin/sh", "-c", "sleep 1 & kill -0 $! && echo ok"]));
    assert_eq!(out.trim(), "ok", "同一個 domain 裡的後代要送得到");
    let abi = s.landlock_abi;
    if abi < 6 {
        assert_ne!(std::env::var("NEXUS_REQUIRE_LANDLOCK").as_deref(), Ok("1"), "Landlock ABI 是 {abi}，要 6");
        eprintln!("跳過：這個核心的 Landlock ABI 是 {abi}，沒有訊號 scope");
        return;
    }
    let spawner_pid = s.child.id().to_string();
    let me = std::process::id().to_string();
    for (id, target) in [(2, &spawner_pid), (3, &me)] {
        assert_eq!(probe_line(&mut s, id, &ws, &["kill", target]), errno_line(libc::EPERM), "{target}");
    }
    let (mut capped, first) = start_with(&[("NEXUS_SPAWNER_TEST_ABI_CAP", "5")], None);
    assert!(matches!(first, Event::Ready { landlock_abi: 5, .. }), "{first:?}");
    assert_eq!(probe_line(&mut capped, 4, &ws, &["kill", &me]), "ok");
}

/// 開著的 fd。
fn open_fds(pid: u32) -> Vec<i32> {
    std::fs::read_dir(format!("/proc/{pid}/fd"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_str().unwrap().parse().unwrap())
        .collect()
}

#[test]
fn running_out_of_fds_for_dev_null_fails_with_resource_and_leaks_nothing() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    let pid = s.child.id();
    let before = open_fds(pid);
    // 新開的 fd 取最小的空號，所以上限設在第二個空號之上：只開得了兩個，三個 /dev/null 開到第三個失敗。
    // 開著的 fd 中間可能有空號（CI 的 runner 上就有），不能用「最大的 fd 之上留兩格」。硬上限不動：降了之後一般使用者調不回來。
    let second_free = (0..).filter(|fd| !before.contains(fd)).nth(1).unwrap();
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY：讀、改自己起的 spawner 的上限，limit 是本地值。
    unsafe {
        assert_eq!(libc::prlimit(pid as libc::pid_t, libc::RLIMIT_NOFILE, std::ptr::null(), &mut limit), 0);
        limit.rlim_cur = (second_free + 1) as libc::rlim_t;
        assert_eq!(libc::prlimit(pid as libc::pid_t, libc::RLIMIT_NOFILE, &limit, std::ptr::null_mut()), 0);
    }
    let (_, _, event) = s.launch(Spawn { pipes: 0, ..request(1, &ws, &["/bin/true"]) });
    assert!(matches!(&event, Event::Failed { id: 1, kind: FailKind::Resource, errno: libc::EMFILE, detail } if detail == b"open /dev/null"), "{event:?}");
    assert_eq!(open_fds(pid).len(), before.len());
}

#[test]
fn seccomp_that_cannot_be_installed_means_unavailable() {
    let filter = outer_filter(libc::SYS_prctl, Some(libc::PR_SET_SECCOMP as u32), libc::EINVAL);
    let (mut s, first) = start_with(&[], Some(filter));
    if matches!(&first, Event::Unavailable { detail, .. } if detail.starts_with("Landlock".as_bytes())) {
        assert_ne!(std::env::var("NEXUS_REQUIRE_LANDLOCK").as_deref(), Ok("1"));
        return;
    }
    assert!(matches!(&first, Event::Unavailable { errno: libc::EINVAL, detail } if detail.starts_with(b"seccomp")), "{first:?}");
    assert_eq!(s.child.wait().unwrap().code(), Some(125));
}

#[test]
fn closing_stdin_or_sigterm_kills_every_running_tool() {
    for how in ["eof", "sigterm"] {
        let mut s = spawner!();
        let ws = temp_dir("ws");
        // 看背景成員：leader 有 PDEATHSIG，spawner 一死它就跟著死；背景成員只有群組 SIGKILL 收得掉。
        let (_, stdout, _) = s.launch(request(1, &ws, &["/bin/sh", "-c", "sleep 100 & echo $!; wait"]));
        let mut line = [0u8; 32];
        let n = stdout.unwrap().read(&mut line).unwrap();
        let pid = String::from_utf8_lossy(&line[..n]).trim().to_string();
        if how == "eof" {
            drop(s.stdin);
        } else {
            // SAFETY：送給自己起的 spawner。
            unsafe { libc::kill(s.child.id() as i32, libc::SIGTERM) };
            // 還在跑的工具照樣收到結局。
            assert_eq!(s.event_for(1), Event::Exited { id: 1, code: -1, signal: libc::SIGKILL });
        }
        assert_eq!(exits_within(&mut s.child, Duration::from_secs(5)), Some(0), "{how}");
        assert!(dies_soon(&pid), "{how}：工具還在");
    }
}

#[test]
fn a_signal_sent_before_start_arrives_after_start() {
    // 子行程在 setsid 之前先睡 0.3 秒：這時對群組送訊號一定打不到（ESRCH），要等 Started 才送。
    let (mut s, first) = start_with(&[("NEXUS_SPAWNER_TEST_CHILD_DELAY_US", "300000")], None);
    if !matches!(first, Event::Ready { .. }) {
        assert_ne!(std::env::var("NEXUS_REQUIRE_LANDLOCK").as_deref(), Ok("1"), "{first:?}");
        return;
    }
    let ws = temp_dir("ws");
    // 要求與訊號同一次寫進去：spawner 處理訊號時，子行程還在 Launching。訊號弄丟的話，sleep 5 會自己正常結束。
    let spawn = Request::Spawn(Spawn { pipes: 0, ..request(1, &ws, &["sleep", "5"]) });
    let signal = Request::Signal { id: 1, signo: libc::SIGTERM };
    let bytes = [protocol::frame(&protocol::encode_request(&spawn)), protocol::frame(&protocol::encode_request(&signal))].concat();
    s.stdin.write_all(&bytes).unwrap();
    assert!(matches!(s.event_for(1), Event::Started { id: 1, .. }));
    assert_eq!(s.event_for(1), Event::Exited { id: 1, code: -1, signal: libc::SIGTERM });
}

/// 等 spawner 自己結束，最多 `limit`；回結束碼。
fn exits_within(child: &mut Child, limit: Duration) -> Option<i32> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            return Some(status.code().unwrap_or(-1));
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    child.kill().ok();
    None
}

#[test]
fn an_undecodable_frame_ends_the_spawner_and_its_tools() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    // 看背景成員：leader 有 PDEATHSIG，spawner 只要結束它就會死，分不出有沒有收尾。
    let (_, stdout, _) = s.launch(request(1, &ws, &["/bin/sh", "-c", "sleep 100 & echo $!; wait"]));
    let mut line = [0u8; 32];
    let n = stdout.unwrap().read(&mut line).unwrap();
    let pid = String::from_utf8_lossy(&line[..n]).trim().to_string();
    s.stdin.write_all(&protocol::frame(b"Z")).unwrap();
    assert_eq!(exits_within(&mut s.child, Duration::from_secs(5)), Some(0));
    assert!(dies_soon(&pid), "工具還在");
}

#[test]
fn losing_the_event_channel_ends_the_spawner() {
    let Spawner { mut child, mut stdin, stdout, .. } = spawner!();
    drop(stdout);
    let ws = temp_dir("ws");
    // 下一筆事件寫不出去：stdin 還開著，spawner 也要自己收尾。
    let spawn = Request::Spawn(Spawn { pipes: 0, ..request(1, &ws, &["/bin/true"]) });
    stdin.write_all(&protocol::frame(&protocol::encode_request(&spawn))).unwrap();
    assert_eq!(exits_within(&mut child, Duration::from_secs(5)), Some(0));
}

#[test]
fn a_signal_sent_while_waiting_for_stdio_arrives_after_start() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    // stdout 還沒接上，spawner 還沒 fork；訊號弄丟的話，sleep 5 會自己正常結束。
    s.send(&Request::Spawn(request(1, &ws, &["sleep", "5"])));
    s.send(&Request::Signal { id: 1, signo: libc::SIGTERM });
    let _stdout = s.connect(1, 1);
    assert!(matches!(s.event_for(1), Event::Started { id: 1, .. }));
    assert_eq!(s.event_for(1), Event::Exited { id: 1, code: -1, signal: libc::SIGTERM });
}

#[test]
fn a_request_still_waiting_for_stdio_fails_when_the_spawner_stops() {
    let mut s = spawner!();
    let ws = temp_dir("ws");
    s.send(&Request::Spawn(request(1, &ws, &["/bin/true"])));
    // 等這筆要求進了 spawner 再叫它結束：先跑完一筆不接 stdio 的，控制通道是依序處理的。
    s.send(&Request::Spawn(Spawn { pipes: 0, ..request(2, &ws, &["/bin/true"]) }));
    assert!(matches!(s.event_for(2), Event::Started { id: 2, .. }));
    assert!(matches!(s.event_for(2), Event::Exited { id: 2, code: 0, .. }));
    // SAFETY：送給自己起的 spawner。
    unsafe { libc::kill(s.child.id() as i32, libc::SIGTERM) };
    assert!(matches!(s.event_for(1), Event::Failed { id: 1, kind: FailKind::Resource, .. }));
    assert_eq!(exits_within(&mut s.child, Duration::from_secs(5)), Some(0));
}
