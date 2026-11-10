//! 過橋的服務：宿主連線上的 `call` 照服務名找到用 [`super::Cx::expose`] 提供的實體，資料進、資料出。
//!
//! 一次呼叫由宿主開始（[`Remote::start`]），沒當場結束的回 [`Progress::Pending`]，之後宿主醒來就 [`Remote::poll`] 它（那條連線排著沒寫出去的太多時先跳過），
//! 直到回 `Ok` 或 `Err`；呼叫端取消、斷線，或宿主提早收尾（塊太大、一步推的塊加起來超過上限、單次的方法推了塊）時宿主叫 [`Remote::cancel`]，之後不再 poll 那一次。服務自己決定什麼時候要被叫醒
//! （[`Remote::next_deadline`]），或給一個喚醒 fd（[`Remote::wake_fd`]）讓別的執行緒叫醒宿主：宿主不忙等，兩者都沒有的 `Pending`
//! 只在宿主因別的事醒來時被 poll 到。
//!
//! 串流的方法在 `start`／`poll` 裡把一塊一塊推進 `chunks`，最後照樣以 `Ok`／`Err` 收尾；推了塊又回 `Pending` 的，宿主下一輪就再 poll
//! （連線暫停時等它恢復），大的結果可以分幾步送。單次的方法推了塊，宿主當成服務的錯。
//! 一步推的塊加起來有上限（`crate::host::calls::OUTBOX_PAUSE`），超過的那一塊起不送，那一次以服務的錯收尾。
//! 服務也可以主動推事件（[`Remote::take_events`]），每個事件指定送給哪一條連線（[`CallKey::conn`]），宿主不廣播。
//!
//! 提供者離開 ACTIVE 時，還在跑的呼叫以服務的錯收尾，不另外叫 [`Remote::cancel`]：離開 ACTIVE 就是進卸載，宿主從那一刻起找不到
//! 這個值；卸載時它連同記的每一次呼叫一起丟掉；再 apply 是新的值、新的 uid。
//!
//! 值都是 [`Value`]，不帶回呼或活物件：過界的只有資料。

use std::any::Any;
use std::os::fd::RawFd;
use std::time::Instant;

use crate::json::Value;

/// 一次呼叫的身分，宿主給的。服務只拿它對應自己記下的狀態，不解讀裡面的欄位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CallKey {
    pub conn: u32,
    pub id: u64,
}

/// 方法回一個值，還是先送一串塊再收尾。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodKind {
    Unary,
    Stream,
}

/// 服務自己判的失敗。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// 參數不合這個方法。
    BadPayload,
    /// 其他失敗。
    Failed,
}

/// 服務主動推的一個事件。編出來超過一框的，宿主不送、只記一行 log；指名的連線排著的到了
/// `crate::host::calls::OUTBOX_LIMIT`，宿主斷掉那條連線。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Push {
    /// 送給哪一條連線：從那條連線上某一次呼叫的 [`CallKey::conn`] 來。連線已經斷了就丟掉。
    pub conn: u32,
    pub topic: String,
    pub payload: Value,
}

/// 一次呼叫推進到哪。`Pending` 之後宿主會再 poll；`Ok`／`Err` 是終點，`Err` 的字串原樣成為回給客戶端的 `error.message`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Progress {
    Pending,
    Ok(Value),
    Err(Fault, String),
}

/// 過橋的服務。跟 [`super::Service`] 分開，是因為要能當成 `dyn` 由宿主照名字取用。
pub trait Remote {
    /// 這個服務有沒有這個方法、是哪一種。
    fn method(&self, name: &str) -> Option<MethodKind>;

    /// 開始一次呼叫。宿主已經核過方法存在。
    fn start(
        &mut self,
        key: CallKey,
        method: &str,
        payload: Value,
        now: Instant,
        chunks: &mut Vec<Value>,
    ) -> Progress;

    /// 推進一次還在跑的呼叫。
    fn poll(&mut self, key: CallKey, now: Instant, chunks: &mut Vec<Value>) -> Progress;

    /// 這一次不跑了（呼叫端取消、斷線，或宿主提早收尾）：放掉它的狀態。之後不會再 poll 它。
    fn cancel(&mut self, key: CallKey);

    /// 還在跑的呼叫最晚什麼時候要被 poll。
    fn next_deadline(&self) -> Option<Instant> {
        None
    }

    /// 取走要推給客戶端的事件。
    fn take_events(&mut self) -> Vec<Push> {
        Vec::new()
    }

    /// 服務自己的喚醒 fd：別的執行緒有結果時它變成可讀，宿主把它放進 poll，可讀時叫 [`Remote::woken`]。
    /// fd 由服務擁有，要是非阻塞的；服務在 `woken` 裡把它讀乾淨，不然宿主會一直醒。
    fn wake_fd(&self) -> Option<RawFd> {
        None
    }

    /// [`Remote::wake_fd`] 可讀了：讀乾淨、收進結果。之後宿主照常 poll 還在跑的呼叫、取事件。
    fn woken(&mut self) {}
}

/// 從型別抹掉的值取回 `dyn Remote`。expose 時照實際型別產生一個，跟值一起存。
pub(crate) type AsRemote = fn(&mut dyn Any) -> Option<&mut dyn Remote>;

pub(crate) fn as_remote<S: Remote + 'static>(value: &mut dyn Any) -> Option<&mut dyn Remote> {
    value.downcast_mut::<S>().map(|s| s as &mut dyn Remote)
}
