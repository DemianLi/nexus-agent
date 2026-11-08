//! 監督行程的控制面（[#1947](https://github.com/DemianLi/nexus-agent/issues/1947)，設計
//! `.docs/supervisor-1947-design-2026-11-03.md` §五）：監督行程與它起的三種子行程（每條對話一個的對話行程、一個前台、一個宿主
//! [#2569](https://github.com/DemianLi/nexus-agent/issues/2569)）之間的訊息。
//! 這裡只定每則訊息的格式與意思（含哪一則回答哪一則）；什麼時候送、收到後怎麼處置，屬於監督行程（#2340）與各個子行程
//! （對話行程 #2338、前台 #2341、宿主 #2569）。
//!
//! **每條通道兩個方向的第一框都是 `hello`**，帶 [`PROTOCOL_VERSION`]：監督行程起了子行程就先送自己的，子行程送出的第一框也要是它的。
//! 版本不相等就是錯配（同一次建置出貨的兩邊才相容，不做跨版本協商），判法見監督行程。給對話行程與前台的 `hello` 另帶一個身分 token：
//! 它們連宿主時拿它證明自己是誰（宿主照監督行程給的身分表核對，見 [`HostCommand::Grant`]）。token 只走這條通道，不放環境變數或命令列。
//!
//! 框與欄位同 spawner 的控制通道（[`crate::protocol`] 的檔頭）：`u32 LE 長度` 接著內容，內容第一個 byte 是種類；數字是 `u32 LE`，
//! 字串是 `u32 LE 長度 + UTF-8 bytes`，列舉是一個 byte。送端只送 UTF-8；這裡照 bytes 收、不驗，TS 端解到壞序列換成 U+FFFD、不丟錯。資料（對話本身的請求與回應）不經這裡，前台直接連對話行程的 socket。
//!
//! 三條通道、六個方向，各有一組種類 byte、各自一支解碼器。**種類 byte 在六個方向之間不重複**：大寫是送給監督行程的，小寫是監督行程送出的。
//! 這幾條通道之間送錯通道或方向時，解碼器回「不認得的種類」，不會把它當成另一則形狀相同的訊息。跟 spawner 控制通道的種類 byte
//! 有重疊（`R`、`E`），那條通道的框送到這裡不在保證內。
//!
//! `decode_*` 遇到截斷、框尾多餘、不認得的種類或列舉碼都回 [`DecodeError`]；`encode_*` 不會失敗。
//!
//! 時間只送相對值：兩個行程的時鐘不同源，監督行程用自己的單調時鐘記收到的時間點。

use crate::protocol::{DecodeError, Reader, Writer};

/// 控制面的協定版本。兩邊各自的常數要跟 `supervisor-vectors.json` 的 `protocolVersion` 相等（兩邊的測試各自核對）；改了任何一則訊息的格式就加一。
/// 連宿主 socket 的協定（[`crate::host_protocol`]）用同一個版本，`host-vectors.json` 的 `protocolVersion` 也核對。
pub const PROTOCOL_VERSION: u32 = 1;

/// 監督行程 → 對話行程。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConversationCommand {
    /// 第一框。`token` 是這個行程連宿主時用的身分（ASCII）。
    Hello { version: u32, token: Vec<u8> },
    /// 綁定一條 thread。預熱池裡的行程與一開始就為某條 thread 起的行程都走這一則。
    Bind { thread_id: Vec<u8> },
    /// 準備收：對話行程確認自己仍閒置才回 [`ConversationReport::Drained`]，否則回 [`ConversationReport::Busy`]。收掉是接著關 stdin。
    Drain,
}

/// 一輪的開始或結束。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TurnPhase {
    Begin = 0,
    End = 1,
}

/// 對話行程 → 監督行程。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConversationReport {
    /// 第一框。
    Hello { version: u32 },
    /// 根建好、插件載完，可以綁 thread。
    Ready,
    /// 已綁定 `thread_id`，帶回同一個 id。
    Bound { thread_id: Vec<u8> },
    Turn { phase: TurnPhase },
    /// 變成閒置（對話行程自己判斷的閒置）時送，帶送出時已經閒置了多久（毫秒）。超過 `u32::MAX`（約 49.7 天）時送端送 `u32::MAX`。
    Idle { idle_ms: u32 },
    /// 不再閒置。也是收到 [`ConversationCommand::Drain`] 時仍不閒置的回答。
    Busy,
    /// 一輪中定時送；監督行程用它判斷事件迴圈有沒有卡死。
    Heartbeat,
    /// 回 [`ConversationCommand::Drain`]：確認仍閒置，不再接新的請求，可以收了。
    Drained,
}

