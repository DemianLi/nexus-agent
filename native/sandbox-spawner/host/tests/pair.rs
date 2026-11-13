//! 橋在組合行程那一端（[`nexus_host::pair`]，#2583）：測試行程自己連進來當葉子，所以 `SO_PEERCRED` 讀到的 pid 就是測試行程的。
//!
//! 單執行緒、不睡：葉子寫完就叫 [`Rig::step`]，寫進 socket 的當下就讀得到；時限用傳進去的時間推。

use nexus_host::host_protocol::{CallError, ErrorCode};
use nexus_host::json::{self, Value};
use nexus_host::pair::{Disconnect, Failure, Pair, PairEvent, SendError};
use nexus_host::pair_protocol::{
    decode, encode, CallRef, PairMessage, Side, HELLO_TIMEOUT, MAX_CALLS, MAX_CHUNK_BYTES,
    MAX_FRAME, MAX_PENDING, METHOD_ATTACH, OUTBOX_LIMIT, OUTBOX_PAUSE, PAIR_PROTOCOL_VERSION,
};
use nexus_sandbox_spawner::protocol::{frame, take_frame_within};
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
        while !bytes.is_empty() {
            match self.stream.write(bytes) {
                Ok(n) => bytes = &bytes[n..],
                Err(err) if err.kind() == ErrorKind::WouldBlock => rig.step(),
                Err(_) => break,
            }
        }
        rig.step();
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

    /// 剩下的只有 `rejected{reason}`，之後連線關了。
    fn assert_rejected(&mut self, rig: &mut Rig, reason: &str) {
        assert_eq!(self.read(rig), [rejected(reason)]);
        assert!(self.closed, "{reason}：送完 rejected 要關");
    }
}

fn hello(version: u32) -> PairMessage {
    PairMessage::Hello { version }
}

fn rejected(reason: &str) -> PairMessage {
    PairMessage::Rejected {
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
    leaf.assert_rejected(&mut rig, "版本不對");
    assert!(!rig.pair.connected());
}

#[test]
fn a_pid_other_than_the_leaf_is_rejected_then_closed() {
    let mut rig = Rig::new("pid");
    rig.pair.set_leaf(someone_else());
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events(), [refused("pid 不對")]);
    leaf.assert_rejected(&mut rig, "pid 不對");
    assert!(!rig.pair.connected());
}

#[test]
fn a_connection_ahead_of_the_leaf_pid_waits_for_it() {
    let mut rig = Rig::new("early");
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    rig.elapsed = HELLO_TIMEOUT - Duration::from_millis(1);
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
    leaf.assert_rejected(&mut rig, "pid 不對");
}

#[test]
fn a_hello_is_rejected_at_the_deadline_when_no_leaf_pid_came() {
    let mut rig = Rig::new("no-pid");
    let mut leaf = Leaf::connect(&rig);
    leaf.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(
        rig.pair.deadline(rig.start),
        Some(rig.start + HELLO_TIMEOUT)
    );
    rig.elapsed = HELLO_TIMEOUT - Duration::from_millis(1);
    assert_eq!(rig.events(), []);
    rig.elapsed = HELLO_TIMEOUT;
    assert_eq!(rig.events(), [refused("還沒有葉子的 pid")]);
    leaf.assert_rejected(&mut rig, "還沒有葉子的 pid");
    assert_eq!(rig.pair.deadline(rig.start), None);
}

#[test]
fn a_connection_that_never_says_hello_is_rejected_at_the_deadline() {
    let mut rig = Rig::new("silent");
    rig.pair.set_leaf(me());
    let mut leaf = Leaf::connect(&rig);
    // 時限從這一端收下連線的那一步起算。
    rig.step();
    rig.elapsed = HELLO_TIMEOUT - Duration::from_millis(1);
    assert_eq!(rig.events(), []);
    assert_eq!(leaf.read(&mut rig), []);
    rig.elapsed = HELLO_TIMEOUT;
    assert_eq!(rig.events(), [refused("沒有在時限內送 hello")]);
    leaf.assert_rejected(&mut rig, "沒有在時限內送 hello");
}

