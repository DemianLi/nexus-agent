//! 真的 `nexus-host`（#2569）：測試站在監督行程的位置握手、送身分表，再從各種客戶端連它的 socket。只在 Linux 跑。
//!
//! 多數情境由測試行程自己當客戶端（把自己的 pid 登記上去）；要另一個 pid 的用 `examples/host_client`。

#![cfg(target_os = "linux")]

#[path = "../../tests/common/mod.rs"]
mod common;
/// 本機 HTTPS 與假 MCP server（`host/tests/common/`）。
#[path = "common/mod.rs"]
mod tls_common;

use common::host::{example, unregistered, violation, HostProc, GRANTED};
use nexus_host::host_protocol::{
    decode_host_message, encode_client_message, hello, HostMessage, HOST_PROTOCOL_VERSION,
    MAX_FRAME,
};
use nexus_host::json::{self, Value};
use nexus_sandbox_spawner::protocol::frame;
use nexus_sandbox_spawner::supervisor_protocol::{HostCommand, HostReport, Role, PROTOCOL_VERSION};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// spawner 在另一個 package，見 `common::built`。
fn spawner() -> std::path::PathBuf {
    common::built("nexus-sandbox-spawner")
}
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
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
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
    frame(&encode_client_message(
        &nexus_host::host_protocol::ClientMessage::Hello {
            version: HOST_PROTOCOL_VERSION + 1,
            token: token.into(),
        },
    ))
}

/// 前面那些連線都沒報任何東西：送一條壞框，下一筆回報就要是它的 `violation`。多報的不管是哪一種，都排在它前面、先被讀到。
/// 壞框會撤掉測試行程的 pid，所以放在測試最後。`generation` 是那時表上測試行程那一筆的序號，沒有是 0。
fn assert_nothing_reported_before_a_bad_frame(socket: &Path, host: &mut HostProc, generation: u32) {
    let (_, reply) = exchange(socket, &frame(&[0xff]));
    let Some(HostMessage::Rejected { reason }) = reply else {
        panic!("{reply:?}")
    };
    assert_eq!(host.report(), Some(violation(me(), generation, &reason)));
}

fn rejected(reason: &str) -> Option<HostMessage> {
    Some(HostMessage::Rejected {
        reason: reason.into(),
    })
}

fn accepted() -> Option<HostMessage> {
    Some(HostMessage::Hello {
        version: HOST_PROTOCOL_VERSION,
    })
}

/// 斷線了：讀逾時之前讀到 EOF，或對方重設連線。逾時（還連著）與讀到資料都不算。
fn closed(stream: &mut UnixStream) -> bool {
    let mut buf = [0u8; 1];
    match stream.read(&mut buf) {
        Ok(n) => n == 0,
        Err(err) => err.kind() == std::io::ErrorKind::ConnectionReset,
    }
}

/// 這個行程累計用掉的 CPU（clock tick，一般是 10 ms）。
fn cpu_ticks(pid: u32) -> u64 {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
    let fields: Vec<&str> = stat.rsplit_once(") ").unwrap().1.split(' ').collect();
    // 括號後第 12、13 欄是 utime、stime（stat 的第 14、15 欄）。
    fields[11].parse::<u64>().unwrap() + fields[12].parse::<u64>().unwrap()
}

/// 開檔數用完：排著的連線接下來就關，宿主不空轉；fd 空出來之後照常收連線。每條連線佔 2 個 fd：剩 1 個時 accept 成功、
/// 複製 fd 失敗，連線當場關掉，碰不到 EMFILE；所以兩個相鄰的上限各跑一次，其中一個剩 0 個、一定走到 EMFILE。
#[test]
fn running_out_of_fds_closes_queued_connections_instead_of_spinning() {
    for limit in [12, 13] {
        out_of_fds_at(limit);
    }
}

fn out_of_fds_at(limit: u64) {
    let dir = temp_dir("emfile");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start_with_open_file_limit(&socket, limit);
    let mut streams: Vec<UnixStream> = (0..8)
        .map(|_| UnixStream::connect(&socket).unwrap())
        .collect();
    std::thread::sleep(Duration::from_millis(200));
    let pid = host.child.id();
    let before = cpu_ticks(pid);
    std::thread::sleep(Duration::from_secs(1));
    let spent = cpu_ticks(pid) - before;
    assert!(spent < 20, "上限 {limit}：宿主 1 秒內用了 {spent} 個 tick");

    for stream in &streams {
        stream
            .set_read_timeout(Some(Duration::from_millis(1000)))
            .unwrap();
    }
    let shed = streams
        .iter_mut()
        .rev()
        .take(4)
        .map(closed)
        .filter(|&c| c)
        .count();
    assert_eq!(shed, 4, "上限 {limit}：排在後面的連線沒被關掉");

    drop(streams);
    host.grant(me(), TOKEN, Role::Conversation, "a");
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let (_stream, reply) = exchange(&socket, &hello_frame(TOKEN));
        if reply == accepted() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "上限 {limit}：fd 空出來之後還是收不了連線：{reply:?}"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// 違規帶回那條連線所屬那一筆的序號：送過 `hello` 的是驗它時那一筆的，表上那個 pid 之後換了一筆也一樣；還沒送的是表上現在那一筆的。
#[test]
fn a_violation_carries_the_generation_of_the_grant_it_belongs_to() {
    let dir = temp_dir("gen");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    host.grant_as(me(), 41, TOKEN, Role::Conversation, "a");
    let (mut stream, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    host.grant_as(me(), 42, TOKEN, Role::Conversation, "a");
    stream.write_all(&hello_frame(TOKEN)).unwrap();
    assert_eq!(read_message(&mut stream), rejected("重複的 hello"));
    assert_eq!(host.report(), Some(violation(me(), 41, "重複的 hello")));

    host.grant_as(me(), 43, TOKEN, Role::Conversation, "a");
    let (_, reply) = exchange(&socket, &hello_frame(OTHER));
    assert_eq!(reply, rejected("token 不對"));
    assert_eq!(host.report(), Some(violation(me(), 43, "token 不對")));
}

/// 一段時間內沒有任何回應、也沒斷線：讀逾時（還連著）才算，讀到資料或 EOF 都不算。
fn silent_for(stream: &mut UnixStream, wait: Duration) -> bool {
    stream.set_read_timeout(Some(wait)).unwrap();
    let mut buf = [0u8; 1];
    matches!(
        stream.read(&mut buf),
        Err(err) if matches!(err.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut)
    )
}

/// 身分表到齊（`Synced`）之前宿主不讀連線：`hello` 先到也不回，也不報；表（`grant`）來了還是不回；`Synced` 到了才照一般的規則驗：表上有這個 pid，接受。
#[test]
fn a_hello_is_not_answered_until_the_table_is_synced() {
    let dir = temp_dir("synced");
    let socket = dir.join("host.sock");
    let mut host = HostProc::spawn(&socket);
    host.ready_without_table();
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream.write_all(&hello_frame(TOKEN)).unwrap();
    let wait = Duration::from_millis(300);
    assert!(silent_for(&mut stream, wait), "表還沒到就回了");
    assert_eq!(host.reports_so_far(), vec![], "表還沒到就報了");
    host.grant(me(), TOKEN, Role::Conversation, "a");
    assert!(silent_for(&mut stream, wait), "只有 grant 還不算到齊");
    host.command(&HostCommand::Synced);
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    assert_eq!(read_message(&mut stream), accepted());
}

/// 空表也要等 `Synced`：到了之後，表上沒有的 pid 才回「沒有登記」、報 `unregistered`。
#[test]
fn an_empty_table_is_also_waited_for_and_then_rejects() {
    let dir = temp_dir("synced-empty");
    let socket = dir.join("host.sock");
    let mut host = HostProc::spawn(&socket);
    host.ready_without_table();
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream.write_all(&hello_frame(TOKEN)).unwrap();
    assert!(
        silent_for(&mut stream, Duration::from_millis(300)),
        "表還沒到就回了"
    );
    host.command(&HostCommand::Synced);
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    assert_eq!(read_message(&mut stream), rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
}

/// 表一直不來：宿主不自己放行、不報，等了 `HELLO_TIMEOUT` 的連線被斷，斷之前沒回任何框。
#[test]
fn a_connection_waiting_for_a_table_that_never_comes_is_dropped_silently() {
    let dir = temp_dir("synced-never");
    let socket = dir.join("host.sock");
    let mut host = HostProc::spawn(&socket);
    host.ready_without_table();
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream.write_all(&hello_frame(TOKEN)).unwrap();
    stream
        .set_read_timeout(Some(nexus_host::host::HELLO_TIMEOUT * 3))
        .unwrap();
    let started = Instant::now();
    assert_eq!(read_message(&mut stream), None, "斷之前不該回任何框");
    assert!(started.elapsed() >= nexus_host::host::HELLO_TIMEOUT / 2);
    assert_eq!(host.reports_so_far(), vec![], "不該報 unregistered");
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
    for version in [PROTOCOL_VERSION + 1, PROTOCOL_VERSION - 1] {
        let dir = temp_dir("ver");
        let socket = dir.join("host.sock");
        let mut host = HostProc::spawn(&socket);
        assert_eq!(
            host.report(),
            Some(HostReport::Hello {
                version: PROTOCOL_VERSION
            })
        );
        host.command(&HostCommand::Hello { version });
        assert_eq!(host.wait().code(), Some(3), "{version}");
        assert!(!socket.exists());
    }
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
    assert_eq!(
        host.report(),
        Some(violation(me(), GRANTED, "重複的 hello"))
    );
    // 隔離：同一個 pid 再連，表上已經沒有它。
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        rejected("沒有登記")
    );
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
    assert_eq!(
        exchange(&socket, &hello_frame(OTHER)).1,
        rejected("token 不對")
    );
    assert_eq!(host.report(), Some(violation(me(), GRANTED, "token 不對")));
    assert!(closed(&mut first), "隔離時它其他驗過身分的連線要一起斷");
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        rejected("沒有登記")
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));

    host.grant(me(), TOKEN, Role::Front, "");
    assert_eq!(
        exchange(&socket, &newer_hello_frame(TOKEN)).1,
        rejected("版本不對")
    );
    assert_eq!(host.report(), Some(violation(me(), GRANTED, "版本不對")));
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        rejected("沒有登記"),
        "版本不對也撤 pid"
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
}

