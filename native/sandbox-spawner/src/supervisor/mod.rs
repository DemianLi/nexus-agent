//! 監督行程（[#1947](https://github.com/DemianLi/nexus-agent/issues/1947)，[#2340](https://github.com/DemianLi/nexus-agent/issues/2340)，
//! 設計 `.docs/supervisor-1947-design-2026-11-03.md` §三-2、§五、§六）：起一個前台、按前台的要求每條 thread 起一個對話行程，
//! 管它們的生死，寫稽核紀錄。資料不經這裡：前台直接連對話行程的 socket。訊息格式在 [`crate::supervisor_protocol`]。
//!
//! **嚴格單執行緒**：子行程的 `PR_SET_PDEATHSIG` 看的是起它的那條執行緒，那條執行緒結束子行程就會被殺。不要在這裡起 thread。
//!
//! 啟動：擋下 SIGINT／SIGTERM／SIGHUP／SIGCHLD 改由 signalfd 收；設 `PR_SET_CHILD_SUBREAPER`（子行程的後代成了孤兒也掛回這裡收）；
//! 準備 `--run-dir`（0700）；開稽核紀錄。前四步任一失敗就結束、回 1。最後起前台；前台起不來就寫稽核，隔 `--front-restart-ms` 再起。
//!
//! 前台的控制通道是它的 stdin／stdout：
//!
//! - `ensure(thread)`：停機中一律回 `down(thread, shutdown)`。這條 thread 已經有對話行程就再回一次 `up`；正在起就等它；正在收就不理（收完會回 `down`，前台要再要一次）；
//!   都沒有就起一個。
//!   對話行程送 `ready` 之後送它 `bind(thread)`，回同一個 id 的 `bound` 之後回前台 `up(thread, socket)`。`open` 不影響行為（唯讀開啟的逐出優先序，TODO(#2340)）。
//! - `release(thread)`：不理，不收行程（TODO(#2340)）。
//! - 前台結束（不是停機）：寫稽核，隔 `--front-restart-ms` 重起；重起之後對每條已經 `up` 的對話行程再送一次 `up`。
//!   前台不在的期間要給它的訊息丟掉。
//!
//! 對話行程的死因（判法在 [`memory::classify`]）：監督行程自己決定收的照那個理由，停機是 `shutdown`，RSS 超過 `--rss-limit-mb` 是
//! `memory`，控制通道上送了解不開的框或綁錯 thread 是 `crash`。其餘的照結束方式判：以 SIGABRT 結束、stderr 結尾附近有 heap 用完的
//! 那一行（判法見 [`process::StderrTap`]）是 `heap`；被 SIGKILL 而 cgroup 的 `oom_kill` 多了是 `host-oom`；其他（非零、被別的訊號殺、沒人叫它停卻自己結束、沒起成）
//! 都是 `crash`。每一個都寫一行稽核、回前台 `down(thread, cause)`。
//!
//! 對話行程的 stderr 接到監督行程（[`process::StderrTap`]）：每次可讀時最多讀 `READ_BUDGET`，原樣寫到自己的 fd 2，順便找 heap
//! 訊息；收屍時再讀最多 `STDERR_DRAIN` 才判死因，之後就關掉。fd 2 阻塞而沒人讀時，整個迴圈停在寫那一步；寫不出去的（轉出的與
//! 監督行程自己的訊息）丟掉、記數，下次寫得出去時先講一句。前台的 stderr 照監督行程的。
//!
//! 有對話行程時，每 `--rss-poll-ms` 讀一次各 leader 的 `VmRSS`，最高值寫進稽核的 `rss_kb`。
//!
//! 拆除梯度：關 stdin（EOF）→ 等 `--eof-grace-ms` → 對群組送 SIGTERM → 等 `--term-grace-ms` → 對群組送 SIGKILL。
//! leader 結束時（收屍之前）再對它的群組送一次 SIGKILL，群組裡剩下的一起帶走。
//!
//! 停機：收到 SIGINT／SIGTERM／SIGHUP，所有對話行程走拆除梯度；全部收完之後前台也走一次；前台收完就回 0。
//! 停機中再收到一次這些訊號，所有對話行程的群組當場 SIGKILL；前台照樣先收到它們的 `down`（排著的框寫完才關它的 stdin），再走拆除梯度。

