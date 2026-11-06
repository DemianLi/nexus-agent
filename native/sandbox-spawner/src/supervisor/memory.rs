//! 記憶體類死因的判斷：RSS 讀法、cgroup 的 `oom_kill` 計數、行程結束時分成哪一類。

use crate::supervisor_protocol::DeathCause;
use std::path::{Path, PathBuf};

/// V8 各種 heap 致命訊息共同的結尾（`Reached heap limit …`、`Ineffective mark-compacts near heap limit …` 都以它收尾）。
pub const HEAP_MARKER: &[u8] = b"JavaScript heap out of memory";

/// `/proc/<pid>/status` 裡 `VmRSS` 的值（kB）。沒有這一欄（例如 zombie）回 `None`。
pub fn parse_vm_rss_kb(status: &str) -> Option<u64> {
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    line["VmRSS:".len()..].trim().strip_suffix("kB")?.trim().parse().ok()
}

pub fn vm_rss_kb(pid: libc::pid_t) -> Option<u64> {
    parse_vm_rss_kb(&std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?)
}

/// cgroup v2 的 `memory.events` 裡 `oom_kill` 的值。
pub fn parse_oom_kill(events: &str) -> Option<u64> {
    events.lines().find_map(|line| line.strip_prefix("oom_kill ")).and_then(|value| value.trim().parse().ok())
}

/// `/proc/self/cgroup` 指到的 cgroup v2 目錄底下的 `memory.events`。只認 v2 的那一行（`0::<路徑>`）。
pub fn memory_events_path(proc_self_cgroup: &str, cgroup_root: &Path) -> Option<PathBuf> {
    let relative = proc_self_cgroup.lines().find_map(|line| line.strip_prefix("0::"))?;
    Some(cgroup_root.join(relative.trim().trim_start_matches('/')).join("memory.events"))
}

/// 監督行程所在 cgroup 的 `oom_kill` 計數。子行程跟它同一個 cgroup，`memory.events` 的計數含底下的子 cgroup。
pub struct OomCounter {
    path: Option<PathBuf>,
    /// 已經算掉的計數：開的時候就有的，加上算給結束行程的次數。
    claimed: u64,
}

impl OomCounter {
    /// 讀不到（不是 cgroup v2、沒有記憶體控制器）就一律回「沒有 OOM」，被殺的都算 `crash`。
    pub fn open() -> OomCounter {
        let path = std::fs::read_to_string("/proc/self/cgroup")
            .ok()
            .and_then(|text| memory_events_path(&text, Path::new("/sys/fs/cgroup")));
        OomCounter::at(path)
    }

    pub fn at(path: Option<PathBuf>) -> OomCounter {
        let claimed = path.as_deref().and_then(read_oom_kill).unwrap_or(0);
        OomCounter { path, claimed }
    }

    /// 計數比已經算掉的多，就算掉一次、回 `true`：一次 OOM 只算給一個被 SIGKILL 的行程。
    pub fn claim(&mut self) -> bool {
        let now = self.path.as_deref().and_then(read_oom_kill).unwrap_or(0);
        if now > self.claimed {
            self.claimed += 1;
            return true;
        }
        false
    }
}

fn read_oom_kill(path: &Path) -> Option<u64> {
    parse_oom_kill(&std::fs::read_to_string(path).ok()?)
}

/// 行程結束了，分成哪一類。
///
/// - 監督行程自己決定收它的（停機、RSS 超過上限、送了解不開的框或綁錯 thread）照那個理由，不看訊號；
/// - SIGABRT 而且 stderr 有 [`HEAP_MARKER`]：`heap`；
/// - 不是監督行程送的 SIGKILL，而且 cgroup 的 `oom_kill` 多了：`host-oom`（只在這種情況才去算 `oom_kill`）；
/// - 其他都是 `crash`。
pub fn classify(decided: Option<DeathCause>, signal: Option<i32>, heap_marker: bool, oom: impl FnOnce() -> bool) -> DeathCause {
    if let Some(cause) = decided {
        return cause;
    }
    match signal {
        Some(libc::SIGABRT) if heap_marker => DeathCause::Heap,
        Some(libc::SIGKILL) if oom() => DeathCause::HostOom,
        _ => DeathCause::Crash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vm_rss_is_read_in_kb() {
        let status = "Name:\tnode\nVmPeak:\t  999 kB\nVmRSS:\t  123456 kB\nRssAnon:\t 1 kB\n";
        assert_eq!(parse_vm_rss_kb(status), Some(123_456));
        assert_eq!(parse_vm_rss_kb("Name:\tzombie\nState:\tZ (zombie)\n"), None);
    }

    #[test]
    fn oom_kill_is_read_from_memory_events() {
        let events = "low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\noom_group_kill 0\n";
        assert_eq!(parse_oom_kill(events), Some(2));
        assert_eq!(parse_oom_kill("low 0\n"), None);
    }

    #[test]
    fn memory_events_path_follows_the_v2_line() {
        let root = Path::new("/sys/fs/cgroup");
        assert_eq!(memory_events_path("0::/\n", root), Some(PathBuf::from("/sys/fs/cgroup/memory.events")));
        assert_eq!(
            memory_events_path("1:name=systemd:/x\n0::/user.slice/a.scope\n", root),
            Some(PathBuf::from("/sys/fs/cgroup/user.slice/a.scope/memory.events"))
        );
        assert_eq!(memory_events_path("12:memory:/docker/abc\n", root), None);
    }

    #[test]
    fn each_oom_kill_is_claimed_once() {
        let path = std::env::temp_dir().join(format!("nsup-unit-oom-{}", std::process::id()));
        std::fs::write(&path, "oom_kill 4\n").unwrap();
        let mut counter = OomCounter::at(Some(path.clone()));
        assert!(!counter.claim(), "開之前就有的不算");
        std::fs::write(&path, "oom_kill 6\n").unwrap();
        assert!(counter.claim());
        assert!(counter.claim());
        assert!(!counter.claim(), "兩次 OOM 只算給兩個行程");
        std::fs::remove_file(&path).unwrap();
        assert!(!OomCounter::at(None).claim());
    }

    #[test]
    fn classify_by_cause_signal_marker_and_oom() {
        let no_oom = || false;
        let oom = || true;
        assert_eq!(classify(Some(DeathCause::Memory), Some(libc::SIGKILL), false, oom), DeathCause::Memory);
        assert_eq!(classify(Some(DeathCause::Shutdown), Some(libc::SIGABRT), true, no_oom), DeathCause::Shutdown);
        assert_eq!(classify(None, Some(libc::SIGABRT), true, no_oom), DeathCause::Heap);
        assert_eq!(classify(None, Some(libc::SIGABRT), false, no_oom), DeathCause::Crash);
        assert_eq!(classify(None, Some(libc::SIGKILL), false, oom), DeathCause::HostOom);
        assert_eq!(classify(None, Some(libc::SIGKILL), false, no_oom), DeathCause::Crash);
        assert_eq!(classify(None, Some(libc::SIGSEGV), true, oom), DeathCause::Crash);
        assert_eq!(classify(None, None, true, oom), DeathCause::Crash);
        // 只有 SIGKILL 才去算 oom_kill，免得別的死法吃掉計數。
        assert_eq!(classify(None, Some(libc::SIGABRT), false, || panic!("不該算")), DeathCause::Crash);
    }
}
