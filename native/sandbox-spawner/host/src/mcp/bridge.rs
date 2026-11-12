//! 宿主的單執行緒迴圈與 MCP 連線之間的橋：一條自己的執行緒跑 tokio 的 current_thread 執行環境，連線池、監督者與每次請求都在那裡。
//!
//! - 宿主那一側送 [`Command`]（無界通道，送了就回，不會卡住宿主迴圈）；橋把結果 [`Outcome`] 排進收件匣、寫一個位元組叫醒宿主
//!   （[`crate::wake`]），宿主醒來 [`Bridge::take`] 取走。
//! - 一次綁定（[`Command::Open`]）向池取一份連線，記成 `open` 編號；放掉（[`Command::Release`]）只是忘掉編號，池裡的連線照留（池的規則）。
//! - 一次請求（[`Command::Request`]）送到那份連線**當下**活著的一代：空窗或放棄之後當場回 `server is disconnected`（同 TS `packages/nexus-plugin-mcp/src/index.ts`）；
//!   transport 已經關了的錯誤讓那一代判掉線，交給監督者重連。rmcp 3.9 的 HTTP transport 握手之後不會因 server 而關，所以另外認一種：帶著 session id 的請求收到 404（[`session_expired`]，
//!   #2690）也讓那一代判掉線。單次請求失敗（逾時、server 回錯、回應太大、這一則的 SSE 串流斷掉）不算掉線。
//! - 結果以 JSON 文字交回：宿主的框有巢狀上限，MCP 的酬載不受它限。成功結果還沒遮蔽秘密（TODO(#2570)）；**遮蔽要在 `outgoing` 序列化成文字之前做**。
//! - [`Command::Shutdown`] 或宿主那一側丟掉 [`Bridge`]：取消還在跑的請求、關池（每一份照監督者的收線期限），最後交一則 [`Outcome::Closed`]。

use std::collections::HashMap;
use std::io;
use std::os::fd::RawFd;
use std::sync::{Arc, Mutex};

use rmcp::model::{CancelledNotification, CancelledNotificationParam, ClientRequest};
use rmcp::service::{PeerRequestOptions, ServiceError};
use rmcp::transport::streamable_http_client::StreamableHttpError;
use tokio::sync::{mpsc, oneshot};

use super::config::Server;
use super::connection::{call_meta, describe, Generation, Http, Listed, MAX_RESPONSE_BYTES};
use super::pool::{Log, Pool, Shared};
use crate::json::Value;
use crate::wake::{Wake, Waker};

/// rmcp 3.9 整份回應 body 超過上限時錯誤裡的字樣（靠認字分辨）。單則 SSE 事件超限 rmcp 回 `TransportClosed`，不經這裡。
const TOO_LARGE: &str = "exceeded the maximum size of";

/// 宿主那一側送進橋的事。
#[derive(Debug)]
pub enum Command {
    /// 向池取這份設定的連線，記成 `open`。
    Open {
        open: u64,
        server: Box<Server>,
        elicitation: bool,
    },
    /// 送一次請求到 `open` 那份連線。`method` 只收 [`REQUEST_METHODS`]。
    Request {
        id: u64,
        open: u64,
        method: String,
        params: Value,
    },
    /// 取消一次還在跑的請求：它照樣交一則 `Done`（`Err("cancelled")`）；已經結束的不理。
    Cancel { id: u64 },
    /// 忘掉 `open`。還在跑的請求照跑完。
    Release { open: u64 },
    /// 收掉整座橋。
    Shutdown,
}

/// 橋交回宿主那一側的事。
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 取用的結果。連不上但沒寫 `failOnStartupError` 時照樣是 `Ok`，`warning` 帶原因、清單可能是空的。
    Opened {
        open: u64,
        result: Result<Opened, String>,
    },
    /// 一次請求的結果：成功是 server 回的結果，JSON 文字。
    Done {
        id: u64,
        result: Result<String, String>,
    },
    /// 記一行日誌（監督者的進度、放棄）。
    Log { error: bool, line: String },
    /// 橋收完了，之後不會再有任何結果。
    Closed,
}

/// 一次取用拿到的清單。
#[derive(Debug, PartialEq, Eq)]
pub struct Opened {
    /// `tools/list` 列出的工具，JSON 文字（陣列）。
    pub tools: String,
    /// 帶出處標頭的指引；沒有是空字串。
    pub instructions: String,
    pub warning: Option<String>,
}

/// 橋收的請求方法。
pub const REQUEST_METHODS: [&str; 4] = [
    "tools/call",
    "resources/list",
    "resources/templates/list",
    "resources/read",
];

/// 宿主那一側握著的橋。丟掉它等於送 [`Command::Shutdown`]，不等執行緒結束。
pub struct Bridge {
    commands: mpsc::UnboundedSender<Command>,
    inbox: Arc<Mutex<Vec<Outcome>>>,
    wake: Wake,
}

