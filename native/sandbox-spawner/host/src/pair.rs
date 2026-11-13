//! 橋在組合行程那一端（#2583）：收連線、驗葉子的身分、記兩個方向還在跑的呼叫、背壓、收線。協定見 [`crate::pair_protocol`]。
//!
//! 不自己跑事件迴圈：擁有它的一方把 [`Pair::poll_fds`] 放進 poll、照 [`Pair::deadline`] 設時限，醒來就叫 [`Pair::step`] 拿上一次 `step` 之後累積的事
//! （[`PairEvent`]）。時間由呼叫的一方傳進來。[`Pair::set_leaf`] 與送出的幾個方法造成的事（斷線、收下等著的連線）也是下一次 `step` 才交出來，
//! 這時 [`Pair::deadline`] 回現在。
//!
//! - 監督行程給的葉子 pid 用 [`Pair::set_leaf`] 交進來。pid 還沒到就連進來的連線先留著，從收下它的那一次 `step` 起最多留
//!   [`HELLO_TIMEOUT`]：監督行程同時起一對，葉子可能比 `leaf{pid}` 先到。
//! - 同時只有一條驗過的連線。它斷了之後 pid 作廢，要等下一次 [`Pair::set_leaf`] 才再收。
//! - 葉子發來的呼叫，還沒到 [`MAX_CALLS`]、`parent` 在跑、method 在 [`Pair::new`] 給的清單裡，才交給擁有的一方（[`PairEvent::Call`]），
//!   由它用 [`Pair::chunk`]、[`Pair::finish`] 回；不合的這裡直接回錯。
//!   葉子取消時這裡直接回 `cancelled`，之後再 `finish` 那一次不會送出任何東西。
//! - `rejected` 排進去之後就關：對方沒在讀的話，那一框送不到。

use std::collections::{HashMap, VecDeque};
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::net::UnixListener;
use std::time::Instant;

use crate::host::peer_pid;
use crate::host_protocol::{CallError, ErrorCode};
use crate::json::Value;
use crate::pair_protocol::{
    decode, encode, CallRef, PairMessage, Side, HELLO_TIMEOUT, MAX_CALLS, MAX_CHUNK_BYTES,
    MAX_FRAME, MAX_PENDING, METHOD_ATTACH, OUTBOX_LIMIT, OUTBOX_PAUSE, PAIR_PROTOCOL_VERSION,
};
use nexus_sandbox_spawner::supervisor::process::Chan;

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
    /// 葉子不讀，再排一框就會超過 [`OUTBOX_LIMIT`]。
    Overflow,
    /// 監督行程又給了一次葉子 pid（同一個號碼也算）。
    Replaced,
}

/// 這一端現在送不了的原因。除了 [`SendError::TooLarge`] 的塊（它要排一框 `result`，排不下時連線照 [`Disconnect::Overflow`] 斷），都不動連線。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendError {
    NotConnected,
    /// 排著的到了 [`OUTBOX_PAUSE`]，等 [`Pair::paused`] 回 `false` 再試。
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
    /// 葉子發來的呼叫。
    Call {
        id: u64,
        parent: Option<CallRef>,
        method: String,
        payload: Value,
    },
    /// 葉子發來的那一次不用做了：它取消了，或連線斷了。
    Cancelled { id: u64 },
    /// 自己發的那一次，葉子串流來的一塊。
    Chunk { id: u64, seq: u64, payload: String },
    /// 自己發的那一次結束了。
    Finished {
        id: u64,
        outcome: Result<Value, Failure>,
    },
    /// 沒收一條連線。`pid` 讀不到是 `None`。
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
    /// 讀進來、還沒處理的框；排著的到了 [`OUTBOX_PAUSE`] 時停在這裡。
    backlog: VecDeque<Vec<u8>>,
    /// 自己發的、還沒收到 `result` 的：下一塊該是第幾塊。
    mine: HashMap<u64, u64>,
    /// 葉子發的、還沒回 `result` 的：下一塊要送第幾塊。
    theirs: HashMap<u64, u64>,
}

