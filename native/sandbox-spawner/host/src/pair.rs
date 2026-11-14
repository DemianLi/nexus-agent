//! 橋在組合行程那一端（#2583）：收連線、驗葉子的身分、記兩個方向還在跑的呼叫、背壓、收線。協定見 [`crate::pair_protocol`]。
//!
//! 不自己跑事件迴圈：擁有它的一方把 [`Pair::poll_fds`] 放進 poll、照 [`Pair::deadline`] 設時限，醒來就叫 [`Pair::step`] 拿上一次 `step` 之後累積的事
//! （[`PairEvent`]）。時間由呼叫的一方傳進來。[`Pair::set_leaf`] 與送出的幾個方法造成的事（斷線、收下等著的連線）也是下一次 `step` 才交出來，
//! 這時 [`Pair::deadline`] 回現在。
//!
//! - 監督行程給的葉子 pid 用 [`Pair::set_leaf`] 交進來。pid 還沒到就連進來的連線先留著，從收下它的那一次 `step` 起最多留
//!   [`PID_WAIT`]：監督行程同時起一對，葉子可能比 `leaf{pid}` 先到。
//! - 同時只有一條驗過的連線。它斷了之後 pid 作廢，要等下一次 [`Pair::set_leaf`] 才再收。
//! - 葉子發來的呼叫，還沒到 [`MAX_CALLS`]、`parent` 在跑、method 在 [`Pair::new`] 給的清單裡，才交給擁有的一方（[`PairEvent::Call`]），
//!   由它用 [`Pair::chunk`]、[`Pair::finish`] 回；不合的這裡直接回錯。
//!   葉子取消時這裡直接回 `cancelled`，之後再 `finish` 那一次不會送出任何東西。
//! - 葉子發來的呼叫，事件裡的 `id` 是這一端給的本地代號，不是線上的 `id`：整個 [`Pair`] 單調遞增、換了連線也不重用，
//!   所以擁有的一方手上晚到的舊工作再 [`Pair::chunk`]、[`Pair::finish`]，對不到任何東西，不會落進別的呼叫。
//! - 背壓照協定：排著的到了 [`OUTBOX_PAUSE`]，[`Pair::call`]、[`Pair::chunk`]、[`Pair::finish`] 回 [`SendError::Paused`]，什麼都沒送，
//!   擁有的一方留著，等 [`PairEvent::Resumed`] 再試；葉子送來的照讀照處理。這裡自動回的 `result`（`busy`、`unknown_method`、`bad_payload`、`cancelled`，都是小框）與 [`Pair::cancel`] 照排。
//! - 回了 `rejected` 的連線，那一框寫完只關寫的方向，對方送來的讀出來丟掉、不解框；要那一框寫完、而且對方關了或讀錯了才整條關，
//!   最多留 [`CLOSE_TIMEOUT`]，對方一直不讀的話那一框送不到。拒絕之前讀端已經被 `Chan` 關掉的（框太大、讀到 EOF 或讀錯），之後對方再送的不讀，那一框寫完就整條關。
//!   同時最多留 [`MAX_CLOSING`] 條，再來的把最舊的直接關掉。
//! - 葉子登記的名稱（[`PairEvent::Registered`]）這裡不記：[`PairEvent::Disconnected`] 之後由擁有的一方自己清。

use std::collections::HashMap;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixListener;
use std::time::{Duration, Instant};

use crate::host_protocol::{CallError, ErrorCode};
use crate::json::Value;
use crate::pair_protocol::{
    clip_method, decode, encode, CallRef, PairMessage, RejectCode, Side, MAX_CALLS,
    MAX_CHUNK_BYTES, MAX_FRAME, MAX_PENDING, METHOD_ATTACH, OUTBOX_LIMIT, OUTBOX_PAUSE,
    PAIR_PROTOCOL_VERSION, PID_WAIT, STALL_TIMEOUT,
};
use nexus_sandbox_spawner::supervisor::process::{Chan, READ_BUDGET};

/// 回了 `rejected` 的連線最多留多久：等那一框寫完、等對方關。對方送什麼來都不延長。
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// accept 出錯（開檔數用完之類）之後多久不看 listener：它會一直可讀，不停一下就空轉。排著的連線留在 backlog；
/// 已經收下、卻複製不出 fd 的那一條直接關掉，報一筆 [`PairEvent::Refused`]。
pub const ACCEPT_BACKOFF: Duration = Duration::from_millis(100);

/// 回了 `rejected`、還沒整條關掉的連線最多幾條；再來的把最舊的直接關掉。
const MAX_CLOSING: usize = MAX_PENDING;

