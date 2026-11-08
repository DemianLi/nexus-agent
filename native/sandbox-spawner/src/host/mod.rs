//! 宿主（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）：監督行程起的第三種子行程，全機共用一個，不在資料路徑上。
//! 目前只做三件事：跟監督行程握手、收身分表、在 `--socket` 上收前台與對話行程的連線並驗身分；還沒有任何服務（#2569）。
//!
//! ```text
//! nexus-host --socket <路徑>
//! ```
//!
//! 控制通道是 stdin／stdout（[`crate::supervisor_protocol`] 的 `HostCommand`／`HostReport`）。一起來先送 `hello`，等監督行程的 `hello`，
//! 版本不同就回 3。接著綁 socket（舊的先刪掉），之後才送 `ready`：`ready` 之前不可能有客戶端的輸入。stdin 讀到 EOF 就刪掉 socket、回 0。
//!
//! 身分表由監督行程給（`grant`／`revoke`），宿主不看客戶端自己說的身分：連線的 pid 取自 `SO_PEERCRED`（核心在 `connect()` 那一刻記下的），
//! uid 要跟自己相同；`hello` 帶的 token 要跟表上那個 pid 的相同、版本要相等。驗每一個 `hello` 之前，先把控制通道讀到 EAGAIN：
//! 宿主 `ready` 之後，監督行程收屍之前就把 `revoke` 寫進 pipe（500 ms 內寫不進去就先殺掉宿主的群組，再收屍），pid 被重用之後才 `connect()` 的連線，
//! 它的 `hello` 一定比那一筆晚，所以這一讀一定讀得到。
//!
//! 違反協定（框太大、解不開、種類不認得、版本或 token 不對、重複的 `hello`）：回 `rejected`、斷線，經控制通道回報監督行程
//! （`violation`，它寫稽核），表上那個 pid 撤掉、它的其他連線一起斷，直到監督行程重送（它不會：那個身分隔離到行程結束）。
//! pid 不在表上的只回 `rejected`、斷線、回報 `unregistered`（算不算違規由監督行程判斷），沒有身分可以撤。宿主自己不因為任何一條連線結束。
//!
//! 連線數最多 [`MAX_CONNECTIONS`]；連上之後 [`HELLO_TIMEOUT`] 內沒送 `hello` 的斷掉。

use crate::host_protocol::{self, decode_client_message, encode_host_message, ClientMessage, HostMessage};
use crate::supervisor::process::Chan;
use crate::supervisor_protocol::{decode_host_command, encode_host_report, HostCommand, HostReport, Role, PROTOCOL_VERSION};
use std::collections::HashMap;
use std::ffi::OsString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// 同時最多幾條客戶端連線；滿了先不 accept。
pub const MAX_CONNECTIONS: usize = 1024;
/// 連上之後多久內要送 `hello`。
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

const EXIT_PROTOCOL: i32 = 3;

const USAGE: &str = "nexus-host --socket <路徑>";

macro_rules! say {
    ($($arg:tt)*) => { eprintln!("nexus-host: {}", format_args!($($arg)*)) };
}

struct Grant {
    token: Vec<u8>,
    role: Role,
    thread: Vec<u8>,
}

struct Conn {
    chan: Chan,
    /// `SO_PEERCRED` 的 pid；取不到或 uid 不同是 `None`，它的 `hello` 一律不收。
    pid: Option<u32>,
    opened: Instant,
    hello: bool,
    /// 要斷了：這一輪結束時清掉。輪中途不刪，索引才不會錯位。
    dead: bool,
}

struct Host {
    control: Chan,
    grants: HashMap<u32, Grant>,
    conns: Vec<Conn>,
}

fn parse(args: Vec<OsString>) -> Result<PathBuf, String> {
    let mut args = args.into_iter();
    let mut socket = None;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--socket") => socket = Some(PathBuf::from(args.next().ok_or("--socket 要一個路徑")?)),
            _ => return Err(format!("不認得的參數 {}", arg.to_string_lossy())),
        }
    }
    socket.ok_or_else(|| "少了 --socket".to_string())
}

