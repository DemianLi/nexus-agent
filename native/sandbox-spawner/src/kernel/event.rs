//! 插件之間的事件。
//!
//! - 事件有型別：listener 收到的是 `&E`，名稱一樣、型別不同的不會收到。
//! - 派發時先取一份 listener 的固定快照，派發途中新登記或收掉的，不影響這一次。
//! - 每個 listener 各自接錯：回錯寫一筆 [`KernelEvent::ListenerFailed`]，其他 listener 照跑，呼叫 `emit` 的一方不會收到這個錯。
//! - listener 派發途中又觸發自己（重入）時，那一次不呼叫它，記成 `ListenerFailed`。
//! - `internal/` 開頭的名稱只給內核用：插件不能登記、也不能送。內核自己的事件走 [`super::Kernel::drain_events`]。

use std::any::{Any, TypeId};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use super::{Cx, FiberId, Kernel, KernelError, KernelEvent, PluginError};

/// 插件之間的事件。`NAME` 不能以 `internal/` 開頭。
pub trait Event: Any {
    const NAME: &'static str;
}

pub const RESERVED_PREFIX: &str = "internal/";

pub(crate) type ListenerFn = dyn for<'a> FnMut(&mut Cx<'a>, &dyn Any) -> Result<(), PluginError>;

pub(crate) struct Listener {
    pub id: u64,
    pub name: &'static str,
    pub type_id: TypeId,
    pub owner: FiberId,
    pub callback: Rc<RefCell<ListenerFn>>,
}

pub(crate) fn check_name(name: &'static str) -> Result<(), KernelError> {
    if name.starts_with(RESERVED_PREFIX) {
        Err(KernelError::Reserved { event: name })
    } else {
        Ok(())
    }
}

impl Kernel {
    pub(crate) fn add_listener<E: Event>(
        &mut self,
        owner: FiberId,
        mut callback: impl for<'a> FnMut(&mut Cx<'a>, &E) -> Result<(), PluginError> + 'static,
    ) -> u64 {
        self.next_listener += 1;
        let id = self.next_listener;
        let erased = move |cx: &mut Cx<'_>, event: &dyn Any| -> Result<(), PluginError> {
            match event.downcast_ref::<E>() {
                Some(event) => callback(cx, event),
                None => Ok(()),
            }
        };
        self.listeners.push(Listener {
            id,
            name: E::NAME,
            type_id: TypeId::of::<E>(),
            owner,
            callback: Rc::new(RefCell::new(erased)),
        });
        id
    }

    pub(crate) fn remove_listener(&mut self, id: u64) {
        self.listeners.retain(|l| l.id != id);
    }

    pub(crate) fn dispatch<E: Event>(&mut self, event: &E) {
        let snapshot: Vec<(FiberId, Rc<RefCell<ListenerFn>>)> = self
            .listeners
            .iter()
            .filter(|l| l.name == E::NAME && l.type_id == TypeId::of::<E>())
            .map(|l| (l.owner, Rc::clone(&l.callback)))
            .collect();
        for (owner, callback) in snapshot {
            let name = self.fiber_name(owner);
            let Ok(mut f) = callback.try_borrow_mut() else {
                self.push_event(KernelEvent::ListenerFailed {
                    fiber: owner,
                    name,
                    event: E::NAME,
                    error: "listener 在派發途中被重入，這一次不呼叫".to_string(),
                });
                continue;
            };
            let started = Instant::now();
            let result = f(&mut Cx { kernel: self, fiber: owner }, event);
            drop(f);
            self.note_slow(owner, E::NAME, started);
            if let Err(error) = result {
                self.push_event(KernelEvent::ListenerFailed { fiber: owner, name, event: E::NAME, error: error.0 });
            }
        }
    }

    pub(crate) fn note_slow(&mut self, owner: FiberId, what: &str, started: Instant) {
        let elapsed = started.elapsed();
        if elapsed > self.limits.slow_callback {
            let name = self.fiber_name(owner);
            self.push_event(KernelEvent::SlowCallback { fiber: owner, name, what: what.to_string(), elapsed });
        }
    }
}
