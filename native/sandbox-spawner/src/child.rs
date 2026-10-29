//! fork 之後、exec 之前的子行程。
//!
//! spawner 是單執行緒，所以這裡配置記憶體（landlock crate 會）是安全的。每一條失敗路徑都把原因寫進狀態 pipe（CLOEXEC；
//! 搬到 fd 3 之前寫原本的 fd，之後寫 fd 3），格式是 `種類 u8、errno i32 LE、說明`，然後 `_exit(125)`；
//! exec 成功時 pipe 隨 exec 關掉，spawner 讀到 EOF 就知道起來了。

use nexus_sandbox_spawner::landlock;
use nexus_sandbox_spawner::protocol::FailKind;
use std::ffi::CString;

pub const STATUS_FD: libc::c_int = 3;

/// 已經在 fork 之前備好的東西：指標陣列都以 NULL 結尾。
pub struct Prepared {
    pub stdio: [libc::c_int; 3],
    pub status: libc::c_int,
    pub spawner: libc::pid_t,
    pub cwd: CString,
    pub abi: i32,
    pub readable: Vec<Vec<u8>>,
    pub writable: Vec<Vec<u8>>,
    /// 依序試的執行檔路徑（argv[0] 有 `/` 時只有它自己；沒有時是 PATH 裡的每一個候選）。
    pub candidates: Vec<CString>,
    pub argv: Vec<*const libc::c_char>,
    pub envp: Vec<*const libc::c_char>,
    /// 只有測試建置會大於 0：`setsid` 之前先睡這麼久，讓測試穩穩造出「子行程還沒自成一組」的時間窗。
    pub test_delay_us: u32,
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

unsafe fn fail(fd: libc::c_int, kind: FailKind, err: i32, detail: &str) -> ! {
    let mut record = vec![kind as u8];
    record.extend_from_slice(&err.to_le_bytes());
    record.extend_from_slice(detail.as_bytes());
    let mut rest = record.as_slice();
    while !rest.is_empty() {
        let n = libc::write(fd, rest.as_ptr().cast(), rest.len());
        if n <= 0 {
            break;
        }
        rest = &rest[n as usize..];
    }
    libc::_exit(125);
}

/// 子行程的全部步驟，順序本身就是安全性的一部分。
///
/// # Safety
/// 只能在 fork 出來的子行程裡呼叫。
pub unsafe fn run(p: &Prepared) -> ! {
    if p.test_delay_us > 0 {
        libc::usleep(p.test_delay_us);
    }
    // 自己一個 session：spawner 對整個行程群組送訊號（`kill(-pid)`），也脫離 serve 的控制終端，終端的 Ctrl-C 不會打到工具。
    libc::setsid();
    // spawner 被硬殺時，工具不留下來。設好之後再核一次父行程，避開「設之前父行程就已經死了」的空窗。
    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
    if libc::getppid() != p.spawner {
        fail(p.status, FailKind::Resource, 0, "spawner 已經不在");
    }
    for (i, &fd) in p.stdio.iter().enumerate() {
        if libc::dup2(fd, i as libc::c_int) < 0 {
            fail(p.status, FailKind::Resource, errno(), "dup2 stdio");
        }
    }
    // stdio 已經複製到 0..2，這裡蓋掉 fd 3 不會弄丟它們。
    if p.status != STATUS_FD && libc::dup2(p.status, STATUS_FD) < 0 {
        fail(p.status, FailKind::Resource, errno(), "dup2 status");
    }
    libc::fcntl(STATUS_FD, libc::F_SETFD, libc::FD_CLOEXEC);
    // fd 3 是狀態 pipe（CLOEXEC）；fd 4 以上全部關掉：監聽 socket、signalfd、別的 id 的連線、pidfd 與狀態 pipe 原本的 fd，都不留給工具。
    if libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) != 0 {
        fail(STATUS_FD, FailKind::Resource, errno(), "close_range");
    }
    // spawner 擋了幾個訊號改由 signalfd 收：遮罩與處置都還原成預設，工具才收得到 SIGTERM、SIGPIPE。
    let mut empty: libc::sigset_t = std::mem::zeroed();
    libc::sigemptyset(&mut empty);
    libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
    for sig in 1..=libc::SIGRTMAX() {
        if sig != libc::SIGKILL && sig != libc::SIGSTOP {
            libc::signal(sig, libc::SIG_DFL);
        }
    }
    // 先 chdir 再上 Landlock：起點不存在或進不去，要報成起點的問題，不是沙箱不可用（#1945）。
    if libc::chdir(p.cwd.as_ptr()) != 0 {
        fail(STATUS_FD, FailKind::StartDir, errno(), "chdir");
    }
    if let Err(e) = landlock::restrict_self(p.abi, &p.readable, &p.writable) {
        fail(STATUS_FD, FailKind::SandboxUnavailable, 0, &format!("landlock: {e}"));
    }
    // 逐一試候選：EACCES 記下來繼續找，找完都沒有就回它；ENOENT、ENOTDIR、ESTALE、ENODEV、ETIMEDOUT 繼續找；
    // 其他錯誤當場停，回那一個。
    // 跟 glibc execvp 的差別：ENOEXEC 不改用 `/bin/sh` 跑（沒有 shebang 的檔案就是 exec 失敗）。
    let mut saw_eacces = false;
    let mut last = libc::ENOENT;
    for candidate in &p.candidates {
        libc::execve(candidate.as_ptr(), p.argv.as_ptr(), p.envp.as_ptr());
        last = errno();
        match last {
            libc::EACCES => saw_eacces = true,
            libc::ENOENT | libc::ENOTDIR | libc::ESTALE | libc::ENODEV | libc::ETIMEDOUT => {}
            _ => fail(STATUS_FD, FailKind::Exec, last, "exec"),
        }
    }
    fail(STATUS_FD, FailKind::Exec, if saw_eacces { libc::EACCES } else { last }, "exec");
}
