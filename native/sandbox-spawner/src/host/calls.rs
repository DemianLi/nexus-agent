//! 驗過身分的連線上的呼叫：`call` 照服務名找內核裡用 `expose` 提供的實體（[`crate::kernel::Remote`]），回 `chunk` 與 `result`；
//! `cancel` 放掉一次；宿主主動推的 `event` 送給每一條驗過身分的連線。
//!
//! - 每個 `id` 剛好回一框 `result`：成功、失敗、取消、太大都是。`cancel` 一個已經結束或不存在的 `id` 不回任何東西（兩邊各自送出時會交錯）。
//! - 違反協定（還沒 `hello` 就送、`side` 是 `"h"`、同一個 `id` 還在跑又送一次）照 [`Host::violate`] 處理；其餘都只回那一次呼叫的錯，連線不斷。
//! - 一條連線同時最多 [`MAX_CALLS`] 個呼叫，再來的回 `busy`。
//! - 一塊或結果編出來超過一框：塊不送、那一次以 `too_large` 收尾（服務那邊取消）；結果換成 `too_large`。大的結果要服務自己切成塊串流。
//! - 連線排著沒寫出去的超過 [`OUTBOX_PAUSE`]，先不 poll 它的呼叫，等對方讀走再說。
//! - 綁定跟著連線走：連線一斷，它還在跑的呼叫全部取消。宿主不記任何跨連線的東西，客戶端重連後自己重新登記。
//! - 提供服務的插件卸載了，或換了一個實體，還在跑的呼叫以 `service_error` 收尾。

use std::time::Instant;

use super::Host;
use crate::host_protocol::{encode_host_message, CallError, ErrorCode, HostMessage, Side, MAX_FRAME};
use crate::json::Value;
use crate::kernel::{CallKey, Fault, MethodKind, Progress};

/// 一條連線同時最多幾個呼叫。
pub const MAX_CALLS: usize = 64;
/// 一條連線排著沒寫出去的位元組超過這麼多，先不 poll 它的呼叫。
pub const OUTBOX_PAUSE: usize = 4 * MAX_FRAME;

/// 一次還在跑的呼叫。
pub(super) struct Call {
    service: String,
    /// 開始時那個服務實體的 uid：換了實體就不再叫它。
    uid: u64,
    kind: MethodKind,
    /// 下一塊的序號。
    seq: u64,
}

fn failure(code: ErrorCode, message: &str) -> Result<Value, CallError> {
    Err(CallError {
        code,
        message: message.to_string(),
    })
}

impl Host {
    fn reply(&mut self, i: usize, id: u64, outcome: Result<Value, CallError>) {
        if let Some(conn) = self.conns.get_mut(i) {
            conn.chan.send(&encode_host_message(&HostMessage::Result {
                side: Side::Client,
                id,
                outcome,
            }));
        }
    }

    /// 送不了 `call` 或 `cancel` 時（還沒 `hello`、方向不對）判違規。這條要斷回 `false`。
    fn check_caller(&mut self, i: usize, side: Side) -> bool {
        let Some(conn) = self.conns.get(i) else {
            return false;
        };
        if !conn.hello {
            self.violate(i, "還沒 hello");
            return false;
        }
        if side == Side::Host {
            self.violate(i, "宿主還不收反方向的呼叫");
            return false;
        }
        true
    }

    /// 收一個 `call`。這條要斷回 `false`。
    pub(super) fn on_call(
        &mut self,
        i: usize,
        side: Side,
        id: u64,
        service: String,
        method: &str,
        payload: Value,
    ) -> bool {
        if !self.check_caller(i, side) {
            return false;
        }
        let Some(conn) = self.conns.get(i) else {
            return false;
        };
        if conn.calls.contains_key(&id) {
            self.violate(i, "重複的呼叫編號");
            return false;
        }
        if conn.calls.len() >= MAX_CALLS {
            let message = format!("這條連線同時在跑的呼叫已經 {MAX_CALLS} 個");
            self.reply(i, id, failure(ErrorCode::Busy, &message));
            return true;
        }
        let key = CallKey { conn: conn.id, id };
        let Some((uid, remote)) = self.kernel.remote(&service) else {
            self.reply(i, id, failure(ErrorCode::UnknownService, &service));
            return true;
        };
        let Some(kind) = remote.method(method) else {
            self.reply(i, id, failure(ErrorCode::UnknownMethod, method));
            return true;
        };
        let mut chunks = Vec::new();
        let progress = remote.start(key, method, payload, Instant::now(), &mut chunks);
        if let Some(conn) = self.conns.get_mut(i) {
            conn.calls.insert(
                id,
                Call {
                    service,
                    uid,
                    kind,
                    seq: 0,
                },
            );
        }
        self.settle(i, id, chunks, progress);
        true
    }

    /// 收一個 `cancel`。這條要斷回 `false`。
    pub(super) fn on_cancel(&mut self, i: usize, side: Side, id: u64) -> bool {
        if !self.check_caller(i, side) {
            return false;
        }
        let Some(conn) = self.conns.get_mut(i) else {
            return false;
        };
        let key = CallKey { conn: conn.id, id };
        if let Some(call) = conn.calls.remove(&id) {
            self.cancel_in_service(&call, key);
            self.reply(i, id, failure(ErrorCode::Cancelled, "呼叫端取消"));
        }
        true
    }

