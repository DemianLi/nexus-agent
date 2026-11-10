//! `nexus_host::mcp::supervisor`：退避、預算重置與訊息逐字照 `supervisor.ts`；再用假的一代跑 [`run`] 的連線、掉線、收不乾淨與 dispose。

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nexus_host::json::Value;
use nexus_host::mcp::supervisor::{
    run, Backoff, Hooks, Next, Policy, State, GENERATION_CLOSE_TIMEOUT,
};
use tokio::sync::{oneshot, watch, Notify};

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

#[test]
fn 退避加倍到上限_同一次中斷最多_max_attempts_次() {
    let mut backoff = Backoff::new(Policy::default(), "mcp:x");
    let now = Instant::now();
    let mut delays = Vec::new();
    for _ in 0..10 {
        match backoff.next(true, now) {
            Next::Retry { delay, .. } => delays.push(delay.as_millis()),
            Next::Stop { message } => panic!("{message}"),
        }
    }
    assert_eq!(
        delays,
        [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]
    );
    assert_eq!(
        backoff.next(true, now),
        Next::Stop {
            message: "mcp:x: giving up after 10 consecutive failed reconnect attempts — registered tools will fail until the plugin is assembled again".into()
        }
    );
}

#[test]
fn 訊息逐字() {
    let mut backoff = Backoff::new(Policy::default(), "mcp:x");
    let now = Instant::now();
    assert_eq!(
        backoff.next(true, now),
        Next::Retry {
            delay: ms(500),
            message: "mcp:x: connection lost; reconnecting in 500ms (attempt 1/10)".into()
        }
    );
    assert_eq!(
        backoff.next(false, now),
        Next::Retry {
            delay: ms(1000),
            message: "mcp:x: connection failed; retrying in 1000ms (attempt 2/10)".into()
        }
    );
    assert_eq!(
        backoff.connected(now),
        Some("mcp:x: reconnected (attempt 2/10)".into())
    );
    let mut off = Backoff::new(
        Policy {
            enabled: false,
            ..Policy::default()
        },
        "mcp:y",
    );
    assert_eq!(
        off.next(true, now),
        Next::Stop { message: "mcp:y: connection lost and reconnect is disabled — registered tools will fail until the plugin is assembled again".into() }
    );
    assert_eq!(
        off.next(false, now),
        Next::Stop { message: "mcp:y: connection failed and reconnect is disabled — no tools were registered; the next assembly connects again".into() }
    );
}

/// 照 `supervisor.ts` 的算式與 `String(n)` 的寫法：小數照寫，不截成整數毫秒。
#[test]
fn 小數毫秒的訊息照_ts() {
    let policy = |initial: f64, max: f64| Policy {
        initial_delay_ms: initial,
        max_delay_ms: max,
        ..Policy::default()
    };
    let now = Instant::now();
    for (initial, max, want) in [
        (1.5, 30_000.0, ["1.5ms", "3ms", "6ms"]),
        (0.1, 30_000.0, ["0.1ms", "0.2ms", "0.4ms"]),
        (0.3, 1000.0, ["0.3ms", "0.6ms", "1.2ms"]),
    ] {
        let mut backoff = Backoff::new(policy(initial, max), "mcp:x");
        for (n, want) in want.iter().enumerate() {
            let Next::Retry { message, .. } = backoff.next(false, now) else {
                panic!("不該放棄");
            };
            assert_eq!(
                message,
                format!(
                    "mcp:x: connection failed; retrying in {want} (attempt {}/10)",
                    n + 1
                )
            );
        }
    }
    let mut huge = Backoff::new(policy(1e300, 1e300), "mcp:x");
    assert!(matches!(huge.next(false, now), Next::Retry { delay, .. } if delay == Duration::MAX));
}

