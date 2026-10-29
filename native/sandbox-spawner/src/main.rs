//! 常駐 spawner（#1946 S3）。由 Node 用 stdio pipe 起：stdin 收要求、stdout 送事件（格式見 `protocol.rs`），stderr 只給人看。
//!
//! ```text
//! nexus-sandbox-spawner --listen <socket 路徑>
//! ```
//!
//! **嚴格單執行緒**：子行程在 fork 之後才配置記憶體（`child.rs`），只有單執行緒才安全。不要在這裡起任何 thread。
//!
//! 啟動順序（順序本身是安全性的一部分）：
//!
//! 1. 查 Landlock：核心不支援（none）就 fail-closed（S2）。
//! 2. 擋下 SIGINT／SIGTERM／SIGHUP，改由 signalfd 收。
//! 3. 建監聽用的 `AF_UNIX` socket、chmod 0600。一定要在裝過濾器之前：S1 擋 `socket(AF_UNIX)`，裝完之後只用 `accept4`。
//! 4. `NO_NEW_PRIVS`＋seccomp，只裝這一次，之後 fork 的子行程都繼承。
//! 5. 自我檢查：`socket(AF_INET)` 要拿到 EACCES、`socket(AF_UNIX)` 要拿到 EPERM。
//! 6. 送 `Ready`。
//!
//! 1 到 5 任何一步失敗，都送 `Unavailable` 後結束。
//!
//! stdio：Node 對監聽 socket 每接一條 fd 就 connect 一次，先寫 8 bytes 標頭（id `u32 LE`、fd `u32 LE`，fd ∈ {0,1,2}），之後就是資料。
//! 連進來的對方要是起這個 spawner 的那個行程（`SO_PEERCRED` 的 pid 等於 `getppid()`，uid 相同），否則直接關掉。
//! 要求與它要的連線都到齊才 fork；等太久（[`STDIO_WAIT`]）回 `Protocol`。
//!
//! 每個收到的要求恰好得到一個結局：`Failed`，或 `Started` 之後一個 `Exited`。例外只有 id 重複：那是 Node 的錯，回一個帶同一個 id
//! 的 `Failed`（`Protocol`），原本那筆照常進行。關機時，還在跑的收到 `Exited`（被 SIGKILL），還在等 stdio 連線的收到
//! `Failed`（`Resource`）；因為事件寫不出去而關機時，這些都送不出去。
//! 工具結束時（leader 結束），整個行程群組一起 SIGKILL，不留背景成員抓著 stdout。
//!
//! 結束：stdin 收到 EOF 或讀錯、收到 SIGINT／SIGTERM／SIGHUP、事件寫不出去（Node 不在了）、控制通道上的框太大或解不開
//! （兩邊對協定的認知不一致，不能猜那筆要求的 id）、poll 出錯：殺掉所有群組、收完、結束。

mod child;

use nexus_sandbox_spawner::landlock;
use nexus_sandbox_spawner::protocol::{self, Event, FailKind, Mode, Request, Spawn};
use nexus_sandbox_spawner::seccomp;
use std::collections::HashMap;
use std::ffi::CString;
use std::time::{Duration, Instant};

/// 要求到了之後，最多等多久它要的 stdio 連線到齊；連線的標頭也是這個期限。
const STDIO_WAIT: Duration = Duration::from_secs(5);

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn write_all(fd: libc::c_int, mut bytes: &[u8]) -> bool {
    while !bytes.is_empty() {
        // SAFETY：寫一段有效的切片。
        let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if n < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            return false;
        }
        bytes = &bytes[n as usize..];
    }
    true
}

/// 送一筆事件；回 false 代表控制通道寫不出去。Rust 執行期預設忽略 SIGPIPE，寫斷掉的 pipe 回 EPIPE，不會被殺。
fn emit(event: &Event) -> bool {
    write_all(1, &protocol::frame(&protocol::encode_event(event)))
}

fn unavailable(err: i32, detail: &str) -> ! {
    eprintln!("nexus-sandbox-spawner: {detail}");
    emit(&Event::Unavailable { errno: err, detail: detail.as_bytes().to_vec() });
    std::process::exit(125);
}

