#![cfg(target_os = "linux")]
//! 組合行程的執行檔（[`nexus_host::composition`]，#2583）：測試行程自己當監督行程（子行程的 stdin／stdout）、當葉子（連橋，
//! 所以 `leaf{pid}` 給的是測試行程的 pid；另外 listen 資料 socket）、當前台（連 `--socket`）。
//!
//! 「沒有發生」不靠等一段時間來證：用同一條通道上排在後面、一定會發生的事當見證（之後的回報、行程結束、一次來回）。
//! 用到牆鐘的只有兩種，各自寫在用的地方：[`GUARD`]（只在壞掉時讓測試紅，正常不會等到）、與只影響「抓不抓得到錯」的等待。

use nexus_host::composition::forward::MAX_LINKS;
use nexus_host::composition::{EXIT_PROTOCOL, HEARTBEAT};
use nexus_host::host_protocol::{CallError, ErrorCode};
use nexus_host::json::Value;
use nexus_host::pair_protocol::{
    decode, encode, CallRef, PairMessage, RejectCode, Side, MAX_FRAME, METHOD_ATTACH,
    PAIR_PROTOCOL_VERSION, RETRY_BACKOFF_MIN,
};
use nexus_sandbox_spawner::protocol::{frame, take_frame, take_frame_within};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_conversation_report, encode_conversation_command, ConversationCommand,
    ConversationReport, PROTOCOL_VERSION,
};
use std::io::{ErrorKind, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::time::{Duration, Instant};

/// 等一件一定會發生的事最多等這麼久。正常幾毫秒就到；到了這個時限就是壞了，測試紅。
const GUARD: Duration = Duration::from_secs(30);

/// 沒有任何回報。
const NONE: [ConversationReport; 0] = [];

fn me() -> u32 {
    std::process::id()
}

struct Rig {
    child: Child,
    stdin: Option<ChildStdin>,
    reports: Receiver<ConversationReport>,
    dir: PathBuf,
    leaf_listener: Option<UnixListener>,
}

impl Rig {
    /// 起組合行程，什麼都還沒送。
    fn start(tag: &str) -> Rig {
        Rig::start_at(tag, "front.sock")
    }

    /// 同 [`Rig::start`]，`--socket` 給的是暫存目錄底下的 `front`。
    fn start_at(tag: &str, front: &str) -> Rig {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("ncomp-{tag}-{}-{n}", me()));
        std::fs::create_dir_all(&dir).unwrap();
        let leaf_listener = UnixListener::bind(dir.join("leaf.sock")).unwrap();
        let mut child = Command::new(env!("CARGO_BIN_EXE_nexus-composition"))
            .arg("--socket")
            .arg(dir.join(front))
            .arg("--pair-socket")
            .arg(dir.join("pair.sock"))
            .arg("--leaf-socket")
            .arg(dir.join("leaf.sock"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let mut stdout = child.stdout.take().unwrap();
        let (tx, reports) = channel();
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                while let Some(payload) = take_frame(&mut buf).unwrap() {
                    if tx
                        .send(decode_conversation_report(&payload).unwrap())
                        .is_err()
                    {
                        return;
                    }
                }
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => return,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
            }
        });
        Rig {
            child,
            stdin,
            reports,
            dir,
            leaf_listener: Some(leaf_listener),
        }
    }

    /// 兩邊的 `hello` 都過了。
    fn greeted(tag: &str) -> Rig {
        let mut rig = Rig::start(tag);
        rig.command(&hello());
        match rig.next() {
            ConversationReport::Hello { .. } => rig,
            other => panic!("第一則回報不是 hello：{other:?}"),
        }
    }

    /// 葉子連上橋、登記了，`ready` 也收到了。
    fn ready(tag: &str) -> (Rig, Leaf) {
        let mut rig = Rig::greeted(tag);
        rig.command(&ConversationCommand::Leaf { pid: me() });
        let mut leaf = Leaf::join(&rig);
        leaf.register();
        assert_eq!(rig.next_but_heartbeats(), ConversationReport::Ready);
        (rig, leaf)
    }

    /// 再加上綁好 `thread-1`。
    fn bound(tag: &str) -> (Rig, Leaf) {
        let (mut rig, mut leaf) = Rig::ready(tag);
        rig.command(&bind("thread-1"));
        leaf.answer_attach("thread-1", Ok(Value::Null));
        assert_eq!(rig.next_but_heartbeats(), bound("thread-1"));
        (rig, leaf)
    }

    fn write(&mut self, bytes: &[u8]) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(bytes).unwrap();
        stdin.flush().unwrap();
    }

    fn command(&mut self, command: &ConversationCommand) {
        self.write(&frame(&encode_conversation_command(command)));
    }

    /// 下一則回報。
    fn next(&mut self) -> ConversationReport {
        self.reports
            .recv_timeout(GUARD)
            .expect("等不到組合行程的下一則回報")
    }

    /// 下一則不是心跳的回報。
    fn next_but_heartbeats(&mut self) -> ConversationReport {
        loop {
            let report = self.next();
            if report != ConversationReport::Heartbeat {
                return report;
            }
        }
    }

    /// 現在已經到的回報，不等。
    fn arrived(&mut self) -> Vec<ConversationReport> {
        self.reports.try_iter().collect()
    }

    /// 到 stdout 關掉為止剩下的回報。
    fn rest(&mut self) -> Vec<ConversationReport> {
        let mut rest = Vec::new();
        loop {
            match self.reports.recv_timeout(GUARD) {
                Ok(report) => rest.push(report),
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return rest,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    panic!("組合行程的 stdout 一直不關")
                }
            }
        }
    }

    /// 等它結束，回結束碼。
    fn exit(&mut self) -> Option<i32> {
        let until = Instant::now() + GUARD;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code();
            }
            assert!(Instant::now() < until, "組合行程一直不結束");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn front(&self) -> UnixStream {
        let stream = UnixStream::connect(self.dir.join("front.sock")).unwrap();
        stream.set_read_timeout(Some(GUARD)).unwrap();
        stream.set_write_timeout(Some(GUARD)).unwrap();
        stream
    }

    /// 葉子那一端收下一條轉送過來的連線。
    fn accept(&self) -> UnixStream {
        let listener = self.leaf_listener.as_ref().unwrap();
        listener.set_nonblocking(true).unwrap();
        let until = Instant::now() + GUARD;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    stream.set_read_timeout(Some(GUARD)).unwrap();
                    stream.set_write_timeout(Some(GUARD)).unwrap();
                    return stream;
                }
                Err(err) if err.kind() == ErrorKind::WouldBlock => {
                    assert!(Instant::now() < until, "轉送的連線一直沒到葉子");
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(err) => panic!("accept 失敗：{err}"),
            }
        }
    }

    /// 前台連一條、葉子收下它。
    fn link(&self) -> (UnixStream, UnixStream) {
        let front = self.front();
        (front, self.accept())
    }

    /// 這一刻有沒有還沒收的轉送連線。
    fn nothing_to_accept(&self) -> bool {
        let listener = self.leaf_listener.as_ref().unwrap();
        listener.set_nonblocking(true).unwrap();
        matches!(listener.accept(), Err(err) if err.kind() == ErrorKind::WouldBlock)
    }

    /// 子行程的 `VmHWM`，直接寫到 fd 2（不被測試框架收走）。只當參考，不下斷言。
    fn print_peak_rss(&self, when: &str) {
        let status = std::fs::read_to_string(format!("/proc/{}/status", self.child.id()));
        let peak = status
            .as_deref()
            .ok()
            .and_then(|text| text.lines().find(|line| line.starts_with("VmHWM:")))
            .unwrap_or("VmHWM: 讀不到");
        let line = format!("nexus-composition {when}：{peak}\n");
        // SAFETY：寫 line 的內容到 fd 2。
        unsafe { libc::write(2, line.as_ptr().cast(), line.len()) };
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// 橋上的葉子。
struct Leaf {
    stream: UnixStream,
    buf: Vec<u8>,
}

impl Leaf {
    /// 連上、送 `hello`、讀到組合行程的 `hello`。被要求稍後再試就照協定的下限等了再連。
    fn join(rig: &Rig) -> Leaf {
        let until = Instant::now() + GUARD;
        loop {
            let stream = UnixStream::connect(rig.dir.join("pair.sock")).unwrap();
            stream.set_read_timeout(Some(GUARD)).unwrap();
            let mut leaf = Leaf {
                stream,
                buf: Vec::new(),
            };
            leaf.send(&PairMessage::Hello {
                version: PAIR_PROTOCOL_VERSION,
            });
            match leaf.read() {
                Some(PairMessage::Hello {
                    version: PAIR_PROTOCOL_VERSION,
                }) => return leaf,
                Some(PairMessage::Rejected {
                    code: RejectCode::RetryLater,
                    ..
                }) => {
                    assert!(Instant::now() < until, "橋一直要葉子稍後再試");
                    std::thread::sleep(RETRY_BACKOFF_MIN);
                }
                other => panic!("橋沒收葉子：{other:?}"),
            }
        }
    }

    fn send(&mut self, message: &PairMessage) {
        self.stream.write_all(&frame(&encode(message))).unwrap();
    }

    fn register(&mut self) {
        self.send(&PairMessage::Register {
            tools: vec!["tool".into()],
            hooks: Vec::new(),
        });
    }

    /// 下一框；連線關了是 `None`。
    fn read(&mut self) -> Option<PairMessage> {
        let mut chunk = [0u8; 4096];
        loop {
            if let Some(payload) = take_frame_within(&mut self.buf, MAX_FRAME).unwrap() {
                return Some(decode(&payload).unwrap());
            }
            match self.stream.read(&mut chunk) {
                Ok(0) => return None,
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(err) if err.kind() == ErrorKind::ConnectionReset => return None,
                Err(err) => panic!("讀橋失敗：{err}"),
            }
        }
    }

    /// 下一框要是這條 thread 的 `attach`，回它的識別。
    fn attach_call(&mut self, thread: &str) -> CallRef {
        match self.read() {
            Some(PairMessage::Call {
                call,
                parent: None,
                method,
                payload,
            }) => {
                assert_eq!(method, METHOD_ATTACH);
                assert_eq!(payload, serde_json::json!({ "threadId": thread }));
                call
            }
            other => panic!("要的是 attach，讀到 {other:?}"),
        }
    }

    /// 等組合行程把這條連線上先前送的都處理完：送一個它沒有的 method，橋照順序處理，讀到這一則的錯誤就表示前面的都處理過了。
    fn settle(&mut self) {
        let call = CallRef {
            side: Side::Leaf,
            id: 1,
        };
        self.send(&PairMessage::Call {
            call,
            parent: None,
            method: "settle".into(),
            payload: Value::Null,
        });
        match self.read() {
            Some(PairMessage::Result {
                call: answered,
                outcome: Err(err),
            }) if answered == call => assert_eq!(err.code, ErrorCode::UnknownMethod),
            other => panic!("要的是 settle 的錯誤，讀到 {other:?}"),
        }
    }

    /// 葉子自己斷線，等到組合行程處理完才回來：關掉寫的方向，組合行程讀到 EOF 就收掉這條連線，這一端讀到 EOF 就是見證。
    /// 少了這一步，下一個葉子（測試裡是同一個 pid）可能在橋還認為這一條在的時候連上，被當成同一個葉子連了兩次而拒絕。
    fn die(mut self) {
        self.stream.shutdown(Shutdown::Write).unwrap();
        assert_eq!(self.read(), None);
    }

    fn answer_attach(&mut self, thread: &str, outcome: Result<Value, CallError>) {
        let call = self.attach_call(thread);
        self.send(&PairMessage::Result { call, outcome });
    }
}

fn hello() -> ConversationCommand {
    ConversationCommand::Hello {
        version: PROTOCOL_VERSION,
        token: b"token".to_vec(),
    }
}

fn bind(thread: &str) -> ConversationCommand {
    ConversationCommand::Bind {
        thread_id: thread.as_bytes().to_vec(),
    }
}

fn bound(thread: &str) -> ConversationReport {
    ConversationReport::Bound {
        thread_id: thread.as_bytes().to_vec(),
    }
}

fn count(reports: &[ConversationReport], wanted: &ConversationReport) -> usize {
    reports.iter().filter(|report| *report == wanted).count()
}

/// 有規律、不是全零的位元組。
fn pattern(len: usize) -> Vec<u8> {
    (0..len).map(|i| (i % 251) as u8).collect()
}

/// 在另一條執行緒把 `bytes` 寫完，之後照 `then` 關。
fn write_in_background(
    mut stream: UnixStream,
    bytes: Vec<u8>,
    then: Option<Shutdown>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        stream.write_all(&bytes).unwrap();
        if let Some(how) = then {
            stream.shutdown(how).unwrap();
        }
    })
}

