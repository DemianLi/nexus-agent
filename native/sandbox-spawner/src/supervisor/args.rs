//! 監督行程的命令列。

use std::ffi::OsString;
use std::path::PathBuf;
use super::cpu::Config;
use std::time::Duration;

pub const USAGE: &str = "nexus-supervisor --run-dir <目錄> --audit <檔> --front <程式> [--front-arg <參數>]... \
--conversation <程式> [--conversation-arg <參數>]... [--eof-grace-ms <毫秒>] [--term-grace-ms <毫秒>] [--front-restart-ms <毫秒>] \
[--rss-limit-mb <MiB>] [--rss-poll-ms <毫秒>] [--stall-ms <毫秒>] [--capacity <條>] [--warm <個>] [--idle-ms <毫秒>] \
[--read-only-idle-ms <毫秒>] [--drain-timeout-ms <毫秒>] [--stats-ms <毫秒>] [--throttle-ms <毫秒>] [--throttle-run-ms <毫秒>] \
[--throttle-stop-ms <毫秒>] [--admission-timeout-ms <毫秒>] [--host <程式> [--host-arg <參數>]... [--host-backoff-ms <毫秒>] \
[--host-backoff-max-ms <毫秒>] [--host-start-failures <次>] [--host-stable-ms <毫秒>] [--host-ready-timeout-ms <毫秒>]]";

/// stdin EOF 之後等多久才送 SIGTERM。
pub const DEFAULT_EOF_GRACE: Duration = Duration::from_millis(6_000);
/// SIGTERM 之後等多久才送 SIGKILL。
pub const DEFAULT_TERM_GRACE: Duration = Duration::from_millis(3_000);
/// 前台結束後隔多久重起。
pub const DEFAULT_FRONT_RESTART: Duration = Duration::from_millis(1_000);
/// 多久讀一次對話行程的 RSS。
pub const DEFAULT_RSS_POLL: Duration = Duration::from_millis(250);
/// 送出 `bind` 之後多久沒聽到對話行程任何一則回報，就判 `stalled`。
pub const DEFAULT_STALL: Duration = Duration::from_millis(15_000);
/// 沉默多久才看要不要壓住吃滿 CPU 的對話行程（[`super::cpu`]）。
pub const DEFAULT_THROTTLE: Duration = Duration::from_millis(2_000);
/// 壓住時每一輪放它跑多久。
pub const DEFAULT_THROTTLE_RUN: Duration = Duration::from_millis(25);
/// 壓住時每一輪停它多久。
pub const DEFAULT_THROTTLE_STOP: Duration = Duration::from_millis(75);
/// 預熱池的大小（設計 §7-4）。
pub const DEFAULT_WARM: u32 = 1;
/// 一般對話行程閒置多久就逐出（設計 §7-2）。
pub const DEFAULT_IDLE: Duration = Duration::from_millis(2 * 60 * 60 * 1000);
/// 只讀開啟的對話行程閒置多久就逐出（設計 §7-3）。
pub const DEFAULT_READ_ONLY_IDLE: Duration = Duration::from_millis(5 * 60 * 1000);
/// 送出 `drain` 之後等回答多久。
pub const DEFAULT_DRAIN_TIMEOUT: Duration = Duration::from_millis(5_000);
/// 多久給前台一次 `stats`。
pub const DEFAULT_STATS: Duration = Duration::from_millis(10_000);
/// 停機時等前台回「已停准入」多久。
pub const DEFAULT_ADMISSION_TIMEOUT: Duration = Duration::from_millis(5_000);
/// 宿主結束後第一次重起前等多久；之後每次加倍，到 [`DEFAULT_HOST_BACKOFF_MAX`] 為止。
pub const DEFAULT_HOST_BACKOFF: Duration = Duration::from_millis(1_000);
pub const DEFAULT_HOST_BACKOFF_MAX: Duration = Duration::from_millis(30_000);
/// 宿主在 `ready` 之前連續失敗幾次，整台以非 0 結束。
pub const DEFAULT_HOST_START_FAILURES: u32 = 5;
/// 宿主活過這麼久才結束，下一次重起的等待回到 [`DEFAULT_HOST_BACKOFF`]。
pub const DEFAULT_HOST_STABLE: Duration = Duration::from_millis(60_000);
/// 宿主起了這麼久還沒 `ready`，當它起不來：殺掉，算一次 `ready` 之前的失敗。
pub const DEFAULT_HOST_READY_TIMEOUT: Duration = Duration::from_millis(30_000);

