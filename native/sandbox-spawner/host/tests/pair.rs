#![cfg(target_os = "linux")]
//! 橋在組合行程那一端（[`nexus_host::pair`]，#2583）：測試行程自己連進來當葉子，所以 `SO_PEERCRED` 讀到的 pid 就是測試行程的。
//!
//! 單執行緒、不睡：葉子寫完就叫 [`Rig::step`] 走到寫進去的都讀完（一步最多讀 `READ_BUDGET`）；時限用傳進去的時間推。

use nexus_host::host_protocol::{CallError, ErrorCode};
use nexus_host::json::{self, Value};
use nexus_host::pair::{Disconnect, Failure, Pair, PairEvent, SendError, CLOSE_TIMEOUT};
use nexus_host::pair_protocol::{
    decode, encode, CallRef, PairMessage, RejectCode, Side, MAX_CALLS, MAX_CHUNK_BYTES, MAX_FRAME,
    MAX_PENDING, METHOD_ATTACH, METHOD_ECHO_BYTES, OUTBOX_LIMIT, OUTBOX_PAUSE,
    PAIR_PROTOCOL_VERSION, PID_WAIT, STALL_TIMEOUT,
};
use nexus_sandbox_spawner::protocol::{frame, take_frame_within};
use nexus_sandbox_spawner::supervisor::process::READ_BUDGET;
use std::io::{ErrorKind, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn me() -> u32 {
    std::process::id()
}

fn someone_else() -> u32 {
    me() + 1
}

struct Rig {
    pair: Pair,
    socket: PathBuf,
    start: Instant,
    /// 從 `start` 起過了多久；`step` 用它當現在。
    elapsed: Duration,
    seen: Vec<PairEvent>,
}

impl Rig {
    /// 組合行程那一端，替葉子做 `echo` 與 `stream` 兩個 method。
    fn new(tag: &str) -> Rig {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("npair-{tag}-{}-{n}", me()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("pair.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        Rig {
            pair: Pair::new(listener, &["echo", "stream"]).unwrap(),
            socket,
            start: Instant::now(),
            elapsed: Duration::ZERO,
            seen: Vec::new(),
        }
    }

    fn step(&mut self) {
        let events = self.pair.step(self.start + self.elapsed);
        self.seen.extend(events);
    }

    /// 到目前為止發生、還沒拿走的事。
    fn events(&mut self) -> Vec<PairEvent> {
        self.step();
        std::mem::take(&mut self.seen)
    }

    /// 連上、送 `hello`、驗過：回葉子，葉子已經讀走組合行程的 `hello`。
    fn connected(tag: &str) -> (Rig, Leaf) {
        let mut rig = Rig::new(tag);
        rig.pair.set_leaf(me());
        let mut leaf = Leaf::connect(&rig);
        leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
        assert_eq!(rig.events(), [PairEvent::Connected { pid: me() }]);
        assert_eq!(leaf.read(&mut rig), [hello(PAIR_PROTOCOL_VERSION)]);
        (rig, leaf)
    }
}

struct Leaf {
    stream: UnixStream,
    buf: Vec<u8>,
    closed: bool,
}

impl Leaf {
    fn connect(rig: &Rig) -> Leaf {
        let stream = UnixStream::connect(&rig.socket).unwrap();
        stream.set_nonblocking(true).unwrap();
        Leaf {
            stream,
            buf: Vec::new(),
            closed: false,
        }
    }

    /// 寫完這些位元組；socket 滿了就讓組合行程那一端讀。寫不進去（對方關了）就停。
    fn write(&mut self, rig: &mut Rig, mut bytes: &[u8]) {
        let total = bytes.len();
        let mut stuck = 0;
        while !bytes.is_empty() {
            match self.stream.write(bytes) {
                Ok(n) => {
                    bytes = &bytes[n..];
                    stuck = 0;
                }
                Err(err) if err.kind() == ErrorKind::WouldBlock => {
                    stuck += 1;
                    assert!(stuck < 10_000, "組合行程那一端一直不讀，葉子寫不進去");
                    rig.step();
                }
                Err(_) => break,
            }
        }
        // 一次 `step` 最多讀 `READ_BUDGET`：走到這些位元組一定都讀進去了為止。
        for _ in 0..total / READ_BUDGET + 2 {
            rig.step();
        }
    }

    fn send(&mut self, rig: &mut Rig, message: &PairMessage) {
        self.write(rig, &frame(&encode(message)));
    }

    /// 讀到沒有東西可讀為止，回讀到的框。組合行程那一端每一輪都先走一步，排著的才寫得出來。
    fn read(&mut self, rig: &mut Rig) -> Vec<PairMessage> {
        let mut frames = Vec::new();
        loop {
            rig.step();
            let mut progressed = false;
            let mut chunk = [0u8; 64 * 1024];
            loop {
                match self.stream.read(&mut chunk) {
                    Ok(0) => {
                        self.closed = true;
                        break;
                    }
                    Ok(n) => {
                        self.buf.extend_from_slice(&chunk[..n]);
                        progressed = true;
                    }
                    Err(err) if err.kind() == ErrorKind::WouldBlock => break,
                    Err(_) => {
                        self.closed = true;
                        break;
                    }
                }
            }
            while let Some(payload) = take_frame_within(&mut self.buf, MAX_FRAME).unwrap() {
                frames.push(decode(&payload).unwrap());
            }
            if !progressed {
                return frames;
            }
        }
    }

    /// 剩下的只有 `rejected{code, reason}`，之後連線關了。
    fn assert_rejected(&mut self, rig: &mut Rig, code: RejectCode, reason: &str) {
        assert_eq!(self.read(rig), [rejected(code, reason)]);
        assert!(self.closed, "{reason}：送完 rejected 要關");
    }
}

fn hello(version: u32) -> PairMessage {
    PairMessage::Hello { version }
}

fn rejected(code: RejectCode, reason: &str) -> PairMessage {
    PairMessage::Rejected {
        code,
        reason: reason.into(),
    }
}

fn refused(reason: &str) -> PairEvent {
    PairEvent::Refused {
        pid: Some(me()),
        reason: reason.into(),
    }
}

fn violation(reason: &str) -> PairEvent {
    PairEvent::Disconnected {
        reason: Disconnect::Violation(reason.into()),
    }
}

fn leaf_call(id: u64) -> CallRef {
    CallRef {
        side: Side::Leaf,
        id,
    }
}

fn my_call(id: u64) -> CallRef {
    CallRef {
        side: Side::Composition,
        id,
    }
}

fn call(call: CallRef, parent: Option<CallRef>, method: &str, payload: Value) -> PairMessage {
    PairMessage::Call {
        call,
        parent,
        method: method.into(),
        payload,
    }
}

fn result(call: CallRef, outcome: Result<Value, CallError>) -> PairMessage {
    PairMessage::Result { call, outcome }
}

fn error(code: ErrorCode, message: &str) -> Result<Value, CallError> {
    Err(CallError {
        code,
        message: message.into(),
    })
}

fn chunk(call: CallRef, seq: u64, payload: &str) -> PairMessage {
    PairMessage::Chunk {
        call,
        seq,
        payload: payload.into(),
    }
}

#[test]
fn the_leaf_pid_with_the_right_version_is_accepted() {
    let (mut rig, mut leaf) = Rig::connected("accept");
    assert!(rig.pair.connected());
    assert_eq!(rig.events(), []);
    assert_eq!(leaf.read(&mut rig), []);
    assert!(!leaf.closed);
}

#[test]
fn another_version_is_rejected_then_closed() {
    let mut rig = Rig::new("version");
    rig.pair.set_leaf(me());
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION + 1));
    assert_eq!(rig.events(), [refused("版本不對")]);
    leaf.assert_rejected(&mut rig, RejectCode::Version, "版本不對");
    assert!(!rig.pair.connected());
}

