//! 整合測試在沙箱裡跑的探針：做一件事，把結果印成一行（`ok` 或 `errno=<n>`）。
//!
//! ```text
//! probe read <path> | write <path> | tcp | udp | unix | socketpair | vsock | uring
//!       unshare | setns | clone-newuser | clone3 | thread | syscall <nr>
//!       x32 | i386 | connect <socket> <id> <fd> | kill <pid> | pdeathsig
//! ```

use std::io::Write;

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn report(ret: i64) {
    if ret < 0 {
        println!("errno={}", errno());
    } else {
        println!("ok");
    }
}

fn socket(family: i32, kind: i32) -> i64 {
    // SAFETY：建了就關。
    let fd = unsafe { libc::socket(family, kind, 0) };
    if fd >= 0 {
        unsafe { libc::close(fd) };
    }
    i64::from(fd)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let arg = |i: usize| args.get(i).cloned().unwrap_or_default();
    // SAFETY：每一條都是單一系統呼叫，參數故意給不成立的值，只看過濾器會不會在核心處理前就擋下來。
    unsafe {
        match arg(1).as_str() {
            "read" => report(std::fs::read(arg(2)).map(|_| 0).unwrap_or_else(|e| {
                println!("errno={}", e.raw_os_error().unwrap_or(0));
                std::process::exit(0)
            })),
            "write" => report(std::fs::write(arg(2), b"x").map(|_| 0).unwrap_or_else(|e| {
                println!("errno={}", e.raw_os_error().unwrap_or(0));
                std::process::exit(0)
            })),
            "tcp" => {
                let fd = libc::socket(libc::AF_INET, libc::SOCK_STREAM, 0);
                if fd < 0 {
                    report(-1);
                } else {
                    // socket 建得起來（沒有過濾器）時，再試 Landlock 擋不擋 connect。
                    let mut addr: libc::sockaddr_in = std::mem::zeroed();
                    addr.sin_family = libc::AF_INET as libc::sa_family_t;
                    addr.sin_port = 9u16.to_be();
                    addr.sin_addr.s_addr = u32::from_be_bytes([127, 0, 0, 1]).to_be();
                    let r = libc::connect(fd, (&addr as *const libc::sockaddr_in).cast(), std::mem::size_of::<libc::sockaddr_in>() as u32);
                    report(i64::from(r));
                }
            }
            "udp" => report(socket(libc::AF_INET, libc::SOCK_DGRAM)),
            "pdeathsig" => {
                let mut sig: libc::c_int = 0;
                libc::prctl(libc::PR_GET_PDEATHSIG, &mut sig as *mut libc::c_int);
                println!("sig={sig}");
            }
            "udp6" => report(socket(libc::AF_INET6, libc::SOCK_DGRAM)),
            "unix" => report(socket(libc::AF_UNIX, libc::SOCK_STREAM)),
            "vsock" => report(socket(libc::AF_VSOCK, libc::SOCK_STREAM)),
            "socketpair" => {
                let mut fds = [0; 2];
                report(i64::from(libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr())));
            }
            "uring" => report(libc::syscall(libc::SYS_io_uring_setup, 1, std::ptr::null_mut::<libc::c_void>())),
            "uring-enter" => report(libc::syscall(libc::SYS_io_uring_enter, -1, 0, 0, 0, 0, 0)),
            "uring-register" => report(libc::syscall(libc::SYS_io_uring_register, -1, 0, 0, 0)),
            "unshare" => report(i64::from(libc::unshare(libc::CLONE_NEWUSER))),
            "setns" => report(i64::from(libc::setns(-1, 0))),
            "clone-newuser" => {
                let r = libc::syscall(libc::SYS_clone, (libc::CLONE_NEWUSER | libc::SIGCHLD) as libc::c_ulong, 0, 0, 0, 0);
                if r == 0 {
                    libc::_exit(0);
                }
                report(r);
            }
            "clone3" => report(libc::syscall(libc::SYS_clone3, std::ptr::null_mut::<libc::c_void>(), 0usize)),
            // glibc 起執行緒先試 clone3，拿到 ENOSYS 退回 clone（S1 第 6 條）。
            "thread" => report(std::thread::spawn(|| 7).join().map(|v| v - 7).unwrap_or(-1) as i64),
            // 任意一條 syscall，參數全給 -1：過濾器擋下來是 EPERM；放過去由核心回 EBADF、EINVAL、EFAULT 之類。
            "syscall" => {
                let nr: i64 = arg(2).parse().unwrap();
                report(libc::syscall(nr, -1, -1, -1, -1, -1, -1));
            }
            #[cfg(target_arch = "x86_64")]
            "x32" => report(libc::syscall(libc::SYS_getpid | 0x4000_0000)),
            #[cfg(target_arch = "x86_64")]
            "i386" => {
                // int 0x80 走 32 位元的 ABI（AUDIT_ARCH_I386），getpid 在那邊是 20。
                let ret: i64;
                std::arch::asm!("int 0x80", inlateout("rax") 20i64 => ret, options(nostack));
                println!("ret={ret}");
            }
            // 訊號 0 只做權限檢查，不真的送。
            "kill" => report(i64::from(libc::kill(arg(2).parse().unwrap(), 0))),
            "connect" => {
                use std::os::unix::net::UnixStream;
                let mut s = UnixStream::connect(arg(2)).unwrap();
                let id: u32 = arg(3).parse().unwrap();
                let fd: u32 = arg(4).parse().unwrap();
                s.write_all(&[id.to_le_bytes(), fd.to_le_bytes()].concat()).unwrap();
                std::thread::sleep(std::time::Duration::from_secs(10));
            }
            other => {
                eprintln!("不認得：{other}");
                std::process::exit(2);
            }
        }
    }
}
