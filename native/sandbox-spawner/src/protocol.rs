//! 控制通道的格式：spawner 的 stdin 收要求、stdout 送事件，兩個方向都是一筆一框。
//!
//! 框：`u32 LE 長度` 接著那麼多 bytes 的內容。內容第一個 byte 是種類，其餘是欄位：
//! 數字一律 `u32 LE`（有號的值照二補數存），字串與位元組串是 `u32 LE 長度 + bytes`，清單是 `u32 LE 個數 + 每一項`。
//! 不用分隔字元，所以參數、路徑、環境變數裡的任何 byte（含 tab、換行）都原樣送到。只有 NUL 例外：argv、env、cwd 含 NUL
//! 回 `Protocol`；授權路徑含 NUL 開不起來，回 `SandboxUnavailable`。

/// 一框最多多大。超過就當成通道壞掉，spawner 結束。
pub const MAX_FRAME: usize = 1 << 20;

/// 檔案效果政策。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    ReadOnly,
    WorkspaceWrite,
    /// 不上 Landlock，讀根、寫根都不看；seccomp 照樣繼承（網路照擋）。Landlock 是 none 時只有這個模式起得來。
    FullAccess,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spawn {
    pub id: u32,
    pub mode: Mode,
    /// 第 i 位元是 1：fd i 接 Node 連進來的那條連線；是 0：接 `/dev/null`。
    pub pipes: u8,
    /// 子行程的工作目錄。
    pub cwd: Vec<u8>,
    /// 讀得到（含執行）的根。spawner 不帶固定清單，由 Node 決定。
    pub readable: Vec<Vec<u8>>,
    /// 寫得進去的根。`read-only` 時 spawner 不看這一份。`/dev/null` 一律可寫，不必列。
    pub writable: Vec<Vec<u8>>,
    pub argv: Vec<Vec<u8>>,
    /// `NAME=value`。子行程的環境就是這一份，不繼承 spawner 自己的。
    pub env: Vec<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Spawn(Spawn),
    /// 送訊號給整個行程群組。不回任何事件：id 不認得、已經 `Failed` 或已經結束都靜靜忽略；
    /// 要求已到、還沒讀到 exec 結果時（含還在等 stdio 連線）先排著，讀到 exec 成功之後、送 `Started` 之前送出。
    Signal { id: u32, signo: i32 },
}

/// 沒起成的原因。種類讓 Node 不必解析文字就能分流：沙箱不可用要照 fail-closed 處理，跟工具自己起不來不能混在同一條判斷。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FailKind {
    /// Landlock 不能用（none，而要求不是 `FullAccess`）、設不上，或授權的路徑打不開（不默默縮小授權）：`SANDBOX_UNAVAILABLE`。
    SandboxUnavailable = 1,
    /// 工作目錄不存在或進不去。跟沙箱無關，要另外說（#1945）。
    StartDir = 2,
    /// execve 失敗，`errno` 帶原因（找不到、沒有執行權限、格式不對……）。
    Exec = 3,
    /// 要求本身不成立：id 重複、argv 或 argv[0] 空的、argv／env／cwd 含 NUL、env 不是 `NAME=value`、
    /// 連進來的 stdio 不在要求裡、等不到 stdio 連線。
    Protocol = 4,
    /// 其餘沒起成的情形：fork、pipe 這類資源用盡；子行程起來時 spawner 已經不在；還在等 stdio 連線時 spawner 就結束了；
    /// 子行程的失敗紀錄看不懂。
    Resource = 5,
}