/// 監督行程自己的一行訊息，走跟轉送對話行程 stderr 同一條路（[`process::write_stderr`]）：寫不出去就丟掉、記數，不 panic。
macro_rules! say {
    ($($arg:tt)*) => {
        $crate::supervisor::process::write_stderr(format!("{} {}\n", $crate::supervisor::LOG, format_args!($($arg)*)).as_bytes())
    };
}

mod args;
mod audit;
mod memory;
mod process;

use crate::supervisor_protocol::{
    decode_conversation_report, decode_front_request, encode_conversation_command, encode_front_event, ConversationCommand,
    ConversationReport, DeathCause, FrontEvent, FrontRequest, TurnPhase,
};
use audit::{Audit, Exit, Record};
use memory::OomCounter;
use process::{Chan, StderrTap};
use std::ffi::OsString;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const LOG: &str = "[nexus-supervisor]";

/// 對話行程 socket 的檔名最長的樣子（序號是 u64）。`--run-dir` 加上它要放得進 `sun_path`。
const LONGEST_SOCKET_NAME: &str = "/c18446744073709551615.sock";
/// `sockaddr_un.sun_path` 的長度，含結尾的 NUL。
const SUN_PATH: usize = 108;
/// 收屍時 stderr 最多再讀多少：還握著寫端的後代一直寫，也不會卡住收屍。1 MiB 是 Linux `pipe-max-size` 的預設值，
/// 管線沒被調得比它大時，leader 死前留在管線裡的一定讀得完。
const STDERR_DRAIN: usize = 1 << 20;

/// 拆除梯度走到哪一步。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Step {
    /// 已關 stdin，期限到了送 SIGTERM。
    Eof,
    /// 已送 SIGTERM，期限到了送 SIGKILL。
    Term,
    /// 已送 SIGKILL，等它結束。
    Kill,
}

struct Proc {
    pid: libc::pid_t,
    chan: Chan,
    /// 拆除梯度：哪一步、下一步的期限。
    stop: Option<(Step, Option<Instant>)>,
}

impl Proc {
    fn begin_stop(&mut self, now: Instant, eof_grace: Duration) {
        if self.stop.is_none() {
            self.chan.finish();
            self.stop = Some((Step::Eof, Some(now + eof_grace)));
        }
    }

    fn kill_now(&mut self) {
        process::signal_group(self.pid, libc::SIGKILL);
        self.chan.close_write();
        self.stop = Some((Step::Kill, None));
    }

    fn advance_stop(&mut self, now: Instant, term_grace: Duration) {
        match self.stop {
            Some((Step::Eof, Some(at))) if at <= now => {
                process::signal_group(self.pid, libc::SIGTERM);
                self.stop = Some((Step::Term, Some(now + term_grace)));
            }
            Some((Step::Term, Some(at))) if at <= now => self.kill_now(),
            _ => {}
        }
    }