/// 跑宿主，回結束碼：0 是 `ready` 之後 stdin 讀到 EOF 或讀不下去（監督行程要它收，或控制通道送來超長的框）；1 是 `hello` 之前 stdin 就 EOF，或綁不了 socket；2 是參數不對；
/// 3 是監督行程的第一框不是這一版的 `hello`，或解不開。
pub fn run(args: Vec<OsString>) -> i32 {
    let socket = match parse(args) {
        Ok(socket) => socket,
        Err(err) => {
            say!("{err}\n用法：{USAGE}");
            return 2;
        }
    };
    // SAFETY：fd 0、1 是監督行程接好的控制通道，整個行程只有這裡拿它們。
    let control = unsafe { Chan::from_fds(OwnedFd::from_raw_fd(0), OwnedFd::from_raw_fd(1), crate::protocol::MAX_FRAME) };
    let mut host = Host { control, grants: HashMap::new(), conns: Vec::new() };
    host.report(&HostReport::Hello { version: PROTOCOL_VERSION });
    match host.await_hello() {
        Ok(()) => {}
        Err(code) => return code,
    }
    let _ = std::fs::remove_file(&socket);
    let listener = match UnixListener::bind(&socket).and_then(|l| l.set_nonblocking(true).map(|()| l)) {
        Ok(listener) => listener,
        Err(err) => {
            say!("綁不了 {}：{err}", socket.display());
            return 1;
        }
    };
    host.report(&HostReport::Ready);
    let code = host.serve(&listener);
    let _ = std::fs::remove_file(&socket);
    code
}

fn poll(fds: &mut [libc::pollfd], timeout: Option<Duration>) {
    let ms = timeout.map_or(-1, |t| libc::c_int::try_from(t.as_millis().max(1)).unwrap_or(libc::c_int::MAX));
    let n = libc::nfds_t::try_from(fds.len()).unwrap_or(libc::nfds_t::MAX);
    // SAFETY：fds 是一段 pollfd。
    unsafe { libc::poll(fds.as_mut_ptr(), n, ms) };
}

fn pollfd(fd: libc::c_int, events: libc::c_short) -> libc::pollfd {
    libc::pollfd { fd, events, revents: 0 }
}

/// 連線那一端的 pid：uid 要跟自己相同。
fn peer_pid(fd: libc::c_int) -> Option<u32> {
    // SAFETY：ucred 是純資料，全零合法。
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = libc::socklen_t::try_from(std::mem::size_of::<libc::ucred>()).ok()?;
    // SAFETY：照 SO_PEERCRED 的大小傳 cred。
    let rc = unsafe {
        libc::getsockopt(fd, libc::SOL_SOCKET, libc::SO_PEERCRED, (&mut cred as *mut libc::ucred).cast(), &mut len)
    };
    // SAFETY：沒有參數。
    let uid = unsafe { libc::getuid() };
    if rc != 0 || cred.uid != uid {
        return None;
    }
    u32::try_from(cred.pid).ok().filter(|&pid| pid > 0)
}

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Front => "前台",
        Role::Conversation => "對話行程",
    }
}

impl Host {
    fn report(&mut self, report: &HostReport) {
        self.control.send(&encode_host_report(report));
    }

