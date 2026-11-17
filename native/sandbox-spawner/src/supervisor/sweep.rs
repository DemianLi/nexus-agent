//! 宿主結束時收它那個 session 裡剩下的行程（[#2920](https://github.com/DemianLi/nexus-agent/issues/2920)）。
//!
//! 宿主起的 MCP server 各自一個行程群組，監督行程對「宿主那一組」送的 SIGKILL 打不到它們與它們的子孫。
//! 監督行程起宿主時讓它自成 session（[`super::process::spawn_in_session`]），宿主底下不論分成幾組都還在這個 session 裡，
//! 所以宿主結束、還沒收屍時（殭屍還在，session 號就是它的 pid，不會被別人拿去用）掃 `/proc` 找 session 等於宿主 pid 的行程，一個個送 SIGKILL。
//! 收不到：自己再 `setsid` 的子孫，與已經不是宿主的後代而被別人收養的。
//!
//! 掃與殺分開：[`sweep`] 只管迴圈與上限，吃一個「列出成員」與一個「送訊號」的函式，測試可以餵假的行程清單；
//! 真的 `/proc` 與 `pidfd` 在 [`list_members`]、[`kill_member`]。

use std::fs;
use std::os::fd::{FromRawFd, OwnedFd};

/// 最多掃幾輪。每一輪只對「還沒送過訊號」的活行程送；到了上限還有新的就停，照常收屍並記稽核。
pub const MAX_ROUNDS: usize = 8;

/// `/proc/<pid>/stat` 裡這一章要的欄位。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub pid: libc::pid_t,
    pub session: libc::pid_t,
    /// 開機以來的啟動時間（`stat` 第 22 欄）：同一個 pid 被重用時它會不同。
    pub start: u64,
    /// 狀態是 `Z`：已經死了、等人收屍，送訊號沒有意義，也不會自己消失。
    pub zombie: bool,
}

/// 解 `/proc/<pid>/stat` 的一行：`pid (comm) state ppid pgrp session ... starttime ...`。
/// 行程名在括號裡，可以有空白與 `)`，所以從**最後一個** `)` 切開。
pub fn parse_stat(text: &str) -> Option<Member> {
    let (head, rest) = text.rsplit_once(')')?;
    let pid = head.split_whitespace().next()?.parse().ok()?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    Some(Member {
        pid,
        zombie: *fields.first()? == "Z",
        session: fields.get(3)?.parse().ok()?,
        start: fields.get(19)?.parse().ok()?,
    })
}

/// 讀一個行程；不在了（或讀不了）是 `None`。
pub fn read_member(pid: libc::pid_t) -> Option<Member> {
    parse_stat(&fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// 列出 `/proc` 底下所有看得到的行程。掃的當下消失的略過。
pub fn list_members() -> Vec<Member> {
    let Ok(dir) = fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
        .filter_map(read_member)
        .collect()
}

/// 送訊號的結果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kill {
    /// 用把手送出去了。
    Sent,
    /// 沒有 `pidfd`（核心太舊或不准），退回對單一 pid 送。
    Fallback,
    /// 送之前再核一次，已經不是這個 session 的、或已經不在：不送。
    Gone,
}

/// 掃的結果。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Sweep {
    /// 有送過訊號的輪數。
    pub rounds: usize,
    /// 送過訊號的 pid（含退路送的）。
    pub signalled: Vec<libc::pid_t>,
    /// 到上限時還掃得到的、沒送過訊號的活行程。
    pub left: Vec<libc::pid_t>,
    /// 有任何一個走了退路。
    pub fallback: bool,
}

impl Sweep {
    /// 值得寫一筆稽核：送過訊號、走過退路，或到上限還有剩的。
    pub fn worth_recording(&self) -> bool {
        !self.signalled.is_empty() || self.fallback || !self.left.is_empty()
    }
}

/// 收 session 等於 `host` 的行程，`host` 自己不算。每一輪列一次，對還沒送過訊號的活行程各送一次；
/// 掃到沒有新的為止，最多 [`MAX_ROUNDS`] 輪。送過訊號的不再送（它可能還沒死透、還在清單上）。
/// `kill` 回 [`Kill::Gone`] 的不算送過。
pub fn sweep(
    host: libc::pid_t,
    mut list: impl FnMut() -> Vec<Member>,
    mut kill: impl FnMut(&Member) -> Kill,
) -> Sweep {
    let mut result = Sweep::default();
    let mut seen: Vec<(libc::pid_t, u64)> = Vec::new();
    let fresh = |list: &mut dyn FnMut() -> Vec<Member>, seen: &[(libc::pid_t, u64)]| {
        list()
            .into_iter()
            .filter(|m| m.session == host && m.pid != host && !m.zombie)
            .filter(|m| !seen.contains(&(m.pid, m.start)))
            .collect::<Vec<_>>()
    };
    for _ in 0..MAX_ROUNDS {
        let members = fresh(&mut list, &seen);
        if members.is_empty() {
            return result;
        }
        let mut sent = false;
        for member in &members {
            seen.push((member.pid, member.start));
            match kill(member) {
                Kill::Sent => {
                    sent = true;
                    result.signalled.push(member.pid);
                }
                Kill::Fallback => {
                    sent = true;
                    result.fallback = true;
                    result.signalled.push(member.pid);
                }
                Kill::Gone => {}
            }
        }
        if sent {
            result.rounds += 1;
        }
    }
    result.left = fresh(&mut list, &seen).iter().map(|m| m.pid).collect();
    result
}