#[test]
fn every_invalid_vector_is_rejected_and_the_host_keeps_serving() {
    let vectors = json::parse(include_bytes!("../../host-vectors.json")).unwrap();
    let dir = temp_dir("invalid");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let unhex = |hex: &str| -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    };
    let text =
        |entry: &Value, key: &str| entry.get(key).and_then(Value::as_str).unwrap().to_string();
    for entry in vectors
        .get("invalidMessages")
        .and_then(Value::as_array)
        .unwrap()
    {
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let reason = text(entry, "error");
        let (mut stream, reply) = exchange(&socket, &frame(&unhex(&text(entry, "hex"))));
        assert_eq!(reply, rejected(&reason), "{}", text(entry, "name"));
        assert!(closed(&mut stream));
        assert_eq!(host.report(), Some(violation(me(), GRANTED, &reason)));
        assert_eq!(
            exchange(&socket, &hello_frame(TOKEN)).1,
            rejected("沒有登記"),
            "{}：pid 撤掉了",
            text(entry, "name")
        );
        assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    }
    for entry in vectors
        .get("invalidFrames")
        .and_then(Value::as_array)
        .unwrap()
    {
        if text(entry, "expect") != "error" {
            continue;
        }
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let (_, reply) = exchange(&socket, &unhex(&text(entry, "hex")));
        assert_eq!(reply, rejected("框太大"), "{}", text(entry, "name"));
        assert_eq!(host.report(), Some(violation(me(), GRANTED, "框太大")));
        assert_eq!(
            exchange(&socket, &hello_frame(TOKEN)).1,
            rejected("沒有登記"),
            "{}：pid 撤掉了",
            text(entry, "name")
        );
        assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    }
    // 剛好等於上限的框照收：內容是一份合法的 hello，後面補空白補到上限。
    host.grant(me(), TOKEN, Role::Conversation, "a");
    let mut payload = encode_client_message(&hello(TOKEN));
    payload.resize(MAX_FRAME, b' ');
    assert_eq!(exchange(&socket, &frame(&payload)).1, accepted());
    assert!(
        host.child.try_wait().unwrap().is_none(),
        "宿主不因為任何一條連線結束"
    );
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
        assert_eq!(
            exchange(&socket, &hello_frame(TOKEN)).1,
            rejected("沒有登記"),
            "第 {round} 輪"
        );
        assert!(
            closed(&mut live),
            "撤銷時它驗過身分的連線要一起斷（第 {round} 輪）"
        );
        assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    }
    assert_nothing_reported_before_a_bad_frame(&socket, &mut host, 0);
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
        pending
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        // 後連的這條拿到回答時，先連的那條已經 accept 了（backlog 先進先出）：這裡測的是撤銷時已經 accept 的；
        // 還在 backlog 的見 `a_connection_still_in_the_backlog_at_a_revoke_is_not_verified_against_a_later_grant`。
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert!(closed(&mut live), "驗過身分的要斷（第 {round} 輪）");
        pending.write_all(&hello_frame(TOKEN)).unwrap();
        assert_eq!(
            read_message(&mut pending),
            rejected("沒有登記"),
            "第 {round} 輪"
        );
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
        pending
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        // 後連的這條拿到回答時，先連的那條已經 accept 了（backlog 先進先出）：這裡測的是撤銷時已經 accept 的；
        // 還在 backlog 的見 `a_connection_still_in_the_backlog_at_a_revoke_is_not_verified_against_a_later_grant`。
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert!(closed(&mut live), "第 {round} 輪");
        host.grant(me(), TOKEN, Role::Conversation, "b");
        pending.write_all(&hello_frame(TOKEN)).unwrap();
        assert_eq!(
            read_message(&mut pending),
            rejected("沒有登記"),
            "第 {round} 輪"
        );
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
        pending
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let (mut live, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted(), "第 {round} 輪");
        host.command(&HostCommand::Revoke { pid: me() });
        assert!(closed(&mut live), "第 {round} 輪");
        host.grant(me(), OTHER, Role::Conversation, "b");
        pending.write_all(&frame(&[0xff])).unwrap();
        let Some(HostMessage::Rejected { reason }) = read_message(&mut pending) else {
            panic!("第 {round} 輪")
        };
        assert_eq!(
            unregistered(host.report()),
            Some((me(), reason)),
            "第 {round} 輪"
        );
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
    let mut full: Vec<UnixStream> = (0..nexus_host::host::MAX_CONNECTIONS)
        .map(|n| {
            let (stream, reply) = exchange(&socket, &hello_frame(TOKEN));
            assert_eq!(reply, accepted(), "第 {n} 條");
            stream
        })
        .collect();
    // 宿主滿了不 accept：這條停在 backlog。
    let mut queued = UnixStream::connect(&socket).unwrap();
    queued
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
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
    let mut cmd = Command::new(common::host::host());
    cmd.arg("--socket")
        .arg(dir.join("host.sock"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
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
    child
        .stdout
        .as_mut()
        .unwrap()
        .read_exact(&mut head)
        .unwrap();
    let limits = std::fs::read_to_string(format!("/proc/{}/limits", child.id())).unwrap();
    let line = limits
        .lines()
        .find(|l| l.starts_with("Max open files"))
        .unwrap()
        .to_string();
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
        assert_eq!(
            exchange(&socket, &hello_frame(TOKEN)).1,
            rejected("沒有登記")
        );
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

/// A⁰（README〈連線身分的狀態表〉）：宿主讀不到連線那一端的 pid。要 `--features test-hooks`（`NEXUS_HOST_TEST_NO_PEER_PID`），
/// CI 兩輪都帶；不帶時這幾支會紅，不會跳過。開關是整個宿主行程的，這個宿主的每一條連線都是 A⁰，所以測試行程雖然登記在表上、
/// 連的又是自己，也查不到表：讀得到 pid 的對照連線另開一個宿主（上面那些測試）。
mod peer_pid_unreadable {
    use super::*;

    /// 測試行程登記在表上、token 對：讀得到 pid 的話 `hello` 會被放行。
    fn started(tag: &str) -> (PathBuf, HostProc) {
        let dir = temp_dir(tag);
        let socket = dir.join("host.sock");
        let mut host = HostProc::start_without_peer_pid(&socket);
        host.grant(me(), TOKEN, Role::Conversation, "a");
        (socket, host)
    }

    /// 壞框：A⁰ 的 `violation` 帶 pid 0、序號 0（沒 `hello` 的連線用 pid 查表，查不到就是 0），也沒有 pid 可撤。
    fn assert_a_bad_frame_is_the_next_report(socket: &Path, host: &mut HostProc) {
        let (mut stream, reply) = exchange(socket, &frame(&[0xff]));
        let Some(HostMessage::Rejected { reason }) = reply else {
            panic!("{reply:?}")
        };
        assert_eq!(host.report(), Some(violation(0, 0, &reason)));
        assert!(closed(&mut stream));
    }

    #[test]
    fn a_hello_with_the_right_token_is_not_registered_and_reports_pid_0() {
        let (socket, mut host) = started("a0-hello");
        let (mut stream, reply) = exchange(&socket, &hello_frame(TOKEN));
        assert_eq!(reply, rejected("沒有登記"));
        assert!(closed(&mut stream));
        assert_eq!(unregistered(host.report()), Some((0, "沒有登記".into())));
    }

    /// 不看 token 與版本：先看連線的狀態。
    #[test]
    fn a_hello_with_a_wrong_token_or_version_is_also_not_registered() {
        let (socket, mut host) = started("a0-wrong");
        for bytes in [hello_frame(OTHER), newer_hello_frame(TOKEN)] {
            assert_eq!(exchange(&socket, &bytes).1, rejected("沒有登記"));
            assert_eq!(unregistered(host.report()), Some((0, "沒有登記".into())));
        }
        assert_a_bad_frame_is_the_next_report(&socket, &mut host);
    }

    #[test]
    fn a_bad_frame_is_a_violation_of_pid_0_with_nothing_to_revoke() {
        let (socket, mut host) = started("a0-bad-frame");
        assert_a_bad_frame_is_the_next_report(&socket, &mut host);
        // 沒有 pid 可撤：表上測試行程那一筆（型別守，見 README n1）不在這裡驗；下一條連線照樣是 A⁰。
        assert_eq!(
            exchange(&socket, &hello_frame(TOKEN)).1,
            rejected("沒有登記")
        );
        assert_eq!(unregistered(host.report()), Some((0, "沒有登記".into())));
    }

    /// 先在另一條連線送 `hello`，確認開關生效（開關是整個宿主的）：連線自己斷時，不管讀不讀得到 pid 都不報，單看 EOF 分不出開關有沒有開。
    #[test]
    fn a_connection_that_closes_reports_nothing() {
        let (socket, mut host) = started("a0-eof");
        let mut stream = UnixStream::connect(&socket).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        stream.write_all(&hello_frame(TOKEN)).unwrap();
        assert_eq!(read_message(&mut stream), rejected("沒有登記"));
        assert_eq!(unregistered(host.report()), Some((0, "沒有登記".into())));
        drop(stream);
        let silent = UnixStream::connect(&socket).unwrap();
        drop(silent);
        assert_a_bad_frame_is_the_next_report(&socket, &mut host);
    }
}

/// 同一個 pid 再登記一次（對話行程綁了 thread）：整筆換掉。還沒送 `hello` 的照新的那一筆驗，驗過身分的照樣連著，舊 token 不再算數。
/// 連上之後才到的登記也算：驗 `hello` 之前先讀乾淨控制通道。
#[test]
fn a_regrant_replaces_the_token_and_keeps_verified_connections() {
    let dir = temp_dir("regrant");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut early = UnixStream::connect(&socket).unwrap();
    early
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    // 後連的拿到回答時，先連的 `early` 已經 accept 了：登記到的時候它是 pid 不在表上的連線，不是還在 backlog。
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        rejected("沒有登記")
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    host.grant(me(), TOKEN, Role::Conversation, "");
    let (mut verified, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    let mut pending = UnixStream::connect(&socket).unwrap();
    pending
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, accepted());
    host.grant(me(), OTHER, Role::Conversation, "a");
    early.write_all(&hello_frame(OTHER)).unwrap();
    assert_eq!(read_message(&mut early), accepted(), "連上之後才到的登記");
    pending.write_all(&hello_frame(OTHER)).unwrap();
    assert_eq!(
        read_message(&mut pending),
        accepted(),
        "還沒送 hello 的照新的那一筆驗"
    );
    verified
        .set_read_timeout(Some(Duration::from_millis(300)))
        .unwrap();
    let mut buf = [0u8; 1];
    assert!(
        matches!(verified.read(&mut buf), Err(err) if err.kind() == std::io::ErrorKind::WouldBlock),
        "驗過身分的照樣連著"
    );
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        rejected("token 不對")
    );
    assert_eq!(host.report(), Some(violation(me(), GRANTED, "token 不對")));
}

/// pid 不在表上、還沒送 `hello` 的連線，撤銷時也記成撤過：之後同一個號碼登記了，它也不照那一筆驗。
#[test]
fn a_connection_from_a_pid_not_on_the_table_is_also_marked_by_a_revoke() {
    let dir = temp_dir("unknown-revoked");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut pending = UnixStream::connect(&socket).unwrap();
    pending
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        rejected("沒有登記")
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    host.command(&HostCommand::Revoke { pid: me() });
    host.grant(me(), TOKEN, Role::Conversation, "a");
    pending.write_all(&hello_frame(TOKEN)).unwrap();
    assert_eq!(read_message(&mut pending), rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        accepted(),
        "撤銷之後才連的照新的那一筆驗"
    );
}

/// pid 不在表上、也沒被撤過的連線送壞框，是違規：報 `violation`，不是 `unregistered`（只有 `hello` 才問表）。
#[test]
fn a_bad_frame_from_a_pid_that_is_not_on_the_table_is_a_violation() {
    let dir = temp_dir("unknown-garbage");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut pending = UnixStream::connect(&socket).unwrap();
    pending
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    // 這條拿到回答時，先連的 `pending` 已經 accept 了：宿主自己撤 pid 不收 backlog，還在 backlog 的不會記成撤過。
    let (mut stream, reply) = exchange(&socket, &frame(&[0xff]));
    let Some(HostMessage::Rejected { reason }) = reply else {
        panic!("{reply:?}")
    };
    assert!(closed(&mut stream));
    assert_eq!(host.report(), Some(violation(me(), 0, &reason)));
    // 表上沒有它可以拿掉；撤 pid 看得到的是同一個 pid 還沒送 `hello` 的連線記成撤過，之後登記了也不照那一筆驗。
    host.grant(me(), TOKEN, Role::Conversation, "a");
    pending.write_all(&hello_frame(TOKEN)).unwrap();
    assert_eq!(read_message(&mut pending), rejected("沒有登記"));
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
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
    let Some(HostMessage::Rejected { reason }) = read_message(&mut stream) else {
        panic!()
    };
    assert!(closed(&mut stream));
    assert_eq!(host.report(), Some(violation(me(), GRANTED, &reason)));
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        rejected("沒有登記")
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
}

/// 連線自己斷（pid 不在表上的、還沒送 `hello` 的、驗過身分的、撤過的）：什麼都不報，表上那一筆不動。撤兩次跟撤一次一樣。
#[test]
fn a_connection_that_closes_reports_nothing_and_leaves_the_grant() {
    let dir = temp_dir("eof");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    drop(UnixStream::connect(&socket).unwrap());
    // 宿主讀到上一條的 EOF 不會晚於驗這一條的 `hello`：上一條斷的時候 pid 確實不在表上。
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        rejected("沒有登記")
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    host.grant(me(), TOKEN, Role::Conversation, "a");
    drop(UnixStream::connect(&socket).unwrap());
    let (verified, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    drop(verified);
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        accepted(),
        "表上那一筆還在"
    );
    let revoked = UnixStream::connect(&socket).unwrap();
    let mut twice = UnixStream::connect(&socket).unwrap();
    twice
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, accepted());
    host.command(&HostCommand::Revoke { pid: me() });
    host.command(&HostCommand::Revoke { pid: me() });
    host.grant(me(), TOKEN, Role::Conversation, "a");
    // 宿主驗 `twice` 之前先讀乾淨控制通道：它拿到回答時，上面三筆都生效了，之後才連的不會被那兩筆 `revoke` 從 backlog 收走。
    twice.write_all(&hello_frame(TOKEN)).unwrap();
    assert_eq!(
        read_message(&mut twice),
        rejected("沒有登記"),
        "撤兩次照舊是撤過的，不照新的那一筆驗"
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    drop(revoked);
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        accepted(),
        "撤過的連線斷了不撤新的那一筆"
    );
    assert_nothing_reported_before_a_bad_frame(&socket, &mut host, GRANTED);
}

