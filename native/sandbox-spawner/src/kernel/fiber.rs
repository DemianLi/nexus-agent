//! fiber 的狀態機。對外的語意寫在 [`super`] 的模組文件；這裡只寫實作上的不變量。
//!
//! - `target` 是現在該套的 epoch（`None` 是不該啟用），`loaded` 是插件實際 apply 時的 epoch。兩者不同，就要卸載或載入。
//!   epoch 是 `[revision, 依賴實體的 uid…]`：設定改了（revision 加一）或依賴換手，epoch 就不同。
//! - 失敗或自我停用之後 `target` 恆為 `None`，只有 `update` 清得掉。
//! - 只有 [`Kernel::settle`] 呼叫 `step`。`step` 會呼叫插件；插件經 `Cx` 做的登記只把 fiber 排進 `dirty`，
//!   emit 同步呼叫 listener，listener 也一樣，都不會重入 `step`。

use std::mem;
use std::time::Instant;

use super::deadline::{later, Effect, Step};
use super::{
    Applied, Cx, FiberId, Health, Kernel, KernelError, KernelEvent, Plugin, PluginError, Range, Spec, State,
};
use crate::json::Value;

pub(crate) type InjectDecl = (&'static str, Option<(Range, &'static str)>);

pub(crate) enum Entry {
    Child(FiberId),
    Provision(u64),
    Listener(u64),
    Timer(u64),
    Effect { label: String, effect: Box<dyn Effect> },
}

pub(crate) enum PendingDispose {
    Child(FiberId),
    Effect { label: String, effect: Box<dyn Effect>, deadline: Instant },
}

pub(crate) enum Phase {
    Idle,
    /// apply 回了 `Pending`。
    Loading { deadline: Instant },
    /// 已經進 UNLOADING，等依賴自己服務的 fiber 卸載完；已經開始收 effect 的祖先不等（它在等這個 fiber 收完）。
    WaitDependents,
    /// effect 都已開始收，等回 `Pending` 的與子 fiber 收完。
    Disposing { pending: Vec<PendingDispose> },
}

pub(crate) struct Fiber {
    pub name: &'static str,
    pub parent: Option<FiberId>,
    pub inject: Vec<InjectDecl>,
    pub required: bool,
    pub spec: Option<&'static Spec>,
    pub config: Value,
    /// 呼叫插件期間拿出來，回來再放回去。
    pub plugin: Option<Box<dyn Plugin>>,
    /// `update` 建好、下一次 apply 才換上的插件。
    pub next_plugin: Option<Box<dyn Plugin>>,
    pub state: State,
    /// `false` 是已經被要求收掉。
    pub alive: bool,
    /// 被要求收掉之後，已經走完一次卸載。
    pub drained: bool,
    pub error: Option<String>,
    pub disabled: Option<String>,
    pub revision: u64,
    pub target: Option<Vec<u64>>,
    pub loaded: Option<Vec<u64>>,
    /// 這次 apply 用到的依賴實體：`(名稱, uid)`。
    pub committed: Vec<(&'static str, u64)>,
    pub entries: Vec<Entry>,
    pub phase: Phase,
    /// 已經送過 `ContractMismatch` 的實體 uid。
    pub mismatch_seen: Vec<u64>,
}

impl Fiber {
    pub fn new(
        name: &'static str,
        parent: Option<FiberId>,
        inject: Vec<InjectDecl>,
        required: bool,
        spec: Option<&'static Spec>,
        config: Value,
        plugin: Option<Box<dyn Plugin>>,
    ) -> Fiber {
        Fiber {
            name,
            parent,
            inject,
            required,
            spec,
            config,
            plugin,
            next_plugin: None,
            state: State::Pending,
            alive: true,
            drained: false,
            error: None,
            disabled: None,
            revision: 0,
            target: None,
            loaded: None,
            committed: Vec::new(),
            entries: Vec::new(),
            phase: Phase::Idle,
            mismatch_seen: Vec::new(),
        }
    }