impl Bridge {
    /// 起橋的執行緒。`secrets` 是每份連線的錯誤都要換掉的字串（代理的帳密）。
    pub fn start(http: reqwest::Client, secrets: Vec<String>) -> io::Result<Bridge> {
        let wake = Wake::new()?;
        let inbox: Arc<Mutex<Vec<Outcome>>> = Arc::default();
        let (commands, rx) = mpsc::unbounded_channel();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let deliver = Deliver {
            inbox: Arc::clone(&inbox),
            waker: wake.waker(),
        };
        std::thread::Builder::new()
            .name("nexus-host-mcp".into())
            .spawn(move || runtime.block_on(serve(rx, deliver, http, secrets)))?;
        Ok(Bridge {
            commands,
            inbox,
            wake,
        })
    }

    /// 送一個命令，不會卡。橋的執行緒已經結束時靜靜丟掉：那時 `Closed` 已經交過或即將交出。
    pub fn send(&self, command: Command) {
        let _ = self.commands.send(command);
    }

    /// 讀乾淨喚醒 fd，取走排著的結果（照交出的順序）。
    pub fn take(&self) -> Vec<Outcome> {
        self.wake.drain();
        self.inbox
            .lock()
            .map(|mut inbox| std::mem::take(&mut *inbox))
            .unwrap_or_default()
    }

    /// 喚醒 fd，借出不交出：[`Bridge`] 活著時有效，呼叫方不得 close。
    pub fn wake_fd(&self) -> RawFd {
        self.wake.fd()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
    }
}

/// 把結果排進收件匣、叫醒宿主。
#[derive(Clone)]
struct Deliver {
    inbox: Arc<Mutex<Vec<Outcome>>>,
    waker: Waker,
}

impl Deliver {
    fn send(&self, outcome: Outcome) {
        if let Ok(mut inbox) = self.inbox.lock() {
            inbox.push(outcome);
        }
        self.waker.wake();
    }
}

type Opens = Arc<Mutex<HashMap<u64, (Arc<Shared<Generation>>, bool)>>>;
type Calls = Arc<Mutex<HashMap<u64, oneshot::Sender<()>>>>;

async fn serve(
    mut rx: mpsc::UnboundedReceiver<Command>,
    deliver: Deliver,
    http: reqwest::Client,
    secrets: Vec<String>,
) {
    let (info, error) = (deliver.clone(), deliver.clone());
    let log = Log {
        info: Arc::new(move |line: &str| {
            info.send(Outcome::Log {
                error: false,
                line: line.to_string(),
            })
        }),
        error: Arc::new(move |line: &str| {
            error.send(Outcome::Log {
                error: true,
                line: line.to_string(),
            })
        }),
    };
    let pool = Arc::new(Pool::new(Http::new(http), secrets, log, None));
    let opens: Opens = Arc::default();
    let calls: Calls = Arc::default();
    while let Some(command) = rx.recv().await {
        match command {
            Command::Open {
                open,
                server,
                elicitation,
            } => {
                let (pool, opens, deliver) =
                    (Arc::clone(&pool), Arc::clone(&opens), deliver.clone());
                tokio::spawn(async move {
                    let result = match pool.acquire(&server, elicitation).await {
                        Ok(acquired) => {
                            let opened = opened(acquired.shared.listed(), acquired.error);
                            if let Ok(mut opens) = opens.lock() {
                                opens.insert(open, (acquired.shared, elicitation));
                            }
                            opened
                        }
                        Err(error) => Err(error),
                    };
                    deliver.send(Outcome::Opened { open, result });
                });
            }
            Command::Request {
                id,
                open,
                method,
                params,
            } => {
                let target = opens.lock().ok().and_then(|o| o.get(&open).cloned());
                let Some((shared, elicitation)) = target else {
                    deliver.send(Outcome::Done {
                        id,
                        result: Err(format!("沒有這個綁定（{open}）")),
                    });
                    continue;
                };
                let (cancel_tx, cancel_rx) = oneshot::channel();
                if let Ok(mut calls) = calls.lock() {
                    calls.insert(id, cancel_tx);
                }
                let (calls, deliver) = (Arc::clone(&calls), deliver.clone());
                tokio::spawn(async move {
                    let result = request(&shared, elicitation, &method, params, cancel_rx).await;
                    if let Ok(mut calls) = calls.lock() {
                        calls.remove(&id);
                    }
                    deliver.send(Outcome::Done { id, result });
                });
            }
            Command::Cancel { id } => {
                let cancel = calls.lock().ok().and_then(|mut c| c.remove(&id));
                if let Some(cancel) = cancel {
                    let _ = cancel.send(());
                }
            }
            Command::Release { open } => {
                if let Ok(mut opens) = opens.lock() {
                    opens.remove(&open);
                }
            }
            Command::Shutdown => break,
        }
    }
    let pending: Vec<oneshot::Sender<()>> = calls
        .lock()
        .map(|mut c| c.drain().map(|(_, tx)| tx).collect())
        .unwrap_or_default();
    for cancel in pending {
        let _ = cancel.send(());
    }
    pool.close().await;
    deliver.send(Outcome::Closed);
}