/// 送訊號之前再核一次：`now` 是現在讀到的這個 pid，還是同一個行程（啟動時間相同）、還是在這個 session、還活著才送。
/// 掃到與送之間行程可能死掉、pid 被別人拿去用。
pub fn still_member(host: libc::pid_t, scanned: &Member, now: Option<&Member>) -> bool {
    now.is_some_and(|now| {
        now.pid == scanned.pid && now.start == scanned.start && now.session == host && !now.zombie
    })
}

/// 對 `member` 送 SIGKILL。先開 `pidfd`（之後的訊號只會到這個行程，pid 之後被重用也不會打錯人），再核一次它還是這個 session 的成員，才用把手送。
/// `pidfd_open` 或 `pidfd_send_signal` 回 `ENOSYS`／`EPERM` 時退回對**單一 pid** 送（不對組），回 [`Kill::Fallback`]，呼叫端記稽核。
pub fn kill_member(host: libc::pid_t, member: &Member) -> Kill {
    // SAFETY：`pidfd_open` 只回一個新的 fd，成功時交給 `OwnedFd` 管。
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, member.pid, 0) };
    if fd < 0 {
        return match errno() {
            libc::ENOSYS | libc::EPERM => fallback(host, member),
            _ => Kill::Gone,
        };
    }
    // SAFETY：`fd` 是剛開成功的 fd，沒有別人持有。
    let pidfd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    if !still_member(host, member, read_member(member.pid).as_ref()) {
        return Kill::Gone;
    }
    // SAFETY：`pidfd` 有效；`info` 傳空指標，核心用預設的。
    let rc = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            std::os::fd::AsRawFd::as_raw_fd(&pidfd),
            libc::SIGKILL,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if rc == 0 {
        return Kill::Sent;
    }
    match errno() {
        libc::ENOSYS | libc::EPERM => fallback(host, member),
        _ => Kill::Gone,
    }
}

