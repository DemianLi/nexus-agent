//! 真的 `nexus-host`（#2569）：測試站在監督行程的位置握手、送身分表，再從各種客戶端連它的 socket。只在 Linux 跑。
//!
//! 多數情境由測試行程自己當客戶端（把自己的 pid 登記上去）；要另一個 pid 的用 `examples/host_client`。

#![cfg(target_os = "linux")]

mod common;

use common::host::{example, unregistered, violation, HostProc};
use nexus_sandbox_spawner::host_protocol::{decode_host_message, encode_client_message, hello, HostMessage, MAX_FRAME};
use nexus_sandbox_spawner::json::{self, Value};
use nexus_sandbox_spawner::protocol::frame;
use nexus_sandbox_spawner::supervisor_protocol::{HostCommand, HostReport, Role, PROTOCOL_VERSION};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

const SPAWNER: &str = env!("CARGO_BIN_EXE_nexus-sandbox-spawner");
const TOKEN: &str = "00112233445566778899aabbccddeeff";
const OTHER: &str = "ffeeddccbbaa99887766554433221100";

fn temp_dir(tag: &str) -> PathBuf {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!("nhost-{tag}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn me() -> u32 {
    std::process::id()
}

/// 測試行程自己連上、送這些位元組，回宿主的回答；宿主沒回答就斷了回 `None`。
fn exchange(socket: &Path, bytes: &[u8]) -> (UnixStream, Option<HostMessage>) {
    let mut stream = UnixStream::connect(socket).unwrap();
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    stream.write_all(bytes).unwrap();
    let reply = read_message(&mut stream);
    (stream, reply)
}

fn read_message(stream: &mut UnixStream) -> Option<HostMessage> {
    let mut head = [0u8; 4];
    stream.read_exact(&mut head).ok()?;
    let mut payload = vec![0u8; u32::from_le_bytes(head) as usize];
    stream.read_exact(&mut payload).ok()?;
    Some(decode_host_message(&payload).unwrap())
}

fn hello_frame(token: &str) -> Vec<u8> {
    frame(&encode_client_message(&hello(token)))
}

fn newer_hello_frame(token: &str) -> Vec<u8> {
    frame(&encode_client_message(&nexus_sandbox_spawner::host_protocol::ClientMessage::Hello {
        version: PROTOCOL_VERSION + 1,
        token: token.into(),
    }))
}

fn rejected(reason: &str) -> Option<HostMessage> {
    Some(HostMessage::Rejected { reason: reason.into() })
}

fn accepted() -> Option<HostMessage> {
    Some(HostMessage::Hello { version: PROTOCOL_VERSION })
}

/// 斷線了：讀到 EOF（或對方重設連線）。
fn closed(stream: &mut UnixStream) -> bool {
    let mut buf = [0u8; 1];
    matches!(stream.read(&mut buf), Ok(0) | Err(_))
}

#[test]
fn handshake_then_eof_removes_the_socket_and_exits_0() {
    let dir = temp_dir("eof");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    host.close_stdin();
    assert!(host.wait().success());
    assert!(!socket.exists());
}

#[test]
fn a_wrong_supervisor_hello_exits_3_before_binding() {
    let dir = temp_dir("ver");
    let socket = dir.join("host.sock");
    let mut host = HostProc::spawn(&socket);
    assert_eq!(host.report(), Some(HostReport::Hello { version: PROTOCOL_VERSION }));
    host.command(&HostCommand::Hello { version: PROTOCOL_VERSION + 1 });
    assert_eq!(host.wait().code(), Some(3));
    assert!(!socket.exists());
}

#[test]
fn a_granted_pid_with_its_token_gets_hello_and_a_second_hello_is_a_violation() {
    let dir = temp_dir("ok");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    host.grant(me(), TOKEN, Role::Conversation, "a");
    let (mut stream, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    stream.write_all(&hello_frame(TOKEN)).unwrap();
    assert_eq!(read_message(&mut stream), rejected("重複的 hello"));
    assert!(closed(&mut stream));
    assert_eq!(host.report(), Some(violation(me(), "重複的 hello")));
    // 隔離：同一個 pid 再連，表上已經沒有它。
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
}

#[test]
fn a_wrong_token_or_version_quarantines_the_pid_and_drops_its_other_connections() {
    let dir = temp_dir("token");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    host.grant(me(), TOKEN, Role::Front, "");
    let (mut first, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    assert_eq!(exchange(&socket, &hello_frame(OTHER)).1, rejected("token 不對"));
    assert_eq!(host.report(), Some(violation(me(), "token 不對")));
    assert!(closed(&mut first), "隔離時它其他驗過身分的連線要一起斷");
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));

    host.grant(me(), TOKEN, Role::Front, "");
    assert_eq!(exchange(&socket, &newer_hello_frame(TOKEN)).1, rejected("版本不對"));
    assert_eq!(host.report(), Some(violation(me(), "版本不對")));
}

#[test]
fn every_invalid_vector_is_rejected_and_the_host_keeps_serving() {
    let vectors = json::parse(include_bytes!("../host-vectors.json")).unwrap();
    let dir = temp_dir("invalid");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let unhex = |hex: &str| -> Vec<u8> { (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect() };
    let text = |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).unwrap().to_string();
    for entry in vectors.get("invalidMessages").and_then(Value::as_array).unwrap() {
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let reason = text(entry, "error");
        let (mut stream, reply) = exchange(&socket, &frame(&unhex(&text(entry, "hex"))));
        assert_eq!(reply, rejected(&reason), "{}", text(entry, "name"));
        assert!(closed(&mut stream));
        assert_eq!(host.report(), Some(violation(me(), &reason)));
        assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"), "{}：pid 撤掉了", text(entry, "name"));
        assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    }
    for entry in vectors.get("invalidFrames").and_then(Value::as_array).unwrap() {
        if text(entry, "expect") != "error" {
            continue;
        }
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let (_, reply) = exchange(&socket, &unhex(&text(entry, "hex")));
        assert_eq!(reply, rejected("框太大"), "{}", text(entry, "name"));
        assert_eq!(host.report(), Some(violation(me(), "框太大")));
    }
    // 剛好等於上限的框照收：內容是一份合法的 hello，後面補空白補到上限。
    host.grant(me(), TOKEN, Role::Conversation, "a");
    let mut payload = encode_client_message(&hello(TOKEN));
    payload.resize(MAX_FRAME, b' ');
    assert_eq!(exchange(&socket, &frame(&payload)).1, accepted());
    assert!(host.child.try_wait().unwrap().is_none(), "宿主不因為任何一條連線結束");
}

/// 監督行程收屍之前就把撤銷寫進 pipe；之後才來的連線，不論宿主那時正在做什麼，都要被拒。
#[test]
fn a_hello_after_a_revoke_is_always_rejected() {
    let dir = temp_dir("revoke");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    for round in 0..200 {
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"), "第 {round} 輪");
        assert!(closed(&mut live), "撤銷時它驗過身分的連線要一起斷（第 {round} 輪）");
        assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    }
}

/// 撤銷只斷已經驗過身分的連線；連上了、還沒送 `hello` 的，等它送來時一律回 `rejected`，不是不吭聲地斷掉。
#[test]
fn a_revoke_leaves_connections_that_have_not_said_hello_to_be_rejected() {
    let dir = temp_dir("pending");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    for round in 0..50 {
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let mut pending = UnixStream::connect(&socket).unwrap();
        pending.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        // 後連的這條拿到回答時，先連的那條已經 accept 了（backlog 先進先出）：這裡測的是撤銷時已經 accept 的；
        // 還在 backlog 的見 `a_connection_still_in_the_backlog_at_a_revoke_is_not_verified_against_a_later_grant`。
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert!(closed(&mut live), "驗過身分的要斷（第 {round} 輪）");
        pending.write_all(&hello_frame(TOKEN)).unwrap();
        assert_eq!(read_message(&mut pending), rejected("沒有登記"), "第 {round} 輪");
        assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    }
}

/// 撤銷之前就連上、還沒送 `hello` 的連線，之後同一個 pid 號碼重新登記（pid 被重用）也不算數：它的 `hello` 一律被拒，
/// 不照新的那一筆驗，免得舊行程留下的連線冒充新行程，或送錯 token 害新行程被隔離。
#[test]
fn a_connection_from_before_a_revoke_is_not_verified_against_a_later_grant() {
    let dir = temp_dir("reuse");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    for round in 0..50 {
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let mut pending = UnixStream::connect(&socket).unwrap();
        pending.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        // 後連的這條拿到回答時，先連的那條已經 accept 了（backlog 先進先出）：這裡測的是撤銷時已經 accept 的；
        // 還在 backlog 的見 `a_connection_still_in_the_backlog_at_a_revoke_is_not_verified_against_a_later_grant`。
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert!(closed(&mut live), "第 {round} 輪");
        host.grant(me(), TOKEN, Role::Conversation, "b");
        pending.write_all(&hello_frame(TOKEN)).unwrap();
        assert_eq!(read_message(&mut pending), rejected("沒有登記"), "第 {round} 輪");
        assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    }
}

/// 撤過的連線送來壞框，也只回 `rejected`、報 `unregistered`：不報違規，也不撤同一個 pid 號碼後來的登記，
/// 免得舊行程留下的連線害新行程被隔離。
#[test]
fn a_bad_frame_on_a_revoked_connection_leaves_a_later_grant_alone() {
    let dir = temp_dir("revoked-garbage");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    for round in 0..50 {
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let mut pending = UnixStream::connect(&socket).unwrap();
        pending.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert!(closed(&mut live), "第 {round} 輪");
        host.grant(me(), OTHER, Role::Conversation, "b");
        pending.write_all(&frame(&[0xff])).unwrap();
        let Some(HostMessage::Rejected { reason }) = read_message(&mut pending) else { panic!("第 {round} 輪") };
        assert_eq!(unregistered(host.report()), Some((me(), reason)), "第 {round} 輪");
        let (_later, reply) = exchange(&socket, &hello_frame(OTHER));
        assert_eq!(reply, accepted(), "後來的登記還在（第 {round} 輪）");
    }
}

/// 連線數滿了、還排在 listen backlog 裡沒 accept 的連線，撤銷時也算舊行程的：之後同一個 pid 號碼重新登記，它的 `hello` 照樣被拒。
#[test]
fn a_connection_still_in_the_backlog_at_a_revoke_is_not_verified_against_a_later_grant() {
    raise_fd_limit();
    let dir = temp_dir("backlog");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    host.grant(me(), TOKEN, Role::Conversation, "a");
    let mut full: Vec<UnixStream> = (0..nexus_sandbox_spawner::host::MAX_CONNECTIONS)
        .map(|n| {
            let (stream, reply) = exchange(&socket, &hello_frame(TOKEN));
            assert_eq!(reply, accepted(), "第 {n} 條");
            stream
        })
        .collect();
    // 宿主滿了不 accept：這條停在 backlog。
    let mut queued = UnixStream::connect(&socket).unwrap();
    queued.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    host.command(&HostCommand::Revoke { pid: me() });
    host.grant(me(), OTHER, Role::Conversation, "b");
    for stream in &mut full {
        assert!(closed(stream));
    }
    queued.write_all(&hello_frame(OTHER)).unwrap();
    assert_eq!(read_message(&mut queued), rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
}

/// 宿主一起來就把開檔數的軟上限拉到硬上限：每條連線佔兩個 fd，撤銷時收 backlog 也要收得完，不能靠啟動它的那一方替它拉。
#[test]
fn the_host_raises_its_open_file_soft_limit_to_the_hard_limit() {
    use std::os::unix::process::CommandExt;
    let dir = temp_dir("nofile");
    let mut cmd = Command::new(common::host::HOST);
    cmd.arg("--socket").arg(dir.join("host.sock")).stdin(Stdio::piped()).stdout(Stdio::piped());
    // SAFETY：fork 之後只做 getrlimit／setrlimit 兩個系統呼叫，不配置記憶體、不拿鎖。
    unsafe {
        cmd.pre_exec(|| {
            let mut limit: libc::rlimit = std::mem::zeroed();
            libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit);
            limit.rlim_cur = limit.rlim_max.min(64);
            libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
            Ok(())
        });
    }
    let mut child = cmd.spawn().unwrap();
    // 第一框 `hello` 送出來時，上限已經拉好了。
    let mut head = [0u8; 4];
    child.stdout.as_mut().unwrap().read_exact(&mut head).unwrap();
    let limits = std::fs::read_to_string(format!("/proc/{}/limits", child.id())).unwrap();
    let line = limits.lines().find(|l| l.starts_with("Max open files")).unwrap().to_string();
    let _ = child.kill();
    let _ = child.wait();
    let fields: Vec<&str> = line.split_whitespace().collect();
    assert_eq!(fields[3], fields[4], "{line}");
}

/// 測試行程要開上千條連線：軟上限拉到硬上限（宿主自己會拉）。
fn raise_fd_limit() {
    // SAFETY：rlimit 是純資料，全零合法；只改自己的 RLIMIT_NOFILE。
    unsafe {
        let mut limit: libc::rlimit = std::mem::zeroed();
        assert_eq!(libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit), 0);
        limit.rlim_cur = limit.rlim_max;
        assert_eq!(libc::setrlimit(libc::RLIMIT_NOFILE, &limit), 0);
    }
}

