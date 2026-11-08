//! 時限與計時器。
//!
//! 內核單執行緒、不用 async runtime，由宿主的事件迴圈呼叫 [`super::Kernel::run`] 推進。要花時間的 apply 與 effect 的收尾，
//! 寫成回 [`Applied::Pending`]／[`Step::Pending`] 的狀態機，之後每次 `run` 被 poll 一次；到了時限就呼叫 `cancel`，算成逾時。
//! 所以時限只對回 `Pending` 的工作有效：一次同步呼叫本身不會被打斷，插件不能在 apply、poll、listener 裡阻塞。
//!
//! 計時器掛在 fiber 上，是那個 fiber 的 effect：fiber 進 UNLOADING 之後、開始收 effect 之前照樣會響；
//! 收到它時計時器跟著取消，不會在插件卸載後還被叫到。

use std::time::{Duration, Instant};

use super::{Cx, PluginError};

/// 收尾（dispose 或 poll）一次的結果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Done,
    Pending,
}

/// apply 的結果。`Disabled` 是插件看過設定與環境之後自己決定不啟用，跟失敗、跟設定裡的 `disabled` 分開回報。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Applied {
    Done,
    Pending,
    Disabled(String),
}

/// 插件自己登記的收尾工作。`dispose` 在 fiber 卸載時呼叫一次；回 `Pending` 的，之後每次 `run` 呼叫 `poll`，
/// 直到 `Done`、回錯或到了時限（時限到了先呼叫 `cancel`）。回錯只寫一筆事件，不擋其他收尾。
pub trait Effect {
    fn dispose(&mut self, cx: &mut Cx<'_>) -> Result<Step, PluginError>;

    fn poll(&mut self, _cx: &mut Cx<'_>) -> Result<Step, PluginError> {
        Ok(Step::Done)
    }

    fn cancel(&mut self) {}
}

/// 包一個同步的收尾函式。
pub struct OnDispose<F: FnOnce(&mut Cx<'_>) -> Result<(), PluginError>>(pub Option<F>);

impl<F: FnOnce(&mut Cx<'_>) -> Result<(), PluginError>> Effect for OnDispose<F> {
    fn dispose(&mut self, cx: &mut Cx<'_>) -> Result<Step, PluginError> {
        if let Some(f) = self.0.take() {
            f(cx)?;
        }
        Ok(Step::Done)
    }
}

/// 內核的限制。`Default` 是出廠值，建 [`super::Kernel`] 時傳入。
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// 一次 apply（含之後的 poll）最久多久。
    pub apply: Duration,
    /// 一個 effect 的收尾最久多久。
    pub dispose: Duration,
    /// 一次同步的 apply、poll、dispose、listener 或計時器回呼超過這麼久，寫一筆 [`super::KernelEvent::SlowCallback`]。
    pub slow_callback: Duration,
    /// 一輪 settle 最多推進幾步（一次 `run` 有兩輪 settle）；超過就停下來寫一筆 [`super::KernelEvent::Overrun`]，
    /// 剩下的留到下一輪。
    pub max_steps: usize,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits {
            apply: Duration::from_secs(10),
            dispose: Duration::from_secs(10),
            slow_callback: Duration::from_millis(50),
            max_steps: 100_000,
        }
    }
}

/// `now + d`，加不上去就把 `d` 減半再試，直到 `Instant` 表示得到：時長來自 `Limits` 與插件傳入的計時器時長，
/// 溢位不能讓行程 panic。
pub(crate) fn later(now: Instant, mut d: Duration) -> Instant {
    loop {
        if let Some(t) = now.checked_add(d) {
            return t;
        }
        d /= 2;
    }
}

pub(crate) type TimerCallback = Box<dyn for<'a> FnMut(&mut Cx<'a>) -> Result<(), PluginError>>;

pub(crate) struct Timer {
    pub owner: super::FiberId,
    pub label: String,
    pub due: Instant,
    /// `None` 是只跑一次。
    pub every: Option<Duration>,
    /// 回呼執行期間拿出來，回來再放回去。
    pub callback: Option<TimerCallback>,
}