/// 宿主（#2569）：第三種子行程，整台一個。argv 是 `<程式> <--host-arg>... --socket <--run-dir>/host.sock`。
#[derive(Debug, PartialEq, Eq)]
pub struct HostArgs {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub backoff: Duration,
    pub backoff_max: Duration,
    /// `ready` 之前連續失敗到這個次數，整台結束。`ready` 之後的失敗不算，一律照退避重起。
    pub start_failures: u32,
    pub stable: Duration,
    pub ready_timeout: Duration,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Args {
    /// 對話行程的 socket 放這裡；監督行程建它（0700），已存在就要是自己的、0700；也不能長到 socket 路徑放不進 `sun_path`（108 bytes）。
    pub run_dir: PathBuf,
    /// 稽核紀錄（JSONL，只追加）。
    pub audit: PathBuf,
    pub front: OsString,
    pub front_args: Vec<OsString>,
    /// 對話行程的 argv 是 `<程式> <--conversation-arg>... --socket <路徑>`；有給 `--host` 時再加 `--host-socket <--run-dir>/host.sock`。
    pub conversation: OsString,
    pub conversation_args: Vec<OsString>,
    pub eof_grace: Duration,
    pub term_grace: Duration,
    pub front_restart: Duration,
    /// 對話行程（leader）的 RSS 超過這個值（kB）就 SIGKILL 它的群組，死因 `memory`（已經在收的照原本的理由）。沒給就不殺，只把最高值記進稽核。
    pub rss_limit_kb: Option<u64>,
    pub rss_poll: Duration,
    /// 送出 `bind` 之後多久沒聽到對話行程任何一則回報，就當場對它的群組送 SIGKILL（不走拆除梯度），死因 `stalled`。`None`（`--stall-ms 0`）是不判。
    pub stall: Option<Duration>,
    /// 同時活著的對話行程（含預熱池、起動中與正在收的）最多幾個。沒給就照記憶體上限算（[`super::memory::auto_capacity`]）。
    pub capacity: Option<u32>,
    /// 預熱池的大小，可以是 0。池裡的算進容量。
    pub warm: u32,
    /// 一般對話行程閒置這麼久就送 `drain`。`None`（`--idle-ms 0`）是不照時間逐出。
    pub idle: Option<Duration>,
    /// 只讀開啟的對話行程閒置這麼久就送 `drain`。`None` 是不照時間逐出。
    pub read_only_idle: Option<Duration>,
    /// 送出 `drain` 之後這麼久沒回答，就當它不閒置、不收。
    pub drain_timeout: Duration,
    /// 每隔這麼久給前台一次 `stats`。`None` 是不送。
    pub stats: Option<Duration>,
    /// 壓住吃滿 CPU 的對話行程（[`super::cpu`]）。`None`（`--throttle-ms 0`）是不壓。
    pub throttle: Option<Config>,
    /// 停機時送前台 `stop-admission`，等它回答最多這麼久，才開始收對話行程。
    pub admission_timeout: Duration,
    /// 沒給 `--host` 就不起宿主。
    pub host: Option<HostArgs>,
}

pub fn parse(args: &[OsString]) -> Result<Args, String> {
    let mut run_dir = None;
    let mut audit = None;
    let mut front = None;
    let mut front_args = Vec::new();
    let mut conversation = None;
    let mut conversation_args = Vec::new();
    let mut eof_grace = DEFAULT_EOF_GRACE;
    let mut term_grace = DEFAULT_TERM_GRACE;
    let mut front_restart = DEFAULT_FRONT_RESTART;
    let mut rss_limit_kb = None;
    let mut rss_poll = DEFAULT_RSS_POLL;
    let mut stall = Some(DEFAULT_STALL);
    let mut capacity = None;
    let mut warm = DEFAULT_WARM;
    let mut idle = Some(DEFAULT_IDLE);
    let mut read_only_idle = Some(DEFAULT_READ_ONLY_IDLE);
    let mut drain_timeout = DEFAULT_DRAIN_TIMEOUT;
    let mut stats = Some(DEFAULT_STATS);
    let mut throttle = Some(DEFAULT_THROTTLE);
    let mut throttle_run = DEFAULT_THROTTLE_RUN;
    let mut throttle_stop = DEFAULT_THROTTLE_STOP;
    let mut admission_timeout = DEFAULT_ADMISSION_TIMEOUT;
    let mut host = None;
    let mut host_args = Vec::new();
    let mut host_backoff = DEFAULT_HOST_BACKOFF;
    let mut host_backoff_max = DEFAULT_HOST_BACKOFF_MAX;
    let mut host_start_failures = DEFAULT_HOST_START_FAILURES;
    let mut host_stable = DEFAULT_HOST_STABLE;
    let mut host_ready_timeout = DEFAULT_HOST_READY_TIMEOUT;
    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let flag = flag.to_str().ok_or_else(|| format!("看不懂的參數 {flag:?}"))?;
        let mut value = || it.next().cloned().ok_or_else(|| format!("{flag} 少了值"));
        match flag {
            "--run-dir" => run_dir = Some(PathBuf::from(value()?)),
            "--audit" => audit = Some(PathBuf::from(value()?)),
            "--front" => front = Some(value()?),
            "--front-arg" => front_args.push(value()?),
            "--conversation" => conversation = Some(value()?),
            "--conversation-arg" => conversation_args.push(value()?),
            "--eof-grace-ms" => eof_grace = millis(flag, value()?)?,
            "--term-grace-ms" => term_grace = millis(flag, value()?)?,
            "--front-restart-ms" => front_restart = millis(flag, value()?)?,
            "--rss-limit-mb" => rss_limit_kb = Some(positive(flag, value()?)?.saturating_mul(1024)),
            "--rss-poll-ms" => rss_poll = Duration::from_millis(positive(flag, value()?)?),
            "--stall-ms" => stall = Some(millis(flag, value()?)?).filter(|d| !d.is_zero()),
            "--capacity" => capacity = Some(Some(count(flag, value()?)?).filter(|&n| n > 0).ok_or(format!("{flag} 要正整數"))?),
            "--warm" => warm = count(flag, value()?)?,
            "--idle-ms" => idle = Some(millis(flag, value()?)?).filter(|d| !d.is_zero()),
            "--read-only-idle-ms" => read_only_idle = Some(millis(flag, value()?)?).filter(|d| !d.is_zero()),
            "--drain-timeout-ms" => drain_timeout = Duration::from_millis(positive(flag, value()?)?),
            "--stats-ms" => stats = Some(millis(flag, value()?)?).filter(|d| !d.is_zero()),
            "--throttle-ms" => throttle = Some(millis(flag, value()?)?).filter(|d| !d.is_zero()),
            "--throttle-run-ms" => throttle_run = Duration::from_millis(positive(flag, value()?)?),
            "--throttle-stop-ms" => throttle_stop = Duration::from_millis(positive(flag, value()?)?),
            "--admission-timeout-ms" => admission_timeout = millis(flag, value()?)?,
            "--host" => host = Some(value()?),
            "--host-arg" => host_args.push(value()?),
            "--host-backoff-ms" => host_backoff = Duration::from_millis(positive(flag, value()?)?),
            "--host-backoff-max-ms" => host_backoff_max = Duration::from_millis(positive(flag, value()?)?),
            "--host-start-failures" => {
                host_start_failures = Some(count(flag, value()?)?).filter(|&n| n > 0).ok_or(format!("{flag} 要正整數"))?
            }
            "--host-stable-ms" => host_stable = Duration::from_millis(positive(flag, value()?)?),
            "--host-ready-timeout-ms" => host_ready_timeout = Duration::from_millis(positive(flag, value()?)?),
            _ => return Err(format!("不認得的參數 {flag}")),
        }
    }
    Ok(Args {
        run_dir: run_dir.ok_or("缺 --run-dir")?,
        audit: audit.ok_or("缺 --audit")?,
        front: front.ok_or("缺 --front")?,
        front_args,
        conversation: conversation.ok_or("缺 --conversation")?,
        conversation_args,
        eof_grace,
        term_grace,
        front_restart,
        rss_limit_kb,
        rss_poll,
        stall,
        capacity,
        warm,
        idle,
        read_only_idle,
        drain_timeout,
        stats,
        throttle: throttle.map(|after| Config { after, run: throttle_run, stop: throttle_stop }),
        admission_timeout,
        host: match host {
            Some(program) => Some(HostArgs {
                program,
                args: host_args,
                backoff: host_backoff,
                backoff_max: host_backoff_max.max(host_backoff),
                start_failures: host_start_failures,
                stable: host_stable,
                ready_timeout: host_ready_timeout,
            }),
            None if !host_args.is_empty() => return Err("--host-arg 要配 --host".into()),
            None => None,
        },
    })
}