/// `unregistered` 帶宿主替每條連線編的號，依 accept 的順序遞增，監督行程的警告與宿主自己的 log 才對得起來。
#[test]
fn unregistered_reports_number_each_connection() {
    let dir = temp_dir("conn-id");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut ids = Vec::new();
    for _ in 0..3 {
        assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"));
        match host.report() {
            Some(HostReport::Unregistered { pid, conn, .. }) => {
                assert_eq!(pid, me());
                ids.push(conn);
            }
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(ids, [1, 2, 3]);
}

/// 同一個 pid 再登記一次（對話行程綁了 thread）：整筆換掉。還沒送 `hello` 的照新的那一筆驗，驗過身分的照樣連著，舊 token 不再算數。
/// 連上之後才到的登記也算：驗 `hello` 之前先讀乾淨控制通道。
#[test]
fn a_regrant_replaces_the_token_and_keeps_verified_connections() {
    let dir = temp_dir("regrant");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut early = UnixStream::connect(&socket).unwrap();
    early.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    // 後連的拿到回答時，先連的 `early` 已經 accept 了：登記到的時候它是 pid 不在表上的連線，不是還在 backlog。
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    host.grant(me(), TOKEN, Role::Conversation, "");
    let (mut verified, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    let mut pending = UnixStream::connect(&socket).unwrap();
    pending.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, accepted());
    host.grant(me(), OTHER, Role::Conversation, "a");
    early.write_all(&hello_frame(OTHER)).unwrap();
    assert_eq!(read_message(&mut early), accepted(), "連上之後才到的登記");
    pending.write_all(&hello_frame(OTHER)).unwrap();
    assert_eq!(read_message(&mut pending), accepted(), "還沒送 hello 的照新的那一筆驗");
    verified.set_read_timeout(Some(Duration::from_millis(300))).unwrap();
    let mut buf = [0u8; 1];
    assert!(matches!(verified.read(&mut buf), Err(err) if err.kind() == std::io::ErrorKind::WouldBlock), "驗過身分的照樣連著");
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("token 不對"));
    assert_eq!(host.report(), Some(violation(me(), "token 不對")));
}

/// pid 不在表上、還沒送 `hello` 的連線，撤銷時也記成撤過：之後同一個號碼登記了，它也不照那一筆驗。
#[test]
fn a_connection_from_a_pid_not_on_the_table_is_also_marked_by_a_revoke() {
    let dir = temp_dir("unknown-revoked");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut pending = UnixStream::connect(&socket).unwrap();
    pending.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    host.command(&HostCommand::Revoke { pid: me() });
    host.grant(me(), TOKEN, Role::Conversation, "a");
    pending.write_all(&hello_frame(TOKEN)).unwrap();
    assert_eq!(read_message(&mut pending), rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, accepted(), "撤銷之後才連的照新的那一筆驗");
}

/// pid 不在表上、也沒被撤過的連線送壞框，是違規：報 `violation`，不是 `unregistered`（只有 `hello` 才問表）。
#[test]
fn a_bad_frame_from_a_pid_that_is_not_on_the_table_is_a_violation() {
    let dir = temp_dir("unknown-garbage");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let (mut stream, reply) = exchange(&socket, &frame(&[0xff]));
    let Some(HostMessage::Rejected { reason }) = reply else { panic!("{reply:?}") };
    assert!(closed(&mut stream));
    assert_eq!(host.report(), Some(violation(me(), &reason)));
}

/// 驗過身分之後送壞框：違規，那個 pid 撤掉，之後再連回 `沒有登記`。
#[test]
fn a_bad_frame_after_hello_quarantines_the_pid() {
    let dir = temp_dir("verified-garbage");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    host.grant(me(), TOKEN, Role::Conversation, "a");
    let (mut stream, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    stream.write_all(&frame(&[0xff])).unwrap();
    let Some(HostMessage::Rejected { reason }) = read_message(&mut stream) else { panic!() };
    assert!(closed(&mut stream));
    assert_eq!(host.report(), Some(violation(me(), &reason)));
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
}

/// 連線自己斷（pid 不在表上的、還沒送 `hello` 的、驗過身分的、撤過的）：什麼都不報，表上那一筆不動。撤兩次跟撤一次一樣。
#[test]
fn a_connection_that_closes_reports_nothing_and_leaves_the_grant() {
    let dir = temp_dir("eof");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    drop(UnixStream::connect(&socket).unwrap());
    host.grant(me(), TOKEN, Role::Conversation, "a");
    drop(UnixStream::connect(&socket).unwrap());
    let (verified, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    drop(verified);
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, accepted(), "表上那一筆還在");
    let revoked = UnixStream::connect(&socket).unwrap();
    let mut twice = UnixStream::connect(&socket).unwrap();
    twice.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, accepted());
    host.command(&HostCommand::Revoke { pid: me() });
    host.command(&HostCommand::Revoke { pid: me() });
    // 第一筆回報就是 `twice` 的：前面那些斷線都沒報。
    twice.write_all(&hello_frame(TOKEN)).unwrap();
    assert_eq!(read_message(&mut twice), rejected("沒有登記"), "撤兩次照舊是撤過的");
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    drop(revoked);
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())), "撤過的連線斷了也不報");
}