#[test]
fn a_pid_other_than_the_leaf_is_rejected_then_closed() {
    let mut rig = Rig::new("pid");
    rig.pair.set_leaf(someone_else());
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events(), [refused("pid 不對")]);
    leaf.assert_rejected(&mut rig, RejectCode::RetryLater, "pid 不對");
    assert!(!rig.pair.connected());
}

#[test]
fn a_leaf_ahead_of_its_own_pid_is_told_to_retry_and_gets_in_once_the_pid_is_updated() {
    // 組合行程手上還是上一個葉子的 pid，新的葉子先連進來。
    let mut rig = Rig::new("stale-pid");
    rig.pair.set_leaf(someone_else());
    let mut early = Leaf::connect(&rig);
    early.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events(), [refused("pid 不對")]);
    early.assert_rejected(&mut rig, RejectCode::RetryLater, "pid 不對");

    rig.pair.set_leaf(me());
    let mut again = Leaf::connect(&rig);
    again.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events(), [PairEvent::Connected { pid: me() }]);
    assert_eq!(again.read(&mut rig), [hello(PAIR_PROTOCOL_VERSION)]);
}

#[test]
fn a_connection_ahead_of_the_leaf_pid_waits_for_it() {
    let mut rig = Rig::new("early");
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    rig.elapsed = PID_WAIT - Duration::from_millis(1);
    assert_eq!(rig.events(), []);
    assert_eq!(leaf.read(&mut rig), []);
    rig.pair.set_leaf(me());
    assert_eq!(rig.events(), [PairEvent::Connected { pid: me() }]);
    assert_eq!(leaf.read(&mut rig), [hello(PAIR_PROTOCOL_VERSION)]);
}

#[test]
fn a_connection_ahead_of_the_leaf_pid_is_rejected_once_the_pid_is_someone_else() {
    let mut rig = Rig::new("early-other");
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events(), []);
    rig.pair.set_leaf(someone_else());
    assert_eq!(rig.events(), [refused("pid 不對")]);
    leaf.assert_rejected(&mut rig, RejectCode::RetryLater, "pid 不對");
}

#[test]
fn a_hello_is_rejected_at_the_deadline_when_no_leaf_pid_came() {
    let mut rig = Rig::new("no-pid");
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.pair.deadline(rig.start), Some(rig.start + PID_WAIT));
    rig.elapsed = PID_WAIT - Duration::from_millis(1);
    assert_eq!(rig.events(), []);
    rig.elapsed = PID_WAIT;
    assert_eq!(rig.events(), [refused("還沒有葉子的 pid")]);
    leaf.assert_rejected(&mut rig, RejectCode::RetryLater, "還沒有葉子的 pid");
    assert_eq!(rig.pair.deadline(rig.start), None);
}

#[test]
fn a_connection_that_never_says_hello_is_rejected_at_the_deadline() {
    let mut rig = Rig::new("silent");
    rig.pair.set_leaf(me());
    let mut leaf = Leaf::connect(&rig);
    // 時限從這一端收下連線的那一步起算。
    rig.step();
    rig.elapsed = PID_WAIT - Duration::from_millis(1);
    assert_eq!(rig.events(), []);
    assert_eq!(leaf.read(&mut rig), []);
    rig.elapsed = PID_WAIT;
    assert_eq!(rig.events(), [refused("沒有在時限內送 hello")]);
    leaf.assert_rejected(&mut rig, RejectCode::Protocol, "沒有在時限內送 hello");
}

