//! 插件樹內核（`kernel`）的語意，一條測試釘一條。對照的語意清單見 `.docs/rust-kernel-2569-2026-11-09.md`。

use std::cell::RefCell;
use std::time::{Duration, Instant};

use nexus_host::json::{self, Value};
use nexus_host::kernel::config::{self, Fields};
use nexus_host::kernel::{
    Applied, ConfigError, Cx, Effect, Event, FiberId, Health, Inject, Kernel, KernelError,
    KernelEvent, Limits, Plugin, PluginError, Range, RequiredProblem, Row, Service, Spec, State,
    Step, Version, CARD_ISOLATE, CARD_LOADER_DIFF, CARD_UPDATE_VETO,
};

thread_local! {
    static LOG: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
}

fn log(line: String) {
    LOG.with(|l| l.borrow_mut().push(line));
}

fn take_log() -> Vec<String> {
    LOG.with(|l| std::mem::take(&mut *l.borrow_mut()))
}

struct Counter(i64);
impl Service for Counter {
    const NAME: &'static str = "counter";
}

/// 名稱跟 `Counter` 一樣、型別不同。
struct NotCounter;
impl Service for NotCounter {
    const NAME: &'static str = "counter";
}

struct Ping(u32);
impl Event for Ping {
    const NAME: &'static str = "test/ping";
}

struct Internal;
impl Event for Internal {
    const NAME: &'static str = "internal/test";
}

/// 一支照設定改變行為的插件，每個動作都寫進 `LOG`，前面帶 `tag`。
struct Probe {
    tag: String,
    provide: Option<i64>,
    version: Option<String>,
    read: bool,
    fail: Option<String>,
    pending: i64,
    polls: i64,
    disable: Option<String>,
    dispose_pending: bool,
    wrong_type: bool,
}

fn build_probe(value: &Value) -> Result<Box<dyn Plugin>, ConfigError> {
    let mut f = Fields::new(value)?;
    let probe = Probe {
        tag: f.str("tag")?.to_string(),
        provide: f.opt_int("provide")?,
        version: f.opt_str("version")?.map(str::to_string),
        read: f.opt_bool("read")?.unwrap_or(false),
        fail: f.opt_str("fail")?.map(str::to_string),
        pending: f.opt_int("pending")?.unwrap_or(0),
        polls: 0,
        disable: f.opt_str("disable")?.map(str::to_string),
        dispose_pending: f.opt_bool("dispose_pending")?.unwrap_or(false),
        wrong_type: f.opt_bool("wrong_type")?.unwrap_or(false),
    };
    f.finish()?;
    Ok(Box::new(probe))
}

impl Plugin for Probe {
    fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
        let tag = self.tag.clone();
        log(format!("{tag}:apply"));
        self.polls = 0;
        let t = tag.clone();
        cx.on_dispose("log", move |cx| {
            let seen = cx.service::<Counter>().map(|c| c.0).ok();
            log(format!("{t}:dispose:{seen:?}"));
            Ok(())
        })?;
        if let Some(v) = self.provide {
            match &self.version {
                Some(version) => cx.provide_versioned(Counter(v), version)?,
                None => cx.provide(Counter(v))?,
            }
        }
        if self.read {
            if self.wrong_type {
                cx.service::<NotCounter>()?;
            }
            let v = cx.service::<Counter>()?.0;
            log(format!("{tag}:read:{v}"));
        }
        if self.dispose_pending {
            cx.effect("forever", Forever { tag: tag.clone() })?;
        }
        if let Some(reason) = &self.disable {
            return Ok(Applied::Disabled(reason.clone()));
        }
        if let Some(error) = &self.fail {
            return Err(error.as_str().into());
        }
        if self.pending != 0 {
            return Ok(Applied::Pending);
        }
        Ok(Applied::Done)
    }

    fn poll(&mut self, _cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
        self.polls += 1;
        log(format!("{}:poll", self.tag));
        if self.pending < 0 || self.polls < self.pending {
            Ok(Applied::Pending)
        } else {
            Ok(Applied::Done)
        }
    }

    fn cancel(&mut self) {
        log(format!("{}:cancel", self.tag));
    }
}

/// 收尾永遠回 `Pending`。
struct Forever {
    tag: String,
}

impl Effect for Forever {
    fn dispose(&mut self, _cx: &mut Cx<'_>) -> Result<Step, PluginError> {
        Ok(Step::Pending)
    }

    fn poll(&mut self, _cx: &mut Cx<'_>) -> Result<Step, PluginError> {
        Ok(Step::Pending)
    }

    fn cancel(&mut self) {
        log(format!("{}:forever-cancel", self.tag));
    }
}

static PROVIDER: Spec = Spec {
    name: "provider",
    inject: &[],
    required: false,
    build: build_probe,
};
static CONSUMER: Spec = Spec {
    name: "consumer",
    inject: &[Inject::new("counter")],
    required: false,
    build: build_probe,
};
static CONSUMER_V1: Spec = Spec {
    name: "consumer-v1",
    inject: &[Inject::with_range("counter", "^1.2.0")],
    required: false,
    build: build_probe,
};
static BAD_RANGE: Spec = Spec {
    name: "bad-range",
    inject: &[Inject::with_range("counter", "1.x")],
    required: false,
    build: build_probe,
};
static REQUIRED: Spec = Spec {
    name: "required",
    inject: &[],
    required: true,
    build: build_probe,
};
static REQUIRED_CONSUMER: Spec = Spec {
    name: "required-consumer",
    inject: &[Inject::new("counter")],
    required: true,
    build: build_probe,
};

fn cfg(text: &str) -> Value {
    json::parse(text.as_bytes()).expect("測試設定要是合法 JSON")
}

fn kernel() -> (Kernel, Instant) {
    let t0 = Instant::now();
    let mut k = Kernel::new(Limits::default(), t0);
    k.set_log(|line| log(format!("log:{line}")));
    (k, t0)
}

/// 跑到樹穩定為止（不前進時間）。
fn settle(k: &mut Kernel, now: Instant) {
    for _ in 0..50 {
        k.run(now);
        if k.is_settled() {
            return;
        }
    }
    panic!("50 次 run 之內沒有穩定");
}

fn statuses(events: &[KernelEvent], fiber: FiberId) -> Vec<(State, State)> {
    events
        .iter()
        .filter_map(|e| match e {
            KernelEvent::Status {
                fiber: f, from, to, ..
            } if *f == fiber => Some((*from, *to)),
            _ => None,
        })
        .collect()
}