    fn deadline(&self) -> Option<Instant> {
        self.stop.and_then(|(_, at)| at)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    /// 起了，還沒送 `ready`。
    Starting,
    /// 送了 `bind`，還沒回 `bound`。
    Binding,
    /// 收到同一個 thread 的 `bound`；沒在收的才會給前台 `up`。
    Up,
}

struct Conversation {
    proc: Proc,
    thread: Vec<u8>,
    socket: PathBuf,
    phase: Phase,
    /// 收到幾次 `turn(begin)`，寫進稽核。
    turns: u32,
    /// 監督行程決定收它的理由；沒有就是它自己結束的。
    cause: Option<DeathCause>,
    stderr: Option<StderrTap>,
    /// 輪詢看到的最高 RSS（kB），寫進稽核。
    rss_kb: u64,
}

struct Supervisor {
    args: args::Args,
    audit: Audit,
    sigfd: libc::c_int,
    front: Option<Proc>,
    front_restart_at: Option<Instant>,
    conversations: Vec<Conversation>,
    next_socket: u64,
    shutting_down: bool,
    oom: OomCounter,
    rss_poll_at: Instant,
}

/// 執行檔的入口。回 0：停機完成；1：起不來（signalfd、`PR_SET_CHILD_SUBREAPER`、`--run-dir`、`--audit`），
/// 或執行中 poll 失敗（先殺掉所有群組）；2：參數錯。
pub fn run(argv: Vec<OsString>) -> i32 {
    let args = match args::parse(&argv) {
        Ok(args) => args,
        Err(err) => {
            say!("{err}\n用法：{}", args::USAGE);
            return 2;
        }
    };
    match start(args) {
        Ok(mut supervisor) => supervisor.run(),
        Err(err) => {
            say!("起不來：{err}");
            1
        }
    }
}

fn start(args: args::Args) -> Result<Supervisor, String> {
    let sigfd = signal_fd()?;
    // SAFETY：只設這個行程的屬性。
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1) } != 0 {
        return Err(format!("PR_SET_CHILD_SUBREAPER：{}", std::io::Error::last_os_error()));
    }
    prepare_run_dir(&args.run_dir)?;
    let audit = Audit::open(&args.audit).map_err(|err| format!("稽核紀錄 {}：{err}", args.audit.display()))?;
    let mut supervisor = Supervisor {
        args,
        audit,
        sigfd,
        front: None,
        front_restart_at: None,
        conversations: Vec::new(),
        next_socket: 0,
        shutting_down: false,
        oom: OomCounter::open(),
        rss_poll_at: Instant::now(),
    };
    supervisor.start_front();
    Ok(supervisor)
}

/// 擋下要改由 signalfd 收的訊號，回 signalfd。SIGPIPE 忽略：對方不收了由寫的那一側處理。
fn signal_fd() -> Result<libc::c_int, String> {
    // SAFETY：只動這個行程的訊號遮罩與處置。
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGCHLD] {
            libc::sigaddset(&mut set, signal);
        }
        if libc::sigprocmask(libc::SIG_BLOCK, &set, std::ptr::null_mut()) != 0 {
            return Err(format!("sigprocmask：{}", std::io::Error::last_os_error()));
        }
        let fd = libc::signalfd(-1, &set, libc::SFD_CLOEXEC | libc::SFD_NONBLOCK);
        if fd < 0 {
            return Err(format!("signalfd：{}", std::io::Error::last_os_error()));
        }
        Ok(fd)
    }
}

/// `--run-dir` 不在就建（0700）；在就要是目錄（不是連結）、擁有者是自己、權限恰好 0700。主機多人共用時，邊界是這個目錄的權限。
fn prepare_run_dir(dir: &Path) -> Result<(), String> {
    if dir.as_os_str().len() + LONGEST_SOCKET_NAME.len() >= SUN_PATH {
        return Err(format!("--run-dir 太長，socket 路徑放不進 {SUN_PATH} bytes：{}", dir.display()));
    }
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(err) => return Err(format!("建不了 --run-dir {}：{err}", dir.display())),
    }
    let meta = std::fs::symlink_metadata(dir).map_err(|err| format!("--run-dir {}：{err}", dir.display()))?;
    // SAFETY：無副作用。
    let uid = unsafe { libc::geteuid() };
    if !meta.file_type().is_dir() || meta.uid() != uid || meta.mode() & 0o777 != 0o700 {
        return Err(format!(
            "--run-dir {} 要是自己擁有、權限 0700 的目錄（現在：{}，擁有者 {}，權限 {:o}）",
            dir.display(),
            if meta.file_type().is_dir() { "目錄" } else { "不是目錄" },
            meta.uid(),
            meta.mode() & 0o777
        ));
    }
    Ok(())
}

/// poll 的一格是誰的、讀還是寫。
#[derive(Clone, Copy)]
enum Slot {
    Signal,
    Front { write: bool },
    Conversation { pid: libc::pid_t, write: bool },
    ConversationStderr { pid: libc::pid_t },
}