    fn provisions(&self) -> impl Iterator<Item = u64> + '_ {
        self.entries.iter().filter_map(|e| match e {
            Entry::Provision(uid) => Some(*uid),
            _ => None,
        })
    }
}

enum Resolve {
    Found(u64),
    Missing,
    Mismatch(u64),
}

impl Kernel {
    pub(crate) fn request_dispose(&mut self, id: FiberId) {
        if let Some(f) = self.fiber_mut(id) {
            f.alive = false;
            self.dirty.push_back(id);
        }
    }

    /// 宣告依賴 `name` 的 fiber 都重新看一次自己的依賴。
    pub(crate) fn notify_name(&mut self, name: &str) {
        for id in self.ids() {
            if self.fiber(id).is_some_and(|f| f.inject.iter().any(|(n, _)| *n == name)) {
                self.dirty.push_back(id);
            }
        }
    }

    /// `Cx::service` 取得到的實體：自己提供的，或宣告了、committed 了的。
    pub(crate) fn service_uid(&self, id: FiberId, name: &'static str) -> Result<u64, KernelError> {
        let f = self.fiber(id).ok_or(KernelError::UnknownFiber)?;
        for uid in f.provisions() {
            if self.store.get(uid).is_some_and(|i| i.name == name) {
                return Ok(uid);
            }
        }
        if !f.inject.iter().any(|(n, _)| *n == name) {
            return Err(KernelError::Undeclared { service: name });
        }
        f.committed.iter().find(|(n, _)| *n == name).map(|(_, uid)| *uid).ok_or(KernelError::Inactive { service: name })
    }

    pub(crate) fn health(&self, id: FiberId) -> Health {
        let Some(f) = self.fiber(id) else { return Health::Disposed };
        match f.state {
            State::Active => Health::Active,
            State::Loading => Health::Loading,
            State::Unloading => Health::Unloading,
            State::Disposed => Health::Disposed,
            State::Failed => match (&f.disabled, &f.error) {
                (Some(reason), _) => Health::SelfDisabled(reason.clone()),
                (None, Some(error)) => Health::Failed(error.clone()),
                (None, None) => Health::Failed(String::new()),
            },
            State::Pending => Health::Waiting {
                missing: f
                    .inject
                    .iter()
                    .filter(|decl| !matches!(self.resolve(id, decl), Resolve::Found(_)))
                    .map(|(name, _)| *name)
                    .collect(),
            },
        }
    }

    fn resolve(&self, id: FiberId, (name, range): &InjectDecl) -> Resolve {
        let Some(uid) = self.store.uid_of(name) else { return Resolve::Missing };
        let Some(imp) = self.store.get(uid) else { return Resolve::Missing };
        if imp.owner == id || self.fiber(imp.owner).map(|f| f.state) != Some(State::Active) {
            return Resolve::Missing;
        }
        if let Some((range, _)) = range {
            if !imp.version.is_some_and(|v| range.satisfies(v)) {
                return Resolve::Mismatch(uid);
            }
        }
        Resolve::Found(uid)
    }

    fn compute_target(&mut self, id: FiberId) -> Option<Vec<u64>> {
        let f = self.fiber(id)?;
        if !f.alive || f.error.is_some() || f.disabled.is_some() {
            return None;
        }
        let mut epoch = vec![f.revision];
        let decls = f.inject.clone();
        let mut missing = false;
        for decl in &decls {
            match self.resolve(id, decl) {
                Resolve::Found(uid) => epoch.push(uid),
                Resolve::Missing => missing = true,
                Resolve::Mismatch(uid) => {
                    missing = true;
                    self.report_mismatch(id, decl, uid);
                }
            }
        }
        (!missing).then_some(epoch)
    }

