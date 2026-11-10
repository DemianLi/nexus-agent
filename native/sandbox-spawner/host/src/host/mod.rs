//! 宿主（[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）：監督行程起的第三種子行程，全機共用一個，不在資料路徑上。
//! 做五件事：跟監督行程握手、照 `--plugins` 掛主機級的插件樹（[`plugins`]）、收身分表、在 `--socket` 上收前台與對話行程的連線並驗身分、
//! 把驗過身分的連線上的呼叫交給樹上的服務（[`calls`]）。出貨的建置還沒有任何插件，所以還沒有任何服務。
//!
//! ```text
//! nexus-host [--plugins <檔>] --socket <路徑>
//! ```
//!
//! 沒帶 `--plugins`，或檔案不存在，是空樹。檔案讀不了或解析不過，寫一行 log、送 `config-broken`（帶那句錯誤）取代 `ready`、回 4，不綁 socket。插件的事件（狀態轉換、設定被插件拒絕、apply 失敗…）每一筆寫一行 log。
//!
//! 控制通道是 stdin／stdout（[`nexus_sandbox_spawner::supervisor_protocol`] 的 `HostCommand`／`HostReport`）。一起來先送 `hello`，等監督行程的 `hello`，
//! 版本不同就回 3。接著綁 socket（舊的先刪掉），之後才送 `ready`：`ready` 之前不可能有客戶端的輸入。stdin 讀到 EOF 或讀不下去（控制通道送來超長的框）就刪掉 socket、回 0。
//!
//! 身分表由監督行程給（`grant`／`revoke`），宿主不看客戶端自己說的身分：連線的 pid 取自 `SO_PEERCRED`（核心在 `connect()` 那一刻記下的），
//! uid 要跟自己相同；`hello` 帶的 token 要跟表上那個 pid 的相同、版本要相等。驗每一個 `hello` 之前，先把控制通道讀到 EAGAIN：
//! 宿主 `ready` 而且沒在停時，監督行程收屍之前就把 `revoke` 寫進 pipe（500 ms 內寫不進去就先殺掉宿主的群組，再收屍），pid 被重用之後才 `connect()` 的連線，
//! 它的 `hello` 一定比那一筆晚，所以這一讀一定讀得到。反過來，宿主讀到監督行程的 `revoke` 時，那個 pid 上已經連上的連線（已 accept 的，
//! 與還在 listen backlog 的）全部記成撤過，之後它們送什麼都只回 `rejected`、報 `unregistered`，不照同一個號碼後來的登記驗，也不撤那一筆。
//! accept 出錯而沒收進來的連線不會記成撤過，之後被 accept 時照當下的表驗；起來時把開檔數的軟上限拉到硬上限，就是為了不在這裡用完 fd。pid 被重用得比宿主讀 pipe 還快時，
//! 新行程先連上的連線也會這樣被拒，要重連（它不會被隔離）。
//!
//! 違反協定（框太大、解不開、種類不認得、版本或 token 不對、重複的 `hello`，以及 [`calls`] 列的那幾種）：回 `rejected`、斷線，經控制通道回報監督行程
//! （`violation`，它寫稽核），表上那個 pid 撤掉、它其他驗過身分的連線一起斷，還沒送 `hello` 的記成撤過。監督行程把那個身分隔離到行程結束：
//! 之後重送的表裡不再有它；宿主 `ready` 而且沒在停的，再送一筆 `revoke`，蓋掉可能還排在監督行程那邊、沒寫出去的 `grant`（這一筆也照上面收 backlog）。
//! `hello` 的 pid 不在表上的，與撤過的連線（送什麼都算），只回 `rejected`、斷線、回報 `unregistered`（算不算違規由監督行程判斷），不撤表上那一筆。
//! 宿主自己不因為任何一條連線結束。
//!
//! 每種狀態的連線收到每種輸入時怎麼處理，整理成表在 `native/sandbox-spawner/README.md`〈連線身分的狀態表〉，每一格附釘住它的測試或不測的原因。
//!
//! 連線數最多 [`MAX_CONNECTIONS`]（收監督行程的 `revoke` 時收 backlog 不受這個上限，見 `Host::sync`）；連上之後 [`HELLO_TIMEOUT`] 內沒送 `hello` 的斷掉。