/// 前台要一條 thread 的對話行程時，這次打開是為了什麼。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpenMode {
    /// 要跑 agent。
    Run = 0,
    /// 只讀歷史（設計 §7-3）：閒置時間短、名額滿時最先被逐出。
    ReadOnly = 1,
}

/// 前台 → 監督行程。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrontRequest {
    /// 第一框。
    Hello { version: u32 },
    /// 回 [`FrontEvent::StopAdmission`]：前台已經不收新的請求了。
    AdmissionStopped,
    /// 要這條 thread 的對話行程；監督行程回 [`FrontEvent::Up`]、[`FrontEvent::Down`] 或 [`FrontEvent::Capacity`]。
    Ensure { thread_id: Vec<u8>, open: OpenMode },
    /// 前台用完了（例如讀完歷史），這條 thread 的行程可以先收。只收只讀開啟的；已經轉成一般的（收到過 `ensure(run)` 或 `turn(begin)`）不理，照閒置時限收。
    Release { thread_id: Vec<u8> },
}

/// 對話行程為什麼結束（設計 §6-2 的七類，加上 [`DeathCause::Protocol`]）。碼從 1 起，[`FrontEvent::Stats`] 的 `deaths` 依碼的順序排。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeathCause {
    /// V8 的 heap 上限。
    Heap = 1,
    /// 監督行程因 RSS 超過上限殺的。
    Memory = 2,
    /// 主機或 cgroup 的 OOM killer 殺的。
    HostOom = 3,
    /// 監督行程因時鐘或心跳殺的。
    Stalled = 4,
    /// 其他非零結束或訊號，含沒起成。
    Crash = 5,
    /// 閒置逐出。
    Evicted = 6,
    /// 整台停機。
    Shutdown = 7,
    /// 控制通道的第一框不是 `hello`，或協定版本對不上。
    Protocol = 8,
}

/// 死因的種數，也是 [`FrontEvent::Stats`] 的 `deaths` 的長度。
pub const DEATH_CAUSES: usize = 8;

impl DeathCause {
    pub fn from_u8(v: u8) -> Option<DeathCause> {
        Some(match v {
            1 => DeathCause::Heap,
            2 => DeathCause::Memory,
            3 => DeathCause::HostOom,
            4 => DeathCause::Stalled,
            5 => DeathCause::Crash,
            6 => DeathCause::Evicted,
            7 => DeathCause::Shutdown,
            8 => DeathCause::Protocol,
            _ => return None,
        })
    }
}

/// 監督行程 → 前台。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrontEvent {
    /// 第一框。`token` 是前台連宿主時用的身分（ASCII）；前台每次（重）起都換一個。
    Hello { version: u32, token: Vec<u8> },
    /// 整台要停機了：前台不再收新的請求，做到了回 [`FrontRequest::AdmissionStopped`]。監督行程等這個回答（有上限）才開始收對話行程。
    StopAdmission,
    /// 這條 thread 的對話行程在 `socket` 上聽，前台直接連。
    Up { thread_id: Vec<u8>, socket: Vec<u8> },
    /// 這條 thread 的對話行程結束了，或沒起成（`Crash`）。
    Down { thread_id: Vec<u8>, cause: DeathCause },
    /// 名額滿、沒有可逐出的，這條 thread 沒起：前台回 `thread_at_capacity`。`current` 含預熱池與起動中的行程。
    Capacity { thread_id: Vec<u8>, current: u32, limit: u32 },
    /// 給前台的 `/metrics`：活著的對話行程數（含預熱池）、預熱池的大小、全部對話行程 RSS 的合計（KiB），與各類死因的累計。
    Stats { live: u32, warm: u32, rss_kib: u32, deaths: [u32; DEATH_CAUSES] },
}

/// 宿主連線的身分是誰的。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Front = 0,
    Conversation = 1,
}

