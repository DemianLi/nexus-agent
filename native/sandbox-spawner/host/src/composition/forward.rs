//! 前台連線的轉送：`--socket` 上每收一條，就對葉子的資料 socket 連一條，位元組原樣雙向對接，不解析內容。
//!
//! 不自己跑事件迴圈：擁有它的一方每一輪先叫 [`Forward::poll_fds`]、poll 完把同一批 `pollfd` 交給 [`Forward::step`]。
//!
//! - 每個方向讀一次最多 [`BUFFER`]、馬上寫給另一邊；寫不完的留著，留著的寫完之前不再讀來源，所以每個方向最多留 [`BUFFER`]，
//!   對方不讀時來源那一端的寫入會被核心擋住。
//! - 一邊讀到 EOF：留著的寫完之後只關另一邊寫的方向；兩個方向都結束才整條關。
//! - 一邊整條關了（`POLLHUP`）：往它的那個方向當場作廢；它關之前送出、還沒讀的照樣轉給另一邊。
//!   這靠 Linux 的語意：stream socket 兩個方向都關了才有 `POLLHUP`，對方只關寫的方向不算。
//! - 讀寫出錯：兩邊一起關。
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
    /// 對方整條關了：不再 poll 它（`POLLHUP` 不用登記也會一直回報），剩下的靠另一端的事件推進。
    hup: bool,
}

/// 一個方向。
#[derive(Default)]
struct Half {
    /// 讀進來、還沒寫出去的。
    pending: Vec<u8>,
    /// 來源讀到 EOF 了。
    eof: bool,
    /// 這個方向結束了：目的端寫的方向已經關，或目的端整條關了。
    done: bool,
}

impl Half {
    fn wants_read(&self) -> bool {
        !self.done && !self.eof
    }

    fn wants_write(&self) -> bool {
        !self.done && !self.pending.is_empty()
    }

    /// 目的端整條關了：留著的丟掉。
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
    pollfd(if end.hup { -1 } else { end.fd.as_raw_fd() }, events)
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

/// 推一個方向：先寫留著的，寫完了才讀來源、讀到就寫；來源 EOF 而且都寫完了，關目的端寫的方向。一次最多讀 `budget`。
fn pump(
    src: RawFd,
    dst: RawFd,
    half: &mut Half,
    scratch: &mut [u8],
    mut budget: usize,
) -> io::Result<()> {
    if half.done {
        return Ok(());
    }
    if !half.pending.is_empty() {
        let written = write_some(dst, &half.pending)?;
        half.pending.drain(..written);
    }
    while !half.eof && budget > 0 {
        let room = budget.min(scratch.len());
        // SAFETY：讀進 scratch 的前 room 個 byte。
        let n = unsafe { libc::read(src, scratch.as_mut_ptr().cast(), room) };
        if n == 0 {
            half.eof = true;
        } else if n > 0 {
            let n = n as usize;
            budget = budget.saturating_sub(n);
            let written = write_some(dst, &scratch[..n])?;
            half.pending.extend_from_slice(&scratch[written..n]);
        } else {
            match errno() {
                libc::EINTR => continue,
                libc::EAGAIN => break,
                _ => return Err(io::Error::last_os_error()),
            }
        }
    }
    if half.eof && half.pending.is_empty() {
        // SAFETY：只關這個 fd 寫的方向。對方已經整條關了會回錯，不理。
        unsafe { libc::shutdown(dst, libc::SHUT_WR) };
        half.done = true;
    }
    Ok(())
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
    // SAFETY：只改這個 fd 的旗標；addr 是填好的 sockaddr_un，長度照它的大小。
    let rc = unsafe {
        libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC);
        let flags = libc::fcntl(raw, libc::F_GETFL);
        libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK);
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

    /// 正在轉送幾條。
    pub fn links(&self) -> usize {
        self.links.len()
    }

    /// 要 poll 的 fd，接在 `fds` 後面。`accepting` 是現在收不收新的連線。
    pub fn poll_fds(&mut self, fds: &mut Vec<libc::pollfd>, accepting: bool, now: Instant) {
        self.accept_after = self.accept_after.filter(|&until| now < until);
        self.base = fds.len();
        self.polled = self.links.len();
        let listening = accepting && self.accept_after.is_none();
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
            if (client | leaf) & (libc::POLLERR | libc::POLLNVAL) != 0 {
                return false;
            }
            link.client.hup |= client & libc::POLLHUP != 0;
            link.leaf.hup |= leaf & libc::POLLHUP != 0;
            if client == 0 && leaf == 0 && !link.client.hup && !link.leaf.hup {
                return true;
            }
            if link.client.hup {
                link.down.abandon();
            }
            if link.leaf.hup {
                link.up.abandon();
            }
            // 整條關了的那一端不再 poll，所以它剩下的要在這裡讀到 EOF 或另一邊寫不進去為止；它不會再有新的進來，讀不會沒完。
            let budget = |end: &End| if end.hup { usize::MAX } else { BUFFER };
            let (up, down) = (budget(&link.client), budget(&link.leaf));
            let (client, leaf) = (link.client.fd.as_raw_fd(), link.leaf.fd.as_raw_fd());
            let ok = pump(client, leaf, &mut link.up, scratch, up).is_ok()
                && pump(leaf, client, &mut link.down, scratch, down).is_ok();
            ok && !(link.up.done || link.down.done)
        });
        if polled[0].revents != 0 {
            self.accept(now);
        }
    }

    fn accept(&mut self, now: Instant) {
        loop {
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
                            hup: false,
                        },
                        leaf: End {
                            fd: leaf,
                            hup: false,
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
