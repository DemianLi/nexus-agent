//! 記憶體類死因的判斷：RSS 讀法、cgroup 的 `oom_kill` 計數、行程結束時分成哪一類。

use crate::supervisor_protocol::DeathCause;
use std::path::{Path, PathBuf};

/// V8 各種 heap 致命訊息共同的結尾（`Reached heap limit …`、`Ineffective mark-compacts near heap limit …`、`CALL_AND_RETRY_LAST …` 都以它收尾）。
pub const HEAP_MARKER: &[u8] = b"JavaScript heap out of memory";
/// node 印那則訊息的那一行以這個開頭。只認以它開頭、又含 [`HEAP_MARKER`] 的行：工具輸出被轉印到 stderr 時，那句話多半夾在行中間。
pub const HEAP_LINE_PREFIX: &[u8] = b"FATAL ERROR: ";
/// 那一行之後 node 還會印 native stack trace（node v22 上實測 1.2–2.7 KiB）。那一行的結尾要落在 stderr 最後這麼多位元組之內才算：
/// 早先印過、之後又活了一陣子才因為別的原因 abort 的，不算 heap。
pub const HEAP_TAIL: u64 = 16 * 1024;

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

/// 容量公式（設計 §7-1）的常數，單位 MiB：每條對話行程的峰值（R6）、監督行程（p2t 量到的）、前台（估的，C0 量）。
const PER_CONVERSATION_MIB: u64 = 209;
const SUPERVISOR_MIB: u64 = 19;
const FRONT_MIB: u64 = 150;

/// 記憶體上限是 `limit_bytes` 時，同時能活幾個對話行程：⌊（上限 − 一半保留 − 監督行程 − 前台）÷ 每條⌋，最少 1。
pub fn capacity_for(limit_bytes: u64) -> u32 {
    let mib = limit_bytes >> 20;
    let usable = (mib - mib / 2).saturating_sub(SUPERVISOR_MIB + FRONT_MIB);
    u32::try_from(usable / PER_CONVERSATION_MIB).unwrap_or(u32::MAX).max(1)
}

/// cgroup v2 的 `memory.max`（bytes）；`max` 是沒有上限。
pub fn parse_memory_max(text: &str) -> Option<u64> {
    text.trim().parse().ok()
}

/// `/proc/meminfo` 的 `MemTotal`，換成 bytes。
pub fn parse_mem_total_bytes(meminfo: &str) -> Option<u64> {
    let line = meminfo.lines().find(|line| line.starts_with("MemTotal:"))?;
    let kib: u64 = line["MemTotal:".len()..].trim().strip_suffix("kB")?.trim().parse().ok()?;
    kib.checked_mul(1024)
}

/// 記憶體上限（bytes）：`/proc/self/cgroup` 指到的 cgroup v2 目錄與它每一層上層的 `memory.max`，加上 `MemTotal`，取最小的。
/// 限制常設在上層（例如 systemd 的 slice），自己這層是 `max`。都讀不到回 `None`。
pub fn memory_limit_bytes(proc_self_cgroup: &str, cgroup_root: &Path, meminfo: &str) -> Option<u64> {
    let mut limits = vec![parse_mem_total_bytes(meminfo)];
    if let Some(relative) = proc_self_cgroup.lines().find_map(|line| line.strip_prefix("0::")) {
        let mut dir = cgroup_root.join(relative.trim().trim_start_matches('/'));
        loop {
            limits.push(std::fs::read_to_string(dir.join("memory.max")).ok().as_deref().and_then(parse_memory_max));
            if dir == cgroup_root || !dir.pop() || !dir.starts_with(cgroup_root) {
                break;
            }
        }
    }
    limits.into_iter().flatten().min()
}

/// 照這台機器（或容器）的記憶體上限算出的容量，與用來算的上限（bytes）。上限讀不到時回 1 條、上限 `None`。
pub fn auto_capacity() -> (u32, Option<u64>) {
    let cgroup = std::fs::read_to_string("/proc/self/cgroup").unwrap_or_default();
    let meminfo = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let limit = memory_limit_bytes(&cgroup, Path::new("/sys/fs/cgroup"), &meminfo);
    (limit.map_or(1, capacity_for), limit)
}