impl Supervisor {
    fn run(&mut self) -> i32 {
        loop {
            let now = Instant::now();
            self.on_timers(now);
            if self.shutting_down && self.conversations.is_empty() {
                match self.front.as_mut() {
                    None => return 0,
                    Some(front) => front.begin_stop(now, self.args.eof_grace),
                }
            }

            let mut fds = vec![libc::pollfd { fd: self.sigfd, events: libc::POLLIN, revents: 0 }];
            let mut slots = vec![Slot::Signal];
            let mut watch = |chan: &Chan, read_slot: Slot, write_slot: Slot| {
                let (read, write) = chan.poll_fds();
                if let Some(fd) = read {
                    fds.push(libc::pollfd { fd, events: libc::POLLIN, revents: 0 });
                    slots.push(read_slot);
                }
                if let Some(fd) = write {
                    fds.push(libc::pollfd { fd, events: libc::POLLOUT, revents: 0 });
                    slots.push(write_slot);
                }
            };
            if let Some(front) = &self.front {
                watch(&front.chan, Slot::Front { write: false }, Slot::Front { write: true });
            }
            for conversation in &self.conversations {
                watch(
                    &conversation.proc.chan,
                    Slot::Conversation { pid: conversation.proc.pid, write: false },
                    Slot::Conversation { pid: conversation.proc.pid, write: true },
                );
            }
            for conversation in &self.conversations {
                if let Some(fd) = conversation.stderr.as_ref().and_then(StderrTap::poll_fd) {
                    fds.push(libc::pollfd { fd, events: libc::POLLIN, revents: 0 });
                    slots.push(Slot::ConversationStderr { pid: conversation.proc.pid });
                }
            }

            let timeout = self.next_deadline().map_or(-1, |at| {
                let left = at.saturating_duration_since(Instant::now());
                // 進位到毫秒，免得差不到 1 ms 時 poll 立刻回來、空轉到期限。
                let millis = left.as_millis() + u128::from(left.subsec_nanos() % 1_000_000 != 0);
                millis.min(i32::MAX as u128) as i32
            });
            // SAFETY：fds 在這次呼叫期間有效。
            let n = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
            if n < 0 {
                if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                    continue;
                }
                say!("poll 失敗：{}；殺掉所有群組後結束", std::io::Error::last_os_error());
                self.kill_everything();
                return 1;
            }

            let mut signals = false;
            for (pollfd, slot) in fds.iter().zip(slots) {
                if pollfd.revents == 0 {
                    continue;
                }
                match slot {
                    Slot::Signal => signals = true,
                    Slot::Front { write: true } => {
                        if let Some(front) = self.front.as_mut() {
                            front.chan.flush();
                        }
                    }
                    Slot::Front { write: false } => self.on_front_readable(),
                    Slot::ConversationStderr { pid } => {
                        let conversation = self.conversations.iter_mut().find(|c| c.proc.pid == pid);
                        if let Some(tap) = conversation.and_then(|c| c.stderr.as_mut()) {
                            tap.pump(process::READ_BUDGET);
                        }
                    }
                    Slot::Conversation { pid, write } => {
                        let Some(index) = self.conversations.iter().position(|c| c.proc.pid == pid) else { continue };
                        if write {
                            self.conversations[index].proc.chan.flush();
                        } else {
                            self.on_conversation_readable(index);
                        }
                    }
                }
            }
            if signals {
                self.on_signals();
            }
        }
    }

    fn on_timers(&mut self, now: Instant) {
        let term_grace = self.args.term_grace;
        for conversation in &mut self.conversations {
            conversation.proc.advance_stop(now, term_grace);
        }
        if let Some(front) = self.front.as_mut() {
            front.advance_stop(now, term_grace);
        }
        if self.rss_poll_at <= now {
            self.rss_poll_at = now + self.args.rss_poll;
            self.poll_rss();
        }
        if self.front_restart_at.is_some_and(|at| at <= now) && !self.shutting_down {
            self.front_restart_at = None;
            self.start_front();
        }
    }

    fn next_deadline(&self) -> Option<Instant> {
        let restart = self.front_restart_at.filter(|_| !self.shutting_down);
        self.conversations
            .iter()
            .filter_map(|c| c.proc.deadline())
            .chain(self.front.as_ref().and_then(Proc::deadline))
            .chain(restart)
            .chain(Some(self.rss_poll_at).filter(|_| !self.conversations.is_empty()))
            .min()
    }

    /// 讀每個對話行程 leader 的 RSS，記最高值；超過 `--rss-limit-mb` 而還沒送過 SIGKILL 的，當場殺掉整個群組。死因記 `memory`，
    /// 已經在收的（例如停機）照原本的理由。
    ///
    /// 只量 leader：只讀它自己的 `VmRSS`，不含子孫行程；spawner 與工具又各自 `setsid`，群組 SIGKILL 也打不到（TODO(#2494)）。
    fn poll_rss(&mut self) {
        for conversation in &mut self.conversations {
            let Some(kb) = memory::vm_rss_kb(conversation.proc.pid) else { continue };
            conversation.rss_kb = conversation.rss_kb.max(kb);
            let over = self.args.rss_limit_kb.is_some_and(|limit| kb > limit);
            if over && !matches!(conversation.proc.stop, Some((Step::Kill, _))) {
                say!("對話行程 {} 的 RSS {kb} kB 超過上限，殺掉", conversation.proc.pid);
                conversation.cause.get_or_insert(DeathCause::Memory);
                conversation.proc.kill_now();
            }
        }
    }

    fn start_front(&mut self) {
        match process::spawn(&self.args.front, &self.args.front_args, false) {
            Ok((pid, chan, _)) => {
                let mut front = Proc { pid, chan, stop: None };
                for conversation in self.conversations.iter().filter(|c| c.phase == Phase::Up && c.proc.stop.is_none()) {
                    front.chan.send(&encode_front_event(&FrontEvent::Up {
                        thread_id: conversation.thread.clone(),
                        socket: conversation.socket.as_os_str().as_bytes().to_vec(),
                    }));
                }
                self.front = Some(front);
            }
            Err(err) => {
                say!("前台起不來：{err}");
                let error = err.to_string();
                self.audit.record(&Record::Front { pid: 0, exit: Exit::NOT_STARTED, error: Some(&error) });
                self.front_restart_at = Some(Instant::now() + self.args.front_restart);
            }
        }
    }

    fn tell_front(&mut self, event: &FrontEvent) {
        if let Some(front) = self.front.as_mut().filter(|front| front.stop.is_none()) {
            front.chan.send(&encode_front_event(event));
        }
    }

    fn on_front_readable(&mut self) {
        let Some(front) = self.front.as_mut() else { return };
        let frames = front.chan.receive();
        let frames = match frames {
            Ok(frames) => frames,
            Err(err) => {
                say!("前台送來解不開的框（{}），殺掉前台", err.0);
                front.kill_now();
                return;
            }
        };
        for payload in frames {
            match decode_front_request(&payload) {
                Ok(FrontRequest::Ensure { thread_id, .. }) => self.ensure(thread_id),
                Ok(FrontRequest::Release { .. }) => {}
                Err(err) => {
                    say!("前台送來解不開的訊息（{}），殺掉前台", err.0);
                    if let Some(front) = self.front.as_mut() {
                        front.kill_now();
                    }
                    return;
                }
            }
        }
    }

    fn ensure(&mut self, thread: Vec<u8>) {
        if self.shutting_down {
            self.tell_front(&FrontEvent::Down { thread_id: thread, cause: DeathCause::Shutdown });
            return;
        }
        if let Some(conversation) = self.conversations.iter_mut().find(|c| c.thread == thread) {
            if conversation.phase == Phase::Up && conversation.proc.stop.is_none() {
                let socket = conversation.socket.as_os_str().as_bytes().to_vec();
                self.tell_front(&FrontEvent::Up { thread_id: thread, socket });
            }
            return;
        }
        self.start_conversation(thread);
    }

    fn start_conversation(&mut self, thread: Vec<u8>) {
        self.next_socket += 1;
        let socket = self.args.run_dir.join(format!("c{}.sock", self.next_socket));
        let _ = std::fs::remove_file(&socket);
        let mut args = self.args.conversation_args.clone();
        args.push("--socket".into());
        args.push(socket.clone().into_os_string());
        match process::spawn(&self.args.conversation, &args, true) {
            Ok((pid, chan, stderr)) => self.conversations.push(Conversation {
                proc: Proc { pid, chan, stop: None },
                thread,
                socket,
                phase: Phase::Starting,
                turns: 0,
                cause: None,
                stderr,
                rss_kb: 0,
            }),
            Err(err) => {
                say!("對話行程起不來：{err}");
                let error = err.to_string();
                self.audit.record(&Record::Conversation {
                    thread: &thread,
                    pid: 0,
                    cause: DeathCause::Crash,
                    exit: Exit::NOT_STARTED,
                    turns: 0,
                    rss_kb: 0,
                    error: Some(&error),
                });
                self.tell_front(&FrontEvent::Down { thread_id: thread, cause: DeathCause::Crash });
            }
        }
    }

    fn on_conversation_readable(&mut self, index: usize) {
        let conversation = &mut self.conversations[index];
        let frames = match conversation.proc.chan.receive() {
            Ok(frames) => frames,
            Err(err) => {
                say!("對話行程 {} 送來解不開的框（{}），殺掉", conversation.proc.pid, err.0);
                conversation.cause.get_or_insert(DeathCause::Crash);
                conversation.proc.kill_now();
                return;
            }
        };
        for payload in frames {
            let conversation = &mut self.conversations[index];
            let report = match decode_conversation_report(&payload) {
                Ok(report) => report,
                Err(err) => {
                    say!("對話行程 {} 送來解不開的訊息（{}），殺掉", conversation.proc.pid, err.0);
                    conversation.cause.get_or_insert(DeathCause::Crash);
                    conversation.proc.kill_now();
                    return;
                }
            };
            match report {
                ConversationReport::Ready if conversation.phase == Phase::Starting => {
                    conversation.phase = Phase::Binding;
                    let bind = ConversationCommand::Bind { thread_id: conversation.thread.clone() };
                    conversation.proc.chan.send(&encode_conversation_command(&bind));
                }
                ConversationReport::Bound { thread_id } if conversation.phase == Phase::Binding => {
                    if thread_id != conversation.thread {
                        say!("對話行程 {} 綁錯 thread，殺掉", conversation.proc.pid);
                        conversation.cause.get_or_insert(DeathCause::Crash);
                        conversation.proc.kill_now();
                        return;
                    }
                    conversation.phase = Phase::Up;
                    if conversation.proc.stop.is_none() {
                        let socket = conversation.socket.as_os_str().as_bytes().to_vec();
                        self.tell_front(&FrontEvent::Up { thread_id, socket });
                    }
                }
                ConversationReport::Turn { phase: TurnPhase::Begin } => {
                    conversation.turns = conversation.turns.saturating_add(1);
                }
                _ => {}
            }
        }
    }

    fn on_signals(&mut self) {
        let mut stop = false;
        let mut child = false;
        loop {
            // SAFETY：讀進一個 signalfd_siginfo 大小的緩衝。
            let mut info: libc::signalfd_siginfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::signalfd_siginfo>();
            let n = unsafe { libc::read(self.sigfd, (&mut info as *mut libc::signalfd_siginfo).cast(), size) };
            if n != size as isize {
                break;
            }
            if info.ssi_signo == libc::SIGCHLD as u32 {
                child = true;
            } else {
                stop = true;
            }
        }
        if child {
            self.reap();
        }
        if stop {
            if self.shutting_down {
                say!("停機中又收到停止訊號，所有對話行程當場 SIGKILL");
                for conversation in &mut self.conversations {
                    conversation.proc.kill_now();
                }
            } else {
                self.shutting_down = true;
                let now = Instant::now();
                for conversation in &mut self.conversations {
                    conversation.cause.get_or_insert(DeathCause::Shutdown);
                    conversation.proc.begin_stop(now, self.args.eof_grace);
                }
            }
        }
    }

    fn kill_everything(&mut self) {
        for conversation in &mut self.conversations {
            conversation.cause.get_or_insert(DeathCause::Shutdown);
            conversation.proc.kill_now();
        }
        if let Some(front) = self.front.as_mut() {
            front.kill_now();
        }
    }

    fn reap(&mut self) {
        let leaders: Vec<libc::pid_t> =
            self.conversations.iter().map(|c| c.proc.pid).chain(self.front.as_ref().map(|f| f.pid)).collect();
        let mut exited = Vec::new();
        process::reap(
            |pid| {
                if leaders.contains(&pid) {
                    process::signal_group(pid, libc::SIGKILL);
                }
            },
            |pid, status| exited.push((pid, Exit::from_status(status))),
        );
        for (pid, exit) in exited {
            self.on_exit(pid, exit);
        }
    }

    fn on_exit(&mut self, pid: libc::pid_t, exit: Exit) {
        if self.front.as_ref().is_some_and(|front| front.pid == pid) {
            self.front = None;
            self.audit.record(&Record::Front { pid, exit, error: None });
            if !self.shutting_down {
                say!("前台結束了（{exit:?}），{} ms 後重起", self.args.front_restart.as_millis());
                self.front_restart_at = Some(Instant::now() + self.args.front_restart);
            }
            return;
        }
        let Some(index) = self.conversations.iter().position(|c| c.proc.pid == pid) else { return };
        let mut conversation = self.conversations.remove(index);
        // 結束前寫出、還沒讀的框：只數輪次（寫進稽核），其餘的對一個已經收掉的行程沒有意義。
        for payload in conversation.proc.chan.receive().unwrap_or_default() {
            if let Ok(ConversationReport::Turn { phase: TurnPhase::Begin }) = decode_conversation_report(&payload) {
                conversation.turns = conversation.turns.saturating_add(1);
            }
        }
        let heap_message = conversation.stderr.as_mut().is_some_and(|tap| {
            tap.pump(STDERR_DRAIN);
            tap.heap_message_near_end()
        });
        let oom = &mut self.oom;
        let cause = memory::classify(conversation.cause, exit.signal, heap_message, || oom.claim());
        self.audit.record(&Record::Conversation {
            thread: &conversation.thread,
            pid,
            cause,
            exit,
            turns: conversation.turns,
            rss_kb: conversation.rss_kb,
            error: None,
        });
        let _ = std::fs::remove_file(&conversation.socket);
        self.tell_front(&FrontEvent::Down { thread_id: conversation.thread, cause });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn temp(tag: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("nsup-unit-{tag}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn run_dir_is_created_0700() {
        let dir = temp("create").join("run");
        prepare_run_dir(&dir).unwrap();
        assert_eq!(std::fs::metadata(&dir).unwrap().mode() & 0o777, 0o700);
        prepare_run_dir(&dir).unwrap();
    }

    #[test]
    fn run_dir_must_be_0700_dir_not_link() {
        let base = temp("reject");
        let open = base.join("open");
        std::fs::create_dir(&open).unwrap();
        std::fs::set_permissions(&open, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(prepare_run_dir(&open).unwrap_err().contains("755"));
        let file = base.join("file");
        std::fs::write(&file, b"").unwrap();
        assert!(prepare_run_dir(&file).is_err());
        let target = base.join("target");
        prepare_run_dir(&target).unwrap();
        let link = base.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(prepare_run_dir(&link).unwrap_err().contains("不是目錄"));
    }

    #[test]
    fn run_dir_too_long_for_sun_path() {
        let long = PathBuf::from(format!("/{}", "d".repeat(SUN_PATH - LONGEST_SOCKET_NAME.len())));
        assert!(prepare_run_dir(&long).unwrap_err().contains("太長"));
    }
}
