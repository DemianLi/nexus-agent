//! 宿主結束時收它那個 session 裡剩下的行程（[#2920](https://github.com/DemianLi/nexus-agent/issues/2920)）。
//!
//! 宿主起的 MCP server 各自一個行程群組，監督行程對「宿主那一組」送的 SIGKILL 打不到它們與它們的子孫。
//! 監督行程起宿主時讓它自成 session（[`super::process::spawn_in_session`]），宿主底下不論分成幾組都還在這個 session 裡，
//! 所以宿主結束、還沒收屍時（殭屍還在，session 號就是它的 pid，不會被別人拿去用）掃 `/proc` 找 session 等於宿主 pid 的行程，一個個送 SIGKILL。
//! 收不到：自己再 `setsid` 而換了 session 的子孫。被收養的孤兒子孫 session 沒變，掃得到。
//!
//! 這一層是保底，「送不出去」不能被當成「已經不在」：只有 `ESRCH`（行程沒了）與再核之後不是這個 session 的成員才算不在；
//! 其他錯（fd 用完、記憶體不足、沒有權限）是 [`Kill::Failed`]，不算送過、算進剩下的、記進稽核。
//!
//! 掃與殺分開：[`sweep`] 只管迴圈與上限，吃一個「列出成員」與一個「送訊號」的函式，測試可以餵假的行程清單；
//! 真的 `/proc` 與 `pidfd` 在 [`list_members`]、[`kill_member`]；送訊號前的再核與各個系統呼叫在 [`kill_member_with`]，同樣可以換成假的。

use std::fs;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

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
/// 行程名在括號裡，可以有空白與 `)`，也可以不是合法 UTF-8（`prctl(PR_SET_NAME)` 設什麼都行），所以讀位元組、從**最後一個** `)` 切開：
/// 名字之後都是 ASCII 的狀態字母與數字。
pub fn parse_stat(text: impl AsRef<[u8]>) -> Option<Member> {
    let text = text.as_ref();
    let close = text.iter().rposition(|byte| *byte == b')')?;
    let (head, rest) = (&text[..close], &text[close + 1..]);
    let digits: Vec<u8> = head
        .iter()
        .copied()
        .take_while(u8::is_ascii_digit)
        .collect();
    let pid = std::str::from_utf8(&digits).ok()?.parse().ok()?;
    let rest = std::str::from_utf8(rest).ok()?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    Some(Member {
        pid,
        zombie: *fields.first()? == "Z",
        session: fields.get(3)?.parse().ok()?,
        start: fields.get(19)?.parse().ok()?,
    })
}

/// 行程不在了的錯：`/proc/<pid>` 沒有（`ENOENT`）或行程沒了（`ESRCH`）。
fn is_gone(err: &io::Error) -> bool {
    matches!(err.raw_os_error(), Some(libc::ENOENT | libc::ESRCH))
}

/// 讀一個行程：不在了是 `Ok(None)`；讀不了（fd 用完之類）或解不開是 `Err`，**不能**當成不在。
pub fn read_member(pid: libc::pid_t) -> io::Result<Option<Member>> {
    match fs::read(format!("/proc/{pid}/stat")) {
        Ok(text) => parse_stat(&text).map(Some).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("解不開 /proc/{pid}/stat"),
            )
        }),
        Err(err) if is_gone(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

/// 一次列出的結果：成員，加上列的過程中遇到的第一個錯（單一行程讀不了、解不開；那一個跳過，其餘照列）。
#[derive(Debug, Default)]
pub struct Listing {
    pub members: Vec<Member>,
    pub error: Option<String>,
}

/// 列出 `/proc` 底下所有看得到的行程。開不了 `/proc` 本身是 `Err`（整輪停，不回空清單）。
/// 單一行程剛好不在了（`ENOENT`／`ESRCH`）略過、不算錯；其他讀錯或解不開：跳過那一個、記進 `error`，其餘照列：
/// 別人的一個行程不該讓保底層整個失效，但也不能靜靜跳過。
pub fn list_members() -> io::Result<Listing> {
    let mut listing = Listing::default();
    for entry in fs::read_dir("/proc")? {
        let pid = match entry {
            Ok(entry) => match entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse().ok())
            {
                Some(pid) => pid,
                None => continue,
            },
            Err(err) => {
                listing
                    .error
                    .get_or_insert(format!("讀 /proc 的一筆：{err}"));
                continue;
            }
        };
        match read_member(pid) {
            Ok(Some(member)) => listing.members.push(member),
            Ok(None) => {}
            Err(err) => {
                listing.error.get_or_insert(format!("讀 {pid}：{err}"));
            }
        }
    }
    Ok(listing)
}