pub mod plugins;
#[cfg(feature = "test-hooks")]
mod test_plugin;

use crate::host_protocol::{
    self, decode_client_message, encode_host_message, ClientMessage, HostMessage,
    HOST_PROTOCOL_VERSION,
};
use crate::kernel::{Kernel, KernelEvent, Limits};
use nexus_sandbox_spawner::supervisor::process::Chan;
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_host_command, encode_host_report, HostCommand, HostReport, Role, PROTOCOL_VERSION,
};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// 同時最多幾條客戶端連線；滿了先不 accept（收監督行程的 `revoke` 時除外）。
pub const MAX_CONNECTIONS: usize = 1024;
/// 連上之後多久內要送 `hello`。
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

const EXIT_PROTOCOL: i32 = 3;
/// `--plugins` 的檔案讀不了或解析不過。
pub const EXIT_CONFIG: i32 = nexus_sandbox_spawner::supervisor_protocol::HOST_EXIT_CONFIG;
/// 結束前把 `config-broken` 寫給監督行程最多等這麼久；寫不完照樣結束，監督行程看結束碼一樣知道。
const CONFIG_BROKEN_WRITE_LIMIT: Duration = Duration::from_millis(500);

const USAGE: &str = "nexus-host [--plugins <檔>] --socket <路徑>";

macro_rules! say {
    ($($arg:tt)*) => { eprintln!("nexus-host: {}", format_args!($($arg)*)) };
}

pub mod calls;

struct Grant {
    generation: u32,
    token: Vec<u8>,
    role: Role,
    thread: Vec<u8>,
}

struct Conn {
    /// 這個宿主行程裡依 accept 的順序編的號，從 1 起；拒絕時的 log 與 `unregistered` 都寫它。
    id: u32,
    chan: Chan,
    /// `SO_PEERCRED` 的 pid；取不到或 uid 不同是 `None`，它的 `hello` 一律不收。
    pid: Option<u32>,
    opened: Instant,
    hello: bool,
    /// 送過 `hello` 的：驗它時那一筆的序號，報違規時帶回去。還沒送是 0。
    generation: u32,
    /// 那個 pid 被撤過：之後送什麼都只回 `rejected`、報 `unregistered`；同一個 pid 號碼又登記了，也不照新的那一筆驗、不撤它。
    revoked: bool,
    /// 要斷了：這一輪結束時清掉。輪中途不刪，索引才不會錯位。
    dead: bool,
    /// 還在跑的呼叫，以客戶端給的 `id` 為鍵。
    calls: HashMap<u64, calls::Call>,
    /// 讀進來、還沒處理的框。寫出去的排到 [`calls::OUTBOX_PAUSE`] 時停在這裡，對方讀走之後再接著處理。
    backlog: VecDeque<Vec<u8>>,
}

impl Conn {
    /// 排著沒寫出去的到了 [`calls::OUTBOX_PAUSE`]：不讀它、不處理它的框、不 poll 它的呼叫，等對方讀走。
    fn paused(&self) -> bool {
        self.chan.queued() >= calls::OUTBOX_PAUSE
    }

    /// 有留著的框可以處理：沒有新的輸入也要叫醒事件迴圈。
    fn backlog_ready(&self) -> bool {
        !self.dead && !self.backlog.is_empty() && !self.paused()
    }
}

struct Host {
    control: Chan,
    listener: UnixListener,
    grants: HashMap<u32, Grant>,
    conns: Vec<Conn>,
    /// 最後一條 accept 的連線的編號，還沒有是 0。
    last_conn: u32,
    /// 預留的一個 fd（開 `/dev/null`）：accept 遇到開檔數用完時先關掉它，騰出位子把排著的那條接下來就關，backlog 才收得乾淨，
    /// listener 也不會一直可讀、讓 poll 空轉。整台主機的 fd 都用完時可能開不回來，是 `None`。
    spare: Option<OwnedFd>,
    /// 這一輪 accept 要退避時（開檔數用完而 [`Host::shed`] 沒接到連線，或 accept 的其他錯），這一刻之前不 poll listener；收 `revoke` 時的 accept 不看它。
    accept_paused_until: Option<Instant>,
    /// 這一段開檔數用完的期間已經記過 log：接下一條連線之後才再記。
    out_of_fds: bool,
    kernel: Kernel,
}