#[test]
fn a_second_connection_is_rejected_and_the_first_keeps_working() {
    let (mut rig, mut first) = Rig::connected("second");
    let mut second = Leaf::connect(&rig);
    second.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events(), [refused("已經有連線")]);
    second.assert_rejected(&mut rig, RejectCode::Protocol, "已經有連線");
    first.send(
        &mut rig,
        &call(leaf_call(1), None, "echo", Value::from("還在")),
    );
    assert_eq!(
        rig.events(),
        [PairEvent::Call {
            id: 0,
            parent: None,
            method: "echo".into(),
            payload: Value::from("還在"),
        }]
    );
}

#[test]
fn connections_waiting_to_be_checked_are_capped() {
    let mut rig = Rig::new("pending");
    let mut waiting: Vec<Leaf> = (0..MAX_PENDING).map(|_| Leaf::connect(&rig)).collect();
    assert_eq!(rig.events(), []);
    let mut extra = Leaf::connect(&rig);
    assert_eq!(rig.events(), [refused("等著驗身分的連線太多")]);
    extra.assert_rejected(&mut rig, RejectCode::RetryLater, "等著驗身分的連線太多");
    for leaf in &mut waiting {
        assert_eq!(leaf.read(&mut rig), []);
        assert!(!leaf.closed);
    }

    // 等著的自己斷了就讓出位子；跟新來的同一步到也先判舊的。
    waiting.pop();
    let mut next = Leaf::connect(&rig);
    assert_eq!(rig.events(), []);
    assert_eq!(next.read(&mut rig), []);
    assert!(!next.closed);
}

#[test]
fn anything_before_hello_or_right_after_it_is_rejected() {
    let mut rig = Rig::new("before-hello");
    rig.pair.set_leaf(me());
    let mut leaf = Leaf::connect(&rig);
    leaf.send(
        &mut rig,
        &PairMessage::Register {
            tools: vec![],
            hooks: vec![],
        },
    );
    assert_eq!(rig.events(), [refused("還沒 hello")]);
    leaf.assert_rejected(&mut rig, RejectCode::Protocol, "還沒 hello");

    // `hello` 與下一框一起到：葉子沒等組合行程的 `hello`。
    let mut rig = Rig::new("with-hello");
    let mut leaf = Leaf::connect(&rig);
    let mut bytes = frame(&encode(&hello(PAIR_PROTOCOL_VERSION)));
    bytes.extend(frame(&encode(&PairMessage::Cancel { call: leaf_call(1) })));
    leaf.write(&mut rig, &bytes);
    assert_eq!(rig.events(), [refused("還沒收到 hello 就送別的")]);
    leaf.assert_rejected(&mut rig, RejectCode::Protocol, "還沒收到 hello 就送別的");
}

#[test]
fn register_replaces_the_whole_list() {
    let (mut rig, mut leaf) = Rig::connected("register");
    for (tools, hooks) in [(vec!["a", "b"], vec!["h"]), (vec!["c"], vec![])] {
        let tools: Vec<String> = tools.into_iter().map(String::from).collect();
        let hooks: Vec<String> = hooks.into_iter().map(String::from).collect();
        leaf.send(
            &mut rig,
            &PairMessage::Register {
                tools: tools.clone(),
                hooks: hooks.clone(),
            },
        );
        assert_eq!(rig.events(), [PairEvent::Registered { tools, hooks }]);
    }
}

#[test]
fn attach_goes_to_the_leaf_and_its_answer_comes_back() {
    let (mut rig, mut leaf) = Rig::connected("attach");
    let id = rig.pair.attach("thread-1").unwrap();
    assert_eq!(
        leaf.read(&mut rig),
        [call(
            my_call(id),
            None,
            METHOD_ATTACH,
            serde_json::json!({"threadId": "thread-1"})
        )]
    );
    leaf.send(&mut rig, &result(my_call(id), Ok(Value::Null)));
    assert_eq!(
        rig.events(),
        [PairEvent::Finished {
            id,
            outcome: Ok(Value::Null)
        }]
    );
}

#[test]
fn calls_nest_across_both_directions_and_a_waterfall_shares_its_parent() {
    let (mut rig, mut leaf) = Rig::connected("nest");
    // 葉子叫組合行程，組合行程在那一次裡面回頭叫葉子兩次（waterfall 的前後段），葉子又在第二段裡面叫回來。
    // 葉子在線上用的 id 是 5 與 6，這一端給的本地代號是 0 與 1。
    leaf.send(&mut rig, &call(leaf_call(5), None, "echo", Value::from(1)));
    let outer = Some(leaf_call(5));
    let local = Some(leaf_call(0));
    let before = rig.pair.call(local, "before", Value::from("a")).unwrap();
    let after = rig.pair.call(local, "after", Value::from("b")).unwrap();
    assert_eq!(
        rig.pair.call(outer, "x", Value::Null),
        Err(SendError::BadParent),
        "線上的 id 不是本地代號"
    );
    assert_ne!(before, after);
    assert_eq!(
        leaf.read(&mut rig),
        [
            call(my_call(before), outer, "before", Value::from("a")),
            call(my_call(after), outer, "after", Value::from("b")),
        ]
    );
    let inner = Some(my_call(after));
    leaf.send(&mut rig, &call(leaf_call(6), inner, "echo", Value::from(2)));
    leaf.send(&mut rig, &result(my_call(before), Ok(Value::from("A"))));
    assert_eq!(rig.pair.finish(1, Ok(Value::from(20))), Ok(()));
    leaf.send(
        &mut rig,
        &result(my_call(after), error(ErrorCode::ServiceError, "壞了")),
    );
    assert_eq!(rig.pair.finish(0, Ok(Value::from(10))), Ok(()));
    assert_eq!(
        rig.events(),
        [
            PairEvent::Call {
                id: 0,
                parent: None,
                method: "echo".into(),
                payload: Value::from(1),
            },
            PairEvent::Call {
                id: 1,
                parent: inner,
                method: "echo".into(),
                payload: Value::from(2),
            },
            PairEvent::Finished {
                id: before,
                outcome: Ok(Value::from("A")),
            },
            PairEvent::Finished {
                id: after,
                outcome: Err(Failure::Error(CallError {
                    code: ErrorCode::ServiceError,
                    message: "壞了".into(),
                })),
            },
        ]
    );
    assert_eq!(
        leaf.read(&mut rig),
        [
            result(leaf_call(6), Ok(Value::from(20))),
            result(leaf_call(5), Ok(Value::from(10))),
        ]
    );
}

