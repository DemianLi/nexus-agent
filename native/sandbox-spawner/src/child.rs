//! fork 之後、exec 之前的子行程。
//!
//! spawner 是單執行緒，所以這裡配置記憶體（landlock crate 會）是安全的。失敗時把原因寫到 fd 3（狀態 pipe，CLOEXEC），
//! 格式是 `種類 u8、errno i32 LE、說明`，然後 `_exit(125)`；exec 成功時 fd 3 隨 exec 關掉，spawner 讀到 EOF 就知道起來了。

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
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

unsafe fn fail(kind: FailKind, err: i32, detail: &str) -> ! {
    let mut record = vec![kind as u8];
    record.extend_from_slice(&err.to_le_bytes());
    record.extend_from_slice(detail.as_bytes());
    let mut rest = record.as_slice();
    while !rest.is_empty() {
        let n = libc::write(STATUS_FD, rest.as_ptr().cast(), rest.len());
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
    // 自己一個 session：Node 對整個行程群組送訊號（`kill(-pid)`），也脫離 serve 的控制終端，終端的 Ctrl-C 不會打到工具。
    libc::setsid();
    // spawner 被硬殺時，工具不留下來。設好之後再核一次父行程，避開「設之前父行程就已經死了」的空窗。
    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
    if libc::getppid() != p.spawner {
        libc::_exit(125);
    }
    for (i, &fd) in p.stdio.iter().enumerate() {
        if libc::dup2(fd, i as libc::c_int) < 0 {
            libc::_exit(125);
        }
    }
    // stdio 已經複製到 0..2，這裡蓋掉 fd 3 不會弄丟它們。
    if p.status != STATUS_FD && libc::dup2(p.status, STATUS_FD) < 0 {
        libc::_exit(125);
    }
    libc::fcntl(STATUS_FD, libc::F_SETFD, libc::FD_CLOEXEC);
    // 不讓工具繼承監聽 socket、控制通道之外的連線、別次 spawn 的 fd。
    if libc::syscall(libc::SYS_close_range, 4u32, u32::MAX, 0u32) != 0 {
        fail(FailKind::Resource, errno(), "close_range");
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
        fail(FailKind::StartDir, errno(), "chdir");
    }
    if let Err(e) = landlock::restrict_self(p.abi, &p.readable, &p.writable) {
        fail(FailKind::SandboxUnavailable, 0, &format!("landlock: {e}"));
    }
    // 照 execvp 的規則：EACCES 記下來繼續找，找完都沒有就回它；ENOENT、ENOTDIR 繼續找；其他錯誤當場停，回那一個。
    let mut saw_eacces = false;
    let mut last = libc::ENOENT;
    for candidate in &p.candidates {
        libc::execve(candidate.as_ptr(), p.argv.as_ptr(), p.envp.as_ptr());
        last = errno();
        match last {
            libc::EACCES => saw_eacces = true,
            libc::ENOENT | libc::ENOTDIR => {}
            _ => fail(FailKind::Exec, last, "exec"),
        }
    }
    fail(FailKind::Exec, if saw_eacces { libc::EACCES } else { last }, "exec");
}
