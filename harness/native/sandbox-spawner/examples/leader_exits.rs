//! 測試用（#2942）：做出「主執行緒結束、其他執行緒還在跑」的行程。這種行程 `stat` 狀態是 `Z`，卻沒死：群組裡還有執行緒，`SIGKILL` 送得到、收得掉。
//!
//! ```text
//! leader_exits member <pid 檔>   起一條一直睡的執行緒、把自己的 pid 寫進檔，然後只結束主執行緒
//! leader_exits leader <pid 檔>   自己 setsid 成 session 領頭，起一個 member 模式的自己（pid 寫進同一個檔），然後一直等
//! ```
//!
//! 主執行緒用 `exit` 系統呼叫結束（不是 `exit_group`），行程才會留著。不用 `pthread_exit`：Rust 的主執行緒上它會 abort。
//! `leader` 不收 `member` 的屍；收不收都不影響 `member` 的狀態：只有整個執行緒群組都沒了，它才會變成真的殭屍。

use std::time::Duration;

fn main() {
    let mut args = std::env::args().skip(1);
    let mode = args
        .next()
        .expect("用法：leader_exits member|leader <pid 檔>");
    let file = args
        .next()
        .expect("用法：leader_exits member|leader <pid 檔>");
    match mode.as_str() {
        "member" => member(&file),
        "leader" => leader(&file),
        other => panic!("不認得的模式 {other}"),
    }
}

fn member(file: &str) -> ! {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_secs(60));
    });
    // 先寫暫存檔再改名：測試讀到檔就一定是完整的 pid。
    let tmp = format!("{file}.tmp");
    std::fs::write(&tmp, std::process::id().to_string()).expect("寫 pid 檔");
    std::fs::rename(&tmp, file).expect("改名");
    // SAFETY：`exit` 只結束呼叫的這條執行緒；工作執行緒握著行程。
    unsafe { libc::syscall(libc::SYS_exit, 0) };
    unreachable!("exit 不會回來")
}

fn leader(file: &str) -> ! {
    // SAFETY：只呼叫 setsid；失敗（已經是組長）就不往下，免得成員落在別的 session。
    assert!(
        unsafe { libc::setsid() } > 0,
        "setsid：{}",
        std::io::Error::last_os_error()
    );
    let exe = std::env::current_exe().expect("自己的路徑");
    // 不收 member 的屍：要的就是它留在行程表上。收尾由測試殺領頭那一組（member 也在組內）。
    #[allow(clippy::zombie_processes)]
    std::process::Command::new(exe)
        .args(["member", file])
        .spawn()
        .expect("起 member");
    loop {
        // SAFETY：只是等訊號。
        unsafe { libc::pause() };
    }
}