/// 監督行程 → 宿主。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostCommand {
    /// 第一框。
    Hello { version: u32 },
    /// 這個 pid 拿這個 token 連進來就是它：前台，或對話行程（`thread` 是它綁的那條；還沒綁是空的）。同一個 pid 再送一次就整筆換掉
    /// （對話行程綁了 thread 時）。宿主每次（重）起送出 [`HostReport::Ready`] 之後，監督行程把當下整張表重送一遍。
    Grant { pid: u32, token: Vec<u8>, role: Role, thread: Vec<u8> },
    /// 這個 pid 的身分作廢。監督行程在收屍之前送（那時 pid 還沒被收，不會被別的行程拿去用），隔離一個身分時也送。
    /// 宿主收到時先把 listen backlog 收完，再撤掉表上那一筆：它驗過身分的連線斷掉；還沒送 `hello` 的（含剛從 backlog 收進來的）
    /// 從此不管送什麼都只回 `rejected`、報 [`HostReport::Unregistered`]，同一個 pid 號碼之後再登記也不照新的那一筆驗。
    Revoke { pid: u32 },
}

/// 宿主 → 監督行程。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostReport {
    /// 第一框。
    Hello { version: u32 },
    /// 在聽了，可以收身分表。在這之前的失敗（含沒起成）算「ready 之前的失敗」，見監督行程的退避。
    Ready,
    /// 一條連線違反協定（框太大、內容解不開、重複的 `hello`、版本或 token 不對），宿主已經斷了它，那個 pid 的身分也在宿主那邊作廢了
    /// （監督行程那邊還排著的 `grant` 寫過去會再登記，所以監督行程隔離時再送一次 `revoke`）。撤過的連線不會報這個，見 `Unregistered`。
    /// `pid` 是 `SO_PEERCRED` 讀到的，讀不到或 uid 不同是 0；`reason` 是給人看的一句話（UTF-8）。
    Violation { pid: u32, reason: Vec<u8> },
    /// 宿主拒了一條連線、斷了它，沒有撤任何身分：它送了 `hello` 而 pid 不在宿主的表上，或它是撤過的連線（送什麼都算）。`pid` 同上。
    /// 不一定是違規：合法行程那一筆還沒寫進宿主的 pipe 時（宿主剛起來或剛重起、監督行程還沒送表，或那一筆還排在監督行程這邊），
    /// 或 pid 被重用、這是同一個號碼上一個行程留下的連線，也是這樣；要不要算違規由監督行程判斷。
    /// `conn` 是宿主替連線編的號（這個宿主行程裡依 accept 的順序從 1 起），宿主自己的 log 也寫這個號，兩邊對得起來。
    Unregistered { pid: u32, conn: u32 },
}

const CMD_HELLO: u8 = b'w';
const CMD_BIND: u8 = b'b';
const CMD_DRAIN: u8 = b'd';
const REP_HELLO: u8 = b'V';
const REP_READY: u8 = b'R';
const REP_BOUND: u8 = b'B';
const REP_TURN: u8 = b'T';
const REP_IDLE: u8 = b'I';
const REP_BUSY: u8 = b'Y';
const REP_HEARTBEAT: u8 = b'H';
const REP_DRAINED: u8 = b'D';
const REQ_HELLO: u8 = b'F';
const REQ_ADMISSION_STOPPED: u8 = b'S';
const REQ_ENSURE: u8 = b'E';
const REQ_RELEASE: u8 = b'L';
const EV_HELLO: u8 = b'f';
const EV_STOP_ADMISSION: u8 = b's';
const EV_UP: u8 = b'u';
const EV_DOWN: u8 = b'x';
const EV_CAPACITY: u8 = b'c';
const EV_STATS: u8 = b'm';
const HCMD_HELLO: u8 = b'k';
const HCMD_GRANT: u8 = b'a';
const HCMD_REVOKE: u8 = b'r';
const HREP_HELLO: u8 = b'K';
const HREP_READY: u8 = b'Q';
const HREP_VIOLATION: u8 = b'P';
const HREP_UNREGISTERED: u8 = b'N';

fn decoded<T>(mut r: Reader<'_>, read: impl FnOnce(&mut Reader<'_>, u8) -> Result<T, DecodeError>) -> Result<T, DecodeError> {
    let kind = r.u8()?;
    let value = read(&mut r, kind)?;
    r.end()?;
    Ok(value)
}

