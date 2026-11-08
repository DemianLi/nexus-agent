//! 假客戶端共用：連宿主的 socket、送一框、讀回答，結果寫成一行給測試比對。
//!
//! 結果：`host hello`、`host rejected <理由>`、`host garbled <理由>`（宿主的回答解不開）、`host closed`（宿主沒回答就斷了）、`host error <errno>`（連不上，或 socket 建不起來）。

use nexus_sandbox_spawner::host_protocol::{decode_host_message, encode_client_message, hello, HostMessage};
use nexus_sandbox_spawner::protocol::frame;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

/// 用這個 token 送 `hello`。
pub fn hello_line(socket: &Path, token: &str) -> String {
    send_line(socket, &frame(&encode_client_message(&hello(token))))
}

/// 原樣送這些位元組（自己帶長度欄位）。
pub fn send_line(socket: &Path, bytes: &[u8]) -> String {
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(err) => return format!("host error {}", err.raw_os_error().unwrap_or(0)),
    };
    stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let _ = stream.write_all(bytes);
    let mut head = [0u8; 4];
    if stream.read_exact(&mut head).is_err() {
        return "host closed".into();
    }
    let mut payload = vec![0u8; u32::from_le_bytes(head) as usize];
    if stream.read_exact(&mut payload).is_err() {
        return "host closed".into();
    }
    match decode_host_message(&payload) {
        Ok(HostMessage::Hello { .. }) => "host hello".into(),
        Ok(HostMessage::Rejected { reason }) => format!("host rejected {reason}"),
        Err(err) => format!("host garbled {}", err.0),
    }
}