fn opened(listed: Option<Arc<Listed>>, warning: Option<String>) -> Result<Opened, String> {
    let (tools, instructions) = match &listed {
        Some(listed) => (
            outgoing(&serde_json::to_value(&listed.tools).map_err(|e| e.to_string())?),
            listed.instructions.clone(),
        ),
        None => ("[]".to_string(), String::new()),
    };
    Ok(Opened {
        tools,
        instructions,
        warning,
    })
}

/// 交回宿主那一側之前序列化成 JSON 文字。TODO(#2570)：成功結果的秘密遮蔽要放在這一步之前。
fn outgoing(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

/// rmcp 3.9.0 的 HTTP transport 在請求帶著 session id、server 回 404 時回的 `StreamableHttpError::SessionExpired`（`"Session expired (HTTP 404)"`），
/// 包在 `ServiceError::TransportSend` 的 `error` 裡。認型別不認字：沒帶 session id 的 404（握手、網址錯）rmcp 不回這一種，照一般的失敗走。
/// 升 rmcp 時要重看這條下轉型還對不對（測試「忘掉_session」會紅）。
fn session_expired(err: &ServiceError) -> bool {
    let ServiceError::TransportSend(sent) = err else {
        return false;
    };
    matches!(
        sent.error
            .downcast_ref::<StreamableHttpError<reqwest::Error>>(),
        Some(StreamableHttpError::SessionExpired)
    )
}

/// 一次請求：送到當下那一代，結果編成 JSON 文字。
async fn request(
    shared: &Shared<Generation>,
    elicitation: bool,
    method: &str,
    params: Value,
    cancel: oneshot::Receiver<()>,
) -> Result<String, String> {
    if !REQUEST_METHODS.contains(&method) {
        return Err(format!("不支援的方法 {method}"));
    }
    let Some(live) = shared.current() else {
        return Err(if shared.gave_up() {
            format!("{}: server is disconnected and reconnection was given up — assemble the plugin again to reconnect", shared.label)
        } else {
            format!("{}: server is disconnected", shared.label)
        });
    };
    let request: ClientRequest =
        serde_json::from_value(serde_json::json!({ "method": method, "params": params }))
            .map_err(|e| format!("{method} 的參數不合：{e}"))?;
    let mut options = PeerRequestOptions::with_timeout(shared.server.tool_call_timeout);
    if method == "tools/call" {
        if let Some(meta) = call_meta(live.peer.modern, elicitation) {
            options = options.with_meta(meta);
        }
    }
    let response = match live
        .peer
        .peer
        .send_request_with_option(request, options)
        .await
    {
        Ok(handle) => {
            let (peer, request_id) = (handle.peer.clone(), handle.id.clone());
            tokio::select! {
                response = handle.await_response() => response,
                _ = cancel => {
                    // 取消：告訴 server 不用做了，不等它回。不分協定都呼叫 `send_notification`；新協定下線上沒出現這則通知（見 docs/host-mcp.md〈跟 TS 的差距〉）。
                    let notice = CancelledNotification::new(CancelledNotificationParam::new(
                        Some(request_id),
                        Some("cancelled".into()),
                    ));
                    let _ = peer.send_notification(notice.into()).await;
                    return Err("cancelled".into());
                }
            }
        }
        Err(err) => Err(err),
    };
    match response {
        Ok(result) => serde_json::to_value(&result)
            .map(|v| outgoing(&v))
            .map_err(|e| e.to_string()),
        Err(err) => {
            // 同 TS 只認 transport 關了：單次 POST 失敗（server 回錯、回應太大、連不上）rmcp 的 worker 照跑，只是這一次失敗。
            // 一則 SSE 串流在最後的回應之前斷掉（含事件超過上限）rmcp 也回 `TransportClosed`，但 transport 還開著，所以要再看 peer。
            if matches!(err, ServiceError::TransportClosed) {
                if live.peer.peer.is_transport_closed() {
                    live.lost();
                } else {
                    return Err(format!(
                        "{}: response stream closed before its final response",
                        shared.label
                    ));
                }
            }
            // session 過期：這一代的 session 已經死了，之後每次呼叫都會 404。`live` 是這次呼叫送出時那一代的，
            // 通知的是它自己的訊號：換代之後才回來的舊錯誤打不到新一代，同一代撞到幾次都只換一次代（通知不累積）。
            // rmcp 的自動重新初始化是關的（`reinit_on_expired_session`），重連走監督者的退避與放棄。
            if session_expired(&err) {
                // 突變：永不判掉線（只驗測試抓得到，不合併）。
                return Err(format!(
                    "{}: session expired (HTTP 404) — this call failed; the connection is being re-established, retry the call",
                    shared.label
                ));
            }
            let text = describe(&err);
            if text.contains(TOO_LARGE) {
                return Err(format!(
                    "{}: response exceeded the size limit of {} MiB — this call failed; the connection stays up",
                    shared.label,
                    MAX_RESPONSE_BYTES / (1024 * 1024)
                ));
            }
            Err(shared.scrub(&text))
        }
    }
}
