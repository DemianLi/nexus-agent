//! 壓住失控吃 CPU 的對話行程：已經 `up`、沒在收、沒在等 `drain` 回答、沉默滿 `--throttle-ms`，而且 leader 這段時間一直要 CPU 的，交替送 SIGSTOP／SIGCONT，
//! 每 `--throttle-run-ms`＋`--throttle-stop-ms` 只放它跑前一段。聽到它的任何一框就當場 SIGCONT、解除。
//!
//! 「一直要 CPU」看 leader 的 `/proc/<pid>/schedstat`：在 CPU 上的時間加上在可執行佇列上等的時間，平均每秒至少 [`BUSY`] 秒。只看 utime 的話，
//! 搶不到 CPU 的空轉會被看成不忙；同步等子行程或 I/O（`execSync`）的事件迴圈睡著，兩樣都不長，不會被壓。讀不到 schedstat 就不壓。
//!
//! 壓住期間 `stalled` 只算放它跑的時間（[`Guard::silence`]）：被壓的行程能不能在 `--stall-ms` 內再出聲，跟沒被壓時一樣看它自己。代價是
//! 真的卡死的那條要多活一陣子才被殺，這段期間它只拿到 run／(run＋stop) 的 CPU。
//!
//! 訊號只送 leader，不送整個群組：leader 有 `PR_SET_PDEATHSIG`，監督行程死了它跟著死；群組裡其他行程沒有，停住後沒人送 SIGCONT 就會一直停著。

use std::time::{Duration, Instant};

/// leader 平均每秒在 CPU 上加上等 CPU 的時間至少這麼多秒，才算一直要 CPU。
pub const BUSY: f64 = 0.9;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// 沉默多久才看要不要壓。
    pub after: Duration,
    /// 每一輪放它跑多久。
    pub run: Duration,
    /// 每一輪停它多久。
    pub stop: Duration,
}

/// 要對 leader 送的訊號。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Signal {
    Stop,
    Cont,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hold {
    /// 停住了，到 `until` 放；`since` 是這一段停住時間的起算點（[`Guard::restart`] 會改）。
    Stopped { since: Instant, until: Instant },
    /// 放它跑，到 `until` 再停。
    Running { until: Instant },
}

/// 一條對話行程的壓制狀態。沉默從「最後一次聽到它」算，由呼叫端傳進來。
#[derive(Debug, Default)]
pub struct Guard {
    /// 這段沉默裡 schedstat 的第一筆與最新一筆：(時間, run＋wait 奈秒)。
    first: Option<(Instant, u64)>,
    last: Option<(Instant, u64)>,
    hold: Option<Hold>,
    /// 這段沉默裡已經結束的停住時間加總（正在停的那一段不算在內）。
    paused: Duration,
}

impl Guard {
    /// 壓制中（停住或放它跑的那一段都算）。
    pub fn holding(&self) -> bool {
        self.hold.is_some()
    }

    fn stopped(&self) -> bool {
        matches!(self.hold, Some(Hold::Stopped { .. }))
    }

    /// 聽到它了：沉默重新起算，解除壓制。回 `true` 時它正停著，要送 SIGCONT。
    pub fn heard(&mut self) -> bool {
        let stopped = self.stopped();
        *self = Guard::default();
        stopped
    }

    /// 沉默從 `now` 重新起算（監督行程自己停住過，見 `Supervisor::check_resumed`）。壓制照舊，正在停的那一段從 `now` 起算。
    pub fn restart(&mut self, now: Instant) {
        self.first = None;
        self.last = None;
        self.paused = Duration::ZERO;
        if let Some(Hold::Stopped { until, .. }) = self.hold {
            self.hold = Some(Hold::Stopped { since: now, until });
        }
    }

    /// 要收它了（拆除梯度、送 `drain`）：解除壓制，停住的時間照樣不算沉默；取樣重來，`drain` 沒收成時不拿壓制前的取樣算。
    /// 回 `true` 時它正停著，要送 SIGCONT。
    pub fn release(&mut self, now: Instant) -> bool {
        self.first = None;
        self.last = None;
        match self.hold.take() {
            Some(Hold::Stopped { since, .. }) => {
                self.paused += now.saturating_duration_since(since);
                true
            }
            _ => false,
        }
    }