/// 送訊號的結果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kill {
    /// 用把手送出去了。
    Sent,
    /// 沒有 `pidfd`（核心太舊或不准），退回對單一 pid 送。
    Fallback,
    /// 行程已經沒了（`ESRCH`），或送之前再核一次，已經不是這個 session 的成員：不用送。
    Gone,
    /// 沒送成、而且不能說它不在了（錯誤碼）：fd 用完、記憶體不足、沒有權限。
    Failed(i32),
}

/// 掃的結果。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Sweep {
    /// 有送過訊號的輪數。
    pub rounds: usize,
    /// 送過訊號的 pid（含退路送的）。
    pub signalled: Vec<libc::pid_t>,
    /// 到上限時還掃得到的、沒送過訊號的活行程（含送不成的）。
    pub left: Vec<libc::pid_t>,
    /// 有任何一個走了退路。
    pub fallback: bool,
    /// 第一個沒處理好的錯：列不出成員，或某個行程送不成。
    pub error: Option<String>,
}

impl Sweep {
    /// 值得寫一筆稽核：送過訊號、走過退路、有錯，或到上限還有剩的。
    pub fn worth_recording(&self) -> bool {
        !self.signalled.is_empty() || self.fallback || !self.left.is_empty() || self.error.is_some()
    }
}

/// 收 session 等於 `host` 的行程，`host` 自己不算。每一輪列一次，對還沒送過訊號的活行程各送一次；
/// 掃到沒有新的為止，最多 [`MAX_ROUNDS`] 輪。送過訊號的不再送（它可能還沒死透、還在清單上）。
/// `kill` 回 [`Kill::Gone`] 的不算送過；回 [`Kill::Failed`] 的也不算，下一輪再試，到上限還在就留在 `left`。
/// 列不出成員（`list` 回錯誤）就停，錯記在 `error`：不當成「沒有成員」。
pub fn sweep(
    host: libc::pid_t,
    mut list: impl FnMut() -> io::Result<Listing>,
    mut kill: impl FnMut(&Member) -> Kill,
) -> Sweep {
    let mut result = Sweep::default();
    let mut seen: Vec<(libc::pid_t, u64)> = Vec::new();
    let mut fresh = |seen: &[(libc::pid_t, u64)]| -> io::Result<(Vec<Member>, Option<String>)> {
        let listing = list()?;
        let members = listing
            .members
            .into_iter()
            .filter(|m| m.session == host && m.pid != host && !m.zombie)
            .filter(|m| !seen.contains(&(m.pid, m.start)))
            .collect();
        Ok((members, listing.error))
    };
    for _ in 0..MAX_ROUNDS {
        let members = match fresh(&seen) {
            Ok((members, error)) => {
                if let Some(error) = error {
                    result.error.get_or_insert(error);
                }
                members
            }
            Err(err) => {
                result.error.get_or_insert(format!("列不出行程：{err}"));
                return result;
            }
        };
        if members.is_empty() {
            return result;
        }
        let mut sent = false;
        for member in &members {
            match kill(member) {
                Kill::Sent => {
                    seen.push((member.pid, member.start));
                    sent = true;
                    result.signalled.push(member.pid);
                }
                Kill::Fallback => {
                    seen.push((member.pid, member.start));
                    sent = true;
                    result.fallback = true;
                    result.signalled.push(member.pid);
                }
                Kill::Gone => seen.push((member.pid, member.start)),
                Kill::Failed(errno) => {
                    result.error.get_or_insert(format!(
                        "送不出去 {}：{}",
                        member.pid,
                        io::Error::from_raw_os_error(errno)
                    ));
                }
            }
        }
        if sent {
            result.rounds += 1;
        }
    }
    match fresh(&seen) {
        Ok((left, error)) => {
            result.left = left.iter().map(|m| m.pid).collect();
            if let Some(error) = error {
                result.error.get_or_insert(error);
            }
        }
        Err(err) => {
            result.error.get_or_insert(format!("列不出行程：{err}"));
        }
    }
    result
}

