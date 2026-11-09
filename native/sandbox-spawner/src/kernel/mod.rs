//! 主機級插件樹的內核（#2569）：fiber 樹、服務、事件、時限、設定。宿主與每條對話的 Rust 組合行程共用。
//!
//! 設計與語意清單的逐條對照見 `.docs/rust-kernel-2569-2026-11-09.md`。
//!
//! # 怎麼推進
//!
//! 單執行緒、不用 async runtime。狀態轉換一律在 [`Kernel::run`] 裡發生：[`Kernel::mount`]、[`Kernel::dispose`]、
//! [`Kernel::update`] 與插件經 [`Cx`] 做的登記，都只把 fiber 排進待做。例外是 emit：它當場同步呼叫 listener，
//! 但 listener 一樣不會觸發狀態轉換。所以插件的回呼裡不會重入狀態機。
//! 宿主的事件迴圈每次醒來呼叫一次 `run`，睡多久看 [`Kernel::next_deadline`]（宿主再併入過橋服務的 [`Remote::next_deadline`]），醒來後用 [`Kernel::drain_events`] 取走內核的事件寫 log 與稽核。
//!
//! # fiber 的狀態
//!
//! 六種：[`State`]。每次轉換都送一筆 [`KernelEvent::Status`]。
//!
//! - 依賴的服務都在、提供者都 ACTIVE、版本符合宣告的範圍，fiber 才 apply；缺一個就停在 PENDING。
//! - 依賴的實體換了（提供者換手，epoch 變了），已經 ACTIVE 的 fiber 先卸載再重新 apply。
//! - apply 失敗或逾時：已經登記的 effect 全部收掉（回滾），停在 FAILED，送一筆 [`KernelEvent::ApplyFailed`]。之後只有 [`Kernel::update`] 救得回來。
//!   apply 回 [`Applied::Disabled`] 也一樣回滾、停在 FAILED，送的是 [`KernelEvent::SelfDisabled`]。
//!   例外：apply 期間來了 `update`，事件照送，但不停在 FAILED，卸載後改用新設定重來。
//! - 從沒啟用過的（PENDING）與 FAILED 的 fiber 被收掉時，照樣經過 UNLOADING，收掉它們在啟用之前就登記的 effect，再到 DISPOSED。
//! - 卸載順序：先等依賴自己服務的 fiber 都卸載完（這段期間自己的 listener 與計時器照常被呼叫），再收自己的 effect；
//!   依賴者是自己的祖先、而且已經開始收 effect 的不等，因為它在等這個 fiber 收完。
//!   effect 照登記的反序開始收：同步的當場收完，回 `Pending` 的交錯推進。子 fiber 是父 fiber 的 effect，輪到時只被要求收掉，
//!   實際卸載在之後的步驟；父 fiber 等全部子 fiber 收完才結束卸載。
//!
//! # 錯誤
//!
//! 插件的 apply、poll、listener、計時器、收尾一律回 `Result`，內核接住之後轉成 [`KernelEvent`]，不往外丟。
//! release 建置是 `panic = "abort"`：插件 panic 等於宿主死掉，交給監督行程重起。
//!
//! 還沒做的三項（Loader 執行期 diff、update 否決、isolate），呼叫入口回 [`KernelError::NotImplemented`]、寫一行 log、
//! 送一筆 [`KernelEvent::NotImplemented`]，不靜默略過（#2596、#2597、#2598）。

pub mod config;
pub mod deadline;
pub mod event;
mod fiber;
pub mod remote;
pub mod service;

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::time::{Duration, Instant};

use crate::json::Value;

pub use config::{ConfigError, Fields};
pub use deadline::{Applied, Effect, Limits, OnDispose, Step};
pub use event::Event;
pub use remote::{CallKey, Fault, MethodKind, Progress, Push, Remote};
pub use service::{Inject, Range, SemverError, Service, Version};

use deadline::Timer;
use event::Listener;
use fiber::{Entry, Fiber, Phase};
use service::{Impl, Store};

/// Loader 以 diff 做執行期編輯（#2596）。
pub const CARD_LOADER_DIFF: u32 = 2596;
/// update 否決（#2597）。
pub const CARD_UPDATE_VETO: u32 = 2597;
/// isolate（#2598）。
pub const CARD_ISOLATE: u32 = 2598;

/// fiber 的編號。fiber 收掉之後編號不會被重用成別的 fiber：舊編號一律查不到。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FiberId {
    index: u32,
    generation: u32,
}

/// fiber 的狀態。PENDING：還沒 apply，或依賴不在。FAILED 也涵蓋自我停用（[`Applied::Disabled`]），要分辨看 [`Health`]。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Pending,
    Loading,
    Active,
    Failed,
    Unloading,
    Disposed,
}

/// 插件回給內核的錯。只帶一段給人看的訊息，內核把它放進 [`KernelEvent`]。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginError(pub String);