    /// 記一筆 leader 的 schedstat（run＋wait，奈秒）。壓制中不記：停住的行程不在佇列上，量到的不是它想要多少。
    pub fn sample(&mut self, now: Instant, demand_ns: u64) {
        if self.hold.is_some() {
            return;
        }
        self.first.get_or_insert((now, demand_ns));
        self.last = Some((now, demand_ns));
    }

    /// 這段沉默裡 leader 平均每秒要了幾秒 CPU。兩筆取樣隔不到 `after` 的一半時，量的時間太短，回 `None`。
    fn demand(&self, after: Duration) -> Option<f64> {
        let ((t0, d0), (t1, d1)) = (self.first?, self.last?);
        let span = t1.saturating_duration_since(t0);
        (span >= after / 2 && !span.is_zero())
            .then(|| d1.saturating_sub(d0) as f64 / 1e9 / span.as_secs_f64())
    }

    /// 扣掉停住的時間之後，`heard_at` 起沉默了多久。
    pub fn silence(&self, now: Instant, heard_at: Instant) -> Duration {
        let ongoing = match self.hold {
            Some(Hold::Stopped { since, .. }) => now.saturating_duration_since(since),
            _ => Duration::ZERO,
        };
        now.saturating_duration_since(heard_at)
            .saturating_sub(self.paused + ongoing)
    }

    /// 照沉默算，最早什麼時候會滿 `stall`。停住的時候不會滿（放它跑的時候才算），回 `None`，由 [`Self::deadline`] 叫醒。
    pub fn stall_at(&self, heard_at: Instant, stall: Duration) -> Option<Instant> {
        (!self.stopped()).then(|| heard_at + stall + self.paused)
    }

    /// 下一次切換的時間；沒在壓是 `None`。
    pub fn deadline(&self) -> Option<Instant> {
        match self.hold? {
            Hold::Stopped { until, .. } | Hold::Running { until } => Some(until),
        }
    }

    /// 該做的事：沒在壓而條件成立就開始停；在壓的照時間切換。回要送的訊號。
    pub fn tick(&mut self, now: Instant, heard_at: Instant, config: Config) -> Option<Signal> {
        match self.hold {
            None => {
                let silent = now.saturating_duration_since(heard_at) >= config.after;
                if silent
                    && self
                        .demand(config.after)
                        .is_some_and(|demand| demand >= BUSY)
                {
                    self.hold = Some(Hold::Stopped {
                        since: now,
                        until: now + config.stop,
                    });
                    return Some(Signal::Stop);
                }
                None
            }
            Some(Hold::Stopped { since, until }) if until <= now => {
                self.paused += now.saturating_duration_since(since);
                self.hold = Some(Hold::Running {
                    until: now + config.run,
                });
                Some(Signal::Cont)
            }
            Some(Hold::Running { until }) if until <= now => {
                self.hold = Some(Hold::Stopped {
                    since: now,
                    until: now + config.stop,
                });
                Some(Signal::Stop)
            }
            Some(_) => None,
        }
    }
}

/// 讀 leader 的 `/proc/<pid>/schedstat`：在 CPU 上的時間加上在可執行佇列上等的時間（奈秒）。只算 leader 的主執行緒（事件迴圈），不含它的其他執行緒，所以每秒最多長 1 秒。讀不到（行程沒了、核心沒開 schedstat）回 `None`。
pub fn demand_ns(pid: libc::pid_t) -> Option<u64> {
    let text = std::fs::read_to_string(format!("/proc/{pid}/schedstat")).ok()?;
    let mut fields = text
        .split_whitespace()
        .map(|field| field.parse::<u64>().ok());
    Some(fields.next()??.saturating_add(fields.next()??))
}