/// accept 要退避時（見 `accept_paused_until`），停 poll listener 這麼久再試。
const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

fn open_spare() -> Option<OwnedFd> {
    std::fs::File::open("/dev/null").ok().map(OwnedFd::from)
}

struct Args {
    socket: PathBuf,
    plugins: Option<PathBuf>,
}

fn parse(args: Vec<OsString>) -> Result<Args, String> {
    let mut args = args.into_iter();
    let mut socket = None;
    let mut plugins = None;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--socket") => {
                socket = Some(PathBuf::from(args.next().ok_or("--socket 要一個路徑")?))
            }
            Some("--plugins") => {
                plugins = Some(PathBuf::from(args.next().ok_or("--plugins 要一個路徑")?))
            }
            _ => return Err(format!("不認得的參數 {}", arg.to_string_lossy())),
        }
    }
    Ok(Args {
        socket: socket.ok_or("少了 --socket")?,
        plugins,
    })
}

/// 照 `--plugins` 建樹；沒帶或檔案不存在是空樹。
fn build_kernel(path: Option<&std::path::Path>) -> Result<Kernel, String> {
    let mut kernel = Kernel::new(Limits::default(), Instant::now());
    kernel.set_log(|line| say!("{line}"));
    let Some(path) = path else { return Ok(kernel) };
    match plugins::load(path, plugins::specs())? {
        plugins::Loaded::Missing => say!("{} 不存在，不掛插件", path.display()),
        plugins::Loaded::Rows(rows) => {
            let root = kernel.root();
            kernel.load(root, &rows).map_err(|err| err.to_string())?;
        }
    }
    Ok(kernel)
}

fn log_kernel_event(event: &KernelEvent) {
    match event {
        KernelEvent::Status { name, from, to, .. } => say!("插件 {name}：{from:?} → {to:?}"),
        KernelEvent::ConfigRejected { name, error, .. } => say!("插件 {name} 沒掛：{error}"),
        KernelEvent::ApplyFailed { name, error, .. } => say!("插件 {name} apply 失敗：{error}"),
        other => say!("插件事件：{other:?}"),
    }
}

/// 跑宿主，回結束碼：0 是 `ready` 之後 stdin 讀到 EOF 或讀不下去（監督行程要它收，或控制通道送來超長的框）；1 是 `hello` 之前 stdin 就 EOF，或綁不了 socket；2 是參數不對；
/// 3 是監督行程的第一框不是這一版的 `hello`，或解不開；4 是 `--plugins` 的檔案讀不了或解析不過（[`EXIT_CONFIG`]）。
pub fn run(args: Vec<OsString>) -> i32 {
    let Args { socket, plugins } = match parse(args) {
        Ok(args) => args,
        Err(err) => {
            say!("{err}\n用法：{USAGE}");
            return 2;
        }
    };
    raise_open_file_limit();
    // SAFETY：fd 0、1 是監督行程接好的控制通道，整個行程只有這裡拿它們。
    let mut control = unsafe {
        Chan::from_fds(
            OwnedFd::from_raw_fd(0),
            OwnedFd::from_raw_fd(1),
            nexus_sandbox_spawner::protocol::MAX_FRAME,
        )
    };
    control.send(&encode_host_report(&HostReport::Hello {
        version: PROTOCOL_VERSION,
    }));
    if let Err(code) = await_hello(&mut control) {
        return code;
    }
    let kernel = match build_kernel(plugins.as_deref()) {
        Ok(kernel) => kernel,
        Err(err) => {
            say!("插件清單壞了：{err}");
            control.send(&encode_host_report(&HostReport::ConfigBroken {
                reason: err.into_bytes(),
            }));
            control.flush_until(Instant::now() + CONFIG_BROKEN_WRITE_LIMIT);
            return EXIT_CONFIG;
        }
    };
    let _ = std::fs::remove_file(&socket);
    let listener =
        match UnixListener::bind(&socket).and_then(|l| l.set_nonblocking(true).map(|()| l)) {
            Ok(listener) => listener,
            Err(err) => {
                say!("綁不了 {}：{err}", socket.display());
                return 1;
            }
        };
    let mut host = Host {
        control,
        listener,
        grants: HashMap::new(),
        conns: Vec::new(),
        last_conn: 0,
        spare: open_spare(),
        accept_paused_until: None,
        out_of_fds: false,
        kernel,
    };
    host.step_kernel();
    host.report(&HostReport::Ready);
    let code = host.serve();
    let _ = std::fs::remove_file(&socket);
    code
}