/// 行程結束了，分成哪一類。
///
/// - 以 SIGKILL 結束的，一律先算一次 `oom_kill`（`oom`）：監督行程送了 SIGKILL、核心又搶先 OOM kill 它時，那一次也要在這裡消掉，
///   不能留給之後一條無關的行程領走。只有 SIGKILL 才去算，免得別的死法吃掉計數；
/// - 監督行程自己決定收它的（停機、RSS 超過上限、送了解不開的框或綁錯 thread）照那個理由；
/// - SIGABRT 而且 stderr 結尾附近有 V8 的 heap 訊息（`heap_message`）：`heap`；
/// - SIGKILL 而且算到了 `oom_kill`：`host-oom`；
/// - 其他都是 `crash`。
pub fn classify(decided: Option<DeathCause>, signal: Option<i32>, heap_message: bool, oom: impl FnOnce() -> bool) -> DeathCause {
    let oom_killed = signal == Some(libc::SIGKILL) && oom();
    if let Some(cause) = decided {
        return cause;
    }
    match signal {
        Some(libc::SIGABRT) if heap_message => DeathCause::Heap,
        Some(libc::SIGKILL) if oom_killed => DeathCause::HostOom,
        _ => DeathCause::Crash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_matches_the_design_table() {
        const GIB: u64 = 1 << 30;
        assert_eq!(capacity_for(64 * GIB), 155);
        assert_eq!(capacity_for(32 * GIB), 77);
        assert_eq!(capacity_for(8 * GIB), 18);
        assert_eq!(capacity_for(256 << 20), 1);
        assert_eq!(capacity_for(0), 1);
    }

    #[test]
    fn memory_limit_is_the_smallest_of_each_cgroup_level_and_mem_total() {
        let root = std::env::temp_dir().join(format!("nsup-memmax-{}", std::process::id()));
        let leaf = root.join("slice/app");
        std::fs::create_dir_all(&leaf).unwrap();
        std::fs::write(leaf.join("memory.max"), "max\n").unwrap();
        std::fs::write(root.join("slice/memory.max"), "4294967296\n").unwrap();
        let meminfo = "MemTotal:       16384000 kB\nMemFree: 1 kB\n";
        assert_eq!(memory_limit_bytes("0::/slice/app\n", &root, meminfo), Some(4 << 30));
        assert_eq!(memory_limit_bytes("0::/slice/app\n", &root, "MemTotal: 1024 kB\n"), Some(1 << 20));
        assert_eq!(memory_limit_bytes("1:memory:/x\n", &root, meminfo), Some(16_384_000 * 1024));
        assert_eq!(memory_limit_bytes("", &root, ""), None);
        assert_eq!(parse_memory_max("max\n"), None);
    }

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
            memory_events_path("0::/user.slice/a.scope\n", root),
            Some(PathBuf::from("/sys/fs/cgroup/user.slice/a.scope/memory.events"))
        );
        // 只有 v1 的主機沒有 `0::` 那一行。
        assert_eq!(memory_events_path("12:memory:/docker/abc\n", root), None);
        // hybrid（v1 與 v2 並存）照樣取 `0::` 那一行，但它的 v2 掛在 `/sys/fs/cgroup/unified`，接在寫死的根底下讀不到，
        // 結果跟沒有 v2 一樣：被殺的都算 `crash`。
        assert_eq!(
            memory_events_path("1:name=systemd:/x\n0::/x\n", root),
            Some(PathBuf::from("/sys/fs/cgroup/x/memory.events"))
        );
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
        assert_eq!(classify(Some(DeathCause::Shutdown), Some(libc::SIGTERM), false, || panic!("不該算")), DeathCause::Shutdown);
    }

    #[test]
    fn oom_kill_during_a_decided_kill_is_consumed_there() {
        let path = std::env::temp_dir().join(format!("nsup-unit-oom-decided-{}", std::process::id()));
        std::fs::write(&path, "oom_kill 0\n").unwrap();
        let mut counter = OomCounter::at(Some(path.clone()));
        // RSS 超過上限、監督行程送了 SIGKILL，核心在它死之前也 OOM kill 了它：死因照 memory，這一次 OOM 在這裡算掉。
        std::fs::write(&path, "oom_kill 1\n").unwrap();
        assert_eq!(classify(Some(DeathCause::Memory), Some(libc::SIGKILL), false, || counter.claim()), DeathCause::Memory);
        // 之後一條被別人 kill -9 的，不能領走那一次。
        assert_eq!(classify(None, Some(libc::SIGKILL), false, || counter.claim()), DeathCause::Crash);
        std::fs::remove_file(&path).unwrap();
    }
}
