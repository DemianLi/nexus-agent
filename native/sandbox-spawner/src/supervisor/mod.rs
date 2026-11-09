//! 監督行程（[#1947](https://github.com/DemianLi/nexus-agent/issues/1947)，[#2340](https://github.com/DemianLi/nexus-agent/issues/2340)，
//! 設計 `.docs/supervisor-1947-design-2026-11-03.md` §三-2、§五、§六）：起一個前台、按前台的要求每條 thread 起一個對話行程，
//! 管它們的生死，寫稽核紀錄。資料不經這裡：前台直接連對話行程的 socket。訊息格式在 [`crate::supervisor_protocol`]。
//!
//! **嚴格單執行緒**：子行程的 `PR_SET_PDEATHSIG` 看的是起它的那條執行緒，那條執行緒結束子行程就會被殺。不要在這裡起 thread。
//!
//! 啟動：擋下 SIGINT／SIGTERM／SIGHUP／SIGCHLD 改由 signalfd 收；設 `PR_SET_CHILD_SUBREAPER`（子行程的後代成了孤兒也掛回這裡收）；
//! 準備 `--run-dir`（0700）；開稽核紀錄。前四步任一失敗就結束、回 1。接著先補預熱池再起前台，前台送出的第一則 `stats` 才數得到池裡的；
//! 前台起不來就寫稽核，隔 `--front-restart-ms` 再起。
//!
//! 前台的控制通道是它的 stdin／stdout：
//!
//! - `ensure(thread, open)`：停機中一律回 `down(thread, shutdown)`。這條 thread 已經有對話行程就再回一次 `up`；正在起就等它；
//!   逐出、正在收的就排隊（已經在排的只升 `open`），跟其他排著的一起重算名額：有名額就等它收完，先回 `down(evicted)` 再照排隊順序起；
//!   沒名額當場回 `capacity`，收完照樣送 `down(evicted)`。死因不是 `evicted`、正在收、又沒在等 `drain` 回答的不理，收完回的 `down` 就是回答；送了 `drain` 還沒回答就等：回 `busy` 或逾時就回 `up`；回 `drained` 就收掉，
//!   前台先收到 `down(evicted)`，這條跟其他排著的一起重算名額，收完照排隊順序起，沒名額回 `capacity`。等回答期間它跟自己的行程互抵，
//!   不回 `capacity`，別的行程讓出的名額也不拿去替它起第二個。
//!   都沒有就從預熱池拿一個（先拿已經 `ready` 的）；池裡沒有、名額也還有就起一個；名額滿了就排隊，見下面的容量。已經在排的再要，只把 `open` 升成 `run`。
//!   對話行程送 `ready` 之後，已經指派了 thread 的送它 `bind(thread)`，沒指派的留在預熱池；回同一個 id 的 `bound` 之後回前台 `up(thread, socket)`。
//!   `open` 是 `read-only` 的標成只讀開啟；同一條 thread 之後收到 `ensure(run)` 或 `turn(begin)` 就轉成一般的。
//! - `release(thread)`：只收只讀開啟的，已經轉成一般的不理。已經閒置就送 `drain`；還沒閒置（含正在等 `drain` 回答的）就記著，一回報閒置就送，之間再被 `ensure` 或轉成一般的就作廢。
//! - 前台結束（不是停機）：寫稽核，隔 `--front-restart-ms` 重起；重起之後對每條已經 `up` 的對話行程再送一次 `up`。
//!   前台不在的期間要給它的訊息丟掉。
//!
//! 容量（設計 §七）：同時活著的對話行程（含預熱池、起動中與正在收的）最多 `--capacity` 個，沒給就照記憶體上限算
//! （[`memory::auto_capacity`]）。名額滿時，排著的每一條都要有一個正在收、或在等 `drain` 回答的行程讓出名額：不夠就挑一個閒置的送 `drain`，
//! 只讀的先，同類裡閒置最久的先（閒置從回報閒置與最後一次被 `ensure` 要到兩者較晚的算）。挑不到的，從最晚排進來的起回 `capacity`。
//! 有行程收完就起排著的，排的都起完才補預熱池。`drain` 回 `drained` 才收（死因 `evicted`，走拆除梯度；逾時之後才到的也照收）；回 `busy` 或
//! `--drain-timeout-ms` 內沒回答都不收，當它不閒置，等它下次回報閒置。閒置超過 `--idle-ms`（只讀的 `--read-only-idle-ms`）也送 `drain`。
//! 預熱池補到 `--warm` 個；池裡的沒綁就死了（或起不來），隔 `--front-restart-ms` 才再補。停機時排著的都回 `down(shutdown)`，那條 thread 還有行程的等它結束時回一次。
//! 每 `--stats-ms` 給前台一次 `stats`，前台（重）起時也送一次。
//!
//! 對話行程的死因（判法在 [`memory::classify`]）：監督行程自己決定收的照那個理由，停機是 `shutdown`，回了 `drained` 是 `evicted`，RSS 超過 `--rss-limit-mb` 是
//! `memory`，心跳斷了超過 `--stall-ms`（壓住時只算放它跑的時間）是 `stalled`，控制通道上送了解不開的框或綁錯 thread 是 `crash`。其餘的照結束方式判：以 SIGABRT 結束、stderr 結尾附近有 heap 用完的
//! 那一行（判法見 [`process::StderrTap`]）是 `heap`；被 SIGKILL 而 cgroup 的 `oom_kill` 多了是 `host-oom`；其他（非零、被別的訊號殺、沒人叫它停卻自己結束、沒起成）
//! 都是 `crash`。每一個都寫一行稽核、回前台 `down(thread, cause)`；預熱池裡還沒指派的只寫稽核（`thread` 是空字串）。
//!
//! 對話行程的 stderr 接到監督行程（[`process::StderrTap`]）：每次可讀時最多讀 `READ_BUDGET`，原樣寫到自己的 fd 2，順便找 heap
//! 訊息；收屍時再讀最多 `STDERR_DRAIN` 才判死因，之後就關掉。fd 2 阻塞而沒人讀時，整個迴圈停在寫那一步；寫不出去的（轉出的與
//! 監督行程自己的訊息）丟掉、記數，下次寫得出去時先講一句。前台的 stderr 照監督行程的。
//!
//! 有對話行程時，每 `--rss-poll-ms` 讀一次各 leader 的 `VmRSS`，最高值寫進稽核的 `rss_kb`。送出 `bind` 起收到的每個框都算聽到，相鄰兩次（第一次與送出 `bind`）之間最長的間隔寫進稽核的
//! `max_silence_ms`，死前最後一段不算。監督行程比預定晚了超過 `--stall-ms` 的一半才醒時，判定自己被停住過，所有沉默從醒來起重新起算
//! （[`Supervisor::check_resumed`]）。
//!
//! 拆除梯度：關 stdin（EOF）→ 等 `--eof-grace-ms` → 對群組送 SIGTERM → 等 `--term-grace-ms` → 對群組送 SIGKILL。RSS 超過上限與
//! 心跳斷了超過 `--stall-ms` 的不走梯度，當場對群組送 SIGKILL。
//!
//! 沉默又一直要 CPU 的 leader 交替送 SIGSTOP／SIGCONT（[`cpu`]）；走拆除梯度或送 `drain` 之前先 SIGCONT。
//! leader 結束時（收屍之前）再對它的群組送一次 SIGKILL，群組裡剩下的一起帶走。
//!
//! 每條控制通道的第一框都是 `hello`（[`crate::supervisor_protocol`] 的檔頭）：子行程一起來監督行程就先送自己的（給對話行程與前台的帶身分 token），
//! 子行程送來的第一框也要是 `hello`、版本相等。對話行程不是：死因 `protocol`，當場 SIGKILL。前台或宿主不是：重起也是同一支執行檔、一樣對不上，
//! 所以不重起，整台停機、回 3。第一框解不開的照解不開的框處置（對話行程 `crash`，前台殺掉重起，宿主殺掉、算一次 `ready` 之前的失敗）。
//!
//! 宿主（`--host`，[#2569](https://github.com/DemianLi/nexus-agent/issues/2569)；沒給就不起）：跟前台一起起，不擋前台。它的 stdin／stdout 是控制通道，
//! stderr 照監督行程的。它送 `ready` 之後，監督行程把身分表整張送過去：每個前台與對話行程一筆（pid、token、角色、綁的 thread）。
//! 之後起的行程，spawn 當下先送宿主那一筆、再把 token 交給它；指派 thread 時更新那一筆；收屍之前撤掉（[`process::reap`] 的 `before_reap`，
//! 那時 pid 還沒被收，撤銷寫進 pipe 才收；500 ms 內寫不進去就殺掉宿主）。宿主回報某個 pid 違反協定時寫一行稽核
//! （`event: protocol`），那個身分隔離到它結束：之後宿主重起重送的表裡不再有它；宿主 `ready` 了、沒在收的，也再送一次 `revoke`，蓋掉可能還排在這邊、沒寫出去的那一筆 `grant`。回報的是 pid 不在宿主表上（`unregistered`）、
//! 而那個 pid 是活著、沒被隔離的前台或對話行程的，不算違規、不寫稽核：那一筆還沒寫進宿主的 pipe（宿主剛起來或剛重起、
//! 這邊還沒處理它的 `ready`，或那一筆還排在這邊），或那是撤銷之前就連上的連線（pid 被重用、同一個號碼上一個行程留下的，或重用得比宿主讀 pipe 快、新行程先連上的）；只記一行警告，帶 pid 與宿主的連線編號。其餘照違規記。宿主結束了就照退避重起：第一次等 `--host-backoff-ms`，
//! 之後每次加倍到 `--host-backoff-max-ms`，活過 `--host-stable-ms` 才結束的回到起始。`ready` 之前的失敗（沒起成、`ready` 之前結束、
//! `--host-ready-timeout-ms` 內沒 `ready`）連續 `--host-start-failures` 次，整台停機、回 4；`ready` 一次就歸零。`ready` 之後的失敗只退避重起，
//! 不會讓整台結束：在 `ready` 之前宿主還沒開始收連線，那之前的失敗一定是它自己（執行檔、設定、環境）的問題，之後的可能是客戶端觸發的。
//!
//! 停機：收到 SIGINT／SIGTERM／SIGHUP，順序是 ① 送前台 `stop-admission`，等它回答最多 `--admission-timeout-ms`（前台不在、或在等的時候結束了就不等）；
//! ② 所有對話行程走拆除梯度；③ 全部收完之後宿主走一次；④ 宿主收完之後前台走一次；前台收完就回 0（停機是 `hello` 對不上或宿主起不來造成的，回 3 或 4）。
//! 停機中再收到一次這些訊號，所有對話行程與宿主的群組當場 SIGKILL；前台照樣先收到它們的 `down`（排著的框寫完才關它的 stdin），再走拆除梯度。