/// 驗 `hello` 先看連線的狀態，再比版本與 token：pid 不在表上、撤過的連線送錯版本與 token 照樣是「沒有登記」，
/// 驗過的連線再送一次 `hello`，版本與 token 都錯也是「重複的 hello」。
#[test]
fn a_hello_is_judged_by_the_connection_state_before_its_version_or_token() {
    let dir = temp_dir("hello-order");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    assert_eq!(
        exchange(&socket, &newer_hello_frame(OTHER)).1,
        rejected("沒有登記"),
        "pid 不在表上"
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));

    host.grant(me(), TOKEN, Role::Conversation, "a");
    let (mut verified, reply) = exchange(&socket, &hello_frame(TOKEN));
    assert_eq!(reply, accepted());
    let mut pending = UnixStream::connect(&socket).unwrap();
    pending
        .set_read_timeout(Some(Duration::from_secs(10)))
        .unwrap();
    // 這條拿到回答時，先連的 `pending` 已經 accept 了：宿主自己撤 pid 不收 backlog，還在 backlog 的不會記成撤過。
    assert_eq!(exchange(&socket, &hello_frame(TOKEN)).1, accepted());
    verified.write_all(&newer_hello_frame(OTHER)).unwrap();
    assert_eq!(read_message(&mut verified), rejected("重複的 hello"));
    assert_eq!(
        host.report(),
        Some(violation(me(), GRANTED, "重複的 hello"))
    );

    host.grant(me(), TOKEN, Role::Conversation, "a");
    pending.write_all(&newer_hello_frame(OTHER)).unwrap();
    assert_eq!(
        read_message(&mut pending),
        rejected("沒有登記"),
        "撤過的連線"
    );
    assert_eq!(unregistered(host.report()), Some((me(), "沒有登記".into())));
    assert_eq!(
        exchange(&socket, &hello_frame(TOKEN)).1,
        accepted(),
        "不撤表上那一筆"
    );
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

    let guard = Command::new(spawner())
        .args(["--guard", "--"])
        .arg(example("host_client"))
        .arg(&socket)
        .arg(TOKEN)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let guard_pid = guard.id();
    let out = guard.wait_with_output().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "host rejected 沒有登記"
    );
    assert_eq!(
        unregistered(host.report()),
        Some((guard_pid, "沒有登記".into()))
    );

    legit.stdin.take().unwrap().write_all(b"go\n").unwrap();
    let out = legit.wait_with_output().unwrap();
    assert_eq!(
        String::from_utf8_lossy(&out.stdout).trim(),
        "host hello",
        "被偷的 token 沒有讓正主被隔離"
    );
    assert!(host.reports_so_far().is_empty());
}

#[test]
fn a_client_that_never_says_hello_is_dropped() {
    let dir = temp_dir("silent");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    let mut stream = UnixStream::connect(&socket).unwrap();
    stream
        .set_read_timeout(Some(nexus_host::host::HELLO_TIMEOUT * 3))
        .unwrap();
    let mut buf = [0u8; 1];
    assert_eq!(
        stream.read(&mut buf).unwrap(),
        0,
        "超過 HELLO_TIMEOUT 要被斷"
    );
    assert_nothing_reported_before_a_bad_frame(&socket, &mut host, 0);
}

/// `--plugins` 的清單（`src/host/plugins.rs`）。`test-echo` 只在 `test-hooks` 的建置裡有。
mod plugins {
    use super::*;
    use nexus_host::host::EXIT_CONFIG;

    fn host_with(tag: &str, list: Option<&str>) -> (PathBuf, PathBuf) {
        let dir = temp_dir(tag);
        let plugins = dir.join("host-plugins.json");
        if let Some(list) = list {
            std::fs::write(&plugins, list).unwrap();
        }
        (dir.join("host.sock"), plugins)
    }

