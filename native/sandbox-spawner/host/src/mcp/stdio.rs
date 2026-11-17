//! stdio MCP server 的行程與 transport（#2570 D2b-2）：`std::process` 起行程，stdin、stdout 交給 tokio 的非阻塞管線（底下是 `AsyncFd`），
//! 讀寫兩端交給 rmcp 的 `AsyncRwTransport`。不加相依、不加 feature：`tokio` 的 `net` 與 rmcp 的 `transport-async-rw` 現成就有。
//!
//! - 環境：`env_clear` 之後只放 [`Stdio::env`]（TS 算好的整份），宿主自己的環境一個都不繼承。
//! - stderr 丟掉（`/dev/null`）：宿主沒有辦法把子行程印的字裡的秘密換掉，也沒有地方好放。
//! - 行程群組：子行程自成一個 session，也就自成一組（pgid 與 sid 都是它的 pid），收線的訊號送整組，所以 server 啟動的子孫（`npx` 底下的 `node`）跟著收；查不到領頭狀態時只殺領頭，不對 pgid 送訊號。子孫自己再 `setsid` 或換組的收不到。session 長開終端裝置時不帶 `O_NOCTTY` 會取得控制終端，跟 spawner 的 `--exec` 自己 `setsid` 之後一樣。
//! - 收線：transport 關了（stdin 跟著關）之後，領頭 [`STDIN_GRACE`] 內自己結束就收；沒有就對整組 SIGTERM，再等領頭最多 [`TERM_GRACE`]，之後對整組 SIGKILL（領頭已結束也送，收掉剩下的子孫），最後一定把領頭 `wait` 掉（SIGKILL 後最多等 [`KILL_WAIT`]，等不到就放手、由阻塞執行緒自己 `wait` 完）。
//!   兩段等待都只看領頭：領頭一結束，組裡剩下的子孫沒有收尾的機會，立刻 SIGKILL。子孫只收到訊號，不等它們結束，也不是宿主的子行程。三段加起來是 [`REAP_BUDGET`]，編譯期斷言小於監督者的 `GENERATION_CLOSE_TIMEOUT`。領頭不留殭屍。連線的 future 被丟下（握手或列工具中途停掉）時，[`ChildGuard`] 的 drop 對整組 SIGKILL 並在另一條執行緒 `wait`。
//! - 領頭不先收屍：[`leader_state`] 用 `waitid(WNOWAIT)` 只看不收，領頭結束後留成殭屍，pid 與 pgid 在 `wait` 之前不會被別的行程拿去用，對整組送訊號才不會打到不相干的行程。前提是宿主行程裡沒有收別人子行程的呼叫：`waitpid(-1)`、`waitid(P_ALL)`，或把 SIGCHLD 設成 `SIG_IGN`／`SA_NOCLDWAIT`。

use std::io;
use std::os::unix::process::CommandExt;
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
/// 沒被 [`reap`] 收走就 drop：對整組 SIGKILL（領頭已經結束也送，子孫可能還在；查不到領頭狀態時只殺領頭），並交給另一條執行緒 `wait`，不阻塞也不留殭屍。
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
        match leader_state(child.id()) {
            Leader::Unknown => {
                let _ = child.kill();
            }
            Leader::Running | Leader::Exited => kill_group(child.id(), libc::SIGKILL),
        }
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
    // 自成一個 session（兼一組，pgid＝sid＝pid）：收線的訊號送整組，server 的子孫一起收。
    // 不能只開組（`process_group(0)`）：被 spawner 的 `--exec` 包起來的 server，spawner 自己要 `setsid`，組長不是 session 長時回 `EPERM` 而結束（125）；
    // 已經是 session 長時它走放行的那條路。
    // SAFETY：`pre_exec` 在 fork 之後、exec 之前跑，只能呼叫 async-signal-safe 的函式；`setsid` 是，不配置記憶體、不拿鎖。
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
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

