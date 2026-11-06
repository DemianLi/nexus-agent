//! 對話行程是不是一直想要一整顆 CPU：取樣兩個累計量，看最近一段窗口的平均，夠高就把群組 renice 到 19。
//!
//! - 整個執行緒群組用掉的 CPU：`/proc/<pid>/stat` 的 utime＋stime。
//! - leader 這條執行緒在 CPU 上與排隊等 CPU 的時間：`/proc/<pid>/schedstat` 的前兩欄。搶 CPU 時（別的行程也在跑、cgroup 被
//!   throttle），空轉的行程拿不到一整顆，第一個量就到不了門檻；它一直可以跑，第二個量照樣接近經過時間。
//!
//! 兩個取較高的。只看 leader 的那個量蓋不到別的執行緒在空轉；只看群組的那個量蓋不到搶 CPU 的情況。

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// 窗口裡平均每秒至少有這麼多秒想跑，才算一直想要一整顆。
const BUSY_SHARE: f64 = 0.9;

/// 這個行程（含所有執行緒）累計用掉的 CPU；讀不到回 `None`。
pub fn cpu_time(pid: libc::pid_t, ticks_per_second: u64) -> Option<Duration> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<&str> = stat.rsplit_once(") ")?.1.split(' ').collect();
    // 括號後第 12、13 欄是 utime、stime（stat 的第 14、15 欄），單位 clock tick。
    let ticks = fields.get(11)?.parse::<u64>().ok()? + fields.get(12)?.parse::<u64>().ok()?;
    Some(Duration::from_nanos(ticks.saturating_mul(1_000_000_000) / ticks_per_second.max(1)))
}

/// leader 這條執行緒累計在 CPU 上與排隊等 CPU 的時間；核心沒開 schedstat 或讀不到回 `None`。
pub fn runnable_time(pid: libc::pid_t) -> Option<Duration> {
    let schedstat = std::fs::read_to_string(format!("/proc/{pid}/schedstat")).ok()?;
    let mut fields = schedstat.split_ascii_whitespace().map(|field| field.parse::<u64>().ok());
    Some(Duration::from_nanos(fields.next()??.saturating_add(fields.next()??)))
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

/// 一次取樣：兩個累計量，讀不到的是 `None`。
#[derive(Clone, Copy)]
struct Sample {
    at: Instant,
    cpu: Option<Duration>,
    runnable: Option<Duration>,
}

/// 一個行程最近一段的取樣。
#[derive(Default)]
pub struct Busy {
    samples: VecDeque<Sample>,
}

impl Busy {
    /// 記一次取樣，回最近 `window` 是不是一直想要一整顆。取樣還不滿 `window` 回 `false`。
    pub fn sample(
        &mut self,
        now: Instant,
        cpu: Option<Duration>,
        runnable: Option<Duration>,
        window: Duration,
    ) -> bool {
        self.samples.push_back(Sample { at: now, cpu, runnable });
        // 留到「第二舊的那筆也已經滿 window」之前：最舊那筆就是剛好涵蓋 window 的起點。
        while self.samples.get(1).is_some_and(|second| now.saturating_duration_since(second.at) >= window) {
            self.samples.pop_front();
        }
        let oldest = self.samples[0];
        let elapsed = now.saturating_duration_since(oldest.at);
        if elapsed < window || elapsed.is_zero() {
            return false;
        }
        let share = |from: Option<Duration>, to: Option<Duration>| match (from, to) {
            (Some(from), Some(to)) => to.saturating_sub(from).as_secs_f64() / elapsed.as_secs_f64(),
            _ => 0.0,
        };
        share(oldest.cpu, cpu).max(share(oldest.runnable, runnable)) >= BUSY_SHARE
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: Duration = Duration::from_secs(2);

    /// 每 250 ms 一筆，照給的兩個比例累加，回第一次判成忙的時間（毫秒）。
    fn first_busy(shares: &[(f64, Option<f64>)]) -> Option<u64> {
        let t0 = Instant::now();
        let mut busy = Busy::default();
        let (mut cpu, mut runnable) = (0.0, 0.0);
        for (i, (cpu_share, runnable_share)) in shares.iter().enumerate() {
            let ms = i as u64 * 250;
            if i > 0 {
                cpu += 0.25 * cpu_share;
                runnable += 0.25 * runnable_share.unwrap_or(0.0);
            }
            let runnable = runnable_share.map(|_| Duration::from_secs_f64(runnable));
            if busy.sample(t0 + Duration::from_millis(ms), Some(Duration::from_secs_f64(cpu)), runnable, WINDOW) {
                return Some(ms);
            }
        }
        None
    }

    #[test]
    fn a_full_core_counts_once_the_window_is_covered() {
        assert_eq!(first_busy(&[(1.0, Some(1.0)); 20]), Some(2_000));
    }

    #[test]
    fn spinning_while_contended_counts_by_time_spent_waiting_for_the_cpu() {
        // S4 試跑實測的形狀：只拿到 0.32–0.60 顆，在 CPU 上加排隊 0.81–1.15，單筆常低於 0.9，平均高於。
        let contended: Vec<_> = (0..20).map(|i| if i % 2 == 0 { (0.4, Some(0.82)) } else { (0.55, Some(1.1)) }).collect();
        assert_eq!(first_busy(&contended), Some(2_000));
    }

    #[test]
    fn a_thread_other_than_the_leader_spinning_counts_by_group_cpu() {
        assert_eq!(first_busy(&[(1.2, Some(0.1)); 20]), Some(2_000));
        // 核心沒開 schedstat。
        assert_eq!(first_busy(&[(1.0, None); 20]), Some(2_000));
    }

    #[test]
    fn a_quiet_stretch_inside_the_window_keeps_it_below() {
        let mut shares = vec![(1.0, Some(1.0)); 20];
        for share in &mut shares[4..8] {
            *share = (0.0, Some(0.0));
        }
        // 安靜那 1 s 要整段滑出 2 s 的窗口才會判忙：最後一筆安靜的在 1,750 ms，窗口要到 3,750 ms 之後才只剩忙的。
        assert_eq!(first_busy(&shares), Some(3_750));
        assert_eq!(first_busy(&[(0.85, Some(0.85)); 20]), None);
    }

    #[test]
    fn reads_this_process() {
        let me = std::process::id() as libc::pid_t;
        assert!(cpu_time(me, ticks_per_second()).is_some());
        assert!(cpu_time(-1, 100).is_none());
        assert!(runnable_time(-1).is_none());
    }
}