impl FailKind {
    pub fn from_u8(v: u8) -> Option<FailKind> {
        Some(match v {
            1 => FailKind::SandboxUnavailable,
            2 => FailKind::StartDir,
            3 => FailKind::Exec,
            4 => FailKind::Protocol,
            5 => FailKind::Resource,
            _ => return None,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    /// spawner 起不來：啟動的任何一步失敗（signalfd、監聽 socket、seccomp、自我檢查）。送完這一框 spawner 就結束，
    /// 之後 Node 對每個工具子行程都回 `SANDBOX_UNAVAILABLE`。
    Unavailable { errno: i32, detail: Vec<u8> },
    /// spawner 準備好了：過濾器裝好、自我檢查通過。帶上過濾器的指令數與 Landlock 的 ABI 版本；版本是 0（none）時，
    /// 只有 `FullAccess` 的要求起得來，其餘回 `Failed`（`SandboxUnavailable`）。
    Ready { filter_insns: u32, landlock_abi: u32 },
    /// 已 exec。`partial` 是 Landlock 只部分生效（核心的 ABI 比要的舊）：照跑，由 Node 印通知。`FullAccess` 不上 Landlock，一律是 false。
    Started { id: u32, pid: u32, partial: bool },
    /// 沒 exec。`errno` 是失敗那一步的錯誤碼（沒有就是 0）。
    Failed { id: u32, kind: FailKind, errno: i32, detail: Vec<u8> },
    /// 結束。被訊號殺掉時 `code` 是 -1、`signal` 是訊號編號。spawner 關機時還在跑的也會送（被 SIGKILL；事件還寫得出去時）。
    Exited { id: u32, code: i32, signal: i32 },
}

const REQ_SPAWN: u8 = b'S';
const REQ_SIGNAL: u8 = b'K';
const EV_UNAVAILABLE: u8 = b'U';
const EV_READY: u8 = b'R';
const EV_STARTED: u8 = b'S';
const EV_FAILED: u8 = b'F';
const EV_EXITED: u8 = b'E';

#[derive(Debug, PartialEq, Eq)]
pub struct DecodeError(pub &'static str);

struct Reader<'a> {
    buf: &'a [u8],
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> Result<u8, DecodeError> {
        let (&b, rest) = self.buf.split_first().ok_or(DecodeError("截斷"))?;
        self.buf = rest;
        Ok(b)
    }

    fn u32(&mut self) -> Result<u32, DecodeError> {
        if self.buf.len() < 4 {
            return Err(DecodeError("截斷"));
        }
        let (head, rest) = self.buf.split_at(4);
        self.buf = rest;
        Ok(u32::from_le_bytes([head[0], head[1], head[2], head[3]]))
    }

    fn bytes(&mut self) -> Result<Vec<u8>, DecodeError> {
        let len = self.u32()? as usize;
        if self.buf.len() < len {
            return Err(DecodeError("截斷"));
        }
        let (head, rest) = self.buf.split_at(len);
        self.buf = rest;
        Ok(head.to_vec())
    }

    fn list(&mut self) -> Result<Vec<Vec<u8>>, DecodeError> {
        let count = self.u32()? as usize;
        // 每一項至少 4 bytes 的長度欄位：個數不可能比剩下的 bytes 還多，先擋掉免得配置一個巨大的 Vec。
        if count > self.buf.len() / 4 {
            return Err(DecodeError("清單個數超過內容"));
        }
        (0..count).map(|_| self.bytes()).collect()
    }

    fn end(&self) -> Result<(), DecodeError> {
        if self.buf.is_empty() {
            Ok(())
        } else {
            Err(DecodeError("多出來的 bytes"))
        }
    }
}

struct Writer(Vec<u8>);

impl Writer {
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn bytes(&mut self, v: &[u8]) {
        self.u32(v.len() as u32);
        self.0.extend_from_slice(v);
    }
    fn list(&mut self, v: &[Vec<u8>]) {
        self.u32(v.len() as u32);
        for item in v {
            self.bytes(item);
        }
    }
}

pub fn decode_request(payload: &[u8]) -> Result<Request, DecodeError> {
    let mut r = Reader { buf: payload };
    let request = match r.u8()? {
        REQ_SPAWN => {
            let id = r.u32()?;
            let mode = match r.u8()? {
                0 => Mode::ReadOnly,
                1 => Mode::WorkspaceWrite,
                2 => Mode::FullAccess,
                _ => return Err(DecodeError("不認得的模式")),
            };
            let pipes = r.u8()?;
            if pipes > 0b111 {
                return Err(DecodeError("stdio 位元超出 0..2"));
            }
            Request::Spawn(Spawn {
                id,
                mode,
                pipes,
                cwd: r.bytes()?,
                readable: r.list()?,
                writable: r.list()?,
                argv: r.list()?,
                env: r.list()?,
            })
        }
        REQ_SIGNAL => Request::Signal { id: r.u32()?, signo: r.u32()? as i32 },
        _ => return Err(DecodeError("不認得的要求")),
    };
    r.end()?;
    Ok(request)
}

pub fn encode_request(request: &Request) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match request {
        Request::Spawn(s) => {
            w.u8(REQ_SPAWN);
            w.u32(s.id);
            w.u8(match s.mode {
                Mode::ReadOnly => 0,
                Mode::WorkspaceWrite => 1,
                Mode::FullAccess => 2,
            });
            w.u8(s.pipes);
            w.bytes(&s.cwd);
            w.list(&s.readable);
            w.list(&s.writable);
            w.list(&s.argv);
            w.list(&s.env);
        }
        Request::Signal { id, signo } => {
            w.u8(REQ_SIGNAL);
            w.u32(*id);
            w.u32(*signo as u32);
        }
    }
    w.0
}

pub fn encode_event(event: &Event) -> Vec<u8> {
    let mut w = Writer(Vec::new());
    match event {
        Event::Unavailable { errno, detail } => {
            w.u8(EV_UNAVAILABLE);
            w.u32(*errno as u32);
            w.bytes(detail);
        }
        Event::Ready { filter_insns, landlock_abi } => {
            w.u8(EV_READY);
            w.u32(*filter_insns);
            w.u32(*landlock_abi);
        }
        Event::Started { id, pid, partial } => {
            w.u8(EV_STARTED);
            w.u32(*id);
            w.u32(*pid);
            w.u8(u8::from(*partial));
        }
        Event::Failed { id, kind, errno, detail } => {
            w.u8(EV_FAILED);
            w.u32(*id);
            w.u8(*kind as u8);
            w.u32(*errno as u32);
            w.bytes(detail);
        }
        Event::Exited { id, code, signal } => {
            w.u8(EV_EXITED);
            w.u32(*id);
            w.u32(*code as u32);
            w.u32(*signal as u32);
        }
    }
    w.0
}

pub fn decode_event(payload: &[u8]) -> Result<Event, DecodeError> {
    let mut r = Reader { buf: payload };
    let event = match r.u8()? {
        EV_UNAVAILABLE => Event::Unavailable { errno: r.u32()? as i32, detail: r.bytes()? },
        EV_READY => Event::Ready { filter_insns: r.u32()?, landlock_abi: r.u32()? },
        EV_STARTED => Event::Started { id: r.u32()?, pid: r.u32()?, partial: r.u8()? != 0 },
        EV_FAILED => {
            let id = r.u32()?;
            let kind = FailKind::from_u8(r.u8()?).ok_or(DecodeError("不認得的失敗種類"))?;
            Event::Failed { id, kind, errno: r.u32()? as i32, detail: r.bytes()? }
        }
        EV_EXITED => Event::Exited { id: r.u32()?, code: r.u32()? as i32, signal: r.u32()? as i32 },
        _ => return Err(DecodeError("不認得的事件")),
    };
    r.end()?;
    Ok(event)
}

/// 加上長度前綴。
pub fn frame(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// 從累積的輸入切出完整的框。框長超過 [`MAX_FRAME`] 回錯。
pub fn take_frame(buf: &mut Vec<u8>) -> Result<Option<Vec<u8>>, DecodeError> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_FRAME {
        return Err(DecodeError("框太大"));
    }
    if buf.len() < 4 + len {
        return Ok(None);
    }
    let payload = buf[4..4 + len].to_vec();
    buf.drain(..4 + len);
    Ok(Some(payload))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn() -> Spawn {
        Spawn {
            id: 7,
            mode: Mode::WorkspaceWrite,
            pipes: 0b110,
            cwd: b"/w/ws".to_vec(),
            readable: vec![b"/usr".to_vec()],
            writable: vec![b"/w/ws".to_vec(), b"/w/extra dir\twith tab".to_vec()],
            argv: vec![b"/usr/bin/rg".to_vec(), b"a\nb".to_vec(), Vec::new()],
            env: vec![b"PATH=/usr/bin".to_vec()],
        }
    }

    #[test]
    fn requests_round_trip_with_separator_bytes_inside_fields() {
        let modes = [Mode::ReadOnly, Mode::WorkspaceWrite, Mode::FullAccess].map(|mode| Request::Spawn(Spawn { mode, ..spawn() }));
        for request in modes.into_iter().chain([Request::Signal { id: 3, signo: libc::SIGTERM }]) {
            assert_eq!(decode_request(&encode_request(&request)), Ok(request));
        }
    }

    #[test]
    fn events_round_trip() {
        for event in [
            Event::Unavailable { errno: libc::ENOSYS, detail: b"landlock".to_vec() },
            Event::Ready { filter_insns: 70, landlock_abi: 5 },
            Event::Started { id: 1, pid: 4242, partial: true },
            Event::Failed { id: 2, kind: FailKind::StartDir, errno: libc::ENOENT, detail: b"chdir".to_vec() },
            Event::Exited { id: 3, code: -1, signal: libc::SIGKILL },
        ] {
            assert_eq!(decode_event(&encode_event(&event)), Ok(event));
        }
    }

    /// `protocol-vectors.json` 裡依序的 `hex`：Node 端的編解碼對同一份測。
    fn vectors() -> Vec<Vec<u8>> {
        include_str!("../protocol-vectors.json")
            .split("\"hex\": \"")
            .skip(1)
            .map(|rest| {
                let hex = &rest[..rest.find('"').unwrap()];
                (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
            })
            .collect()
    }

    #[test]
    fn the_shared_vectors_match_both_directions() {
        let s = |v: &str| v.as_bytes().to_vec();
        let requests = [
            Request::Spawn(Spawn {
                id: 7,
                mode: Mode::WorkspaceWrite,
                pipes: 0b110,
                cwd: s("/w/ws"),
                readable: vec![s("/usr"), s("/etc/gitconfig")],
                writable: vec![s("/w/ws"), s("/w/extra dir\twith tab")],
                argv: vec![s("/usr/bin/git"), s("a\nb"), Vec::new()],
                env: vec![s("PATH=/usr/bin"), s("LC_ALL=C")],
            }),
            Request::Spawn(Spawn {
                id: 8,
                mode: Mode::ReadOnly,
                pipes: 0b010,
                cwd: s("/"),
                readable: Vec::new(),
                writable: Vec::new(),
                argv: vec![s("rg")],
                env: Vec::new(),
            }),
            Request::Spawn(Spawn {
                id: u32::MAX,
                mode: Mode::FullAccess,
                pipes: 0,
                cwd: s("/tmp"),
                readable: Vec::new(),
                writable: Vec::new(),
                argv: vec![s("true")],
                env: vec![s("A=é")],
            }),
            Request::Signal { id: 3, signo: libc::SIGTERM },
        ];
        let events = [
            Event::Unavailable { errno: libc::EINVAL, detail: s("seccomp: Invalid argument") },
            Event::Ready { filter_insns: 70, landlock_abi: 0 },
            Event::Started { id: 1, pid: 4242, partial: true },
            Event::Failed { id: 2, kind: FailKind::StartDir, errno: libc::ENOENT, detail: s("chdir") },
            Event::Failed { id: 9, kind: FailKind::Resource, errno: libc::EMFILE, detail: s("open /dev/null") },
            Event::Exited { id: 3, code: -1, signal: libc::SIGKILL },
        ];
        let vectors = vectors();
        assert_eq!(vectors.len(), requests.len() + events.len());
        for (request, bytes) in requests.iter().zip(&vectors) {
            assert_eq!(&encode_request(request), bytes, "{request:?}");
            assert_eq!(decode_request(bytes).as_ref(), Ok(request));
        }
        for (event, bytes) in events.iter().zip(&vectors[requests.len()..]) {
            assert_eq!(&encode_event(event), bytes, "{event:?}");
            assert_eq!(decode_event(bytes).as_ref(), Ok(event));
        }
    }

    #[test]
    fn truncated_trailing_or_unknown_input_is_rejected() {
        let bytes = encode_request(&Request::Spawn(spawn()));
        for cut in 0..bytes.len() {
            assert!(decode_request(&bytes[..cut]).is_err(), "截在 {cut}");
        }
        let mut extra = bytes.clone();
        extra.push(0);
        assert!(decode_request(&extra).is_err());
        assert!(decode_request(b"Z").is_err());
        let mut bad_pipes = encode_request(&Request::Spawn(Spawn { pipes: 0, ..spawn() }));
        bad_pipes[6] = 0b1000;
        assert_eq!(decode_request(&bad_pipes), Err(DecodeError("stdio 位元超出 0..2")));
        let mut bad_mode = bytes.clone();
        bad_mode[5] = 3;
        assert_eq!(decode_request(&bad_mode), Err(DecodeError("不認得的模式")));
    }

    #[test]
    fn a_huge_list_count_does_not_allocate() {
        let mut w = Writer(Vec::new());
        w.u8(REQ_SPAWN);
        w.u32(1);
        w.u8(0);
        w.u8(0);
        w.bytes(b"/");
        w.u32(u32::MAX);
        assert_eq!(decode_request(&w.0), Err(DecodeError("清單個數超過內容")));
    }

    #[test]
    fn frames_are_split_from_a_byte_stream() {
        let a = frame(b"one");
        let b = frame(b"two!");
        let mut buf = [a.as_slice(), &b[..3]].concat();
        assert_eq!(take_frame(&mut buf), Ok(Some(b"one".to_vec())));
        assert_eq!(take_frame(&mut buf), Ok(None));
        buf.extend_from_slice(&b[3..]);
        assert_eq!(take_frame(&mut buf), Ok(Some(b"two!".to_vec())));
        assert!(buf.is_empty());
        let mut huge = ((MAX_FRAME + 1) as u32).to_le_bytes().to_vec();
        assert_eq!(take_frame(&mut huge), Err(DecodeError("框太大")));
    }
}