#[test]
fn a_plugin_goes_through_every_state_and_each_transition_is_an_event() {
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p"}"#)).unwrap();
    assert_eq!(
        k.state(id),
        Some(State::Pending),
        "mount 只記下來，apply 在 run 裡"
    );
    settle(&mut k, t0);
    assert_eq!(k.state(id), Some(State::Active));
    k.dispose(id).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(id), None, "收掉之後舊編號查不到");
    let events = k.drain_events();
    assert_eq!(
        statuses(&events, id),
        vec![
            (State::Pending, State::Loading),
            (State::Loading, State::Active),
            (State::Active, State::Unloading),
            (State::Unloading, State::Disposed),
        ]
    );
}

#[test]
fn a_dependent_waits_in_pending_until_the_service_is_provided() {
    let (mut k, t0) = kernel();
    let c = k
        .mount(k.root(), &CONSUMER, cfg(r#"{"tag":"c","read":true}"#))
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(c), Some(State::Pending));
    let report = k.report().into_iter().find(|r| r.id == c).unwrap();
    assert_eq!(
        report.health,
        Health::Waiting {
            missing: vec!["counter"]
        }
    );
    k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":7}"#))
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(c), Some(State::Active));
    assert!(take_log().contains(&"c:read:7".to_string()));
}

#[test]
fn reading_a_service_that_was_not_injected_is_an_error() {
    let (mut k, t0) = kernel();
    k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":1}"#))
        .unwrap();
    let reader = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"r","read":true}"#))
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(reader), Some(State::Failed));
    let events = k.drain_events();
    let failed = events.iter().find_map(|e| match e {
        KernelEvent::ApplyFailed { fiber, error, .. } if *fiber == reader => Some(error.clone()),
        _ => None,
    });
    assert_eq!(
        failed,
        Some(KernelError::Undeclared { service: "counter" }.to_string())
    );
}

#[test]
fn a_service_is_matched_by_type_as_well_as_name() {
    let (mut k, t0) = kernel();
    k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":1}"#))
        .unwrap();
    let c = k
        .mount(
            k.root(),
            &CONSUMER,
            cfg(r#"{"tag":"c","read":true,"wrong_type":true}"#),
        )
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(c), Some(State::Failed));
    assert!(k.drain_events().iter().any(|e| matches!(e,
        KernelEvent::ApplyFailed { fiber, error, .. }
            if *fiber == c && *error == KernelError::TypeMismatch { service: "counter" }.to_string())));
    assert_eq!(k.service::<Counter>().unwrap().0, 1);
    assert!(matches!(
        k.service::<NotCounter>(),
        Err(KernelError::TypeMismatch { .. })
    ));
}

#[test]
fn a_second_provider_of_the_same_name_fails() {
    let (mut k, t0) = kernel();
    k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"a","provide":1}"#))
        .unwrap();
    let b = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"b","provide":2}"#))
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(b), Some(State::Failed));
    let expected = KernelError::AlreadyProvided {
        service: "counter",
        by: "provider",
    }
    .to_string();
    assert!(k
        .drain_events()
        .iter()
        .any(|e| matches!(e, KernelEvent::ApplyFailed { error, .. } if *error == expected)));
}

#[test]
fn a_new_provider_epoch_reloads_the_dependent() {
    let (mut k, t0) = kernel();
    let p = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":1}"#))
        .unwrap();
    let c = k
        .mount(k.root(), &CONSUMER, cfg(r#"{"tag":"c","read":true}"#))
        .unwrap();
    settle(&mut k, t0);
    take_log();
    k.update(p, &cfg(r#"{"provide":2}"#)).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(c), Some(State::Active));
    let log = take_log();
    assert!(log.contains(&"c:read:2".to_string()), "{log:?}");
    let c_dispose = log.iter().position(|l| l.starts_with("c:dispose")).unwrap();
    let p_dispose = log.iter().position(|l| l.starts_with("p:dispose")).unwrap();
    assert!(c_dispose < p_dispose, "依賴者先收完，提供者才收：{log:?}");
    assert_eq!(
        log[c_dispose], "c:dispose:Some(1)",
        "依賴者收尾時還讀得到舊的服務"
    );
}

#[test]
fn a_dependent_is_unloaded_before_its_provider_and_can_still_read_it() {
    let (mut k, t0) = kernel();
    let p = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":5}"#))
        .unwrap();
    let c = k.mount(k.root(), &CONSUMER, cfg(r#"{"tag":"c"}"#)).unwrap();
    settle(&mut k, t0);
    take_log();
    k.dispose(p).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        take_log(),
        vec![
            "c:dispose:Some(5)".to_string(),
            "p:dispose:None".to_string()
        ]
    );
    assert_eq!(k.state(c), Some(State::Pending), "依賴者沒被收掉，回去等");
}

#[test]
fn effects_of_one_fiber_are_disposed_in_reverse_order() {
    struct Two;
    impl Plugin for Two {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.on_dispose("first", |_| {
                log("first".into());
                Ok(())
            })?;
            cx.on_dispose("second", |_| {
                log("second".into());
                Ok(())
            })?;
            Ok(Applied::Done)
        }
    }
    static TWO: Spec = Spec {
        name: "two",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Two)),
    };
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &TWO, Value::Null).unwrap();
    settle(&mut k, t0);
    k.dispose(id).unwrap();
    settle(&mut k, t0);
    assert_eq!(take_log(), vec!["second".to_string(), "first".to_string()]);
}

#[test]
fn children_are_collected_with_their_parent() {
    static PARENT: Spec = Spec {
        name: "parent",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Parent)),
    };
    struct Parent;
    impl Plugin for Parent {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.plugin(&PROVIDER, cfg(r#"{"tag":"child","dispose_pending":true}"#))?;
            Ok(Applied::Done)
        }
    }
    let (mut k, t0) = kernel();
    let parent = k.mount(k.root(), &PARENT, Value::Null).unwrap();
    settle(&mut k, t0);
    let child = k
        .report()
        .into_iter()
        .find(|r| r.parent == Some(parent))
        .unwrap()
        .id;
    assert_eq!(k.state(child), Some(State::Active));
    k.dispose(parent).unwrap();
    k.run(t0);
    assert_eq!(
        k.state(child),
        Some(State::Unloading),
        "子 fiber 的收尾還沒完"
    );
    assert_eq!(
        k.state(parent),
        Some(State::Unloading),
        "父 fiber 等子 fiber 收完"
    );
    let late = t0 + Limits::default().dispose;
    k.run(late);
    settle(&mut k, late);
    assert_eq!(k.state(child), None);
    assert_eq!(k.state(parent), None);
    assert!(take_log().contains(&"child:dispose:None".to_string()));
}