/// 收掉子行程與它同組的子孫，回來時領頭已經 `wait` 過、子孫已送出 SIGKILL（不等它們結束）；唯一例外是 SIGKILL 之後 [`KILL_WAIT`] 內沒結束（D 狀態），那時記一行錯誤、放手，`wait` 留給阻塞執行緒。transport 已經關了（stdin 已關）才呼叫。這個 future 中途被丟下，guard 照樣收。
pub async fn reap(mut guard: ChildGuard) {
    let Some(pid) = guard.id() else {
        return;
    };
    let state = match exited_within(pid, STDIN_GRACE).await {
        Leader::Running => {
            kill_group(pid, libc::SIGTERM);
            exited_within(pid, TERM_GRACE).await
        }
        // 領頭自己結束了，或查不了狀態（下面處理）。
        other => other,
    };
    // 任何一段查不了狀態，就不能保證領頭還沒被收屍，pgid 可能已被重用：不對 pgid 送訊號，只殺領頭再 `wait`。
    if let Leader::Unknown = state {
        let Some(mut child) = guard.0.take() else {
            return;
        };
        let _ = child.kill();
        wait_killed(child, pid).await;
        return;
    }
    let Some(child) = guard.0.take() else {
        return;
    };
    kill_group(pid, libc::SIGKILL);
    wait_killed(child, pid).await;
}

/// SIGKILL 已經送出：把領頭 `wait` 掉。SIGKILL 擋不住，`wait` 很快回來；放進阻塞執行緒，免得卡住執行環境。
/// 等不到 [`KILL_WAIT`] 就放手：`child` 已經在那條執行緒裡，它自己 `wait` 完，不會留殭屍，只是這裡不再等。
async fn wait_killed(mut child: Child, pid: u32) {
    let waiting = tokio::task::spawn_blocking(move || child.wait());
    if tokio::time::timeout(KILL_WAIT, waiting).await.is_err() {
        eprintln!(
            "nexus-host: mcp 錯誤：子行程 {pid} 收到 SIGKILL 後 {KILL_WAIT:?} 內沒有結束，不再等它"
        );
    }
}

/// 對 `pgid` 這一組送 `sig`。呼叫端要保證領頭還沒被 `wait`（見 [`leader_state`]）；組已經空了就是 `ESRCH`，不處理。
fn kill_group(pgid: u32, sig: libc::c_int) {
    let Ok(pgid) = i32::try_from(pgid) else {
        return;
    };
    // 0 與 1 會變成 `kill(0)`（宿主自己那一組）與 `kill(-1)`（所有送得到的行程）。
    if pgid <= 1 {
        return;
    }
    // SAFETY：呼叫端保證 `pgid` 是還沒 `wait` 的領頭的 pid。它自成一個 session 也就自成一組（`spawn` 的 `setsid`），組號就是這個 pid；pid 沒被收屍前不會被重用，`-pgid` 不會指到別組。
    unsafe { libc::kill(-pgid, sig) };
}

/// 領頭的狀態。
enum Leader {
    /// 領頭已經結束，還沒被 `wait`（殭屍）。
    Exited,
    Running,
    Unknown,
}

/// 領頭結束了沒，但不收屍：`WNOWAIT` 讓領頭留成殭屍，pid 與 pgid 在自己 `wait` 之前不會被別的行程拿去用。
/// 不用 `Child::try_wait`：它一看到結束就收屍，之後對 `-pgid` 送訊號可能打到拿到同一個號碼的別組行程。
fn leader_state(pid: u32) -> Leader {
    // SAFETY：`info` 歸零後交給 `waitid` 填；`WNOHANG` 下沒有結束的子行程時 `si_pid` 留在零，所以讀 `si_pid()` 有定義。
    let (rc, reported) = unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        let rc = libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        );
        (rc, info.si_pid())
    };
    if rc != 0 {
        return Leader::Unknown;
    }
    // `WNOHANG` 而且沒有子行程結束：`si_pid` 維持零。
    if reported == 0 {
        Leader::Running
    } else {
        Leader::Exited
    }
}

/// 在 `limit` 內等領頭結束（不收屍）。
async fn exited_within(pid: u32, limit: Duration) -> Leader {
    let deadline = Instant::now() + limit;
    loop {
        match leader_state(pid) {
            Leader::Running => {}
            other => return other,
        }
        if Instant::now() >= deadline {
            return Leader::Running;
        }
        sleep(POLL).await;
    }
}
