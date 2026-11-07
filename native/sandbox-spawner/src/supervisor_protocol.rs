//! 監督行程的控制面（[#1947](https://github.com/DemianLi/nexus-agent/issues/1947)，設計
//! `.docs/supervisor-1947-design-2026-11-03.md` §五）：監督行程與它起的兩種 Node 行程（每條對話一個的對話行程、一個前台）之間的訊息。
//! 這裡只定每則訊息的格式與意思（含哪一則回答哪一則）；什麼時候送、收到後怎麼處置，屬於監督行程（#2340）與兩種 Node 行程
//! （對話行程 #2338、前台 #2341）。
//!
//! 框與欄位同 spawner 的控制通道（[`crate::protocol`] 的檔頭）：`u32 LE 長度` 接著內容，內容第一個 byte 是種類；數字是 `u32 LE`，
//! 字串是 `u32 LE 長度 + UTF-8 bytes`，列舉是一個 byte。送端只送 UTF-8；這裡照 bytes 收、不驗，TS 端解到壞序列換成 U+FFFD、不丟錯。資料（對話本身的請求與回應）不經這裡，前台直接連對話行程的 socket。
//!
//! 兩條通道、四個方向，各有一組種類 byte、各自一支解碼器。**種類 byte 在四個方向之間不重複**：大寫是送給監督行程的，小寫是監督行程送出的。
//! 這兩條通道之間送錯通道或方向時，解碼器回「不認得的種類」，不會把它當成另一則形狀相同的訊息。跟 spawner 控制通道的種類 byte
//! 有重疊（`R`、`E`），那條通道的框送到這裡不在保證內。
//!
//! `decode_*` 遇到截斷、框尾多餘、不認得的種類或列舉碼都回 [`DecodeError`]；`encode_*` 不會失敗。
//!
//! 時間只送相對值：兩個行程的時鐘不同源，監督行程用自己的單調時鐘記收到的時間點。

use crate::protocol::{DecodeError, Reader, Writer};

/// 監督行程 → 對話行程。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConversationCommand {
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
    /// 要這條 thread 的對話行程；監督行程回 [`FrontEvent::Up`]、[`FrontEvent::Down`] 或 [`FrontEvent::Capacity`]。
    Ensure { thread_id: Vec<u8>, open: OpenMode },
    /// 前台用完了（例如讀完歷史），這條 thread 的行程可以先收。只收只讀開啟的；已經轉成一般的（收到過 `ensure(run)` 或 `turn(begin)`）不理，照閒置時限收。
    Release { thread_id: Vec<u8> },
}

/// 對話行程為什麼結束（設計 §6-2 的七類）。碼從 1 起，[`FrontEvent::Stats`] 的 `deaths` 依碼的順序排。
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
}

/// 死因的種數，也是 [`FrontEvent::Stats`] 的 `deaths` 的長度。
pub const DEATH_CAUSES: usize = 7;

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
            _ => return None,
        })
    }
}

/// 監督行程 → 前台。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FrontEvent {
    /// 這條 thread 的對話行程在 `socket` 上聽，前台直接連。
    Up { thread_id: Vec<u8>, socket: Vec<u8> },
    /// 這條 thread 的對話行程結束了，或沒起成（`Crash`）。
    Down { thread_id: Vec<u8>, cause: DeathCause },
    /// 名額滿、沒有可逐出的，這條 thread 沒起：前台回 `thread_at_capacity`。`current` 含預熱池與起動中的行程。
    Capacity { thread_id: Vec<u8>, current: u32, limit: u32 },
    /// 給前台的 `/metrics`：活著的對話行程數（含預熱池）、預熱池的大小、全部對話行程 RSS 的合計（KiB），與各類死因的累計。
    Stats { live: u32, warm: u32, rss_kib: u32, deaths: [u32; DEATH_CAUSES] },
}

const CMD_BIND: u8 = b'b';
const CMD_DRAIN: u8 = b'd';
const REP_READY: u8 = b'R';
const REP_BOUND: u8 = b'B';
const REP_TURN: u8 = b'T';
const REP_IDLE: u8 = b'I';
const REP_BUSY: u8 = b'Y';
const REP_HEARTBEAT: u8 = b'H';
const REP_DRAINED: u8 = b'D';
const REQ_ENSURE: u8 = b'E';
const REQ_RELEASE: u8 = b'L';
const EV_UP: u8 = b'u';
const EV_DOWN: u8 = b'x';
const EV_CAPACITY: u8 = b'c';
const EV_STATS: u8 = b'm';

fn decoded<T>(mut r: Reader<'_>, read: impl FnOnce(&mut Reader<'_>, u8) -> Result<T, DecodeError>) -> Result<T, DecodeError> {
    let kind = r.u8()?;
    let value = read(&mut r, kind)?;
    r.end()?;
    Ok(value)
}