/// 監督行程自己的一行訊息，走跟轉送對話行程 stderr 同一條路（[`process::write_stderr`]）：寫不出去就丟掉、記數，不 panic。
macro_rules! say {
    ($($arg:tt)*) => {
        $crate::supervisor::process::write_stderr(format!("{} {}\n", $crate::supervisor::LOG, format_args!($($arg)*)).as_bytes())
    };
}

mod args;
mod audit;
mod cpu;
mod memory;
pub(crate) mod process;

use crate::supervisor_protocol::{
    decode_conversation_report, decode_front_request, decode_host_report, encode_conversation_command, encode_front_event,
    encode_host_command, ConversationCommand, ConversationReport, DeathCause, FrontEvent, FrontRequest, HostCommand, HostReport,
    OpenMode, Role, TurnPhase, DEATH_CAUSES, PROTOCOL_VERSION,
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
    /// 收到它版本相等的 `hello` 了。
    hello: bool,
}

impl Proc {
    fn new(pid: libc::pid_t, chan: Chan) -> Proc {
        Proc { pid, chan, stop: None, hello: false }
    }

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
    /// 預熱池裡的：送了 `ready`，還沒指派 thread。
    Warm,
    /// 送了 `bind`，還沒回 `bound`。
    Binding,
    /// 收到同一個 thread 的 `bound`；沒在收的才會給前台 `up`。
    Up,
}

struct Conversation {
    proc: Proc,
    /// 預熱池裡還沒指派的是 `None`。
    thread: Option<Vec<u8>>,
    /// 只讀開啟（設計 §7-3）：閒置時間用 `--read-only-idle-ms`，名額滿時先逐出。收到 `turn(begin)` 或 `ensure(run)` 就轉成一般的。
    read_only: bool,
    /// 它回報閒置起算的時間點；不閒置（還沒回報過、回了 `busy`、`drain` 逾時）是 `None`。
    idle_since: Option<Instant>,
    /// 最後一次被 `ensure` 要到、被起、或從預熱池指派的時間；逐出的先後與閒置時限都從它與 `idle_since` 較晚的那個算。
    used_at: Instant,
    /// 送出 `drain`、還沒收到回答的時間點。
    drain: Option<Instant>,
    /// 只讀開啟時被前台 `release` 過、還沒閒置（含在等 `drain` 回答時，回了 `busy` 或逾時）：一回報閒置就送 `drain`；再被 `ensure` 或收到 `turn(begin)` 就清掉。
    released: bool,
    /// 最近一次輪詢到的 RSS（kB），給 `stats` 加總。
    rss_now_kb: u64,
    socket: PathBuf,
    phase: Phase,
    /// 收到幾次 `turn(begin)`，寫進稽核。
    turns: u32,
    /// 監督行程決定收它的理由；沒有就是它自己結束的。
    cause: Option<DeathCause>,
    stderr: Option<StderrTap>,
    /// 輪詢看到的最高 RSS（kB），寫進稽核。
    rss_kb: u64,
    /// 送出 `bind` 之後最後一次聽到它的時間；還沒送 `bind` 是 `None`，不判 `stalled`。
    heard_at: Option<Instant>,
    /// 送出 `bind` 之後，兩則回報之間最長隔了多久，寫進稽核。
    max_silence: Duration,
    /// 吃滿 CPU 時的壓制（[`cpu`]）。
    cpu: cpu::Guard,
    /// 連宿主用的身分（ASCII），隨 `hello` 交給它。
    token: Vec<u8>,
    /// 宿主回報它違反協定：不再放進身分表，到它結束為止。
    quarantined: bool,
    /// spawn 它時發的序號，見 [`HostCommand::Grant`]。
    generation: u32,
}

impl Conversation {
    /// 聽到它的一則回報。
    fn hear(&mut self, now: Instant) {
        if let Some(at) = self.heard_at {
            self.max_silence = self.max_silence.max(now.saturating_duration_since(at));
            self.heard_at = Some(now);
        }
        if self.cpu.holding() {
            say!("對話行程 {} 出聲了，不再壓它", self.proc.pid);
        }
        if self.cpu.heard() {
            cpu::signal(self.proc.pid, cpu::Signal::Cont);
        }
    }

    /// 走拆除梯度。壓制中的先放開：停住的行程讀不到 EOF，SIGTERM 也要等 SIGCONT 才送得到。
    fn begin_stop(&mut self, now: Instant, eof_grace: Duration) {
        self.release(now);
        self.proc.begin_stop(now, eof_grace);
    }

