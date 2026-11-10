//! 只給整合測試的插件 `test-echo`：證明 `--plugins` 的列真的掛上宿主的樹，也給宿主連線上的呼叫一個對象。出貨的建置沒有它（`test-hooks`）。
//!
//! 設定只收 `greeting`（字串，選填）；apply 時 provide [`Greeting`]、expose [`Echo`]（`test-echo/echo`），並在 stderr 寫一行
//! `test-echo apply：<greeting>`。
//!
//! `test-echo/echo` 的方法：
//!
//! | 方法 | 種類 | 做什麼 |
//! | --- | --- | --- |
//! | `echo` | 單次 | 原樣回 payload |
//! | `fail` | 單次 | 以服務的錯收尾 |
//! | `reject` | 單次 | 以參數不合收尾 |
//! | `stream` | 串流 | payload `{"count": n}`（n 在 0 到 1000）：送 n 塊（0 到 n-1），回 n |
//! | `wait` | 單次 | payload `{"ms": n}`：掛 n 毫秒後回 `"done"` |
//! | `hang` | 單次 | 一直掛著，直到被取消 |
//! | `cancels` | 單次 | 回到目前為止被取消了幾次 |
//! | `big` | 單次 | 回一個編出來超過一框的結果 |
//! | `big-chunk` | 串流 | 送一塊超過一框的字串，之後掛著 |
//! | `unary-chunk` | 單次 | 送一塊（單次的方法不該送），之後掛著 |
//! | `emit` | 單次 | 推一個事件 `ping`（payload 原樣）給發出這次呼叫的連線，回 null |
//! | `burst` | 單次 | payload `{"count": n, "bytes": b}`（n 在 0 到 1000、b 在 0 到 200000）：一次推 n 個事件 `burst` 給發出這次呼叫的連線，payload 是 b 個 x，回 null |
//! | `flood` | 串流 | 一步推 5 塊、每塊 250000 個 x（加起來超過一步的上限），之後掛著 |

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::host_protocol::MAX_FRAME;
use crate::json::Value;
use crate::kernel::{
    Applied, CallKey, ConfigError, Cx, Fault, Fields, MethodKind, Plugin, PluginError, Progress,
    Push, Remote, Service, Spec,
};

pub static SPEC: Spec = Spec {
    name: "test-echo",
    inject: &[],
    required: false,
    build,
};

pub struct Greeting;

impl Service for Greeting {
    const NAME: &'static str = "test-echo/greeting";
}

#[derive(Default)]
pub struct Echo {
    /// 掛著的呼叫：有時限的到時回 `"done"`，沒有的等取消。
    pending: HashMap<CallKey, Option<Instant>>,
    cancels: i64,
    events: Vec<Push>,
}

impl Service for Echo {
    const NAME: &'static str = "test-echo/echo";
}

fn int(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(Value::as_i64)
}

impl Remote for Echo {
    fn method(&self, name: &str) -> Option<MethodKind> {
        match name {
            "echo" | "fail" | "reject" | "wait" | "hang" | "cancels" | "big" | "unary-chunk"
            | "emit" | "burst" => Some(MethodKind::Unary),
            "stream" | "big-chunk" | "flood" => Some(MethodKind::Stream),
            _ => None,
        }
    }

    fn start(
        &mut self,
        key: CallKey,
        method: &str,
        payload: Value,
        now: Instant,
        chunks: &mut Vec<Value>,
    ) -> Progress {
        match method {
            "echo" => Progress::Ok(payload),
            "fail" => Progress::Err(Fault::Failed, "要求失敗".into()),
            "reject" => Progress::Err(Fault::BadPayload, "參數不合".into()),
            "stream" => {
                let Some(count) = int(&payload, "count").filter(|n| (0..=1000).contains(n)) else {
                    return Progress::Err(Fault::BadPayload, "count 要是 0 到 1000".into());
                };
                chunks.extend((0..count).map(Value::from));
                Progress::Ok(Value::from(count))
            }
            "wait" => {
                let Some(ms) = int(&payload, "ms").and_then(|n| u64::try_from(n).ok()) else {
                    return Progress::Err(Fault::BadPayload, "ms 要是非負整數".into());
                };
                self.pending
                    .insert(key, Some(now + Duration::from_millis(ms)));
                Progress::Pending
            }
            "hang" => {
                self.pending.insert(key, None);
                Progress::Pending
            }
            "cancels" => Progress::Ok(Value::from(self.cancels)),
            "big" => Progress::Ok(Value::String("x".repeat(MAX_FRAME))),
            "big-chunk" => {
                chunks.push(Value::String("x".repeat(MAX_FRAME)));
                self.pending.insert(key, None);
                Progress::Pending
            }
            "unary-chunk" => {
                chunks.push(Value::Null);
                self.pending.insert(key, None);
                Progress::Pending
            }
            "emit" => {
                self.events.push(Push {
                    conn: key.conn,
                    topic: "ping".into(),
                    payload,
                });
                Progress::Ok(Value::Null)
            }
            "burst" => {
                let count = int(&payload, "count").filter(|n| (0..=1000).contains(n));
                let bytes = int(&payload, "bytes").and_then(|n| usize::try_from(n).ok());
                let (Some(count), Some(bytes)) = (count, bytes.filter(|n| *n <= 200_000)) else {
                    return Progress::Err(Fault::BadPayload, "count 或 bytes 不在範圍內".into());
                };
                let event = Push {
                    conn: key.conn,
                    topic: "burst".into(),
                    payload: Value::String("x".repeat(bytes)),
                };
                self.events.extend((0..count).map(|_| event.clone()));
                Progress::Ok(Value::Null)
            }
            "flood" => {
                chunks.extend((0..5).map(|_| Value::String("x".repeat(250_000))));
                self.pending.insert(key, None);
                Progress::Pending
            }
            _ => Progress::Err(Fault::Failed, "沒有這個方法".into()),
        }
    }

    fn poll(&mut self, key: CallKey, now: Instant, _chunks: &mut Vec<Value>) -> Progress {
        match self.pending.get(&key) {
            Some(Some(at)) if *at <= now => {
                self.pending.remove(&key);
                Progress::Ok(Value::from("done"))
            }
            Some(_) => Progress::Pending,
            None => Progress::Err(Fault::Failed, "不認得這一次呼叫".into()),
        }
    }

    fn cancel(&mut self, key: CallKey) {
        self.pending.remove(&key);
        self.cancels += 1;
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.pending.values().flatten().min().copied()
    }

    fn take_events(&mut self) -> Vec<Push> {
        std::mem::take(&mut self.events)
    }
}

struct Plug {
    greeting: String,
}

fn build(value: &Value) -> Result<Box<dyn Plugin>, ConfigError> {
    let mut fields = Fields::new(value)?;
    let greeting = fields.opt_str("greeting")?.unwrap_or("hi").to_string();
    fields.finish()?;
    Ok(Box::new(Plug { greeting }))
}

impl Plugin for Plug {
    fn apply(&mut self, cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
        cx.provide(Greeting)?;
        cx.expose(Echo::default())?;
        eprintln!("nexus-host: test-echo apply：{}", self.greeting);
        Ok(Applied::Done)
    }
}