#[test]
fn a_parent_that_is_not_running_fails_only_that_call() {
    let (mut rig, mut leaf) = Rig::connected("parent");
    for parent in [leaf_call(9), my_call(9)] {
        leaf.send(
            &mut rig,
            &call(leaf_call(1), Some(parent), "echo", Value::Null),
        );
        assert_eq!(
            leaf.read(&mut rig),
            [result(
                leaf_call(1),
                error(ErrorCode::BadPayload, "parent 不在跑")
            )]
        );
        assert_eq!(
            rig.pair.call(Some(parent), "x", Value::Null),
            Err(SendError::BadParent)
        );
    }
    assert_eq!(rig.events(), []);
    assert!(rig.pair.connected());
}

#[test]
fn an_unknown_method_fails_only_that_call() {
    let (mut rig, mut leaf) = Rig::connected("method");
    leaf.send(&mut rig, &call(leaf_call(1), None, "nope", Value::Null));
    assert_eq!(
        leaf.read(&mut rig),
        [result(
            leaf_call(1),
            error(ErrorCode::UnknownMethod, "nope")
        )]
    );
    // 名稱長的只帶回前 `METHOD_ECHO_BYTES` 個位元組，切在字元邊界（「長」三個位元組，64 不是 3 的倍數）。
    let long = "長".repeat(MAX_FRAME / 4);
    leaf.send(&mut rig, &call(leaf_call(2), None, &long, Value::Null));
    let kept = "長".repeat(METHOD_ECHO_BYTES / 3);
    assert_eq!(
        leaf.read(&mut rig),
        [result(leaf_call(2), error(ErrorCode::UnknownMethod, &kept))]
    );
    assert_eq!(rig.events(), []);
    assert!(rig.pair.connected());
}

#[test]
fn chunks_stream_both_ways_in_order() {
    let (mut rig, mut leaf) = Rig::connected("chunks");
    leaf.send(&mut rig, &call(leaf_call(1), None, "stream", Value::Null));
    assert_eq!(rig.pair.chunk(0, "甲"), Ok(()));
    assert_eq!(rig.pair.chunk(0, "乙"), Ok(()));
    assert_eq!(rig.pair.finish(0, Ok(Value::Null)), Ok(()));
    assert_eq!(rig.pair.chunk(0, "丙"), Err(SendError::NotRunning));
    assert_eq!(
        leaf.read(&mut rig),
        [
            chunk(leaf_call(1), 0, "甲"),
            chunk(leaf_call(1), 1, "乙"),
            result(leaf_call(1), Ok(Value::Null)),
        ]
    );
    rig.events();

    let id = rig.pair.call(None, "tail", Value::Null).unwrap();
    leaf.read(&mut rig);
    leaf.send(&mut rig, &chunk(my_call(id), 0, "一"));
    leaf.send(&mut rig, &chunk(my_call(id), 1, "二"));
    leaf.send(&mut rig, &result(my_call(id), Ok(Value::from("完"))));
    assert_eq!(
        rig.events(),
        [
            PairEvent::Chunk {
                id,
                seq: 0,
                payload: "一".into()
            },
            PairEvent::Chunk {
                id,
                seq: 1,
                payload: "二".into()
            },
            PairEvent::Finished {
                id,
                outcome: Ok(Value::from("完"))
            },
        ]
    );
}

#[test]
fn a_chunk_over_the_limit_ends_that_call_as_too_large() {
    let (mut rig, mut leaf) = Rig::connected("chunk-size");
    leaf.send(&mut rig, &call(leaf_call(1), None, "stream", Value::Null));
    // 上限剛好的一塊，全是編出來六倍長的控制字元：照送。
    let worst = "\u{1}".repeat(MAX_CHUNK_BYTES);
    assert_eq!(rig.pair.chunk(0, &worst), Ok(()));
    assert_eq!(leaf.read(&mut rig), [chunk(leaf_call(1), 0, &worst)]);
    let over = "x".repeat(MAX_CHUNK_BYTES + 1);
    assert_eq!(rig.pair.chunk(0, &over), Err(SendError::TooLarge));
    assert_eq!(
        leaf.read(&mut rig),
        [result(
            leaf_call(1),
            error(ErrorCode::TooLarge, "一塊超過上限")
        )]
    );
    assert_eq!(rig.pair.chunk(0, "x"), Err(SendError::NotRunning));
    assert!(rig.pair.connected());
}

#[test]
fn a_result_or_call_over_a_frame_never_reaches_the_wire() {
    let (mut rig, mut leaf) = Rig::connected("frame-size");
    let huge = Value::from("x".repeat(MAX_FRAME));
    leaf.send(&mut rig, &call(leaf_call(1), None, "echo", Value::Null));
    assert_eq!(rig.pair.finish(0, Ok(huge.clone())), Ok(()));
    assert_eq!(
        leaf.read(&mut rig),
        [result(
            leaf_call(1),
            error(ErrorCode::TooLarge, "結果超過一框")
        )]
    );
    assert_eq!(rig.pair.call(None, "big", huge), Err(SendError::TooLarge));
    assert_eq!(leaf.read(&mut rig), []);
    // 沒送出去的那一次不佔編號。
    assert_eq!(rig.pair.call(None, "small", Value::Null), Ok(0));
    assert!(rig.pair.connected());
}

