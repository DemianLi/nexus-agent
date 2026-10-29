//! seccomp 過濾器：spawner 啟動時裝一次，之後 fork 出來的每個子行程都繼承（#1946 S1、S3）。
//!
//! 規則照 S1（#1827 issuecomment-6369593415）：
//!
//! - 擋網路：`socket(AF_INET)`、`socket(AF_INET6)` 回 EACCES；`io_uring_setup` 回 EACCES。
//! - `socket(AF_UNIX)`、`socket(AF_VSOCK)` 回 EPERM。`socketpair(AF_UNIX)` 不擋：擋了 Node `child_process` 的 stdio pipe 就壞。
//! - `io_uring_enter`、`io_uring_register` 回 EPERM。
//! - namespace 與 mount 系列 13 條回 EPERM：`unshare`、`setns`、`clone` 帶 `CLONE_NEW*`，以及 10 條 mount 系列。
//! - `clone3` 回 ENOSYS：BPF 看不到它的旗標（參數是指標），glibc 拿到 ENOSYS 會退回 `clone`。
//! - 架構不符、x86_64 上的 x32 呼叫：KILL。不然換一套 syscall ABI 就繞過整個過濾器。
//!
//! 被擋時回錯誤碼、不用 KILL：KILL 會讓 `ls -l`、`id`、`getent` 這類會試 nscd 的程式被 SIGSYS 殺掉。

use libc::sock_filter;

const LD_ABS_W: u16 = 0x20;
const JEQ_K: u16 = 0x15;
const JSET_K: u16 = 0x45;
const RET_K: u16 = 0x06;

/// `SECCOMP_RET_ALLOW`。
pub const ALLOW: u32 = 0x7fff_0000;
/// `SECCOMP_RET_KILL_PROCESS`。
pub const KILL_PROCESS: u32 = 0x8000_0000;

/// `SECCOMP_RET_ERRNO`，帶錯誤碼。
pub const fn errno(e: i32) -> u32 {
    0x0005_0000 | (e as u32 & 0xffff)
}

/// `struct seccomp_data` 的欄位位移。`args[0]` 只讀低 32 位元：要比的是位址族與旗標，都在低位。
const OFF_NR: u32 = 0;
const OFF_ARCH: u32 = 4;
const OFF_ARG0: u32 = 16;

#[cfg(target_arch = "aarch64")]
pub const AUDIT_ARCH: u32 = 0xC000_00B7;
#[cfg(target_arch = "x86_64")]
pub const AUDIT_ARCH: u32 = 0xC000_003E;

/// x86_64 的 x32 ABI 把這一位元加在 syscall 編號上。
#[cfg(target_arch = "x86_64")]
pub const X32_SYSCALL_BIT: u32 = 0x4000_0000;

const CLONE_NEW_MASK: u32 = (libc::CLONE_NEWTIME as u32)
    | (libc::CLONE_NEWNS as u32)
    | (libc::CLONE_NEWCGROUP as u32)
    | (libc::CLONE_NEWUTS as u32)
    | (libc::CLONE_NEWIPC as u32)
    | (libc::CLONE_NEWUSER as u32)
    | (libc::CLONE_NEWPID as u32)
    | (libc::CLONE_NEWNET as u32);

/// mount 系列：`clone` 帶 `CLONE_NEW*`、`unshare`、`setns` 之外的 10 條。
pub const MOUNT_SYSCALLS: [i64; 10] = [
    libc::SYS_mount,
    libc::SYS_umount2,
    libc::SYS_pivot_root,
    libc::SYS_open_tree,
    libc::SYS_move_mount,
    libc::SYS_fsopen,
    libc::SYS_fsconfig,
    libc::SYS_fsmount,
    libc::SYS_fspick,
    libc::SYS_mount_setattr,
];

fn insn(code: u16, jt: u8, jf: u8, k: u32) -> sock_filter {
    sock_filter { code, jt, jf, k }
}