#[cfg(feature = "test-hooks")]
fn test_abi_cap() -> Option<i32> {
    std::env::var("NEXUS_SPAWNER_TEST_ABI_CAP").ok().and_then(|v| v.parse().ok())
}

#[cfg(not(feature = "test-hooks"))]
fn test_abi_cap() -> Option<i32> {
    None
}

#[cfg(feature = "test-hooks")]
fn test_child_delay_us() -> u32 {
    std::env::var("NEXUS_SPAWNER_TEST_CHILD_DELAY_US").ok().and_then(|v| v.parse().ok()).unwrap_or(0)
}

#[cfg(not(feature = "test-hooks"))]
fn test_child_delay_us() -> u32 {
    0
}

fn listen(path: &str) -> Result<libc::c_int, String> {
    let cpath = CString::new(path).map_err(|_| "socket 路徑含 NUL".to_string())?;
    // SAFETY：sockaddr_un 先清零再填；路徑長度先檢查過。
    unsafe {
        let fd = libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(format!("socket: {}", std::io::Error::last_os_error()));
        }
        let mut addr: libc::sockaddr_un = std::mem::zeroed();
        addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
        let bytes = path.as_bytes();
        if bytes.len() >= addr.sun_path.len() {
            return Err("socket 路徑太長".to_string());
        }
        for (i, b) in bytes.iter().enumerate() {
            addr.sun_path[i] = *b as libc::c_char;
        }
        libc::unlink(cpath.as_ptr());
        let len = std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t;
        if libc::bind(fd, (&addr as *const libc::sockaddr_un).cast(), len) != 0 {
            return Err(format!("bind: {}", std::io::Error::last_os_error()));
        }
        if libc::chmod(cpath.as_ptr(), 0o600) != 0 {
            return Err(format!("chmod: {}", std::io::Error::last_os_error()));
        }
        if libc::listen(fd, 128) != 0 {
            return Err(format!("listen: {}", std::io::Error::last_os_error()));
        }
        Ok(fd)
    }
}

/// 裝好過濾器之後，確認網路與 `AF_UNIX` 真的被擋。
fn self_check() -> Result<(), String> {
    for (family, want) in [(libc::AF_INET, libc::EACCES), (libc::AF_UNIX, libc::EPERM)] {
        // SAFETY：建了就關。
        let fd = unsafe { libc::socket(family, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
        if fd >= 0 {
            unsafe { libc::close(fd) };
            return Err(format!("自我檢查：socket({family}) 在過濾器之下建得起來"));
        }
        let got = errno();
        if got != want {
            return Err(format!("自我檢查：socket({family}) 拿到 errno {got}，應該是 {want}"));
        }
    }
    Ok(())
}

/// 擋掉要改由 signalfd 收的訊號，回 signalfd。
fn signal_fd() -> Result<libc::c_int, String> {
    // SAFETY：只操作本地的 sigset。
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for sig in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            libc::sigaddset(&mut set, sig);
        }
        if libc::sigprocmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) != 0 {
            return Err(format!("sigprocmask: {}", std::io::Error::last_os_error()));
        }
        let fd = libc::signalfd(-1, &set, libc::SFD_CLOEXEC | libc::SFD_NONBLOCK);
        if fd < 0 {
            return Err(format!("signalfd: {}", std::io::Error::last_os_error()));
        }
        Ok(fd)
    }
}

fn close(fd: libc::c_int) {
    if fd >= 0 {
        // SAFETY：只關自己持有的 fd。
        unsafe { libc::close(fd) };
    }
}

/// 一條還沒讀完標頭的連線。
struct Conn {
    fd: libc::c_int,
    header: Vec<u8>,
    deadline: Instant,
}

/// 等連線到齊的要求（或還沒等到要求、先到的連線）。
struct Pending {
    request: Option<Spawn>,
    fds: [libc::c_int; 3],
    deadline: Instant,
    /// 要求到了、還沒 fork 時收到的訊號，fork 之後轉給 `Child::queued`。
    queued: Vec<i32>,
}

impl Pending {
    fn new(deadline: Instant) -> Pending {
        Pending { request: None, fds: [-1; 3], deadline, queued: Vec::new() }
    }

    fn close_all(&mut self) {
        for fd in &mut self.fds {
            close(*fd);
            *fd = -1;
        }
    }
}