fn read_exactly(stream: &mut UnixStream, len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    stream.read_exact(&mut bytes).unwrap();
    bytes
}

fn read_to_end(stream: &mut UnixStream) -> Vec<u8> {
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).unwrap();
    bytes
}

#[test]
fn the_first_frame_is_a_hello_that_does_not_claim_the_loop() {
    let mut rig = Rig::start("hello");
    assert_eq!(
        rig.next(),
        ConversationReport::Hello {
            version: PROTOCOL_VERSION,
            runs_loop: false
        }
    );
}

#[test]
fn another_supervisor_version_exits_with_a_protocol_error() {
    let mut rig = Rig::start("version");
    rig.command(&ConversationCommand::Hello {
        version: PROTOCOL_VERSION + 1,
        token: Vec::new(),
    });
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
    assert_eq!(count(&rig.rest(), &ConversationReport::Ready), 0);
}

#[test]
fn a_first_frame_other_than_hello_exits_with_a_protocol_error() {
    let mut rig = Rig::start("first");
    rig.command(&ConversationCommand::Leaf { pid: me() });
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
}

#[test]
fn a_frame_that_does_not_decode_exits_with_a_protocol_error() {
    let mut rig = Rig::greeted("garbage");
    rig.write(&frame(b"?"));
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
}