    fn report_mismatch(&mut self, id: FiberId, (service, range): &InjectDecl, uid: u64) {
        let version = self.store.get(uid).and_then(|i| i.version).map(|v| v.to_string());
        let Some(f) = self.fiber_mut(id) else { return };
        if f.mismatch_seen.contains(&uid) {
            return;
        }
        f.mismatch_seen.push(uid);
        let name = f.name;
        let range = range.map_or_else(String::new, |(_, text)| text.to_string());
        self.push_event(KernelEvent::ContractMismatch { fiber: id, name, service, range, version });
    }

    /// 把 `dirty` 裡的 fiber 推進到推不動為止，最多 `max_steps` 步。
    pub(crate) fn settle(&mut self) {
        let mut steps = 0;
        while let Some(id) = self.dirty.pop_front() {
            if steps >= self.limits.max_steps {
                self.dirty.push_front(id);
                self.push_event(KernelEvent::Overrun);
                return;
            }
            steps += 1;
            self.step(id);
        }
    }

    fn step(&mut self, id: FiberId) {
        let Some(f) = self.fiber(id) else { return };
        match f.phase {
            Phase::Loading { .. } => {
                if !f.alive {
                    self.cancel_plugin(id);
                    self.start_unload(id);
                }
                return;
            }
            Phase::WaitDependents | Phase::Disposing { .. } => {
                self.advance_unload(id);
                return;
            }
            Phase::Idle => {}
        }
        let target = self.compute_target(id);
        let Some(f) = self.fiber_mut(id) else { return };
        f.target = target.clone();
        if f.loaded != target {
            if f.loaded.is_none() {
                self.start_load(id);
            } else {
                self.start_unload(id);
            }
        } else if !f.alive && !f.drained {
            self.start_unload(id);
        } else {
            let state = derive_state(f);
            self.set_state(id, state);
            if state == State::Disposed {
                self.finalize(id);
            }
        }
    }

    fn start_load(&mut self, id: FiberId) {
        let Some(f) = self.fiber_mut(id) else { return };
        f.loaded = f.target.clone();
        if let Some(next) = f.next_plugin.take() {
            f.plugin = Some(next);
        }
        let uids: Vec<u64> = f.loaded.as_ref().map_or_else(Vec::new, |e| e[1..].to_vec());
        f.committed = f.inject.iter().map(|(name, _)| *name).zip(uids.iter().copied()).collect();
        for uid in uids {
            if let Some(imp) = self.store.get_mut(uid) {
                imp.dependents.push(id);
            }
        }
        self.set_state(id, State::Loading);
        let result = self.call_plugin(id, Call::Apply);
        self.after_apply(id, result);
    }

    fn after_apply(&mut self, id: FiberId, result: Option<Result<Applied, PluginError>>) {
        match result {
            None | Some(Ok(Applied::Done)) => self.finish_load(id),
            Some(Ok(Applied::Pending)) => {
                let deadline = later(self.now, self.limits.apply);
                if let Some(f) = self.fiber_mut(id) {
                    if !matches!(f.phase, Phase::Loading { .. }) {
                        f.phase = Phase::Loading { deadline };
                    }
                }
            }
            Some(Ok(Applied::Disabled(reason))) => {
                let name = self.fiber_name(id);
                let superseded = self.superseded(id);
                if let Some(f) = self.fiber_mut(id).filter(|_| !superseded) {
                    f.disabled = Some(reason.clone());
                    f.target = None;
                }
                self.push_event(KernelEvent::SelfDisabled { fiber: id, name, reason });
                self.start_unload(id);
            }
            Some(Err(error)) => self.fail(id, error.0),
        }
    }

    fn finish_load(&mut self, id: FiberId) {
        if let Some(f) = self.fiber_mut(id) {
            f.phase = Phase::Idle;
        }
        let target = self.compute_target(id);
        let Some(f) = self.fiber_mut(id) else { return };
        f.target = target;
        if f.alive && f.loaded == f.target {
            self.set_state(id, State::Active);
        } else {
            self.start_unload(id);
        }
    }