pub fn encode_conversation_command(command: &ConversationCommand) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match command {
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
            CMD_BIND => ConversationCommand::Bind { thread_id: r.bytes()? },
            CMD_DRAIN => ConversationCommand::Drain,
            _ => return Err(DecodeError("不認得的種類")),
        })
    })
}

pub fn encode_conversation_report(report: &ConversationReport) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match report {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// `supervisor-vectors.json` 每一組依序的 `hex`，Node 端對同一份測。用字串切的：組內的值不能含 `]`，也不能含 `"hex": "`。
    fn vectors(group: &str) -> Vec<Vec<u8>> {
        let json = include_str!("../supervisor-vectors.json");
        let start = json.find(&format!("\"{group}\"")).unwrap();
        let section = &json[start..];
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

    fn commands() -> Vec<ConversationCommand> {
        vec![
            ConversationCommand::Bind { thread_id: T.to_vec() },
            ConversationCommand::Bind { thread_id: "é\n\t".as_bytes().to_vec() },
            ConversationCommand::Drain,
        ]
    }

    fn reports() -> Vec<ConversationReport> {
        vec![
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
    ];

    fn events() -> Vec<FrontEvent> {
        let mut events = vec![FrontEvent::Up { thread_id: T.to_vec(), socket: b"/run/nexus/s-0700/thread a.sock".to_vec() }];
        events.extend(CAUSES.map(|cause| FrontEvent::Down { thread_id: T.to_vec(), cause }));
        events.push(FrontEvent::Capacity { thread_id: T.to_vec(), current: 156, limit: 155 });
        events.push(FrontEvent::Stats { live: 3, warm: 1, rss_kib: u32::MAX, deaths: [1, 2, 3, 4, 5, 6, 7] });
        events
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
    }

    /// 這裡列出的每個種類 byte、每一類死因都要有向量。清單是手寫的，新增種類要同時加進來（TS 那一側由型別強制）。
    #[test]
    fn every_kind_and_cause_has_a_vector() {
        let kinds = |group: &str| vectors(group).iter().map(|v| v[0]).collect::<std::collections::BTreeSet<u8>>();
        let expect = |group: &str, all: &[u8]| assert_eq!(kinds(group), all.iter().copied().collect(), "{group}");
        expect("conversationCommands", &[CMD_BIND, CMD_DRAIN]);
        expect("conversationReports", &[REP_READY, REP_BOUND, REP_TURN, REP_IDLE, REP_BUSY, REP_HEARTBEAT, REP_DRAINED]);
        expect("frontRequests", &[REQ_ENSURE, REQ_RELEASE]);
        expect("frontEvents", &[EV_UP, EV_DOWN, EV_CAPACITY, EV_STATS]);
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

    #[test]
    fn kind_bytes_do_not_repeat_across_directions() {
        let all = [
            CMD_BIND, CMD_DRAIN, REP_READY, REP_BOUND, REP_TURN, REP_IDLE, REP_BUSY, REP_HEARTBEAT, REP_DRAINED, REQ_ENSURE,
            REQ_RELEASE, EV_UP, EV_DOWN, EV_CAPACITY, EV_STATS,
        ];
        assert_eq!(all.iter().collect::<std::collections::BTreeSet<_>>().len(), all.len());
        // 送錯方向的框：每一組的每一則，其他三支解碼器都不收。
        let decoders: [(&str, fn(&[u8]) -> bool); 4] = [
            ("conversationCommands", |b| decode_conversation_command(b).is_ok()),
            ("conversationReports", |b| decode_conversation_report(b).is_ok()),
            ("frontRequests", |b| decode_front_request(b).is_ok()),
            ("frontEvents", |b| decode_front_event(b).is_ok()),
        ];
        for (group, _) in decoders {
            for bytes in vectors(group) {
                for (other, accepts) in decoders {
                    assert_eq!(accepts(&bytes), group == other, "{group} 的 {bytes:02x?} 給 {other}");
                }
            }
        }
    }

    #[test]
    fn truncated_trailing_or_unknown_input_is_rejected() {
        let decoders: [(&str, fn(&[u8]) -> bool); 4] = [
            ("conversationCommands", |b| decode_conversation_command(b).is_ok()),
            ("conversationReports", |b| decode_conversation_report(b).is_ok()),
            ("frontRequests", |b| decode_front_request(b).is_ok()),
            ("frontEvents", |b| decode_front_event(b).is_ok()),
        ];
        for (group, accepts) in decoders {
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
        for code in [0, 8, u8::MAX] {
            let mut down = encode_front_event(&FrontEvent::Down { thread_id: Vec::new(), cause: DeathCause::Heap });
            *down.last_mut().unwrap() = code;
            assert_eq!(decode_front_event(&down), Err(DecodeError("不認得的死因")));
        }
    }
}