/// 綁不了 socket 就不送 `hello`：監督行程讀到 `hello` 時兩個 socket 一定都在聽。
#[test]
fn a_socket_that_cannot_be_bound_exits_1_without_a_hello() {
    let mut rig = Rig::start_at("unbound", "no-such-dir/front.sock");
    assert_eq!(rig.exit(), Some(1));
    assert_eq!(rig.rest(), NONE);
}

/// `ready` 之前的 `bind` 是協定錯誤，所以拿它當見證：行程因它結束，就證明到那一刻為止沒送過 `ready`。
#[test]
fn there_is_no_ready_while_no_leaf_pid_came() {
    let mut rig = Rig::greeted("nopid");
    rig.command(&bind("thread-1"));
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
    assert_eq!(count(&rig.rest(), &ConversationReport::Ready), 0);
}

/// 同上：葉子讀到橋的 `hello` 表示已經驗過，這時還沒 `register`。
#[test]
fn there_is_no_ready_while_the_leaf_has_not_registered() {
    let mut rig = Rig::greeted("noreg");
    rig.command(&ConversationCommand::Leaf { pid: me() });
    let _leaf = Leaf::join(&rig);
    rig.command(&bind("thread-1"));
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
    assert_eq!(count(&rig.rest(), &ConversationReport::Ready), 0);
}