/// 每個區塊自己重新載入 syscall 編號，跳躍距離都在區塊內，順序可以任意調換。
struct Program(Vec<sock_filter>);

impl Program {
    fn deny(&mut self, nr: i64, action: u32) {
        self.0.push(insn(LD_ABS_W, 0, 0, OFF_NR));
        self.0.push(insn(JEQ_K, 0, 1, nr as u32));
        self.0.push(insn(RET_K, 0, 0, action));
    }

    fn deny_arg0_eq(&mut self, nr: i64, value: u32, action: u32) {
        self.0.push(insn(LD_ABS_W, 0, 0, OFF_NR));
        self.0.push(insn(JEQ_K, 0, 3, nr as u32));
        self.0.push(insn(LD_ABS_W, 0, 0, OFF_ARG0));
        self.0.push(insn(JEQ_K, 0, 1, value));
        self.0.push(insn(RET_K, 0, 0, action));
    }

    fn deny_arg0_any(&mut self, nr: i64, mask: u32, action: u32) {
        self.0.push(insn(LD_ABS_W, 0, 0, OFF_NR));
        self.0.push(insn(JEQ_K, 0, 3, nr as u32));
        self.0.push(insn(LD_ABS_W, 0, 0, OFF_ARG0));
        self.0.push(insn(JSET_K, 0, 1, mask));
        self.0.push(insn(RET_K, 0, 0, action));
    }
}

/// 組出 S1 的過濾器。
pub fn program() -> Vec<sock_filter> {
    let mut p = Program(vec![
        insn(LD_ABS_W, 0, 0, OFF_ARCH),
        insn(JEQ_K, 1, 0, AUDIT_ARCH),
        insn(RET_K, 0, 0, KILL_PROCESS),
    ]);
    #[cfg(target_arch = "x86_64")]
    {
        p.0.push(insn(LD_ABS_W, 0, 0, OFF_NR));
        p.0.push(insn(JSET_K, 0, 1, X32_SYSCALL_BIT));
        p.0.push(insn(RET_K, 0, 0, KILL_PROCESS));
    }
    let eacces = errno(libc::EACCES);
    let eperm = errno(libc::EPERM);
    p.deny_arg0_eq(libc::SYS_socket, libc::AF_INET as u32, eacces);
    p.deny_arg0_eq(libc::SYS_socket, libc::AF_INET6 as u32, eacces);
    p.deny(libc::SYS_io_uring_setup, eacces);
    p.deny_arg0_eq(libc::SYS_socket, libc::AF_UNIX as u32, eperm);
    p.deny_arg0_eq(libc::SYS_socket, libc::AF_VSOCK as u32, eperm);
    p.deny(libc::SYS_io_uring_enter, eperm);
    p.deny(libc::SYS_io_uring_register, eperm);
    p.deny(libc::SYS_unshare, eperm);
    p.deny(libc::SYS_setns, eperm);
    p.deny_arg0_any(libc::SYS_clone, CLONE_NEW_MASK, eperm);
    for nr in MOUNT_SYSCALLS {
        p.deny(nr, eperm);
    }
    p.deny(libc::SYS_clone3, errno(libc::ENOSYS));
    p.0.push(insn(RET_K, 0, 0, ALLOW));
    p.0
}

/// 對目前的行程裝上 `NO_NEW_PRIVS` 與過濾器。之後 fork 的子行程都繼承，exec 也帶著走。
pub fn install() -> Result<usize, std::io::Error> {
    let prog = program();
    let fprog = libc::sock_fprog { len: prog.len() as u16, filter: prog.as_ptr() as *mut sock_filter };
    // SAFETY：prctl 只讀 fprog 指到的陣列，prog 在呼叫期間存活。
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::prctl(libc::PR_SET_SECCOMP, libc::SECCOMP_MODE_FILTER, &fprog as *const libc::sock_fprog) != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(prog.len())
}