/// 自己發的呼叫沒有成功的原因。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// 葉子回了錯。
    Error(CallError),
    /// 還沒回連線就斷了。
    PeerGone,
}

/// 驗過的連線為什麼斷。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Disconnect {
    /// 葉子關了連線，或讀寫出錯。
    Closed,
    /// 葉子違反協定。
    Violation(String),
    /// 葉子不讀：照排的框（[`Pair::cancel`]、這裡自動回的 `result`）再排一框就會超過 [`OUTBOX_LIMIT`]。
    Overflow,
    /// 葉子不讀：有東西排著，連續 [`STALL_TIMEOUT`] 一個位元組都沒寫出去。
    Stalled,
    /// 監督行程又給了一次葉子 pid（同一個號碼也算）。
    Replaced,
}

/// 這一端現在送不了的原因；都不動連線。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    NotConnected,
    /// 排著的到了 [`OUTBOX_PAUSE`]，什麼都沒送；等 [`PairEvent::Resumed`] 再試。
    Paused,
    /// 自己發的呼叫已經 [`MAX_CALLS`] 個。
    Busy,
    /// `call` 編出來超過一框：沒送、不佔編號。或一塊超過 [`MAX_CHUNK_BYTES`]：沒送，那一次呼叫已經以 `too_large` 收尾。
    TooLarge,
    /// `parent` 不在跑。
    BadParent,
    /// 那一次呼叫不在跑（結束了，或葉子取消了）。
    NotRunning,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairEvent {
    /// 葉子驗過了，可以發呼叫。
    Connected { pid: u32 },
    /// 葉子登記的名稱，整份取代上一次的。
    Registered {
        tools: Vec<String>,
        hooks: Vec<String>,
    },
    /// 葉子發來的呼叫。`id` 是本地代號；`parent` 是葉子發的那一邊時也是本地代號。
    Call {
        id: u64,
        parent: Option<CallRef>,
        method: String,
        payload: Value,
    },
    /// 葉子發來的那一次（本地代號）不用做了：它取消了，或連線斷了。
    Cancelled { id: u64 },
    /// 自己發的那一次，葉子串流來的一塊。
    Chunk { id: u64, seq: u64, payload: String },
    /// 自己發的那一次結束了。
    Finished {
        id: u64,
        outcome: Result<Value, Failure>,
    },
    /// 回過 [`SendError::Paused`] 之後，排著的降回 [`OUTBOX_PAUSE`] 以下了，可以再試。
    Resumed,
    /// 沒收一條連線。`pid` 讀不到是 `None`。`reason` 是給稽核看的。身分這一類先看 uid：uid 跟這一端不同是「uid 不同（那個 uid）」，
    /// 這時 pid 不是正數的話 `pid` 是 `None`；`SO_PEERCRED` 讀不到、或 uid 相同但 pid 不是正數，是「讀不到身分」。這兩種線上回的都是「身分不對」，不告訴對方是哪一種。
    Refused { pid: Option<u32>, reason: String },
    /// 驗過的那條斷了；在這之前，還在跑的呼叫各有一筆 [`PairEvent::Finished`] 或 [`PairEvent::Cancelled`]。
    Disconnected { reason: Disconnect },
}

/// 連上了、還沒驗過身分。
struct Pending {
    chan: Chan,
    pid: u32,
    opened: Instant,
    /// 它的 `hello` 帶的版本；還沒送是 `None`。
    hello: Option<u32>,
}

struct Conn {
    chan: Chan,
    /// 回過 [`SendError::Paused`]，還沒報 [`PairEvent::Resumed`]。
    refused: bool,
    /// 上一次 `step` 之後寫出過位元組。
    wrote: bool,
    /// 上一次 `step` 時有東西排著：從哪一步起沒再寫出過位元組。上一次 `step` 時沒有東西排著（或還沒有 `step` 看過）是 `None`。
    stalled_since: Option<Instant>,
    /// 自己發的、還沒收到 `result` 的：下一塊該是第幾塊。
    mine: HashMap<u64, u64>,
    /// 葉子發的、還沒回 `result` 的，照本地代號查。
    theirs: HashMap<u64, Their>,
    /// 葉子發的、還沒回 `result` 的：線上的 `id` 對到本地代號。
    wire: HashMap<u64, u64>,
}

struct Their {
    /// 線上的 `id`。
    wire: u64,
    /// 下一塊要送第幾塊。
    next: u64,
}