#[test]
fn a_second_connection_is_rejected_and_the_first_keeps_working() {
    let (mut rig, mut first) = Rig::connected("second");
    let mut second = Leaf::connect(&rig);
    second.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.events(), [refused("已經有連線")]);
    second.assert_rejected(&mut rig, "已經有連線");
    first.send(
        &mut rig,
        &call(leaf_call(1), None, "echo", Value::from("還在")),
    );
    assert_eq!(
        rig.events(),
        [PairEvent::Call {
            id: 1,
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
    extra.assert_rejected(&mut rig, "等著驗身分的連線太多");
    for leaf in &mut waiting {
        assert_eq!(leaf.read(&mut rig), []);
        assert!(!leaf.closed);
    }
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
    leaf.assert_rejected(&mut rig, "還沒 hello");

    // `hello` 與下一框一起到：葉子沒等組合行程的 `hello`。
    let mut rig = Rig::new("with-hello");
    let mut leaf = Leaf::connect(&rig);
    let mut bytes = frame(&encode(&hello(PAIR_PROTOCOL_VERSION)));
    bytes.extend(frame(&encode(&PairMessage::Cancel { call: leaf_call(1) })));
    leaf.write(&mut rig, &bytes);
    assert_eq!(rig.events(), [refused("還沒收到 hello 就送別的")]);
    leaf.assert_rejected(&mut rig, "還沒收到 hello 就送別的");
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
    leaf.send(&mut rig, &call(leaf_call(5), None, "echo", Value::from(1)));
    let outer = Some(leaf_call(5));
    let before = rig.pair.call(outer, "before", Value::from("a")).unwrap();
    let after = rig.pair.call(outer, "after", Value::from("b")).unwrap();
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
    rig.pair.finish(6, Ok(Value::from(20)));
    leaf.send(
        &mut rig,
        &result(my_call(after), error(ErrorCode::ServiceError, "壞了")),
    );
    rig.pair.finish(5, Ok(Value::from(10)));
    assert_eq!(
        rig.events(),
        [
            PairEvent::Call {
                id: 5,
                parent: None,
                method: "echo".into(),
                payload: Value::from(1),
            },
            PairEvent::Call {
                id: 6,
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
    assert_eq!(rig.events(), []);
    assert!(rig.pair.connected());
}

#[test]
fn chunks_stream_both_ways_in_order() {
    let (mut rig, mut leaf) = Rig::connected("chunks");
    leaf.send(&mut rig, &call(leaf_call(1), None, "stream", Value::Null));
    assert_eq!(rig.pair.chunk(1, "甲"), Ok(()));
    assert_eq!(rig.pair.chunk(1, "乙"), Ok(()));
    rig.pair.finish(1, Ok(Value::Null));
    assert_eq!(rig.pair.chunk(1, "丙"), Err(SendError::NotRunning));
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
    assert_eq!(rig.pair.chunk(1, &worst), Ok(()));
    assert_eq!(leaf.read(&mut rig), [chunk(leaf_call(1), 0, &worst)]);
    let over = "x".repeat(MAX_CHUNK_BYTES + 1);
    assert_eq!(rig.pair.chunk(1, &over), Err(SendError::TooLarge));
    assert_eq!(
        leaf.read(&mut rig),
        [result(
            leaf_call(1),
            error(ErrorCode::TooLarge, "一塊超過上限")
        )]
    );
    assert_eq!(rig.pair.chunk(1, "x"), Err(SendError::NotRunning));
    assert!(rig.pair.connected());
}

#[test]
fn a_result_or_call_over_a_frame_never_reaches_the_wire() {
    let (mut rig, mut leaf) = Rig::connected("frame-size");
    let huge = Value::from("x".repeat(MAX_FRAME));
    leaf.send(&mut rig, &call(leaf_call(1), None, "echo", Value::Null));
    rig.pair.finish(1, Ok(huge.clone()));
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
    rig.pair.finish(1, Ok(Value::from("太晚")));
    assert_eq!(
        leaf.read(&mut rig),
        [result(leaf_call(1), error(ErrorCode::Cancelled, ""))]
    );
    assert_eq!(
        rig.events(),
        [
            PairEvent::Call {
                id: 1,
                parent: None,
                method: "echo".into(),
                payload: Value::Null,
            },
            PairEvent::Cancelled { id: 1 },
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
    rig.pair.finish(0, Ok(Value::Null));
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
        ("葉子不送 rejected", vec![rejected("x")]),
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
        // 組合行程發的第 0 號還在跑，葉子的塊從 1 起。
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
        leaf.assert_rejected(&mut rig, reason);
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
        leaf.assert_rejected(&mut rig, &reason);
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
            id: 1,
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
            PairEvent::Cancelled { id: 3 },
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
fn at_the_pause_line_it_stops_reading_and_refuses_new_calls_until_drained() {
    let (mut rig, mut leaf) = Rig::connected("pause");
    leaf.send(&mut rig, &call(leaf_call(1), None, "stream", Value::Null));
    rig.events();
    let ids = fill_until_paused(&mut rig);
    assert!(rig.pair.queued() >= OUTBOX_PAUSE);
    assert_eq!(
        rig.pair.call(None, "more", Value::Null),
        Err(SendError::Paused)
    );
    assert_eq!(rig.pair.chunk(1, "x"), Err(SendError::Paused));

    let register = PairMessage::Register {
        tools: vec!["t".into()],
        hooks: vec![],
    };
    leaf.stream.write_all(&frame(&encode(&register))).unwrap();
    for _ in 0..3 {
        rig.step();
    }
    assert_eq!(rig.seen, [], "暫停時不讀葉子送來的");
    assert!(rig.pair.paused());

    assert_eq!(leaf.read(&mut rig).len(), ids.len());
    assert!(!rig.pair.paused());
    assert_eq!(
        rig.events(),
        [PairEvent::Registered {
            tools: vec!["t".into()],
            hooks: vec![],
        }]
    );
    assert_eq!(rig.pair.chunk(1, "x"), Ok(()));
}

#[test]
fn past_the_outbox_limit_the_connection_is_dropped() {
    let (mut rig, mut leaf) = Rig::connected("overflow");
    let answers = 16;
    for id in 0..answers {
        leaf.send(&mut rig, &call(leaf_call(id), None, "echo", Value::Null));
    }
    rig.events();
    fill_until_paused(&mut rig);
    // 暫停時回答照樣排得進去；葉子一直不讀，排到上限就斷。
    let answer = Value::from("y".repeat(256 * 1024));
    let mut sent = 0;
    while rig.pair.connected() {
        assert!(sent < answers, "排了 {sent} 個回答還沒斷");
        rig.pair.finish(sent, Ok(answer.clone()));
        sent += 1;
        assert!(rig.pair.queued() <= OUTBOX_LIMIT);
    }
    assert!(sent > 1);
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
fn the_deadline_is_now_while_something_waits_for_the_next_step() {
    let mut rig = Rig::new("due");
    let now = rig.start + Duration::from_millis(1);

    // 等著的連線送過 hello，pid 一到就判得出來：不用等到它的時限。
    let mut ahead = Leaf::connect(&rig);
    ahead.send(&mut rig, &hello(PAIR_PROTOCOL_VERSION));
    assert_eq!(rig.pair.deadline(now), Some(rig.start + HELLO_TIMEOUT));
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
