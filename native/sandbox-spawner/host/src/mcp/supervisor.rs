//! 一台 MCP server 的連線監督者：連上、等它掉、照有上限的指數退避重連。退避、預算歸零、收連上過的一代的期限與記的訊息照 `packages/nexus-plugin-mcp/src/supervisor.ts`，訊息的英文逐字相同；`stop` 時直接丟下進行中的 [`Hooks::connect`]，不等它落定。
//! 失敗的連線嘗試監督者不收也不設期限（TS 的 `abandon` 沒有對應，失敗的嘗試也就不會因收不乾淨而停止重連）：
//! [`Hooks::connect`] 回錯之前要自己把開出來的東西真的關掉；`stop` 時被丟下的嘗試靠 drop 收。
//!
//! - 退避：第一次 `initialDelayMs`，每次連續失敗加倍，上限 `maxDelayMs`；同一次中斷最多 `maxAttempts` 次，超過就放棄。
//!   訊息裡的毫秒數跟 TS 一樣用浮點數算、照最短的十進位寫；只有小於 1e-6 或不小於 1e21 時不逐字：JS 改寫成指數（`1e-7`、`1e+21`），這裡照寫全部的位數。
//! - 連上之後撐過 `maxDelayMs` 才掉線，失敗次數歸零。
//! - 收連上過的一代最多等 [`GENERATION_CLOSE_TIMEOUT`]；等不到就停止重連，寧可停下也不讓兩代同時活著。
//! - 第一次連線的結果經 `first` 交給建立者；`retry_first` 是 `false`（對應設定的 `failOnStartupError: true`）時第一次失敗就結束，不重試。
//!
//! [`Backoff`] 是不碰時鐘與 I/O 的部分，[`run`] 把它接到 tokio 的計時器與 [`Hooks`]。

use std::future::Future;
use std::time::{Duration, Instant};

use tokio::sync::{oneshot, watch};

use crate::json::Value;

/// 收連上過的一代最多等多久，跟 `supervisor.ts` 的 `GENERATION_CLOSE_TIMEOUT_MS` 同值。
pub const GENERATION_CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

/// 重連政策，欄位、預設與收哪些值照 `reconnectSchema`：毫秒是正的有限數，`maxAttempts` 是 1 到 2^53−1 的整數。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Policy {
    pub enabled: bool,
    pub initial_delay_ms: f64,
    pub max_delay_ms: f64,
    pub max_attempts: u64,
}

impl Default for Policy {
    fn default() -> Policy {
        Policy {
            enabled: true,
            initial_delay_ms: 500.0,
            max_delay_ms: 30_000.0,
            max_attempts: 10,
        }
    }
}

/// JS 的 `Number.MAX_SAFE_INTEGER`，zod 的 `int()` 收的上限。
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// 毫秒數換成 [`Duration`]；放不進的夾到 [`Duration::MAX`]。
fn millis(ms: f64) -> Duration {
    Duration::try_from_secs_f64(ms / 1000.0).unwrap_or(Duration::MAX)
}

impl Policy {
    /// 解 `reconnect` 那一格：`{ enabled?, initialDelayMs?, maxDelayMs?, maxAttempts? }`，沒寫的用預設。
    pub fn parse(value: Option<&Value>) -> Result<Policy, String> {
        let mut policy = Policy::default();
        let Some(value) = value else {
            return Ok(policy);
        };
        let Value::Object(fields) = value else {
            return Err("reconnect 要是物件".into());
        };
        let positive = |name: &str, v: &Value| -> Result<f64, String> {
            v.as_f64()
                .filter(|ms| ms.is_finite() && *ms > 0.0)
                .ok_or_else(|| format!("reconnect.{name} 要是正數（毫秒）"))
        };
        for (key, v) in fields {
            match key.as_str() {
                "enabled" => {
                    policy.enabled = v.as_bool().ok_or("reconnect.enabled 要是布林")?;
                }
                "initialDelayMs" => policy.initial_delay_ms = positive(key, v)?,
                "maxDelayMs" => policy.max_delay_ms = positive(key, v)?,
                "maxAttempts" => {
                    policy.max_attempts = v
                        .as_f64()
                        .filter(|n| n.fract() == 0.0 && (1.0..=MAX_SAFE_INTEGER).contains(n))
                        .ok_or("reconnect.maxAttempts 要是正整數")?
                        as u64;
                }
                _ => return Err(format!("reconnect 不認得的欄位 {key}")),
            }
        }
        if policy.initial_delay_ms > policy.max_delay_ms {
            return Err("initialDelayMs 不能大於 maxDelayMs".into());
        }
        Ok(policy)
    }
}