/// 回了 `rejected`、還沒整條關掉的連線。
struct Closing {
    chan: Chan,
    until: Instant,
    /// 寫端關了之後收尾過沒：讀端還開著的話，這時對 socket 關寫的方向。
    shut: bool,
    /// 不再讀：對方關了、讀錯了，或進來時讀端已經被 [`Chan`] 關掉。
    gone: bool,
}

impl Closing {
    /// 把排著的寫出去；寫完（或寫不進去）就關寫的方向。
    fn flush(&mut self) {
        self.chan.flush();
        if self.shut || !self.chan.write_closed() {
            return;
        }
        self.shut = true;
        // `Chan` 關寫端只丟掉它那個 fd，同一個 socket 的讀端還開著，對方讀不到 EOF。
        if let (Some(fd), _) = self.chan.poll_fds() {
            // SAFETY：fd 是這條通道還開著的讀端。
            unsafe { libc::shutdown(fd, libc::SHUT_WR) };
        }
    }

    /// 對方送來的讀出來丟掉，不解框，一次最多 [`READ_BUDGET`]。
    fn discard(&mut self) {
        if self.gone {
            return;
        }
        let _ = READ_BUDGET;
        if self.chan.receive().is_err() || self.chan.read_closed() {
            self.gone = true;
        }
    }

    /// 還要不要留著：還沒寫完就留；寫完（或寫不進去）之後留到不再讀為止。
    fn open(&self) -> bool {
        !self.gone || !self.chan.write_closed()
    }
}

impl Conn {
    fn paused(&self) -> bool {
        self.chan.queued() >= OUTBOX_PAUSE
    }

    /// 擁有的一方要發的先過這裡：到了暫停線就不送，並記下要報 [`PairEvent::Resumed`]。
    fn admit(&mut self) -> Result<(), SendError> {
        if self.paused() {
            self.refused = true;
            return Err(SendError::Paused);
        }
        Ok(())
    }

    fn flush(&mut self) {
        let before = self.chan.queued();
        self.chan.flush();
        self.wrote |= self.chan.queued() < before;
    }

    fn send(&mut self, payload: &[u8]) {
        let before = self.chan.queued() + payload.len() + 4;
        self.chan.send(payload);
        self.wrote |= self.chan.queued() < before;
    }

    /// 線上的呼叫換成這一端的說法；不在跑是 `None`。
    fn local(&self, call: CallRef) -> Option<CallRef> {
        let id = match call.side {
            Side::Composition => self.mine.contains_key(&call.id).then_some(call.id)?,
            Side::Leaf => *self.wire.get(&call.id)?,
        };
        Some(CallRef { id, ..call })
    }

    /// 這一端的說法換成線上的呼叫；不在跑是 `None`。
    fn on_wire(&self, call: CallRef) -> Option<CallRef> {
        let id = match call.side {
            Side::Composition => self.mine.contains_key(&call.id).then_some(call.id)?,
            Side::Leaf => self.theirs.get(&call.id)?.wire,
        };
        Some(CallRef { id, ..call })
    }
}

pub struct Pair {
    listener: UnixListener,
    methods: Vec<String>,
    leaf: Option<u32>,
    pending: Vec<Pending>,
    conn: Option<Conn>,
    closing: Vec<Closing>,
    /// 這個時刻之前不 accept。
    accept_after: Option<Instant>,
    next_id: u64,
    /// 下一個葉子發來的呼叫的本地代號。
    next_handle: u64,
    events: Vec<PairEvent>,
}