pub fn encode_conversation_command(command: &ConversationCommand) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match command {
        ConversationCommand::Hello { version, token } => {
            w.u8(CMD_HELLO);
            w.u32(*version);
            w.bytes(token);
        }
        ConversationCommand::Bind { thread_id } => {
            w.u8(CMD_BIND);
            w.bytes(thread_id);
        }
        ConversationCommand::Drain => w.u8(CMD_DRAIN),
    }
    w.0
}

pub fn decode_conversation_command(payload: &[u8]) -> Result<ConversationCommand, DecodeError> {
    decoded(Reader { buf: payload }, |r, kind| {
        Ok(match kind {
            CMD_HELLO => ConversationCommand::Hello { version: r.u32()?, token: r.bytes()? },
            CMD_BIND => ConversationCommand::Bind { thread_id: r.bytes()? },
            CMD_DRAIN => ConversationCommand::Drain,
            _ => return Err(DecodeError("不認得的種類")),
        })
    })
}

pub fn encode_conversation_report(report: &ConversationReport) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match report {
        ConversationReport::Hello { version } => {
            w.u8(REP_HELLO);
            w.u32(*version);
        }
        ConversationReport::Ready => w.u8(REP_READY),
        ConversationReport::Bound { thread_id } => {
            w.u8(REP_BOUND);
            w.bytes(thread_id);
        }
        ConversationReport::Turn { phase } => {
            w.u8(REP_TURN);
            w.u8(*phase as u8);
        }
        ConversationReport::Idle { idle_ms } => {
            w.u8(REP_IDLE);
            w.u32(*idle_ms);
        }
        ConversationReport::Busy => w.u8(REP_BUSY),
        ConversationReport::Heartbeat => w.u8(REP_HEARTBEAT),
        ConversationReport::Drained => w.u8(REP_DRAINED),
    }
    w.0
}

pub fn decode_conversation_report(payload: &[u8]) -> Result<ConversationReport, DecodeError> {
    decoded(Reader { buf: payload }, |r, kind| {
        Ok(match kind {
            REP_HELLO => ConversationReport::Hello { version: r.u32()? },
            REP_READY => ConversationReport::Ready,
            REP_BOUND => ConversationReport::Bound { thread_id: r.bytes()? },
            REP_TURN => ConversationReport::Turn {
                phase: match r.u8()? {
                    0 => TurnPhase::Begin,
                    1 => TurnPhase::End,
                    _ => return Err(DecodeError("不認得的一輪階段")),
                },
            },
            REP_IDLE => ConversationReport::Idle { idle_ms: r.u32()? },
            REP_BUSY => ConversationReport::Busy,
            REP_HEARTBEAT => ConversationReport::Heartbeat,
            REP_DRAINED => ConversationReport::Drained,
            _ => return Err(DecodeError("不認得的種類")),
        })
    })
}

pub fn encode_front_request(request: &FrontRequest) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match request {
        FrontRequest::Hello { version } => {
            w.u8(REQ_HELLO);
            w.u32(*version);
        }
        FrontRequest::AdmissionStopped => w.u8(REQ_ADMISSION_STOPPED),
        FrontRequest::Ensure { thread_id, open } => {
            w.u8(REQ_ENSURE);
            w.bytes(thread_id);
            w.u8(*open as u8);
        }
        FrontRequest::Release { thread_id } => {
            w.u8(REQ_RELEASE);
            w.bytes(thread_id);
        }
    }
    w.0
}

pub fn decode_front_request(payload: &[u8]) -> Result<FrontRequest, DecodeError> {
    decoded(Reader { buf: payload }, |r, kind| {
        Ok(match kind {
            REQ_HELLO => FrontRequest::Hello { version: r.u32()? },
            REQ_ADMISSION_STOPPED => FrontRequest::AdmissionStopped,
            REQ_ENSURE => FrontRequest::Ensure {
                thread_id: r.bytes()?,
                open: match r.u8()? {
                    0 => OpenMode::Run,
                    1 => OpenMode::ReadOnly,
                    _ => return Err(DecodeError("不認得的打開方式")),
                },
            },
            REQ_RELEASE => FrontRequest::Release { thread_id: r.bytes()? },
            _ => return Err(DecodeError("不認得的種類")),
        })
    })
}