    fn release(&mut self, now: Instant) {
        if self.cpu.release(now) {
            cpu::signal(self.proc.pid, cpu::Signal::Cont);
        }
    }

    /// 可以判要不要壓：已經 `up`、沒在收、沒在等 `drain` 的回答。`bind` 到 `bound` 之間是冷開，不壓。
    fn throttleable(&self) -> bool {
        self.phase == Phase::Up && self.proc.stop.is_none() && self.drain.is_none() && self.heard_at.is_some()
    }

    /// 閒置、已經 `up`、沒在收也沒在等 `drain` 的回答：可以送 `drain`。
    fn evictable(&self) -> bool {
        self.idle_since.is_some() && self.phase == Phase::Up && self.proc.stop.is_none() && self.drain.is_none()
    }

    /// 閒置從什麼時候算：回報閒置的時間點與最後一次被要到的時間點較晚的那個。
    fn idle_from(&self) -> Option<Instant> {
        self.idle_since.map(|at| at.max(self.used_at))
    }

    /// 預熱池裡的（還沒指派 thread、沒在收）。
    fn warm(&self) -> bool {
        self.thread.is_none() && self.proc.stop.is_none()
    }

    /// 送出 `bind` 之後、還沒在收，而且已經 `stall` 沒聽到它（壓住時停住的時間不算，見 [`cpu::Guard::silence`]）。
    fn stalled(&self, now: Instant, stall: Duration) -> bool {
        self.proc.stop.is_none() && self.heard_at.is_some_and(|at| self.cpu.silence(now, at) >= stall)
    }
}

struct Host {
    proc: Proc,
    /// 送過 `ready` 了。
    ready: bool,
    started: Instant,
    /// 在 `--host-ready-timeout-ms` 內沒 `ready`，是監督行程殺的。
    timed_out: bool,
}

/// `hello` 對不上（前台或宿主）而停機時的結束碼。
const EXIT_PROTOCOL: i32 = 3;
/// 宿主在 `ready` 之前連續失敗到上限而停機時的結束碼。
const EXIT_HOST_FAILED: i32 = 4;
/// 撤銷寫進宿主控制通道最多等這麼久；收屍會等它，所以要短。
const REVOKE_WRITE_LIMIT: Duration = Duration::from_millis(500);

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
    /// 同時活著的對話行程最多幾個（含預熱池、起動中與正在收的）。
    capacity: u32,
    /// 名額滿而排著的 thread 與開啟方式，先排的在前；有行程收完就從前面起。
    pending: Vec<(Vec<u8>, OpenMode)>,
    /// 預熱池的行程沒綁就死了（或起不來）：這時間之前不補。
    warm_retry_at: Option<Instant>,
    /// 下次送 `stats` 的時間。
    stats_at: Option<Instant>,
    /// 各類死因的累計，依死因碼的順序。
    deaths: [u32; DEATH_CAUSES],
    /// 現在這個前台的身分 token。
    front_token: Vec<u8>,
    front_quarantined: bool,
    front_generation: u32,
    /// 最後發出的序號；還沒發過是 0。
    last_generation: u32,
    host: Option<Host>,
    host_restart_at: Option<Instant>,
    /// 下一次重起前要等多久。
    host_backoff: Duration,
    /// `ready` 之前連續失敗了幾次。
    host_failures: u32,
    /// 停機中、還在等前台回答 `stop-admission` 的期限。
    admission_until: Option<Instant>,
    /// 停機完成時回的碼。
    exit_code: i32,
}

/// 執行檔的入口。回 0：停機完成；1：起不來（signalfd、`PR_SET_CHILD_SUBREAPER`、`--run-dir`、`--audit`），
/// 或執行中 poll 失敗（先殺掉所有群組）；2：參數錯；3：前台或宿主的 `hello` 對不上，停機完成；4：宿主 `ready` 之前連續失敗到上限，停機完成。
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
    let capacity = match args.capacity {
        Some(capacity) => capacity,
        None => {
            let (capacity, limit) = memory::auto_capacity();
            match limit {
                Some(bytes) => say!("容量 {capacity} 個對話行程（記憶體上限 {} MiB）", bytes >> 20),
                None => say!("讀不到記憶體上限，容量用 {capacity}"),
            }
            capacity
        }
    };
    let stats_at = args.stats.map(|every| Instant::now() + every);
    let host_backoff = args.host.as_ref().map_or(Duration::ZERO, |host| host.backoff);
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
        capacity,
        pending: Vec::new(),
        warm_retry_at: None,
        stats_at,
        deaths: [0; DEATH_CAUSES],
        front_token: Vec::new(),
        front_quarantined: false,
        front_generation: 0,
        last_generation: 0,
        host_backoff,
        host: None,
        host_restart_at: None,
        host_failures: 0,
        admission_until: None,
        exit_code: 0,
    };
    supervisor.fill_warm();
    supervisor.start_host();
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

/// 連宿主用的身分 token：16 個隨機 byte 的十六進位（32 個 ASCII 字元）。
fn new_token() -> std::io::Result<Vec<u8>> {
    let mut raw = [0u8; 16];
    let mut filled = 0;
    while filled < raw.len() {
        // SAFETY：寫進 raw 還沒填的那一段。
        let n = unsafe { libc::getrandom(raw[filled..].as_mut_ptr().cast(), raw.len() - filled, 0) };
        if n < 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(err);
        }
        filled += n as usize;
    }
    Ok(raw.iter().flat_map(|b| format!("{b:02x}").into_bytes()).collect())
}

/// 第一框不是對的 `hello` 時，寫進訊息的那一段。
fn hello_mismatch(request: &FrontRequest) -> String {
    match request {
        FrontRequest::Hello { version } => format!("版本 {version}"),
        _ => "別的訊息".to_string(),
    }
}

/// poll 的一格是誰的、讀還是寫。
#[derive(Clone, Copy)]
enum Slot {
    Signal,
    Front { write: bool },
    Host { write: bool },
    Conversation { pid: libc::pid_t, write: bool },
    ConversationStderr { pid: libc::pid_t },
}

