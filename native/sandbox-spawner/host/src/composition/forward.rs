//! 前台連線的轉送：`--socket` 上每收一條，就對葉子的資料 socket 連一條，位元組原樣雙向對接，不解析內容。
//!
//! 不自己跑事件迴圈：擁有它的一方每一輪先叫 [`Forward::poll_fds`]、poll 完把同一批 `pollfd` 交給 [`Forward::step`]。
//!
//! - 每個方向讀一次最多 [`BUFFER`]、馬上寫給另一邊；寫不完的留著，留著的寫完之前不再讀來源，所以每個方向最多留 [`BUFFER`]，
//!   對方不讀時來源那一端的寫入會被核心擋住。
//! - 一邊讀到 EOF：留著的寫完之後只關另一邊寫的方向；兩個方向都結束才整條關。
//! - 一邊斷了（`POLLHUP` 或 `POLLERR`）：往它的那個方向當場作廢；它斷之前送出、還沒讀的照樣轉給另一邊，
//!   讀到 EOF、讀錯或讀不到東西為止。
//!   `POLLHUP` 靠 Linux 的語意：stream socket 兩個方向都關了才有，對方只關寫的方向不算。
//!   `POLLERR` 在 Linux 上是對方帶著沒讀的資料關（`ECONNRESET`），它關之前送出的一樣讀得到。
//! - 讀來源出錯：當成來源結束，跟 EOF 一樣。往目的端寫出錯：只有那個方向作廢，另一個方向照推。
//! - 任一端 `POLLNVAL`：整條直接關，留著的不轉。
//! - 同時最多 [`MAX_LINKS`] 條，到了就不 accept，多的排在 listen 的 backlog。
//! - 連不上葉子：進來的那一條直接關。連是非阻塞的，葉子的 backlog 滿了也算連不上。

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 每個方向最多留這麼多還沒寫出去的位元組，也是一次讀的上限。
pub const BUFFER: usize = 64 * 1024;
/// 同時轉送的連線數上限。
pub const MAX_LINKS: usize = 64;
/// accept 出錯（開檔數用完之類）之後多久不看 listener。
pub const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