#[test]
fn 撐過_max_delay_才掉線_失敗次數歸零() {
    let mut backoff = Backoff::new(Policy::default(), "mcp:x");
    let start = Instant::now();
    for _ in 0..3 {
        backoff.next(true, start);
    }
    backoff.connected(start);
    // 不到上限就掉：接著算第 4 次。
    assert!(
        matches!(backoff.next(true, start + ms(29_999)), Next::Retry { delay, .. } if delay == ms(4000))
    );
    backoff.connected(start);
    // 撐過上限：歸零，從第 1 次算。
    assert!(
        matches!(backoff.next(true, start + ms(30_000)), Next::Retry { delay, .. } if delay == ms(500))
    );
}

#[test]
fn 政策解析() {
    let parse = |json: &str| Policy::parse(Some(&serde_json::from_str::<Value>(json).unwrap()));
    assert_eq!(Policy::parse(None), Ok(Policy::default()));
    assert_eq!(
        parse(r#"{"enabled":false,"initialDelayMs":10,"maxDelayMs":20.5,"maxAttempts":2}"#),
        Ok(Policy {
            enabled: false,
            initial_delay_ms: 10.0,
            max_delay_ms: 20.5,
            max_attempts: 2
        })
    );
    // zod 收的邊界：放不進 `Duration` 的毫秒、大於 2^32 的次數、2^53−1 的上限、寫成 `2.0` 的整數。
    for (json, want) in [
        (
            r#"{"initialDelayMs":1e300,"maxDelayMs":1e300}"#,
            Policy {
                initial_delay_ms: 1e300,
                max_delay_ms: 1e300,
                ..Policy::default()
            },
        ),
        (
            r#"{"maxAttempts":4294967296}"#,
            Policy {
                max_attempts: 1 << 32,
                ..Policy::default()
            },
        ),
        (
            r#"{"maxAttempts":9007199254740991}"#,
            Policy {
                max_attempts: (1 << 53) - 1,
                ..Policy::default()
            },
        ),
        (
            r#"{"maxAttempts":2.0}"#,
            Policy {
                max_attempts: 2,
                ..Policy::default()
            },
        ),
    ] {
        assert_eq!(parse(json), Ok(want), "{json}");
    }
    for (json, want) in [
        (
            r#"{"initialDelayMs":0}"#,
            "reconnect.initialDelayMs 要是正數（毫秒）",
        ),
        (
            r#"{"initialDelayMs":-1}"#,
            "reconnect.initialDelayMs 要是正數（毫秒）",
        ),
        (r#"{"maxAttempts":0}"#, "reconnect.maxAttempts 要是正整數"),
        (r#"{"maxAttempts":1.5}"#, "reconnect.maxAttempts 要是正整數"),
        (r#"{"maxAttempts":2.5}"#, "reconnect.maxAttempts 要是正整數"),
        (
            r#"{"maxAttempts":9007199254740992}"#,
            "reconnect.maxAttempts 要是正整數",
        ),
        (
            r#"{"maxAttempts":1e300}"#,
            "reconnect.maxAttempts 要是正整數",
        ),
        (
            r#"{"initialDelayMs":20,"maxDelayMs":10}"#,
            "initialDelayMs 不能大於 maxDelayMs",
        ),
        (r#"{"jitter":true}"#, "reconnect 不認得的欄位 jitter"),
    ] {
        assert_eq!(parse(json), Err(want.to_string()), "{json}");
    }
}

/// 假的一代：`down` 等 `drop_now` 被通知；`connect` 與 `close` 可以設成永遠不回。
#[derive(Clone, Default)]
struct Script {
    /// 每次 connect 的結果，照順序取；取完之後 `hang_connect` 是 `true` 就一直掛著，否則失敗。
    outcomes: Arc<Mutex<Vec<Result<(), String>>>>,
    hang_connect: Arc<Mutex<bool>>,
    /// 掛著的那次 connect 開始了。
    connecting: Arc<Notify>,
    /// 掛著的那次 connect 被丟下了。
    connect_dropped: Arc<AtomicBool>,
    /// connect 回來之前把 stop 設成 `true`：模擬連上的同時被 dispose。
    stop_on_connect: Arc<Mutex<Option<watch::Sender<bool>>>>,
    connects: Arc<AtomicUsize>,
    drop_now: Arc<Notify>,
    hang_close: Arc<Mutex<bool>>,
    log: Arc<Mutex<Vec<String>>>,
}

struct Fake(Script);

struct SetOnDrop(Arc<AtomicBool>);

impl Drop for SetOnDrop {
    fn drop(&mut self) {
        self.0.store(true, SeqCst);
    }
}

impl Hooks for Fake {
    type Generation = ();

    async fn connect(&mut self) -> Result<(), String> {
        self.0.connects.fetch_add(1, SeqCst);
        let next = {
            let mut outcomes = self.0.outcomes.lock().unwrap();
            (!outcomes.is_empty()).then(|| outcomes.remove(0))
        };
        let next = match next {
            Some(next) => next,
            None if *self.0.hang_connect.lock().unwrap() => {
                let _dropped = SetOnDrop(self.0.connect_dropped.clone());
                self.0.connecting.notify_one();
                std::future::pending::<()>().await;
                unreachable!()
            }
            None => Err("refused".to_string()),
        };
        if let Some(stop) = self.0.stop_on_connect.lock().unwrap().as_ref() {
            stop.send_replace(true);
        }
        next
    }

    fn adopted(&mut self, generation: u64, _: &()) {
        self.0
            .log
            .lock()
            .unwrap()
            .push(format!("adopted {generation}"));
    }

    async fn down(&mut self, _: &()) {
        self.0.drop_now.notified().await;
    }

    async fn close(&mut self, _: ()) {
        let hang = *self.0.hang_close.lock().unwrap();
        if hang {
            std::future::pending::<()>().await;
        }
        self.0.log.lock().unwrap().push("closed".into());
    }

    fn report(&mut self, message: &str) {
        self.0.log.lock().unwrap().push(message.to_string());
    }

    fn error(&mut self, message: &str) {
        self.0.log.lock().unwrap().push(format!("ERROR {message}"));
    }
}

fn fast() -> Policy {
    Policy {
        enabled: true,
        initial_delay_ms: 5.0,
        max_delay_ms: 20.0,
        max_attempts: 3,
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn 第一次失敗照退避重試_連上之後掉線再重連() {
    runtime().block_on(async {
        let script = Script::default();
        *script.outcomes.lock().unwrap() = vec![Err("boom".into()), Ok(()), Ok(())];
        let (first_tx, first_rx) = oneshot::channel();
        let (state_tx, mut state_rx) = watch::channel(State::Connecting);
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(run(
            Fake(script.clone()),
            fast(),
            "mcp:x".into(),
            true,
            first_tx,
            state_tx,
            stop_rx,
        ));
        assert_eq!(first_rx.await.unwrap(), Err("boom".into()));
        state_rx
            .wait_for(|s| *s == State::Up { generation: 1 })
            .await
            .unwrap();
        script.drop_now.notify_one();
        state_rx
            .wait_for(|s| *s == State::Up { generation: 2 })
            .await
            .unwrap();
        stop_tx.send_replace(true);
        task.await.unwrap();
        assert_eq!(
            *script.log.lock().unwrap(),
            [
                "mcp:x: connection attempt failed: boom",
                "mcp:x: connection failed; retrying in 5ms (attempt 1/3)",
                "mcp:x: reconnected (attempt 1/3)",
                "adopted 1",
                "closed",
                "mcp:x: connection lost; reconnecting in 10ms (attempt 2/3)",
                "mcp:x: reconnected (attempt 2/3)",
                "adopted 2",
                "closed",
            ]
        );
    });
}

#[test]
fn fail_on_startup_error_第一次失敗就停() {
    runtime().block_on(async {
        let script = Script::default();
        let (first_tx, first_rx) = oneshot::channel();
        let (state_tx, state_rx) = watch::channel(State::Connecting);
        let (_stop_tx, stop_rx) = watch::channel(false);
        run(
            Fake(script.clone()),
            fast(),
            "mcp:x".into(),
            false,
            first_tx,
            state_tx,
            stop_rx,
        )
        .await;
        assert_eq!(first_rx.await.unwrap(), Err("refused".into()));
        assert_eq!(*state_rx.borrow(), State::Stopped);
        assert!(script.log.lock().unwrap().is_empty());
    });
}

#[test]
fn 一直連不上就放棄() {
    runtime().block_on(async {
        let script = Script::default();
        let (first_tx, _first_rx) = oneshot::channel();
        let (state_tx, state_rx) = watch::channel(State::Connecting);
        let (_stop_tx, stop_rx) = watch::channel(false);
        run(Fake(script.clone()), fast(), "mcp:x".into(), true, first_tx, state_tx, stop_rx).await;
        assert_eq!(*state_rx.borrow(), State::Stopped);
        let log = script.log.lock().unwrap();
        assert_eq!(log.iter().filter(|l| l.contains("connection attempt failed")).count(), 4);
        assert_eq!(
            log.last().unwrap(),
            "mcp:x: giving up after 3 consecutive failed reconnect attempts — registered tools will fail until the plugin is assembled again"
        );
    });
}

#[test]
fn 掉線後收不乾淨就停止重連() {
    runtime().block_on(async {
        let script = Script::default();
        *script.outcomes.lock().unwrap() = vec![Ok(())];
        *script.hang_close.lock().unwrap() = true;
        let (first_tx, first_rx) = oneshot::channel();
        let (state_tx, state_rx) = watch::channel(State::Connecting);
        let (_stop_tx, stop_rx) = watch::channel(false);
        let started = Instant::now();
        let task = tokio::spawn(run(Fake(script.clone()), fast(), "mcp:x".into(), true, first_tx, state_tx, stop_rx));
        assert_eq!(first_rx.await.unwrap(), Ok(()));
        script.drop_now.notify_one();
        task.await.unwrap();
        assert!(started.elapsed() >= Duration::from_secs(5));
        assert_eq!(*state_rx.borrow(), State::Stopped);
        assert_eq!(
            script.log.lock().unwrap().last().unwrap(),
            "ERROR mcp:x: failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; 要重試得重新組裝（下一條 thread 或重啟 serve）"
        );
    });
}

#[test]
fn 第一次還沒落定就_dispose() {
    runtime().block_on(async {
        let script = Script::default();
        let (first_tx, first_rx) = oneshot::channel();
        let (state_tx, _state_rx) = watch::channel(State::Connecting);
        let (stop_tx, stop_rx) = watch::channel(true);
        drop(stop_tx);
        run(
            Fake(script),
            fast(),
            "mcp:x".into(),
            true,
            first_tx,
            state_tx,
            stop_rx,
        )
        .await;
        assert_eq!(
            first_rx.await.unwrap(),
            Err("mcp:x: disposed before the first connection settled".into())
        );
    });
}

/// 監督者在收一代的期限的兩倍內結束，收不乾淨的情境也等得到。
async fn within<T>(f: impl Future<Output = T>) -> T {
    tokio::time::timeout(GENERATION_CLOSE_TIMEOUT * 2, f)
        .await
        .expect("監督者沒有結束")
}

#[test]
fn stop_落在第二次_connect_進行中_丟下那次嘗試_不收() {
    runtime().block_on(async {
        let script = Script::default();
        *script.outcomes.lock().unwrap() = vec![Err("boom".into())];
        *script.hang_connect.lock().unwrap() = true;
        let (first_tx, first_rx) = oneshot::channel();
        let (state_tx, _state_rx) = watch::channel(State::Connecting);
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(run(
            Fake(script.clone()),
            fast(),
            "mcp:x".into(),
            true,
            first_tx,
            state_tx,
            stop_rx,
        ));
        script.connecting.notified().await;
        stop_tx.send_replace(true);
        within(task).await.unwrap();
        assert_eq!(first_rx.await.unwrap(), Err("boom".into()));
        assert!(script.connect_dropped.load(SeqCst));
        assert_eq!(script.connects.load(SeqCst), 2);
        assert_eq!(
            *script.log.lock().unwrap(),
            [
                "mcp:x: connection attempt failed: boom",
                "mcp:x: connection failed; retrying in 5ms (attempt 1/3)",
            ]
        );
    });
}

#[test]
fn 連上的同時被_stop_收掉那一代_不發布() {
    runtime().block_on(async {
        for hang_close in [false, true] {
            let script = Script::default();
            *script.outcomes.lock().unwrap() = vec![Ok(())];
            *script.hang_close.lock().unwrap() = hang_close;
            let (first_tx, first_rx) = oneshot::channel();
            let (state_tx, state_rx) = watch::channel(State::Connecting);
            let (stop_tx, stop_rx) = watch::channel(false);
            *script.stop_on_connect.lock().unwrap() = Some(stop_tx);
            within(run(
                Fake(script.clone()),
                fast(),
                "mcp:x".into(),
                true,
                first_tx,
                state_tx,
                stop_rx,
            ))
            .await;
            assert_eq!(first_rx.await.unwrap(), Err("mcp:x: disposed".into()));
            assert_eq!(*state_rx.borrow(), State::Connecting);
            let want = if hang_close {
                "ERROR mcp:x: transport closure could not be confirmed during disposal — server shutdown may be incomplete"
            } else {
                "closed"
            };
            assert_eq!(*script.log.lock().unwrap(), [want], "hang_close={hang_close}");
        }
    });
}

#[test]
fn 退避睡眠中_stop_當場結束_不再連() {
    runtime().block_on(async {
        let script = Script::default();
        let slow = Policy {
            initial_delay_ms: 60_000.0,
            max_delay_ms: 60_000.0,
            ..fast()
        };
        let (first_tx, first_rx) = oneshot::channel();
        let (state_tx, _state_rx) = watch::channel(State::Connecting);
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(run(
            Fake(script.clone()),
            slow,
            "mcp:x".into(),
            true,
            first_tx,
            state_tx,
            stop_rx,
        ));
        assert_eq!(first_rx.await.unwrap(), Err("refused".into()));
        stop_tx.send_replace(true);
        within(task).await.unwrap();
        assert_eq!(script.connects.load(SeqCst), 1);
        assert_eq!(
            *script.log.lock().unwrap(),
            [
                "mcp:x: connection attempt failed: refused",
                "mcp:x: connection failed; retrying in 60000ms (attempt 1/3)",
            ]
        );
    });
}

#[test]
fn 連上之後_dispose_收不乾淨_記錯() {
    runtime().block_on(async {
        let script = Script::default();
        *script.outcomes.lock().unwrap() = vec![Ok(())];
        *script.hang_close.lock().unwrap() = true;
        let (first_tx, first_rx) = oneshot::channel();
        let (state_tx, _state_rx) = watch::channel(State::Connecting);
        let (stop_tx, stop_rx) = watch::channel(false);
        let task = tokio::spawn(run(
            Fake(script.clone()),
            fast(),
            "mcp:x".into(),
            true,
            first_tx,
            state_tx,
            stop_rx,
        ));
        assert_eq!(first_rx.await.unwrap(), Ok(()));
        let started = Instant::now();
        stop_tx.send_replace(true);
        within(task).await.unwrap();
        assert!(started.elapsed() >= GENERATION_CLOSE_TIMEOUT);
        assert_eq!(
            *script.log.lock().unwrap(),
            [
                "adopted 1",
                "ERROR mcp:x: transport closure could not be confirmed during disposal — server shutdown may be incomplete",
            ]
        );
    });
}