    fn fail(&mut self, id: FiberId, error: String) {
        let name = self.fiber_name(id);
        let superseded = self.superseded(id);
        if let Some(f) = self.fiber_mut(id).filter(|_| !superseded) {
            f.error = Some(error.clone());
            f.target = None;
        }
        self.push_event(KernelEvent::ApplyFailed { fiber: id, name, error });
        self.start_unload(id);
    }

    /// apply 跑的期間來了 `update`：這次 apply 的結果不算數，卸載後用新設定重來；事件照發，但不記成失敗或自我停用。
    fn superseded(&self, id: FiberId) -> bool {
        self.fiber(id).is_some_and(|f| f.next_plugin.is_some())
    }

    fn start_unload(&mut self, id: FiberId) {
        let Some(f) = self.fiber_mut(id) else { return };
        f.phase = Phase::WaitDependents;
        self.set_state(id, State::Unloading);
        self.advance_unload(id);
    }

    fn advance_unload(&mut self, id: FiberId) {
        let Some(f) = self.fiber(id) else { return };
        if matches!(f.phase, Phase::WaitDependents) {
            let waiting = f.provisions().any(|uid| {
                self.store.get(uid).is_some_and(|i| i.dependents.iter().any(|d| *d != id && !self.collecting(*d, id)))
            });
            if waiting {
                return;
            }
            self.begin_disposing(id);
        }
        let mut done = false;
        let mut alive_children = Vec::new();
        if let Some(Phase::Disposing { pending }) = self.fiber(id).map(|f| &f.phase) {
            alive_children =
                pending.iter().filter_map(|p| if let PendingDispose::Child(c) = p { Some(*c) } else { None }).collect();
        }
        alive_children.retain(|c| self.fiber(*c).is_some());
        if let Some(f) = self.fiber_mut(id) {
            if let Phase::Disposing { pending } = &mut f.phase {
                pending.retain(|p| match p {
                    PendingDispose::Child(c) => alive_children.contains(c),
                    PendingDispose::Effect { .. } => true,
                });
                done = pending.is_empty();
            }
        }
        if done {
            self.finish_unload(id);
        }
    }

    /// `dependent` 是 `id` 的祖先、而且已經開始收 effect：它在等 `id` 這個子孫收完，`id` 不能反過來等它。
    fn collecting(&self, dependent: FiberId, id: FiberId) -> bool {
        if !matches!(self.fiber(dependent).map(|f| &f.phase), Some(Phase::Disposing { .. })) {
            return false;
        }
        let mut at = self.fiber(id).and_then(|f| f.parent);
        while let Some(p) = at {
            if p == dependent {
                return true;
            }
            at = self.fiber(p).and_then(|f| f.parent);
        }
        false
    }

    /// 照登記的反序開始收每一個 effect。一次從 `entries` 尾端拿一個：還沒輪到的服務留在原處，比服務晚登記的 effect
    /// 在 dispose 裡讀得到；回 `Pending` 之後的 poll 讀不到。
    fn begin_disposing(&mut self, id: FiberId) {
        let Some(f) = self.fiber_mut(id) else { return };
        f.phase = Phase::Disposing { pending: Vec::new() };
        // 這個 fiber 底下被拒的列跟子 fiber 一起作廢；重新 apply 時 load 會再記一次。
        self.rejected.retain(|r| r.parent != id);
        let mut pending = Vec::new();
        while let Some(entry) = self.fiber_mut(id).and_then(|f| f.entries.pop()) {
            match entry {
                Entry::Child(child) => {
                    if self.fiber(child).is_some() {
                        self.request_dispose(child);
                        pending.push(PendingDispose::Child(child));
                    }
                }
                Entry::Provision(uid) => {
                    if let Some(imp) = self.store.remove(uid) {
                        self.notify_name(imp.name);
                    }
                }
                Entry::Listener(lid) => self.remove_listener(lid),
                Entry::Timer(tid) => {
                    self.timers.remove(&tid);
                }
                Entry::Effect { label, mut effect } => {
                    let started = Instant::now();
                    let result = effect.dispose(&mut Cx { kernel: self, fiber: id });
                    self.note_slow(id, &label, started);
                    match result {
                        Ok(Step::Done) => {}
                        Ok(Step::Pending) => {
                            let deadline = later(self.now, self.limits.dispose);
                            pending.push(PendingDispose::Effect { label, effect, deadline });
                        }
                        Err(error) => self.dispose_failed(id, label, error.0),
                    }
                }
            }
        }
        if let Some(f) = self.fiber_mut(id) {
            if let Phase::Disposing { pending: slot } = &mut f.phase {
                slot.extend(pending);
            }
        }
    }