#[derive(PartialEq, Eq)]
enum Phase {
    /// 已 fork、還沒讀到狀態 pipe 的結果。
    Launching,
    /// 已 exec，送過 `Started`。
    Running,
    /// 沒 exec 成，送過 `Failed`；結束時只收屍，不送 `Exited`。
    Failed,
}

struct Child {
    pid: libc::pid_t,
    pidfd: libc::c_int,
    status: libc::c_int,
    partial: bool,
    phase: Phase,
    /// 還沒讀到 exec 結果時收到的訊號：子行程 `setsid` 之前 `kill(-pid)` 打不到，exec 之前殺掉又會被看成起來了，
    /// 所以讀到 exec 成功之後才送。
    queued: Vec<i32>,
}

struct Spawner {
    abi: i32,
    listen: libc::c_int,
    conns: Vec<Conn>,
    pending: HashMap<u32, Pending>,
    children: HashMap<u32, Child>,
    me: libc::pid_t,
    parent: libc::pid_t,
    uid: libc::uid_t,
    /// 事件寫不出去過：主迴圈看到就收尾。
    lost: bool,
    test_delay_us: u32,
}

/// argv[0] 沒有 `/` 時，照 request 帶來的 PATH 列出候選；PATH 沒給就用 glibc execvp 的預設（`_CS_PATH`）。
fn candidates(argv0: &[u8], env: &[Vec<u8>]) -> Vec<Vec<u8>> {
    if argv0.contains(&b'/') {
        return vec![argv0.to_vec()];
    }
    let path = env
        .iter()
        .rev()
        .find_map(|entry| entry.strip_prefix(b"PATH=").map(<[u8]>::to_vec))
        .unwrap_or_else(|| b"/bin:/usr/bin".to_vec());
    path.split(|&b| b == b':')
        .map(|dir| {
            let dir: &[u8] = if dir.is_empty() { b"." } else { dir };
            [dir, b"/", argv0].concat()
        })
        .collect()
}

fn cstrings(items: &[Vec<u8>]) -> Option<Vec<CString>> {
    items.iter().map(|item| CString::new(item.clone()).ok()).collect()
}

fn null_terminated(items: &[CString]) -> Vec<*const libc::c_char> {
    items.iter().map(|c| c.as_ptr()).chain(std::iter::once(std::ptr::null())).collect()
}

impl Spawner {
    fn emit(&mut self, event: &Event) {
        if !emit(event) {
            self.lost = true;
        }
    }

    fn fail(&mut self, id: u32, kind: FailKind, err: i32, detail: &str) {
        self.emit(&Event::Failed { id, kind, errno: err, detail: detail.as_bytes().to_vec() });
    }

    fn on_request(&mut self, request: Request) {
        match request {
            Request::Spawn(spawn) => {
                let id = spawn.id;
                if self.children.contains_key(&id) || self.pending.get(&id).is_some_and(|p| p.request.is_some()) {
                    self.fail(id, FailKind::Protocol, 0, "id 重複");
                    return;
                }
                let entry = self.pending.entry(id).or_insert_with(|| Pending::new(Instant::now() + STDIO_WAIT));
                entry.deadline = Instant::now() + STDIO_WAIT;
                // 先到的連線裡，有要求沒要的 fd：整筆不成立。
                let unwanted = (0..3).any(|i| entry.fds[i] >= 0 && spawn.pipes & (1 << i) == 0);
                entry.request = Some(spawn);
                if unwanted {
                    let mut p = self.pending.remove(&id).unwrap();
                    p.close_all();
                    self.fail(id, FailKind::Protocol, 0, "連進來的 stdio 不在要求裡");
                    return;
                }
                self.try_spawn(id);
            }
            Request::Signal { id, signo } => {
                if let Some(p) = self.pending.get_mut(&id).filter(|p| p.request.is_some()) {
                    p.queued.push(signo);
                } else if let Some(child) = self.children.get_mut(&id) {
                    match child.phase {
                        Phase::Launching => child.queued.push(signo),
                        // leader 還沒被收屍，pgid 不會被重用。
                        // SAFETY：送訊號給自己起的群組。
                        Phase::Running => unsafe {
                            libc::kill(-child.pid, signo);
                        },
                        Phase::Failed => {}
                    }
                }
            }
        }
    }