/// 照核心的語意跑一遍過濾器，給單元測試用：只支援上面用到的四種指令。
pub fn evaluate(prog: &[sock_filter], arch: u32, nr: u32, arg0: u32) -> u32 {
    let mut acc = 0u32;
    let mut pc = 0usize;
    loop {
        let i = prog[pc];
        pc += 1;
        match i.code {
            LD_ABS_W => {
                acc = match i.k {
                    OFF_NR => nr,
                    OFF_ARCH => arch,
                    OFF_ARG0 => arg0,
                    other => panic!("未支援的位移 {other}"),
                }
            }
            JEQ_K => pc += usize::from(if acc == i.k { i.jt } else { i.jf }),
            JSET_K => pc += usize::from(if acc & i.k != 0 { i.jt } else { i.jf }),
            RET_K => return i.k,
            other => panic!("未支援的指令 {other:#x}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(nr: i64, arg0: u32) -> u32 {
        evaluate(&program(), AUDIT_ARCH, nr as u32, arg0)
    }

    #[test]
    fn network_sockets_get_eacces() {
        assert_eq!(run(libc::SYS_socket, libc::AF_INET as u32), errno(libc::EACCES));
        assert_eq!(run(libc::SYS_socket, libc::AF_INET6 as u32), errno(libc::EACCES));
        assert_eq!(run(libc::SYS_io_uring_setup, 0), errno(libc::EACCES));
    }

    #[test]
    fn unix_and_vsock_sockets_get_eperm_but_socketpair_is_allowed() {
        assert_eq!(run(libc::SYS_socket, libc::AF_UNIX as u32), errno(libc::EPERM));
        assert_eq!(run(libc::SYS_socket, libc::AF_VSOCK as u32), errno(libc::EPERM));
        assert_eq!(run(libc::SYS_socketpair, libc::AF_UNIX as u32), ALLOW);
        assert_eq!(run(libc::SYS_socket, libc::AF_NETLINK as u32), ALLOW);
    }

    #[test]
    fn io_uring_and_namespaces_get_eperm() {
        for nr in [libc::SYS_io_uring_enter, libc::SYS_io_uring_register, libc::SYS_unshare, libc::SYS_setns] {
            assert_eq!(run(nr, 0), errno(libc::EPERM), "nr {nr}");
        }
        for nr in MOUNT_SYSCALLS {
            assert_eq!(run(nr, 0), errno(libc::EPERM), "nr {nr}");
        }
    }

    #[test]
    fn clone_is_denied_only_with_a_new_namespace_flag() {
        assert_eq!(run(libc::SYS_clone, libc::SIGCHLD as u32), ALLOW);
        assert_eq!(run(libc::SYS_clone, (libc::CLONE_VM | libc::CLONE_THREAD) as u32), ALLOW);
        for flag in [libc::CLONE_NEWUSER, libc::CLONE_NEWNET, libc::CLONE_NEWNS, libc::CLONE_NEWPID, libc::CLONE_NEWTIME] {
            assert_eq!(run(libc::SYS_clone, flag as u32 | libc::SIGCHLD as u32), errno(libc::EPERM), "flag {flag:#x}");
        }
    }

    #[test]
    fn clone3_gets_enosys() {
        assert_eq!(run(libc::SYS_clone3, 0), errno(libc::ENOSYS));
    }

    #[test]
    fn foreign_arch_is_killed() {
        assert_eq!(evaluate(&program(), 0x4000_0003, libc::SYS_read as u32, 0), KILL_PROCESS);
    }

    #[cfg(target_arch = "x86_64")]
    #[test]
    fn x32_calls_are_killed() {
        assert_eq!(run(libc::SYS_read | i64::from(X32_SYSCALL_BIT), 0), KILL_PROCESS);
    }

    #[test]
    fn ordinary_calls_are_allowed() {
        for nr in [libc::SYS_read, libc::SYS_write, libc::SYS_openat, libc::SYS_execve, libc::SYS_close] {
            assert_eq!(run(nr, 0), ALLOW, "nr {nr}");
        }
    }
}