impl From<&str> for PluginError {
    fn from(message: &str) -> PluginError {
        PluginError(message.to_string())
    }
}

impl From<String> for PluginError {
    fn from(message: String) -> PluginError {
        PluginError(message)
    }
}

impl From<KernelError> for PluginError {
    fn from(error: KernelError) -> PluginError {
        PluginError(error.to_string())
    }
}

/// 內核的 API 回的錯。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KernelError {
    /// 讀了 `inject` 沒宣告的服務。
    Undeclared {
        service: &'static str,
    },
    /// 經 [`Cx`] 讀：宣告了，但這個 fiber 現在沒有 committed 的實體（還沒 apply，或已經卸載）。
    /// 經 [`Kernel::service`] 讀：沒有提供者，或提供者不是 ACTIVE。
    Inactive {
        service: &'static str,
    },
    /// 名稱對、型別不對。
    TypeMismatch {
        service: &'static str,
    },
    /// 同名的服務已經有人提供（包括自己）。
    AlreadyProvided {
        service: &'static str,
        by: &'static str,
    },
    /// fiber 已經被要求收掉（dispose 過）或正在卸載，不能再登記 effect、服務、listener、計時器或子 fiber；
    /// 完全收掉之後的編號回 [`KernelError::UnknownFiber`]。
    InactiveEffect,
    /// 登記或送出 `internal/` 開頭的事件（包括 [`Kernel::emit`]）。
    Reserved {
        event: &'static str,
    },
    /// 編號查不到（已經收掉，或是舊編號）；對已經被要求收掉的 fiber 呼叫 `update` 也回這個。
    UnknownFiber,
    Config(ConfigError),
    /// `interval` 的間隔是 0。
    ZeroInterval,
    NotImplemented {
        what: &'static str,
        card: u32,
    },
}

impl fmt::Display for KernelError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KernelError::Undeclared { service } => {
                write!(f, "讀服務 {service} 之前沒有在 inject 宣告")
            }
            KernelError::Inactive { service } => write!(f, "服務 {service} 現在不可用"),
            KernelError::TypeMismatch { service } => write!(f, "服務 {service} 的型別不對"),
            KernelError::AlreadyProvided { service, by } => {
                write!(f, "服務 {service} 已經由 {by} 提供")
            }
            KernelError::InactiveEffect => f.write_str("fiber 已經收掉或正在卸載，不能再登記"),
            KernelError::Reserved { event } => write!(f, "事件 {event} 只給內核用"),
            KernelError::UnknownFiber => f.write_str("沒有這個 fiber"),
            KernelError::Config(error) => write!(f, "設定不合法：{error}"),
            KernelError::ZeroInterval => f.write_str("interval 的間隔不能是 0"),
            KernelError::NotImplemented { what, card } => write!(f, "{what} 還沒實作（#{card}）"),
        }
    }
}

impl From<ConfigError> for KernelError {
    fn from(error: ConfigError) -> KernelError {
        KernelError::Config(error)
    }
}

/// 插件。`apply` 在 fiber 啟用時呼叫，每次重新啟用都會再呼叫一次，插件自己的狀態要在 `apply` 裡重設。
/// 要花時間的就回 [`Applied::Pending`]，之後每次 [`Kernel::run`] 呼叫 `poll`；到了時限先呼叫 `cancel`，再算成 apply 失敗。
/// fiber 被收掉時正在跑的 apply 也會被 `cancel`。
pub trait Plugin {
    fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError>;

    fn poll(&mut self, _cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
        Ok(Applied::Done)
    }

    fn cancel(&mut self) {}
}

/// 編進執行檔的插件。`build` 把設定嚴格解析成插件，解析不過回錯，那一列不 apply。
pub struct Spec {
    pub name: &'static str,
    pub inject: &'static [Inject],
    /// 必掛：宿主起來時這個插件不是 ACTIVE，就不該起來（[`Kernel::check_required`]）。
    pub required: bool,
    /// mount 與每次 update 都當場呼叫；update 建好的插件可能被下一次 update 換掉，所以不能有副作用。
    pub build: fn(&Value) -> Result<Box<dyn Plugin>, ConfigError>,
}

/// 啟動時照設定掛樹用的一列。`disabled` 的列不掛；停用的 group 整棵子樹都不掛。
#[derive(Clone)]
pub enum Row {
    Plugin {
        spec: &'static Spec,
        config: Value,
        disabled: bool,
    },
    Group {
        name: &'static str,
        disabled: bool,
        rows: Vec<Row>,
    },
}