impl Supervisor {
    fn run(&mut self) -> i32 {
        loop {
            let now = Instant::now();
            self.on_timers(now);
            if self.shutting_down {
                if let Some(code) = self.advance_shutdown(now) {
                    return code;
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
            if let Some(host) = &self.host {
                watch(&host.proc.chan, Slot::Host { write: false }, Slot::Host { write: true });
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
            let planned = u64::try_from(timeout).ok().map(|millis| Instant::now() + Duration::from_millis(millis));
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
            if let Some(planned) = planned {
                self.check_resumed(planned);
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
                    Slot::Host { write: true } => {
                        if let Some(host) = self.host.as_mut() {
                            host.proc.chan.flush();
                        }
                    }
                    Slot::Host { write: false } => self.on_host_readable(),
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
        if let Some(host) = self.host.as_mut() {
            host.proc.advance_stop(now, term_grace);
            if self.host_ready_deadline().is_some_and(|at| at <= now) {
                say!("宿主起了 {} ms 還沒 ready，殺掉", self.args.host.as_ref().map_or(0, |h| h.ready_timeout.as_millis()));
                if let Some(host) = self.host.as_mut() {
                    host.timed_out = true;
                    host.proc.kill_now();
                }
            }
        }
        if self.host_restart_at.is_some_and(|at| at <= now) && !self.shutting_down {
            self.host_restart_at = None;
            self.start_host();
        }
        if self.rss_poll_at <= now {
            self.rss_poll_at = now + self.args.rss_poll;
            self.poll_rss();
        }
        if let Some(stall) = self.args.stall {
            self.check_stalls(now, stall);
        }
        if let Some(config) = self.args.throttle {
            self.throttle(now, config);
        }
        if self.front_restart_at.is_some_and(|at| at <= now) && !self.shutting_down {
            self.front_restart_at = None;
            self.start_front();
        }
        self.check_drains(now);
        self.check_idle(now);
        if self.warm_retry_at.is_some_and(|at| at <= now) {
            self.warm_retry_at = None;
            self.fill_warm();
        }
        if let (Some(at), Some(every)) = (self.stats_at, self.args.stats) {
            if at <= now {
                self.stats_at = Some(now + every);
                self.send_stats();
            }
        }
    }

    /// 有對話行程在判 `stalled` 時，最晚 `--stall-ms` 的四分之一醒一次，[`Self::check_resumed`] 才量得出自己停住過。
    fn next_deadline(&self) -> Option<Instant> {
        let restart = self.front_restart_at.filter(|_| !self.shutting_down);
        self.conversations
            .iter()
            .filter_map(|c| c.proc.deadline())
            .chain(self.front.as_ref().and_then(Proc::deadline))
            .chain(restart)
            .chain(Some(self.rss_poll_at).filter(|_| !self.conversations.is_empty()))
            .chain(self.args.stall.into_iter().flat_map(|stall| {
                self.conversations.iter().filter(|c| c.proc.stop.is_none()).filter_map(move |c| c.cpu.stall_at(c.heard_at?, stall))
            }))
            .chain(self.conversations.iter().filter(|c| c.throttleable()).filter_map(|c| c.cpu.deadline()))
            .chain(self.args.stall.filter(|_| self.conversations.iter().any(|c| c.heard_at.is_some())).map(|stall| Instant::now() + stall / 4))
            .chain(self.conversations.iter().filter_map(|c| c.drain.map(|at| at + self.args.drain_timeout)))
            .chain(self.conversations.iter().filter_map(|c| self.idle_deadline(c)))
            .chain(self.warm_retry_at.filter(|_| !self.shutting_down))
            .chain(self.stats_at)
            .chain(self.host.as_ref().and_then(|host| host.proc.deadline()))
            .chain(self.host_ready_deadline())
            .chain(self.host_restart_at.filter(|_| !self.shutting_down))
            .chain(self.admission_until)
            .min()
    }

    /// 宿主還沒 `ready`、還沒在收：到這個時間點就當它起不來。
    fn host_ready_deadline(&self) -> Option<Instant> {
        let host = self.host.as_ref().filter(|host| !host.ready && host.proc.stop.is_none())?;
        Some(host.started + self.args.host.as_ref()?.ready_timeout)
    }

    /// 監督行程比預定的時間晚了超過 `--stall-ms` 的一半才醒，判定自己被停住過（通常是整棵樹一起被凍住：docker pause、
    /// cgroup freezer、VM 暫停或快照）。這時對話行程也一起停了，遲到的心跳還沒送出來，照樣判就會把每一條都殺掉；所以所有的沉默從現在重新起算。
    ///
    /// 門檻取一半：正常的排程延遲是毫秒級，遠低於它；而凍住前對話行程照常送心跳時，會造成誤判的停住醒來時一定晚了至少 `stall` 的四分之三減一個心跳間隔
    /// （[`Self::next_deadline`] 保證最晚 `stall` 的四分之一就醒一次），所以心跳間隔不到 `stall` 的四分之一時一定認得出來。
    fn check_resumed(&mut self, planned: Instant) {
        let Some(stall) = self.args.stall else { return };
        let now = Instant::now();
        let late = now.saturating_duration_since(planned);
        if late < stall / 2 {
            return;
        }
        say!("監督行程比預定晚了 {} ms 才醒，判定自己被停住過；所有對話行程的沉默從現在重新起算", late.as_millis());
        for conversation in &mut self.conversations {
            if conversation.heard_at.is_some() {
                conversation.heard_at = Some(now);
                conversation.cpu.restart(now);
            }
        }
    }

    /// 送出 `bind` 之後 `stall` 沒聽到回報的，當場殺掉整個群組，死因 `stalled`。不走拆除梯度：事件迴圈卡住的行程讀不到 EOF，
    /// 也跑不了自己的 SIGTERM handler，梯度的兩段寬限只會讓它多佔那麼久的 CPU。監督行程自己停住過（fd 2 阻塞、被 SIGSTOP）時，
    /// 回報可能還在管線裡沒讀，所以判之前先讀一次它的控制通道。
    fn check_stalls(&mut self, now: Instant, stall: Duration) {
        for index in 0..self.conversations.len() {
            if !self.conversations[index].stalled(now, stall) {
                continue;
            }
            self.on_conversation_readable(index);
            let conversation = &mut self.conversations[index];
            if conversation.stalled(now, stall) {
                say!("對話行程 {} 已經 {} ms 沒有回報（壓住時停住的時間不算），殺掉", conversation.proc.pid, stall.as_millis());
                conversation.cause.get_or_insert(DeathCause::Stalled);
                conversation.proc.kill_now();
            }
        }
    }

    /// 壓住吃滿 CPU 的對話行程（[`cpu`]）：可以壓的照 [`cpu::Guard::tick`] 開始或切換。開始收、送 `drain` 的當場就放開了，見 [`Conversation::release`]。
    fn throttle(&mut self, now: Instant, config: cpu::Config) {
        for conversation in &mut self.conversations {
            let Some(heard_at) = conversation.heard_at.filter(|_| conversation.throttleable()) else {
                continue;
            };
            let holding = conversation.cpu.holding();
            if let Some(signal) = conversation.cpu.tick(now, heard_at, config) {
                if !holding {
                    say!("對話行程 {} 沉默 {} ms 而且一直要 CPU，開始壓住它", conversation.proc.pid, config.after.as_millis());
                }
                cpu::signal(conversation.proc.pid, signal);
            }
        }
    }

    /// 讀每個對話行程 leader 的 RSS，記最高值；超過 `--rss-limit-mb` 而還沒送過 SIGKILL 的，當場殺掉整個群組。死因記 `memory`，
    /// 已經在收的（例如停機）照原本的理由。
    ///
    /// 只量 leader：只讀它自己的 `VmRSS`，不含子孫行程；spawner 與工具又各自 `setsid`，群組 SIGKILL 也打不到（TODO(#2494)）。
    fn poll_rss(&mut self) {
        let now = Instant::now();
        for conversation in &mut self.conversations {
            if self.args.throttle.is_some() && conversation.throttleable() {
                if let Some(ns) = cpu::demand_ns(conversation.proc.pid) {
                    conversation.cpu.sample(now, ns);
                }
            }
            let Some(kb) = memory::vm_rss_kb(conversation.proc.pid) else { continue };
            conversation.rss_now_kb = kb;
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
        match new_token().and_then(|token| Ok((process::spawn(&self.args.front, &self.args.front_args, false)?, token))) {
            Ok(((pid, chan, _), token)) => {
                // 先登記、再交 token：宿主 ready 了，那一筆先排進宿主的通道；還沒的，等它 ready 時整張送。連線比那一筆先到，見 `on_unregistered`。
                self.front = Some(Proc::new(pid, chan));
                self.front_token = token.clone();
                self.front_quarantined = false;
                self.front_generation = self.next_generation();
                self.regrant(pid);
                let Some(mut front) = self.front.take() else { return };
                front.chan.send(&encode_front_event(&FrontEvent::Hello { version: PROTOCOL_VERSION, token }));
                for conversation in self.conversations.iter().filter(|c| c.phase == Phase::Up && c.proc.stop.is_none()) {
                    let Some(thread) = &conversation.thread else { continue };
                    front.chan.send(&encode_front_event(&FrontEvent::Up {
                        thread_id: thread.clone(),
                        socket: conversation.socket.as_os_str().as_bytes().to_vec(),
                    }));
                }
                self.front = Some(front);
                if self.args.stats.is_some() {
                    self.send_stats();
                }
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
            let request = decode_front_request(&payload);
            if let Some(front) = self.front.as_mut().filter(|front| !front.hello) {
                match &request {
                    Ok(FrontRequest::Hello { version: PROTOCOL_VERSION }) => {
                        front.hello = true;
                        continue;
                    }
                    Ok(other) => {
                        say!("前台的第一框不是版本 {PROTOCOL_VERSION} 的 hello（{}），整台停機", hello_mismatch(other));
                        front.kill_now();
                        self.begin_shutdown(EXIT_PROTOCOL);
                        return;
                    }
                    Err(_) => {}
                }
            }
            match request {
                Ok(FrontRequest::Ensure { thread_id, open }) => self.ensure(thread_id, open),
                Ok(FrontRequest::Release { thread_id }) => self.release(&thread_id),
                Ok(FrontRequest::AdmissionStopped) => self.admission_until = None,
                Ok(FrontRequest::Hello { .. }) => {}
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

    fn ensure(&mut self, thread: Vec<u8>, open: OpenMode) {
        if self.shutting_down {
            self.tell_front(&FrontEvent::Down { thread_id: thread, cause: DeathCause::Shutdown });
            return;
        }
        let now = Instant::now();
        if let Some(conversation) = self.conversations.iter_mut().find(|c| c.thread.as_ref() == Some(&thread)) {
            conversation.used_at = now;
            conversation.released = false;
            if open == OpenMode::Run {
                conversation.read_only = false;
            }
            if conversation.drain.is_some() {
                // 等它回答：回 `busy` 或逾時就回 `up`；回 `drained` 就收掉，這條跟其他排著的一起重算名額，收完照順序起。
                self.queue(thread, open);
            } else if conversation.phase == Phase::Up && conversation.proc.stop.is_none() {
                let socket = conversation.socket.as_os_str().as_bytes().to_vec();
                self.tell_front(&FrontEvent::Up { thread_id: thread, socket });
            } else if conversation.proc.stop.is_some() && conversation.cause == Some(DeathCause::Evicted) {
                // 逐出、正在收：前台收到 `down(evicted)` 不算回答，所以排進隊伍（已經在排的只升開啟方式），跟其他排著的一起重算名額。
                // 別的死因不理：收完回的 `down` 就是回答。
                self.queue(thread, open);
                self.make_room();
            }
            return;
        }
        if self.upgrade_pending(&thread, open) {
            return;
        }
        if self.take_warm(&thread, open) {
            self.fill_warm();
            return;
        }
        if self.conversations.len() < self.capacity as usize {
            self.start_conversation(Some(thread), open);
            return;
        }
        self.queue(thread, open);
        self.make_room();
    }

    /// 排進等名額的隊伍；已經在排的不重排，見 [`Self::upgrade_pending`]。
    fn queue(&mut self, thread: Vec<u8>, open: OpenMode) {
        if !self.upgrade_pending(&thread, open) {
            self.pending.push((thread, open));
        }
    }

    /// 這條 thread 在排的話，要的是 `run` 就把排著的升成 `run`；回它在不在排。
    fn upgrade_pending(&mut self, thread: &[u8], open: OpenMode) -> bool {
        let Some(waiting) = self.pending.iter_mut().find(|(t, _)| t == thread) else { return false };
        if open == OpenMode::Run {
            waiting.1 = OpenMode::Run;
        }
        true
    }

    /// 把預熱池裡的一個指派給 `thread`，先挑已經 `ready` 的。還沒 `ready` 的等它 `ready` 再送 `bind`。
    fn take_warm(&mut self, thread: &[u8], open: OpenMode) -> bool {
        let Some(index) = self
            .conversations
            .iter()
            .position(|c| c.warm() && c.phase == Phase::Warm)
            .or_else(|| self.conversations.iter().position(Conversation::warm))
        else {
            return false;
        };
        let conversation = &mut self.conversations[index];
        conversation.thread = Some(thread.to_vec());
        conversation.read_only = open == OpenMode::ReadOnly;
        conversation.used_at = Instant::now();
        if conversation.phase == Phase::Warm {
            Self::bind(conversation);
        }
        let pid = conversation.proc.pid;
        self.regrant(pid);
        true
    }

    fn bind(conversation: &mut Conversation) {
        let Some(thread) = &conversation.thread else { return };
        conversation.phase = Phase::Binding;
        conversation.heard_at = Some(Instant::now());
        let bind = ConversationCommand::Bind { thread_id: thread.clone() };
        conversation.proc.chan.send(&encode_conversation_command(&bind));
    }

    /// 這條 thread 排著，是在等它自己那個行程回答 `drain`：回 `busy` 就用原來的，回 `drained` 就用它讓出的名額，兩者互抵。
    fn waiting_own_drain(&self, thread: &[u8]) -> bool {
        self.conversations.iter().any(|c| c.thread.as_deref() == Some(thread) && c.drain.is_some() && c.proc.stop.is_none())
    }

    /// 排著的每一條都要有一個正在收、或在等 `drain` 回答的行程讓出名額：不夠就挑閒置最久的送 `drain`（只讀的先），挑不到的從最晚排進來的起回 `capacity`。
    /// 在等自己 `drain` 回答的那條與它自己的行程互抵，兩邊都不算，也不回 `capacity`。
    fn make_room(&mut self) {
        let needed = self.pending.iter().filter(|(t, _)| !self.waiting_own_drain(t)).count();
        let mut freeing = self
            .conversations
            .iter()
            .filter(|c| {
                c.proc.stop.is_some()
                    || (c.drain.is_some() && !c.thread.as_ref().is_some_and(|t| self.pending.iter().any(|(p, _)| p == t)))
            })
            .count();
        while freeing < needed {
            let victim = self
                .conversations
                .iter()
                .enumerate()
                .filter(|(_, c)| c.evictable())
                .min_by_key(|(_, c)| (!c.read_only, c.idle_from()))
                .map(|(index, _)| index);
            let Some(index) = victim else { break };
            Self::drain(&mut self.conversations[index]);
            freeing += 1;
        }
        while freeing < needed {
            let Some(at) = self.pending.iter().rposition(|(t, _)| !self.waiting_own_drain(t)) else { break };
            let (thread, _) = self.pending.remove(at);
            freeing += 1;
            let (current, limit) = (self.conversations.len() as u32, self.capacity);
            say!("名額滿（{current}／{limit}），沒有可逐出的對話行程");
            self.tell_front(&FrontEvent::Capacity { thread_id: thread, current, limit });
        }
    }

    fn drain(conversation: &mut Conversation) {
        let now = Instant::now();
        conversation.release(now);
        conversation.drain = Some(now);
        conversation.proc.chan.send(&encode_conversation_command(&ConversationCommand::Drain));
    }

    /// 有名額就照排隊順序起排著的；這條 thread 還有行程（在等它回答 `drain`、或正在收）的留著，等那個行程的結果。排的都起完了再補預熱池。
    fn serve_pending(&mut self) {
        while self.conversations.len() < self.capacity as usize && !self.shutting_down {
            let Some(at) =
                self.pending.iter().position(|(t, _)| !self.conversations.iter().any(|c| c.thread.as_ref() == Some(t)))
            else {
                break;
            };
            let (thread, open) = self.pending.remove(at);
            if !self.take_warm(&thread, open) {
                self.start_conversation(Some(thread), open);
            }
        }
        self.fill_warm();
    }

    /// 預熱池補到 `--warm` 個：有排著的、名額滿、停機中、上一個預熱的剛失敗，都不補。
    fn fill_warm(&mut self) {
        while !self.shutting_down
            && self.warm_retry_at.is_none()
            && self.pending.is_empty()
            && self.conversations.iter().filter(|c| c.warm()).count() < self.args.warm as usize
            && self.conversations.len() < self.capacity as usize
        {
            self.start_conversation(None, OpenMode::Run);
        }
    }

    fn release(&mut self, thread: &[u8]) {
        let Some(conversation) = self.conversations.iter_mut().find(|c| c.thread.as_deref() == Some(thread)) else { return };
        if !conversation.read_only {
            return;
        }
        if conversation.evictable() {
            Self::drain(conversation);
        } else if conversation.proc.stop.is_none() {
            conversation.released = true;
        }
    }

    /// 這條的閒置時限到期的時間點；還沒 `up`、不在閒置、在收、在等 `drain` 的回答、或這種開啟方式不照時間逐出的，沒有。
    fn idle_deadline(&self, conversation: &Conversation) -> Option<Instant> {
        if !conversation.evictable() {
            return None;
        }
        let limit = if conversation.read_only { self.args.read_only_idle } else { self.args.idle };
        Some(conversation.idle_from()? + limit?)
    }

    fn check_idle(&mut self, now: Instant) {
        for index in 0..self.conversations.len() {
            if self.idle_deadline(&self.conversations[index]).is_some_and(|at| at <= now) {
                Self::drain(&mut self.conversations[index]);
            }
        }
    }

    /// `drain` 送出 `--drain-timeout-ms` 還沒回答，當它不閒置：不收，等它下次回報閒置。
    fn check_drains(&mut self, now: Instant) {
        for index in 0..self.conversations.len() {
            let conversation = &mut self.conversations[index];
            if conversation.drain.is_some_and(|at| at + self.args.drain_timeout <= now) {
                say!("對話行程 {} 沒回答 drain，不收", conversation.proc.pid);
                self.not_drained(index);
            }
        }
    }

    /// `drain` 的回答是不收（`busy` 或逾時）：排著等它的那條 thread 回 `up`，其餘排著的另找名額。
    fn not_drained(&mut self, index: usize) {
        let conversation = &mut self.conversations[index];
        conversation.drain = None;
        conversation.idle_since = None;
        if let Some(thread) = conversation.thread.clone() {
            if let Some(at) = self.pending.iter().position(|(t, _)| *t == thread) {
                self.pending.remove(at);
                if conversation.phase == Phase::Up && conversation.proc.stop.is_none() {
                    let socket = conversation.socket.as_os_str().as_bytes().to_vec();
                    self.tell_front(&FrontEvent::Up { thread_id: thread, socket });
                }
            }
        }
        self.make_room();
    }

    fn send_stats(&mut self) {
        let live = self.conversations.len() as u32;
        let warm = self.conversations.iter().filter(|c| c.warm()).count() as u32;
        let rss_kib = self.conversations.iter().map(|c| c.rss_now_kb).sum::<u64>().min(u64::from(u32::MAX)) as u32;
        self.tell_front(&FrontEvent::Stats { live, warm, rss_kib, deaths: self.deaths });
    }

    /// 發一個新的序號：從 1 起遞增，繞回時跳過 0。
    fn next_generation(&mut self) -> u32 {
        self.last_generation = self.last_generation.checked_add(1).unwrap_or(1);
        self.last_generation
    }

    fn count_death(&mut self, cause: DeathCause) {
        let slot = &mut self.deaths[cause as usize - 1];
        *slot = slot.saturating_add(1);
    }

    fn start_conversation(&mut self, thread: Option<Vec<u8>>, open: OpenMode) {
        self.next_socket += 1;
        let socket = self.args.run_dir.join(format!("c{}.sock", self.next_socket));
        let _ = std::fs::remove_file(&socket);
        let mut args = self.args.conversation_args.clone();
        args.push("--socket".into());
        args.push(socket.clone().into_os_string());
        match new_token().and_then(|token| Ok((process::spawn(&self.args.conversation, &args, true)?, token))) {
            Ok(((pid, chan, stderr), token)) => {
                let generation = self.next_generation();
                self.conversations.push(Conversation {
                    proc: Proc::new(pid, chan),
                    thread,
                    read_only: open == OpenMode::ReadOnly,
                    idle_since: None,
                    used_at: Instant::now(),
                    drain: None,
                    released: false,
                    rss_now_kb: 0,
                    socket,
                    phase: Phase::Starting,
                    turns: 0,
                    cause: None,
                    stderr,
                    rss_kb: 0,
                    heard_at: None,
                    max_silence: Duration::ZERO,
                    cpu: cpu::Guard::default(),
                    token: token.clone(),
                    quarantined: false,
                    generation,
                });
                // 先登記、再交 token：同 `start_front`。
                self.regrant(pid);
                if let Some(conversation) = self.conversations.last_mut() {
                    let hello = ConversationCommand::Hello { version: PROTOCOL_VERSION, token };
                    conversation.proc.chan.send(&encode_conversation_command(&hello));
                }
            }
            Err(err) => {
                say!("對話行程起不來：{err}");
                let error = err.to_string();
                self.audit.record(&Record::Conversation {
                    thread: thread.as_deref().unwrap_or_default(),
                    pid: 0,
                    cause: DeathCause::Crash,
                    exit: Exit::NOT_STARTED,
                    turns: 0,
                    rss_kb: 0,
                    max_silence_ms: 0,
                    error: Some(&error),
                });
                self.count_death(DeathCause::Crash);
                match thread {
                    Some(thread) => self.tell_front(&FrontEvent::Down { thread_id: thread, cause: DeathCause::Crash }),
                    None => self.warm_retry_at = Some(Instant::now() + self.args.front_restart),
                }
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
        if !frames.is_empty() {
            self.conversations[index].hear(Instant::now());
        }
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
            if !conversation.proc.hello {
                if report == (ConversationReport::Hello { version: PROTOCOL_VERSION }) {
                    conversation.proc.hello = true;
                    continue;
                }
                say!(
                    "對話行程 {} 的第一框不是版本 {PROTOCOL_VERSION} 的 hello（{}），殺掉",
                    conversation.proc.pid,
                    match report {
                        ConversationReport::Hello { version } => format!("版本 {version}"),
                        _ => "別的訊息".to_string(),
                    }
                );
                conversation.cause.get_or_insert(DeathCause::Protocol);
                conversation.proc.kill_now();
                return;
            }
            match report {
                ConversationReport::Ready if conversation.phase == Phase::Starting => {
                    if conversation.thread.is_some() {
                        Self::bind(conversation);
                    } else {
                        conversation.phase = Phase::Warm;
                    }
                }
                ConversationReport::Bound { thread_id } if conversation.phase == Phase::Binding => {
                    if Some(&thread_id) != conversation.thread.as_ref() {
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
                    conversation.read_only = false;
                    conversation.released = false;
                }
                ConversationReport::Idle { idle_ms } => {
                    let now = Instant::now();
                    conversation.idle_since = Some(now.checked_sub(Duration::from_millis(idle_ms.into())).unwrap_or(now));
                    if conversation.released && conversation.evictable() {
                        conversation.released = false;
                        Self::drain(conversation);
                    }
                }
                ConversationReport::Busy => {
                    if conversation.drain.is_some() {
                        self.not_drained(index);
                    } else {
                        conversation.idle_since = None;
                    }
                }
                ConversationReport::Drained if conversation.proc.stop.is_none() => {
                    conversation.drain = None;
                    conversation.cause.get_or_insert(DeathCause::Evicted);
                    conversation.begin_stop(Instant::now(), self.args.eof_grace);
                    // 在等它回答的那條 thread 現在要一個新行程，跟其他排著的一起重算名額。
                    self.make_room();
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
                say!("停機中又收到停止訊號，所有對話行程與宿主當場 SIGKILL");
                for conversation in &mut self.conversations {
                    conversation.proc.kill_now();
                }
                if let Some(host) = self.host.as_mut() {
                    host.proc.kill_now();
                }
            } else {
                self.begin_shutdown(0);
            }
        }
    }

    /// 開始停機（見檔頭的順序）；已經在停機的只記下結束碼（先記到的非 0 碼優先）。
    fn begin_shutdown(&mut self, code: i32) {
        if self.exit_code == 0 {
            self.exit_code = code;
        }
        if self.shutting_down {
            return;
        }
        self.shutting_down = true;
        self.host_restart_at = None;
        // 還有行程的那幾條，等那個行程結束時回 `down`。
        for (thread, _) in std::mem::take(&mut self.pending) {
            if self.conversations.iter().any(|c| c.thread.as_ref() == Some(&thread)) {
                continue;
            }
            self.tell_front(&FrontEvent::Down { thread_id: thread, cause: DeathCause::Shutdown });
        }
        if self.front.as_ref().is_some_and(|front| front.stop.is_none()) {
            self.tell_front(&FrontEvent::StopAdmission);
            self.admission_until = Some(Instant::now() + self.args.admission_timeout);
        }
    }

    /// 停機的下一步；全部收完回結束碼。
    fn advance_shutdown(&mut self, now: Instant) -> Option<i32> {
        let front_admitting = self.front.as_ref().is_some_and(|front| front.stop.is_none());
        if front_admitting && self.admission_until.is_some_and(|at| at > now) {
            return None;
        }
        self.admission_until = None;
        if !self.conversations.is_empty() {
            for conversation in &mut self.conversations {
                conversation.cause.get_or_insert(DeathCause::Shutdown);
                conversation.begin_stop(now, self.args.eof_grace);
            }
            return None;
        }
        if let Some(host) = self.host.as_mut() {
            host.proc.begin_stop(now, self.args.eof_grace);
            return None;
        }
        match self.front.as_mut() {
            None => Some(self.exit_code),
            Some(front) => {
                front.begin_stop(now, self.args.eof_grace);
                None
            }
        }
    }

    fn kill_everything(&mut self) {
        for conversation in &mut self.conversations {
            conversation.cause.get_or_insert(DeathCause::Shutdown);
            conversation.proc.kill_now();
        }
        if let Some(host) = self.host.as_mut() {
            host.proc.kill_now();
        }
        if let Some(front) = self.front.as_mut() {
            front.kill_now();
        }
    }

    fn start_host(&mut self) {
        let Some(config) = &self.args.host else { return };
        let socket = self.args.run_dir.join("host.sock");
        let mut args = config.args.clone();
        args.push("--socket".into());
        args.push(socket.into_os_string());
        match process::spawn(&config.program, &args, false) {
            Ok((pid, chan, _)) => {
                let mut proc = Proc::new(pid, chan);
                proc.chan.send(&encode_host_command(&HostCommand::Hello { version: PROTOCOL_VERSION }));
                self.host = Some(Host { proc, ready: false, started: Instant::now(), timed_out: false });
            }
            Err(err) => {
                say!("宿主起不來：{err}");
                let error = err.to_string();
                self.audit.record(&Record::Host { pid: 0, exit: Exit::NOT_STARTED, ready: false, error: Some(&error) });
                self.host_failed(false, Duration::ZERO);
            }
        }
    }

    /// 宿主沒了（沒起成或結束了）：`ready` 之前的失敗連續到上限就停機，否則照退避排下一次重起。停機中不重起。
    fn host_failed(&mut self, ready: bool, lived: Duration) {
        let Some(config) = &self.args.host else { return };
        if self.shutting_down {
            return;
        }
        if !ready {
            self.host_failures += 1;
            if self.host_failures >= config.start_failures {
                say!("宿主在 ready 之前連續失敗 {} 次，整台停機", self.host_failures);
                self.begin_shutdown(EXIT_HOST_FAILED);
                return;
            }
        }
        if lived >= config.stable {
            self.host_backoff = config.backoff;
        }
        let wait = self.host_backoff;
        self.host_backoff = (wait * 2).min(config.backoff_max);
        say!("宿主 {} ms 後重起", wait.as_millis());
        self.host_restart_at = Some(Instant::now() + wait);
    }

    fn on_host_readable(&mut self) {
        let Some(host) = self.host.as_mut() else { return };
        let frames = match host.proc.chan.receive() {
            Ok(frames) => frames,
            Err(err) => {
                say!("宿主送來解不開的框（{}），殺掉宿主", err.0);
                host.proc.kill_now();
                return;
            }
        };
        for payload in frames {
            let Some(host) = self.host.as_mut() else { return };
            let report = match decode_host_report(&payload) {
                Ok(report) => report,
                Err(err) => {
                    say!("宿主送來解不開的訊息（{}），殺掉宿主", err.0);
                    host.proc.kill_now();
                    return;
                }
            };
            if !host.proc.hello {
                if report == (HostReport::Hello { version: PROTOCOL_VERSION }) {
                    host.proc.hello = true;
                    continue;
                }
                say!("宿主的第一框不是版本 {PROTOCOL_VERSION} 的 hello，整台停機");
                host.proc.kill_now();
                self.begin_shutdown(EXIT_PROTOCOL);
                return;
            }
            match report {
                HostReport::Ready if !host.ready && host.proc.stop.is_none() => {
                    host.ready = true;
                    self.host_failures = 0;
                    say!("宿主 {} ready", host.proc.pid);
                    let grants: Vec<HostCommand> = self.identities().filter_map(|pid| self.grant_of(pid)).collect();
                    if let Some(host) = self.host.as_mut() {
                        for grant in grants {
                            host.proc.chan.send(&encode_host_command(&grant));
                        }
                    }
                }
                HostReport::Violation { pid, generation, reason } => self.on_violation(pid, Some(generation), &reason),
                HostReport::Unregistered { pid, conn, reason } => self.on_unregistered(pid, conn, &reason),
                _ => {}
            }
        }
    }

    /// 前台與每個對話行程的 pid。
    fn identities(&self) -> impl Iterator<Item = libc::pid_t> + '_ {
        self.front.iter().map(|front| front.pid).chain(self.conversations.iter().map(|c| c.proc.pid))
    }

    /// 這個 pid 在身分表上的那一筆：沒被隔離的前台或對話行程才有。spawn 當下就有，`hello` 對不上的會被殺掉、收屍前撤掉。
    fn grant_of(&self, pid: libc::pid_t) -> Option<HostCommand> {
        let (generation, token, role, thread) = if self.front.as_ref().is_some_and(|front| front.pid == pid) {
            if self.front_quarantined {
                return None;
            }
            (self.front_generation, self.front_token.clone(), Role::Front, Vec::new())
        } else {
            let conversation = self.conversations.iter().find(|c| c.proc.pid == pid && !c.quarantined)?;
            (conversation.generation, conversation.token.clone(), Role::Conversation, conversation.thread.clone().unwrap_or_default())
        };
        Some(HostCommand::Grant { pid: u32::try_from(pid).ok()?, generation, token, role, thread })
    }

    /// 這個 pid 的那一筆有了或變了：宿主 `ready` 了就送過去（還沒 `ready` 的，等它 `ready` 時整張送）。
    fn regrant(&mut self, pid: libc::pid_t) {
        let Some(grant) = self.grant_of(pid) else { return };
        if let Some(host) = self.host.as_mut().filter(|host| host.ready && host.proc.stop.is_none()) {
            host.proc.chan.send(&encode_host_command(&grant));
        }
    }

    /// 宿主拒了一條 pid 不在它表上的連線，或一條撤過的連線。那個 pid 是活著、沒被隔離的前台或對話行程時，它那一筆 spawn 當下就登記了，
    /// 宿主沒有只會是還沒寫進宿主的 pipe（宿主剛起來或剛重起、這邊還沒處理它的 `ready`，或排在這邊沒寫出去）；撤過的連線是撤銷之前
    /// 就連上的：同一個號碼上一個行程留下的，或 pid 重用得比宿主讀 pipe 快、新行程先連上的。兩種都不是它的錯：不隔離、不寫稽核，只在運作 log 記一行警告，帶 pid 與宿主的連線編號（`conn`，
    /// 宿主自己的 log 也寫這個號）。其餘的（不是我們的 pid、已經隔離的）照違規記，稽核的理由是宿主回給那條連線的。
    fn on_unregistered(&mut self, pid: u32, conn: u32, reason: &[u8]) {
        let live = libc::pid_t::try_from(pid).ok().filter(|&pid| pid > 0).is_some_and(|pid| self.grant_of(pid).is_some());
        if live {
            say!("警告：宿主拒了 pid {pid} 的連線 #{conn}：表還在路上，或是撤銷之前就連上的連線；不隔離、不寫稽核");
            return;
        }
        self.on_violation(pid, None, reason);
    }

    /// 宿主斷了一條違反協定的連線（或 `on_unregistered` 判成違規的）：寫稽核。那個 pid 是前台或對話行程的，隔離到它結束：
    /// 之後重送身分表時不再放進去；宿主 `ready` 了、沒在收的，也再送一次 `revoke`：它那一筆 `grant` 可能還排在這邊沒寫出去，
    /// 撤銷排在它後面才蓋得掉。還沒 `ready` 的不必送：`ready` 時整張送的表本來就沒有它。只在剛隔離時送一次：隔離之後不會再送它的
    /// `grant`，第一次那筆 `revoke` 就蓋得掉；每筆 `revoke` 都讓宿主把 backlog 收乾淨，重送只會讓違規的行程反覆觸發這件事。
    /// 不是我們的 pid（含 0），或 `generation` 對不上現在那個行程的（同一個 pid 號碼上一個行程的回報，在它收屍、號碼被重用之後才讀到），
    /// 只寫稽核，`role` 記 `unknown`。序號 0 與 `None` 只比 pid：0 是宿主表上沒有那個 pid 時、還沒送 `hello` 的連線報的（那一筆還在 pipe 上，
    /// 或已經隔離、撤掉了）；收屍之前先撤銷，宿主照順序讀 pipe，撤銷時把 backlog 收乾淨、記成撤過，上一個行程留下的連線報的是 `unregistered`，
    /// 不會是序號 0 的 `violation`。`None` 是 `on_unregistered` 轉來的，那時 pid 已經不在身分表上。
    fn on_violation(&mut self, pid: u32, generation: Option<u32>, reason: &[u8]) {
        let reason = String::from_utf8_lossy(reason);
        let pid = libc::pid_t::try_from(pid).unwrap_or(-1);
        let current = |own: u32| generation.is_none_or(|g| g == 0 || g == own);
        let (role, thread, newly) = if self.front.as_ref().is_some_and(|front| front.pid == pid) && current(self.front_generation) {
            ("front", Vec::new(), !std::mem::replace(&mut self.front_quarantined, true))
        } else if let Some(conversation) = self.conversations.iter_mut().find(|c| c.proc.pid == pid && current(c.generation)) {
            ("conversation", conversation.thread.clone().unwrap_or_default(), !std::mem::replace(&mut conversation.quarantined, true))
        } else {
            ("unknown", Vec::new(), false)
        };
        if role == "unknown" {
            let generation = generation.map_or_else(String::new, |g| format!("，序號 {g}"));
            say!("宿主斷了 pid {pid}{generation} 的連線：{reason}；不是現在這邊起的哪個行程，只寫稽核");
        } else {
            say!("宿主斷了 pid {pid}（{role}）的連線：{reason}；這個身分隔離到它結束");
        }
        self.audit.record(&Record::Protocol { pid, role, thread: &thread, reason: &reason });
        if let (true, Ok(pid), Some(host)) =
            (newly, u32::try_from(pid), self.host.as_mut().filter(|host| host.ready && host.proc.stop.is_none()))
        {
            host.proc.chan.send(&encode_host_command(&HostCommand::Revoke { pid }));
        }
    }

    fn reap(&mut self) {
        let leaders: Vec<libc::pid_t> = self
            .conversations
            .iter()
            .map(|c| c.proc.pid)
            .chain(self.front.as_ref().map(|f| f.pid))
            .chain(self.host.as_ref().map(|h| h.proc.pid))
            .collect();
        // 隔離中的也算：它那一筆 `grant` 與隔離時補送的 `revoke` 可能還排在這邊沒寫出去，收屍前要一起寫進 pipe。
        let identities: Vec<libc::pid_t> = self.identities().collect();
        let host = &mut self.host;
        let mut exited = Vec::new();
        process::reap(
            |pid| {
                if leaders.contains(&pid) {
                    process::signal_group(pid, libc::SIGKILL);
                }
                // 收屍之前撤掉它的身分：這時 pid 還沒被收，不會被重用。撤銷要在收屍之前真的進 pipe；宿主每一輪先讀乾淨控制通道才處理連線，
                // 所以 pid 被重用之後才來的連線，一定排在撤銷後面。寫不進去就當場殺掉宿主：新的宿主拿到的表本來就沒有這個 pid。
                if let (true, Ok(pid), Some(host)) =
                    (identities.contains(&pid), u32::try_from(pid), host.as_mut().filter(|host| host.ready))
                {
                    host.proc.chan.send(&encode_host_command(&HostCommand::Revoke { pid }));
                    if !host.proc.chan.flush_until(Instant::now() + REVOKE_WRITE_LIMIT) {
                        eprintln!("nexus-supervisor: 宿主 {} 收不下撤銷，殺掉重起", host.proc.pid);
                        process::signal_group(host.proc.pid, libc::SIGKILL);
                    }
                }
            },
            |pid, status| exited.push((pid, Exit::from_status(status))),
        );
        for (pid, exit) in exited {
            self.on_exit(pid, exit);
        }
    }

    fn on_exit(&mut self, pid: libc::pid_t, exit: Exit) {
        if self.host.as_ref().is_some_and(|host| host.proc.pid == pid) {
            let Some(host) = self.host.take() else { return };
            let error = host.timed_out.then_some("ready 之前逾時");
            self.audit.record(&Record::Host { pid, exit, ready: host.ready, error });
            if !self.shutting_down {
                say!("宿主結束了（{exit:?}，{}）", if host.ready { "ready 之後" } else { "ready 之前" });
            }
            self.host_failed(host.ready, host.started.elapsed());
            return;
        }
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
            thread: conversation.thread.as_deref().unwrap_or_default(),
            pid,
            cause,
            exit,
            turns: conversation.turns,
            rss_kb: conversation.rss_kb,
            max_silence_ms: conversation.max_silence.as_millis().min(u128::from(u64::MAX)) as u64,
            error: None,
        });
        let _ = std::fs::remove_file(&conversation.socket);
        self.count_death(cause);
        match conversation.thread {
            Some(thread) => self.tell_front(&FrontEvent::Down { thread_id: thread, cause }),
            None if cause != DeathCause::Shutdown => self.warm_retry_at = Some(Instant::now() + self.args.front_restart),
            None => {}
        }
        self.serve_pending();
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