/// 沒有把手時：對單一 pid 送。不對組；pid 重用的窗留著（核一次再送，之間仍有極小的窗），所以只在把手不能用時走這裡。
fn fallback(host: libc::pid_t, member: &Member) -> Kill {
    if !still_member(host, member, read_member(member.pid).as_ref()) {
        return Kill::Gone;
    }
    // SAFETY：只送訊號給單一 pid。
    if unsafe { libc::kill(member.pid, libc::SIGKILL) } == 0 {
        Kill::Fallback
    } else {
        Kill::Gone
    }
}

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn member(pid: libc::pid_t, session: libc::pid_t) -> Member {
        Member {
            pid,
            session,
            start: 1,
            zombie: false,
        }
    }

    /// U1：每一輪清單都冒出新的成員（像一直 fork 的行程）：到 [`MAX_ROUNDS`] 輪就停，不再掃，剩下的記在 `left`。
    #[test]
    fn u1_stops_after_the_round_limit_and_reports_what_is_left() {
        let next = Cell::new(100);
        let lists = Cell::new(0);
        let result = sweep(
            50,
            || {
                lists.set(lists.get() + 1);
                let pid = next.get();
                next.set(pid + 1);
                vec![member(pid, 50)]
            },
            |_| Kill::Sent,
        );
        assert_eq!(result.rounds, MAX_ROUNDS);
        assert_eq!(result.signalled.len(), MAX_ROUNDS);
        assert_eq!(result.left, vec![100 + MAX_ROUNDS as libc::pid_t]);
        // 8 輪各列一次，上限那一次再看一眼剩下的：不多不少。
        assert_eq!(lists.get(), MAX_ROUNDS + 1);
        assert!(result.worth_recording());
    }

    /// 清單乾淨了就停，不用等滿上限；送過訊號、還掛在清單上的不再送第二次。
    #[test]
    fn stops_when_nothing_new_and_never_signals_twice() {
        let sent = RefCell::new(Vec::new());
        let result = sweep(
            50,
            || vec![member(7, 50), member(8, 50), member(9, 51), member(50, 50)],
            |m| {
                sent.borrow_mut().push(m.pid);
                Kill::Sent
            },
        );
        assert_eq!(*sent.borrow(), vec![7, 8]);
        assert_eq!(result.rounds, 1);
        assert!(result.left.is_empty());
    }

    /// 殭屍不送也不算剩下的：它等人收屍，不會自己消失。
    #[test]
    fn zombies_are_neither_signalled_nor_left() {
        let mut dead = member(7, 50);
        dead.zombie = true;
        let result = sweep(50, || vec![dead.clone()], |_| panic!("不該送"));
        assert_eq!(result, Sweep::default());
        assert!(!result.worth_recording());
    }

    /// `Gone` 不算送過：送之前再核一次發現已經離開的，不進 `signalled`。
    #[test]
    fn gone_members_are_not_counted() {
        let result = sweep(50, || vec![member(7, 50)], |_| Kill::Gone);
        assert!(result.signalled.is_empty());
        assert_eq!(result.rounds, 0);
    }

    /// 走過退路的要留記號，稽核才寫得出來。
    #[test]
    fn fallback_is_remembered() {
        let result = sweep(50, || vec![member(7, 50)], |_| Kill::Fallback);
        assert!(result.fallback);
        assert_eq!(result.signalled, vec![7]);
    }

    /// U2：行程名裡有空白與 `)` 也讀對（從最後一個 `)` 切）。
    #[test]
    fn u2_parses_stat_with_awkward_names() {
        let tail = "S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22";
        // 欄位：state=S、ppid=1、pgrp=2、session=3、starttime 是第 22 欄（`)` 之後的第 20 個）。
        let line = format!("42 (a b) c) {tail}");
        let parsed = parse_stat(&line).unwrap();
        assert_eq!(parsed.pid, 42);
        assert_eq!(parsed.session, 3);
        assert_eq!(parsed.start, 19);
        assert!(!parsed.zombie);
        let zombie =
            parse_stat("42 (x) Z 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22")
                .unwrap();
        assert!(zombie.zombie);
        assert!(parse_stat("42 (x").is_none());
        assert!(parse_stat("42 (x) S 1 2").is_none());
    }

    /// U3：送訊號前再核一次：不在了、換了行程（啟動時間不同）、換了 session、變成殭屍，都不送。
    #[test]
    fn u3_rechecks_before_signalling() {
        let scanned = member(7, 50);
        assert!(still_member(50, &scanned, Some(&scanned)));
        assert!(!still_member(50, &scanned, None));
        let mut reused = scanned.clone();
        reused.start = 2;
        assert!(!still_member(50, &scanned, Some(&reused)));
        let mut moved = scanned.clone();
        moved.session = 7;
        assert!(!still_member(50, &scanned, Some(&moved)));
        let mut dead = scanned.clone();
        dead.zombie = true;
        assert!(!still_member(50, &scanned, Some(&dead)));
        let mut other = scanned.clone();
        other.pid = 8;
        assert!(!still_member(50, &scanned, Some(&other)));
    }

    /// 真的 `/proc` 與 `pidfd`：自成 session 的 sh 底下兩個 `sleep`（其中一個自己換了行程群組），掃完兩個都不在了，領頭（宿主）不動。
    #[test]
    fn kills_the_real_members_of_a_session_but_not_its_leader() {
        use std::os::unix::process::CommandExt;
        use std::process::Command;
        let mut leader = Command::new("/bin/sh");
        leader
            .arg("-c")
            .arg("sleep 300 & echo $!; (exec setsid -w sleep 300) & wait");
        leader.stdout(std::process::Stdio::piped());
        // SAFETY：pre_exec 裡只有 setsid。
        unsafe {
            leader.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let mut leader = leader.spawn().unwrap();
        let host = leader.id() as libc::pid_t;
        let mut line = String::new();
        std::io::BufRead::read_line(
            &mut std::io::BufReader::new(leader.stdout.take().unwrap()),
            &mut line,
        )
        .unwrap();
        let first: libc::pid_t = line.trim().parse().unwrap();
        // 等第二個 sleep 也起來（setsid -w 之下它自己開了新 session，不在宿主的 session，預期掃不到：這是限制）。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while read_member(first).is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let result = sweep(host, list_members, |member| kill_member(host, member));
        assert!(result.signalled.contains(&first), "{result:?}");
        assert!(!result.fallback, "{result:?}");
        assert!(result.left.is_empty(), "{result:?}");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while read_member(first).is_some_and(|m| !m.zombie) && std::time::Instant::now() < deadline
        {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(read_member(first).is_none_or(|m| m.zombie));
        assert!(read_member(host).is_some_and(|m| !m.zombie), "領頭不該被動");
        // 自己 `setsid` 的那個不在這個 session，掃不到：已知限制（L1 在整合測試釘）。
        assert!(result.signalled.iter().all(|pid| *pid != host));
        leader.kill().unwrap();
        leader.wait().unwrap();
    }

    /// 真的 `/proc`：自己讀得到自己，session 欄與 `getsid` 一致。
    #[test]
    fn reads_the_real_proc_for_this_process() {
        let me = std::process::id() as libc::pid_t;
        let read = read_member(me).expect("讀得到自己");
        assert_eq!(read.pid, me);
        // SAFETY：`getsid(0)` 只回自己的 session。
        assert_eq!(read.session, unsafe { libc::getsid(0) });
        assert!(list_members().iter().any(|m| m.pid == me));
    }
}