/// 內核送給宿主的事件。宿主決定哪些寫 log、哪些寫稽核。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KernelEvent {
    Status {
        fiber: FiberId,
        name: &'static str,
        from: State,
        to: State,
    },
    /// 設定解析不過，那一列沒有掛上去。
    ConfigRejected {
        parent: FiberId,
        name: &'static str,
        error: String,
    },
    /// apply 或 poll 回錯、或逾時。回滾在這筆事件之後開始，收完時 fiber 轉到 FAILED（看 `Status`）；
    /// apply 期間來了 `update` 的例外，改用新設定重來。
    ApplyFailed {
        fiber: FiberId,
        name: &'static str,
        error: String,
    },
    SelfDisabled {
        fiber: FiberId,
        name: &'static str,
        reason: String,
    },
    /// 一個 effect 的收尾回錯或逾時；其他收尾照跑。
    DisposeFailed {
        fiber: FiberId,
        name: &'static str,
        label: String,
        error: String,
    },
    /// listener 回錯，或派發途中被重入、這一次沒有呼叫（`error` 寫明是哪一種）。
    ListenerFailed {
        fiber: FiberId,
        name: &'static str,
        event: &'static str,
        error: String,
    },
    TimerFailed {
        fiber: FiberId,
        name: &'static str,
        label: String,
        error: String,
    },
    /// 一次同步呼叫超過 [`Limits::slow_callback`]。`what` 是 apply、poll、收尾或計時器的 label，或事件名稱。
    SlowCallback {
        fiber: FiberId,
        name: &'static str,
        what: String,
        elapsed: Duration,
    },
    /// 提供者的版本不符合依賴者宣告的範圍，那個依賴算不在。同一個 fiber 對同一個實體只送一次。
    ContractMismatch {
        fiber: FiberId,
        name: &'static str,
        service: &'static str,
        range: String,
        version: Option<String>,
    },
    NotImplemented {
        what: &'static str,
        card: u32,
    },
    /// 一次推進做到 [`Limits::max_steps`] 步還有剩，剩下的留到下一次推進。`run` 裡推進兩次，所以一次 `run` 最多送兩筆。
    Overrun,
}

/// 給人看的健康狀態：比 [`State`] 多說為什麼不是 ACTIVE。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Health {
    Active,
    Loading,
    Unloading,
    /// 等這些服務（沒有提供者、提供者不是 ACTIVE，或版本不符）。`missing` 是空的，表示依賴都在、還沒輪到 apply。
    Waiting {
        missing: Vec<&'static str>,
    },
    Failed(String),
    /// 插件自己決定不啟用，跟失敗、跟設定裡的停用分開。
    SelfDisabled(String),
    Disposed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiberReport {
    pub id: FiberId,
    pub name: &'static str,
    pub parent: Option<FiberId>,
    pub required: bool,
    pub state: State,
    pub health: Health,
}

