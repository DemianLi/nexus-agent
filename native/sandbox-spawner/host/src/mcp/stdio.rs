//! stdio MCP server 的行程與 transport（#2570 D2b-2）：`std::process` 起行程，stdin、stdout 交給 tokio 的非阻塞管線（底下是 `AsyncFd`），
//! 讀寫兩端交給 rmcp 的 `AsyncRwTransport`。不加相依、不加 feature：`tokio` 的 `net` 與 rmcp 的 `transport-async-rw` 現成就有。
//!
//! - 環境：`env_clear` 之後只放 [`Stdio::env`]（TS 算好的整份），宿主自己的環境一個都不繼承。
//! - stderr 丟掉（`/dev/null`）：宿主沒有辦法把子行程印的字裡的秘密換掉，也沒有地方好放。
//! - 收線：transport 關了（stdin 跟著關）之後，子行程 [`STDIN_GRACE`] 內自己結束就收；沒有就 SIGTERM，再等 [`TERM_GRACE`]，還在就 SIGKILL，最後一定 `wait` 掉。
//!   子行程不留殭屍。

use std::io;
use std::process::{Child, Command, Stdio as Pipe};
use std::time::Duration;

use rmcp::transport::async_rw::AsyncRwTransport;
use rmcp::RoleClient;
use tokio::net::unix::pipe::{Receiver, Sender};
use tokio::time::{sleep, Instant};

use super::config::Stdio;

/// stdin 關了之後等子行程自己結束多久。
pub const STDIN_GRACE: Duration = Duration::from_secs(2);
/// SIGTERM 之後等多久，之後 SIGKILL。
pub const TERM_GRACE: Duration = Duration::from_secs(2);
/// 等子行程結束時輪詢的間隔。
const POLL: Duration = Duration::from_millis(20);

/// 起好的行程與它的 stdio 兩端。
pub struct Spawned {
    pub child: Child,
    pub transport: AsyncRwTransport<RoleClient, Receiver, Sender>,
}

/// 照 `spec` 起行程，stdin、stdout 接成 rmcp 的 client transport。必須在 tokio 執行環境裡呼叫。
pub fn spawn(spec: &Stdio) -> io::Result<Spawned> {
    let mut command = Command::new(&spec.command);
    command
        .args(&spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .stdin(Pipe::piped())
        .stdout(Pipe::piped())
        .stderr(Pipe::null());
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    let mut child = command.spawn()?;
    // 兩條管線都接得起來才算起好；接不起來就把剛起的行程收掉，不留下去。
    let transport = match pipes(&mut child) {
        Ok(transport) => transport,
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };
    Ok(Spawned { child, transport })
}

fn pipes(child: &mut Child) -> io::Result<AsyncRwTransport<RoleClient, Receiver, Sender>> {
    let stdin = child.stdin.take().ok_or_else(missing)?;
    let stdout = child.stdout.take().ok_or_else(missing)?;
    Ok(AsyncRwTransport::new_client(
        Receiver::from_owned_fd(stdout.into())?,
        Sender::from_owned_fd(stdin.into())?,
    ))
}

fn missing() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "子行程的 stdio 管線不在")
}

/// 收掉子行程，回來時它一定已經 `wait` 過。transport 已經關了（stdin 已關）才呼叫。
pub async fn reap(mut child: Child) {
    if exited_within(&mut child, STDIN_GRACE).await {
        return;
    }
    if let Ok(pid) = i32::try_from(child.id()) {
        // SAFETY：只送訊號給自己起的子行程；它還沒被 `wait`，pid 不會被別人重用。
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    if exited_within(&mut child, TERM_GRACE).await {
        return;
    }
    let _ = child.kill();
    // SIGKILL 擋不住，`wait` 很快回來；放進阻塞執行緒，免得卡住執行環境。
    let _ = tokio::task::spawn_blocking(move || child.wait()).await;
}

/// 在 `limit` 內等到子行程結束（並且已 `wait` 掉）。
async fn exited_within(child: &mut Child, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            // 查不了狀態：不在這裡空等，往下一步（SIGTERM、SIGKILL、`wait`）走。
            Err(_) => return false,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            return false;
        }
        sleep(POLL).await;
    }
}
