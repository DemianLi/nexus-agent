//! 對話行程吃了多少 CPU：讀 `/proc/<pid>/stat` 的 utime＋stime（整個執行緒群組），判斷是不是連續吃滿一顆，吃滿太久就把群組 renice 到 19。

use std::time::{Duration, Instant};

/// 兩次取樣之間用掉的 CPU 時間至少是經過時間的這個比例，才算吃滿一顆。
const BUSY_SHARE: f64 = 0.9;

/// 這個行程（含所有執行緒）累計用掉的 CPU，單位 clock tick；讀不到回 `None`。
pub fn cpu_ticks(pid: libc::pid_t) -> Option<u64> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<&str> = stat.rsplit_once(") ")?.1.split(' ').collect();
    // 括號後第 12、13 欄是 utime、stime（stat 的第 14、15 欄）。
    Some(fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?)
}

/// 每秒幾個 clock tick。
pub fn ticks_per_second() -> u64 {
    // SAFETY：只查系統常數。
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz > 0 {
        hz as u64
    } else {
        100
    }
}

/// 把整個行程群組 renice 到 19。用 `PRIO_PGRP`：`PRIO_PROCESS` 在 Linux 只改 tid 等於 pid 的那一條執行緒，GC 與 libuv 的執行緒不會跟著變。
pub fn renice_group(pgid: libc::pid_t) -> std::io::Result<()> {
    // SAFETY：只改那個群組的排程優先權。
    if unsafe { libc::setpriority(libc::PRIO_PGRP, pgid as libc::id_t, 19) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// 一個行程的 CPU 取樣。
#[derive(Default)]
pub struct Busy {
    last: Option<(u64, Instant)>,
    since: Option<Instant>,
}

impl Busy {
    /// 記一次取樣，回已經連續吃滿多久；這一段沒吃滿回 `None`。第一次取樣只當基準。
    pub fn sample(&mut self, ticks: u64, now: Instant, ticks_per_second: u64) -> Option<Duration> {
        if let Some((last_ticks, last_at)) = self.last {
            let elapsed = now.saturating_duration_since(last_at).as_secs_f64();
            let used = ticks.saturating_sub(last_ticks) as f64 / ticks_per_second as f64;
            if elapsed > 0.0 && used >= BUSY_SHARE * elapsed {
                self.since.get_or_insert(last_at);
            } else {
                self.since = None;
            }
        }
        self.last = Some((ticks, now));
        self.since.map(|since| now.saturating_duration_since(since))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_counts_from_the_first_full_interval_and_resets_on_a_quiet_one() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut busy = Busy::default();
        assert_eq!(busy.sample(0, at(0), 100), None);
        // 1 s 用了 0.95 s：吃滿，從上一次取樣算起。
        assert_eq!(busy.sample(95, at(1_000), 100), Some(Duration::from_secs(1)));
        assert_eq!(busy.sample(195, at(2_000), 100), Some(Duration::from_secs(2)));
        // 多執行緒一秒用掉兩秒也算。
        assert_eq!(busy.sample(395, at(3_000), 100), Some(Duration::from_secs(3)));
        // 一秒只用 0.5 s：歸零。
        assert_eq!(busy.sample(445, at(4_000), 100), None);
        assert_eq!(busy.sample(540, at(5_000), 100), Some(Duration::from_secs(1)));
    }

    #[test]
    fn just_under_the_share_is_not_busy() {
        let t0 = Instant::now();
        let mut busy = Busy::default();
        busy.sample(0, t0, 100);
        assert_eq!(busy.sample(89, t0 + Duration::from_secs(1), 100), None);
        assert_eq!(busy.sample(179, t0 + Duration::from_secs(2), 100), Some(Duration::from_secs(1)));
    }

    #[test]
    fn reads_this_process() {
        let me = std::process::id() as libc::pid_t;
        assert!(cpu_ticks(me).is_some());
        assert!(cpu_ticks(-1).is_none());
    }
}