#[test]
fn cancel_works_in_both_directions_and_every_call_still_gets_one_result() {
    let (mut rig, mut leaf) = Rig::connected("cancel");
    leaf.send(&mut rig, &call(leaf_call(1), None, "echo", Value::Null));
    leaf.send(&mut rig, &PairMessage::Cancel { call: leaf_call(1) });
    // 已經結束的與從來沒有的，不回任何東西。
    leaf.send(&mut rig, &PairMessage::Cancel { call: leaf_call(1) });
    leaf.send(&mut rig, &PairMessage::Cancel { call: leaf_call(2) });
    assert_eq!(
        rig.pair.finish(0, Ok(Value::from("太晚"))),
        Err(SendError::NotRunning)
    );
    assert_eq!(
        leaf.read(&mut rig),
        [result(leaf_call(1), error(ErrorCode::Cancelled, ""))]
    );
    assert_eq!(
        rig.events(),
        [
            PairEvent::Call {
                id: 0,
                parent: None,
                method: "echo".into(),
                payload: Value::Null,
            },
            PairEvent::Cancelled { id: 0 },
        ]
    );

    let id = rig.pair.call(None, "slow", Value::Null).unwrap();
    rig.pair.cancel(id);
    assert_eq!(
        leaf.read(&mut rig),
        [
            call(my_call(id), None, "slow", Value::Null),
            PairMessage::Cancel { call: my_call(id) },
        ]
    );
    assert_eq!(rig.events(), []);
    leaf.send(
        &mut rig,
        &result(my_call(id), error(ErrorCode::Cancelled, "")),
    );
    assert_eq!(
        rig.events(),
        [PairEvent::Finished {
            id,
            outcome: Err(Failure::Error(CallError {
                code: ErrorCode::Cancelled,
                message: String::new(),
            })),
        }]
    );
    rig.pair.cancel(id);
    assert_eq!(leaf.read(&mut rig), []);
}

#[test]
fn calls_past_the_limit_are_busy_in_each_direction() {
    let (mut rig, mut leaf) = Rig::connected("busy");
    for id in 0..MAX_CALLS as u64 {
        leaf.send(&mut rig, &call(leaf_call(id), None, "echo", Value::Null));
    }
    assert_eq!(rig.events().len(), MAX_CALLS);
    assert_eq!(leaf.read(&mut rig), []);
    leaf.send(&mut rig, &call(leaf_call(64), None, "echo", Value::Null));
    assert_eq!(
        leaf.read(&mut rig),
        [result(
            leaf_call(64),
            error(ErrorCode::Busy, "同時在跑的呼叫已經到上限")
        )]
    );
    assert_eq!(rig.pair.finish(0, Ok(Value::Null)), Ok(()));
    leaf.send(&mut rig, &call(leaf_call(64), None, "echo", Value::Null));
    assert_eq!(leaf.read(&mut rig), [result(leaf_call(0), Ok(Value::Null))]);

    for _ in 0..MAX_CALLS {
        rig.pair.call(None, "x", Value::Null).unwrap();
    }
    assert_eq!(rig.pair.call(None, "x", Value::Null), Err(SendError::Busy));
    assert!(rig.pair.connected());
}

#[test]
fn every_protocol_violation_is_rejected_then_closed() {
    let running = call(leaf_call(1), None, "echo", Value::Null);
    let cases: Vec<(&str, Vec<PairMessage>)> = vec![
        ("又送了一次 hello", vec![hello(PAIR_PROTOCOL_VERSION)]),
        (
            "葉子不送 rejected",
            vec![rejected(RejectCode::Protocol, "x")],
        ),
        (
            "方向不對",
            vec![call(my_call(1), None, "echo", Value::Null)],
        ),
        ("方向不對", vec![chunk(leaf_call(1), 0, "")]),
        ("方向不對", vec![result(leaf_call(1), Ok(Value::Null))]),
        ("方向不對", vec![PairMessage::Cancel { call: my_call(0) }]),
        ("重複的呼叫編號", vec![running.clone(), running]),
        ("不在跑的呼叫", vec![chunk(my_call(1), 0, "")]),
        ("不在跑的呼叫", vec![result(my_call(1), Ok(Value::Null))]),
        // 組合行程發的第 0 號還在跑，葉子的第一塊卻帶 seq 1。
        ("seq 沒接上", vec![chunk(my_call(0), 1, "")]),
    ];
    for (reason, frames) in cases {
        let (mut rig, mut leaf) = Rig::connected("violation");
        assert_eq!(rig.pair.call(None, "pending", Value::Null), Ok(0));
        leaf.read(&mut rig);
        for message in &frames {
            leaf.send(&mut rig, message);
        }
        assert_eq!(rig.events().last(), Some(&violation(reason)), "{frames:?}");
        leaf.assert_rejected(&mut rig, RejectCode::Protocol, reason);
        assert!(!rig.pair.connected());
    }
}

