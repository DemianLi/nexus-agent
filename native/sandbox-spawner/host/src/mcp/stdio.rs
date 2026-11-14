//! stdio MCP server 的行程與 transport（#2570 D2b-2）：`std::process` 起行程，stdin、stdout 交給 tokio 的非阻塞管線（底下是 `AsyncFd`），
//! 讀寫兩端交給 rmcp 的 `AsyncRwTransport`。不加相依、不加 feature：`tokio` 的 `net` 與 rmcp 的 `transport-async-rw` 現成就有。
//!
//! - 環境：`env_clear` 之後只放 [`Stdio::env`]（TS 算好的整份），宿主自己的環境一個都不繼承。
//! - stderr 丟掉（`/dev/null`）：宿主沒有辦法把子行程印的字裡的秘密換掉，也沒有地方好放。
//! - 收線：transport 關了（stdin 跟著關）之後，子行程 [`STDIN_GRACE`] 內自己結束就收；沒有就 SIGTERM，再等 [`TERM_GRACE`]，還在就 SIGKILL，最後一定 `wait` 掉（SIGKILL 後最多等 [`KILL_WAIT`]，等不到就放手、由阻塞執行緒自己 `wait` 完）。
//!   三段加起來是 [`REAP_BUDGET`]，編譯期斷言小於監督者的 `GENERATION_CLOSE_TIMEOUT`。子行程不留殭屍。連線的 future 被丟下（握手或列工具中途停掉）時，[`ChildGuard`] 的 drop 直接 SIGKILL 並在另一條執行緒 `wait`。

use std::io;
use std::process::{Child, Command, Stdio as Pipe};
use std::time::Duration;

use rmcp::transport::async_rw::AsyncRwTransport;
use rmcp::RoleClient;
use tokio::net::unix::pipe::{Receiver, Sender};
use tokio::time::{sleep, Instant};

use super::config::Stdio;
use super::supervisor::GENERATION_CLOSE_TIMEOUT;

/// stdin 關了之後等子行程自己結束多久。
pub const STDIN_GRACE: Duration = Duration::from_secs(2);
/// SIGTERM 之後等多久，之後 SIGKILL。
pub const TERM_GRACE: Duration = Duration::from_secs(2);
/// SIGKILL 之後等 `wait` 回來最多多久。SIGKILL 擋不住，正常是立刻回來；卡在不可中斷的睡眠（D 狀態）時才會用到上限。
pub const KILL_WAIT: Duration = Duration::from_millis(500);
/// 整段收線梯度的預算：三段之和。最壞約這個值再加兩個 [`POLL`]（前兩段各可能多出一個輪詢間隔）。
pub const REAP_BUDGET: Duration = Duration::from_millis(
    (STDIN_GRACE.as_millis() + TERM_GRACE.as_millis() + KILL_WAIT.as_millis()) as u64,
);
/// 等子行程結束時輪詢的間隔。
const POLL: Duration = Duration::from_millis(20);

// 梯度要跑得完才輪得到監督者的 [`GENERATION_CLOSE_TIMEOUT`]；超過它，監督者會把這一代判成「沒收乾淨」而停止重連。
const _: () = assert!(REAP_BUDGET.as_millis() < GENERATION_CLOSE_TIMEOUT.as_millis());

/// 子行程的擁有者：不論怎麼離開（正常收線、連線的 future 被丟下、執行環境收掉）都不留行程。
/// 沒被 [`reap`] 收走就 drop：還在跑就 SIGKILL，並交給另一條執行緒 `wait`，不阻塞也不留殭屍。
pub struct ChildGuard(Option<Child>);

impl ChildGuard {
    /// 子行程的 pid；已經收走了是 `None`。
    pub fn id(&self) -> Option<u32> {
        self.0.as_ref().map(Child::id)
    }

    fn child(&mut self) -> Option<&mut Child> {
        self.0.as_mut()
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.0.take() else {
            return;
        };
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        let _ = child.kill();
        // drop 可能發生在非同步執行環境裡，不能在這裡 `wait`。起不了執行緒時 `child` 隨 drop 結束，行程已被殺、殭屍留到宿主結束。
        let _ = std::thread::Builder::new()
            .name("mcp-stdio-wait".into())
            .spawn(move || {
                let _ = child.wait();
            });
    }
}

/// 起好的行程與它的 stdio 兩端。
pub struct Spawned {
    pub child: ChildGuard,
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
    // 起好就交給 guard：之後管線接不起來也不會留下行程。
    let mut child = ChildGuard(Some(command.spawn()?));
    let transport = pipes(child.child().ok_or_else(missing)?)?;
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

/// 收掉子行程，回來時它已經 `wait` 過；唯一例外是 SIGKILL 之後 [`KILL_WAIT`] 內沒結束（D 狀態），那時記一行錯誤、放手，`wait` 留給阻塞執行緒。transport 已經關了（stdin 已關）才呼叫。這個 future 中途被丟下，guard 照樣收。
pub async fn reap(mut guard: ChildGuard) {
    let Some(child) = guard.child() else {
        return;
    };
    match exited_within(child, STDIN_GRACE).await {
        Wait::Exited => return,
        Wait::Running => {
            // 能走到這裡是 `try_wait` 剛回「還在跑」：還沒被 `wait`，pid 不會被別人重用。
            if let Ok(pid) = i32::try_from(child.id()) {
                // SAFETY：只送訊號給自己起的、還沒 `wait` 的子行程。
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
            if let Wait::Exited = exited_within(child, Duration::ZERO).await {
                return;
            }
        }
        // 查不了狀態：不對 pid 送訊號，直接走 SIGKILL 與 `wait`。
        Wait::Unknown => {}
    }
    let Some(mut child) = guard.0.take() else {
        return;
    };
    let _ = child.kill();
    let pid = child.id();
    // SIGKILL 擋不住，`wait` 很快回來；放進阻塞執行緒，免得卡住執行環境。
    // 等不到 [`KILL_WAIT`] 就放手：`child` 已經在那條執行緒裡，它自己 `wait` 完，不會留殭屍，只是這裡不再等。
    let waiting = tokio::task::spawn_blocking(move || child.wait());
    if tokio::time::timeout(KILL_WAIT, waiting).await.is_err() {
        eprintln!(
            "nexus-host: mcp 錯誤：子行程 {pid} 收到 SIGKILL 後 {KILL_WAIT:?} 內沒有結束，不再等它"
        );
    }
}

/// [`exited_within`] 的結果。
enum Wait {
    Exited,
    Running,
    Unknown,
}

/// 在 `limit` 內等到子行程結束（並且已 `wait` 掉）。
async fn exited_within(child: &mut Child, limit: Duration) -> Wait {
    let deadline = Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Wait::Exited,
            Err(_) => return Wait::Unknown,
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            return Wait::Running;
        }
        sleep(POLL).await;
    }
}