    /// 等監督行程的 `hello`：版本相等回 `Ok`，否則回結束碼。
    fn await_hello(&mut self) -> Result<(), i32> {
        loop {
            let (read, write) = self.control.poll_fds();
            let mut fds: Vec<libc::pollfd> = read.map(|fd| pollfd(fd, libc::POLLIN)).into_iter().collect();
            fds.extend(write.map(|fd| pollfd(fd, libc::POLLOUT)));
            if fds.is_empty() {
                say!("監督行程在 hello 之前就斷了");
                return Err(1);
            }
            poll(&mut fds, None);
            self.control.flush();
            let frames = self.control.receive().map_err(|err| {
                say!("監督行程送來解不開的框：{}", err.0);
                EXIT_PROTOCOL
            })?;
            if let Some(first) = frames.first() {
                return match decode_host_command(first) {
                    Ok(HostCommand::Hello { version: PROTOCOL_VERSION }) => {
                        // 同一批裡跟在 hello 後面的不會有：監督行程等 ready 才送身分表。
                        Ok(())
                    }
                    Ok(other) => {
                        say!("監督行程的第一框不是這一版的 hello：{other:?}");
                        Err(EXIT_PROTOCOL)
                    }
                    Err(err) => {
                        say!("監督行程的第一框解不開：{}", err.0);
                        Err(EXIT_PROTOCOL)
                    }
                };
            }
            if self.control.read_closed() {
                say!("監督行程在 hello 之前就斷了");
                return Err(1);
            }
        }
    }

    /// 把控制通道讀到 EAGAIN，套用身分表的變動。監督行程斷了回 `false`。
    fn sync(&mut self) -> bool {
        match self.control.receive_all() {
            Ok(frames) => {
                for frame in frames {
                    match decode_host_command(&frame) {
                        Ok(HostCommand::Grant { pid, token, role, thread }) => {
                            self.grants.insert(pid, Grant { token, role, thread });
                        }
                        Ok(HostCommand::Revoke { pid }) => self.revoke(pid),
                        Ok(HostCommand::Hello { .. }) => say!("監督行程又送了一次 hello，不理"),
                        Err(err) => say!("監督行程送來解不開的訊息（{}），不理", err.0),
                    }
                }
            }
            Err(err) => say!("監督行程送來解不開的框（{}）", err.0),
        }
        !self.control.read_closed()
    }

    /// 表上撤掉這個 pid，它的連線全部斷掉。
    fn revoke(&mut self, pid: u32) {
        self.grants.remove(&pid);
        for conn in self.conns.iter_mut().filter(|conn| conn.pid == Some(pid)) {
            conn.dead = true;
        }
    }

    fn serve(&mut self, listener: &UnixListener) -> i32 {
        loop {
            let now = Instant::now();
            let deadline = self.conns.iter().filter(|c| !c.hello).map(|c| c.opened + HELLO_TIMEOUT).min();
            let (read, write) = self.control.poll_fds();
            let mut fds = Vec::with_capacity(self.conns.len() + 3);
            fds.push(pollfd(read.unwrap_or(-1), libc::POLLIN));
            fds.push(pollfd(write.unwrap_or(-1), libc::POLLOUT));
            let accepting = self.conns.len() < MAX_CONNECTIONS;
            fds.push(pollfd(if accepting { listener.as_raw_fd() } else { -1 }, libc::POLLIN));
            for conn in &self.conns {
                let (read, write) = conn.chan.poll_fds();
                let events = if write.is_some() { libc::POLLIN | libc::POLLOUT } else { libc::POLLIN };
                fds.push(pollfd(read.or(write).unwrap_or(-1), events));
            }
            poll(&mut fds, deadline.map(|d| d.saturating_duration_since(now)));

            self.control.flush();
            if !self.sync() {
                return 0;
            }
            if accepting && fds[2].revents != 0 {
                self.accept(listener);
            }
            // 新 accept 的排在 fds 之後，下一輪才 poll 到它們。
            for (i, fd) in fds.iter().skip(3).enumerate() {
                if fd.revents != 0 && self.conns.get(i).is_some_and(|conn| !conn.dead) && !self.on_readable(i) {
                    if let Some(conn) = self.conns.get_mut(i) {
                        conn.dead = true;
                    }
                }
            }
            let now = Instant::now();
            self.conns.retain(|conn| {
                !conn.dead && !conn.chan.read_closed() && !conn.chan.write_closed() && (conn.hello || now < conn.opened + HELLO_TIMEOUT)
            });
        }
    }

