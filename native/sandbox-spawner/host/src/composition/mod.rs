//! 組合行程（[#2583](https://github.com/DemianLi/nexus-agent/issues/2583)）：一對裡 Rust 的那一個，每條對話一個。現在只有骨架：
//! 跟監督行程握手、在橋上等葉子（[`crate::pair`]）、把 `bind` 經橋轉成 `attach`、把前台的連線原樣轉給葉子（[`forward`]）。
//! 還沒有人起它（監督行程、harness 與出貨都還沒接），只有整合測試起；不連宿主。
//!
//! ```text
//! nexus-composition --socket <路徑> --pair-socket <路徑> --leaf-socket <路徑>
//! ```
//!
//! `--socket` 是前台連的（這裡 listen），`--pair-socket` 是橋（這裡 listen、葉子連進來），`--leaf-socket` 是葉子自己 listen 的資料 socket。
//!
//! 控制通道是 stdin／stdout，走對話行程那一組訊息（[`nexus_sandbox_spawner::supervisor_protocol`]）。單執行緒、一個 poll 迴圈。
//!
//! - 一起來先綁兩個 socket（舊的先刪掉）再送 `hello`（不宣告 loop 在自己這裡）：監督行程讀到 `hello` 時兩個 socket 都已經在聽。
//!   監督行程的第一框要是同一版的 `hello`；它帶的 token 還用不到。
//! - `leaf{pid}`：交給橋，橋只認這個 pid 的連線；已經連著的葉子斷掉。
//! - `ready` 只送一次：葉子在橋上驗過、而且送了第一則 `register`（清單可以是空的）之後。換了葉子不再送。`ready` 之前不收前台的連線。
//! - `bind`（`ready` 之後才合法）：thread 記第一次的，之後每一則都要相同。
//!   - 現在的葉子驗過並 `register` 了、還沒綁過：馬上在橋上 `attach`，葉子回成功才送 `bound`。
//!   - 沒有這樣的葉子（斷了、換了還沒到）：留著，等葉子 `register` 那一刻再 `attach`。
//!   - `attach` 沒成功（葉子回錯、送不出去、回之前斷線）：記一行，不送 `bound`，不替下一個葉子重試，等監督行程再送 `bind`。
//! - 心跳：收到第一則 `bind` 起每 [`HEARTBEAT`] 送一次，之後不停。
//! - `drain`：不該送到這裡（只有宣告 loop 的行程回答），記一行、不理。
//! - 葉子斷線：照活，等下一則 `leaf{pid}`。
//! - 協定錯誤（回 3）：第一框不是同一版的 `hello`；解不開的框或訊息；`ready` 之前的 `bind`；thread 不同或不是 UTF-8 的 `bind`；
//!   現在的葉子已經綁了、`attach` 還沒回、或已經有一則留著時又來的 `bind`。
//! - stdin 讀到 EOF 或收到 SIGTERM：刪掉兩個 socket、回 0。

macro_rules! say {
    ($($arg:tt)*) => { eprintln!("nexus-composition: {}", format_args!($($arg)*)) };
}

pub mod forward;

use crate::pair::{Pair, PairEvent};
use forward::Forward;
use nexus_sandbox_spawner::supervisor::process::Chan;
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_conversation_command, encode_conversation_report, ConversationCommand,
    ConversationReport, PROTOCOL_VERSION,
};
use std::ffi::OsString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

/// 綁定之後多久送一次心跳；跟對話行程相同。
pub const HEARTBEAT: Duration = Duration::from_secs(1);

/// 協定錯誤的結束碼。
pub const EXIT_PROTOCOL: i32 = 3;

const USAGE: &str = "nexus-composition --socket <路徑> --pair-socket <路徑> --leaf-socket <路徑>";

/// SIGTERM 的 handler 往這個 fd 寫一個 byte 叫醒迴圈。
static TERM_FD: AtomicI32 = AtomicI32::new(-1);

extern "C" fn on_sigterm(_: libc::c_int) {
    // SAFETY：handler 裡只用 async-signal-safe 的 write；管線滿了或沒開，寫不進去都不理。
    unsafe { libc::write(TERM_FD.load(Ordering::SeqCst), b"t".as_ptr().cast(), 1) };
}