#[test]
fn ready_comes_once_after_the_first_register_and_not_again() {
    let (mut rig, mut leaf) = Rig::ready("ready");
    leaf.register();
    rig.command(&bind("thread-1"));
    leaf.answer_attach("thread-1", Ok(Value::Null));
    assert_eq!(rig.next_but_heartbeats(), bound("thread-1"));
    drop(rig.stdin.take());
    assert_eq!(rig.exit(), Some(0));
    assert_eq!(count(&rig.rest(), &ConversationReport::Ready), 0);
}

/// 葉子拿到 `attach` 之後先等一次心跳才回：`bound` 若不等葉子，會排在這次心跳前面。
#[test]
fn bound_waits_for_the_leaf_to_answer_attach() {
    let (mut rig, mut leaf) = Rig::ready("bound");
    rig.command(&bind("thread-1"));
    let call = leaf.attach_call("thread-1");
    assert_eq!(rig.next(), ConversationReport::Heartbeat);
    leaf.send(&PairMessage::Result {
        call,
        outcome: Ok(Value::Null),
    });
    assert_eq!(rig.next_but_heartbeats(), bound("thread-1"));
}

#[test]
fn a_failed_attach_sends_no_bound_and_the_next_bind_tries_again() {
    let (mut rig, mut leaf) = Rig::ready("attach-error");
    rig.command(&bind("thread-1"));
    leaf.answer_attach(
        "thread-1",
        Err(CallError {
            code: ErrorCode::ServiceError,
            message: "綁不了".into(),
        }),
    );
    leaf.settle();
    // 第二則 `bind` 能走到 `attach`，就證明第一次失敗之後行程還在、也沒把葉子當成綁過。
    rig.command(&bind("thread-1"));
    leaf.answer_attach("thread-1", Ok(Value::Null));
    assert_eq!(rig.next_but_heartbeats(), bound("thread-1"));
    drop(rig.stdin.take());
    assert_eq!(count(&rig.rest(), &bound("thread-1")), 0);
}