    fn accept(&mut self, listener: &UnixListener) {
        while self.conns.len() < MAX_CONNECTIONS {
            match listener.accept() {
                Ok((stream, _)) => {
                    let pid = peer_pid(stream.as_raw_fd());
                    let fd = OwnedFd::from(stream);
                    let Ok(write) = fd.try_clone() else { continue };
                    let chan = Chan::from_fds(fd, write, host_protocol::MAX_FRAME);
                    self.conns.push(Conn { chan, pid, opened: Instant::now(), hello: false, dead: false });
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(err) => {
                    say!("accept 失敗：{err}");
                    return;
                }
            }
        }
    }

    /// 讀第 `i` 條連線、處理讀到的框。這條要斷回 `false`。
    fn on_readable(&mut self, i: usize) -> bool {
        let Some(conn) = self.conns.get_mut(i) else { return false };
        conn.chan.flush();
        let frames = match conn.chan.receive() {
            Ok(frames) => frames,
            Err(err) => {
                self.violate(i, err.0);
                return false;
            }
        };
        for frame in frames {
            let message = match decode_client_message(&frame) {
                Ok(message) => message,
                Err(err) => {
                    self.violate(i, err.0);
                    return false;
                }
            };
            match message {
                ClientMessage::Hello { version, token } => {
                    if !self.on_hello(i, version, token.as_bytes()) {
                        return false;
                    }
                }
            }
        }
        true
    }

    fn on_hello(&mut self, i: usize, version: u32, token: &[u8]) -> bool {
        // 驗之前先讀乾淨控制通道：見檔頭。
        self.sync();
        let Some(conn) = self.conns.get(i) else { return false };
        if conn.hello {
            self.violate(i, "重複的 hello");
            return false;
        }
        let Some(grant) = conn.pid.and_then(|pid| self.grants.get(&pid)) else {
            let pid = self.refuse(i, "沒有登記");
            self.report(&HostReport::Unregistered { pid });
            return false;
        };
        if version != PROTOCOL_VERSION {
            self.violate(i, "版本不對");
            return false;
        }
        if grant.token != token {
            self.violate(i, "token 不對");
            return false;
        }
        say!(
            "pid {}（{}，thread {:?}）連上",
            conn.pid.unwrap_or(0),
            role_name(grant.role),
            String::from_utf8_lossy(&grant.thread)
        );
        if let Some(conn) = self.conns.get_mut(i) {
            conn.hello = true;
            conn.chan.send(&encode_host_message(&HostMessage::Hello { version: PROTOCOL_VERSION }));
        }
        true
    }

    /// 回 `rejected`，回傳要報給監督行程的 pid（讀不到是 0）；這條由呼叫方斷。
    fn refuse(&mut self, i: usize, reason: &str) -> u32 {
        let Some(conn) = self.conns.get_mut(i) else { return 0 };
        conn.chan.send(&encode_host_message(&HostMessage::Rejected { reason: reason.to_string() }));
        let pid = conn.pid.unwrap_or(0);
        say!("拒絕 pid {pid} 的連線：{reason}");
        pid
    }

    /// 違反協定：回 `rejected`、回報監督行程，撤掉那個 pid 在表上的身分、斷掉它其他的連線；這條由呼叫方斷。
    fn violate(&mut self, i: usize, reason: &str) {
        let pid = self.refuse(i, reason);
        self.report(&HostReport::Violation { pid, reason: reason.as_bytes().to_vec() });
        let Some(pid) = self.conns.get(i).and_then(|conn| conn.pid) else { return };
        if self.grants.contains_key(&pid) {
            say!("pid {pid} 隔離到它結束");
        }
        self.revoke(pid);
    }
}