/// [`Kernel::check_required`] 找到的一筆問題。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RequiredProblem {
    /// 掛上了，但不是 ACTIVE（等依賴、失敗、自我停用…）。
    NotActive { name: &'static str, health: Health },
    /// 設定解析不過，那一列沒掛。
    Rejected { name: &'static str, error: String },
    /// 設定把這一列或它所在的 group 停用。
    Off { name: &'static str },
}

#[derive(Debug, Clone)]
enum Reject {
    Off,
    Config(String),
}

#[derive(Debug, Clone)]
struct Rejected {
    parent: FiberId,
    name: &'static str,
    required: bool,
    reason: Reject,
}

struct Slot {
    generation: u32,
    fiber: Option<Fiber>,
}

pub struct Kernel {
    slots: Vec<Slot>,
    free: Vec<u32>,
    root: FiberId,
    store: Store,
    listeners: Vec<Listener>,
    next_listener: u64,
    timers: HashMap<u64, Timer>,
    next_timer: u64,
    dirty: VecDeque<FiberId>,
    events: Vec<KernelEvent>,
    rejected: Vec<Rejected>,
    limits: Limits,
    now: Instant,
    log: Box<dyn FnMut(&str)>,
}

impl Kernel {
    /// 只有根 fiber 的一棵樹。根 fiber 沒有插件，一開始就是 ACTIVE。
    pub fn new(limits: Limits, now: Instant) -> Kernel {
        let mut kernel = Kernel {
            slots: Vec::new(),
            free: Vec::new(),
            root: FiberId {
                index: 0,
                generation: 0,
            },
            store: Store::default(),
            listeners: Vec::new(),
            next_listener: 0,
            timers: HashMap::new(),
            next_timer: 0,
            dirty: VecDeque::new(),
            events: Vec::new(),
            rejected: Vec::new(),
            limits,
            now,
            log: Box::new(|line| eprintln!("kernel: {line}")),
        };
        let mut root = Fiber::new("root", None, Vec::new(), false, None, Value::Null, None);
        root.state = State::Active;
        root.target = Some(vec![0]);
        root.loaded = Some(vec![0]);
        kernel.root = kernel.alloc(root);
        kernel
    }

    /// 換掉寫 log 的地方（預設寫 stderr）。
    pub fn set_log(&mut self, log: impl FnMut(&str) + 'static) {
        self.log = Box::new(log);
    }

    pub fn root(&self) -> FiberId {
        self.root
    }

    /// 在 `parent` 底下掛一個插件，回新 fiber 的編號；設定解析不過回錯，什麼都不掛。apply 在下一次 `run` 才發生。
    pub fn mount(
        &mut self,
        parent: FiberId,
        spec: &'static Spec,
        config: Value,
    ) -> Result<FiberId, KernelError> {
        self.mount_spec(parent, spec, config)
    }

    /// 啟動時照設定在 `parent` 底下掛一整批列。解析不過的列寫一筆 [`KernelEvent::ConfigRejected`]，其他列照掛。
    pub fn load(&mut self, parent: FiberId, rows: &[Row]) -> Result<(), KernelError> {
        self.load_rows(parent, rows)
    }

    /// 執行期以新舊兩份列的差異編輯樹（#2596），還沒做。
    pub fn apply_diff(&mut self, _parent: FiberId, _rows: &[Row]) -> Result<(), KernelError> {
        self.not_implemented("Loader 以 diff 做執行期編輯", CARD_LOADER_DIFF)
    }

    /// 收掉一個 fiber 與它底下的整棵子樹，下一次 `run` 才真的卸載；重複呼叫沒有作用。
    /// 收根 fiber 就是收整棵樹，之後這個 `Kernel` 不能再掛任何東西。
    pub fn dispose(&mut self, id: FiberId) -> Result<(), KernelError> {
        self.fiber(id).ok_or(KernelError::UnknownFiber)?;
        self.request_dispose(id);
        Ok(())
    }

    /// 把 `patch` 疊到這個 fiber 現在的設定上（`null` 的欄位不覆寫），整份重新嚴格解析；解析不過什麼都不改。
    /// 解析過了就清掉之前的失敗與自我停用。下一次 `run`：ACTIVE 的先卸載，再用新設定 apply；依賴不在的照樣等。
    /// 舊的 apply 還在 `Pending`，就等它結束（完成、失敗、自我停用或逾時）再卸載、換新設定；舊的結果照樣發
    /// [`KernelEvent::ApplyFailed`] 或 [`KernelEvent::SelfDisabled`]，但不會讓 fiber 停在 FAILED。
    pub fn update(&mut self, id: FiberId, patch: &Value) -> Result<(), KernelError> {
        let fiber = self
            .fiber(id)
            .filter(|f| f.alive)
            .ok_or(KernelError::UnknownFiber)?;
        let spec = fiber.spec.ok_or_else(|| {
            KernelError::Config(ConfigError(format!("{} 沒有設定可以改", fiber.name)))
        })?;
        let merged = config::merge(&fiber.config, patch);
        config::reject_js_expr(&merged)?;
        let plugin = (spec.build)(&merged)?;
        let fiber = self.fiber_mut(id).ok_or(KernelError::UnknownFiber)?;
        fiber.config = merged;
        fiber.next_plugin = Some(plugin);
        fiber.error = None;
        fiber.disabled = None;
        fiber.revision += 1;
        self.dirty.push_back(id);
        Ok(())
    }

    /// 以框架的身分送一個插件事件；跟插件經 [`Cx::emit`] 送的一樣派發。同步：回來之前每個 listener 都已經呼叫過，
    /// 在 `run` 之外也一樣。名稱以 `internal/` 開頭回 [`KernelError::Reserved`]。
    pub fn emit<E: Event>(&mut self, event: &E) -> Result<(), KernelError> {
        event::check_name(E::NAME)?;
        self.dispatch(event);
        Ok(())
    }

    /// 以框架的身分讀一個服務：不經 `inject`，只要提供者是 ACTIVE。
    pub fn service<S: Service>(&self) -> Result<&S, KernelError> {
        let uid = self
            .visible_uid(S::NAME)
            .ok_or(KernelError::Inactive { service: S::NAME })?;
        service::downcast(
            self.store
                .get(uid)
                .ok_or(KernelError::Inactive { service: S::NAME })?,
        )
    }

    /// 規則同 [`Kernel::service`]。改動不會通知依賴者。
    pub fn service_mut<S: Service>(&mut self) -> Result<&mut S, KernelError> {
        let uid = self
            .visible_uid(S::NAME)
            .ok_or(KernelError::Inactive { service: S::NAME })?;
        service::downcast_mut(
            self.store
                .get_mut(uid)
                .ok_or(KernelError::Inactive { service: S::NAME })?,
        )
    }

    /// 照名字取一個用 [`Cx::expose`] 提供、提供者是 ACTIVE 的服務，連同它這次 provide 的 uid：uid 變了就是換了一個實體。
    pub fn remote(&mut self, name: &str) -> Option<(u64, &mut dyn Remote)> {
        let uid = self.visible_uid(name)?;
        let imp = self.store.get_mut(uid)?;
        let as_remote = imp.remote?;
        Some((uid, as_remote(imp.value.as_mut())?))
    }

    /// 每一個提供者是 ACTIVE 的過橋服務各叫一次 `f(名字, 服務)`。
    pub fn for_each_remote(&mut self, mut f: impl FnMut(&'static str, &mut dyn Remote)) {
        let slots = &self.slots;
        for (_, imp) in self.store.iter_mut() {
            let Some(as_remote) = imp.remote else { continue };
            let active = slots
                .get(imp.owner.index as usize)
                .filter(|slot| slot.generation == imp.owner.generation)
                .and_then(|slot| slot.fiber.as_ref())
                .is_some_and(|fiber| fiber.state == State::Active);
            if !active {
                continue;
            }
            if let Some(remote) = as_remote(imp.value.as_mut()) {
                f(imp.name, remote);
            }
        }
    }

    /// 推進到 `now`：先做記下來的轉換，再 poll 回 `Pending` 的工作（逾時的取消），再跑到期的計時器，最後把這些引起的轉換做完。
    pub fn run(&mut self, now: Instant) {
        self.now = now;
        self.settle();
        self.poll_pending();
        self.fire_timers();
        self.settle();
    }

    /// 下一次至少要在什麼時候呼叫 `run`。還有待做的轉換就回上一次 `run` 的時間（已經過去了，等於立刻）。
    /// 回 `Pending` 的工作只貢獻自己的時限，不是下一次該 poll 的時間：到了時限直接取消、不再 poll。
    /// 所以宿主要在這些工作可以推進時（例如 fd 可讀寫）另外呼叫 `run`。
    pub fn next_deadline(&self) -> Option<Instant> {
        if !self.dirty.is_empty() {
            return Some(self.now);
        }
        let mut next: Option<Instant> = None;
        let mut take = |t: Instant| next = Some(next.map_or(t, |n| n.min(t)));
        for timer in self.timers.values() {
            take(timer.due);
        }
        for fiber in self.fibers() {
            match &fiber.phase {
                Phase::Loading { deadline } => take(*deadline),
                Phase::Disposing { pending } => {
                    for p in pending {
                        if let fiber::PendingDispose::Effect { deadline, .. } = p {
                            take(*deadline);
                        }
                    }
                }
                Phase::Idle | Phase::WaitDependents => {}
            }
        }
        next
    }

    /// 沒有記下來沒做的轉換，也沒有 fiber 在載入或卸載途中。
    pub fn is_settled(&self) -> bool {
        self.dirty.is_empty() && self.fibers().all(|f| matches!(f.phase, Phase::Idle))
    }

    pub fn drain_events(&mut self) -> Vec<KernelEvent> {
        std::mem::take(&mut self.events)
    }

    /// 收掉了或是舊編號回 `None`。
    pub fn state(&self, id: FiberId) -> Option<State> {
        self.fiber(id).map(|f| f.state)
    }

    /// 樹上每個 fiber 的狀態，照槽位順序；收掉過 fiber 之後，順序跟建立的先後不一定一致。
    pub fn report(&self) -> Vec<FiberReport> {
        let mut out = Vec::new();
        for (index, slot) in self.slots.iter().enumerate() {
            if let Some(f) = &slot.fiber {
                let id = FiberId {
                    index: index as u32,
                    generation: slot.generation,
                };
                out.push(FiberReport {
                    id,
                    name: f.name,
                    parent: f.parent,
                    required: f.required,
                    state: f.state,
                    health: self.health(id),
                });
            }
        }
        out
    }

    /// 必掛的插件都 ACTIVE 才回 `Ok`。回錯時列出每一個不是 ACTIVE 的、設定解析不過的，以及被設定停用的必掛列。
    /// 要在樹穩定之後（[`Kernel::is_settled`]）才有意義。
    pub fn check_required(&self) -> Result<(), Vec<RequiredProblem>> {
        let mut problems = Vec::new();
        for report in self.report() {
            if report.required && report.health != Health::Active {
                problems.push(RequiredProblem::NotActive {
                    name: report.name,
                    health: report.health,
                });
            }
        }
        for r in self.rejected.iter().filter(|r| r.required) {
            problems.push(match &r.reason {
                Reject::Off => RequiredProblem::Off { name: r.name },
                Reject::Config(error) => RequiredProblem::Rejected {
                    name: r.name,
                    error: error.clone(),
                },
            });
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(problems)
        }
    }

    fn not_implemented<T>(&mut self, what: &'static str, card: u32) -> Result<T, KernelError> {
        (self.log)(&format!("{what} 還沒實作（#{card}）"));
        self.push_event(KernelEvent::NotImplemented { what, card });
        Err(KernelError::NotImplemented { what, card })
    }

    pub(crate) fn push_event(&mut self, event: KernelEvent) {
        self.events.push(event);
    }

    pub(crate) fn fiber_name(&self, id: FiberId) -> &'static str {
        self.fiber(id).map_or("?", |f| f.name)
    }

    fn load_rows(&mut self, parent: FiberId, rows: &[Row]) -> Result<(), KernelError> {
        self.can_register(parent)?;
        for row in rows {
            match row {
                Row::Plugin {
                    spec,
                    disabled: true,
                    ..
                } => {
                    self.rejected.push(Rejected {
                        parent,
                        name: spec.name,
                        required: spec.required,
                        reason: Reject::Off,
                    });
                }
                Row::Plugin {
                    spec,
                    config,
                    disabled: false,
                } => {
                    if let Err(error) = self.mount_spec(parent, spec, config.clone()) {
                        let error = error.to_string();
                        self.push_event(KernelEvent::ConfigRejected {
                            parent,
                            name: spec.name,
                            error: error.clone(),
                        });
                        self.rejected.push(Rejected {
                            parent,
                            name: spec.name,
                            required: spec.required,
                            reason: Reject::Config(error),
                        });
                    }
                }
                Row::Group {
                    disabled: true,
                    rows,
                    ..
                } => self.reject_off(parent, rows),
                Row::Group {
                    name,
                    disabled: false,
                    rows,
                } => {
                    let group = Fiber::new(
                        name,
                        Some(parent),
                        Vec::new(),
                        false,
                        None,
                        Value::Null,
                        None,
                    );
                    let id = self.alloc(group);
                    if let Some(f) = self.fiber_mut(id) {
                        f.plugin = Some(Box::new(Group { rows: rows.clone() }));
                    }
                    self.adopt(parent, id);
                }
            }
        }
        Ok(())
    }

    /// 停用的 group 底下的必掛列一樣要記下來，否則 `check_required` 看不到它們沒掛。
    fn reject_off(&mut self, parent: FiberId, rows: &[Row]) {
        for row in rows {
            match row {
                Row::Plugin { spec, .. } => self.rejected.push(Rejected {
                    parent,
                    name: spec.name,
                    required: spec.required,
                    reason: Reject::Off,
                }),
                Row::Group { rows, .. } => self.reject_off(parent, rows),
            }
        }
    }

    fn mount_spec(
        &mut self,
        parent: FiberId,
        spec: &'static Spec,
        config: Value,
    ) -> Result<FiberId, KernelError> {
        self.can_register(parent)?;
        config::reject_js_expr(&config)?;
        let mut inject = Vec::with_capacity(spec.inject.len());
        for i in spec.inject {
            let range = match i.range {
                Some(text) => Some((
                    Range::parse(text).map_err(|e| {
                        ConfigError(format!("{} 的 inject {}：{e}", spec.name, i.name))
                    })?,
                    text,
                )),
                None => None,
            };
            inject.push((i.name, range));
        }
        let plugin = (spec.build)(&config)?;
        let id = self.alloc(Fiber::new(
            spec.name,
            Some(parent),
            inject,
            spec.required,
            Some(spec),
            config,
            Some(plugin),
        ));
        self.adopt(parent, id);
        Ok(id)
    }

    fn adopt(&mut self, parent: FiberId, child: FiberId) {
        if let Some(p) = self.fiber_mut(parent) {
            p.entries.push(Entry::Child(child));
        }
        self.dirty.push_back(child);
    }

    /// 這個 fiber 現在能不能再登記東西：還沒被收掉，也不在卸載途中。
    fn can_register(&self, id: FiberId) -> Result<(), KernelError> {
        let f = self.fiber(id).ok_or(KernelError::UnknownFiber)?;
        if !f.alive
            || f.state == State::Unloading
            || !matches!(f.phase, Phase::Idle | Phase::Loading { .. })
        {
            return Err(KernelError::InactiveEffect);
        }
        Ok(())
    }

    /// 全樹看得到的那個實體：有人提供、提供者是 ACTIVE。
    fn visible_uid(&self, name: &str) -> Option<u64> {
        let uid = self.store.uid_of(name)?;
        let imp = self.store.get(uid)?;
        (self.fiber(imp.owner)?.state == State::Active).then_some(uid)
    }

    fn alloc(&mut self, fiber: Fiber) -> FiberId {
        match self.free.pop() {
            Some(index) => {
                let slot = &mut self.slots[index as usize];
                slot.fiber = Some(fiber);
                FiberId {
                    index,
                    generation: slot.generation,
                }
            }
            None => {
                self.slots.push(Slot {
                    generation: 0,
                    fiber: Some(fiber),
                });
                FiberId {
                    index: (self.slots.len() - 1) as u32,
                    generation: 0,
                }
            }
        }
    }

    fn release_slot(&mut self, id: FiberId) {
        if let Some(slot) = self.slots.get_mut(id.index as usize) {
            if slot.generation == id.generation && slot.fiber.is_some() {
                slot.fiber = None;
                // generation 用完的槽位不再重用：繞回 0 會讓舊編號指到新 fiber。
                if let Some(next) = slot.generation.checked_add(1) {
                    slot.generation = next;
                    self.free.push(id.index);
                }
            }
        }
    }

    fn fiber(&self, id: FiberId) -> Option<&Fiber> {
        let slot = self.slots.get(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        slot.fiber.as_ref()
    }

    fn fiber_mut(&mut self, id: FiberId) -> Option<&mut Fiber> {
        let slot = self.slots.get_mut(id.index as usize)?;
        if slot.generation != id.generation {
            return None;
        }
        slot.fiber.as_mut()
    }

    fn fibers(&self) -> impl Iterator<Item = &Fiber> {
        self.slots.iter().filter_map(|s| s.fiber.as_ref())
    }

    fn ids(&self) -> Vec<FiberId> {
        self.slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.fiber.is_some())
            .map(|(index, s)| FiberId {
                index: index as u32,
                generation: s.generation,
            })
            .collect()
    }
}

/// group：apply 時把自己的列掛成子 fiber。group 沒有設定也沒有依賴，掛上之後不會重新 apply。
struct Group {
    rows: Vec<Row>,
}

impl Plugin for Group {
    fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
        cx.load(&self.rows)?;
        Ok(Applied::Done)
    }
}

/// 插件在回呼裡拿到的操作面，綁在一個 fiber 上：登記的東西都算這個 fiber 的 effect，fiber 卸載時一起收。
pub struct Cx<'k> {
    pub(crate) kernel: &'k mut Kernel,
    pub(crate) fiber: FiberId,
}

