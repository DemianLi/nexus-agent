//! stdio MCP server 的行程與 transport（#2570 D2b-2）：`std::process` 起行程，三條管線交給 tokio 的非阻塞管線（底下是 `AsyncFd`），
//! 讀寫兩端交給 rmcp 的 `AsyncRwTransport`。不加相依、不加 feature：`tokio` 的 `net` 與 rmcp 的 `transport-async-rw` 現成就有。

use std::io;
use std::process::{Child, Command, Stdio};

use rmcp::transport::async_rw::AsyncRwTransport;
use rmcp::RoleClient;
use tokio::net::unix::pipe::{Receiver, Sender};

/// 起好的行程與它的 stdio 兩端。stderr 另給，由呼叫方決定怎麼收。
pub struct Spawned {
    pub child: Child,
    pub transport: AsyncRwTransport<RoleClient, Receiver, Sender>,
}

/// 照 `command` 起行程，stdin、stdout 接成 rmcp 的 client transport。必須在 tokio 執行環境裡呼叫。
pub fn spawn(mut command: Command) -> io::Result<Spawned> {
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdin = child.stdin.take().ok_or_else(missing)?;
    let stdout = child.stdout.take().ok_or_else(missing)?;
    let transport = AsyncRwTransport::new_client(
        Receiver::from_owned_fd(stdout.into())?,
        Sender::from_owned_fd(stdin.into())?,
    );
    Ok(Spawned { child, transport })
}

fn missing() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "子行程的 stdio 管線不在")
}