/// 開一條非阻塞的管線、裝上 SIGTERM 的 handler，回讀端。
fn watch_sigterm() -> std::io::Result<OwnedFd> {
    let mut fds: [libc::c_int; 2] = [0; 2];
    // SAFETY：fds 是兩個 int 的陣列。
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY：兩個 fd 是剛開的，只改它們的旗標；讀端交給 OwnedFd，寫端留到行程結束；handler 只做 write。
    unsafe {
        for fd in fds {
            libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            let flags = libc::fcntl(fd, libc::F_GETFL);
            libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        TERM_FD.store(fds[1], Ordering::SeqCst);
        libc::signal(
            libc::SIGTERM,
            on_sigterm as extern "C" fn(libc::c_int) as libc::sighandler_t,
        );
        Ok(OwnedFd::from_raw_fd(fds[0]))
    }
}

struct Args {
    socket: PathBuf,
    pair_socket: PathBuf,
    leaf_socket: PathBuf,
}

fn parse(args: Vec<OsString>) -> Result<Args, String> {
    let mut args = args.into_iter();
    let (mut socket, mut pair_socket, mut leaf_socket) = (None, None, None);
    while let Some(arg) = args.next() {
        let slot = match arg.to_str() {
            Some("--socket") => &mut socket,
            Some("--pair-socket") => &mut pair_socket,
            Some("--leaf-socket") => &mut leaf_socket,
            _ => return Err(format!("不認得的參數 {}", arg.to_string_lossy())),
        };
        let path = args
            .next()
            .ok_or_else(|| format!("{} 要一個路徑", arg.to_string_lossy()))?;
        *slot = Some(PathBuf::from(path));
    }
    Ok(Args {
        socket: socket.ok_or("少了 --socket")?,
        pair_socket: pair_socket.ok_or("少了 --pair-socket")?,
        leaf_socket: leaf_socket.ok_or("少了 --leaf-socket")?,
    })
}

fn bind(path: &Path) -> std::io::Result<UnixListener> {
    let _ = std::fs::remove_file(path);
    UnixListener::bind(path)
}

fn pollfd(fd: libc::c_int, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

struct Composition {
    control: Chan,
    pair: Pair,
    forward: Forward,
    term: OwnedFd,
    /// 收到監督行程的 `hello` 了。
    hello: bool,
    ready: bool,
    /// 現在的葉子驗過、而且送過 `register`。
    registered: bool,
    /// 第一則 `bind` 的 thread。
    thread: Option<String>,
    /// 留著的 `bind`：等葉子 `register`。
    held: bool,
    /// 還沒回的 `attach`。
    attaching: Option<u64>,
    /// 現在的葉子回過 `attach` 成功。
    bound: bool,
    /// 下一次心跳的時刻；還沒收過 `bind` 是 `None`。
    heartbeat: Option<Instant>,
}

/// 跑組合行程，回結束碼：0 是 stdin 讀到 EOF 或收到 SIGTERM；1 是綁不了 socket；2 是參數不對；3 是協定錯誤（[`EXIT_PROTOCOL`]）。
pub fn run(args: Vec<OsString>) -> i32 {
    let args = match parse(args) {
        Ok(args) => args,
        Err(err) => {
            say!("{err}\n用法：{USAGE}");
            return 2;
        }
    };
    // SAFETY：fd 0、1 是監督行程接好的控制通道，整個行程只有這裡拿它們。
    let mut control = unsafe {
        Chan::from_fds(
            OwnedFd::from_raw_fd(0),
            OwnedFd::from_raw_fd(1),
            nexus_sandbox_spawner::protocol::MAX_FRAME,
        )
    };
    let opened = watch_sigterm().and_then(|term| {
        let pair = Pair::new(bind(&args.pair_socket)?, &[])?;
        let forward = Forward::new(bind(&args.socket)?, args.leaf_socket.clone())?;
        Ok((term, pair, forward))
    });
    let (term, pair, forward) = match opened {
        Ok(opened) => opened,
        Err(err) => {
            say!("起不來：{err}");
            return 1;
        }
    };
    control.send(&encode_conversation_report(&ConversationReport::Hello {
        version: PROTOCOL_VERSION,
        runs_loop: false,
    }));
    let mut composition = Composition {
        control,
        pair,
        forward,
        term,
        hello: false,
        ready: false,
        registered: false,
        thread: None,
        held: false,
        attaching: None,
        bound: false,
        heartbeat: None,
    };
    let code = composition.serve();
    let _ = std::fs::remove_file(&args.socket);
    let _ = std::fs::remove_file(&args.pair_socket);
    code
}

impl Composition {
    fn report(&mut self, report: &ConversationReport) {
        self.control.send(&encode_conversation_report(report));
    }

    fn serve(&mut self) -> i32 {
        loop {
            if self.control.read_closed() {
                return 0;
            }
            let now = Instant::now();
            let deadline = self
                .pair
                .deadline(now)
                .into_iter()
                .chain(self.forward.deadline())
                .chain(self.heartbeat)
                .min();
            let (read, write) = self.control.poll_fds();
            let mut fds = vec![
                pollfd(read.unwrap_or(-1), libc::POLLIN),
                pollfd(write.unwrap_or(-1), libc::POLLOUT),
                pollfd(self.term.as_raw_fd(), libc::POLLIN),
            ];
            self.pair.poll_fds(&mut fds);
            self.forward.poll_fds(&mut fds, self.ready, now);
            let ms = deadline.map_or(-1, |at| {
                let left = at.saturating_duration_since(now);
                if left.is_zero() {
                    0
                } else {
                    libc::c_int::try_from(left.as_millis().max(1)).unwrap_or(libc::c_int::MAX)
                }
            });
            let n = libc::nfds_t::try_from(fds.len()).unwrap_or(libc::nfds_t::MAX);
            // SAFETY：fds 是一段 pollfd。
            unsafe { libc::poll(fds.as_mut_ptr(), n, ms) };
            if fds[2].revents != 0 {
                say!("收到 SIGTERM");
                return 0;
            }

            self.control.flush();
            let (frames, err) = self.control.receive_all();
            for frame in frames {
                if let Err(code) = self.on_command(&frame) {
                    return code;
                }
            }
            if let Some(err) = err {
                say!("監督行程送來解不開的框：{}", err.0);
                return EXIT_PROTOCOL;
            }
            let now = Instant::now();
            self.step_pair(now);
            self.forward.step(&fds, now);
            if self.heartbeat.is_some_and(|at| at <= now) {
                self.report(&ConversationReport::Heartbeat);
                self.heartbeat = Some(now + HEARTBEAT);
            }
        }
    }

    fn on_command(&mut self, frame: &[u8]) -> Result<(), i32> {
        let command = decode_conversation_command(frame).map_err(|err| {
            say!("監督行程送來解不開的訊息：{}", err.0);
            EXIT_PROTOCOL
        })?;
        if !self.hello {
            return match command {
                ConversationCommand::Hello {
                    version: PROTOCOL_VERSION,
                    ..
                } => {
                    self.hello = true;
                    Ok(())
                }
                ConversationCommand::Hello { version, .. } => {
                    say!("監督行程的 hello 是第 {version} 版，這裡是第 {PROTOCOL_VERSION} 版");
                    Err(EXIT_PROTOCOL)
                }
                _ => {
                    say!("監督行程的第一框不是 hello");
                    Err(EXIT_PROTOCOL)
                }
            };
        }
        match command {
            ConversationCommand::Hello { .. } => say!("監督行程又送了一次 hello，不理"),
            ConversationCommand::Leaf { pid } => {
                self.pair.set_leaf(pid);
                // 同一批裡跟在後面的 `bind` 要看到舊葉子已經斷了。
                self.step_pair(Instant::now());
            }
            ConversationCommand::Bind { thread_id } => return self.on_bind(thread_id),
            ConversationCommand::Drain => say!("收到 drain：loop 不在這裡，不理"),
        }
        Ok(())
    }

    fn on_bind(&mut self, thread_id: Vec<u8>) -> Result<(), i32> {
        if !self.ready {
            say!("ready 之前就收到 bind");
            return Err(EXIT_PROTOCOL);
        }
        let Ok(thread) = String::from_utf8(thread_id) else {
            say!("bind 的 thread 不是 UTF-8");
            return Err(EXIT_PROTOCOL);
        };
        if self.thread.as_ref().is_some_and(|first| *first != thread) {
            say!("bind 的 thread 跟第一次的不同");
            return Err(EXIT_PROTOCOL);
        }
        if self.bound || self.attaching.is_some() || self.held {
            say!("現在的葉子已經綁了（或正在綁）又收到 bind");
            return Err(EXIT_PROTOCOL);
        }
        self.thread = Some(thread);
        if self.heartbeat.is_none() {
            self.heartbeat = Some(Instant::now() + HEARTBEAT);
        }
        if self.registered {
            self.attach();
        } else {
            self.held = true;
        }
        Ok(())
    }

    fn attach(&mut self) {
        let Some(thread) = self.thread.as_deref() else {
            return;
        };
        match self.pair.attach(thread) {
            Ok(id) => self.attaching = Some(id),
            Err(err) => say!("attach 送不出去（{err:?}），不送 bound"),
        }
    }

    fn step_pair(&mut self, now: Instant) {
        for event in self.pair.step(now) {
            match event {
                PairEvent::Connected { pid } => say!("葉子 {pid} 連上橋"),
                PairEvent::Registered { tools, hooks } => {
                    say!("葉子登記了 {} 個工具、{} 個 hook", tools.len(), hooks.len());
                    if std::mem::replace(&mut self.registered, true) {
                        continue;
                    }
                    if !std::mem::replace(&mut self.ready, true) {
                        self.report(&ConversationReport::Ready);
                    }
                    if std::mem::take(&mut self.held) {
                        self.attach();
                    }
                }
                PairEvent::Finished { id, outcome } if self.attaching == Some(id) => {
                    self.attaching = None;
                    match (outcome, self.thread.clone()) {
                        (Ok(_), Some(thread)) => {
                            self.bound = true;
                            self.report(&ConversationReport::Bound {
                                thread_id: thread.into_bytes(),
                            });
                        }
                        (outcome, _) => say!("attach 沒成功（{outcome:?}），不送 bound"),
                    }
                }
                PairEvent::Disconnected { reason } => {
                    say!("葉子斷線：{reason:?}");
                    self.thread = self.thread.take().map(|_| String::new());
                    self.registered = false;
                    self.bound = false;
                    self.attaching = None;
                }
                PairEvent::Refused { pid, reason } => {
                    say!("橋上不收一條連線（pid {pid:?}）：{reason}")
                }
                PairEvent::Call { .. }
                | PairEvent::Cancelled { .. }
                | PairEvent::Chunk { .. }
                | PairEvent::Finished { .. }
                | PairEvent::Resumed => {}
            }
        }
    }
}