/// 驗 `hello` 先看連線的狀態，再比版本與 token：pid 不在表上、撤過的連線送錯版本照樣是「沒有登記」，
/// 驗過的連線再送一次 `hello`，版本與 token 都錯也是「重複的 hello」。
#[test]
fn a_hello_is_judged_by_the_connection_state_before_its_version_or_token() {
    let dir = temp_dir("hello-order");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    assert_eq!(exchange(&socket, &newer_hello_frame(OTHER)).1, rejected("沒有登記"), "pid 不在表上");
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));

    host.grant(me(), TOKEN, Role::Conversation, "a");
    let (mut verified, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    let mut pending = UnixStream::connect(&socket).unwrap();
    pending.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, accepted());
    verified.write_all(&newer_hello_frame(OTHER)).unwrap();
    assert_eq!(read_message(&mut verified), rejected("重複的 hello"));
    assert_eq!(host.report(), Some(violation(me(), "重複的 hello")));

    host.grant(me(), TOKEN, Role::Conversation, "a");
    pending.write_all(&newer_hello_frame(OTHER)).unwrap();
    assert_eq!(read_message(&mut pending), rejected("沒有登記"), "撤過的連線");
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
}

/// 出廠預設下沒宣告 sandbox 的 MCP stdio 伺服器跑在 `--guard` 底下，沒有 seccomp，連得到 socket；就算拿到了別人的 token，
/// 它的 pid 不在表上，照樣被拒。
#[test]
fn an_unsandboxed_mcp_server_with_a_stolen_token_is_rejected() {
    let dir = temp_dir("guard");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut legit = Command::new(example("host_client"))
        .arg("--wait-stdin")
        .arg(&socket)
        .arg(TOKEN)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    host.grant(legit.id(), TOKEN, Role::Conversation, "a");

    let guard = Command::new(SPAWNER)
        .args(["--guard", "--"])
        .arg(example("host_client"))
        .arg(&socket)
        .arg(TOKEN)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let guard_pid = guard.id();
    let out = guard.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "host rejected 沒有登記");
    assert_eq!(unregistered(host.report()), Some((guard_pid, "沒有登記".into())));

    legit.stdin.take().unwrap().write_all(b"go\n").unwrap();
    let out = legit.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "host hello", "被偷的 token 沒有讓正主被隔離");
    assert!(host.reports_so_far().is_empty());
}

#[test]
fn a_client_that_never_says_hello_is_dropped() {
    let dir = temp_dir("silent");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream.set_read_timeout(Some(nexus_sandbox_spawner::host::HELLO_TIMEOUT * 3)).unwrap();
    let mut buf = [0u8; 1];
    assert_eq!(stream.read(&mut buf).unwrap(), 0, "超過 HELLO_TIMEOUT 要被斷");
    // 逾時不報：第一筆回報就是下面這一條的。
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
}