/// 一次失敗之後該怎麼辦。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    /// 等 `delay` 再試；`message` 是要記的那一句。
    Retry { delay: Duration, message: String },
    /// 不再試了（放棄或沒開重連）。
    Stop { message: String },
}

/// 退避與預算：記連續失敗幾次、上一代什麼時候連上。
#[derive(Debug, Clone)]
pub struct Backoff {
    policy: Policy,
    label: String,
    failed: u64,
    connected_at: Option<Instant>,
}

impl Backoff {
    pub fn new(policy: Policy, label: impl Into<String>) -> Backoff {
        Backoff {
            policy,
            label: label.into(),
            failed: 0,
            connected_at: None,
        }
    }

    /// 連上了。重試之後才連上的，回要記的那一句。
    pub fn connected(&mut self, now: Instant) -> Option<String> {
        self.connected_at = Some(now);
        (self.failed > 0).then(|| {
            format!(
                "{}: reconnected (attempt {}/{})",
                self.label, self.failed, self.policy.max_attempts
            )
        })
    }

    /// 掉線（`lost_established`）或一次嘗試失敗之後，下一步。
    pub fn next(&mut self, lost_established: bool, now: Instant) -> Next {
        let label = &self.label;
        if !self.policy.enabled {
            let message = if lost_established {
                format!("{label}: connection lost and reconnect is disabled — registered tools will fail until the plugin is assembled again")
            } else {
                format!("{label}: connection failed and reconnect is disabled — no tools were registered; the next assembly connects again")
            };
            return Next::Stop { message };
        }
        if self
            .connected_at
            .is_some_and(|at| now.saturating_duration_since(at) >= millis(self.policy.max_delay_ms))
        {
            self.failed = 0;
        }
        self.connected_at = None;
        self.failed = self.failed.saturating_add(1);
        if self.failed > self.policy.max_attempts {
            return Next::Stop {
                message: format!(
                    "{label}: giving up after {} consecutive failed reconnect attempts — registered tools will fail until the plugin is assembled again",
                    self.policy.max_attempts
                ),
            };
        }
        let factor = 2f64.powi(i32::try_from(self.failed - 1).unwrap_or(i32::MAX));
        let delay_ms = self
            .policy
            .max_delay_ms
            .min(self.policy.initial_delay_ms * factor);
        let action = if lost_established {
            "connection lost; reconnecting"
        } else {
            "connection failed; retrying"
        };
        Next::Retry {
            message: format!(
                "{label}: {action} in {delay_ms}ms (attempt {}/{})",
                self.failed, self.policy.max_attempts
            ),
            delay: millis(delay_ms),
        }
    }
}

/// 監督者這一刻的狀態，給呼叫端看。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum State {
    /// 還沒有一代連上過，正在連或等著重試。
    Connecting,
    /// 第 `generation` 代連著。
    Up { generation: u64 },
    /// 掉線了，等著重連；監督者不收回上一次 [`Hooks::adopted`] 發布的清單。
    Reconnecting,
    /// 不再重連：放棄、沒開重連、收不乾淨、或第一次就失敗而 `retry_first` 是 `false`。
    Stopped,
}

/// 監督者要呼叫端提供的事。一代是什麼、怎麼連、怎麼關、怎麼知道它掉了，都由呼叫端定。
pub trait Hooks {
    type Generation;