fn pollfd(fd: libc::c_int, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

/// 連線那一端是誰。
#[derive(Debug, PartialEq, Eq)]
enum Peer {
    /// uid 跟這一端相同、pid 是正數；帶的是 pid。
    Ours(u32),
    /// 不收的：`reason` 是 [`PairEvent::Refused`] 要寫的理由。
    Stranger { pid: Option<u32>, reason: String },
}

impl Peer {
    /// `read` 是 `SO_PEERCRED` 讀到的 `(uid, pid)`；`uid` 是這一端的。
    fn from_cred(read: Option<(u32, i32)>, uid: u32) -> Peer {
        let unreadable = Peer::Stranger {
            pid: None,
            reason: "讀不到身分".to_string(),
        };
        let Some((theirs, pid)) = read else {
            return unreadable;
        };
        let pid = u32::try_from(pid).ok().filter(|&pid| pid > 0);
        match pid {
            _ if theirs != uid => Peer::Stranger {
                pid,
                reason: format!("uid 不同（{theirs}）"),
            },
            Some(pid) => Peer::Ours(pid),
            None => unreadable,
        }
    }
}

fn peer(fd: libc::c_int) -> Peer {
    // SAFETY：ucred 是純資料，全零合法。
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let Ok(mut len) = libc::socklen_t::try_from(std::mem::size_of::<libc::ucred>()) else {
        return Peer::from_cred(None, 0);
    };
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
    Peer::from_cred((rc == 0).then_some((cred.uid, cred.pid)), uid)
}

fn failure(code: ErrorCode, message: &str) -> Result<Value, CallError> {
    Err(CallError {
        code,
        message: message.to_string(),
    })
}

fn rejected(code: RejectCode, reason: &str) -> Vec<u8> {
    encode(&PairMessage::Rejected {
        code,
        reason: reason.to_string(),
    })
}

impl Pair {
    /// `methods` 是這一端替葉子做的 method；葉子叫別的回 `unknown_method`。
    pub fn new(listener: UnixListener, methods: &[&str]) -> std::io::Result<Pair> {
        listener.set_nonblocking(true)?;
        Ok(Pair {
            listener,
            methods: methods.iter().map(|name| name.to_string()).collect(),
            leaf: None,
            pending: Vec::new(),
            conn: None,
            closing: Vec::new(),
            accept_after: None,
            next_id: 0,
            next_handle: 0,
            events: Vec::new(),
        })
    }

    /// 監督行程說葉子是這個 pid。已經有驗過的連線就斷掉它（[`Disconnect::Replaced`]）。
    pub fn set_leaf(&mut self, pid: u32) {
        if self.conn.is_some() {
            drop(self.disconnect(Disconnect::Replaced));
        }
        self.leaf = Some(pid);
    }

    pub fn connected(&self) -> bool {
        self.conn.is_some()
    }

    /// 排著沒寫出去的到了 [`OUTBOX_PAUSE`]。
    pub fn paused(&self) -> bool {
        self.conn.as_ref().is_some_and(Conn::paused)
    }

    /// 排著沒寫出去的位元組數。
    pub fn queued(&self) -> usize {
        self.conn.as_ref().map_or(0, |conn| conn.chan.queued())
    }

    /// 要 poll 的 fd。
    pub fn poll_fds(&self, fds: &mut Vec<libc::pollfd>) {
        if self.accept_after.is_none() {
            fds.push(pollfd(self.listener.as_raw_fd(), libc::POLLIN));
        }
        for closing in &self.closing {
            let (read, write) = closing.chan.poll_fds();
            if let Some(read) = read.filter(|_| !closing.gone) {
                fds.push(pollfd(read, libc::POLLIN));
            }
            if let Some(write) = write {
                fds.push(pollfd(write, libc::POLLOUT));
            }
        }
        for pending in &self.pending {
            if let (Some(read), _) = pending.chan.poll_fds() {
                fds.push(pollfd(read, libc::POLLIN));
            }
        }
        if let Some(conn) = &self.conn {
            let (read, write) = conn.chan.poll_fds();
            if let Some(read) = read {
                fds.push(pollfd(read, libc::POLLIN));
            }
            if let Some(write) = write {
                fds.push(pollfd(write, libc::POLLOUT));
            }
        }
    }

    /// 沒有 fd 動也要叫 [`Pair::step`] 的時刻：最早到期的等著驗身分的時限（[`PID_WAIT`]）、等著關的連線的時限、accept 退避完的時刻、送端停滯的時限；
    /// 有還沒交出去的事、有等著的連線已經判得出來、該報 [`PairEvent::Resumed`]、送端剛有東西排著還沒開始計時、或驗過的那條有一端已經關了，就是現在。
    pub fn deadline(&self, now: Instant) -> Option<Instant> {
        let decided = self.pending.iter().any(|pending| match self.leaf {
            Some(leaf) => pending.hello.is_some() || pending.pid != leaf,
            None => false,
        });
        let conn = self.conn.as_ref();
        let resumed = conn.is_some_and(|conn| conn.refused && !conn.paused());
        let untimed =
            conn.is_some_and(|conn| conn.chan.queued() > 0 && conn.stalled_since.is_none());
        let stall = conn
            .and_then(|conn| conn.stalled_since)
            .map(|since| since + STALL_TIMEOUT);
        let closed = conn.is_some_and(|conn| conn.chan.write_closed() || conn.chan.read_closed());
        let ready = decided || resumed || untimed || closed || !self.events.is_empty();
        self.pending
            .iter()
            .map(|pending| pending.opened + PID_WAIT)
            .chain(self.closing.iter().map(|closing| closing.until))
            .chain(self.accept_after)
            .chain(stall)
            .chain(ready.then_some(now))
            .min()
    }

    /// 收連線、讀寫、處理讀到的框、收掉過了時限的，回上一次 `step` 之後累積的事。不會擋住。
    /// 先判等著的、讓斷了的讓出位子再 accept；accept 之後再判一次，連線帶著 `hello` 一起到的同一步就收下。
    pub fn step(&mut self, now: Instant) -> Vec<PairEvent> {
        self.step_closing(now);
        self.step_pending(now);
        self.accept(now);
        self.step_pending(now);
        self.step_conn(now);
        std::mem::take(&mut self.events)
    }

    /// 叫葉子的一個 method，回這一次的 `id`。`parent` 是葉子發的那一邊時給本地代號。結果之後由 [`PairEvent::Chunk`] 與 [`PairEvent::Finished`] 交回來。
    pub fn call(
        &mut self,
        parent: Option<CallRef>,
        method: &str,
        payload: Value,
    ) -> Result<u64, SendError> {
        let conn = self.conn.as_mut().ok_or(SendError::NotConnected)?;
        conn.admit()?;
        if conn.mine.len() >= MAX_CALLS {
            return Err(SendError::Busy);
        }
        let parent = match parent {
            Some(parent) => Some(conn.on_wire(parent).ok_or(SendError::BadParent)?),
            None => None,
        };
        let id = self.next_id;
        let bytes = encode(&PairMessage::Call {
            call: CallRef {
                side: Side::Composition,
                id,
            },
            parent,
            method: method.to_string(),
            payload,
        });
        if bytes.len() > MAX_FRAME {
            return Err(SendError::TooLarge);
        }
        self.next_id += 1;
        if let Some(conn) = self.conn.as_mut() {
            conn.mine.insert(id, 0);
        }
        self.send(&bytes);
        Ok(id)
    }

    /// 叫葉子綁這條 thread。
    pub fn attach(&mut self, thread_id: &str) -> Result<u64, SendError> {
        self.call(
            None,
            METHOD_ATTACH,
            serde_json::json!({ "threadId": thread_id }),
        )
    }

    /// 自己發的那一次不要了。它的 [`PairEvent::Finished`] 照樣會來；已經結束的不送任何東西。暫停時也照排；再排就超過
    /// [`OUTBOX_LIMIT`] 的，斷線（[`Disconnect::Overflow`]）。
    pub fn cancel(&mut self, id: u64) {
        if self
            .conn
            .as_ref()
            .is_some_and(|conn| conn.mine.contains_key(&id))
        {
            self.send(&encode(&PairMessage::Cancel {
                call: CallRef {
                    side: Side::Composition,
                    id,
                },
            }));
        }
    }

    /// 替葉子發的那一次（本地代號）串流一塊。
    pub fn chunk(&mut self, id: u64, payload: &str) -> Result<(), SendError> {
        let conn = self.conn.as_mut().ok_or(SendError::NotConnected)?;
        if !conn.theirs.contains_key(&id) {
            return Err(SendError::NotRunning);
        }
        conn.admit()?;
        if payload.len() > MAX_CHUNK_BYTES {
            self.finish(id, failure(ErrorCode::TooLarge, "一塊超過上限"))?;
            return Err(SendError::TooLarge);
        }
        let Some(their) = conn.theirs.get_mut(&id) else {
            return Err(SendError::NotRunning);
        };
        let seq = their.next;
        their.next += 1;
        let call = CallRef {
            side: Side::Leaf,
            id: their.wire,
        };
        self.send(&encode(&PairMessage::Chunk {
            call,
            seq,
            payload: payload.to_string(),
        }));
        Ok(())
    }

    /// 葉子發的那一次（本地代號）做完了。編出來超過一框的換成 `too_large`。那一次已經不在跑（葉子取消了、連線斷過）回
    /// [`SendError::NotRunning`]，沒有連線回 [`SendError::NotConnected`]，這兩種結果丟掉就好；回 [`SendError::Paused`] 的那一次還在跑，結果要留著再試。
    pub fn finish(&mut self, id: u64, outcome: Result<Value, CallError>) -> Result<(), SendError> {
        let conn = self.conn.as_mut().ok_or(SendError::NotConnected)?;
        if !conn.theirs.contains_key(&id) {
            return Err(SendError::NotRunning);
        }
        conn.admit()?;
        let Some(their) = conn.theirs.remove(&id) else {
            return Err(SendError::NotRunning);
        };
        conn.wire.remove(&their.wire);
        self.reply(their.wire, outcome);
        Ok(())
    }

    /// 回線上那個 `id` 的 `result`。
    fn reply(&mut self, id: u64, outcome: Result<Value, CallError>) {
        let call = CallRef {
            side: Side::Leaf,
            id,
        };
        let mut bytes = encode(&PairMessage::Result { call, outcome });
        if bytes.len() > MAX_FRAME {
            bytes = encode(&PairMessage::Result {
                call,
                outcome: failure(ErrorCode::TooLarge, "結果超過一框"),
            });
        }
        self.send(&bytes);
    }

    /// 排一框給驗過的那條連線；排不下就斷。
    fn send(&mut self, payload: &[u8]) {
        let Some(conn) = self.conn.as_mut() else {
            return;
        };
        conn.flush();
        if conn.chan.queued() + payload.len() + 4 > OUTBOX_LIMIT {
            drop(self.disconnect(Disconnect::Overflow));
            return;
        }
        conn.send(payload);
    }

    /// 收掉驗過的那條連線：還在跑的呼叫各報一筆，pid 作廢。回那條連線，丟掉它就關了。
    fn disconnect(&mut self, reason: Disconnect) -> Option<Chan> {
        let conn = self.conn.take()?;
        let mut mine: Vec<u64> = conn.mine.into_keys().collect();
        mine.sort_unstable();
        for id in mine {
            self.events.push(PairEvent::Finished {
                id,
                outcome: Err(Failure::PeerGone),
            });
        }
        let mut theirs: Vec<u64> = conn.theirs.into_keys().collect();
        theirs.sort_unstable();
        for id in theirs {
            self.events.push(PairEvent::Cancelled { id });
        }
        self.leaf = None;
        self.events.push(PairEvent::Disconnected { reason });
        Some(conn.chan)
    }

    /// 葉子違反協定：收線，回 `rejected`。
    fn violate(&mut self, why: &str, now: Instant) {
        if let Some(chan) = self.disconnect(Disconnect::Violation(why.to_string())) {
            self.reject(chan, RejectCode::Protocol, why, now);
        }
    }

    fn refuse(&mut self, pending: Pending, code: RejectCode, reason: &str, now: Instant) {
        self.events.push(PairEvent::Refused {
            pid: Some(pending.pid),
            reason: reason.to_string(),
        });
        self.reject(pending.chan, code, reason, now);
    }

    /// 排一框 `rejected`，寫完關寫的方向；連線留到 [`Closing::open`] 說不留、[`CLOSE_TIMEOUT`] 或被 [`MAX_CLOSING`] 擠掉，這段時間對方寫得進來、讀得到那一框。
    /// 這裡不讀：一步可能拒絕很多條，讀交給 `step_closing`，一步最多 `MAX_CLOSING` 條各 [`READ_BUDGET`]。
    fn reject(&mut self, mut chan: Chan, code: RejectCode, reason: &str, now: Instant) {
        chan.send(&rejected(code, reason));
        chan.finish();
        let mut closing = Closing {
            gone: chan.read_closed(),
            chan,
            until: now + CLOSE_TIMEOUT,
            shut: false,
        };
        closing.flush();
        if !closing.open() {
            return;
        }
        if self.closing.len() >= MAX_CLOSING {
            self.closing.remove(0);
        }
        self.closing.push(closing);
    }

    fn step_closing(&mut self, now: Instant) {
        self.closing.retain_mut(|closing| {
            if now >= closing.until {
                return false;
            }
            closing.flush();
            closing.discard();
            closing.open()
        });
    }

    fn accept(&mut self, now: Instant) {
        if self.accept_after.is_some_and(|after| now < after) {
            return;
        }
        self.accept_after = None;
        loop {
            let stream = match self.listener.accept() {
                Ok((stream, _)) => stream,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => return,
                Err(_) => {
                    self.accept_after = Some(now + ACCEPT_BACKOFF);
                    return;
                }
            };
            let peer = peer(stream.as_raw_fd());
            let read = OwnedFd::from(stream);
            let Ok(write) = read.try_clone() else {
                let pid = match peer {
                    Peer::Ours(pid) => Some(pid),
                    Peer::Stranger { pid, .. } => pid,
                };
                self.events.push(PairEvent::Refused {
                    pid,
                    reason: "開不了 fd".to_string(),
                });
                self.accept_after = Some(now + ACCEPT_BACKOFF);
                return;
            };
            let chan = Chan::from_fds(read, write, MAX_FRAME);
            let pid = match peer {
                Peer::Ours(pid) => pid,
                Peer::Stranger { pid, reason } => {
                    self.events.push(PairEvent::Refused { pid, reason });
                    self.reject(chan, RejectCode::Identity, "身分不對", now);
                    continue;
                }
            };
            let refusal = if self.leaf.is_some_and(|leaf| leaf != pid) {
                Some((RejectCode::RetryLater, "pid 不對"))
            } else if self.pending.len() >= MAX_PENDING {
                Some((RejectCode::RetryLater, "等著驗身分的連線太多"))
            } else {
                None
            };
            match refusal {
                None => self.pending.push(Pending {
                    chan,
                    pid,
                    opened: now,
                    hello: None,
                }),
                Some((code, reason)) => {
                    self.events.push(PairEvent::Refused {
                        pid: Some(pid),
                        reason: reason.to_string(),
                    });
                    self.reject(chan, code, reason, now);
                }
            }
        }
    }

    /// 還沒驗過的連線：讀它的 `hello`，判得出來的就收下或拒絕。
    fn step_pending(&mut self, now: Instant) {
        for mut pending in std::mem::take(&mut self.pending) {
            let verdict = self.judge(&mut pending, now);
            match verdict {
                Verdict::Wait => self.pending.push(pending),
                Verdict::Gone => {}
                Verdict::Refuse(code, reason) => self.refuse(pending, code, reason, now),
                Verdict::Accept => {
                    let pid = pending.pid;
                    let mut chan = pending.chan;
                    chan.send(&encode(&PairMessage::Hello {
                        version: PAIR_PROTOCOL_VERSION,
                    }));
                    self.conn = Some(Conn {
                        chan,
                        refused: false,
                        wrote: false,
                        stalled_since: None,
                        mine: HashMap::new(),
                        theirs: HashMap::new(),
                        wire: HashMap::new(),
                    });
                    self.events.push(PairEvent::Connected { pid });
                }
            }
        }
    }

    fn judge(&self, pending: &mut Pending, now: Instant) -> Verdict {
        if self.leaf.is_some_and(|leaf| leaf != pending.pid) {
            return Verdict::Refuse(RejectCode::RetryLater, "pid 不對");
        }
        let frames = match pending.chan.receive() {
            Ok(frames) => frames,
            Err(err) => return Verdict::Refuse(RejectCode::Protocol, err.0),
        };
        for frame in frames {
            if pending.hello.is_some() {
                return Verdict::Refuse(RejectCode::Protocol, "還沒收到 hello 就送別的");
            }
            match decode(&frame) {
                Ok(PairMessage::Hello { version }) => pending.hello = Some(version),
                Ok(_) => return Verdict::Refuse(RejectCode::Protocol, "還沒 hello"),
                Err(err) => return Verdict::Refuse(RejectCode::Protocol, err.0),
            }
        }
        let expired = now >= pending.opened + PID_WAIT;
        match (pending.hello, self.leaf) {
            (Some(version), _) if version != PAIR_PROTOCOL_VERSION => {
                Verdict::Refuse(RejectCode::Version, "版本不對")
            }
            (Some(_), Some(_)) if self.conn.is_some() => {
                Verdict::Refuse(RejectCode::Protocol, "已經有連線")
            }
            (Some(_), Some(_)) => Verdict::Accept,
            (Some(_), None) if expired => {
                Verdict::Refuse(RejectCode::RetryLater, "還沒有葉子的 pid")
            }
            (None, _) if expired => Verdict::Refuse(RejectCode::Protocol, "沒有在時限內送 hello"),
            _ if pending.chan.read_closed() || pending.chan.write_closed() => Verdict::Gone,
            _ => Verdict::Wait,
        }
    }

    /// 驗過的那條：寫、判停滯、報 [`PairEvent::Resumed`]、讀與處理、判對方關了。
    fn step_conn(&mut self, now: Instant) {
        let Some(conn) = self.conn.as_mut() else {
            return;
        };
        conn.flush();
        if conn.chan.queued() == 0 {
            conn.stalled_since = None;
        } else if conn.wrote || conn.stalled_since.is_none() {
            conn.stalled_since = Some(now);
        }
        conn.wrote = false;
        let stalled = conn
            .stalled_since
            .is_some_and(|since| now >= since + STALL_TIMEOUT);
        if stalled {
            drop(self.disconnect(Disconnect::Stalled));
            return;
        }
        if conn.refused && !conn.paused() {
            conn.refused = false;
            self.events.push(PairEvent::Resumed);
        }
        let frames = match conn.chan.receive() {
            Ok(frames) => frames,
            Err(err) => {
                self.violate(err.0, now);
                return;
            }
        };
        for frame in frames {
            if self.conn.is_none() {
                return;
            }
            if let Err(why) = self.handle(&frame) {
                self.violate(why, now);
                return;
            }
        }
        let closed = self
            .conn
            .as_ref()
            .is_some_and(|conn| conn.chan.write_closed() || conn.chan.read_closed());
        if closed {
            drop(self.disconnect(Disconnect::Closed));
        }
    }

    /// 處理葉子送來的一框；違反協定回原因。
    fn handle(&mut self, frame: &[u8]) -> Result<(), &'static str> {
        let message = decode(frame).map_err(|err| err.0)?;
        let Some(conn) = self.conn.as_mut() else {
            return Ok(());
        };
        match message {
            PairMessage::Hello { .. } => Err("又送了一次 hello"),
            PairMessage::Rejected { .. } => Err("葉子不送 rejected"),
            PairMessage::Register { tools, hooks } => {
                self.events.push(PairEvent::Registered { tools, hooks });
                Ok(())
            }
            PairMessage::Call {
                call,
                parent,
                method,
                payload,
            } => {
                if call.side != Side::Leaf {
                    return Err("方向不對");
                }
                let id = call.id;
                if conn.wire.contains_key(&id) {
                    return Err("重複的呼叫編號");
                }
                let local = parent.map(|parent| conn.local(parent));
                let refusal = if conn.theirs.len() >= MAX_CALLS {
                    Some((ErrorCode::Busy, "同時在跑的呼叫已經到上限".to_string()))
                } else if local == Some(None) {
                    Some((ErrorCode::BadPayload, "parent 不在跑".to_string()))
                } else if !self.methods.contains(&method) {
                    Some((ErrorCode::UnknownMethod, clip_method(&method).to_string()))
                } else {
                    None
                };
                match refusal {
                    Some((code, message)) => self.reply(id, Err(CallError { code, message })),
                    None => {
                        let handle = self.next_handle;
                        self.next_handle += 1;
                        conn.theirs.insert(handle, Their { wire: id, next: 0 });
                        conn.wire.insert(id, handle);
                        self.events.push(PairEvent::Call {
                            id: handle,
                            parent: local.flatten(),
                            method,
                            payload,
                        });
                    }
                }
                Ok(())
            }
            PairMessage::Chunk { call, seq, payload } => {
                if call.side != Side::Composition {
                    return Err("方向不對");
                }
                let next = conn.mine.get_mut(&call.id).ok_or("不在跑的呼叫")?;
                if seq != *next {
                    return Err("seq 沒接上");
                }
                *next += 1;
                self.events.push(PairEvent::Chunk {
                    id: call.id,
                    seq,
                    payload,
                });
                Ok(())
            }
            PairMessage::Result { call, outcome } => {
                if call.side != Side::Composition {
                    return Err("方向不對");
                }
                conn.mine.remove(&call.id).ok_or("不在跑的呼叫")?;
                self.events.push(PairEvent::Finished {
                    id: call.id,
                    outcome: outcome.map_err(Failure::Error),
                });
                Ok(())
            }
            PairMessage::Cancel { call } => {
                if call.side != Side::Leaf {
                    return Err("方向不對");
                }
                if let Some(handle) = conn.wire.remove(&call.id) {
                    conn.theirs.remove(&handle);
                    self.events.push(PairEvent::Cancelled { id: handle });
                    self.reply(call.id, failure(ErrorCode::Cancelled, ""));
                }
                Ok(())
            }
        }
    }
}

enum Verdict {
    Wait,
    /// 對方自己斷了。
    Gone,
    Refuse(RejectCode, &'static str),
    Accept,
}

#[cfg(test)]
mod tests {
    use super::Peer;

    fn stranger(pid: Option<u32>, reason: &str) -> Peer {
        Peer::Stranger {
            pid,
            reason: reason.to_string(),
        }
    }

    #[test]
    fn another_uid_and_an_unreadable_peer_are_refused_for_different_reasons() {
        assert_eq!(Peer::from_cred(Some((1000, 42)), 1000), Peer::Ours(42));
        assert_eq!(
            Peer::from_cred(Some((1001, 42)), 1000),
            stranger(Some(42), "uid 不同（1001）")
        );
        // uid 先看：別的 uid 就算沒有 pid，理由也是 uid。
        assert_eq!(
            Peer::from_cred(Some((1001, 0)), 1000),
            stranger(None, "uid 不同（1001）")
        );
        assert_eq!(Peer::from_cred(None, 1000), stranger(None, "讀不到身分"));
        // 讀到了但沒有 pid。
        assert_eq!(
            Peer::from_cred(Some((1000, 0)), 1000),
            stranger(None, "讀不到身分")
        );
    }
}