pub fn encode_front_event(event: &FrontEvent) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match event {
        FrontEvent::Hello { version, token } => {
            w.u8(EV_HELLO);
            w.u32(*version);
            w.bytes(token);
        }
        FrontEvent::StopAdmission => w.u8(EV_STOP_ADMISSION),
        FrontEvent::Up { thread_id, socket } => {
            w.u8(EV_UP);
            w.bytes(thread_id);
            w.bytes(socket);
        }
        FrontEvent::Down { thread_id, cause } => {
            w.u8(EV_DOWN);
            w.bytes(thread_id);
            w.u8(*cause as u8);
        }
        FrontEvent::Capacity { thread_id, current, limit } => {
            w.u8(EV_CAPACITY);
            w.bytes(thread_id);
            w.u32(*current);
            w.u32(*limit);
        }
        FrontEvent::Stats { live, warm, rss_kib, deaths } => {
            w.u8(EV_STATS);
            w.u32(*live);
            w.u32(*warm);
            w.u32(*rss_kib);
            for count in deaths {
                w.u32(*count);
            }
        }
    }
    w.0
}

pub fn decode_front_event(payload: &[u8]) -> Result<FrontEvent, DecodeError> {
    decoded(Reader { buf: payload }, |r, kind| {
        Ok(match kind {
            EV_HELLO => FrontEvent::Hello { version: r.u32()?, token: r.bytes()? },
            EV_STOP_ADMISSION => FrontEvent::StopAdmission,
            EV_UP => FrontEvent::Up { thread_id: r.bytes()?, socket: r.bytes()? },
            EV_DOWN => FrontEvent::Down {
                thread_id: r.bytes()?,
                cause: DeathCause::from_u8(r.u8()?).ok_or(DecodeError("不認得的死因"))?,
            },
            EV_CAPACITY => FrontEvent::Capacity { thread_id: r.bytes()?, current: r.u32()?, limit: r.u32()? },
            EV_STATS => {
                let (live, warm, rss_kib) = (r.u32()?, r.u32()?, r.u32()?);
                let mut deaths = [0; DEATH_CAUSES];
                for count in &mut deaths {
                    *count = r.u32()?;
                }
                FrontEvent::Stats { live, warm, rss_kib, deaths }
            }
            _ => return Err(DecodeError("不認得的種類")),
        })
    })
}

pub fn encode_host_command(command: &HostCommand) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match command {
        HostCommand::Hello { version } => {
            w.u8(HCMD_HELLO);
            w.u32(*version);
        }
        HostCommand::Grant { pid, token, role, thread } => {
            w.u8(HCMD_GRANT);
            w.u32(*pid);
            w.bytes(token);
            w.u8(*role as u8);
            w.bytes(thread);
        }
        HostCommand::Revoke { pid } => {
            w.u8(HCMD_REVOKE);
            w.u32(*pid);
        }
    }
    w.0
}

pub fn decode_host_command(payload: &[u8]) -> Result<HostCommand, DecodeError> {
    decoded(Reader { buf: payload }, |r, kind| {
        Ok(match kind {
            HCMD_HELLO => HostCommand::Hello { version: r.u32()? },
            HCMD_GRANT => HostCommand::Grant {
                pid: r.u32()?,
                token: r.bytes()?,
                role: match r.u8()? {
                    0 => Role::Front,
                    1 => Role::Conversation,
                    _ => return Err(DecodeError("不認得的角色")),
                },
                thread: r.bytes()?,
            },
            HCMD_REVOKE => HostCommand::Revoke { pid: r.u32()? },
            _ => return Err(DecodeError("不認得的種類")),
        })
    })
}

pub fn encode_host_report(report: &HostReport) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match report {
        HostReport::Hello { version } => {
            w.u8(HREP_HELLO);
            w.u32(*version);
        }
        HostReport::Ready => w.u8(HREP_READY),
        HostReport::Violation { pid, reason } => {
            w.u8(HREP_VIOLATION);
            w.u32(*pid);
            w.bytes(reason);
        }
        HostReport::Unregistered { pid, conn } => {
            w.u8(HREP_UNREGISTERED);
            w.u32(*pid);
            w.u32(*conn);
        }
    }
    w.0
}