/// 等 3 個心跳間隔再看：正確的程式在 `bind` 之前永遠不送心跳，等多久都不會紅；這段等待只決定「從起動就送心跳」這種錯抓不抓得到
/// （間隔 1 秒，留 3 倍）。
#[test]
fn heartbeats_start_at_bind_and_keep_coming() {
    let (mut rig, mut leaf) = Rig::ready("heartbeat");
    std::thread::sleep(HEARTBEAT * 3);
    assert_eq!(rig.arrived(), NONE);
    rig.command(&bind("thread-1"));
    leaf.answer_attach("thread-1", Ok(Value::Null));
    let mut heartbeats = 0;
    while heartbeats < 3 {
        if rig.next() == ConversationReport::Heartbeat {
            heartbeats += 1;
        }
    }
}

#[test]
fn drain_is_ignored() {
    let (mut rig, mut leaf) = Rig::ready("drain");
    rig.command(&ConversationCommand::Drain);
    rig.command(&bind("thread-1"));
    leaf.answer_attach("thread-1", Ok(Value::Null));
    assert_eq!(rig.next_but_heartbeats(), bound("thread-1"));
}

#[test]
fn a_second_bind_for_the_same_leaf_exits_with_a_protocol_error() {
    let (mut rig, mut leaf) = Rig::bound("rebind");
    // `attach` 的結果確定處理完了：下面的結束碼才是「已經綁了」那一條，不是「`attach` 還沒回」那一條。
    leaf.settle();
    rig.command(&bind("thread-1"));
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
}

#[test]
fn a_bind_while_attach_is_unanswered_exits_with_a_protocol_error() {
    let (mut rig, mut leaf) = Rig::ready("bind-twice");
    rig.command(&bind("thread-1"));
    leaf.attach_call("thread-1");
    rig.command(&bind("thread-1"));
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
}

/// 新的 `leaf{pid}` 讓舊葉子的連線被關（舊葉子讀到 EOF 就是見證）；`bind` 比新葉子早到，留著等它 `register`。
#[test]
fn a_bind_ahead_of_the_replacement_leaf_waits_for_it_to_register() {
    let (mut rig, mut old) = Rig::bound("swap-held");
    rig.command(&ConversationCommand::Leaf { pid: me() });
    assert_eq!(old.read(), None);
    rig.command(&bind("thread-1"));
    let mut leaf = Leaf::join(&rig);
    leaf.register();
    leaf.answer_attach("thread-1", Ok(Value::Null));
    assert_eq!(rig.next_but_heartbeats(), bound("thread-1"));
    drop(rig.stdin.take());
    assert_eq!(rig.exit(), Some(0));
    assert_eq!(count(&rig.rest(), &ConversationReport::Ready), 0);
}

/// 葉子自己斷線（沒有新的 `leaf{pid}`）：組合行程照活，之後的 `leaf{pid}`、新葉子、`bind` 照常。
#[test]
fn the_composition_survives_its_leaf_and_takes_the_next_one() {
    let (mut rig, old) = Rig::bound("swap-died");
    old.die();
    rig.command(&ConversationCommand::Leaf { pid: me() });
    let mut leaf = Leaf::join(&rig);
    leaf.register();
    rig.command(&bind("thread-1"));
    leaf.answer_attach("thread-1", Ok(Value::Null));
    assert_eq!(rig.next_but_heartbeats(), bound("thread-1"));
    let (mut front, mut behind) = rig.link();
    front.write_all(b"again").unwrap();
    assert_eq!(read_exactly(&mut behind, 5), b"again");
}