fn pollfd(fd: RawFd, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

/// 一條連線的一端。
struct End {
    fd: OwnedFd,
    /// 這一端斷了：不再 poll 它（`POLLHUP`、`POLLERR` 不用登記也會一直回報），剩下的靠另一端的事件推進。
    gone: bool,
}

/// 一個方向。
#[derive(Default)]
struct Half {
    /// 讀進來、還沒寫出去的。
    pending: Vec<u8>,
    /// 來源結束了：讀到 EOF、讀錯，或來源斷了之後讀不到東西。
    eof: bool,
    /// 這個方向結束了：目的端寫的方向已經關，或往目的端送不出去（斷了、寫出錯）。
    done: bool,
}

impl Half {
    fn wants_read(&self) -> bool {
        !self.done && !self.eof && self.pending.is_empty()
    }

    fn wants_write(&self) -> bool {
        !self.done && !self.pending.is_empty()
    }

    /// 往目的端送不出去了（斷了或寫出錯）：留著的丟掉，這個方向結束。
    fn abandon(&mut self) {
        self.pending.clear();
        self.done = true;
    }
}

struct Link {
    client: End,
    leaf: End,
    /// 前台 → 葉子。
    up: Half,
    /// 葉子 → 前台。
    down: Half,
}

fn events(end: &End, from: &Half, to: &Half) -> libc::pollfd {
    let mut events = 0;
    if from.wants_read() {
        events |= libc::POLLIN;
    }
    if to.wants_write() {
        events |= libc::POLLOUT;
    }
    pollfd(if end.gone { -1 } else { end.fd.as_raw_fd() }, events)
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// 寫到寫完或 EAGAIN 為止，回寫出去的位元組數。
fn write_some(fd: RawFd, bytes: &[u8]) -> io::Result<usize> {
    let mut written = 0;
    while written < bytes.len() {
        let rest = &bytes[written..];
        // SAFETY：寫 rest 的內容。
        let n = unsafe { libc::write(fd, rest.as_ptr().cast(), rest.len()) };
        if n > 0 {
            written += n as usize;
            continue;
        }
        match errno() {
            libc::EINTR => continue,
            libc::EAGAIN => break,
            _ => return Err(io::Error::last_os_error()),
        }
    }
    Ok(written)
}

/// 推一個方向：先寫留著的，寫完了才讀來源、讀到就寫；來源結束（EOF 或讀錯）而且都寫完了，關目的端寫的方向。
/// 往目的端寫出錯時這個方向作廢；另一個方向不受影響，目的端真的斷了的話下一輪 poll 會回報。
/// `src_gone` 是來源那一端斷了：它不會再被 poll，所以讀到它結束或目的端寫不進去為止，讀不到東西也算結束；
/// 它不會再有新的進來，讀不會沒完。來源沒斷的話一次最多讀 [`BUFFER`]。
fn pump(src: RawFd, dst: RawFd, half: &mut Half, scratch: &mut [u8], src_gone: bool) -> bool {
    if half.done {
        return false;
    }
    if !half.pending.is_empty() {
        match write_some(dst, &half.pending) {
            Ok(written) => {
                half.pending.drain(..written);
            }
            Err(_) => {
                half.abandon();
                return true;
            }
        }
    }
    let mut budget = if src_gone { usize::MAX } else { BUFFER };
    while half.pending.is_empty() && !half.eof && budget > 0 {
        let room = budget.min(scratch.len());
        // SAFETY：讀進 scratch 的前 room 個 byte。
        let n = unsafe { libc::read(src, scratch.as_mut_ptr().cast(), room) };
        if n == 0 {
            half.eof = true;
        } else if n > 0 {
            let n = n as usize;
            budget = budget.saturating_sub(n);
            match write_some(dst, &scratch[..n]) {
                Ok(written) => half.pending.extend_from_slice(&scratch[written..n]),
                Err(_) => {
                    half.abandon();
                    return true;
                }
            }
        } else {
            match errno() {
                libc::EINTR => continue,
                libc::EAGAIN if !src_gone => break,
                _ => half.eof = true,
            }
        }
    }
    if half.eof && half.pending.is_empty() {
        // SAFETY：只關這個 fd 寫的方向。對方已經整條關了會回錯，不理。
        unsafe { libc::shutdown(dst, libc::SHUT_WR) };
        half.done = true;
    }
    false
}

/// 非阻塞地連一個 Unix socket。行程是單執行緒、不 fork，`socket()` 之後才設 `FD_CLOEXEC` 沒有空窗。
fn connect(path: &Path) -> io::Result<OwnedFd> {
    let bytes = path.as_os_str().as_bytes();
    // SAFETY：sockaddr_un 是純資料，全零合法。
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= addr.sun_path.len() || bytes.contains(&0) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "socket 路徑太長",
        ));
    }
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (dst, src) in addr.sun_path.iter_mut().zip(bytes) {
        *dst = *src as libc::c_char;
    }
    // SAFETY：開一個新的 socket。
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY：raw 是剛開的 fd，只有這裡擁有。
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    // SAFETY：只改這個 fd 的旗標。
    let flagged = unsafe {
        let flags = libc::fcntl(raw, libc::F_GETFL);
        libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC) == 0
            && flags >= 0
            && libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) == 0
    };
    if !flagged {
        return Err(io::Error::last_os_error());
    }
    // SAFETY：addr 是填好的 sockaddr_un，長度照它的大小。
    let rc = unsafe {
        libc::connect(
            raw,
            (&addr as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(fd)
}

pub struct Forward {
    listener: UnixListener,
    leaf: PathBuf,
    links: Vec<Link>,
    /// 這個時刻之前不 accept。
    accept_after: Option<Instant>,
    /// 上一次連葉子沒連上：連上一次之前不再記 log。
    leaf_down: bool,
    scratch: Vec<u8>,
    /// 上一次 [`Forward::poll_fds`] 放進去的第一個位置，與那時有幾條連線。
    base: usize,
    polled: usize,
}

impl Forward {
    /// `listener` 是前台連的那一個；`leaf` 是葉子的資料 socket。
    pub fn new(listener: UnixListener, leaf: PathBuf) -> io::Result<Forward> {
        listener.set_nonblocking(true)?;
        Ok(Forward {
            listener,
            leaf,
            links: Vec::new(),
            accept_after: None,
            leaf_down: false,
            scratch: vec![0; BUFFER],
            base: 0,
            polled: 0,
        })
    }

    /// 要 poll 的 fd，接在 `fds` 後面。`accepting` 是現在收不收新的連線。
    pub fn poll_fds(&mut self, fds: &mut Vec<libc::pollfd>, accepting: bool, now: Instant) {
        self.accept_after = self.accept_after.filter(|&until| now < until);
        self.base = fds.len();
        self.polled = self.links.len();
        let listening = accepting && self.links.len() < MAX_LINKS && self.accept_after.is_none();
        fds.push(pollfd(
            if listening {
                self.listener.as_raw_fd()
            } else {
                -1
            },
            libc::POLLIN,
        ));
        for link in &self.links {
            fds.push(events(&link.client, &link.up, &link.down));
            fds.push(events(&link.leaf, &link.down, &link.up));
        }
    }

    /// 沒有 fd 動也要再走一輪的時刻：accept 退避完。
    pub fn deadline(&self) -> Option<Instant> {
        self.accept_after
    }

    /// `fds` 是上一次 [`Forward::poll_fds`] 放過、poll 完的同一批。
    pub fn step(&mut self, fds: &[libc::pollfd], now: Instant) {
        let polled = &fds[self.base..self.base + 1 + 2 * self.polled];
        let scratch = &mut self.scratch;
        let mut index = 0;
        self.links.retain_mut(|link| {
            let (client, leaf) = match polled.get(1 + 2 * index..3 + 2 * index) {
                Some([client, leaf]) => (client.revents, leaf.revents),
                _ => (0, 0),
            };
            index += 1;
            if (client | leaf) & libc::POLLNVAL != 0 {
                return false;
            }
            let gone = libc::POLLHUP | libc::POLLERR;
            link.client.gone |= client & gone != 0;
            link.leaf.gone |= leaf & gone != 0;
            if client == 0 && leaf == 0 && !link.client.gone && !link.leaf.gone {
                return true;
            }
            if link.client.gone {
                link.down.abandon();
            }
            if link.leaf.gone {
                link.up.abandon();
            }
            let (client, leaf) = (link.client.fd.as_raw_fd(), link.leaf.fd.as_raw_fd());
            link.leaf.gone |= pump(client, leaf, &mut link.up, scratch, link.client.gone);
            link.client.gone |= pump(leaf, client, &mut link.down, scratch, link.leaf.gone);
            !(link.up.done && link.down.done)
        });
        if polled[0].revents != 0 {
            self.accept(now);
        }
    }

    fn accept(&mut self, now: Instant) {
        while self.links.len() < MAX_LINKS {
            let client = match self.listener.accept() {
                Ok((stream, _)) => stream,
                Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
                Err(err) if err.kind() == io::ErrorKind::WouldBlock => return,
                Err(err) => {
                    say!("前台的連線 accept 失敗：{err}");
                    self.accept_after = Some(now + ACCEPT_BACKOFF);
                    return;
                }
            };
            if client.set_nonblocking(true).is_err() {
                continue;
            }
            match connect(&self.leaf) {
                Ok(leaf) => {
                    self.leaf_down = false;
                    self.links.push(Link {
                        client: End {
                            fd: OwnedFd::from(client),
                            gone: false,
                        },
                        leaf: End {
                            fd: leaf,
                            gone: false,
                        },
                        up: Half::default(),
                        down: Half::default(),
                    });
                }
                Err(err) => {
                    if !std::mem::replace(&mut self.leaf_down, true) {
                        say!(
                            "連不上葉子的 {}（{err}）：前台的連線直接關，連上之前不再記",
                            self.leaf.display()
                        );
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Forward;
    use std::io::{Read, Write};
    #[cfg(target_os = "linux")]
    use std::net::Shutdown;
    use std::os::fd::AsRawFd;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    /// 等一件一定會發生的事最多等這麼久；到了就是壞了，測試紅。
    const GUARD: Duration = Duration::from_secs(30);

    /// poll 一次，回 poll 完的那一批；還沒交給 [`Forward::step`]。
    fn polled(forward: &mut Forward) -> Vec<libc::pollfd> {
        let mut fds = Vec::new();
        forward.poll_fds(&mut fds, true, Instant::now());
        // SAFETY：fds 是剛填好的 pollfd，長度照它的。
        let ready = unsafe {
            libc::poll(
                fds.as_mut_ptr(),
                fds.len() as libc::nfds_t,
                GUARD.as_millis() as libc::c_int,
            )
        };
        assert!(ready > 0, "等不到任何一個 fd 動");
        fds
    }

    /// 一條轉送中的連線：`Forward`、前台那一端、葉子那一端，與要刪的暫存目錄。
    fn linked(tag: &str) -> (Forward, UnixStream, UnixStream, PathBuf) {
        let dir = std::env::temp_dir().join(format!("nfwd-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let leaf_listener = UnixListener::bind(dir.join("leaf.sock")).unwrap();
        let front = UnixListener::bind(dir.join("front.sock")).unwrap();
        let mut forward = Forward::new(front, dir.join("leaf.sock")).unwrap();
        let client = UnixStream::connect(dir.join("front.sock")).unwrap();
        client.set_read_timeout(Some(GUARD)).unwrap();
        let fds = polled(&mut forward);
        forward.step(&fds, Instant::now());
        assert_eq!(forward.links.len(), 1);
        let (leaf, _) = leaf_listener.accept().unwrap();
        (forward, client, leaf, dir)
    }

    fn round(forward: &mut Forward) {
        let fds = polled(forward);
        forward.step(&fds, Instant::now());
    }

    /// 葉子在這一輪 poll 之後、寫之前才回應並整條關：往葉子寫會出錯，葉子關之前送出的回應還是要到前台。
    /// poll 與寫之間的空窗從行程外面排不出來，所以在行程內拿 poll 當下那一批 `pollfd` 叫 `step`。
    #[test]
    fn a_response_from_a_leaf_that_closed_between_poll_and_write_still_arrives() {
        let (mut forward, mut client, mut leaf, dir) = linked("stale");
        client.write_all(b"request").unwrap();
        let stale = polled(&mut forward);
        let leaf_fd = forward.links[0].leaf.fd.as_raw_fd();
        assert!(
            stale
                .iter()
                .all(|pfd| pfd.fd != leaf_fd || pfd.revents == 0),
            "葉子那一端在它回應之前就有事件"
        );
        // 這時還沒有人讀葉子送出的，整份要放得進 socket 的緩衝。
        let response: Vec<u8> = (0..4 * 1024).map(|i| (i % 251) as u8).collect();
        leaf.write_all(&response).unwrap();
        drop(leaf);
        forward.step(&stale, Instant::now());

        while !forward.links.is_empty() {
            round(&mut forward);
        }
        let mut arrived = Vec::new();
        client.read_to_end(&mut arrived).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            arrived == response,
            "回應被截了：到了 {} 個位元組",
            arrived.len()
        );
    }

    /// 葉子只關了讀的方向、還在送：往它寫會出錯，但它沒有斷，之後送的照樣要到前台。
    /// 把寫出錯當成那一端斷了的話，連線在第一輪就收掉，葉子下一次寫會失敗。
    /// 只在 Linux 跑：對方關了讀的方向之後寫會回 `EPIPE` 是 Linux 的行為，macOS 上寫得進去，走不到要釘的那條路。
    #[cfg(target_os = "linux")]
    #[test]
    fn a_leaf_that_only_stopped_reading_can_still_send() {
        let (mut forward, mut client, mut leaf, dir) = linked("shut-rd");
        leaf.shutdown(Shutdown::Read).unwrap();
        client.write_all(b"request").unwrap();
        round(&mut forward);
        assert!(
            forward.links[0].up.done,
            "往葉子寫沒有出錯，沒走到要釘的那條路"
        );
        for part in [&b"first"[..], &b"second"[..]] {
            leaf.write_all(part).unwrap();
            round(&mut forward);
            let mut arrived = vec![0; part.len()];
            client.read_exact(&mut arrived).unwrap();
            assert_eq!(arrived, part);
        }
        drop(leaf);
        while !forward.links.is_empty() {
            round(&mut forward);
        }
        let mut rest = Vec::new();
        client.read_to_end(&mut rest).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(rest, b"");
    }
}