pub fn decode_host_report(payload: &[u8]) -> Result<HostReport, DecodeError> {
    decoded(Reader { buf: payload }, |r, kind| {
        Ok(match kind {
            HREP_HELLO => HostReport::Hello { version: r.u32()? },
            HREP_READY => HostReport::Ready,
            HREP_VIOLATION => HostReport::Violation { pid: r.u32()?, reason: r.bytes()? },
            HREP_UNREGISTERED => HostReport::Unregistered { pid: r.u32()?, conn: r.u32()? },
            _ => return Err(DecodeError("不認得的種類")),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const VECTORS: &str = include_str!("../supervisor-vectors.json");

    /// `supervisor-vectors.json` 每一組依序的 `hex`，Node 端對同一份測。用字串切的：組內的值不能含 `]`，也不能含 `"hex": "`。
    fn vectors(group: &str) -> Vec<Vec<u8>> {
        let start = VECTORS.find(&format!("\"{group}\"")).unwrap();
        let section = &VECTORS[start..];
        let section = &section[..section.find(']').map_or(section.len(), |end| end)];
        section
            .split("\"hex\": \"")
            .skip(1)
            .map(|rest| {
                let hex = &rest[..rest.find('"').unwrap()];
                (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
            })
            .collect()
    }

    const T: &[u8] = b"0c4f1c8e-thread";
    const TOKEN: &[u8] = b"00112233445566778899aabbccddeeff";

    fn commands() -> Vec<ConversationCommand> {
        vec![
            ConversationCommand::Hello { version: PROTOCOL_VERSION, token: TOKEN.to_vec() },
            ConversationCommand::Bind { thread_id: T.to_vec() },
            ConversationCommand::Bind { thread_id: "é\n\t".as_bytes().to_vec() },
            ConversationCommand::Drain,
        ]
    }

    fn reports() -> Vec<ConversationReport> {
        vec![
            ConversationReport::Hello { version: PROTOCOL_VERSION },
            ConversationReport::Ready,
            ConversationReport::Bound { thread_id: T.to_vec() },
            ConversationReport::Turn { phase: TurnPhase::Begin },
            ConversationReport::Turn { phase: TurnPhase::End },
            ConversationReport::Idle { idle_ms: 0 },
            ConversationReport::Idle { idle_ms: u32::MAX },
            ConversationReport::Busy,
            ConversationReport::Heartbeat,
            ConversationReport::Drained,
        ]
    }

    fn requests() -> Vec<FrontRequest> {
        vec![
            FrontRequest::Hello { version: PROTOCOL_VERSION },
            FrontRequest::AdmissionStopped,
            FrontRequest::Ensure { thread_id: T.to_vec(), open: OpenMode::Run },
            FrontRequest::Ensure { thread_id: Vec::new(), open: OpenMode::ReadOnly },
            FrontRequest::Release { thread_id: T.to_vec() },
        ]
    }

    const CAUSES: [DeathCause; DEATH_CAUSES] = [
        DeathCause::Heap,
        DeathCause::Memory,
        DeathCause::HostOom,
        DeathCause::Stalled,
        DeathCause::Crash,
        DeathCause::Evicted,
        DeathCause::Shutdown,
        DeathCause::Protocol,
    ];

    fn events() -> Vec<FrontEvent> {
        let mut events = vec![
            FrontEvent::Hello { version: PROTOCOL_VERSION, token: TOKEN.to_vec() },
            FrontEvent::StopAdmission,
            FrontEvent::Up { thread_id: T.to_vec(), socket: b"/run/nexus/s-0700/thread a.sock".to_vec() },
        ];
        events.extend(CAUSES.map(|cause| FrontEvent::Down { thread_id: T.to_vec(), cause }));
        events.push(FrontEvent::Capacity { thread_id: T.to_vec(), current: 156, limit: 155 });
        events.push(FrontEvent::Stats { live: 3, warm: 1, rss_kib: u32::MAX, deaths: [1, 2, 3, 4, 5, 6, 7, 8] });
        events
    }

    fn host_commands() -> Vec<HostCommand> {
        vec![
            HostCommand::Hello { version: PROTOCOL_VERSION },
            HostCommand::Grant { pid: 4242, token: TOKEN.to_vec(), role: Role::Front, thread: Vec::new() },
            HostCommand::Grant { pid: u32::MAX, token: TOKEN.to_vec(), role: Role::Conversation, thread: T.to_vec() },
            HostCommand::Revoke { pid: 4242 },
        ]
    }

    fn host_reports() -> Vec<HostReport> {
        vec![
            HostReport::Hello { version: PROTOCOL_VERSION },
            HostReport::Ready,
            HostReport::Violation { pid: 4242, reason: "框太大".as_bytes().to_vec() },
            HostReport::Unregistered { pid: 4242, conn: 7 },
        ]
    }

    /// `cases` 要跟向量檔同一組同一順序，數量也要相等。
    fn check<T: PartialEq + std::fmt::Debug>(
        group: &str,
        cases: &[T],
        encode: fn(&T) -> Vec<u8>,
        decode: fn(&[u8]) -> Result<T, DecodeError>,
    ) {
        let vectors = vectors(group);
        assert_eq!(vectors.len(), cases.len(), "{group} 的向量數");
        for (case, bytes) in cases.iter().zip(&vectors) {
            assert_eq!(&encode(case), bytes, "{case:?}");
            assert_eq!(decode(bytes).as_ref(), Ok(case));
        }
    }

    #[test]
    fn the_shared_vectors_match_both_directions() {
        check("conversationCommands", &commands(), encode_conversation_command, decode_conversation_command);
        check("conversationReports", &reports(), encode_conversation_report, decode_conversation_report);
        check("frontRequests", &requests(), encode_front_request, decode_front_request);
        check("frontEvents", &events(), encode_front_event, decode_front_event);
        check("hostCommands", &host_commands(), encode_host_command, decode_host_command);
        check("hostReports", &host_reports(), encode_host_report, decode_host_report);
    }

    #[test]
    fn the_protocol_version_matches_the_vector_file() {
        let key = "\"protocolVersion\": ";
        let at = VECTORS.find(key).unwrap() + key.len();
        let digits: String = VECTORS[at..].chars().take_while(char::is_ascii_digit).collect();
        assert_eq!(digits.parse::<u32>().unwrap(), PROTOCOL_VERSION);
    }

    /// 這裡列出的每個種類 byte、每一類死因都要有向量。清單是手寫的，新增種類要同時加進來（TS 那一側由型別強制）。
    #[test]
    fn every_kind_and_cause_has_a_vector() {
        let kinds = |group: &str| vectors(group).iter().map(|v| v[0]).collect::<std::collections::BTreeSet<u8>>();
        let expect = |group: &str, all: &[u8]| assert_eq!(kinds(group), all.iter().copied().collect(), "{group}");
        expect("conversationCommands", &[CMD_HELLO, CMD_BIND, CMD_DRAIN]);
        expect(
            "conversationReports",
            &[REP_HELLO, REP_READY, REP_BOUND, REP_TURN, REP_IDLE, REP_BUSY, REP_HEARTBEAT, REP_DRAINED],
        );
        expect("frontRequests", &[REQ_HELLO, REQ_ADMISSION_STOPPED, REQ_ENSURE, REQ_RELEASE]);
        expect("frontEvents", &[EV_HELLO, EV_STOP_ADMISSION, EV_UP, EV_DOWN, EV_CAPACITY, EV_STATS]);
        expect("hostCommands", &[HCMD_HELLO, HCMD_GRANT, HCMD_REVOKE]);
        expect("hostReports", &[HREP_HELLO, HREP_READY, HREP_VIOLATION, HREP_UNREGISTERED]);
        let downs: Vec<DeathCause> = events()
            .into_iter()
            .filter_map(|e| match e {
                FrontEvent::Down { cause, .. } => Some(cause),
                _ => None,
            })
            .collect();
        assert_eq!(downs, CAUSES);
        for (code, cause) in (1u8..).zip(CAUSES) {
            assert_eq!(cause as u8, code);
            assert_eq!(DeathCause::from_u8(code), Some(cause));
        }
    }

    const DECODERS: [(&str, fn(&[u8]) -> bool); 6] = [
        ("conversationCommands", |b| decode_conversation_command(b).is_ok()),
        ("conversationReports", |b| decode_conversation_report(b).is_ok()),
        ("frontRequests", |b| decode_front_request(b).is_ok()),
        ("frontEvents", |b| decode_front_event(b).is_ok()),
        ("hostCommands", |b| decode_host_command(b).is_ok()),
        ("hostReports", |b| decode_host_report(b).is_ok()),
    ];

    #[test]
    fn kind_bytes_do_not_repeat_across_directions() {
        let all = [
            CMD_HELLO, CMD_BIND, CMD_DRAIN, REP_HELLO, REP_READY, REP_BOUND, REP_TURN, REP_IDLE, REP_BUSY, REP_HEARTBEAT,
            REP_DRAINED, REQ_HELLO, REQ_ADMISSION_STOPPED, REQ_ENSURE, REQ_RELEASE, EV_HELLO, EV_STOP_ADMISSION, EV_UP,
            EV_DOWN, EV_CAPACITY, EV_STATS, HCMD_HELLO, HCMD_GRANT, HCMD_REVOKE, HREP_HELLO, HREP_READY, HREP_VIOLATION,
        ];
        assert_eq!(all.iter().collect::<std::collections::BTreeSet<_>>().len(), all.len());
        // 送錯方向的框：每一組的每一則，其他五支解碼器都不收。
        for (group, _) in DECODERS {
            for bytes in vectors(group) {
                for (other, accepts) in DECODERS {
                    assert_eq!(accepts(&bytes), group == other, "{group} 的 {bytes:02x?} 給 {other}");
                }
            }
        }
    }

    #[test]
    fn truncated_trailing_or_unknown_input_is_rejected() {
        for (group, accepts) in DECODERS {
            for bytes in vectors(group) {
                for cut in 0..bytes.len() {
                    assert!(!accepts(&bytes[..cut]), "{group} 截在 {cut}");
                }
                let mut extra = bytes.clone();
                extra.push(0);
                assert!(!accepts(&extra), "{group} 多一個 byte");
            }
            assert!(!accepts(b"Z"), "{group}");
        }
        let turn = encode_conversation_report(&ConversationReport::Turn { phase: TurnPhase::End });
        assert_eq!(decode_conversation_report(&[turn[0], 2]), Err(DecodeError("不認得的一輪階段")));
        let mut ensure = encode_front_request(&FrontRequest::Ensure { thread_id: Vec::new(), open: OpenMode::Run });
        *ensure.last_mut().unwrap() = 2;
        assert_eq!(decode_front_request(&ensure), Err(DecodeError("不認得的打開方式")));
        for code in [0, DEATH_CAUSES as u8 + 1, u8::MAX] {
            let mut down = encode_front_event(&FrontEvent::Down { thread_id: Vec::new(), cause: DeathCause::Heap });
            *down.last_mut().unwrap() = code;
            assert_eq!(decode_front_event(&down), Err(DecodeError("不認得的死因")));
        }
        let mut grant = encode_host_command(&HostCommand::Grant { pid: 1, token: Vec::new(), role: Role::Front, thread: Vec::new() });
        grant[9] = 2;
        assert_eq!(decode_host_command(&grant), Err(DecodeError("不認得的角色")));
    }

    /// 每一個合法向量逐 byte 截斷、逐位元翻轉：解碼器只回 `Ok` 或 `Err`，不 panic（panic 會讓這條測試失敗）。
    /// 翻轉後解得開的，重新編碼要得回同一串 bytes：解碼器不會把兩種輸入讀成同一個值。
    #[test]
    fn every_truncation_and_bit_flip_decodes_without_panicking() {
        fn roundtrip<T>(bytes: &[u8], decode: fn(&[u8]) -> Result<T, DecodeError>, encode: fn(&T) -> Vec<u8>) {
            if let Ok(value) = decode(bytes) {
                assert_eq!(encode(&value), bytes, "{bytes:02x?}");
            }
        }
        let codecs: [(&str, fn(&[u8])); 6] = [
            ("conversationCommands", |b| roundtrip(b, decode_conversation_command, encode_conversation_command)),
            ("conversationReports", |b| roundtrip(b, decode_conversation_report, encode_conversation_report)),
            ("frontRequests", |b| roundtrip(b, decode_front_request, encode_front_request)),
            ("frontEvents", |b| roundtrip(b, decode_front_event, encode_front_event)),
            ("hostCommands", |b| roundtrip(b, decode_host_command, encode_host_command)),
            ("hostReports", |b| roundtrip(b, decode_host_report, encode_host_report)),
        ];
        let mut tried = 0;
        for (group, run) in codecs {
            for bytes in vectors(group) {
                for cut in 0..=bytes.len() {
                    run(&bytes[..cut]);
                    tried += 1;
                }
                for bit in 0..bytes.len() * 8 {
                    let mut flipped = bytes.clone();
                    flipped[bit / 8] ^= 1 << (bit % 8);
                    run(&flipped);
                    tried += 1;
                }
            }
        }
        assert!(tried > 1000, "{tried}");
    }
}