impl Conn {
    fn paused(&self) -> bool {
        self.chan.queued() >= OUTBOX_PAUSE
    }

    fn running(&self, call: CallRef) -> bool {
        match call.side {
            Side::Composition => self.mine.contains_key(&call.id),
            Side::Leaf => self.theirs.contains_key(&call.id),
        }
    }
}

pub struct Pair {
    listener: UnixListener,
    methods: Vec<String>,
    leaf: Option<u32>,
    pending: Vec<Pending>,
    conn: Option<Conn>,
    next_id: u64,
    events: Vec<PairEvent>,
}

fn pollfd(fd: libc::c_int, events: libc::c_short) -> libc::pollfd {
    libc::pollfd {
        fd,
        events,
        revents: 0,
    }
}

fn failure(code: ErrorCode, message: &str) -> Result<Value, CallError> {
    Err(CallError {
        code,
        message: message.to_string(),
    })
}

fn rejected(reason: &str) -> Vec<u8> {
    encode(&PairMessage::Rejected {
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
            next_id: 0,
            events: Vec::new(),
        })
    }

    /// 監督行程說葉子是這個 pid。已經有驗過的連線就斷掉它（[`Disconnect::Replaced`]）。
    pub fn set_leaf(&mut self, pid: u32) {
        if self.conn.is_some() {
            self.disconnect(Disconnect::Replaced);
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

    /// 要 poll 的 fd。暫停時，或還有讀進來沒處理的框時，不看那條連線的讀端。
    pub fn poll_fds(&self, fds: &mut Vec<libc::pollfd>) {
        fds.push(pollfd(self.listener.as_raw_fd(), libc::POLLIN));
        for pending in &self.pending {
            if let (Some(read), _) = pending.chan.poll_fds() {
                fds.push(pollfd(read, libc::POLLIN));
            }
        }
        if let Some(conn) = &self.conn {
            let (read, write) = conn.chan.poll_fds();
            if let Some(read) = read.filter(|_| !conn.paused() && conn.backlog.is_empty()) {
                fds.push(pollfd(read, libc::POLLIN));
            }
            if let Some(write) = write {
                fds.push(pollfd(write, libc::POLLOUT));
            }
        }
    }

    /// 沒有 fd 動也要叫 [`Pair::step`] 的時刻：最早到期的 `hello` 時限；有留著的框可以處理、有還沒交出去的事、
    /// 或有等著的連線已經判得出來，就是現在。
    pub fn deadline(&self, now: Instant) -> Option<Instant> {
        let decided = self.pending.iter().any(|pending| match self.leaf {
            Some(leaf) => pending.hello.is_some() || pending.pid != leaf,
            None => false,
        });
        let backlog = self
            .conn
            .as_ref()
            .is_some_and(|conn| !conn.backlog.is_empty() && !conn.paused());
        let ready = backlog || decided || !self.events.is_empty();
        self.pending
            .iter()
            .map(|pending| pending.opened + HELLO_TIMEOUT)
            .chain(ready.then_some(now))
            .min()
    }

    /// 收連線、讀寫、處理讀到的框、收掉過了時限的，回上一次 `step` 之後累積的事。不會擋住。
    pub fn step(&mut self, now: Instant) -> Vec<PairEvent> {
        self.accept(now);
        self.step_pending(now);
        self.step_conn();
        std::mem::take(&mut self.events)
    }

    /// 叫葉子的一個 method，回這一次的 `id`。結果之後由 [`PairEvent::Chunk`] 與 [`PairEvent::Finished`] 交回來。
    pub fn call(
        &mut self,
        parent: Option<CallRef>,
        method: &str,
        payload: Value,
    ) -> Result<u64, SendError> {
        let conn = self.conn.as_ref().ok_or(SendError::NotConnected)?;
        if conn.paused() {
            return Err(SendError::Paused);
        }
        if conn.mine.len() >= MAX_CALLS {
            return Err(SendError::Busy);
        }
        if parent.is_some_and(|parent| !conn.running(parent)) {
            return Err(SendError::BadParent);
        }
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

    /// 自己發的那一次不要了。它的 [`PairEvent::Finished`] 照樣會來；已經結束的不送任何東西。
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

    /// 替葉子發的那一次串流一塊。
    pub fn chunk(&mut self, id: u64, payload: &str) -> Result<(), SendError> {
        let conn = self.conn.as_mut().ok_or(SendError::NotConnected)?;
        if !conn.theirs.contains_key(&id) {
            return Err(SendError::NotRunning);
        }
        if false && payload.len() > MAX_CHUNK_BYTES {
            self.finish(id, failure(ErrorCode::TooLarge, "一塊超過上限"));
            return Err(SendError::TooLarge);
        }
        if conn.paused() {
            return Err(SendError::Paused);
        }
        let Some(next) = conn.theirs.get_mut(&id) else {
            return Err(SendError::NotRunning);
        };
        let seq = *next;
        *next += 1;
        self.send(&encode(&PairMessage::Chunk {
            call: CallRef {
                side: Side::Leaf,
                id,
            },
            seq,
            payload: payload.to_string(),
        }));
        Ok(())
    }

    /// 葉子發的那一次做完了。編出來超過一框的換成 `too_large`；那一次已經不在跑（葉子取消了）就不送。
    pub fn finish(&mut self, id: u64, outcome: Result<Value, CallError>) {
        let Some(conn) = self.conn.as_mut() else {
            return;
        };
        if conn.theirs.remove(&id).is_none() {
            return;
        }
        self.reply(id, outcome);
    }

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
        conn.chan.flush();
        if false && conn.chan.queued() + payload.len() + 4 > OUTBOX_LIMIT {
            self.disconnect(Disconnect::Overflow);
            return;
        }
        conn.chan.send(payload);
    }

    /// 收掉驗過的那條連線：還在跑的呼叫各報一筆，pid 作廢。
    fn disconnect(&mut self, reason: Disconnect) {
        let Some(mut conn) = self.conn.take() else {
            return;
        };
        if let Disconnect::Violation(why) = &reason {
            conn.chan.send(&rejected(why));
        }
        let mut mine: Vec<u64> = conn.mine.into_keys().collect();
        mine.sort_unstable();
        for id in mine {
            self.events.push(PairEvent::Finished {
                id,
                outcome: Err(Failure::Error(CallError {
                    code: ErrorCode::ServiceError,
                    message: String::new(),
                })),
            });
        }
        let mut theirs: Vec<u64> = conn.theirs.into_keys().collect();
        theirs.sort_unstable();
        for id in theirs {
            self.events.push(PairEvent::Cancelled { id });
        }
        self.leaf = None;
        self.events.push(PairEvent::Disconnected { reason });
    }

    fn refuse(&mut self, mut pending: Pending, reason: &str) {
        pending.chan.send(&rejected(reason));
        self.events.push(PairEvent::Refused {
            pid: Some(pending.pid),
            reason: reason.to_string(),
        });
    }

    fn accept(&mut self, now: Instant) {
        loop {
            let stream = match self.listener.accept() {
                Ok((stream, _)) => stream,
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return,
            };
            let pid = peer_pid(stream.as_raw_fd());
            let read = OwnedFd::from(stream);
            let Ok(write) = read.try_clone() else {
                continue;
            };
            let mut chan = Chan::from_fds(read, write, MAX_FRAME);
            let refusal = match pid {
                None => Some("讀不到身分"),
                Some(pid) if self.leaf.is_some_and(|leaf| false && leaf != pid) => Some("pid 不對"),
                Some(_) if self.pending.len() >= MAX_PENDING => Some("等著驗身分的連線太多"),
                Some(_) => None,
            };
            match (pid, refusal) {
                (Some(pid), None) => self.pending.push(Pending {
                    chan,
                    pid,
                    opened: now,
                    hello: None,
                }),
                (_, reason) => {
                    let reason = reason.unwrap_or_default();
                    chan.send(&rejected(reason));
                    self.events.push(PairEvent::Refused {
                        pid,
                        reason: reason.to_string(),
                    });
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
                Verdict::Refuse(reason) => self.refuse(pending, reason),
                Verdict::Accept => {
                    let pid = pending.pid;
                    let mut chan = pending.chan;
                    chan.send(&encode(&PairMessage::Hello {
                        version: PAIR_PROTOCOL_VERSION,
                    }));
                    self.conn = Some(Conn {
                        chan,
                        backlog: VecDeque::new(),
                        mine: HashMap::new(),
                        theirs: HashMap::new(),
                    });
                    self.events.push(PairEvent::Connected { pid });
                }
            }
        }
    }

    fn judge(&self, pending: &mut Pending, now: Instant) -> Verdict {
        if self.leaf.is_some_and(|leaf| false && leaf != pending.pid) {
            return Verdict::Refuse("pid 不對");
        }
        let frames = match pending.chan.receive() {
            Ok(frames) => frames,
            Err(err) => return Verdict::Refuse(err.0),
        };
        for frame in frames {
            if pending.hello.is_some() {
                return Verdict::Refuse("還沒收到 hello 就送別的");
            }
            match decode(&frame) {
                Ok(PairMessage::Hello { version }) => pending.hello = Some(version),
                Ok(_) => return Verdict::Refuse("還沒 hello"),
                Err(err) => return Verdict::Refuse(err.0),
            }
        }
        let expired = false && now >= pending.opened + HELLO_TIMEOUT;
        match (pending.hello, self.leaf) {
            (Some(version), _) if version != PAIR_PROTOCOL_VERSION => Verdict::Gone,
            (Some(_), Some(_)) if self.conn.is_some() => Verdict::Refuse("已經有連線"),
            (Some(_), Some(_)) => Verdict::Accept,
            (Some(_), None) if expired => Verdict::Refuse("還沒有葉子的 pid"),
            (None, _) if expired => Verdict::Refuse("沒有在時限內送 hello"),
            _ if pending.chan.read_closed() || pending.chan.write_closed() => Verdict::Gone,
            _ => Verdict::Wait,
        }
    }

    /// 驗過的那條：寫、沒暫停就讀與處理。
    fn step_conn(&mut self) {
        let Some(conn) = self.conn.as_mut() else {
            return;
        };
        conn.chan.flush();
        if conn.backlog.is_empty() {
            match conn.chan.receive() {
                Ok(frames) => conn.backlog.extend(frames),
                Err(err) => {
                    self.disconnect(Disconnect::Violation(err.0.to_string()));
                    return;
                }
            }
        }
        loop {
            let Some(conn) = self.conn.as_mut() else {
                return;
            };
            let Some(frame) = conn.backlog.pop_front() else {
                break;
            };
            if let Err(why) = self.handle(&frame) {
                self.disconnect(Disconnect::Violation(why.to_string()));
                return;
            }
        }
        let closed = self.conn.as_ref().is_some_and(|conn| {
            conn.chan.write_closed() || (conn.chan.read_closed() && conn.backlog.is_empty())
        });
        if closed {
            self.disconnect(Disconnect::Closed);
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
                if conn.theirs.contains_key(&id) {
                    return Err("重複的呼叫編號");
                }
                let refusal = if conn.theirs.len() >= MAX_CALLS {
                    Some((ErrorCode::Busy, "同時在跑的呼叫已經到上限".to_string()))
                } else if parent.is_some_and(|parent| !conn.running(parent)) {
                    Some((ErrorCode::BadPayload, "parent 不在跑".to_string()))
                } else if !self.methods.contains(&method) {
                    Some((ErrorCode::UnknownMethod, method.clone()))
                } else {
                    None
                };
                match refusal {
                    Some((code, message)) => self.reply(id, Err(CallError { code, message })),
                    None => {
                        conn.theirs.insert(id, 0);
                        self.events.push(PairEvent::Call {
                            id,
                            parent,
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
                if conn.theirs.remove(&call.id).is_some() {
                    self.events.push(PairEvent::Cancelled { id: call.id });
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
    Refuse(&'static str),
    Accept,
}