#[test]
fn every_invalid_vector_is_rejected_then_closed() {
    let vectors = json::parse(include_bytes!("../../pair-vectors.json")).unwrap();
    let group = |name: &str| vectors.get(name).and_then(Value::as_array).unwrap().clone();
    let text =
        |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).unwrap().to_string();
    let unhex = |hex: &str| -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    };
    let mut inputs: Vec<(String, Vec<u8>, String)> = Vec::new();
    for entry in group("invalidMessages") {
        let bytes = frame(text(&entry, "json").as_bytes());
        inputs.push((text(&entry, "name"), bytes, text(&entry, "error")));
    }
    for entry in group("invalidBytes") {
        let bytes = frame(&unhex(&text(&entry, "hex")));
        inputs.push((text(&entry, "name"), bytes, text(&entry, "error")));
    }
    for entry in group("invalidFrames") {
        if text(&entry, "expect") == "error" {
            let bytes = unhex(&text(&entry, "hex"));
            inputs.push((text(&entry, "name"), bytes, "框太大".into()));
        }
    }
    let over = encode(&chunk(my_call(0), 0, &"x".repeat(MAX_CHUNK_BYTES + 1)));
    inputs.push(("一塊超過上限".into(), frame(&over), "塊太大".into()));
    assert!(inputs.len() > 40);
    for (name, bytes, reason) in inputs {
        let (mut rig, mut leaf) = Rig::connected("invalid");
        leaf.write(&mut rig, &bytes);
        assert_eq!(rig.events(), [violation(&reason)], "{name}");
        leaf.assert_rejected(&mut rig, RejectCode::Protocol, &reason);
    }
}

#[test]
fn a_frame_exactly_at_the_limit_is_taken() {
    let (mut rig, mut leaf) = Rig::connected("limit");
    let empty = encode(&call(leaf_call(1), None, "echo", Value::from(""))).len();
    let payload = Value::from("x".repeat(MAX_FRAME - empty));
    let message = call(leaf_call(1), None, "echo", payload.clone());
    assert_eq!(encode(&message).len(), MAX_FRAME);
    leaf.send(&mut rig, &message);
    assert_eq!(
        rig.events(),
        [PairEvent::Call {
            id: 0,
            parent: None,
            method: "echo".into(),
            payload,
        }]
    );
}

#[test]
fn when_the_leaf_hangs_up_unanswered_calls_end_as_peer_gone_and_the_pid_is_void() {
    let (mut rig, mut leaf) = Rig::connected("hangup");
    let first = rig.pair.call(None, "a", Value::Null).unwrap();
    let second = rig.pair.attach("t").unwrap();
    leaf.send(&mut rig, &call(leaf_call(3), None, "echo", Value::Null));
    rig.events();
    drop(leaf);
    assert_eq!(
        rig.events(),
        [
            PairEvent::Finished {
                id: first,
                outcome: Err(Failure::PeerGone),
            },
            PairEvent::Finished {
                id: second,
                outcome: Err(Failure::PeerGone),
            },
            PairEvent::Cancelled { id: 0 },
            PairEvent::Disconnected {
                reason: Disconnect::Closed
            },
        ]
    );
    assert!(!rig.pair.connected());
    assert_eq!(
        rig.pair.call(None, "a", Value::Null),
        Err(SendError::NotConnected)
    );

    // 同一個 pid 再連：要等監督行程再給一次。
    let mut again = Leaf::connect(&rig);
    again.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events(), []);
    assert_eq!(again.read(&mut rig), []);
    rig.pair.set_leaf(me());
    assert_eq!(rig.events(), [PairEvent::Connected { pid: me() }]);
    assert_eq!(again.read(&mut rig), [hello(PAIR_PROTOCOL_VERSION)]);
}

#[test]
fn a_new_leaf_pid_drops_the_connection_it_replaces() {
    let (mut rig, mut leaf) = Rig::connected("replace");
    rig.pair.call(None, "a", Value::Null).unwrap();
    rig.pair.set_leaf(someone_else());
    assert_eq!(
        rig.events().last(),
        Some(&PairEvent::Disconnected {
            reason: Disconnect::Replaced
        })
    );
    leaf.read(&mut rig);
    assert!(leaf.closed);
}

/// 葉子不讀：組合行程一直發到 [`Pair::paused`]。回發出去的 `id`。
fn fill_until_paused(rig: &mut Rig) -> Vec<u64> {
    let payload = Value::from("x".repeat(64 * 1024));
    let mut ids = Vec::new();
    while !rig.pair.paused() {
        ids.push(rig.pair.call(None, "fill", payload.clone()).unwrap());
        rig.step();
    }
    assert!(ids.len() < MAX_CALLS);
    ids
}

#[test]
fn at_the_pause_line_it_refuses_its_own_new_work_and_keeps_reading() {
    let (mut rig, mut leaf) = Rig::connected("pause");
    leaf.send(&mut rig, &call(leaf_call(1), None, "stream", Value::Null));
    rig.events();
    let ids = fill_until_paused(&mut rig);
    assert!(rig.pair.queued() >= OUTBOX_PAUSE);
    assert_eq!(
        rig.pair.call(None, "more", Value::Null),
        Err(SendError::Paused)
    );
    assert_eq!(rig.pair.chunk(0, "x"), Err(SendError::Paused));
    let over = "x".repeat(MAX_CHUNK_BYTES + 1);
    assert_eq!(rig.pair.chunk(0, &over), Err(SendError::Paused));
    assert_eq!(
        rig.pair.finish(0, Ok(Value::from("完"))),
        Err(SendError::Paused)
    );
    let queued = rig.pair.queued();

    // 葉子送來的照讀照處理。
    let register = PairMessage::Register {
        tools: vec!["t".into()],
        hooks: vec![],
    };
    leaf.send(&mut rig, &register);
    assert_eq!(
        rig.events(),
        [PairEvent::Registered {
            tools: vec!["t".into()],
            hooks: vec![],
        }]
    );
    assert!(rig.pair.paused());

    // 取消照排。
    rig.pair.cancel(ids[0]);
    assert!(rig.pair.queued() > queued);

    let read = leaf.read(&mut rig);
    assert_eq!(read.len(), ids.len() + 1);
    assert_eq!(
        read.last(),
        Some(&PairMessage::Cancel {
            call: my_call(ids[0])
        })
    );
    assert!(!rig.pair.paused());
    // 被擋過的那一次還在跑：等到 `Resumed` 再送就送得出去。
    assert_eq!(rig.events(), [PairEvent::Resumed]);
    assert_eq!(rig.pair.finish(0, Ok(Value::from("完"))), Ok(()));
    assert_eq!(
        leaf.read(&mut rig),
        [result(leaf_call(1), Ok(Value::from("完")))]
    );
    assert_eq!(rig.events(), []);
    assert_eq!(rig.pair.deadline(rig.start), None);
}