/// 只送給 leader，理由見模組說明。錯一律不理。
pub fn signal(pid: libc::pid_t, signal: Signal) {
    let signo = match signal {
        Signal::Stop => libc::SIGSTOP,
        Signal::Cont => libc::SIGCONT,
    };
    // SAFETY：只送訊號。leader 收屍之前它的 pid 不會被別人拿去用，見 `process::reap`。
    unsafe { libc::kill(pid, signo) };
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);
    const CONFIG: Config = Config {
        after: Duration::from_millis(2_000),
        run: Duration::from_millis(25),
        stop: Duration::from_millis(75),
    };

    /// 從 `heard_at` 起每 250 ms 取樣一次，每秒要 `rate` 秒 CPU，取樣到 `until`。
    fn feed(guard: &mut Guard, heard_at: Instant, rate: f64, until: Duration) {
        let mut at = Duration::ZERO;
        while at <= until {
            guard.sample(heard_at + at, (at.as_secs_f64() * rate * 1e9) as u64);
            at += 250 * MS;
        }
    }

    #[test]
    fn a_silent_leader_that_keeps_wanting_the_cpu_is_stopped() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 2_000 * MS);
        assert_eq!(guard.tick(t + 2_000 * MS, t, CONFIG), Some(Signal::Stop));
        assert!(guard.stopped());
    }

    #[test]
    fn waiting_on_the_cpu_counts_as_wanting_it() {
        // 搶不到 CPU：在 CPU 上 0.3、等 0.65，合計 0.95。
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 0.95, 2_000 * MS);
        assert_eq!(guard.tick(t + 2_000 * MS, t, CONFIG), Some(Signal::Stop));
    }

    #[test]
    fn a_silent_leader_that_sleeps_is_not_stopped() {
        // execSync、同步 I/O：事件迴圈卡著，但 leader 在睡。
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 0.0, 5_000 * MS);
        assert_eq!(guard.tick(t + 5_000 * MS, t, CONFIG), None);
        assert!(!guard.holding());
    }

    #[test]
    fn a_leader_just_under_the_threshold_is_not_stopped() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 0.85, 4_000 * MS);
        assert_eq!(guard.tick(t + 4_000 * MS, t, CONFIG), None);
    }

    #[test]
    fn busy_but_not_yet_silent_long_enough_is_not_stopped() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 1_750 * MS);
        assert_eq!(guard.tick(t + 1_999 * MS, t, CONFIG), None);
    }

    #[test]
    fn too_short_a_sample_span_is_not_judged() {
        // 只有最後半秒內的取樣（例如剛起取樣），量的時間不夠，不判。
        let t = Instant::now();
        let mut guard = Guard::default();
        guard.sample(t + 1_600 * MS, 0);
        guard.sample(t + 2_000 * MS, 400_000_000);
        assert_eq!(guard.tick(t + 2_000 * MS, t, CONFIG), None);
    }

    #[test]
    fn unreadable_schedstat_never_stops() {
        let t = Instant::now();
        let mut guard = Guard::default();
        assert_eq!(guard.tick(t + 60_000 * MS, t, CONFIG), None);
    }

    #[test]
    fn stop_and_cont_alternate_on_schedule() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 2_000 * MS);
        let s = t + 2_000 * MS;
        assert_eq!(guard.tick(s, t, CONFIG), Some(Signal::Stop));
        assert_eq!(guard.tick(s + 74 * MS, t, CONFIG), None);
        assert_eq!(guard.deadline(), Some(s + 75 * MS));
        assert_eq!(guard.tick(s + 75 * MS, t, CONFIG), Some(Signal::Cont));
        assert!(!guard.stopped() && guard.holding());
        assert_eq!(guard.deadline(), Some(s + 100 * MS));
        assert_eq!(guard.tick(s + 99 * MS, t, CONFIG), None);
        assert_eq!(guard.tick(s + 100 * MS, t, CONFIG), Some(Signal::Stop));
        assert_eq!(guard.deadline(), Some(s + 175 * MS));
    }

    #[test]
    fn samples_while_holding_are_ignored() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 2_000 * MS);
        guard.tick(t + 2_000 * MS, t, CONFIG);
        let last = guard.last;
        guard.sample(t + 2_250 * MS, 0);
        assert_eq!(guard.last, last);
    }

    #[test]
    fn hearing_it_while_stopped_asks_for_cont_and_clears_everything() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 2_000 * MS);
        guard.tick(t + 2_000 * MS, t, CONFIG);
        assert!(guard.heard());
        assert!(!guard.holding());
        assert_eq!(guard.first, None);
        assert_eq!(guard.paused, Duration::ZERO);
        assert!(!guard.heard());
    }

    #[test]
    fn hearing_it_while_running_needs_no_signal() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 2_000 * MS);
        guard.tick(t + 2_000 * MS, t, CONFIG);
        guard.tick(t + 2_075 * MS, t, CONFIG);
        assert!(!guard.heard());
        assert!(!guard.holding());
    }

    #[test]
    fn release_conts_only_when_stopped() {
        let t = Instant::now();
        let mut guard = Guard::default();
        assert!(!guard.release(t));
        feed(&mut guard, t, 1.0, 2_000 * MS);
        let s = t + 2_000 * MS;
        guard.tick(s, t, CONFIG);
        assert!(guard.release(s + 50 * MS));
        assert!(!guard.holding());
        // 放開之前停住的那 50 ms 照樣不算沉默。
        assert_eq!(guard.silence(s + 50 * MS, t), 2_000 * MS);
        assert!(!guard.release(s + 60 * MS));
        // 放開之後取樣重來：不拿壓制前的取樣再判一次。
        assert_eq!(guard.tick(s + 60 * MS, t, CONFIG), None);
    }

    #[test]
    fn silence_only_counts_time_it_was_let_run() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 2_000 * MS);
        let s = t + 2_000 * MS;
        guard.tick(s, t, CONFIG);
        // 正在停的那一段不算。
        assert_eq!(guard.silence(s + 50 * MS, t), 2_000 * MS);
        guard.tick(s + 75 * MS, t, CONFIG);
        assert_eq!(guard.silence(s + 75 * MS, t), 2_000 * MS);
        assert_eq!(guard.silence(s + 100 * MS, t), 2_025 * MS);
        guard.tick(s + 100 * MS, t, CONFIG);
        guard.tick(s + 175 * MS, t, CONFIG);
        assert_eq!(guard.silence(s + 175 * MS, t), 2_025 * MS);
    }

    #[test]
    fn stall_deadline_moves_out_by_the_paused_time() {
        let t = Instant::now();
        let stall = 15_000 * MS;
        let mut guard = Guard::default();
        assert_eq!(guard.stall_at(t, stall), Some(t + stall));
        feed(&mut guard, t, 1.0, 2_000 * MS);
        let s = t + 2_000 * MS;
        guard.tick(s, t, CONFIG);
        assert_eq!(guard.stall_at(t, stall), None);
        guard.tick(s + 75 * MS, t, CONFIG);
        assert_eq!(guard.stall_at(t, stall), Some(t + stall + 75 * MS));
    }

    #[test]
    fn a_stuck_leader_is_stalled_after_stall_of_run_time() {
        // 卡死的那條：放它跑的時間累計到 stall 才滿。2 s 之後只有 25／100 的時間在算。
        let t = Instant::now();
        let stall = 15_000 * MS;
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 2_000 * MS);
        let mut now = t + 2_000 * MS;
        loop {
            guard.tick(now, t, CONFIG);
            if guard.silence(now, t) >= stall {
                break;
            }
            now = guard
                .deadline()
                .unwrap()
                .min(guard.stall_at(t, stall).unwrap_or(now + 1_000_000 * MS));
        }
        assert_eq!(now - t, 2_000 * MS + 13_000 * MS * 4);
    }

    #[test]
    fn restart_drops_samples_and_paused_time_but_keeps_holding() {
        let t = Instant::now();
        let mut guard = Guard::default();
        feed(&mut guard, t, 1.0, 2_000 * MS);
        guard.tick(t + 2_000 * MS, t, CONFIG);
        guard.tick(t + 2_075 * MS, t, CONFIG);
        guard.tick(t + 2_100 * MS, t, CONFIG);
        let r = t + 2_150 * MS;
        guard.restart(r);
        assert!(guard.stopped());
        assert_eq!(guard.first, None);
        assert_eq!(guard.silence(r, r), Duration::ZERO);
        assert_eq!(guard.silence(r + 25 * MS, r), Duration::ZERO);
    }

    #[test]
    fn schedstat_sums_run_and_wait() {
        assert_eq!(demand_ns(i32::MAX), None);
        let me = std::process::id() as libc::pid_t;
        if std::path::Path::new(&format!("/proc/{me}/schedstat")).exists() {
            assert!(demand_ns(me).is_some());
        }
    }
}