/// 送訊號之前再核一次：`now` 是現在讀到的這個 pid，還是同一個行程（啟動時間相同）、還是在這個 session、還活著才送。
/// 掃到與送之間行程可能死掉、pid 被別人拿去用。
pub fn still_member(host: libc::pid_t, scanned: &Member, now: Option<&Member>) -> bool {
    now.is_some_and(|now| {
        now.pid == scanned.pid && now.start == scanned.start && now.session == host && !now.zombie
    })
}

/// 對 `member` 送 SIGKILL，用真的 `/proc` 與 `pidfd`。
pub fn kill_member(host: libc::pid_t, member: &Member) -> Kill {
    kill_member_with(
        host,
        member,
        read_member,
        |pid| {
            // SAFETY：`pidfd_open` 只回一個新的 fd，成功時交給 `OwnedFd` 管。
            let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
            if fd < 0 {
                return Err(errno());
            }
            // SAFETY：`fd` 是剛開成功的 fd，沒有別人持有。
            Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
        },
        |pidfd| {
            // SAFETY：`pidfd` 有效；`info` 傳空指標，核心用預設的。
            let rc = unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    pidfd.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                )
            };
            if rc == 0 {
                Ok(())
            } else {
                Err(errno())
            }
        },
        |pid| {
            // SAFETY：只送訊號給單一 pid。
            if unsafe { libc::kill(pid, libc::SIGKILL) } == 0 {
                Ok(())
            } else {
                Err(errno())
            }
        },
    )
}

/// [`kill_member`] 的本體，讀行程與三個系統呼叫都由呼叫端給（測試換成假的）。
///
/// 先開 `pidfd`（之後的訊號只會到這個行程，pid 之後被重用也不會打錯人），再用 `read` 核一次它還是這個 session 的成員，才用把手送。
/// `open` 或 `send` 回 `ENOSYS`／`EPERM` 時退回 `kill`：對**單一 pid** 送（不對組），核了再送，回 [`Kill::Fallback`]，呼叫端記稽核。
/// 只有 `ESRCH` 與再核不是成員才是 [`Kill::Gone`]；其他錯（含再核時讀不到）是 [`Kill::Failed`]。
pub fn kill_member_with(
    host: libc::pid_t,
    member: &Member,
    read: impl Fn(libc::pid_t) -> io::Result<Option<Member>>,
    open: impl Fn(libc::pid_t) -> Result<OwnedFd, i32>,
    send: impl Fn(&OwnedFd) -> Result<(), i32>,
    kill: impl Fn(libc::pid_t) -> Result<(), i32>,
) -> Kill {
    // 再核：讀不到不能當成不在。
    let recheck = || -> Result<bool, i32> {
        match read(member.pid) {
            Ok(now) => Ok(still_member(host, member, now.as_ref())),
            Err(err) => Err(err.raw_os_error().unwrap_or(libc::EIO)),
        }
    };
    let fallback = || -> Kill {
        match recheck() {
            Ok(true) => match kill(member.pid) {
                Ok(()) => Kill::Fallback,
                Err(libc::ESRCH) => Kill::Gone,
                Err(code) => Kill::Failed(code),
            },
            Ok(false) => Kill::Gone,
            Err(code) => Kill::Failed(code),
        }
    };
    let pidfd = match open(member.pid) {
        Ok(pidfd) => pidfd,
        Err(libc::ENOSYS | libc::EPERM) => return fallback(),
        Err(libc::ESRCH) => return Kill::Gone,
        Err(code) => return Kill::Failed(code),
    };
    match recheck() {
        Ok(true) => {}
        Ok(false) => return Kill::Gone,
        Err(code) => return Kill::Failed(code),
    }
    match send(&pidfd) {
        Ok(()) => Kill::Sent,
        Err(libc::ENOSYS | libc::EPERM) => fallback(),
        Err(libc::ESRCH) => Kill::Gone,
        Err(code) => Kill::Failed(code),
    }
}