    fn dispose_failed(&mut self, id: FiberId, label: String, error: String) {
        let name = self.fiber_name(id);
        self.push_event(KernelEvent::DisposeFailed { fiber: id, name, label, error });
    }

    fn finish_unload(&mut self, id: FiberId) {
        let Some(f) = self.fiber_mut(id) else { return };
        let committed = mem::take(&mut f.committed);
        f.loaded = None;
        f.phase = Phase::Idle;
        if !f.alive {
            f.drained = true;
        }
        for (_, uid) in committed {
            if let Some(imp) = self.store.get_mut(uid) {
                imp.dependents.retain(|d| *d != id);
                if imp.dependents.is_empty() {
                    let owner = imp.owner;
                    self.dirty.push_back(owner);
                }
            }
        }
        self.dirty.push_back(id);
    }

    /// DISPOSED 的 fiber 從父 fiber 的 effect 拿掉，編號作廢；父 fiber 卸載時在等子 fiber 收完，所以把它排進待做。
    fn finalize(&mut self, id: FiberId) {
        let parent = self.fiber(id).and_then(|f| f.parent);
        if let Some(parent) = parent {
            if let Some(p) = self.fiber_mut(parent) {
                p.entries.retain(|e| !matches!(e, Entry::Child(c) if *c == id));
            }
            self.dirty.push_back(parent);
        }
        self.release_slot(id);
    }

    fn set_state(&mut self, id: FiberId, state: State) {
        let Some(f) = self.fiber_mut(id) else { return };
        let from = f.state;
        if from == state {
            return;
        }
        f.state = state;
        let name = f.name;
        let provided: Vec<u64> = f.provisions().collect();
        self.push_event(KernelEvent::Status { fiber: id, name, from, to: state });
        if from == State::Active || state == State::Active {
            for uid in provided {
                if let Some(service) = self.store.get(uid).map(|i| i.name) {
                    self.notify_name(service);
                }
            }
        }
    }

    /// 沒有插件（根 fiber）回 `None`。
    fn call_plugin(&mut self, id: FiberId, call: Call) -> Option<Result<Applied, PluginError>> {
        let mut plugin = self.fiber_mut(id)?.plugin.take()?;
        let started = Instant::now();
        let result = {
            let mut cx = Cx { kernel: self, fiber: id };
            match call {
                Call::Apply => plugin.apply(&mut cx),
                Call::Poll => plugin.poll(&mut cx),
            }
        };
        self.note_slow(id, call.label(), started);
        if let Some(f) = self.fiber_mut(id) {
            f.plugin = Some(plugin);
        }
        Some(result)
    }

    fn cancel_plugin(&mut self, id: FiberId) {
        if let Some(f) = self.fiber_mut(id) {
            if let Some(plugin) = f.plugin.as_mut() {
                plugin.cancel();
            }
            f.phase = Phase::Idle;
        }
    }