    fn on_accept(&mut self) {
        // SAFETY：accept 回來的 fd 由這裡接手。
        let fd = unsafe {
            libc::accept4(self.listen, std::ptr::null_mut(), std::ptr::null_mut(), libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK)
        };
        if fd < 0 {
            return;
        }
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY：cred 夠大，len 是它的大小。
        let ok = unsafe {
            libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len)
        } == 0;
        if !ok || cred.pid != self.parent || cred.uid != self.uid {
            eprintln!("nexus-sandbox-spawner: 拒絕連線：pid {} uid {}", cred.pid, cred.uid);
            close(fd);
            return;
        }
        self.conns.push(Conn { fd, header: Vec::new(), deadline: Instant::now() + STDIO_WAIT });
    }

    /// 讀連線的標頭；讀齊了就交給那個 id。
    fn on_conn(&mut self, fd: libc::c_int) {
        let Some(index) = self.conns.iter().position(|c| c.fd == fd) else { return };
        let conn = &mut self.conns[index];
        let mut buf = [0u8; 8];
        let want = 8 - conn.header.len();
        // SAFETY：讀進本地緩衝。
        let n = unsafe { libc::read(conn.fd, buf.as_mut_ptr().cast(), want) };
        if n < 0 && matches!(errno(), libc::EAGAIN | libc::EINTR) {
            return;
        }
        if n <= 0 {
            let conn = self.conns.swap_remove(index);
            close(conn.fd);
            return;
        }
        conn.header.extend_from_slice(&buf[..n as usize]);
        if conn.header.len() < 8 {
            return;
        }
        let conn = self.conns.swap_remove(index);
        let h = &conn.header;
        let id = u32::from_le_bytes([h[0], h[1], h[2], h[3]]);
        let which = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize;
        // 交給子行程的是阻塞的 fd。
        // SAFETY：只改自己持有的 fd 的旗標。
        unsafe {
            let flags = libc::fcntl(conn.fd, libc::F_GETFL);
            libc::fcntl(conn.fd, libc::F_SETFL, flags & !libc::O_NONBLOCK);
        }
        if which > 2 || self.children.contains_key(&id) {
            close(conn.fd);
            return;
        }
        let entry = self.pending.entry(id).or_insert_with(|| Pending::new(Instant::now() + STDIO_WAIT));
        let unwanted = entry.request.as_ref().is_some_and(|r| r.pipes & (1 << which) == 0);
        if entry.fds[which] >= 0 || unwanted {
            close(conn.fd);
            return;
        }
        entry.fds[which] = conn.fd;
        self.try_spawn(id);
    }

    fn try_spawn(&mut self, id: u32) {
        let ready = match self.pending.get(&id) {
            Some(Pending { request: Some(r), fds, .. }) => (0..3).all(|i| r.pipes & (1 << i) == 0 || fds[i] >= 0),
            _ => false,
        };
        if !ready {
            return;
        }
        let mut p = self.pending.remove(&id).unwrap();
        let request = p.request.take().unwrap();
        match self.spawn(&request, &mut p.fds) {
            Ok(mut child) => {
                child.queued = std::mem::take(&mut p.queued);
                self.children.insert(id, child);
            }
            Err((kind, err, detail)) => self.fail(id, kind, err, &detail),
        }
        p.close_all();
    }

    fn spawn(&mut self, r: &Spawn, fds: &mut [libc::c_int; 3]) -> Result<Child, (FailKind, i32, String)> {
        let protocol_error = |detail: &str| (FailKind::Protocol, 0, detail.to_string());
        if r.argv.is_empty() {
            return Err(protocol_error("argv 是空的"));
        }
        if r.env.iter().any(|e| !e.contains(&b'=')) {
            return Err(protocol_error("環境變數不是 NAME=value"));
        }
        let argv = cstrings(&r.argv).ok_or_else(|| protocol_error("argv 含 NUL"))?;
        let env = cstrings(&r.env).ok_or_else(|| protocol_error("環境變數含 NUL"))?;
        let candidates = cstrings(&candidates(&r.argv[0], &r.env)).ok_or_else(|| protocol_error("PATH 含 NUL"))?;
        let cwd = CString::new(r.cwd.clone()).map_err(|_| protocol_error("cwd 含 NUL"))?;
        let devnull = c"/dev/null";
        let mut opened = Vec::new();
        for i in 0..3 {
            if fds[i] < 0 {
                // SAFETY：開 /dev/null，交給子行程後由 close_all 關掉。
                let fd = unsafe { libc::open(devnull.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC) };
                if fd < 0 {
                    for fd in opened {
                        close(fd);
                    }
                    return Err((FailKind::Resource, errno(), "open /dev/null".to_string()));
                }
                fds[i] = fd;
                opened.push(fd);
            }
        }
        let mut status = [-1; 2];
        // SAFETY：pipe2 寫進本地陣列。
        if unsafe { libc::pipe2(status.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
            return Err((FailKind::Resource, errno(), "pipe2".to_string()));
        }
        let prepared = child::Prepared {
            stdio: *fds,
            status: status[1],
            spawner: self.me,
            cwd,
            abi: self.abi,
            readable: r.readable.clone(),
            writable: if r.mode == Mode::WorkspaceWrite { r.writable.clone() } else { Vec::new() },
            candidates,
            argv: null_terminated(&argv),
            envp: null_terminated(&env),
            test_delay_us: self.test_delay_us,
        };
        // SAFETY：單執行緒的 fork；子行程只走 child::run，不會回來。
        let pid = unsafe { libc::fork() };
        if pid == 0 {
            unsafe { child::run(&prepared) }
        }
        close(status[1]);
        if pid < 0 {
            close(status[0]);
            return Err((FailKind::Resource, errno(), "fork".to_string()));
        }
        // SAFETY：對剛 fork 的子行程開 pidfd；它還沒被收屍，pid 不會被重用。
        let pidfd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) } as libc::c_int;
        if pidfd < 0 {
            let err = errno();
            // 沒有 pidfd 就等不了它：殺掉、收屍。Landlock 需要的核心（5.13）一定有 pidfd_open（5.3），這裡照理到不了。
            unsafe {
                libc::kill(pid, libc::SIGKILL);
                libc::waitpid(pid, std::ptr::null_mut(), 0);
            }
            close(status[0]);
            return Err((FailKind::Resource, err, "pidfd_open".to_string()));
        }
        Ok(Child { pid, pidfd, status: status[0], partial: self.abi < landlock::WANTED_ABI, phase: Phase::Launching, queued: Vec::new() })
    }

    /// 狀態 pipe 有結果：EOF 是 exec 成功，有字是失敗紀錄（子行程每條失敗路徑都會寫）。
    /// 例外：exec 之前被外部殺掉（例如 OOM killer）也是 EOF，會被看成 `Started`，接著的 `Exited` 帶那個訊號。
    fn on_status(&mut self, id: u32) {
        let Some(child) = self.children.get_mut(&id) else { return };
        let mut record = Vec::new();
        let mut buf = [0u8; 512];
        loop {
            // SAFETY：讀進本地緩衝。
            let n = unsafe { libc::read(child.status, buf.as_mut_ptr().cast(), buf.len()) };
            if n < 0 && errno() == libc::EINTR {
                continue;
            }
            if n <= 0 {
                break;
            }
            record.extend_from_slice(&buf[..n as usize]);
        }
        close(child.status);
        child.status = -1;
        if record.is_empty() {
            child.phase = Phase::Running;
            let event = Event::Started { id, pid: child.pid as u32, partial: child.partial };
            for signo in std::mem::take(&mut child.queued) {
                // SAFETY：送訊號給自己起的群組，leader 還沒被收屍。
                unsafe { libc::kill(-child.pid, signo) };
            }
            self.emit(&event);
            return;
        }
        child.phase = Phase::Failed;
        let (kind, err, detail) = match record.as_slice() {
            [kind, a, b, c, d, detail @ ..] => (
                FailKind::from_u8(*kind).unwrap_or(FailKind::Resource),
                i32::from_le_bytes([*a, *b, *c, *d]),
                detail.to_vec(),
            ),
            _ => (FailKind::Resource, 0, record.clone()),
        };
        self.emit(&Event::Failed { id, kind, errno: err, detail });
    }

    /// leader 結束了：先把狀態讀完（它可能 exec 完馬上結束），群組整個 SIGKILL，再收屍。
    fn on_exit(&mut self, id: u32) {
        if self.children.get(&id).is_some_and(|c| c.status >= 0) {
            self.on_status(id);
        }
        let Some(child) = self.children.remove(&id) else { return };
        let mut st = 0;
        // SAFETY：leader 還是殭屍，pgid 還在它身上；之後才收屍。
        unsafe {
            libc::kill(-child.pid, libc::SIGKILL);
            libc::waitpid(child.pid, &mut st, 0);
        }
        close(child.pidfd);
        if child.phase == Phase::Running {
            let (code, signal) = if libc::WIFEXITED(st) {
                (libc::WEXITSTATUS(st), 0)
            } else if libc::WIFSIGNALED(st) {
                (-1, libc::WTERMSIG(st))
            } else {
                (-2, 0)
            };
            self.emit(&Event::Exited { id, code, signal });
        }
    }

    fn expire(&mut self, now: Instant) {
        let expired: Vec<u32> = self.pending.iter().filter(|(_, p)| p.deadline <= now).map(|(&id, _)| id).collect();
        for id in expired {
            let mut p = self.pending.remove(&id).unwrap();
            p.close_all();
            if p.request.is_some() {
                self.fail(id, FailKind::Protocol, 0, "等不到 stdio 連線");
            }
        }
        self.conns.retain(|c| {
            let keep = c.deadline > now;
            if !keep {
                close(c.fd);
            }
            keep
        });
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().map(|p| p.deadline).chain(self.conns.iter().map(|c| c.deadline)).min()
    }

    /// 殺掉所有群組、收完、結束。先殺再收：還沒 exec 的子行程可能卡在 chdir 之類的地方，`on_exit` 讀它的狀態 pipe 會等到它死。
    /// leader 另外單獨殺一次，因為 `setsid` 之前 `kill(-pid)` 打不到它。
    fn shutdown(&mut self, path: &CString) -> ! {
        let ids: Vec<u32> = self.children.keys().copied().collect();
        for id in &ids {
            let pid = self.children[id].pid;
            // SAFETY：送給自己起的行程與群組，都還沒被收屍。
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
                libc::kill(pid, libc::SIGKILL);
            }
        }
        for id in ids {
            self.on_exit(id);
        }
        let waiting: Vec<u32> = self.pending.iter().filter(|(_, p)| p.request.is_some()).map(|(&id, _)| id).collect();
        for id in waiting {
            self.fail(id, FailKind::Resource, 0, "spawner 結束");
        }
        // SAFETY：刪掉自己建的 socket 檔。
        unsafe { libc::unlink(path.as_ptr()) };
        std::process::exit(0);
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(path) = args.iter().position(|a| a == "--listen").and_then(|i| args.get(i + 1)).cloned() else {
        eprintln!("usage: nexus-sandbox-spawner --listen <socket path>");
        std::process::exit(2);
    };
    let cpath = CString::new(path.as_bytes()).unwrap_or_else(|_| unavailable(0, "socket 路徑含 NUL"));

    let abi = landlock::effective_abi(landlock::kernel_abi(), test_abi_cap());
    if abi < 1 {
        unavailable(libc::ENOSYS, "Landlock 不能用（核心不支援或沒開）");
    }
    let sigfd = signal_fd().unwrap_or_else(|e| unavailable(errno(), &e));
    let lfd = listen(&path).unwrap_or_else(|e| unavailable(errno(), &e));
    let insns = seccomp::install().unwrap_or_else(|e| unavailable(e.raw_os_error().unwrap_or(0), &format!("seccomp: {e}")));
    if let Err(e) = self_check() {
        unavailable(0, &e);
    }
    if !emit(&Event::Ready { filter_insns: insns as u32, landlock_abi: abi as u32 }) {
        std::process::exit(3);
    }

    let mut s = Spawner {
        abi,
        listen: lfd,
        conns: Vec::new(),
        pending: HashMap::new(),
        children: HashMap::new(),
        // SAFETY：讀自己的身分。
        me: unsafe { libc::getpid() },
        parent: unsafe { libc::getppid() },
        uid: unsafe { libc::getuid() },
        lost: false,
        test_delay_us: test_child_delay_us(),
    };
    let mut input: Vec<u8> = Vec::new();

    loop {
        if s.lost {
            s.shutdown(&cpath);
        }
        // 前兩格固定是 stdin 與 signalfd，第三格是監聽 socket；之後依序是連線、狀態 pipe、pidfd。
        let mut fds = vec![
            libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: sigfd, events: libc::POLLIN, revents: 0 },
            libc::pollfd { fd: lfd, events: libc::POLLIN, revents: 0 },
        ];
        let conns: Vec<libc::c_int> = s.conns.iter().map(|c| c.fd).collect();
        fds.extend(conns.iter().map(|&fd| libc::pollfd { fd, events: libc::POLLIN, revents: 0 }));
        let mut owners: Vec<(u32, bool)> = Vec::new();
        for (&id, child) in &s.children {
            if child.status >= 0 {
                fds.push(libc::pollfd { fd: child.status, events: libc::POLLIN, revents: 0 });
                owners.push((id, true));
            }
            fds.push(libc::pollfd { fd: child.pidfd, events: libc::POLLIN, revents: 0 });
            owners.push((id, false));
        }
        let timeout = s
            .next_deadline()
            .map(|d| d.saturating_duration_since(Instant::now()).as_millis().min(i32::MAX as u128) as i32 + 1)
            .unwrap_or(-1);
        // SAFETY：fds 在呼叫期間存活。
        let n = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if n < 0 {
            if errno() == libc::EINTR {
                continue;
            }
            eprintln!("nexus-sandbox-spawner: poll: {}", std::io::Error::last_os_error());
            s.shutdown(&cpath);
        }
        s.expire(Instant::now());

        if fds[1].revents != 0 {
            s.shutdown(&cpath);
        }
        if fds[0].revents != 0 {
            let mut buf = [0u8; 65536];
            // SAFETY：讀進本地緩衝。
            let r = unsafe { libc::read(0, buf.as_mut_ptr().cast(), buf.len()) };
            if r == 0 || (r < 0 && errno() != libc::EINTR) {
                s.shutdown(&cpath);
            }
            if r > 0 {
                input.extend_from_slice(&buf[..r as usize]);
                loop {
                    match protocol::take_frame(&mut input) {
                        Ok(Some(payload)) => match protocol::decode_request(&payload) {
                            Ok(request) => s.on_request(request),
                            Err(e) => {
                                eprintln!("nexus-sandbox-spawner: 看不懂的要求：{}", e.0);
                                s.shutdown(&cpath);
                            }
                        },
                        Ok(None) => break,
                        Err(e) => {
                            eprintln!("nexus-sandbox-spawner: 控制通道壞了：{}", e.0);
                            s.shutdown(&cpath);
                        }
                    }
                }
            }
        }
        if fds[2].revents != 0 {
            s.on_accept();
        }
        for (i, &fd) in conns.iter().enumerate() {
            if fds[3 + i].revents != 0 {
                s.on_conn(fd);
            }
        }
        let base = 3 + conns.len();
        for (k, &(id, is_status)) in owners.iter().enumerate() {
            if fds[base + k].revents == 0 {
                continue;
            }
            if is_status {
                if s.children.get(&id).is_some_and(|c| c.status >= 0) {
                    s.on_status(id);
                }
            } else {
                s.on_exit(id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::candidates;

    #[test]
    fn a_slash_in_argv0_skips_the_path_search() {
        assert_eq!(candidates(b"./rg", &[b"PATH=/usr/bin".to_vec()]), vec![b"./rg".to_vec()]);
    }

    #[test]
    fn path_comes_from_the_request_and_empty_entries_mean_cwd() {
        let env = vec![b"PATH=/a:/b".to_vec(), b"PATH=/c::/d".to_vec()];
        assert_eq!(
            candidates(b"git", &env),
            vec![b"/c/git".to_vec(), b"./git".to_vec(), b"/d/git".to_vec()]
        );
        assert_eq!(candidates(b"git", &[]), vec![b"/bin/git".to_vec(), b"/usr/bin/git".to_vec()]);
    }
}