impl Cx<'_> {
    pub fn fiber(&self) -> FiberId {
        self.fiber
    }

    /// 上一次 `run` 傳進來的時間；在 `run` 之外的 [`Kernel::emit`] 裡也是它。`timeout` 與 `interval` 都從它起算。
    pub fn now(&self) -> Instant {
        self.kernel.now
    }

    /// 讀一個服務。只讀得到自己提供的，與 `inject` 宣告了、而且這次 apply 時 committed 的。
    pub fn service<S: Service>(&self) -> Result<&S, KernelError> {
        let uid = self.kernel.service_uid(self.fiber, S::NAME)?;
        service::downcast(
            self.kernel
                .store
                .get(uid)
                .ok_or(KernelError::Inactive { service: S::NAME })?,
        )
    }

    /// 規則同 [`Cx::service`]。改動不會通知依賴者。
    pub fn service_mut<S: Service>(&mut self) -> Result<&mut S, KernelError> {
        let uid = self.kernel.service_uid(self.fiber, S::NAME)?;
        service::downcast_mut(
            self.kernel
                .store
                .get_mut(uid)
                .ok_or(KernelError::Inactive { service: S::NAME })?,
        )
    }

    /// 提供一個服務，算這個 fiber 的 effect，卸載時收回；fiber 是 ACTIVE 時別的 fiber 才看得到。
    /// 同名已經有人提供（包括自己）回 [`KernelError::AlreadyProvided`]；fiber 正在卸載回 [`KernelError::InactiveEffect`]。
    /// 每次 provide 都是新實體，依賴者會跟著重載。
    pub fn provide<S: Service>(&mut self, value: S) -> Result<(), KernelError> {
        self.provide_inner(value, None, None)
    }

    /// 同 [`Cx::provide`]，另外讓宿主連線上的 `call` 照 `S::NAME` 叫得到它（[`Remote`]）。
    pub fn expose<S: Service + Remote>(&mut self, value: S) -> Result<(), KernelError> {
        self.provide_inner(value, None, Some(remote::as_remote::<S>))
    }

    /// 帶版本提供；依賴者宣告的 semver 範圍拿這個版本比。
    pub fn provide_versioned<S: Service>(
        &mut self,
        value: S,
        version: &str,
    ) -> Result<(), KernelError> {
        let version = Version::parse(version).map_err(|e| KernelError::Config(ConfigError(e.0)))?;
        self.provide_inner(value, Some(version), None)
    }

    fn provide_inner<S: Service>(
        &mut self,
        value: S,
        version: Option<Version>,
        remote: Option<remote::AsRemote>,
    ) -> Result<(), KernelError> {
        let k = &mut *self.kernel;
        k.can_register(self.fiber)?;
        let imp = Impl {
            name: S::NAME,
            type_id: std::any::TypeId::of::<S>(),
            value: Box::new(value),
            owner: self.fiber,
            version,
            dependents: Vec::new(),
            remote,
        };
        let uid = match k.store.insert(imp) {
            Ok(uid) => uid,
            Err(existing) => {
                let by = k.store.get(existing).map_or("?", |i| k.fiber_name(i.owner));
                return Err(KernelError::AlreadyProvided {
                    service: S::NAME,
                    by,
                });
            }
        };
        let active = k
            .fiber(self.fiber)
            .is_some_and(|f| f.state == State::Active);
        if let Some(f) = k.fiber_mut(self.fiber) {
            f.entries.push(Entry::Provision(uid));
        }
        if active {
            k.notify_name(S::NAME);
        }
        Ok(())
    }

    /// 登記一個 listener，算這個 fiber 的 effect。派發照全樹登記的先後；重新 apply 時重新登記，排到最後。
    /// 名稱以 `internal/` 開頭回 [`KernelError::Reserved`]。
    pub fn on<E: Event>(
        &mut self,
        callback: impl for<'a> FnMut(&mut Cx<'a>, &E) -> Result<(), PluginError> + 'static,
    ) -> Result<(), KernelError> {
        event::check_name(E::NAME)?;
        self.kernel.can_register(self.fiber)?;
        let id = self.kernel.add_listener(self.fiber, callback);
        if let Some(f) = self.kernel.fiber_mut(self.fiber) {
            f.entries.push(Entry::Listener(id));
        }
        Ok(())
    }

    /// 同步派發，同 [`Kernel::emit`]；listener 的錯不回給呼叫方。
    pub fn emit<E: Event>(&mut self, event: &E) -> Result<(), KernelError> {
        event::check_name(E::NAME)?;
        self.kernel.dispatch(event);
        Ok(())
    }

    /// 掛一個子插件，回它的編號。apply 不在這次呼叫裡發生：在 `run` 裡就是同一次 `run` 稍後；
    /// 從 `run` 之外的 [`Kernel::emit`] 呼叫時，要等下一次 `run`。
    pub fn plugin(&mut self, spec: &'static Spec, config: Value) -> Result<FiberId, KernelError> {
        self.kernel.mount_spec(self.fiber, spec, config)
    }

    /// 同 [`Kernel::load`]，列掛在這個 fiber 底下。
    pub fn load(&mut self, rows: &[Row]) -> Result<(), KernelError> {
        self.kernel.load_rows(self.fiber, rows)
    }

    /// 登記一個收尾工作：卸載時照登記的反序呼叫 [`Effect::dispose`]。fiber 已經被要求收掉或正在卸載回
    /// [`KernelError::InactiveEffect`]。
    pub fn effect(
        &mut self,
        label: &str,
        effect: impl Effect + 'static,
    ) -> Result<(), KernelError> {
        self.kernel.can_register(self.fiber)?;
        if let Some(f) = self.kernel.fiber_mut(self.fiber) {
            f.entries.push(Entry::Effect {
                label: label.to_string(),
                effect: Box::new(effect),
            });
        }
        Ok(())
    }

    pub fn on_dispose(
        &mut self,
        label: &str,
        f: impl FnOnce(&mut Cx<'_>) -> Result<(), PluginError> + 'static,
    ) -> Result<(), KernelError> {
        self.effect(label, OnDispose(Some(f)))
    }

    /// `after` 之後跑一次。
    pub fn timeout(
        &mut self,
        label: &str,
        after: Duration,
        f: impl FnOnce(&mut Cx<'_>) -> Result<(), PluginError> + 'static,
    ) -> Result<(), KernelError> {
        let mut f = Some(f);
        self.add_timer(
            label,
            after,
            None,
            Box::new(move |cx| f.take().map_or(Ok(()), |f| f(cx))),
        )
    }

    /// 每 `every` 跑一次，從 [`Cx::now`] 起算。晚了不補跑；下一次從觸發它的那次 `run` 的時間再起算。
    /// `every` 是 0 回 [`KernelError::ZeroInterval`]：否則 [`Kernel::next_deadline`] 永遠是現在，宿主會空轉。
    pub fn interval(
        &mut self,
        label: &str,
        every: Duration,
        f: impl for<'a> FnMut(&mut Cx<'a>) -> Result<(), PluginError> + 'static,
    ) -> Result<(), KernelError> {
        if every.is_zero() {
            return Err(KernelError::ZeroInterval);
        }
        self.add_timer(label, every, Some(every), Box::new(f))
    }

    fn add_timer(
        &mut self,
        label: &str,
        after: Duration,
        every: Option<Duration>,
        callback: deadline::TimerCallback,
    ) -> Result<(), KernelError> {
        let k = &mut *self.kernel;
        k.can_register(self.fiber)?;
        k.next_timer += 1;
        let id = k.next_timer;
        k.timers.insert(
            id,
            Timer {
                owner: self.fiber,
                label: label.to_string(),
                due: deadline::later(k.now, after),
                every,
                callback: Some(callback),
            },
        );
        if let Some(f) = k.fiber_mut(self.fiber) {
            f.entries.push(Entry::Timer(id));
        }
        Ok(())
    }

    /// 在這個 fiber 底下設一道服務的隔離邊界（#2598），還沒做。
    pub fn isolate(&mut self, _service: &str) -> Result<(), KernelError> {
        self.kernel.not_implemented("isolate", CARD_ISOLATE)
    }

    /// 登記 update 的否決（#2597），還沒做。
    pub fn on_update_veto(&mut self) -> Result<(), KernelError> {
        self.kernel.not_implemented("update 否決", CARD_UPDATE_VETO)
    }
}