#[test]
fn a_failed_first_apply_rolls_back_everything_it_registered() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(
            k.root(),
            &PROVIDER,
            cfg(r#"{"tag":"p","provide":3,"fail":"boom"}"#),
        )
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(id), Some(State::Failed));
    assert!(
        take_log().contains(&"p:dispose:None".to_string()),
        "失敗之前登記的 effect 收掉了"
    );
    assert!(
        matches!(k.service::<Counter>(), Err(KernelError::Inactive { .. })),
        "提供的服務也收回了"
    );
    let events = k.drain_events();
    assert!(events.iter().any(|e| matches!(e, KernelEvent::ApplyFailed { fiber, error, .. } if *fiber == id && error == "boom")));
    assert_eq!(
        statuses(&events, id),
        vec![
            (State::Pending, State::Loading),
            (State::Loading, State::Unloading),
            (State::Unloading, State::Failed)
        ]
    );
}

#[test]
fn update_brings_a_failed_fiber_back_and_null_keeps_the_old_value() {
    let (mut k, t0) = kernel();
    k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":3}"#))
        .unwrap();
    let id = k
        .mount(
            k.root(),
            &CONSUMER,
            cfg(r#"{"tag":"c","read":true,"wrong_type":true}"#),
        )
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(id), Some(State::Failed));
    k.update(id, &cfg(r#"{"wrong_type":null}"#)).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        k.state(id),
        Some(State::Failed),
        "null 不覆寫：wrong_type 還是 true"
    );
    take_log();
    k.update(id, &cfg(r#"{"wrong_type":false}"#)).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(id), Some(State::Active), "失敗只有 update 救得回來");
    assert!(take_log().contains(&"c:read:3".to_string()));
}

#[test]
fn a_rejected_update_changes_nothing() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":3}"#))
        .unwrap();
    settle(&mut k, t0);
    take_log();
    assert!(matches!(
        k.update(id, &cfg(r#"{"typo":1}"#)),
        Err(KernelError::Config(_))
    ));
    assert!(matches!(
        k.update(id, &cfg(r#"{"x":{"__jsExpr":"1"}}"#)),
        Err(KernelError::Config(_))
    ));
    settle(&mut k, t0);
    assert_eq!(k.state(id), Some(State::Active));
    assert!(take_log().is_empty(), "沒有重新 apply");
    assert_eq!(k.service::<Counter>().unwrap().0, 3);
    k.update(id, &cfg(r#"{"provide":4}"#))
        .expect("被拒的鍵沒有留在設定裡");
    settle(&mut k, t0);
    assert_eq!(k.service::<Counter>().unwrap().0, 4);
}

#[test]
fn a_pending_apply_is_polled_until_done() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","pending":2}"#))
        .unwrap();
    k.run(t0);
    assert_eq!(
        k.state(id),
        Some(State::Loading),
        "同一輪 run 裡 apply 之後已經 poll 過一次"
    );
    k.run(t0);
    assert_eq!(k.state(id), Some(State::Active));
    assert_eq!(take_log(), vec!["p:apply", "p:poll", "p:poll"]);
}

#[test]
fn an_apply_past_its_deadline_is_cancelled_and_fails() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","pending":-1}"#))
        .unwrap();
    k.run(t0);
    assert_eq!(k.next_deadline(), Some(t0 + Limits::default().apply));
    k.run(t0 + Limits::default().apply);
    settle(&mut k, t0 + Limits::default().apply);
    assert_eq!(k.state(id), Some(State::Failed));
    let log = take_log();
    assert!(log.contains(&"p:cancel".to_string()), "{log:?}");
    assert!(log.contains(&"p:dispose:None".to_string()), "逾時也回滾");
}

#[test]
fn disposing_during_a_pending_apply_cancels_it() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","pending":-1}"#))
        .unwrap();
    k.run(t0);
    k.dispose(id).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(id), None);
    let log = take_log();
    assert!(log.contains(&"p:cancel".to_string()), "{log:?}");
}

#[test]
fn a_dispose_past_its_deadline_is_cancelled_and_the_fiber_still_goes_away() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(
            k.root(),
            &PROVIDER,
            cfg(r#"{"tag":"p","dispose_pending":true}"#),
        )
        .unwrap();
    settle(&mut k, t0);
    k.dispose(id).unwrap();
    k.run(t0);
    assert_eq!(k.state(id), Some(State::Unloading));
    let late = t0 + Limits::default().dispose;
    assert_eq!(k.next_deadline(), Some(late));
    k.run(late);
    settle(&mut k, late);
    assert_eq!(k.state(id), None);
    assert!(take_log().contains(&"p:forever-cancel".to_string()));
    assert!(k
        .drain_events()
        .iter()
        .any(|e| matches!(e, KernelEvent::DisposeFailed { label, .. } if label == "forever")));
}

#[test]
fn a_fiber_that_never_activated_still_goes_through_unloading() {
    let (mut k, t0) = kernel();
    let c = k.mount(k.root(), &CONSUMER, cfg(r#"{"tag":"c"}"#)).unwrap();
    let child = k.mount(c, &PROVIDER, cfg(r#"{"tag":"child"}"#)).unwrap();
    settle(&mut k, t0);
    take_log();
    k.dispose(c).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        statuses(&k.drain_events(), c),
        vec![
            (State::Pending, State::Unloading),
            (State::Unloading, State::Disposed)
        ]
    );
    assert_eq!(k.state(child), None);
    assert_eq!(
        take_log(),
        vec!["child:dispose:None"],
        "PENDING 底下的子 fiber 也收了"
    );
}

#[test]
fn a_failed_fiber_still_goes_through_unloading() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","fail":"x"}"#))
        .unwrap();
    settle(&mut k, t0);
    let child = k.mount(id, &PROVIDER, cfg(r#"{"tag":"child"}"#)).unwrap();
    settle(&mut k, t0);
    k.drain_events();
    take_log();
    k.dispose(id).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        statuses(&k.drain_events(), id),
        vec![
            (State::Failed, State::Unloading),
            (State::Unloading, State::Disposed)
        ]
    );
    assert_eq!(k.state(child), None);
    assert_eq!(
        take_log(),
        vec!["child:dispose:None"],
        "FAILED 底下的子 fiber 也收了"
    );
}

#[test]
fn self_disabled_is_reported_apart_from_failed_and_off() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(
            k.root(),
            &REQUIRED,
            cfg(r#"{"tag":"r","disable":"沒有設定金鑰"}"#),
        )
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(id), Some(State::Failed));
    let report = k.report().into_iter().find(|r| r.id == id).unwrap();
    assert_eq!(
        report.health,
        Health::SelfDisabled("沒有設定金鑰".to_string())
    );
    assert!(
        take_log().contains(&"r:dispose:None".to_string()),
        "自我停用也回滾"
    );
    assert!(k.drain_events().iter().any(
        |e| matches!(e, KernelEvent::SelfDisabled { reason, .. } if reason == "沒有設定金鑰")
    ));
    assert_eq!(
        k.check_required(),
        Err(vec![RequiredProblem::NotActive {
            name: "required",
            health: Health::SelfDisabled("沒有設定金鑰".to_string())
        }])
    );
}

#[test]
fn check_required_lists_every_required_row_that_is_not_active() {
    let (mut k, t0) = kernel();
    let rows = vec![
        Row::Plugin {
            spec: &REQUIRED,
            config: cfg(r#"{"tag":"ok"}"#),
            disabled: false,
        },
        Row::Plugin {
            spec: &REQUIRED,
            config: cfg(r#"{"tag":"off"}"#),
            disabled: true,
        },
        Row::Plugin {
            spec: &REQUIRED,
            config: cfg(r#"{"tag":"t","typo":1}"#),
            disabled: false,
        },
        Row::Plugin {
            spec: &REQUIRED_CONSUMER,
            config: cfg(r#"{"tag":"wait"}"#),
            disabled: false,
        },
        Row::Plugin {
            spec: &PROVIDER,
            config: cfg(r#"{"tag":"optional","fail":"x"}"#),
            disabled: false,
        },
    ];
    k.load(k.root(), &rows).unwrap();
    settle(&mut k, t0);
    let problems = k.check_required().unwrap_err();
    assert_eq!(problems.len(), 3, "{problems:?}");
    assert!(problems.contains(&RequiredProblem::NotActive {
        name: "required-consumer",
        health: Health::Waiting {
            missing: vec!["counter"]
        }
    }));
    assert!(problems.contains(&RequiredProblem::Off { name: "required" }));
    assert!(problems.iter().any(|p| matches!(p, RequiredProblem::Rejected { name: "required", error } if error.contains("typo"))));
}

#[test]
fn a_row_with_a_bad_config_is_skipped_and_the_others_are_mounted() {
    let (mut k, t0) = kernel();
    let rows = vec![
        Row::Plugin {
            spec: &PROVIDER,
            config: cfg(r#"{"tag":"a","unknown":1}"#),
            disabled: false,
        },
        Row::Plugin {
            spec: &PROVIDER,
            config: cfg(r#"{"tag":{"__jsExpr":"x"}}"#),
            disabled: false,
        },
        Row::Plugin {
            spec: &PROVIDER,
            config: cfg(r#"{"tag":"b","provide":"one"}"#),
            disabled: false,
        },
        Row::Plugin {
            spec: &BAD_RANGE,
            config: cfg(r#"{"tag":"r"}"#),
            disabled: false,
        },
        Row::Plugin {
            spec: &PROVIDER,
            config: cfg(r#"{"tag":"good"}"#),
            disabled: false,
        },
    ];
    k.load(k.root(), &rows).unwrap();
    settle(&mut k, t0);
    let names: Vec<_> = k.report().into_iter().map(|r| (r.name, r.state)).collect();
    assert_eq!(
        names,
        vec![("root", State::Active), ("provider", State::Active)]
    );
    let rejected: Vec<String> = k
        .drain_events()
        .into_iter()
        .filter_map(|e| match e {
            KernelEvent::ConfigRejected { error, .. } => Some(error),
            _ => None,
        })
        .collect();
    assert_eq!(rejected.len(), 4, "{rejected:?}");
    assert!(rejected[0].contains("unknown"));
    assert!(rejected[1].contains("__jsExpr"));
    assert!(rejected[2].contains("provide"));
    assert!(rejected[3].contains("1.x"));
    assert_eq!(take_log(), vec!["good:apply"]);
}

#[test]
fn a_disabled_group_mounts_nothing_below_it() {
    let (mut k, t0) = kernel();
    let rows = vec![
        Row::Group {
            name: "on",
            disabled: false,
            rows: vec![Row::Plugin {
                spec: &PROVIDER,
                config: cfg(r#"{"tag":"in-on"}"#),
                disabled: false,
            }],
        },
        Row::Group {
            name: "off",
            disabled: true,
            rows: vec![
                Row::Plugin {
                    spec: &PROVIDER,
                    config: cfg(r#"{"tag":"in-off"}"#),
                    disabled: false,
                },
                Row::Group {
                    name: "nested",
                    disabled: false,
                    rows: vec![Row::Plugin {
                        spec: &REQUIRED,
                        config: cfg(r#"{"tag":"deep"}"#),
                        disabled: false,
                    }],
                },
            ],
        },
    ];
    k.load(k.root(), &rows).unwrap();
    settle(&mut k, t0);
    assert_eq!(take_log(), vec!["in-on:apply"]);
    let names: Vec<_> = k.report().into_iter().map(|r| r.name).collect();
    assert_eq!(names, vec!["root", "on", "provider"]);
    assert_eq!(
        k.check_required(),
        Err(vec![RequiredProblem::Off { name: "required" }]),
        "停用的 group 裡的必掛列也看得到"
    );
}

fn group_rows(disabled: bool) -> Vec<Row> {
    vec![Row::Group {
        name: "g",
        disabled,
        rows: vec![
            Row::Plugin {
                spec: &PROVIDER,
                config: cfg(r#"{"tag":"first"}"#),
                disabled: false,
            },
            Row::Group {
                name: "nested",
                disabled: false,
                rows: vec![Row::Plugin {
                    spec: &REQUIRED,
                    config: cfg(r#"{"tag":"second"}"#),
                    disabled: false,
                }],
            },
        ],
    }]
}

#[test]
fn a_group_mounts_its_rows_in_order_unless_it_is_disabled() {
    let (mut k, t0) = kernel();
    k.load(k.root(), &group_rows(true)).unwrap();
    settle(&mut k, t0);
    assert!(take_log().is_empty());
    assert_eq!(k.report().len(), 1, "只剩 root");

    let (mut k, t0) = kernel();
    k.load(k.root(), &group_rows(false)).unwrap();
    settle(&mut k, t0);
    assert_eq!(take_log(), vec!["first:apply", "second:apply"]);
    let names: Vec<_> = k.report().into_iter().map(|r| (r.name, r.state)).collect();
    assert_eq!(
        names,
        vec![
            ("root", State::Active),
            ("g", State::Active),
            ("provider", State::Active),
            ("nested", State::Active),
            ("required", State::Active),
        ]
    );
    assert_eq!(k.check_required(), Ok(()));
}

#[test]
fn a_semver_range_gates_the_dependency_and_a_mismatch_is_reported_once() {
    let (mut k, t0) = kernel();
    let p = k
        .mount(
            k.root(),
            &PROVIDER,
            cfg(r#"{"tag":"p","provide":1,"version":"2.0.0"}"#),
        )
        .unwrap();
    let c = k
        .mount(k.root(), &CONSUMER_V1, cfg(r#"{"tag":"c","read":true}"#))
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(c), Some(State::Pending));
    k.run(t0);
    let mismatches = k
        .drain_events()
        .into_iter()
        .filter(|e| matches!(e, KernelEvent::ContractMismatch { .. }))
        .count();
    assert_eq!(mismatches, 1);
    k.update(p, &cfg(r#"{"version":"1.4.0"}"#)).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(c), Some(State::Active));
}

#[test]
fn a_range_against_a_provider_without_a_version_does_not_match() {
    let (mut k, t0) = kernel();
    k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":1}"#))
        .unwrap();
    let c = k
        .mount(k.root(), &CONSUMER_V1, cfg(r#"{"tag":"c"}"#))
        .unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(c), Some(State::Pending));
    assert!(k
        .drain_events()
        .iter()
        .any(|e| matches!(e, KernelEvent::ContractMismatch { version: None, .. })));
}

#[test]
fn semver_parsing_and_ranges() {
    let v = |s: &str| Version::parse(s).unwrap();
    for bad in [
        "1.2",
        "1.2.3.4",
        "01.2.3",
        "1.2.x",
        "1.2.3-beta",
        "",
        "a.b.c",
    ] {
        assert!(Version::parse(bad).is_err(), "{bad}");
    }
    let r = |s: &str| Range::parse(s).unwrap();
    assert!(r("*").satisfies(v("0.0.1")));
    assert!(r("1.2.3").satisfies(v("1.2.3")) && !r("1.2.3").satisfies(v("1.2.4")));
    assert!(
        r("^1.2.3").satisfies(v("1.9.0"))
            && !r("^1.2.3").satisfies(v("2.0.0"))
            && !r("^1.2.3").satisfies(v("1.2.2"))
    );
    assert!(r("^0.2.3").satisfies(v("0.2.9")) && !r("^0.2.3").satisfies(v("0.3.0")));
    assert!(r("^0.0.3").satisfies(v("0.0.3")) && !r("^0.0.3").satisfies(v("0.0.4")));
    assert!(r("~1.2.3").satisfies(v("1.2.9")) && !r("~1.2.3").satisfies(v("1.3.0")));
    assert!(r(">=1.2.3").satisfies(v("9.0.0")) && !r(">=1.2.3").satisfies(v("1.2.2")));
    assert!(Range::parse("1.x").is_err());
}

#[test]
fn a_listener_error_does_not_stop_the_others_or_reach_the_emitter() {
    struct Listeners;
    impl Plugin for Listeners {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.on(|_, p: &Ping| Err(format!("bad {}", p.0).into()))?;
            cx.on(|_, p: &Ping| {
                log(format!("second {}", p.0));
                Ok(())
            })?;
            Ok(Applied::Done)
        }
    }
    static LISTENERS: Spec = Spec {
        name: "listeners",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Listeners)),
    };
    let (mut k, t0) = kernel();
    k.mount(k.root(), &LISTENERS, Value::Null).unwrap();
    settle(&mut k, t0);
    k.drain_events();
    k.emit(&Ping(4)).unwrap();
    assert_eq!(take_log(), vec!["second 4"]);
    assert!(k.drain_events().iter().any(|e| matches!(e, KernelEvent::ListenerFailed { event: "test/ping", error, .. } if error == "bad 4")));
}

#[test]
fn dispatch_uses_a_snapshot_and_a_reentrant_listener_is_skipped() {
    struct Grower;
    impl Plugin for Grower {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.on(|cx, p: &Ping| {
                log(format!("outer {}", p.0));
                if p.0 == 1 {
                    cx.on(|_, p: &Ping| {
                        log(format!("late {}", p.0));
                        Ok(())
                    })?;
                    cx.emit(&Ping(2))?;
                }
                Ok(())
            })?;
            Ok(Applied::Done)
        }
    }
    static GROWER: Spec = Spec {
        name: "grower",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Grower)),
    };
    let (mut k, t0) = kernel();
    k.mount(k.root(), &GROWER, Value::Null).unwrap();
    settle(&mut k, t0);
    k.drain_events();
    k.emit(&Ping(1)).unwrap();
    assert_eq!(
        take_log(),
        vec!["outer 1", "late 2"],
        "巢狀那次派發才看得到新登記的；外層自己被重入，跳過"
    );
    assert!(k
        .drain_events()
        .iter()
        .any(|e| matches!(e, KernelEvent::ListenerFailed { error, .. } if error.contains("重入"))));
    k.emit(&Ping(3)).unwrap();
    assert_eq!(take_log(), vec!["outer 3", "late 3"]);
}

#[test]
fn listeners_go_away_with_their_fiber() {
    struct One;
    impl Plugin for One {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.on(|_, p: &Ping| {
                log(format!("got {}", p.0));
                Ok(())
            })?;
            Ok(Applied::Done)
        }
    }
    static ONE: Spec = Spec {
        name: "one",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(One)),
    };
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &ONE, Value::Null).unwrap();
    settle(&mut k, t0);
    k.emit(&Ping(1)).unwrap();
    k.dispose(id).unwrap();
    settle(&mut k, t0);
    k.emit(&Ping(2)).unwrap();
    assert_eq!(take_log(), vec!["got 1"]);
}

#[test]
fn internal_events_are_reserved_for_the_kernel() {
    struct Sneaky;
    impl Plugin for Sneaky {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            let on = cx.on(|_, _: &Internal| Ok(()));
            let emit = cx.emit(&Internal);
            log(format!("{on:?} {emit:?}"));
            Ok(Applied::Done)
        }
    }
    static SNEAKY: Spec = Spec {
        name: "sneaky",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Sneaky)),
    };
    let (mut k, t0) = kernel();
    k.mount(k.root(), &SNEAKY, Value::Null).unwrap();
    settle(&mut k, t0);
    let reserved = KernelError::Reserved {
        event: "internal/test",
    };
    assert_eq!(
        take_log(),
        vec![format!("Err({reserved:?}) Err({reserved:?})")]
    );
    assert_eq!(k.emit(&Internal), Err(reserved));
}

#[test]
fn timers_fire_on_time_and_are_cancelled_with_their_fiber() {
    struct Ticker;
    impl Plugin for Ticker {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.timeout("once", Duration::from_secs(1), |_| {
                log("once".into());
                Ok(())
            })?;
            cx.interval("tick", Duration::from_secs(2), |_| {
                log("tick".into());
                Ok(())
            })?;
            cx.timeout("bad", Duration::from_secs(1), |_| Err("timer broke".into()))?;
            Ok(Applied::Done)
        }
    }
    static TICKER: Spec = Spec {
        name: "ticker",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Ticker)),
    };
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &TICKER, Value::Null).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.next_deadline(), Some(t0 + Duration::from_secs(1)));
    let s = |n| t0 + Duration::from_secs(n);
    k.run(s(1));
    k.run(s(2));
    k.run(s(3));
    k.run(s(4));
    assert_eq!(take_log(), vec!["once", "tick", "tick"]);
    assert!(k
        .drain_events()
        .iter()
        .any(|e| matches!(e, KernelEvent::TimerFailed { label, .. } if label == "bad")));
    k.dispose(id).unwrap();
    settle(&mut k, s(4));
    assert_eq!(k.next_deadline(), None);
    k.run(s(10));
    assert!(take_log().is_empty());
}

#[test]
fn registering_on_a_fiber_that_is_unloading_is_refused() {
    struct Late;
    impl Plugin for Late {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.on_dispose("late", |cx| {
                let r = cx.on_dispose("too-late", |_| Ok(()));
                log(format!("{r:?}"));
                Ok(())
            })?;
            Ok(Applied::Done)
        }
    }
    static LATE: Spec = Spec {
        name: "late",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Late)),
    };
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &LATE, Value::Null).unwrap();
    settle(&mut k, t0);
    k.dispose(id).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        take_log(),
        vec![format!("Err({:?})", KernelError::InactiveEffect)]
    );
    assert_eq!(
        k.mount(id, &PROVIDER, cfg(r#"{"tag":"x"}"#)),
        Err(KernelError::UnknownFiber)
    );
}

#[test]
fn disposing_the_root_takes_the_whole_tree_down() {
    let (mut k, t0) = kernel();
    let p = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":1}"#))
        .unwrap();
    let c = k.mount(k.root(), &CONSUMER, cfg(r#"{"tag":"c"}"#)).unwrap();
    settle(&mut k, t0);
    take_log();
    k.dispose(k.root()).unwrap();
    settle(&mut k, t0);
    assert!(k.report().is_empty());
    assert_eq!((k.state(p), k.state(c)), (None, None));
    assert_eq!(take_log(), vec!["c:dispose:Some(1)", "p:dispose:None"]);
}

#[test]
fn the_three_deferred_entries_fail_loudly() {
    struct Deferred;
    impl Plugin for Deferred {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            log(format!("{:?}", cx.isolate("counter")));
            log(format!("{:?}", cx.on_update_veto()));
            Ok(Applied::Done)
        }
    }
    static DEFERRED: Spec = Spec {
        name: "deferred",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Deferred)),
    };
    let (mut k, t0) = kernel();
    k.mount(k.root(), &DEFERRED, Value::Null).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        k.apply_diff(k.root(), &[]),
        Err(KernelError::NotImplemented {
            what: "Loader 以 diff 做執行期編輯",
            card: CARD_LOADER_DIFF
        })
    );
    let log = take_log();
    assert_eq!(
        log,
        vec![
            "log:isolate 還沒實作（#2598）".to_string(),
            format!(
                "{:?}",
                Err::<(), _>(KernelError::NotImplemented {
                    what: "isolate",
                    card: CARD_ISOLATE
                })
            ),
            "log:update 否決 還沒實作（#2597）".to_string(),
            format!(
                "{:?}",
                Err::<(), _>(KernelError::NotImplemented {
                    what: "update 否決",
                    card: CARD_UPDATE_VETO
                })
            ),
            "log:Loader 以 diff 做執行期編輯 還沒實作（#2596）".to_string(),
        ]
    );
    let cards: Vec<u32> = k
        .drain_events()
        .into_iter()
        .filter_map(|e| match e {
            KernelEvent::NotImplemented { card, .. } => Some(card),
            _ => None,
        })
        .collect();
    assert_eq!(cards, vec![2598, 2597, 2596]);
}

#[test]
fn a_plugin_that_never_settles_is_cut_off_per_run() {
    static LOOPER: Spec = Spec {
        name: "looper",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Looper)),
    };
    struct Looper;
    impl Plugin for Looper {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.plugin(&LOOPER, Value::Null)?;
            Ok(Applied::Done)
        }
    }
    let t0 = Instant::now();
    let mut k = Kernel::new(
        Limits {
            max_steps: 50,
            ..Limits::default()
        },
        t0,
    );
    k.mount(k.root(), &LOOPER, Value::Null).unwrap();
    k.run(t0);
    assert!(k.drain_events().contains(&KernelEvent::Overrun));
    assert!(!k.is_settled());
}

#[test]
fn a_slow_listener_is_reported() {
    struct Slow;
    impl Plugin for Slow {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.on(|_, _: &Ping| {
                std::thread::sleep(Duration::from_millis(20));
                Ok(())
            })?;
            Ok(Applied::Done)
        }
    }
    static SLOW: Spec = Spec {
        name: "slow",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Slow)),
    };
    let t0 = Instant::now();
    let mut k = Kernel::new(
        Limits {
            slow_callback: Duration::from_millis(5),
            ..Limits::default()
        },
        t0,
    );
    k.mount(k.root(), &SLOW, Value::Null).unwrap();
    settle(&mut k, t0);
    k.drain_events();
    k.emit(&Ping(1)).unwrap();
    assert!(k
        .drain_events()
        .iter()
        .any(|e| matches!(e, KernelEvent::SlowCallback { what, .. } if what == "test/ping")));
}

