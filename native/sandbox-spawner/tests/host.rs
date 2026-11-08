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
    assert_eq!(host.report(), Some(unregistered(me())));
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
    assert_eq!(host.report(), Some(unregistered(me())));

    host.grant(me(), TOKEN, Role::Front, "");
    let old = frame(&encode_client_message(&nexus_sandbox_spawner::host_protocol::ClientMessage::Hello {
        version: PROTOCOL_VERSION + 1,
        token: TOKEN.into(),
    }));
    assert_eq!(exchange(&socket, &old).1, rejected("版本不對"));
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
        assert_eq!(host.report(), Some(unregistered(me())));
    }
}

/// 撤銷只斷已經驗過身分的連線；連上了、還沒送 `hello` 的，等它送來時照表拒絕，回 `rejected`，不是不吭聲地斷掉。
#[test]
fn a_revoke_leaves_connections_that_have_not_said_hello_to_be_rejected() {
    let dir = temp_dir("pending");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    for round in 0..50 {
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let mut pending = UnixStream::connect(&socket).unwrap();
        pending.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        // 後連的這條拿到回答時，先連的那條一定已經 accept 了：宿主一次把排著的連線收完。
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert!(closed(&mut live), "驗過身分的要斷（第 {round} 輪）");
        pending.write_all(&hello_frame(TOKEN)).unwrap();
        assert_eq!(read_message(&mut pending), rejected("沒有登記"), "第 {round} 輪");
        assert_eq!(host.report(), Some(unregistered(me())));
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
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert!(closed(&mut live), "第 {round} 輪");
        host.grant(me(), TOKEN, Role::Conversation, "b");
        pending.write_all(&hello_frame(TOKEN)).unwrap();
        assert_eq!(read_message(&mut pending), rejected("沒有登記"), "第 {round} 輪");
        assert_eq!(host.report(), Some(unregistered(me())));
    }
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
    assert_eq!(host.report(), Some(unregistered(guard_pid)));

    legit.stdin.take().unwrap().write_all(b"go\n").unwrap();
    let out = legit.wait_with_output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "host hello", "被偷的 token 沒有讓正主被隔離");
    assert!(host.reports_so_far().is_empty());
}

#[test]
fn a_client_that_never_says_hello_is_dropped() {
    let dir = temp_dir("silent");
    let socket = dir.join("host.sock");
    let _host = HostProc::start(&socket);
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream.set_read_timeout(Some(nexus_sandbox_spawner::host::HELLO_TIMEOUT * 3)).unwrap();
    let mut buf = [0u8; 1];
    assert_eq!(stream.read(&mut buf).unwrap(), 0, "超過 HELLO_TIMEOUT 要被斷");
}