    /// 宿主換完 `hello` 就以設定壞了結束：不送 `ready`、不綁 socket。回它的 stderr。
    fn refused(socket: &Path, plugins: &Path) -> String {
        let mut host = HostProc::spawn_with_plugins(socket, plugins);
        host.hello_only();
        assert_eq!(host.wait().code(), Some(EXIT_CONFIG));
        let Some(HostReport::ConfigBroken { reason }) = host.report() else {
            panic!("要 config-broken")
        };
        assert_eq!(host.report(), None, "設定壞了不送 ready");
        assert!(!socket.exists());
        let stderr = host.stderr();
        let reason = String::from_utf8(reason).expect("config-broken 的原因是 UTF-8");
        assert!(
            stderr.contains(&reason),
            "config-broken 帶的是 log 那句：{reason}\n{stderr}"
        );
        stderr
    }

    #[test]
    fn a_listed_plugin_is_mounted_before_ready() {
        let (socket, plugins) = host_with(
            "plugins-ok",
            Some(r#"[{"name":"test-echo","config":{"greeting":"早"}}]"#),
        );
        let host = HostProc::start_with_plugins(&socket, &plugins);
        let stderr = host.stderr();
        assert!(stderr.contains("test-echo apply：早"), "{stderr}");
        assert!(
            stderr.contains("插件 test-echo：Loading → Active"),
            "{stderr}"
        );
    }

    #[test]
    fn a_missing_list_is_an_empty_tree() {
        let (socket, plugins) = host_with("plugins-missing", None);
        let host = HostProc::start_with_plugins(&socket, &plugins);
        let stderr = host.stderr();
        assert!(stderr.contains("不存在，不掛插件"), "{stderr}");
        assert!(!stderr.contains("test-echo"), "{stderr}");
    }

    #[test]
    fn a_list_that_cannot_be_read_stops_the_host() {
        let (socket, plugins) = host_with("plugins-unreadable", None);
        std::fs::create_dir(&plugins).unwrap();
        let stderr = refused(&socket, &plugins);
        assert!(
            stderr.contains("插件清單壞了") && stderr.contains("讀不了"),
            "{stderr}"
        );
    }

    #[test]
    fn a_malformed_list_stops_the_host() {
        let (socket, plugins) =
            host_with("plugins-bad", Some(r#"[{"name":"test-echo","confg":{}}]"#));
        let stderr = refused(&socket, &plugins);
        assert!(
            stderr.contains("插件清單壞了") && stderr.contains("confg"),
            "{stderr}"
        );
    }

    #[test]
    fn intercept_stops_the_host_and_points_to_its_card() {
        let (socket, plugins) = host_with(
            "plugins-intercept",
            Some(r#"[{"name":"test-echo","intercept":{}}]"#),
        );
        let stderr = refused(&socket, &plugins);
        assert!(
            stderr.contains("intercept") && stderr.contains("/issues/2596"),
            "{stderr}"
        );
    }

    #[test]
    fn a_config_the_plugin_refuses_leaves_the_host_up_without_it() {
        let (socket, plugins) = host_with(
            "plugins-config",
            Some(r#"[{"name":"test-echo","config":{"greeting":1}}]"#),
        );
        let host = HostProc::start_with_plugins(&socket, &plugins);
        let stderr = host.stderr();
        assert!(
            stderr.contains("插件 test-echo 沒掛：設定不合法：greeting 必須是字串"),
            "{stderr}"
        );
        assert!(!stderr.contains("test-echo apply"), "{stderr}");
    }
}

/// 控制通道的版本是 3：客戶端送 3 進來，宿主判版本不對（報 violation），不當成這一版。
#[test]
fn a_hello_with_the_control_channel_version_is_a_version_mismatch() {
    let dir = temp_dir("old-version");
    let socket = dir.join("host.sock");
    let mut host = HostProc::start(&socket);
    host.grant(me(), TOKEN, Role::Conversation, "a");
    let old = frame(&encode_client_message(
        &nexus_host::host_protocol::ClientMessage::Hello {
            version: 3,
            token: TOKEN.into(),
        },
    ));
    assert_eq!(exchange(&socket, &old).1, rejected("版本不對"));
    assert_eq!(host.report(), Some(violation(me(), GRANTED, "版本不對")));
}

/// 驗過身分的連線上的呼叫（`src/host/calls.rs`）。服務是 `test-echo/echo`（`src/host/test_plugin.rs`）。
mod calls {
    use super::*;
    use nexus_host::host::calls::MAX_CALLS;
    use nexus_host::host_protocol::{CallError, ClientMessage, ErrorCode, Side};

    const ECHO: &str = "test-echo/echo";

    /// 掛著 `test-echo` 的宿主，測試行程已經登記。
    fn host(tag: &str) -> (HostProc, PathBuf) {
        let dir = temp_dir(tag);
        let plugins = dir.join("host-plugins.json");
        std::fs::write(&plugins, r#"[{"name":"test-echo"}]"#).unwrap();
        let socket = dir.join("host.sock");
        let mut host = HostProc::start_with_plugins(&socket, &plugins);
        host.grant(me(), TOKEN, Role::Conversation, "a");
        (host, socket)
    }

    fn connect(socket: &Path) -> UnixStream {
        let (stream, reply) = exchange(socket, &hello_frame(TOKEN));
        assert_eq!(reply, accepted());
        stream
    }

    fn send(stream: &mut UnixStream, message: &ClientMessage) {
        stream
            .write_all(&frame(&encode_client_message(message)))
            .unwrap();
    }

    fn call(stream: &mut UnixStream, id: u64, method: &str, payload: &str) {
        call_to(stream, id, ECHO, method, payload);
    }

    fn call_to(stream: &mut UnixStream, id: u64, service: &str, method: &str, payload: &str) {
        send(
            stream,
            &ClientMessage::Call {
                side: Side::Client,
                id,
                service: service.into(),
                method: method.into(),
                payload: json::parse(payload.as_bytes()).unwrap(),
            },
        );
    }

    fn cancel(stream: &mut UnixStream, id: u64) {
        send(
            stream,
            &ClientMessage::Cancel {
                side: Side::Client,
                id,
            },
        );
    }

    fn ok(id: u64, value: &str) -> Option<HostMessage> {
        Some(HostMessage::Result {
            side: Side::Client,
            id,
            outcome: Ok(json::parse(value.as_bytes()).unwrap()),
        })
    }

    /// 下一框是 `id` 的失敗結果，回它的錯誤碼。
    fn error_code(stream: &mut UnixStream, id: u64) -> ErrorCode {
        match read_message(stream) {
            Some(HostMessage::Result {
                side: Side::Client,
                id: got,
                outcome: Err(CallError { code, .. }),
            }) if got == id => code,
            other => panic!("要 {id} 的失敗結果，收到 {other:?}"),
        }
    }

    fn cancels(stream: &mut UnixStream, id: u64) -> i64 {
        call(stream, id, "cancels", "null");
        match read_message(stream) {
            Some(HostMessage::Result {
                outcome: Ok(value), ..
            }) if value.is_i64() => value.as_i64().unwrap(),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_call_gets_exactly_one_result_and_errors_keep_the_connection() {
        let (_host, socket) = host("call-basic");
        let mut stream = connect(&socket);
        call(&mut stream, 1, "echo", r#"{"a":[1,null,true],"b":"字"}"#);
        assert_eq!(
            read_message(&mut stream),
            ok(1, r#"{"a":[1,null,true],"b":"字"}"#)
        );
        call_to(&mut stream, 2, "nope", "m", "null");
        assert_eq!(error_code(&mut stream, 2), ErrorCode::UnknownService);
        call(&mut stream, 3, "nope", "null");
        assert_eq!(error_code(&mut stream, 3), ErrorCode::UnknownMethod);
        call(&mut stream, 4, "fail", "null");
        assert_eq!(error_code(&mut stream, 4), ErrorCode::ServiceError);
        call(&mut stream, 5, "reject", "null");
        assert_eq!(error_code(&mut stream, 5), ErrorCode::BadPayload);
        // 結束了的 id 可以再用。
        call(&mut stream, 1, "echo", "7");
        assert_eq!(read_message(&mut stream), ok(1, "7"));
    }

    #[test]
    fn a_stream_sends_numbered_chunks_then_its_result() {
        let (_host, socket) = host("call-stream");
        let mut stream = connect(&socket);
        call(&mut stream, 9, "stream", r#"{"count":3}"#);
        for seq in 0..3 {
            assert_eq!(
                read_message(&mut stream),
                Some(HostMessage::Chunk {
                    side: Side::Client,
                    id: 9,
                    seq,
                    payload: Value::from(seq),
                })
            );
        }
        assert_eq!(read_message(&mut stream), ok(9, "3"));
    }

    #[test]
    fn a_stream_that_pushed_chunks_and_is_still_pending_is_polled_again_next_round() {
        let (_host, socket) = host("call-drip");
        let mut stream = connect(&socket);
        let started = std::time::Instant::now();
        // 服務每步只推一塊、不寫時限也不用喚醒 fd：宿主不在下一輪再 poll 的話，推完第一塊就一直掛著，讀到逾時。
        call(&mut stream, 4, "drip", r#"{"count":5}"#);
        for seq in 0..5 {
            assert_eq!(
                read_message(&mut stream),
                Some(HostMessage::Chunk {
                    side: Side::Client,
                    id: 4,
                    seq,
                    payload: Value::from(seq),
                })
            );
        }
        assert_eq!(read_message(&mut stream), ok(4, "5"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_pending_call_finishes_on_the_deadline_the_service_asks_for() {
        let (_host, socket) = host("call-wait");
        let mut stream = connect(&socket);
        let started = std::time::Instant::now();
        call(&mut stream, 1, "wait", r#"{"ms":200}"#);
        assert_eq!(read_message(&mut stream), ok(1, r#""done""#));
        assert!(started.elapsed() >= Duration::from_millis(200));
    }

    #[test]
    fn a_call_finished_on_another_thread_wakes_the_host_through_its_fd() {
        let (_host, socket) = host("call-later");
        let mut stream = connect(&socket);
        let started = std::time::Instant::now();
        // 服務不寫時限：宿主沒被喚醒 fd 叫醒的話，這一次會一直掛著，讀到逾時。
        call(&mut stream, 1, "later", r#"{"ms":200}"#);
        call(&mut stream, 2, "later", r#"{"ms":50}"#);
        // 宿主卡住超過兩者的差時，兩個會在同一輪做完，先後不定：只比收齊了沒有。
        let got = [read_message(&mut stream), read_message(&mut stream)];
        for id in [1, 2] {
            assert!(got.contains(&ok(id, r#""later""#)), "{got:?}");
        }
        assert!(started.elapsed() >= Duration::from_millis(200));
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_cancel_ends_the_call_once_and_a_late_cancel_gets_nothing() {
        let (_host, socket) = host("call-cancel");
        let mut stream = connect(&socket);
        call(&mut stream, 1, "hang", "null");
        cancel(&mut stream, 1);
        assert_eq!(error_code(&mut stream, 1), ErrorCode::Cancelled);
        // 已經結束的與從沒開始的：都不回，下一框就是後面那次呼叫的。
        cancel(&mut stream, 1);
        cancel(&mut stream, 99);
        assert_eq!(cancels(&mut stream, 2), 1);
    }

    #[test]
    fn closing_the_connection_cancels_its_calls_in_the_service() {
        let (_host, socket) = host("call-drop");
        let mut first = connect(&socket);
        call(&mut first, 1, "hang", "null");
        call(&mut first, 2, "hang", "null");
        let mut second = connect(&socket);
        assert_eq!(cancels(&mut second, 1), 0);
        drop(first);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut id = 2;
        while cancels(&mut second, id) != 2 {
            assert!(std::time::Instant::now() < deadline, "斷線之後兩次都要取消");
            std::thread::sleep(Duration::from_millis(20));
            id += 1;
        }
    }

    #[test]
    fn calls_over_the_limit_are_busy_and_the_rest_keep_running() {
        let (_host, socket) = host("call-busy");
        let mut stream = connect(&socket);
        for id in 0..MAX_CALLS as u64 {
            call(&mut stream, id, "hang", "null");
        }
        call(&mut stream, 1000, "echo", "null");
        assert_eq!(error_code(&mut stream, 1000), ErrorCode::Busy);
        cancel(&mut stream, 0);
        assert_eq!(error_code(&mut stream, 0), ErrorCode::Cancelled);
        call(&mut stream, 1001, "echo", "null");
        assert_eq!(read_message(&mut stream), ok(1001, "null"));
    }

    #[test]
    fn oversized_results_and_chunks_become_too_large() {
        let (_host, socket) = host("call-large");
        let mut stream = connect(&socket);
        call(&mut stream, 1, "big", "null");
        assert_eq!(error_code(&mut stream, 1), ErrorCode::TooLarge);
        call(&mut stream, 2, "big-chunk", "null");
        assert_eq!(error_code(&mut stream, 2), ErrorCode::TooLarge);
        call(&mut stream, 3, "unary-chunk", "null");
        assert_eq!(error_code(&mut stream, 3), ErrorCode::ServiceError);
        assert_eq!(
            cancels(&mut stream, 4),
            2,
            "宿主收尾時，掛著的那兩次要在服務那邊取消"
        );
    }

    #[test]
    fn an_event_goes_only_to_the_connection_the_service_names() {
        let (_host, socket) = host("call-event");
        let mut first = connect(&socket);
        let mut second = connect(&socket);
        call(&mut first, 1, "emit", r#"{"n":1}"#);
        let event = Some(HostMessage::Event {
            service: ECHO.into(),
            topic: "ping".into(),
            payload: json::parse(br#"{"n":1}"#).unwrap(),
        });
        assert_eq!(read_message(&mut first), ok(1, "null"));
        assert_eq!(read_message(&mut first), event);
        // 第二條沒收到事件：它的下一框就是它自己這次呼叫的結果。
        call(&mut second, 2, "echo", "2");
        assert_eq!(read_message(&mut second), ok(2, "2"));
    }

    /// 不讀回答的連線，宿主也不再讀它：送的一方卡住，別的連線照常；讀走之後每個 `id` 照樣剛好一框。
    #[test]
    fn a_connection_that_does_not_read_is_not_read_either() {
        // 十萬個呼叫的回答遠超過 OUTBOX_PAUSE 加兩邊 socket 的緩衝，宿主不停讀就一定送得完。
        const CALLS: u64 = 100_000;
        let (_host, socket) = host("call-backpressure");
        let mut stream = connect(&socket);
        let frames: Vec<u8> = (0..CALLS)
            .flat_map(|id| {
                frame(&encode_client_message(&ClientMessage::Call {
                    side: Side::Client,
                    id,
                    service: "nope".into(),
                    method: "m".into(),
                    payload: Value::Null,
                }))
            })
            .collect();
        stream.set_nonblocking(true).unwrap();
        let mut sent = 0;
        let mut progressed = Instant::now();
        while sent < frames.len() && progressed.elapsed() < Duration::from_secs(1) {
            match stream.write(&frames[sent..]) {
                Ok(n) => {
                    sent += n;
                    progressed = Instant::now();
                }
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(err) => panic!("{err}"),
            }
        }
        assert!(
            sent < frames.len(),
            "宿主一直在讀：{CALLS} 個呼叫全送出去了"
        );

        let mut other = connect(&socket);
        call(&mut other, 1, "echo", "1");
        assert_eq!(read_message(&mut other), ok(1, "1"));

        stream.set_nonblocking(false).unwrap();
        let mut writer = stream.try_clone().unwrap();
        let rest = std::thread::spawn(move || writer.write_all(&frames[sent..]).unwrap());
        for id in 0..CALLS {
            assert_eq!(error_code(&mut stream, id), ErrorCode::UnknownService);
        }
        rest.join().unwrap();
    }

    /// 事件排到上限就斷掉那條連線，不悄悄丟；上限以內的照送，別的連線不受影響。
    #[test]
    fn a_connection_whose_events_pile_up_is_dropped() {
        let (_host, socket) = host("call-event-limit");
        let mut small = connect(&socket);
        call(&mut small, 1, "burst", r#"{"count":5,"bytes":200000}"#);
        assert_eq!(read_message(&mut small), ok(1, "null"));
        for _ in 0..5 {
            assert!(matches!(
                read_message(&mut small),
                Some(HostMessage::Event { .. })
            ));
        }

        let mut flooded = connect(&socket);
        call(&mut flooded, 1, "burst", r#"{"count":20,"bytes":200000}"#);
        // 先不讀：宿主一口氣排 20 個事件，排到上限時這條連線還沒讀走多少。
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(read_message(&mut flooded), ok(1, "null"));
        let mut events = 0;
        while let Some(message) = read_message(&mut flooded) {
            assert!(matches!(message, HostMessage::Event { .. }), "{message:?}");
            events += 1;
        }
        assert!(events < 20, "20 個事件全送到了");

        call(&mut small, 2, "echo", "2");
        assert_eq!(read_message(&mut small), ok(2, "2"));
    }

    #[test]
    fn chunks_of_one_step_past_the_bound_end_the_call() {
        let (_host, socket) = host("call-flood");
        let mut stream = connect(&socket);
        call(&mut stream, 3, "flood", "null");
        // flood 一步推五塊、每塊約 250 KB：前四塊加起來還在 OUTBOX_PAUSE 以內照送，第五塊起不送。
        for seq in 0..4 {
            assert!(matches!(
                read_message(&mut stream),
                Some(HostMessage::Chunk { id: 3, seq: got, .. }) if got == seq
            ));
        }
        assert_eq!(error_code(&mut stream, 3), ErrorCode::ServiceError);
        assert_eq!(
            cancels(&mut stream, 4),
            1,
            "超過上限收尾時，還掛著的 flood 要在服務那邊取消"
        );
    }

    #[test]
    fn an_empty_tree_answers_unknown_service() {
        let dir = temp_dir("call-empty");
        let socket = dir.join("host.sock");
        let mut host = HostProc::start(&socket);
        host.grant(me(), TOKEN, Role::Conversation, "a");
        let mut stream = connect(&socket);
        call(&mut stream, 1, "echo", "null");
        assert_eq!(error_code(&mut stream, 1), ErrorCode::UnknownService);
    }

    /// 違規之後宿主撤掉這個 pid，所以每一種各用一個宿主。
    fn violates(tag: &str, script: impl FnOnce(&Path) -> UnixStream, reason: &str) {
        let (mut host, socket) = host(tag);
        let mut stream = script(&socket);
        assert_eq!(read_message(&mut stream), rejected(reason));
        assert!(closed(&mut stream));
        assert_eq!(host.report(), Some(violation(me(), GRANTED, reason)));
    }

    #[test]
    fn a_call_before_hello_is_a_violation() {
        violates(
            "call-early",
            |socket| {
                let mut stream = UnixStream::connect(socket).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(10)))
                    .unwrap();
                call(&mut stream, 1, "echo", "null");
                stream
            },
            "還沒 hello",
        );
    }

    #[test]
    fn a_call_from_the_host_side_is_a_violation() {
        violates(
            "call-side",
            |socket| {
                let mut stream = connect(socket);
                send(
                    &mut stream,
                    &ClientMessage::Cancel {
                        side: Side::Host,
                        id: 1,
                    },
                );
                stream
            },
            "宿主還不收反方向的呼叫",
        );
    }

    #[test]
    fn reusing_a_running_id_is_a_violation() {
        violates(
            "call-dup",
            |socket| {
                let mut stream = connect(socket);
                call(&mut stream, 1, "hang", "null");
                call(&mut stream, 1, "echo", "null");
                stream
            },
            "重複的呼叫編號",
        );
    }

    /// 插件 `mcp`（`src/mcp/service.rs`）：對本機 HTTPS 的假 MCP server，經宿主連線 open、call。
    mod mcp {
        use super::*;
        use crate::tls_common::fake_mcp::{big_text, handler, FakeMcp};
        use crate::tls_common::{
            fixture, ConnectProxy, PlainServer, ProxyMode, Request, Response, TlsServer,
        };
        use nexus_host::mcp::service::{NO_ROOTS, PIECES_PER_STEP, PIECE_BYTES, SERVICE};
        use serde_json::json;
        use std::sync::{Arc, Mutex};

        struct Fake {
            port: u16,
            log: Arc<Mutex<Vec<Request>>>,
        }

        fn fake(tools: &[&str]) -> Fake {
            let log: Arc<Mutex<Vec<Request>>> = Arc::default();
            let server =
                TlsServer::start(handler(FakeMcp::with_tools(false, tools), Arc::clone(&log)));
            Fake {
                port: server.port,
                log,
            }
        }

        /// 掛著 `mcp` 的宿主，根憑證是夾具的 CA。
        fn host(tag: &str) -> (HostProc, PathBuf) {
            host_with(tag, serde_json::json!({ "roots": fixture("ca-a.pem") }))
        }

        /// 掛著 `mcp` 的宿主，插件的設定是 `config`。
        fn host_with(tag: &str, config: Value) -> (HostProc, PathBuf) {
            let dir = temp_dir(tag);
            let plugins = dir.join("host-plugins.json");
            let list = serde_json::json!([{ "name": "mcp", "config": config }]);
            std::fs::write(&plugins, list.to_string()).unwrap();
            let socket = dir.join("host.sock");
            let mut host = HostProc::start_with_plugins(&socket, &plugins);
            host.grant(me(), TOKEN, Role::Conversation, "a");
            (host, socket)
        }

        fn server(port: u16) -> String {
            at(&format!("https://localhost:{port}/mcp"), json!({}))
        }

        /// `open` 的酬載：一台網址是 `url` 的 HTTP server，`extra` 的欄位併進 `server`。
        fn at(url: &str, extra: Value) -> String {
            let mut server = json!({
                "serverName": "fake",
                "connection": { "transport": "http", "url": url },
            });
            for (key, value) in extra.as_object().expect("物件") {
                server[key] = value.clone();
            }
            json!({ "server": server }).to_string()
        }

        /// 收到的一塊：序號與內容。
        type Piece = (u64, Value);

        /// 讀 `id` 的塊，直到 `stop` 說停（open 的 `ready`）或收到 `id` 的結果。別的 id 的框不該出現。
        fn read_pieces(
            stream: &mut UnixStream,
            id: u64,
            stop: impl Fn(&Value) -> bool,
        ) -> (Vec<Piece>, Option<Result<Value, CallError>>) {
            let mut pieces = Vec::new();
            loop {
                match read_message(stream) {
                    Some(HostMessage::Chunk {
                        id: got,
                        seq,
                        payload,
                        ..
                    }) if got == id => {
                        let done = stop(&payload);
                        pieces.push((seq, payload));
                        if done {
                            return (pieces, None);
                        }
                    }
                    Some(HostMessage::Result {
                        id: got, outcome, ..
                    }) if got == id => return (pieces, Some(outcome)),
                    other => panic!("要 {id} 的框，收到 {other:?}"),
                }
            }
        }

        /// 對話行程那一側該做的拼回：序號要從 0 連續，字串塊接起來，塊數與位元組數要對上 `summary`。
        fn reassemble(pieces: &[Piece], summary: &Value) -> Result<String, String> {
            let mut text = String::new();
            for (i, (seq, payload)) in pieces.iter().enumerate() {
                if *seq != i as u64 {
                    return Err(format!("第 {i} 塊的序號是 {seq}"));
                }
                text.push_str(payload.as_str().ok_or("不是字串塊")?);
            }
            if summary["chunks"].as_u64() != Some(pieces.len() as u64)
                || summary["bytes"].as_u64() != Some(text.len() as u64)
            {
                return Err(format!(
                    "{} 塊 {} 位元組，對不上 {summary}",
                    pieces.len(),
                    text.len()
                ));
            }
            Ok(text)
        }

        /// open 到 `ready`，回拼好的清單文件。
        fn open(stream: &mut UnixStream, id: u64, port: u16) -> Value {
            open_with(stream, id, &server(port))
        }

        /// 同 [`open`]，`payload` 是整份 `open` 的酬載。
        fn open_with(stream: &mut UnixStream, id: u64, payload: &str) -> Value {
            call_to(stream, id, SERVICE, "open", payload);
            let (mut pieces, outcome) = read_pieces(stream, id, |p| p.get("ready").is_some());
            assert_eq!(outcome, None, "open 不該收尾");
            let (_, ready) = pieces.pop().unwrap();
            let text = reassemble(&pieces, &ready["ready"]).expect("清單拼得回來");
            serde_json::from_str(&text).expect("清單是 JSON")
        }

        fn call_tool(stream: &mut UnixStream, id: u64, open: u64, name: &str, arguments: Value) {
            call_params(
                stream,
                id,
                open,
                &serde_json::json!({ "name": name, "arguments": arguments }),
            );
        }

        /// 一次 `tools/call`，`params` 整份由呼叫端給（反問的第二輪要帶 `inputResponses`、`requestState`）。
        fn call_params(stream: &mut UnixStream, id: u64, open: u64, params: &Value) {
            let payload = serde_json::json!({
                "open": open,
                "method": "tools/call",
                "params": params.to_string(),
            });
            call_to(stream, id, SERVICE, "call", &payload.to_string());
        }

        /// 讀 `id` 這次 `call` 的結果，拼回成 JSON。
        fn result_of(stream: &mut UnixStream, id: u64) -> Value {
            let (pieces, outcome) = read_pieces(stream, id, |_| false);
            let summary = outcome.expect("要收尾").expect("成功");
            let text = reassemble(&pieces, &summary).expect("拼得回來");
            serde_json::from_str(&text).expect("結果是 JSON")
        }

        /// `open` 以錯收尾：回錯誤碼與訊息。
        fn open_refused(stream: &mut UnixStream, id: u64, payload: &str) -> CallError {
            call_to(stream, id, SERVICE, "open", payload);
            let (pieces, outcome) = read_pieces(stream, id, |p| p.get("ready").is_some());
            assert!(pieces.is_empty(), "被拒的 open 不送塊：{pieces:?}");
            outcome.expect("要收尾").expect_err("要被拒")
        }

        fn cancelled_notices(log: &Mutex<Vec<Request>>) -> usize {
            log.lock()
                .unwrap()
                .iter()
                .filter(|r| String::from_utf8_lossy(&r.body).contains("notifications/cancelled"))
                .count()
        }

        #[test]
        fn open_送清單_call_的大結果分多步送_拼得回來() {
            let fake = fake(&["a", "big"]);
            let (_host, socket) = host("mcp-open-call");
            let mut stream = connect(&socket);
            let listed = open(&mut stream, 1, fake.port);
            let names: Vec<&str> = listed["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["name"].as_str().unwrap())
                .collect();
            assert_eq!(names, ["a", "big"]);
            assert_eq!(listed["warning"], Value::Null);

            // 每塊 32 KiB、一步四塊：600 KiB 要分好幾步，而且有切點落在三位元組字元中間。
            let bytes = 600 * 1024;
            call_tool(
                &mut stream,
                2,
                1,
                "big",
                serde_json::json!({ "bytes": bytes }),
            );
            let (pieces, outcome) = read_pieces(&mut stream, 2, |_| false);
            let summary = outcome.expect("要收尾").expect("成功");
            assert!(pieces.len() > PIECES_PER_STEP, "{} 塊", pieces.len());
            assert!(pieces
                .iter()
                .all(|(_, p)| p.as_str().is_some_and(|s| s.len() <= PIECE_BYTES)));
            let text = reassemble(&pieces, &summary).expect("拼得回來");
            let result: Value = serde_json::from_str(&text).expect("結果是 JSON");
            assert_eq!(result["content"][0]["text"], big_text(bytes).as_str());

            // 掉一塊、換兩塊的順序，拼回時都要抓得到。
            let mut missing = pieces.clone();
            missing.remove(3);
            assert!(reassemble(&missing, &summary).is_err());
            let mut swapped = pieces.clone();
            swapped.swap(1, 2);
            assert!(reassemble(&swapped, &summary).is_err());

            // 綁定還掛著：同一條連線可以再 call。
            call_tool(&mut stream, 3, 1, "a", serde_json::json!({}));
            let (pieces, outcome) = read_pieces(&mut stream, 3, |_| false);
            let text = reassemble(&pieces, &outcome.unwrap().unwrap()).unwrap();
            assert!(text.contains(r#"\"a\":{}"#), "{text}");
        }

        #[test]
        fn 參數不合與沒有綁定_回參數錯() {
            let fake = fake(&["a"]);
            let (_host, socket) = host("mcp-bad");
            let mut stream = connect(&socket);
            call_to(
                &mut stream,
                1,
                SERVICE,
                "open",
                r#"{"server":{"serverName":"x"}}"#,
            );
            assert_eq!(error_code(&mut stream, 1), ErrorCode::BadPayload);
            // 綁定還沒開：
            call_tool(&mut stream, 2, 9, "a", serde_json::json!({}));
            assert_eq!(error_code(&mut stream, 2), ErrorCode::BadPayload);
            open(&mut stream, 3, fake.port);
            let bad = [
                r#"{"open":3,"method":"tools/list","params":"{}"}"#,
                r#"{"open":3,"method":"tools/call","params":"{"}"#,
                r#"{"open":3,"method":"tools/call","params":{}}"#,
                r#"{"open":3,"method":"tools/call","params":"{}","x":1}"#,
            ];
            for (i, payload) in bad.iter().enumerate() {
                let id = 10 + i as u64;
                call_to(&mut stream, id, SERVICE, "call", payload);
                assert_eq!(
                    error_code(&mut stream, id),
                    ErrorCode::BadPayload,
                    "{payload}"
                );
            }
            // 綁定只在開它的那一條連線上：
            let mut other = connect(&socket);
            call_tool(&mut other, 1, 3, "a", serde_json::json!({}));
            assert_eq!(error_code(&mut other, 1), ErrorCode::BadPayload);
        }

        #[test]
        fn 取消與斷線_都告訴_server_不用做了() {
            let fake = fake(&["slow"]);
            let (_host, socket) = host("mcp-cancel");
            let mut stream = connect(&socket);
            open(&mut stream, 1, fake.port);
            call_tool(&mut stream, 2, 1, "slow", serde_json::json!({}));
            std::thread::sleep(Duration::from_millis(300));
            cancel(&mut stream, 2);
            assert_eq!(error_code(&mut stream, 2), ErrorCode::Cancelled);

            // 中途斷線：宿主取消還在跑的 call，橋送 `notifications/cancelled`；綁定跟著放掉。
            call_tool(&mut stream, 3, 1, "slow", serde_json::json!({}));
            std::thread::sleep(Duration::from_millis(300));
            drop(stream);
            let deadline = Instant::now() + Duration::from_secs(5);
            while cancelled_notices(&fake.log) < 2 {
                assert!(Instant::now() < deadline, "取消與斷線各要送一則");
                std::thread::sleep(Duration::from_millis(20));
            }
            // 連線池照留那一份：新連線再 open 不用重新握手。
            let handshakes = |log: &Mutex<Vec<Request>>| {
                log.lock()
                    .unwrap()
                    .iter()
                    .filter(|r| String::from_utf8_lossy(&r.body).contains(r#""initialize""#))
                    .count()
            };
            let before = handshakes(&fake.log);
            let mut again = connect(&socket);
            open(&mut again, 1, fake.port);
            assert_eq!(handshakes(&fake.log), before);
        }

        #[test]
        fn 超過一則回應上限的結果_以服務的錯收尾_連線照用() {
            let fake = fake(&["big", "a"]);
            let (_host, socket) = host("mcp-huge");
            let mut stream = connect(&socket);
            open(&mut stream, 1, fake.port);
            call_tool(
                &mut stream,
                2,
                1,
                "big",
                serde_json::json!({ "bytes": 17 * 1024 * 1024 }),
            );
            let (pieces, outcome) = read_pieces(&mut stream, 2, |_| false);
            assert!(pieces.is_empty());
            let error = outcome.unwrap().unwrap_err();
            assert_eq!(error.code, ErrorCode::ServiceError);
            assert!(
                error
                    .message
                    .ends_with("response exceeded the size limit of 16 MiB — this call failed; the connection stays up"),
                "{}",
                error.message
            );
            // 單次失敗不判掉線：同一代照用，不重新握手。
            call_tool(&mut stream, 3, 1, "a", serde_json::json!({}));
            let (pieces, outcome) = read_pieces(&mut stream, 3, |_| false);
            reassemble(&pieces, &outcome.unwrap().unwrap()).unwrap();
            let handshakes = fake
                .log
                .lock()
                .unwrap()
                .iter()
                .filter(|r| String::from_utf8_lossy(&r.body).contains(r#""initialize""#))
                .count();
            assert_eq!(handshakes, 1);
        }

        /// 新協定每次請求帶 client 能力的 `_meta` 鍵。
        const CAPABILITIES: &str = "io.modelcontextprotocol/clientCapabilities";
        /// [`asking`] 第一輪給的 `requestState`。
        const STATE: &str = "state-1";

        fn question() -> Value {
            json!({
                "method": "elicitation/create",
                "params": {
                    "mode": "form",
                    "message": "請問怎麼稱呼？",
                    "requestedSchema": {
                        "type": "object",
                        "properties": { "name": { "type": "string", "title": "名字" } },
                        "required": ["name"]
                    }
                }
            })
        }

        fn text_result(text: &str) -> Value {
            json!({
                "resultType": "complete",
                "content": [{ "type": "text", "text": text }],
                "isError": false,
            })
        }

        /// 會反問的新協定假 server（HTTPS）。握手與清單照 [`FakeMcp`]；`tools/call` 看請求決定怎麼回：
        /// `_meta` 沒帶反問能力回「沒問」；帶了、還沒有答案回 `input_required`（題目 [`question`]、`requestState` 是 [`STATE`]）；
        /// 帶了答案回「答：」加答案裡的名字。`log` 只記 `tools/call`。
        fn asking() -> Fake {
            let log: Arc<Mutex<Vec<Request>>> = Arc::default();
            let base = handler(FakeMcp::with_tools(true, &["ask"]), Arc::default());
            let seen = Arc::clone(&log);
            let server = TlsServer::start(Arc::new(move |request: &Request| {
                let message: Value = serde_json::from_slice(&request.body).unwrap_or_default();
                if message["method"] != "tools/call" {
                    return base(request);
                }
                seen.lock().unwrap().push(request.clone());
                let params = &message["params"];
                let result = if !params["_meta"][CAPABILITIES]["elicitation"].is_object() {
                    text_result("沒問")
                } else if params.get("inputResponses").is_none() {
                    json!({
                        "resultType": "input_required",
                        "inputRequests": { "q1": question() },
                        "requestState": STATE,
                    })
                } else {
                    let name = params["inputResponses"]["q1"]["content"]["name"]
                        .as_str()
                        .unwrap_or("?");
                    text_result(&format!("答：{name}"))
                };
                let body = json!({ "jsonrpc": "2.0", "id": message["id"], "result": result });
                Response::new(200, "application/json", body.to_string())
            }));
            Fake {
                port: server.port,
                log,
            }
        }

        /// [`asking`] 那台 server 的 `open` 酬載，`elicitation` 是這次取用開不開反問。
        fn asking_server(port: u16, elicitation: bool) -> String {
            json!({
                "server": {
                    "serverName": "fake",
                    "connection": { "transport": "http", "url": format!("https://localhost:{port}/mcp") },
                },
                "elicitation": elicitation,
            })
            .to_string()
        }

        /// server 收到的每一次 `tools/call` 的 `params`，依序。
        fn tool_calls(log: &Mutex<Vec<Request>>) -> Vec<Value> {
            log.lock()
                .unwrap()
                .iter()
                .map(|r| serde_json::from_slice::<Value>(&r.body).expect("JSON")["params"].clone())
                .collect()
        }

        fn answer() -> Value {
            json!({ "q1": { "action": "accept", "content": { "name": "小明" } } })
        }

        /// R5：真宿主加會反問的假 server。第一輪拿到題目與 `requestState`；帶答案與同一份 `requestState` 再叫一次，拿到最終結果。
        /// server 兩輪收到的都帶反問能力，第二輪的答案與狀態逐欄位等於送的。
        #[test]
        fn r5_一次呼叫問一題_答完拿到結果() {
            let fake = asking();
            let (_host, socket) = host("mcp-r5");
            let mut stream = connect(&socket);
            let listed = open_with(&mut stream, 1, &asking_server(fake.port, true));
            assert_eq!(listed["tools"][0]["name"], "ask", "{listed}");

            let arguments = json!({ "topic": "天氣" });
            call_params(
                &mut stream,
                2,
                1,
                &json!({ "name": "ask", "arguments": arguments }),
            );
            let first = result_of(&mut stream, 2);
            assert_eq!(first["resultType"], "input_required", "{first}");
            assert_eq!(
                first["inputRequests"],
                json!({ "q1": question() }),
                "{first}"
            );
            assert_eq!(first["requestState"], STATE, "{first}");

            call_params(
                &mut stream,
                3,
                1,
                &json!({
                    "name": "ask",
                    "arguments": arguments,
                    "inputResponses": answer(),
                    "requestState": first["requestState"],
                }),
            );
            let second = result_of(&mut stream, 3);
            assert_eq!(second["content"][0]["text"], "答：小明", "{second}");

            let calls = tool_calls(&fake.log);
            assert_eq!(calls.len(), 2, "server 收到兩次 tools/call：{calls:?}");
            for call in &calls {
                assert_eq!(
                    call["_meta"][CAPABILITIES],
                    json!({ "elicitation": { "form": {}, "url": {} } }),
                    "每一輪都帶反問能力：{call}"
                );
                assert_eq!(call["name"], "ask", "{call}");
                assert_eq!(call["arguments"], arguments, "{call}");
            }
            assert!(calls[0].get("inputResponses").is_none(), "{}", calls[0]);
            assert_eq!(calls[1]["inputResponses"], answer(), "{}", calls[1]);
            assert_eq!(calls[1]["requestState"], STATE, "{}", calls[1]);
        }

        /// `open` 沒開反問：`tools/call` 不帶反問能力，同一台 server 不問、直接回結果。
        #[test]
        fn open_沒開反問_呼叫不帶反問能力_server_不問() {
            let fake = asking();
            let (_host, socket) = host("mcp-no-elicitation");
            let mut stream = connect(&socket);
            open_with(&mut stream, 1, &asking_server(fake.port, false));
            call_params(
                &mut stream,
                2,
                1,
                &json!({ "name": "ask", "arguments": {} }),
            );
            let result = result_of(&mut stream, 2);
            assert_eq!(result["content"][0]["text"], "沒問", "{result}");
            let calls = tool_calls(&fake.log);
            assert_eq!(calls.len(), 1, "{calls:?}");
            assert!(
                calls[0]["_meta"][CAPABILITIES]["elicitation"].is_null(),
                "{}",
                calls[0]
            );
        }

        /// R6：等答時宿主被殺。補起的宿主上舊的綁定編號不存在：帶著它送第二輪會被拒，server 收不到；
        /// 重新 `open` 之後，帶答案與原本那份 `requestState` 的第二輪經新的綁定送到 server，拿到最終結果。
        #[test]
        fn r6_等答時宿主被殺_補起後第二輪經新的綁定送到() {
            let fake = asking();
            let (old, socket) = host("mcp-r6-old");
            let mut stream = connect(&socket);
            open_with(&mut stream, 1, &asking_server(fake.port, true));
            call_params(
                &mut stream,
                2,
                1,
                &json!({ "name": "ask", "arguments": {} }),
            );
            let first = result_of(&mut stream, 2);
            assert_eq!(first["resultType"], "input_required", "{first}");
            drop(old);
            assert_eq!(read_message(&mut stream), None, "宿主被殺，舊連線要斷");

            let (_new, socket) = host("mcp-r6-new");
            let mut stream = connect(&socket);
            let second = json!({
                "name": "ask",
                "arguments": {},
                "inputResponses": answer(),
                "requestState": first["requestState"],
            });
            call_params(&mut stream, 2, 1, &second);
            assert_eq!(error_code(&mut stream, 2), ErrorCode::BadPayload);
            assert_eq!(
                tool_calls(&fake.log).len(),
                1,
                "帶舊編號的第二輪不該送到 server"
            );

            open_with(&mut stream, 3, &asking_server(fake.port, true));
            call_params(&mut stream, 4, 3, &second);
            let result = result_of(&mut stream, 4);
            assert_eq!(result["content"][0]["text"], "答：小明", "{result}");
            let calls = tool_calls(&fake.log);
            assert_eq!(calls.len(), 2, "{calls:?}");
            assert_eq!(calls[1]["inputResponses"], answer(), "{}", calls[1]);
            assert_eq!(calls[1]["requestState"], STATE, "{}", calls[1]);
        }

        /// 一台 stdio 的假 server：把自己的 pid 寫進 `$PIDFILE`，握手走舊協定，`tools/call` 回 `from-stdio`。
        const STDIO_SERVER: &str = r#"
echo $$ > "$PIDFILE"
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"server/discover"'*)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id";;
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"0"}}}\n' "$id";;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"echo","inputSchema":{"type":"object"}}]}}\n' "$id";;
    *'"method":"tools/call"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"from-stdio"}],"isError":false}}\n' "$id";;
  esac
done
"#;

        /// [`STDIO_SERVER`] 的 `open` 酬載。
        fn stdio_server(pid_file: &Path) -> String {
            json!({
                "server": {
                    "serverName": "fake",
                    "connection": {
                        "transport": "stdio",
                        "command": "/bin/sh",
                        "args": ["-c", STDIO_SERVER],
                        "env": { "PATH": "/usr/bin:/bin", "PIDFILE": pid_file },
                        "credentialEnv": [],
                    },
                },
            })
            .to_string()
        }

        /// `/proc/<pid>/stat` 裡的父行程。
        fn parent_of(pid: u32) -> u32 {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).expect("行程還在");
            let after_name = &stat[stat.rfind(')').expect("stat 的格式") + 1..];
            after_name
                .split_whitespace()
                .nth(1)
                .and_then(|ppid| ppid.parse().ok())
                .expect("ppid")
        }

        /// open 一列 [`STDIO_SERVER`]、叫一次工具，確認結果來自它，而且它是 `host` 的子行程。
        fn assert_stdio_works(host: &HostProc, stream: &mut UnixStream, tag: &str) {
            let pid_file = temp_dir(tag).join("server.pid");
            let listed = open_with(stream, 20, &stdio_server(&pid_file));
            assert_eq!(listed["warning"], Value::Null, "{listed}");
            assert_eq!(listed["tools"][0]["name"], "echo", "{listed}");
            call_tool(stream, 21, 20, "echo", json!({}));
            let result = result_of(stream, 21);
            assert_eq!(result["content"][0]["text"], "from-stdio", "{result}");
            let pid: u32 = std::fs::read_to_string(&pid_file)
                .expect("server 寫了 pid")
                .trim()
                .parse()
                .expect("pid");
            assert_eq!(parent_of(pid), host.child.id(), "server 要是宿主的子行程");
        }

        /// 啟動時 stderr 上根憑證的警告行。
        fn root_warnings(host: &HostProc) -> Vec<String> {
            host.stderr()
                .lines()
                .filter(|line| line.starts_with("nexus-host: mcp 警告："))
                .map(str::to_string)
                .collect()
        }

        /// 沒設根憑證（插件的設定不帶 `roots`）：http 與 stdio 的 server 連得上、叫得到工具；https 的當場被拒，訊息是 [`NO_ROOTS`]；啟動時不印警告。
        #[test]
        fn 沒設根憑證_http_與_stdio_照常_https_當場被拒() {
            let log: Arc<Mutex<Vec<Request>>> = Arc::default();
            let plain = PlainServer::start(handler(
                FakeMcp::with_tools(false, &["a"]),
                Arc::clone(&log),
            ));
            let (host, socket) = host_with("mcp-no-roots", json!({}));
            let mut stream = connect(&socket);
            let url = format!("http://localhost:{}/mcp", plain.port);
            let listed = open_with(&mut stream, 1, &at(&url, json!({})));
            assert_eq!(listed["warning"], Value::Null, "{listed}");
            assert_eq!(listed["tools"][0]["name"], "a", "{listed}");
            call_tool(&mut stream, 2, 1, "a", json!({ "x": 1 }));
            let result = result_of(&mut stream, 2);
            assert_eq!(result["content"][0]["text"], r#""a":{"x":1}"#, "{result}");

            assert_stdio_works(&host, &mut stream, "mcp-no-roots-stdio");

            let refused = open_refused(&mut stream, 3, &at("https://localhost:1/mcp", json!({})));
            assert_eq!(refused.code, ErrorCode::ServiceError);
            assert_eq!(refused.message, NO_ROOTS);
            assert_eq!(root_warnings(&host), Vec::<String>::new());
        }

        /// `roots` 指的檔不能用：宿主照常起來，啟動時在 stderr 印一行警告、指名那個檔；stdio 照常；https 的被拒，訊息指名那個檔、不說成沒設。
        #[test]
        fn 根憑證檔不能用_宿主照常起來_啟動時印一行警告_stdio_照常_https_指名檔案() {
            let roots = temp_dir("mcp-bad-roots-file").join("broken.pem");
            std::fs::write(
                &roots,
                "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
            )
            .unwrap();
            let shown = roots.display().to_string();
            let (host, socket) = host_with("mcp-bad-roots", json!({ "roots": roots }));
            let warnings = root_warnings(&host);
            assert_eq!(warnings.len(), 1, "{warnings:?}");
            assert!(
                warnings[0].contains("NODE_EXTRA_CA_CERTS 指的根憑證檔不能用")
                    && warnings[0].contains(&shown),
                "{warnings:?}"
            );

            let mut stream = connect(&socket);
            assert_stdio_works(&host, &mut stream, "mcp-bad-roots-stdio");

            let refused = open_refused(&mut stream, 1, &at("https://localhost:1/mcp", json!({})));
            assert_eq!(refused.code, ErrorCode::ServiceError);
            assert!(refused.message.contains(&shown), "{}", refused.message);
            assert!(
                !refused.message.contains("沒設 NODE_EXTRA_CA_CERTS"),
                "{}",
                refused.message
            );
        }

        /// https 的 server 要走代理、又沒設根憑證：`open` 當場被拒，訊息是 [`NO_ROOTS`]，代理沒有收到任何請求。
        #[test]
        fn https_的_server_走代理_沒設根憑證_當場被拒_不碰代理() {
            let proxy = ConnectProxy::start(ProxyMode::Reject);
            let policy = json!({
                "httpsProxy": format!("http://127.0.0.1:{}", proxy.port),
                "noProxy": "",
            });
            let (_host, socket) = host_with("mcp-proxy-no-roots", json!({ "proxy": policy }));
            let mut stream = connect(&socket);
            let refused =
                open_refused(&mut stream, 1, &at("https://mcp.nexus.test/mcp", json!({})));
            assert_eq!(refused.code, ErrorCode::ServiceError);
            assert_eq!(refused.message, NO_ROOTS);
            assert!(proxy.seen().is_empty(), "被拒的 open 不該連代理");
        }

        /// 代理的網址是 https、又沒設根憑證：http 的 server 也要先跟代理做 TLS，空信任庫驗不過，連不上。
        /// 釘現況：錯誤只說送不出請求，沒有提代理、TLS 或根憑證。
        #[test]
        fn http_的_server_走_https_的代理_沒設根憑證_連不上() {
            let proxy = TlsServer::start(Arc::new(|_| Response::empty(502)));
            let policy = json!({
                "httpProxy": format!("https://localhost:{}", proxy.port),
                "noProxy": "",
            });
            let (_host, socket) = host_with("mcp-tls-proxy-no-roots", json!({ "proxy": policy }));
            let mut stream = connect(&socket);
            let refused = open_refused(
                &mut stream,
                1,
                &at(
                    "http://mcp.nexus.test/mcp",
                    json!({ "failOnStartupError": true }),
                ),
            );
            assert_eq!(refused.code, ErrorCode::ServiceError);
            assert!(
                refused.message.contains("error sending request"),
                "{}",
                refused.message
            );
            assert!(
                !refused.message.contains("NODE_EXTRA_CA_CERTS"),
                "{}",
                refused.message
            );
        }
    }
}