#[test]
fn config_helpers() {
    let base = cfg(r#"{"a":1,"b":{"c":2,"d":3},"e":[1]}"#);
    let merged = config::merge(
        &base,
        &cfg(r#"{"a":null,"b":{"c":null,"d":4},"e":[2],"f":null,"g":5}"#),
    );
    assert_eq!(merged, cfg(r#"{"a":1,"b":{"c":2,"d":4},"e":[2],"g":5}"#));
    assert!(
        config::reject_js_expr(&cfg(r#"{"a":[{"b":{"__jsExpr":1}}]}"#))
            .unwrap_err()
            .0
            .contains("a.0.b.__jsExpr")
    );
    assert!(
        config::reject_js_expr(&cfg(r#"{"a":"__jsExpr"}"#)).is_ok(),
        "只看鍵名"
    );
    let v = cfg(r#"{"n":null,"s":"x"}"#);
    let mut f = Fields::new(&v).unwrap();
    assert_eq!(f.opt_int("n").unwrap(), None);
    assert!(f.int("s").is_err());
    f.finish().unwrap();
    assert!(Fields::new(&cfg("[1]")).is_err());
}

#[test]
fn a_stale_fiber_id_never_points_at_a_new_fiber() {
    let (mut k, t0) = kernel();
    let old = k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"a"}"#)).unwrap();
    settle(&mut k, t0);
    k.dispose(old).unwrap();
    settle(&mut k, t0);
    let new = k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"b"}"#)).unwrap();
    settle(&mut k, t0);
    assert_ne!(old, new);
    assert_eq!(k.state(old), None);
    assert_eq!(k.dispose(old), Err(KernelError::UnknownFiber));
    assert_eq!(k.state(new), Some(State::Active));
}

#[test]
fn a_dependent_can_change_a_service_it_injected() {
    struct Bump;
    impl Plugin for Bump {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.service_mut::<Counter>()?.0 += 10;
            Ok(Applied::Done)
        }
    }
    static BUMP: Spec = Spec {
        name: "bump",
        inject: &[Inject::new("counter")],
        required: false,
        build: |_| Ok(Box::new(Bump)),
    };
    let (mut k, t0) = kernel();
    k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":1}"#))
        .unwrap();
    k.mount(k.root(), &BUMP, Value::Null).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.service::<Counter>().unwrap().0, 11);
}

#[test]
fn a_rejected_row_is_reported_once_after_its_parent_is_applied_again() {
    struct Loader;
    impl Plugin for Loader {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.load(&[Row::Plugin {
                spec: &REQUIRED,
                config: cfg(r#"{"tag":"t","typo":1}"#),
                disabled: false,
            }])?;
            Ok(Applied::Done)
        }
    }
    static LOADER: Spec = Spec {
        name: "loader",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Loader)),
    };
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &LOADER, cfg(r#"{"rev":1}"#)).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.check_required().unwrap_err().len(), 1);
    k.update(id, &cfg(r#"{"rev":2}"#)).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        k.check_required().unwrap_err().len(),
        1,
        "重新 apply 不重記"
    );
    k.dispose(id).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        k.check_required(),
        Ok(()),
        "父 fiber 卸載，底下被拒的列一起作廢"
    );
}

#[test]
fn an_ancestor_that_injects_a_descendant_service_can_still_go_away() {
    for action in ["dispose", "update", "dispose-root"] {
        let (mut k, t0) = kernel();
        let c = k
            .mount(k.root(), &CONSUMER, cfg(r#"{"tag":"c","read":true}"#))
            .unwrap();
        let p = k
            .mount(c, &PROVIDER, cfg(r#"{"tag":"p","provide":1}"#))
            .unwrap();
        settle(&mut k, t0);
        assert_eq!(k.state(c), Some(State::Active), "{action}");
        match action {
            "dispose" => k.dispose(c).unwrap(),
            "update" => k.update(c, &cfg(r#"{"tag":"c2"}"#)).unwrap(),
            _ => k.dispose(k.root()).unwrap(),
        }
        settle(&mut k, t0);
        assert_eq!(k.state(p), None, "{action}：子孫提供者收完了");
        let expected = if action == "update" {
            Some(State::Pending)
        } else {
            None
        };
        assert_eq!(k.state(c), expected, "{action}：祖先沒有卡在 UNLOADING");
    }
}

#[test]
fn durations_that_overflow_are_clamped_and_a_zero_interval_is_refused() {
    struct Far;
    impl Plugin for Far {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.timeout("once", Duration::MAX, |_| Ok(()))?;
            cx.interval("every", Duration::MAX, |_| {
                log("far:tick".into());
                Ok(())
            })?;
            log(format!(
                "{:?}",
                cx.interval("zero", Duration::ZERO, |_| Ok(()))
            ));
            Ok(Applied::Done)
        }
    }
    static FAR: Spec = Spec {
        name: "far",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Far)),
    };
    let t0 = Instant::now();
    let mut k = Kernel::new(
        Limits {
            apply: Duration::MAX,
            dispose: Duration::MAX,
            ..Limits::default()
        },
        t0,
    );
    k.mount(k.root(), &FAR, Value::Null).unwrap();
    let slow = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"slow","pending":-1}"#))
        .unwrap();
    let stuck = k
        .mount(
            k.root(),
            &PROVIDER,
            cfg(r#"{"tag":"stuck","dispose_pending":true}"#),
        )
        .unwrap();
    k.run(t0);
    k.dispose(stuck).unwrap();
    k.run(t0);
    assert!(take_log().contains(&"Err(ZeroInterval)".to_string()));
    assert_eq!(k.state(slow), Some(State::Loading));
    assert_eq!(k.state(stuck), Some(State::Unloading));
    let due = k.next_deadline().expect("夾住之後仍然有時限");
    assert!(due > t0);
    k.run(due);
    settle(&mut k, due);
    assert!(
        take_log().contains(&"far:tick".to_string()),
        "到了夾住的時間會響，下一次的時間也夾住"
    );
}

#[test]
fn an_update_during_a_pending_apply_is_applied_after_the_old_one_fails() {
    let (mut k, t0) = kernel();
    let id = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","pending":-1}"#))
        .unwrap();
    k.run(t0);
    assert_eq!(k.state(id), Some(State::Loading));
    k.update(id, &cfg(r#"{"pending":0}"#)).unwrap();
    let late = t0 + Limits::default().apply;
    k.run(late);
    settle(&mut k, late);
    assert_eq!(
        k.state(id),
        Some(State::Active),
        "新設定接著 apply，不停在 FAILED"
    );
    assert!(
        k.drain_events()
            .iter()
            .any(|e| matches!(e, KernelEvent::ApplyFailed { fiber, .. } if *fiber == id)),
        "舊的逾時照樣回報"
    );
    assert_eq!(take_log().iter().filter(|l| *l == "p:apply").count(), 2);
}

#[test]
fn a_provider_reads_its_own_service_in_a_dispose_registered_after_providing() {
    struct Own;
    impl Plugin for Own {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.provide(Counter(7))?;
            cx.on_dispose("read", |cx| {
                log(format!(
                    "own:{:?}",
                    cx.service::<Counter>().map(|c| c.0).ok()
                ));
                Ok(())
            })?;
            Ok(Applied::Done)
        }
    }
    static OWN: Spec = Spec {
        name: "own",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Own)),
    };
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &OWN, Value::Null).unwrap();
    settle(&mut k, t0);
    k.dispose(id).unwrap();
    settle(&mut k, t0);
    assert_eq!(take_log(), vec!["own:Some(7)"]);
}

#[test]
fn every_effect_starts_disposing_even_after_one_is_pending() {
    struct Slow(&'static str);
    impl Effect for Slow {
        fn dispose(&mut self, _cx: &mut Cx<'_>) -> Result<Step, PluginError> {
            log(format!("{}:dispose", self.0));
            Ok(Step::Pending)
        }
    }
    struct Two;
    impl Plugin for Two {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.effect("a", Slow("a"))?;
            cx.effect("b", Slow("b"))?;
            Ok(Applied::Done)
        }
    }
    static TWO: Spec = Spec {
        name: "two-slow",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Two)),
    };
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &TWO, Value::Null).unwrap();
    settle(&mut k, t0);
    k.dispose(id).unwrap();
    k.run(t0);
    assert_eq!(take_log(), vec!["b:dispose", "a:dispose"]);
}

#[test]
fn registering_on_a_fiber_that_was_asked_to_go_is_refused() {
    let (mut k, t0) = kernel();
    let id = k.mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p"}"#)).unwrap();
    settle(&mut k, t0);
    k.dispose(id).unwrap();
    assert_eq!(
        k.mount(id, &PROVIDER, cfg(r#"{"tag":"late"}"#)).err(),
        Some(KernelError::InactiveEffect)
    );
}

#[test]
fn a_dependency_lost_during_a_pending_apply_sends_the_fiber_back_to_waiting() {
    let (mut k, t0) = kernel();
    let p = k
        .mount(k.root(), &PROVIDER, cfg(r#"{"tag":"p","provide":1}"#))
        .unwrap();
    let c = k
        .mount(k.root(), &CONSUMER, cfg(r#"{"tag":"c","pending":2}"#))
        .unwrap();
    k.run(t0);
    assert_eq!(k.state(c), Some(State::Loading));
    k.dispose(p).unwrap();
    settle(&mut k, t0);
    assert_eq!(k.state(p), None);
    assert_eq!(
        k.state(c),
        Some(State::Pending),
        "apply 完成時依賴已經不在，不轉 ACTIVE"
    );
}

#[test]
fn an_update_during_a_pending_apply_outlives_its_self_disable() {
    /// `disable` 為真時 apply 回 `Pending`，第二次 poll 才自我停用；否則 apply 直接完成。
    struct Flaky {
        disable: bool,
        polls: u32,
    }
    impl Plugin for Flaky {
        fn apply(&mut self, _cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            Ok(if self.disable {
                Applied::Pending
            } else {
                Applied::Done
            })
        }
        fn poll(&mut self, _cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            self.polls += 1;
            Ok(if self.polls >= 2 {
                Applied::Disabled("x".into())
            } else {
                Applied::Pending
            })
        }
    }
    static FLAKY: Spec = Spec {
        name: "flaky",
        inject: &[],
        required: false,
        build: |v| {
            let mut f = Fields::new(v)?;
            let disable = f.opt_bool("disable")?.unwrap_or(false);
            f.finish()?;
            Ok(Box::new(Flaky { disable, polls: 0 }))
        },
    };
    let (mut k, t0) = kernel();
    let id = k
        .mount(k.root(), &FLAKY, cfg(r#"{"disable":true}"#))
        .unwrap();
    k.run(t0);
    assert_eq!(k.state(id), Some(State::Loading));
    k.update(id, &cfg(r#"{"disable":false}"#)).unwrap();
    settle(&mut k, t0);
    assert_eq!(
        k.state(id),
        Some(State::Active),
        "新設定接著 apply，不停在自我停用"
    );
    assert!(k
        .drain_events()
        .iter()
        .any(|e| matches!(e, KernelEvent::SelfDisabled { fiber, .. } if *fiber == id)));
}

/// 用 `expose` 提供的服務，宿主照名字叫得到；`provide` 的叫不到；提供者收掉之後也叫不到。
mod remote {
    use super::*;
    use nexus_host::kernel::{CallKey, MethodKind, Progress, Remote};

    struct Shout;
    impl Service for Shout {
        const NAME: &'static str = "shout";
    }
    impl Remote for Shout {
        fn method(&self, name: &str) -> Option<MethodKind> {
            (name == "say").then_some(MethodKind::Unary)
        }
        fn start(
            &mut self,
            _key: CallKey,
            _method: &str,
            payload: Value,
            _now: Instant,
            _chunks: &mut Vec<Value>,
        ) -> Progress {
            Progress::Ok(payload)
        }
        fn poll(&mut self, _key: CallKey, _now: Instant, _chunks: &mut Vec<Value>) -> Progress {
            Progress::Pending
        }
        fn cancel(&mut self, _key: CallKey) {}
    }

    struct Exposer;
    impl Plugin for Exposer {
        fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            cx.expose(Shout)?;
            cx.provide(Counter(1))?;
            Ok(Applied::Done)
        }
    }

    static EXPOSER: Spec = Spec {
        name: "exposer",
        inject: &[],
        required: false,
        build: |_| Ok(Box::new(Exposer)),
    };

    #[test]
    fn only_exposed_services_of_active_providers_are_callable() {
        let (mut k, t0) = kernel();
        assert!(k.remote("shout").is_none());
        let fiber = k.mount(k.root(), &EXPOSER, Value::Null).unwrap();
        settle(&mut k, t0);
        let key = CallKey { conn: 1, id: 1 };
        let (uid, remote) = k.remote("shout").expect("expose 的叫得到");
        assert_eq!(remote.method("say"), Some(MethodKind::Unary));
        assert_eq!(remote.method("nope"), None);
        let mut chunks = Vec::new();
        assert_eq!(
            remote.start(key, "say", Value::from(3), t0, &mut chunks),
            Progress::Ok(Value::from(3))
        );
        assert!(k.remote("counter").is_none(), "provide 的叫不到");
        assert!(k.service::<Shout>().is_ok(), "照樣是一般的服務");
        let mut names = Vec::new();
        k.for_each_remote(|name, _| names.push(name));
        assert_eq!(names, ["shout"]);

        k.dispose(fiber).unwrap();
        settle(&mut k, t0);
        assert!(k.remote("shout").is_none(), "提供者收掉之後叫不到");
        let mut names = Vec::new();
        k.for_each_remote(|name, _| names.push(name));
        assert!(names.is_empty());

        k.mount(k.root(), &EXPOSER, Value::Null).unwrap();
        settle(&mut k, t0);
        let (again, _) = k.remote("shout").unwrap();
        assert_ne!(again, uid, "重新 provide 是新的實體");
    }
}