/// 開檔數的軟上限拉到硬上限：每條連線佔兩個 fd。拉不了就照原本的跑。
fn raise_open_file_limit() {
    // SAFETY：rlimit 是純資料，全零合法；只改自己的 RLIMIT_NOFILE。
    unsafe {
        let mut limit: libc::rlimit = std::mem::zeroed();
        if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) == 0 && limit.rlim_cur < limit.rlim_max
        {
            limit.rlim_cur = limit.rlim_max;
            if libc::setrlimit(libc::RLIMIT_NOFILE, &limit) != 0 {
                say!("拉不高開檔數上限：{}", std::io::Error::last_os_error());
            }
        }
    }
}

fn poll(fds: &mut [libc::pollfd], timeout: Option<Duration>) {
    let ms = timeout.map_or(-1, |t| {
        libc::c_int::try_from(t.as_millis().max(1)).unwrap_or(libc::c_int::MAX)
    });
    let n = libc::nfds_t::try_from(fds.len()).unwrap_or(libc::nfds_t::MAX);
    // SAFETY：fds 是一段 pollfd。
    unsafe { libc::poll(fds.as_mut_ptr(), n, ms) };
}

fn pollfd(fd: libc::c_int, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

/// 連線那一端的 pid：uid 要跟自己相同。
fn peer_pid(fd: libc::c_int) -> Option<u32> {
    // SAFETY：ucred 是純資料，全零合法。
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = libc::socklen_t::try_from(std::mem::size_of::<libc::ucred>()).ok()?;
    // SAFETY：照 SO_PEERCRED 的大小傳 cred。
    let rc = unsafe {
        libc::getsockopt(
            fd,
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
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

/// 等監督行程的 `hello`：版本相等回 `Ok`，否則回結束碼。
fn await_hello(control: &mut Chan) -> Result<(), i32> {
    loop {
        let (read, write) = control.poll_fds();
        let mut fds: Vec<libc::pollfd> = read
            .map(|fd| pollfd(fd, libc::POLLIN))
            .into_iter()
            .collect();
        fds.extend(write.map(|fd| pollfd(fd, libc::POLLOUT)));
        if fds.is_empty() {
            say!("監督行程在 hello 之前就斷了");
            return Err(1);
        }
        poll(&mut fds, None);
        control.flush();
        let frames = control.receive().map_err(|err| {
            say!("監督行程送來解不開的框：{}", err.0);
            EXIT_PROTOCOL
        })?;
        if let Some(first) = frames.first() {
            return match decode_host_command(first) {
                Ok(HostCommand::Hello {
                    version: PROTOCOL_VERSION,
                }) => {
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
        if control.read_closed() {
            say!("監督行程在 hello 之前就斷了");
            return Err(1);
        }
    }
}

impl Host {
    fn report(&mut self, report: &HostReport) {
        self.control.send(&encode_host_report(report));
    }

    fn step_kernel(&mut self) {
        self.kernel.run(Instant::now());
        for event in self.kernel.drain_events() {
            log_kernel_event(&event);
        }
    }

    /// 把控制通道讀到 EAGAIN，套用身分表的變動。監督行程斷了回 `false`。框太大時讀端會關掉、宿主隨後結束，但在那之前切出來的框照樣先套用：
    /// [`Host::on_hello`] 與 [`Host::violate`] 呼叫它之後不看回傳值，接著就拿這張表驗連線、查序號。
    fn sync(&mut self) -> bool {
        let (frames, err) = self.control.receive_all();
        for frame in frames {
            match decode_host_command(&frame) {
                Ok(HostCommand::Grant {
                    pid,
                    generation,
                    token,
                    role,
                    thread,
                }) => {
                    self.grants.insert(
                        pid,
                        Grant {
                            generation,
                            token,
                            role,
                            thread,
                        },
                    );
                }
                Ok(HostCommand::Revoke { pid }) => {
                    // 收屍前送的（行程已死，它 `connect()` 的連線不是已經 accept 了，就是還排在 backlog 裡）與隔離時補送的，
                    // 都先把 backlog 收到空（不管連線數上限）才抓得齊，連線數可能暫時超過上限；沒送 `hello` 的 [`HELLO_TIMEOUT`] 內就斷。
                    self.accept(usize::MAX);
                    self.revoke(pid);
                }
                Ok(HostCommand::Hello { .. }) => say!("監督行程又送了一次 hello，不理"),
                Err(err) => say!("監督行程送來解不開的訊息（{}），不理", err.0),
            }
        }
        if let Some(err) = err {
            say!("監督行程送來解不開的框（{}）", err.0);
        }
        !self.control.read_closed()
    }

    /// 表上撤掉這個 pid，它的連線全部記成撤過，驗過身分的當場斷掉。還沒送 `hello` 的留著：之後不管送什麼都只回 `rejected`、
    /// 報 `unregistered`，pid 被重用、同一個號碼又登記了也一樣，舊行程留下的連線不能拿新的那一筆驗，也不能害它被撤。
    fn revoke(&mut self, pid: u32) {
        self.grants.remove(&pid);
        for conn in self.conns.iter_mut().filter(|conn| conn.pid == Some(pid)) {
            conn.revoked = true;
            conn.dead |= conn.hello;
        }
    }

    fn serve(&mut self) -> i32 {
        let listen_fd = self.listener.as_raw_fd();
        loop {
            // 驗 `hello` 與判違規時的那一讀也可能讀到 EOF：讀端關了就不再 poll 它，沒有等 `hello` 的連線時會一直等下去。
            if self.control.read_closed() {
                return 0;
            }
            let now = Instant::now();
            self.accept_paused_until = self.accept_paused_until.filter(|&until| now < until);
            let calls_deadline = self.calls_deadline();
            let deadline = self
                .conns
                .iter()
                .filter(|c| !c.hello)
                .map(|c| c.opened + HELLO_TIMEOUT)
                .chain(self.accept_paused_until)
                .chain(self.kernel.next_deadline())
                .chain(calls_deadline)
                .chain(self.calls_have_more().then_some(now))
                .chain(self.conns.iter().any(Conn::backlog_ready).then_some(now))
                .min();
            let (read, write) = self.control.poll_fds();
            let mut fds = Vec::with_capacity(self.conns.len() + 3);
            fds.push(pollfd(read.unwrap_or(-1), libc::POLLIN));
            fds.push(pollfd(write.unwrap_or(-1), libc::POLLOUT));
            let accepting =
                self.conns.len() < MAX_CONNECTIONS && self.accept_paused_until.is_none();
            fds.push(pollfd(if accepting { listen_fd } else { -1 }, libc::POLLIN));
            for conn in &self.conns {
                let (read, write) = conn.chan.poll_fds();
                let mut events = if write.is_some() { libc::POLLOUT } else { 0 };
                if !conn.paused() {
                    events |= libc::POLLIN;
                }
                fds.push(pollfd(read.or(write).unwrap_or(-1), events));
            }
            let polled_conns = self.conns.len();
            for fd in self.wake_fds() {
                fds.push(pollfd(fd, libc::POLLIN));
            }
            poll(&mut fds, deadline.map(|d| d.saturating_duration_since(now)));

            self.control.flush();
            if !self.sync() {
                return 0;
            }
            if accepting && fds[2].revents != 0 {
                self.accept(MAX_CONNECTIONS);
            }
            // fds 是三個固定的、這一輪的 `polled_conns` 條連線，再接各服務的喚醒 fd；這裡只取連線那段。新 accept 的下一輪才 poll 到。
            for (i, fd) in fds.iter().skip(3).take(polled_conns).enumerate() {
                let Some(conn) = self.conns.get(i) else {
                    continue;
                };
                if conn.dead || (fd.revents == 0 && !conn.backlog_ready()) {
                    continue;
                }
                if !self.on_readable(i) {
                    if let Some(conn) = self.conns.get_mut(i) {
                        conn.dead = true;
                    }
                }
            }
            self.step_kernel();
            let woken: Vec<RawFd> = fds[3 + polled_conns..]
                .iter()
                .filter(|fd| fd.revents != 0)
                .map(|fd| fd.fd)
                .collect();
            self.wake_remotes(&woken);
            self.pump_calls();
            let now = Instant::now();
            let keep = |conn: &Conn| {
                !conn.dead
                    && !conn.chan.read_closed()
                    && !conn.chan.write_closed()
                    && (conn.hello || now < conn.opened + HELLO_TIMEOUT)
            };
            for i in 0..self.conns.len() {
                if !keep(&self.conns[i]) {
                    self.drop_calls(i);
                }
            }
            self.conns.retain(keep);
        }
    }

    /// 收排著的連線，收到 EAGAIN、連線數到 `limit`，或要退避為止。開檔數用完時排著的連線接下來就關（見 [`Host::shed`]），不是留在 backlog；
    /// `shed` 接不到時（沒有預留的 fd、backlog 已空，或騰出位子還是接不到）停下來退避，那時還排著的連線留在 backlog。EMFILE、ENFILE 以外的錯記一行、退避。
    fn accept(&mut self, limit: usize) {
        while self.conns.len() < limit {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    let pid = peer_pid(stream.as_raw_fd());
                    let fd = OwnedFd::from(stream);
                    let Ok(write) = fd.try_clone() else {
                        self.note_out_of_fds();
                        continue;
                    };
                    self.out_of_fds = false;
                    let chan = Chan::from_fds(fd, write, host_protocol::MAX_FRAME);
                    self.last_conn = self.last_conn.wrapping_add(1);
                    let id = self.last_conn;
                    self.conns.push(Conn {
                        id,
                        chan,
                        pid,
                        opened: Instant::now(),
                        hello: false,
                        generation: 0,
                        revoked: false,
                        dead: false,
                        calls: HashMap::new(),
                        backlog: VecDeque::new(),
                    });
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(err) if matches!(err.raw_os_error(), Some(libc::EMFILE | libc::ENFILE)) => {
                    self.note_out_of_fds();
                    if !self.shed() {
                        self.accept_paused_until = Some(Instant::now() + ACCEPT_BACKOFF);
                        return;
                    }
                }
                Err(err) => {
                    say!("accept 失敗：{err}");
                    self.accept_paused_until = Some(Instant::now() + ACCEPT_BACKOFF);
                    return;
                }
            }
        }
    }

    /// 關掉預留的 fd、接下排著的一條連線就關，再把預留的開回來。接到了回 `true`；沒有預留的 fd（這時試著開回來），或騰出位子後 accept 沒接到
    /// （含 backlog 已空），回 `false`。
    fn shed(&mut self) -> bool {
        if self.spare.take().is_none() {
            self.spare = open_spare();
            return false;
        }
        let shed = self.listener.accept().is_ok();
        self.spare = open_spare();
        shed
    }

    fn note_out_of_fds(&mut self) {
        if !std::mem::replace(&mut self.out_of_fds, true) {
            say!("開檔數用完了：排著的連線接下來就關（預留的 fd 開不回來時留在 backlog、每 100 ms 再試），直到 fd 空出來");
        }
    }

    /// 第 `i` 條連線的 fd 有事件（可讀、可寫、掛斷）或有留著的框時叫。留著的框處理完才再讀，框照序處理，留著的最多是一次
    /// `receive` 讀進來的；停著時不讀也不處理。這條要斷回 `false`。
    fn on_readable(&mut self, i: usize) -> bool {
        let Some(conn) = self.conns.get_mut(i) else {
            return false;
        };
        conn.chan.flush();
        if conn.backlog.is_empty() && !conn.paused() {
            match conn.chan.receive() {
                Ok(frames) => conn.backlog.extend(frames),
                Err(err) => {
                    self.violate(i, err.0);
                    return false;
                }
            }
        }
        loop {
            let Some(conn) = self.conns.get_mut(i) else {
                return false;
            };
            if conn.paused() {
                return true;
            }
            let Some(frame) = conn.backlog.pop_front() else {
                return true;
            };
            if !self.on_frame(i, &frame) {
                return false;
            }
        }
    }

    /// 處理第 `i` 條連線的一框。這條要斷回 `false`。
    fn on_frame(&mut self, i: usize, frame: &[u8]) -> bool {
        let message = match decode_client_message(frame) {
            Ok(message) => message,
            Err(err) => {
                self.violate(i, err.0);
                return false;
            }
        };
        match message {
            ClientMessage::Hello { version, token } => self.on_hello(i, version, token.as_bytes()),
            ClientMessage::Call {
                side,
                id,
                service,
                method,
                payload,
            } => self.on_call(i, side, id, service, &method, payload),
            ClientMessage::Cancel { side, id } => self.on_cancel(i, side, id),
        }
    }

    fn on_hello(&mut self, i: usize, version: u32, token: &[u8]) -> bool {
        // 驗之前先讀乾淨控制通道：見檔頭。
        self.sync();
        let Some(conn) = self.conns.get(i) else {
            return false;
        };
        if conn.hello {
            self.violate(i, "重複的 hello");
            return false;
        }
        let Some(grant) = conn
            .pid
            .filter(|_| !conn.revoked)
            .and_then(|pid| self.grants.get(&pid))
        else {
            self.unregistered(i, "沒有登記");
            return false;
        };
        if version != HOST_PROTOCOL_VERSION {
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
        let generation = grant.generation;
        if let Some(conn) = self.conns.get_mut(i) {
            conn.hello = true;
            conn.generation = generation;
            conn.chan.send(&encode_host_message(&HostMessage::Hello {
                version: HOST_PROTOCOL_VERSION,
            }));
        }
        true
    }

    /// 回 `rejected`，回傳要報給監督行程的 pid（讀不到是 0）；這條由呼叫方斷。
    fn refuse(&mut self, i: usize, reason: &str) -> u32 {
        let Some(conn) = self.conns.get_mut(i) else {
            return 0;
        };
        conn.chan.send(&encode_host_message(&HostMessage::Rejected {
            reason: reason.to_string(),
        }));
        let pid = conn.pid.unwrap_or(0);
        say!("拒絕 pid {pid} 的連線 #{}：{reason}", conn.id);
        pid
    }

    /// 回 `rejected`、報 `unregistered`，不撤任何身分；這條由呼叫方斷。
    fn unregistered(&mut self, i: usize, reason: &str) {
        let pid = self.refuse(i, reason);
        let conn = self.conns.get(i).map_or(0, |conn| conn.id);
        self.report(&HostReport::Unregistered {
            pid,
            conn,
            reason: reason.as_bytes().to_vec(),
        });
    }

    /// 違反協定：回 `rejected`、回報監督行程，撤掉那個 pid 在表上的身分、斷掉它其他驗過身分的連線；這條由呼叫方斷。
    /// 撤過的連線只回 `rejected`、報 `unregistered`，不撤表上同一個號碼的那一筆：那一筆若在，是撤銷之後才登記的，不是它的。
    /// 判斷之前先讀乾淨控制通道，已經寫進 pipe 的撤銷先生效。
    fn violate(&mut self, i: usize, reason: &str) {
        self.sync();
        if self.conns.get(i).is_some_and(|conn| conn.revoked) {
            self.unregistered(i, reason);
            return;
        }
        let generation = match self.conns.get(i) {
            Some(conn) if conn.hello => conn.generation,
            Some(conn) => conn
                .pid
                .and_then(|pid| self.grants.get(&pid))
                .map_or(0, |grant| grant.generation),
            None => 0,
        };
        let pid = self.refuse(i, reason);
        self.report(&HostReport::Violation {
            pid,
            generation,
            reason: reason.as_bytes().to_vec(),
        });
        let Some(pid) = self.conns.get(i).and_then(|conn| conn.pid) else {
            return;
        };
        if self.grants.contains_key(&pid) {
            say!("pid {pid} 隔離到它結束");
        }
        self.revoke(pid);
    }
}