fn errno() -> i32 {
    io::Error::last_os_error().raw_os_error().unwrap_or(0)
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

    fn ok(members: Vec<Member>) -> io::Result<Listing> {
        Ok(Listing {
            members,
            error: None,
        })
    }

    /// 給 `kill_member_with` 用的把手：隨便一個開著的 fd。
    fn some_fd() -> OwnedFd {
        OwnedFd::from(fs::File::open("/dev/null").unwrap())
    }

    /// 每一輪清單都冒出新的成員（像一直 fork 的行程）：到 [`MAX_ROUNDS`] 輪就停，不再掃，剩下的記在 `left`。
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
                ok(vec![member(pid, 50)])
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

    /// 到上限只剩下 `left`、一個都沒送成時也要記稽核（`signalled` 是空的，只靠 `left` 為真）。
    #[test]
    fn a_leftover_alone_is_worth_recording() {
        let only_left = Sweep {
            left: vec![9],
            ..Sweep::default()
        };
        assert!(only_left.worth_recording());
        assert!(!Sweep::default().worth_recording());
        let only_error = Sweep {
            error: Some("x".into()),
            ..Sweep::default()
        };
        assert!(only_error.worth_recording());
    }

    /// 清單乾淨了就停，不用等滿上限；送過訊號、還掛在清單上的不再送第二次。
    #[test]
    fn stops_when_nothing_new_and_never_signals_twice() {
        let sent = RefCell::new(Vec::new());
        let result = sweep(
            50,
            || {
                ok(vec![
                    member(7, 50),
                    member(8, 50),
                    member(9, 51),
                    member(50, 50),
                ])
            },
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
        let result = sweep(50, || ok(vec![dead.clone()]), |_| panic!("不該送"));
        assert_eq!(result, Sweep::default());
        assert!(!result.worth_recording());
    }

    /// `Gone` 不算送過：送之前再核一次發現已經離開的，不進 `signalled`，也不再試。
    #[test]
    fn gone_members_are_not_counted_or_retried() {
        let calls = Cell::new(0);
        let result = sweep(
            50,
            || ok(vec![member(7, 50)]),
            |_| {
                calls.set(calls.get() + 1);
                Kill::Gone
            },
        );
        assert!(result.signalled.is_empty());
        assert_eq!(result.rounds, 0);
        assert_eq!(calls.get(), 1);
        assert!(!result.worth_recording());
    }

    /// 送不成（`Failed`）不是不在：不進 `signalled`、每一輪再試、到上限還在就留在 `left`，錯記下來、值得寫稽核。
    #[test]
    fn a_failed_kill_is_retried_and_ends_up_in_left() {
        let calls = Cell::new(0);
        let result = sweep(
            50,
            || ok(vec![member(7, 50)]),
            |_| {
                calls.set(calls.get() + 1);
                Kill::Failed(libc::EMFILE)
            },
        );
        assert_eq!(calls.get(), MAX_ROUNDS);
        assert!(result.signalled.is_empty());
        assert_eq!(result.left, vec![7]);
        assert!(result.error.as_deref().unwrap().contains('7'));
        assert!(result.worth_recording());
    }

    /// 前面失敗、後面送成了：之後不再列為剩下的。
    #[test]
    fn a_failed_kill_that_later_succeeds_is_not_left() {
        let calls = Cell::new(0);
        let result = sweep(
            50,
            || ok(vec![member(7, 50)]),
            |_| {
                calls.set(calls.get() + 1);
                if calls.get() < 3 {
                    Kill::Failed(libc::ENOMEM)
                } else {
                    Kill::Sent
                }
            },
        );
        assert_eq!(result.signalled, vec![7]);
        assert!(result.left.is_empty());
        assert!(result.error.is_some(), "曾經失敗過的錯留著，稽核才看得到");
    }

    /// 列不出成員（`/proc` 開不了）：不當成「沒有成員」，停下來、記錯、值得寫稽核，一個都不送。
    #[test]
    fn a_failed_listing_is_an_error_not_an_empty_list() {
        let result = sweep(
            50,
            || Err(io::Error::from_raw_os_error(libc::EMFILE)),
            |_| panic!("不該送"),
        );
        assert!(result.error.as_deref().unwrap().contains("列不出"));
        assert!(result.worth_recording());
        assert!(result.signalled.is_empty());
    }

    /// 走過退路的要留記號，稽核才寫得出來。
    #[test]
    fn fallback_is_remembered() {
        let result = sweep(50, || ok(vec![member(7, 50)]), |_| Kill::Fallback);
        assert!(result.fallback);
        assert_eq!(result.signalled, vec![7]);
    }

    /// 行程名裡有空白與 `)` 也讀對（從最後一個 `)` 切）。
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

    /// 行程名可以不是合法 UTF-8（`prctl(PR_SET_NAME)` 設什麼都行）：讀位元組照樣解得出來。
    #[test]
    fn u2_parses_stat_with_a_name_that_is_not_utf8() {
        let mut line = b"42 (".to_vec();
        line.extend_from_slice(&[0xff, 0xfe, b')', 0x80]);
        line.extend_from_slice(b") S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22");
        let parsed = parse_stat(&line).unwrap();
        assert_eq!((parsed.pid, parsed.session, parsed.start), (42, 3, 19));
        // 名字之後的欄位不是 UTF-8 才是真的解不開。
        let mut broken = b"42 (x) S 1 2 3".to_vec();
        broken.push(0xff);
        assert!(parse_stat(&broken).is_none());
    }

    /// 清單裡夾一個單一行程讀錯的（`error`）：其餘成員照樣被送到，錯留在結果裡、值得寫稽核；掃描沒有停。
    #[test]
    fn one_unreadable_process_does_not_stop_the_sweep() {
        let sent = RefCell::new(Vec::new());
        let result = sweep(
            50,
            || {
                Ok(Listing {
                    members: vec![member(7, 50), member(8, 50)],
                    error: Some("讀 99：解不開 /proc/99/stat".into()),
                })
            },
            |m| {
                sent.borrow_mut().push(m.pid);
                Kill::Sent
            },
        );
        assert_eq!(*sent.borrow(), vec![7, 8]);
        assert_eq!(result.signalled, vec![7, 8]);
        assert!(result.error.as_deref().unwrap().contains("99"));
        assert!(result.worth_recording());
    }

    /// 再核的判斷：不在了、換了行程（啟動時間不同）、換了 session、變成殭屍，都不算成員。
    #[test]
    fn u3_still_member_checks_every_field() {
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

    /// 掃到時在、送之前 pid 被別人拿去用（啟動時間不同）：**一個訊號都不送**，也不走退路。這一支守的是「不誤殺別人」。
    #[test]
    fn a8_a_reused_pid_is_not_signalled() {
        let scanned = member(7, 50);
        let mut reused = scanned.clone();
        reused.start = 99;
        let sent = Cell::new(0);
        let killed = Cell::new(0);
        let got = kill_member_with(
            50,
            &scanned,
            |_| Ok(Some(reused.clone())),
            |_| Ok(some_fd()),
            |_| {
                sent.set(sent.get() + 1);
                Ok(())
            },
            |_| {
                killed.set(killed.get() + 1);
                Ok(())
            },
        );
        assert_eq!(got, Kill::Gone);
        assert_eq!((sent.get(), killed.get()), (0, 0));
    }

    /// 同上，退路那條：沒有 `pidfd` 時送之前也要核。
    #[test]
    fn a8_the_fallback_rechecks_too() {
        let scanned = member(7, 50);
        let mut moved = scanned.clone();
        moved.session = 7;
        let killed = Cell::new(0);
        let got = kill_member_with(
            50,
            &scanned,
            |_| Ok(Some(moved.clone())),
            |_| Err(libc::ENOSYS),
            |_| unreachable!("沒有把手"),
            |_| {
                killed.set(killed.get() + 1);
                Ok(())
            },
        );
        assert_eq!(got, Kill::Gone);
        assert_eq!(killed.get(), 0);
    }

    /// 還是成員就送：用把手；把手不能用（`ENOSYS`）才退回單一 pid。
    #[test]
    fn a_confirmed_member_is_signalled_through_the_handle_or_the_fallback() {
        let scanned = member(7, 50);
        let read = |_| Ok(Some(member(7, 50)));
        let sent = Cell::new(0);
        let got = kill_member_with(
            50,
            &scanned,
            read,
            |_| Ok(some_fd()),
            |_| {
                sent.set(sent.get() + 1);
                Ok(())
            },
            |_| unreachable!("有把手不該退回"),
        );
        assert_eq!((got, sent.get()), (Kill::Sent, 1));
        let got = kill_member_with(
            50,
            &scanned,
            read,
            |_| Ok(some_fd()),
            |_| Err(libc::ENOSYS),
            |_| Ok(()),
        );
        assert_eq!(got, Kill::Fallback);
    }

    /// 只有 `ESRCH` 是不在；其他錯都是 `Failed`：開把手失敗（fd 用完）、再核讀不到、送不出去、退路的 `kill` 沒權限。
    #[test]
    fn only_esrch_means_gone_everything_else_failed() {
        let scanned = member(7, 50);
        let read = |_| Ok(Some(member(7, 50)));
        let run = |open: Result<OwnedFd, i32>, send: Result<(), i32>, kill: Result<(), i32>| {
            let open = Cell::new(Some(open));
            kill_member_with(
                50,
                &scanned,
                read,
                |_| open.take().unwrap(),
                |_| send,
                |_| kill,
            )
        };
        assert_eq!(run(Err(libc::ESRCH), Ok(()), Ok(())), Kill::Gone);
        assert_eq!(
            run(Err(libc::EMFILE), Ok(()), Ok(())),
            Kill::Failed(libc::EMFILE)
        );
        assert_eq!(
            run(Err(libc::ENFILE), Ok(()), Ok(())),
            Kill::Failed(libc::ENFILE)
        );
        assert_eq!(
            run(Err(libc::ENOMEM), Ok(()), Ok(())),
            Kill::Failed(libc::ENOMEM)
        );
        assert_eq!(run(Ok(some_fd()), Err(libc::ESRCH), Ok(())), Kill::Gone);
        assert_eq!(
            run(Ok(some_fd()), Err(libc::ENOMEM), Ok(())),
            Kill::Failed(libc::ENOMEM)
        );
        // 退路：沒有權限的 `kill` 不是「不在」。
        assert_eq!(
            run(Err(libc::ENOSYS), Ok(()), Err(libc::EPERM)),
            Kill::Failed(libc::EPERM)
        );
        assert_eq!(run(Err(libc::ENOSYS), Ok(()), Err(libc::ESRCH)), Kill::Gone);
        // 再核時讀不到（fd 用完）：不能當成不在。
        let got = kill_member_with(
            50,
            &scanned,
            |_| Err(io::Error::from_raw_os_error(libc::EMFILE)),
            |_| Ok(some_fd()),
            |_| unreachable!("核不了就不送"),
            |_| unreachable!("核不了就不送"),
        );
        assert_eq!(got, Kill::Failed(libc::EMFILE));
    }

    /// 真的 `/proc` 與 `pidfd`：自成 session 的領頭（宿主）底下兩個成員，一個留在領頭那一組、一個自己換了行程群組（`setpgid`，沒換 session）。
    /// 留在組內的那一個把名字設成非 UTF-8 位元組加 `)`（`prctl(PR_SET_NAME)`），掃得到才算數。
    /// 兩個都掃得到、送得到、掃完都不在（死了留成領頭的殭屍也算）；領頭不動。結束時領頭一併收掉，不留行程。
    #[test]
    fn kills_members_of_a_session_including_one_that_changed_group() {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY：fork 之後子行程只呼叫 async-signal-safe 的函式（setsid、fork、setpgid、write、pause）。
        let leader = unsafe {
            assert_eq!(libc::pipe(fds.as_mut_ptr()), 0);
            let leader = libc::fork();
            assert!(leader >= 0);
            if leader == 0 {
                // 測試行程的 fd 副本不留在這三個不會 exec 的行程裡（別的測試等某條管線 EOF 時會被拖住）：領頭只留管線寫端，成員一個都不留。
                let keep = fds[1] as libc::c_uint;
                libc::syscall(libc::SYS_close_range, 3u32, keep.wrapping_sub(1), 0u32);
                libc::syscall(libc::SYS_close_range, keep + 1, u32::MAX, 0u32);
                libc::setsid();
                for i in 0..2 {
                    let child = libc::fork();
                    if child == 0 {
                        libc::syscall(libc::SYS_close_range, 3u32, u32::MAX, 0u32);
                        if i == 1 {
                            libc::setpgid(0, 0);
                        } else {
                            // 行程名帶非 UTF-8 位元組與 `)`：`read_to_string` 會在這裡回 `InvalidData`，讀位元組才掃得到它。
                            let name: [u8; 6] = [0xff, 0xfe, b')', 0x80, b'x', 0];
                            libc::prctl(libc::PR_SET_NAME, name.as_ptr());
                        }
                        loop {
                            libc::pause();
                        }
                    }
                    let bytes = child.to_ne_bytes();
                    libc::write(fds[1], bytes.as_ptr().cast(), bytes.len());
                }
                loop {
                    libc::pause();
                }
            }
            libc::close(fds[1]);
            leader
        };
        let mut pids = [0 as libc::pid_t; 2];
        for pid in &mut pids {
            let mut bytes = [0u8; 4];
            // SAFETY：讀進長度正好的緩衝區。
            let n = unsafe { libc::read(fds[0], bytes.as_mut_ptr().cast(), bytes.len()) };
            assert_eq!(n, 4);
            *pid = libc::pid_t::from_ne_bytes(bytes);
        }
        // SAFETY：關掉自己開的管線。
        unsafe { libc::close(fds[0]) };
        // 第二個的 setpgid 要等它跑到；等它的組號等於自己的 pid。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            // SAFETY：只查行程群組。
            if unsafe { libc::getpgid(pids[1]) } == pids[1] {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "第二個成員沒換組");
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // 第一個的名字也要設好（`stat` 裡看得到 0xff）才掃，不然這支測不到非 UTF-8。
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !fs::read(format!("/proc/{}/stat", pids[0])).is_ok_and(|stat| stat.contains(&0xff)) {
            assert!(
                std::time::Instant::now() < deadline,
                "第一個成員的名字沒設成非 UTF-8"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // SAFETY：只查行程群組。
        assert_eq!(
            unsafe { libc::getpgid(pids[0]) },
            leader,
            "第一個該留在領頭那一組"
        );

        let result = sweep(leader, list_members, |member| kill_member(leader, member));

        let alive = |pid| read_member(pid).unwrap().is_some_and(|m| !m.zombie);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while pids.iter().any(|pid| alive(*pid)) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let leader_alive = alive(leader);
        let survivors: Vec<_> = pids.iter().filter(|pid| alive(**pid)).collect();
        // 清掉領頭，不留行程：成員已死（領頭的殭屍），領頭 SIGKILL 之後收屍；掃描壞了而成員還活著時也一併送 SIGKILL。
        // SAFETY：只動這個測試自己 fork 出來的行程。
        unsafe {
            for pid in pids {
                libc::kill(pid, libc::SIGKILL);
            }
            libc::kill(leader, libc::SIGKILL);
            libc::waitpid(leader, std::ptr::null_mut(), 0);
        }
        for pid in pids {
            assert!(
                result.signalled.contains(&pid),
                "{pid} 沒被送到：{result:?}"
            );
        }
        assert!(
            !result.fallback && result.left.is_empty() && result.error.is_none(),
            "{result:?}"
        );
        assert!(leader_alive, "領頭不該被動");
        assert!(survivors.is_empty(), "{survivors:?} 還活著");
    }

    /// 真的 `/proc`：自己讀得到自己，session 欄與 `getsid` 一致；不存在的 pid 是 `Ok(None)`。
    #[test]
    fn reads_the_real_proc_for_this_process() {
        let me = std::process::id() as libc::pid_t;
        let read = read_member(me).unwrap().expect("讀得到自己");
        assert_eq!(read.pid, me);
        // SAFETY：`getsid(0)` 只回自己的 session。
        assert_eq!(read.session, unsafe { libc::getsid(0) });
        let listing = list_members().unwrap();
        assert!(listing.members.iter().any(|m| m.pid == me));
        assert!(listing.error.is_none(), "{:?}", listing.error);
        assert_eq!(read_member(i32::MAX).unwrap(), None);
    }
}