#[test]
fn a_second_bind_while_one_is_held_exits_with_a_protocol_error() {
    let (mut rig, mut old) = Rig::bound("held-twice");
    rig.command(&ConversationCommand::Leaf { pid: me() });
    assert_eq!(old.read(), None);
    rig.command(&bind("thread-1"));
    rig.command(&bind("thread-1"));
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
}

#[test]
fn a_bind_whose_thread_is_not_utf8_exits_with_a_protocol_error() {
    let (mut rig, _leaf) = Rig::ready("not-utf8");
    rig.command(&ConversationCommand::Bind {
        thread_id: vec![0xff],
    });
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
}

/// 葉子拿到 `attach` 還沒回就斷線：不送 `bound`、行程照活，下一個葉子來了再 `bind` 照常。
#[test]
fn a_leaf_that_dies_before_answering_attach_gets_no_bound() {
    let (mut rig, mut old) = Rig::ready("attach-dropped");
    rig.command(&bind("thread-1"));
    old.attach_call("thread-1");
    old.die();
    rig.command(&ConversationCommand::Leaf { pid: me() });
    let mut leaf = Leaf::join(&rig);
    leaf.register();
    rig.command(&bind("thread-1"));
    leaf.answer_attach("thread-1", Ok(Value::Null));
    assert_eq!(rig.next_but_heartbeats(), bound("thread-1"));
    drop(rig.stdin.take());
    assert_eq!(count(&rig.rest(), &bound("thread-1")), 0);
}

#[test]
fn a_bind_for_another_thread_after_the_leaf_changed_exits_with_a_protocol_error() {
    let (mut rig, mut old) = Rig::bound("swap-thread");
    rig.command(&ConversationCommand::Leaf { pid: me() });
    assert_eq!(old.read(), None);
    rig.command(&bind("thread-2"));
    assert_eq!(rig.exit(), Some(EXIT_PROTOCOL));
}

#[test]
fn stdin_eof_exits_0_and_removes_both_sockets() {
    let (mut rig, _leaf) = Rig::ready("eof");
    drop(rig.stdin.take());
    assert_eq!(rig.exit(), Some(0));
    assert!(!rig.dir.join("front.sock").exists());
    assert!(!rig.dir.join("pair.sock").exists());
}

#[test]
fn sigterm_exits_0() {
    let (mut rig, _leaf) = Rig::ready("sigterm");
    // SAFETY：對自己起的子行程送訊號。
    unsafe { libc::kill(rig.child.id() as libc::pid_t, libc::SIGTERM) };
    assert_eq!(rig.exit(), Some(0));
}

#[test]
fn bytes_cross_unchanged_in_both_directions() {
    let (rig, _leaf) = Rig::ready("bytes");
    rig.print_peak_rss("ready 之後");
    let (mut front, mut behind) = rig.link();
    front.write_all(b"GET / HTTP/1.1\r\n\r\n").unwrap();
    assert_eq!(read_exactly(&mut behind, 18), b"GET / HTTP/1.1\r\n\r\n");
    behind.write_all(b"HTTP/1.1 200 OK\r\n\r\n").unwrap();
    assert_eq!(read_exactly(&mut front, 19), b"HTTP/1.1 200 OK\r\n\r\n");

    let big = pattern(64 * 1024 * 1024);
    let writer = write_in_background(front.try_clone().unwrap(), big.clone(), None);
    assert!(
        read_exactly(&mut behind, big.len()) == big,
        "前台 → 葉子的內容變了"
    );
    writer.join().unwrap();
    let writer = write_in_background(behind.try_clone().unwrap(), big.clone(), None);
    assert!(
        read_exactly(&mut front, big.len()) == big,
        "葉子 → 前台的內容變了"
    );
    writer.join().unwrap();
    rig.print_peak_rss("兩個方向各轉送 64 MiB 之後");
}