    fn cancel_in_service(&mut self, call: &Call, key: CallKey) {
        if let Some((uid, remote)) = self.kernel.remote(&call.service) {
            if uid == call.uid {
                remote.cancel(key);
            }
        }
    }

    /// 送出服務這一步推的塊，結束了就送 `result`、從表上拿掉。
    fn settle(&mut self, i: usize, id: u64, chunks: Vec<Value>, progress: Progress) {
        let Some(conn) = self.conns.get_mut(i) else {
            return;
        };
        let key = CallKey { conn: conn.id, id };
        let Some(call) = conn.calls.get_mut(&id) else {
            return;
        };
        let pending = progress == Progress::Pending;
        let mut end = None;
        if call.kind == MethodKind::Unary && !chunks.is_empty() {
            end = Some(failure(ErrorCode::ServiceError, "單次的方法送了串流的塊"));
        } else {
            for payload in chunks {
                let bytes = encode_host_message(&HostMessage::Chunk {
                    side: Side::Client,
                    id,
                    seq: call.seq,
                    payload,
                });
                if bytes.len() > MAX_FRAME {
                    end = Some(failure(
                        ErrorCode::TooLarge,
                        &format!("一塊超過 {MAX_FRAME} 位元組"),
                    ));
                    break;
                }
                conn.chan.send(&bytes);
                call.seq += 1;
            }
        }
        // 服務還當它在跑，宿主卻要收尾了：叫服務放掉。
        let cancel = end.is_some() && pending;
        let outcome = match (end, progress) {
            (Some(outcome), _) => outcome,
            (None, Progress::Pending) => return,
            (None, Progress::Ok(value)) => Ok(value),
            (None, Progress::Err(fault, message)) => Err(CallError {
                code: match fault {
                    Fault::BadPayload => ErrorCode::BadPayload,
                    Fault::Failed => ErrorCode::ServiceError,
                },
                message,
            }),
        };
        let Some(call) = conn.calls.remove(&id) else {
            return;
        };
        let mut bytes = encode_host_message(&HostMessage::Result {
            side: Side::Client,
            id,
            outcome,
        });
        if bytes.len() > MAX_FRAME {
            bytes = encode_host_message(&HostMessage::Result {
                side: Side::Client,
                id,
                outcome: failure(
                    ErrorCode::TooLarge,
                    &format!("結果超過 {MAX_FRAME} 位元組，要用串流"),
                ),
            });
        }
        conn.chan.send(&bytes);
        if cancel {
            self.cancel_in_service(&call, key);
        }
    }

    /// poll 每一條連線還在跑的呼叫，再把服務推的事件送出去。
    pub(super) fn pump_calls(&mut self) {
        let now = Instant::now();
        for i in 0..self.conns.len() {
            let conn = &self.conns[i];
            if conn.dead || conn.calls.is_empty() || conn.chan.queued() >= OUTBOX_PAUSE {
                continue;
            }
            let ids: Vec<u64> = conn.calls.keys().copied().collect();
            for id in ids {
                let conn = &self.conns[i];
                if conn.chan.queued() >= OUTBOX_PAUSE {
                    break;
                }
                let Some(call) = conn.calls.get(&id) else {
                    continue;
                };
                let key = CallKey { conn: conn.id, id };
                let uid = call.uid;
                let mut chunks = Vec::new();
                let progress = match self.kernel.remote(&call.service) {
                    Some((current, remote)) if current == uid => remote.poll(key, now, &mut chunks),
                    _ => Progress::Err(Fault::Failed, "服務已經卸載".to_string()),
                };
                self.settle(i, id, chunks, progress);
            }
        }
        let mut events = Vec::new();
        self.kernel.for_each_remote(|service, remote| {
            for (topic, payload) in remote.take_events() {
                events.push(encode_host_message(&HostMessage::Event {
                    service: service.to_string(),
                    topic,
                    payload,
                }));
            }
        });
        for bytes in events {
            if bytes.len() > MAX_FRAME {
                say!("服務的事件超過 {MAX_FRAME} 位元組，不送");
                continue;
            }
            for conn in self.conns.iter_mut().filter(|c| c.hello && !c.dead) {
                conn.chan.send(&bytes);
            }
        }
    }

    /// 服務要求最晚什麼時候被 poll。
    pub(super) fn calls_deadline(&mut self) -> Option<Instant> {
        let mut earliest: Option<Instant> = None;
        self.kernel.for_each_remote(|_, remote| {
            if let Some(at) = remote.next_deadline() {
                earliest = Some(earliest.map_or(at, |e| e.min(at)));
            }
        });
        earliest
    }

    /// 第 `i` 條連線要拿掉了：它還在跑的呼叫在服務那邊全部取消。
    pub(super) fn drop_calls(&mut self, i: usize) {
        let Some(conn) = self.conns.get_mut(i) else {
            return;
        };
        let conn_id = conn.id;
        let calls: Vec<(u64, Call)> = conn.calls.drain().collect();
        for (id, call) in calls {
            self.cancel_in_service(&call, CallKey { conn: conn_id, id });
        }
    }
}