#[test]
fn resumed_is_not_reported_when_nothing_was_refused() {
    let (mut rig, mut leaf) = Rig::connected("no-resume");
    let ids = fill_until_paused(&mut rig);
    assert_eq!(leaf.read(&mut rig).len(), ids.len());
    assert!(!rig.pair.paused());
    assert_eq!(rig.events(), []);
}

#[test]
fn past_the_outbox_limit_the_connection_is_dropped() {
    let (mut rig, mut leaf) = Rig::connected("overflow");
    fill_until_paused(&mut rig);
    // 葉子不讀、一直發這裡沒有的 method：自動回的錯誤都是小框、照排，排到上限就斷。
    // 一框 `unknown_method` 的 `result` 至少 64 個位元組，排滿之前送不到這麼多個。
    let most = (OUTBOX_LIMIT / 64) as u64;
    let mut sent = 0;
    while rig.pair.connected() {
        assert!(sent < most, "排了 {sent} 個拒絕還沒斷");
        leaf.send(&mut rig, &call(leaf_call(sent), None, "沒有", Value::Null));
        sent += 1;
        assert!(rig.pair.queued() <= OUTBOX_LIMIT);
    }
    assert!(sent > MAX_CALLS as u64, "被拒的不佔同時在跑的名額");
    assert_eq!(
        rig.events().last(),
        Some(&PairEvent::Disconnected {
            reason: Disconnect::Overflow
        })
    );
    leaf.read(&mut rig);
    assert!(leaf.closed);
}

#[test]
fn when_both_ends_are_past_the_pause_line_it_still_reads_and_drops_a_silent_leaf_at_the_stall_timeout(
) {
    let (mut rig, mut leaf) = Rig::connected("stall");
    let ids = fill_until_paused(&mut rig);
    // 葉子也送一個 kernel 的 buffer 裝不下的大框、而且不讀：這一端暫停著也把它讀完。
    let big = Value::from("y".repeat(900 * 1024));
    leaf.send(&mut rig, &result(my_call(ids[0]), Ok(big.clone())));
    assert!(rig.pair.paused());
    assert_eq!(
        rig.events(),
        [PairEvent::Finished {
            id: ids[0],
            outcome: Ok(big),
        }]
    );

    // 葉子一直不讀：送端沒有寫出任何位元組，到時限就斷，還在跑的各有一個終點。
    assert_eq!(
        rig.pair.deadline(rig.start),
        Some(rig.start + STALL_TIMEOUT)
    );
    rig.elapsed = STALL_TIMEOUT - Duration::from_millis(1);
    assert_eq!(rig.events(), []);
    assert!(rig.pair.connected());
    rig.elapsed = STALL_TIMEOUT;
    let mut expected: Vec<PairEvent> = ids[1..]
        .iter()
        .map(|&id| PairEvent::Finished {
            id,
            outcome: Err(Failure::PeerGone),
        })
        .collect();
    expected.push(PairEvent::Disconnected {
        reason: Disconnect::Stalled,
    });
    assert_eq!(rig.events(), expected);
    assert_eq!(rig.pair.deadline(rig.start), None);
    leaf.read(&mut rig);
    assert!(leaf.closed);
}

#[test]
fn any_byte_written_restarts_the_stall_clock() {
    let (mut rig, mut leaf) = Rig::connected("stall-progress");
    fill_until_paused(&mut rig);
    let almost = STALL_TIMEOUT - Duration::from_millis(1);
    rig.elapsed = almost;
    rig.step();
    // 葉子把 socket 裡的讀走（不走 `step`），這一端下一步就寫得出去一些。
    let before = rig.pair.queued();
    let mut sink = [0u8; 64 * 1024];
    while leaf.stream.read(&mut sink).is_ok_and(|n| n > 0) {}
    rig.step();
    assert!(rig.pair.queued() < before);
    assert_eq!(
        rig.pair.deadline(rig.start),
        Some(rig.start + almost + STALL_TIMEOUT)
    );
    rig.elapsed = almost + almost;
    rig.step();
    assert!(rig.pair.connected());
    rig.elapsed = almost + STALL_TIMEOUT;
    assert_eq!(
        rig.events().last(),
        Some(&PairEvent::Disconnected {
            reason: Disconnect::Stalled
        })
    );
}

#[test]
fn the_deadline_is_now_while_something_waits_for_the_next_step() {
    let mut rig = Rig::new("due");
    let now = rig.start + Duration::from_millis(1);

    // 等著的連線送過 hello，pid 一到就判得出來：不用等到它的時限。
    let mut ahead = Leaf::connect(&rig);
    ahead.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.pair.deadline(now), Some(rig.start + PID_WAIT));
    rig.pair.set_leaf(me());
    assert_eq!(rig.pair.deadline(now), Some(now));
    assert_eq!(rig.events(), [PairEvent::Connected { pid: me() }]);
    assert_eq!(rig.pair.deadline(now), None);

    // 換 pid 斷掉連線的那幾筆事，還沒被 step 拿走。
    rig.pair.set_leaf(someone_else());
    assert_eq!(rig.pair.deadline(now), Some(now));
    assert_eq!(
        rig.events(),
        [PairEvent::Disconnected {
            reason: Disconnect::Replaced
        }]
    );
    assert_eq!(rig.pair.deadline(now), None);

    // 等著的連線還沒送 hello，pid 到了而且不是它。
    let mut rig = Rig::new("due-other");
    let _waiting = Leaf::connect(&rig);
    rig.step();
    rig.pair.set_leaf(someone_else());
    assert_eq!(rig.pair.deadline(now), Some(now));
    drop(ahead);
}