    /// 連一代。錯誤字串不得帶任何秘密。失敗的嘗試監督者不叫 [`Hooks::close`]，回錯之前要自己把開出來的東西真的關掉（沒有期限，也不會因此停止重連）；
    /// `stop` 時這個 future 可能在任何 await 點被丟掉，被丟下的要靠 drop 收。
    fn connect(&mut self) -> impl Future<Output = Result<Self::Generation, String>>;
    /// 新的一代連上了（第 `generation` 代）：發布它的清單。
    fn adopted(&mut self, generation: u64, gen: &Self::Generation);
    /// 等到這一代掉線（transport 關了，或呼叫端判它斷線）。
    fn down(&mut self, gen: &Self::Generation) -> impl Future<Output = ()>;
    /// 收掉這一代，回來時它已經真的關了。監督者自己套 [`GENERATION_CLOSE_TIMEOUT`]。
    fn close(&mut self, gen: Self::Generation) -> impl Future<Output = ()>;
    /// 記一句一般的訊息。
    fn report(&mut self, message: &str);
    /// 記一句錯誤級的訊息。
    fn error(&mut self, message: &str);
}

/// 跑一個監督者，直到 `stop` 被觸發或不再重連。第一次連線的結果送進 `first`（成功是 `Ok(())`）。
/// 狀態寫進 `state`。結束時進行中的那一代已經收過（或等過了期限）。
pub async fn run<H: Hooks>(
    mut hooks: H,
    policy: Policy,
    label: String,
    retry_first: bool,
    first: oneshot::Sender<Result<(), String>>,
    state: watch::Sender<State>,
    mut stop: watch::Receiver<bool>,
) {
    let mut backoff = Backoff::new(policy, label.clone());
    let mut first = Some(first);
    let mut generations = 0u64;
    loop {
        let attempt = tokio::select! {
            biased;
            _ = stopped(&mut stop) => {
                settle_first(&mut first, Err(format!("{label}: disposed before the first connection settled")));
                return;
            }
            attempt = hooks.connect() => attempt,
        };
        let lost_established = match attempt {
            Ok(gen) => {
                if *stop.borrow() {
                    let closed =
                        tokio::time::timeout(GENERATION_CLOSE_TIMEOUT, hooks.close(gen)).await;
                    if closed.is_err() {
                        hooks.error(&format!("{label}: transport closure could not be confirmed during disposal — server shutdown may be incomplete"));
                    }
                    settle_first(&mut first, Err(format!("{label}: disposed")));
                    return;
                }
                generations += 1;
                if let Some(message) = backoff.connected(Instant::now()) {
                    hooks.report(&message);
                }
                hooks.adopted(generations, &gen);
                state.send_replace(State::Up {
                    generation: generations,
                });
                settle_first(&mut first, Ok(()));
                let disposed = tokio::select! {
                    biased;
                    _ = stopped(&mut stop) => true,
                    _ = hooks.down(&gen) => false,
                };
                if !disposed {
                    state.send_replace(State::Reconnecting);
                }
                let closed = tokio::time::timeout(GENERATION_CLOSE_TIMEOUT, hooks.close(gen)).await;
                if disposed {
                    if closed.is_err() {
                        hooks.error(&format!("{label}: transport closure could not be confirmed during disposal — server shutdown may be incomplete"));
                    }
                    return;
                }
                if closed.is_err() {
                    hooks.error(&format!("{label}: failed generation could not confirm transport closure — reconnect stopped to avoid overlapping server processes; 要重試得重新組裝（下一條 thread 或重啟 serve）"));
                    state.send_replace(State::Stopped);
                    return;
                }
                true
            }
            Err(error) => {
                if first.is_some() && !retry_first {
                    settle_first(&mut first, Err(error));
                    state.send_replace(State::Stopped);
                    return;
                }
                hooks.report(&format!("{label}: connection attempt failed: {error}"));
                settle_first(&mut first, Err(error));
                false
            }
        };
        match backoff.next(lost_established, Instant::now()) {
            Next::Stop { message } => {
                hooks.report(&message);
                state.send_replace(State::Stopped);
                return;
            }
            Next::Retry { delay, message } => {
                hooks.report(&message);
                tokio::select! {
                    biased;
                    _ = stopped(&mut stop) => return,
                    _ = tokio::time::sleep(delay) => {}
                }
            }
        }
    }
}

fn settle_first(
    first: &mut Option<oneshot::Sender<Result<(), String>>>,
    outcome: Result<(), String>,
) {
    if let Some(tx) = first.take() {
        let _ = tx.send(outcome);
    }
}

/// `stop` 變成 `true`（或送端沒了）時完成。
async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|s| *s).await;
}