fn positive(flag: &str, value: OsString) -> Result<u64, String> {
    value
        .to_str()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&n| n > 0)
        .ok_or_else(|| format!("{flag} 要正整數，拿到 {value:?}"))
}

fn count(flag: &str, value: OsString) -> Result<u32, String> {
    value.to_str().and_then(|v| v.parse::<u32>().ok()).ok_or_else(|| format!("{flag} 要整數，拿到 {value:?}"))
}

fn millis(flag: &str, value: OsString) -> Result<Duration, String> {
    value
        .to_str()
        .and_then(|v| v.parse::<u64>().ok())
        .map(Duration::from_millis)
        .ok_or_else(|| format!("{flag} 要毫秒數，拿到 {value:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn os(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_required_and_repeated_flags() {
        let args = parse(&os(&[
            "--run-dir", "/r", "--audit", "/a.jsonl", "--front", "node", "--front-arg", "front.js", "--front-arg", "--x",
            "--conversation", "node", "--conversation-arg", "conv.js", "--term-grace-ms", "50",
        ]))
        .unwrap();
        assert_eq!(args.run_dir, PathBuf::from("/r"));
        assert_eq!(args.front_args, os(&["front.js", "--x"]));
        assert_eq!(args.conversation_args, os(&["conv.js"]));
        assert_eq!(args.eof_grace, DEFAULT_EOF_GRACE);
        assert_eq!(args.term_grace, Duration::from_millis(50));
        assert_eq!(args.front_restart, DEFAULT_FRONT_RESTART);
        assert_eq!(args.rss_limit_kb, None);
        assert_eq!(args.rss_poll, DEFAULT_RSS_POLL);
        assert_eq!(args.stall, Some(DEFAULT_STALL));
        assert_eq!(args.capacity, None);
        assert_eq!(args.warm, DEFAULT_WARM);
        assert_eq!(args.idle, Some(DEFAULT_IDLE));
        assert_eq!(args.read_only_idle, Some(DEFAULT_READ_ONLY_IDLE));
        assert_eq!(args.drain_timeout, DEFAULT_DRAIN_TIMEOUT);
        assert_eq!(args.stats, Some(DEFAULT_STATS));
        assert_eq!(
            args.throttle,
            Some(Config { after: DEFAULT_THROTTLE, run: DEFAULT_THROTTLE_RUN, stop: DEFAULT_THROTTLE_STOP })
        );
    }

    #[test]
    fn throttle_flags() {
        let base = ["--run-dir", "/r", "--audit", "/a", "--front", "f", "--conversation", "c"];
        let mut items = base.to_vec();
        items.extend(["--throttle-ms", "300", "--throttle-run-ms", "10", "--throttle-stop-ms", "40"]);
        let args = parse(&os(&items)).unwrap();
        assert_eq!(
            args.throttle,
            Some(Config { after: Duration::from_millis(300), run: Duration::from_millis(10), stop: Duration::from_millis(40) })
        );
        let mut items = base.to_vec();
        items.extend(["--throttle-ms", "0"]);
        assert_eq!(parse(&os(&items)).unwrap().throttle, None);
        for bad in [["--throttle-run-ms", "0"], ["--throttle-stop-ms", "0"], ["--throttle-ms", "x"]] {
            let mut items = base.to_vec();
            items.extend(bad);
            assert!(parse(&os(&items)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn capacity_warm_and_eviction_flags() {
        let base = ["--run-dir", "/r", "--audit", "/a", "--front", "f", "--conversation", "c"];
        let mut items = base.to_vec();
        items.extend(["--capacity", "3", "--warm", "0", "--idle-ms", "0", "--read-only-idle-ms", "40", "--drain-timeout-ms", "70", "--stats-ms", "0"]);
        let args = parse(&os(&items)).unwrap();
        assert_eq!(args.capacity, Some(3));
        assert_eq!(args.warm, 0);
        assert_eq!(args.idle, None);
        assert_eq!(args.read_only_idle, Some(Duration::from_millis(40)));
        assert_eq!(args.drain_timeout, Duration::from_millis(70));
        assert_eq!(args.stats, None);
        for bad in [["--capacity", "0"], ["--capacity", "-1"], ["--warm", "x"], ["--drain-timeout-ms", "0"]] {
            let mut items = base.to_vec();
            items.extend(bad);
            assert!(parse(&os(&items)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn host_flags() {
        let base = ["--run-dir", "/r", "--audit", "/a", "--front", "f", "--conversation", "c"];
        let args = parse(&os(&base)).unwrap();
        assert_eq!(args.host, None);
        assert_eq!(args.admission_timeout, DEFAULT_ADMISSION_TIMEOUT);
        let mut items = base.to_vec();
        items.extend(["--host", "h", "--host-arg", "x"]);
        let host = parse(&os(&items)).unwrap().host.unwrap();
        assert_eq!(
            host,
            HostArgs {
                program: "h".into(),
                args: os(&["x"]),
                backoff: DEFAULT_HOST_BACKOFF,
                backoff_max: DEFAULT_HOST_BACKOFF_MAX,
                start_failures: DEFAULT_HOST_START_FAILURES,
                stable: DEFAULT_HOST_STABLE,
                ready_timeout: DEFAULT_HOST_READY_TIMEOUT,
            }
        );
        let mut items = base.to_vec();
        items.extend([
            "--host", "h", "--host-backoff-ms", "50", "--host-backoff-max-ms", "20", "--host-start-failures", "2",
            "--host-stable-ms", "300", "--host-ready-timeout-ms", "400", "--admission-timeout-ms", "0",
        ]);
        let args = parse(&os(&items)).unwrap();
        assert_eq!(args.admission_timeout, Duration::ZERO);
        let host = args.host.unwrap();
        assert_eq!(host.backoff, Duration::from_millis(50));
        // 上限比起始小時取起始。
        assert_eq!(host.backoff_max, Duration::from_millis(50));
        assert_eq!(host.start_failures, 2);
        assert_eq!(host.stable, Duration::from_millis(300));
        assert_eq!(host.ready_timeout, Duration::from_millis(400));
        for bad in [["--host-start-failures", "0"], ["--host-backoff-ms", "0"], ["--host-arg", "x"]] {
            let mut items = base.to_vec();
            items.extend(bad);
            assert!(parse(&os(&items)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn zero_turns_stall_off() {
        let base = ["--run-dir", "/r", "--audit", "/a", "--front", "f", "--conversation", "c"];
        let mut items = base.to_vec();
        items.extend(["--stall-ms", "0"]);
        assert_eq!(parse(&os(&items)).unwrap().stall, None);
        let mut items = base.to_vec();
        items.extend(["--stall-ms", "300"]);
        assert_eq!(parse(&os(&items)).unwrap().stall, Some(Duration::from_millis(300)));
    }

    #[test]
    fn rss_limit_is_mib_and_must_be_positive() {
        let base = ["--run-dir", "/r", "--audit", "/a", "--front", "f", "--conversation", "c"];
        let mut items = base.to_vec();
        items.extend(["--rss-limit-mb", "512", "--rss-poll-ms", "100"]);
        let args = parse(&os(&items)).unwrap();
        assert_eq!(args.rss_limit_kb, Some(512 * 1024));
        assert_eq!(args.rss_poll, Duration::from_millis(100));
        for bad in [["--rss-limit-mb", "0"], ["--rss-poll-ms", "0"], ["--rss-limit-mb", "big"]] {
            let mut items = base.to_vec();
            items.extend(bad);
            assert!(parse(&os(&items)).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn rejects_missing_unknown_and_bad_values() {
        let base = ["--run-dir", "/r", "--audit", "/a", "--front", "f", "--conversation", "c"];
        assert!(parse(&os(&base)).is_ok());
        for drop in [0, 2, 4, 6] {
            let mut items = base.to_vec();
            items.drain(drop..drop + 2);
            assert!(parse(&os(&items)).is_err(), "少了 {}", base[drop]);
        }
        let mut unknown = base.to_vec();
        unknown.push("--nope");
        assert!(parse(&os(&unknown)).unwrap_err().contains("--nope"));
        let mut bad = base.to_vec();
        bad.extend(["--eof-grace-ms", "soon"]);
        assert!(parse(&os(&bad)).is_err());
        let mut dangling = base.to_vec();
        dangling.push("--front-arg");
        assert!(parse(&os(&dangling)).unwrap_err().contains("少了值"));
    }
}