/// 葉子不讀時，前台最多寫得進去：自己 socket 的緩衝＋組合行程留的一份＋往葉子那條 socket 的緩衝，預設值下不到 1 MiB。
/// 門檻取 16 MiB（留給調大過 socket 緩衝的機器），拿掉背壓的話 64 MiB 會全部寫進去。
/// 「寫不進去了」用 2 秒內都不可寫來判：正確的程式只會更早停，這段等待只影響這種錯抓不抓得到。
#[test]
fn a_reader_that_stops_holds_the_writer_back() {
    let (rig, _leaf) = Rig::ready("backpressure");
    let (front, mut behind) = rig.link();
    front.set_nonblocking(true).unwrap();
    let big = pattern(64 * 1024 * 1024);
    let mut written = 0;
    while written < big.len() {
        match (&front).write(&big[written..]) {
            Ok(n) => written += n,
            Err(err) if err.kind() == ErrorKind::WouldBlock => {
                let mut pfd = libc::pollfd {
                    fd: std::os::fd::AsRawFd::as_raw_fd(&front),
                    events: libc::POLLOUT,
                    revents: 0,
                };
                // SAFETY：一個 pollfd。
                if unsafe { libc::poll(&mut pfd, 1, 2_000) } == 0 {
                    break;
                }
            }
            Err(err) => panic!("寫不進去：{err}"),
        }
    }
    assert!(
        written < 16 * 1024 * 1024,
        "葉子沒在讀，前台卻寫進了 {written} 個位元組"
    );
    // 葉子開始讀之後，剩下的寫得完，內容一個位元組都沒少。
    front.set_nonblocking(false).unwrap();
    let writer = write_in_background(front, big[written..].to_vec(), Some(Shutdown::Write));
    assert!(read_to_end(&mut behind) == big, "卡住又恢復之後內容變了");
    writer.join().unwrap();
}

#[test]
fn a_half_closed_request_still_gets_its_whole_response() {
    let (rig, _leaf) = Rig::ready("half-close");
    let (mut front, mut behind) = rig.link();
    front.write_all(b"request").unwrap();
    front.shutdown(Shutdown::Write).unwrap();
    assert_eq!(read_to_end(&mut behind), b"request");
    let response = pattern(4 * 1024 * 1024);
    // 葉子寫完就整條關：還沒轉完的不能跟著丟。
    let writer = std::thread::spawn({
        let response = response.clone();
        move || {
            behind.write_all(&response).unwrap();
            drop(behind);
        }
    });
    assert!(read_to_end(&mut front) == response, "回應被截了");
    writer.join().unwrap();
}

#[test]
fn a_connection_is_closed_when_the_leaf_socket_is_gone_and_the_next_one_works() {
    let (mut rig, _leaf) = Rig::ready("no-leaf");
    drop(rig.leaf_listener.take());
    std::fs::remove_file(rig.dir.join("leaf.sock")).unwrap();
    let mut front = rig.front();
    assert_eq!(read_to_end(&mut front), b"");
    rig.leaf_listener = Some(UnixListener::bind(rig.dir.join("leaf.sock")).unwrap());
    let (mut front, mut behind) = rig.link();
    front.write_all(b"ping").unwrap();
    assert_eq!(read_exactly(&mut behind, 4), b"ping");
}

/// 第 65 條連得上（排在 backlog）但不該被轉送。見證是既有連線上的一次來回：多收的話，那條連線在這次來回走完之前就已經連到葉子了。
#[test]
fn links_are_capped_and_the_next_one_waits_for_a_free_slot() {
    let (rig, _leaf) = Rig::ready("cap");
    let mut links: Vec<_> = (0..MAX_LINKS).map(|_| rig.link()).collect();
    let mut extra = rig.front();
    let (front, behind) = &mut links[0];
    front.write_all(b"ping").unwrap();
    assert_eq!(read_exactly(behind, 4), b"ping");
    behind.write_all(b"pong").unwrap();
    assert_eq!(read_exactly(front, 4), b"pong");
    assert!(rig.nothing_to_accept(), "超過上限的連線被轉送了");

    drop(links.pop());
    let mut behind = rig.accept();
    extra.write_all(b"late").unwrap();
    assert_eq!(read_exactly(&mut behind, 4), b"late");
}