fn leaf_calls(id: u64, local: u64) -> (PairMessage, PairEvent) {
    let event = PairEvent::Call {
        id: local,
        parent: None,
        method: "stream".into(),
        payload: Value::Null,
    };
    (call(leaf_call(id), None, "stream", Value::Null), event)
}

#[test]
fn late_work_for_an_old_call_never_lands_on_a_new_one() {
    let (mut rig, mut leaf) = Rig::connected("stale");
    // 葉子取消之後用同一個 id 再發：本地代號不一樣，舊工作晚到的塊與結果對不到新的那一次。
    let (first, first_event) = leaf_calls(1, 0);
    let (again, again_event) = leaf_calls(1, 1);
    leaf.send(&mut rig, &first);
    leaf.send(&mut rig, &PairMessage::Cancel { call: leaf_call(1) });
    leaf.send(&mut rig, &again);
    assert_eq!(
        rig.events(),
        [first_event, PairEvent::Cancelled { id: 0 }, again_event]
    );
    assert_eq!(rig.pair.chunk(0, "舊的"), Err(SendError::NotRunning));
    assert_eq!(
        rig.pair.finish(0, Ok(Value::from("舊的"))),
        Err(SendError::NotRunning)
    );
    assert_eq!(rig.pair.finish(1, Ok(Value::from("新的"))), Ok(()));
    assert_eq!(
        leaf.read(&mut rig),
        [
            result(leaf_call(1), error(ErrorCode::Cancelled, "")),
            result(leaf_call(1), Ok(Value::from("新的"))),
        ]
    );

    // 換了連線，代號接著編，不從頭來。
    let (old, old_event) = leaf_calls(7, 2);
    leaf.send(&mut rig, &old);
    assert_eq!(rig.events(), [old_event]);
    drop(leaf);
    assert_eq!(
        rig.events(),
        [
            PairEvent::Cancelled { id: 2 },
            PairEvent::Disconnected {
                reason: Disconnect::Closed
            },
        ]
    );
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    rig.pair.set_leaf(me());
    assert_eq!(rig.events(), [PairEvent::Connected { pid: me() }]);
    let (new, new_event) = leaf_calls(7, 3);
    leaf.send(&mut rig, &new);
    assert_eq!(rig.events(), [new_event]);
    assert_eq!(rig.pair.chunk(2, "舊連線的"), Err(SendError::NotRunning));
    assert_eq!(
        rig.pair.finish(2, Ok(Value::from("舊連線的"))),
        Err(SendError::NotRunning)
    );
    assert_eq!(leaf.read(&mut rig), [hello(PAIR_PROTOCOL_VERSION)]);
}

/// 葉子不讀，排到送端有寫不出去的、但還沒到暫停線。回排了幾框。
fn queue_some(rig: &mut Rig) -> usize {
    let payload = Value::from("x".repeat(64 * 1024));
    let mut frames = 0;
    while rig.pair.queued() == 0 {
        rig.pair.call(None, "fill", payload.clone()).unwrap();
        frames += 1;
    }
    assert!(!rig.pair.paused());
    frames
}

#[test]
fn a_rejected_behind_queued_frames_arrives_once_the_leaf_reads() {
    let (mut rig, mut leaf) = Rig::connected("linger");
    let frames = queue_some(&mut rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events().last(), Some(&violation("又送了一次 hello")));
    assert!(!rig.pair.connected());
    assert_eq!(
        rig.pair.deadline(rig.start),
        Some(rig.start + CLOSE_TIMEOUT)
    );
    let read = leaf.read(&mut rig);
    assert_eq!(read.len(), frames + 1);
    assert_eq!(
        read.last(),
        Some(&rejected(RejectCode::Protocol, "又送了一次 hello"))
    );
    assert!(leaf.closed);
    assert_eq!(rig.pair.deadline(rig.start), None);
}

#[test]
fn a_rejected_the_leaf_never_reads_is_dropped_at_the_close_timeout() {
    let (mut rig, mut leaf) = Rig::connected("linger-timeout");
    queue_some(&mut rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    rig.events();
    rig.elapsed = CLOSE_TIMEOUT - Duration::from_millis(1);
    rig.step();
    assert_eq!(
        rig.pair.deadline(rig.start),
        Some(rig.start + CLOSE_TIMEOUT)
    );
    rig.elapsed = CLOSE_TIMEOUT;
    rig.step();
    assert_eq!(rig.pair.deadline(rig.start), None);
    // 關了之後葉子只讀得到已經進 socket 的那一段，沒有 `rejected`。
    let mut rest = Vec::new();
    leaf.stream.set_nonblocking(false).unwrap();
    leaf.stream.read_to_end(&mut rest).unwrap();
    let mut last = None;
    while let Ok(Some(payload)) = take_frame_within(&mut rest, MAX_FRAME) {
        last = Some(decode(&payload).unwrap());
    }
    assert_ne!(
        last,
        Some(rejected(RejectCode::Protocol, "又送了一次 hello"))
    );
}

#[test]
fn the_same_leaf_pid_given_again_also_drops_the_connection() {
    let (mut rig, mut leaf) = Rig::connected("same-pid");
    rig.pair.set_leaf(me());
    assert_eq!(
        rig.events(),
        [PairEvent::Disconnected {
            reason: Disconnect::Replaced
        }]
    );
    leaf.read(&mut rig);
    assert!(leaf.closed);
}