    /// poll 每一個回了 `Pending` 的 apply 與收尾一次；到了時限的先 `cancel`，算成逾時。
    pub(crate) fn poll_pending(&mut self) {
        let now = self.now;
        for id in self.ids() {
            let phase = self.fiber(id).map(|f| match f.phase {
                Phase::Loading { deadline } => Some(deadline),
                _ => None,
            });
            match phase {
                Some(Some(deadline)) => {
                    if now >= deadline {
                        self.cancel_plugin(id);
                        self.fail(id, format!("apply 超過時限 {:?}", self.limits.apply));
                    } else {
                        let result = self.call_plugin(id, Call::Poll);
                        if !matches!(result, Some(Ok(Applied::Pending))) {
                            if let Some(f) = self.fiber_mut(id) {
                                f.phase = Phase::Idle;
                            }
                        }
                        self.after_apply(id, result);
                    }
                }
                Some(None) => self.poll_disposing(id, now),
                None => {}
            }
        }
    }

    fn poll_disposing(&mut self, id: FiberId, now: Instant) {
        let pending = match self.fiber_mut(id).map(|f| &mut f.phase) {
            Some(Phase::Disposing { pending }) => mem::take(pending),
            _ => return,
        };
        let mut keep = Vec::new();
        for p in pending {
            match p {
                PendingDispose::Child(_) => keep.push(p),
                PendingDispose::Effect { label, mut effect, deadline } => {
                    if now >= deadline {
                        effect.cancel();
                        self.dispose_failed(id, label, format!("收尾超過時限 {:?}", self.limits.dispose));
                        continue;
                    }
                    let started = Instant::now();
                    let result = effect.poll(&mut Cx { kernel: self, fiber: id });
                    self.note_slow(id, &label, started);
                    match result {
                        Ok(Step::Done) => {}
                        Ok(Step::Pending) => keep.push(PendingDispose::Effect { label, effect, deadline }),
                        Err(error) => self.dispose_failed(id, label, error.0),
                    }
                }
            }
        }
        if let Some(Phase::Disposing { pending }) = self.fiber_mut(id).map(|f| &mut f.phase) {
            pending.extend(keep);
        }
        self.dirty.push_back(id);
    }

    /// 跑到期的計時器，照到期時間的先後。
    pub(crate) fn fire_timers(&mut self) {
        let now = self.now;
        let mut due: Vec<(Instant, u64)> =
            self.timers.iter().filter(|(_, t)| t.due <= now).map(|(id, t)| (t.due, *id)).collect();
        due.sort();
        for (_, tid) in due {
            let Some(timer) = self.timers.get_mut(&tid) else { continue };
            let Some(mut callback) = timer.callback.take() else { continue };
            let owner = timer.owner;
            let label = timer.label.clone();
            let started = Instant::now();
            let result = callback(&mut Cx { kernel: self, fiber: owner });
            self.note_slow(owner, &label, started);
            if let Err(error) = result {
                let name = self.fiber_name(owner);
                self.push_event(KernelEvent::TimerFailed { fiber: owner, name, label, error: error.0 });
            }
            let repeat = match self.timers.get_mut(&tid) {
                Some(timer) => match timer.every {
                    Some(every) => {
                        timer.due = later(now, every);
                        timer.callback = Some(callback);
                        true
                    }
                    None => false,
                },
                None => true,
            };
            if !repeat {
                self.timers.remove(&tid);
                if let Some(f) = self.fiber_mut(owner) {
                    f.entries.retain(|e| !matches!(e, Entry::Timer(t) if *t == tid));
                }
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Call {
    Apply,
    Poll,
}

impl Call {
    fn label(self) -> &'static str {
        match self {
            Call::Apply => "apply",
            Call::Poll => "poll",
        }
    }
}

fn derive_state(f: &Fiber) -> State {
    if !f.alive {
        State::Disposed
    } else if f.error.is_some() || f.disabled.is_some() {
        State::Failed
    } else if f.loaded.is_some() {
        State::Active
    } else {
        State::Pending
    }
}
