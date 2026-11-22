//! 測試用：起一個子行程，它先 `setpgid(0,0)` 成為組長再 exec 後面的指令（`pgexec <程式> [參數]...`），自己等它結束、回同一個結束碼。
//! 自己是 session 長時，子行程就是「組長、但 session 不是自己的」，宿主起 MCP server 的樣子（#2920）；
//! 不靠 shell 的 job control（沒有終端時它不開）。

use std::ffi::CString;
use std::os::unix::ffi::OsStrExt;

fn main() {
    let argv: Vec<CString> = std::env::args_os()
        .skip(1)
        .map(|arg| CString::new(arg.as_bytes()).expect("參數含 NUL"))
        .collect();
    assert!(!argv.is_empty(), "用法：pgexec <程式> [參數]...");
    let mut ptrs: Vec<*const libc::c_char> = argv.iter().map(|arg| arg.as_ptr()).collect();
    ptrs.push(std::ptr::null());
    // SAFETY：fork 之後子行程只做 setpgid、execv（async-signal-safe）；ptrs 以 NULL 結尾，指到的 CString 活到 exec。
    unsafe {
        let child = libc::fork();
        if child < 0 {
            eprintln!("pgexec：fork：{}", std::io::Error::last_os_error());
            std::process::exit(125);
        }
        if child > 0 {
            let mut status = 0;
            libc::waitpid(child, &mut status, 0);
            std::process::exit(if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                128 + libc::WTERMSIG(status)
            });
        }
        if libc::setpgid(0, 0) != 0 {
            eprintln!("pgexec：setpgid：{}", std::io::Error::last_os_error());
            std::process::exit(125);
        }
        libc::execv(ptrs[0], ptrs.as_ptr());
    }
    eprintln!("pgexec：exec：{}", std::io::Error::last_os_error());
    std::process::exit(126);
}
