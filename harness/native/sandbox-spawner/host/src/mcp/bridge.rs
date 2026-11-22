//! 宿主的單執行緒迴圈與 MCP 連線之間的橋：一條自己的執行緒跑 tokio 的 current_thread 執行環境，連線池、監督者與每次請求都在那裡。
//!
//! - 宿主那一側送 [`Command`]（無界通道，送了就回，不會卡住宿主迴圈）；橋把結果 [`Outcome`] 排進收件匣、寫一個位元組叫醒宿主
//!   （[`crate::wake`]），宿主醒來 [`Bridge::take`] 取走。
//! - 一次綁定（[`Command::Open`]）向池取一份連線，記成 `open` 編號；放掉（[`Command::Release`]）只是忘掉編號，池裡的連線照留（池的規則）。
//! - 一次請求（[`Command::Request`]）送到那份連線**當下**活著的一代：空窗或放棄之後當場回 `server is disconnected`（同 TS `harness/packages/nexus-plugin-mcp/src/index.ts`）；
//!   transport 已經關了的錯誤讓那一代判掉線，交給監督者重連。rmcp 3.9 的 HTTP transport 握手之後不會因 server 而關，所以另外認一種：帶著 session id 的請求收到 404（[`session_expired`]，
//!   #2690）也讓那一代判掉線。單次請求失敗（逾時、server 回錯、回應太大、這一則的 SSE 串流斷掉）不算掉線。
//! - stdio 的請求逾時或被取消之後探一次活（[`probe`]）：探活也沒回應才判那一代卡死，收掉子行程、重連。
//! - 結果以 JSON 文字交回：宿主的框有巢狀上限，MCP 的酬載不受它限。送回對話行程的文字有三條出口，都先遮蔽這一份的秘密（[`super::redact`]）：結果與工具清單在序列化成文字之前走 `outgoing`／`outgoing_tools`，instructions 走 `Shared::redact_text`，錯誤走 `Shared::scrub`。連線診斷在 `connection::connect` 回錯之前就 `scrub` 過。
//! - [`Command::Shutdown`] 或宿主那一側丟掉 [`Bridge`]：取消還在跑的請求、關池（每一份照監督者的收線期限），最後交一則 [`Outcome::Closed`]。
//!   丟掉 [`Bridge`] 會等橋收完（最多 [`CLOSE_WAIT`]），宿主才接著結束行程。

use std::collections::HashMap;
use std::io::{self, Write};
use std::os::fd::RawFd;
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use rmcp::model::{
    CancelledNotification, CancelledNotificationParam, ClientRequest, ListToolsRequest,
};
use rmcp::service::{PeerRequestOptions, ServiceError};
use rmcp::transport::streamable_http_client::StreamableHttpError;
use tokio::sync::{mpsc, oneshot};

use super::config::Server;
use super::connection::{call_meta, describe, Generation, Http, MAX_RESPONSE_BYTES};
use super::pool::{Live, Log, Pool, Shared, POOL_CLOSE_TIMEOUT};
use super::stdio::REAP_BUDGET;
use super::supervisor::GENERATION_CLOSE_TIMEOUT;
use crate::json::Value;
use crate::wake::{Wake, Waker};

/// rmcp 3.9 整份回應 body 超過上限時錯誤裡的字樣（靠認字分辨）。單則 SSE 事件超限 rmcp 回 `TransportClosed`，不經這裡。
const TOO_LARGE: &str = "exceeded the maximum size of";

/// 丟掉 [`Bridge`] 時最多等橋收完多久，之後放行、由 `PR_SET_PDEATHSIG` 與監督行程掃 session 兜底。
///
/// 比 [`GENERATION_CLOSE_TIMEOUT`]（每一份連線的收線期限，內含 [`REAP_BUDGET`] 的 SIGTERM→SIGKILL 梯度）長，
/// 所以任何一份在自己的期限內收完或被放棄，宿主都等得到橋回來；比監督行程預設的 `--eof-grace-ms`（6000，在宿主讀到控制通道 EOF 時起算，宿主沒有參數接它）短，
/// 所以宿主先自己放行，不會被監督行程的 SIGTERM 搶先。對監督行程那一側只寫註解、不斷言（那個值在 `supervisor/`，不在這裡）。
/// 池整體的 `POOL_CLOSE_TIMEOUT`（6000）比這個長（編譯期斷言）：池收得慢時宿主會先逾時放行。
pub const CLOSE_WAIT: Duration = Duration::from_millis(5500);
const _: () = assert!(CLOSE_WAIT.as_millis() > GENERATION_CLOSE_TIMEOUT.as_millis());
const _: () = assert!(CLOSE_WAIT.as_millis() > REAP_BUDGET.as_millis());
const _: () = assert!(CLOSE_WAIT.as_millis() < POOL_CLOSE_TIMEOUT.as_millis());

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
    ///
    /// 橋交出這個 `open` 的 [`Outcome::Opened`] 之前處理到的是空操作：`Opened` 照樣交出，取用成功的照樣記下綁定。
    /// 要放掉一個還沒落定的綁定，收到它的 `Opened` 之後再送一次；已經忘掉的編號再送也是空操作
    /// （[`super::service::Client`] 在 `cancel` 送第一次、在 `deliver` 收到 `Opened` 時補送）。
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

/// 宿主那一側握著的橋。丟掉它等於送 [`Command::Shutdown`]，再等橋收完，最多 [`CLOSE_WAIT`]。
///
/// **丟掉會阻塞**：宿主迴圈還在跑的時候不要丟（kernel 有執行期卸載服務的路，今天沒有人呼叫；接上之後，丟掉會讓宿主迴圈停最多 [`CLOSE_WAIT`]）。
/// 不能在橋自己的執行緒或它的 runtime 裡丟：那會自己等自己，等滿上限。今天只有 `Client` 持有，在宿主主執行緒丟。
pub struct Bridge {
    commands: mpsc::UnboundedSender<Command>,
    inbox: Arc<Mutex<Vec<Outcome>>>,
    wake: Wake,
    closed: Arc<Closed>,
}

/// 橋的執行緒收完的旗標。
#[derive(Default)]
struct Closed {
    done: Mutex<bool>,
    changed: Condvar,
}

impl Closed {
    /// 鎖中毒照樣設：這裡可能是在 panic 展開裡被呼叫，不能再 panic。
    fn set(&self) {
        *self.done.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.changed.notify_all();
    }

    /// 等到旗標設起來或過了 `limit`；回傳旗標。`wait_timeout_while` 會處理假醒。
    fn wait(&self, limit: Duration) -> bool {
        let done = self.done.lock().unwrap_or_else(PoisonError::into_inner);
        let (done, _) = self
            .changed
            .wait_timeout_while(done, limit, |done| !*done)
            .unwrap_or_else(PoisonError::into_inner);
        *done
    }
}

/// 橋的執行緒的最外層：它被丟掉（正常離開、提早離開、展開）才設旗標，所以旗標設起來時 runtime 與裡面分離的任務都已經收掉。
/// 出貨的建置是 `panic = "abort"`，展開那一路只在 dev 與測試建置走得到。
struct CloseGuard(Arc<Closed>);

impl Drop for CloseGuard {
    fn drop(&mut self) {
        self.0.set();
    }
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
        let closed: Arc<Closed> = Arc::default();
        let guard = CloseGuard(Arc::clone(&closed));
        std::thread::Builder::new()
            .name("nexus-host-mcp".into())
            .spawn(move || thread_main(guard, runtime, rx, deliver, http, secrets))?;
        Ok(Bridge {
            commands,
            inbox,
            wake,
            closed,
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

    /// 等橋收完，最多 `limit`；收完了回 `true`，逾時回 `false`。已經收完再呼叫立刻回 `true`。
    pub fn wait_closed(&self, limit: Duration) -> bool {
        self.closed.wait(limit)
    }

    /// 喚醒 fd，借出不交出：[`Bridge`] 活著時有效，呼叫方不得 close。
    pub fn wake_fd(&self) -> RawFd {
        self.wake.fd()
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.commands.send(Command::Shutdown);
        // stderr 寫失敗（另一頭已經關了）不能讓這裡 panic：這一句與下面印日誌的，都用寫失敗就算了的寫法，結束碼不變。
        if !self.wait_closed(CLOSE_WAIT) {
            let _ = writeln!(
                io::stderr(),
                "nexus-host: mcp 錯誤：橋沒在 {} ms 內收完，不再等",
                CLOSE_WAIT.as_millis()
            );
        }
        // `Client` 丟掉之後沒人讀收件匣：關池時記的日誌（有幾份沒收完、監督者收不乾淨）在這裡寫出去，格式同 `Client` 印的。
        for outcome in self.take() {
            if let Outcome::Log { error, line } = outcome {
                let level = if error { "錯誤" } else { "資訊" };
                let _ = writeln!(io::stderr(), "nexus-host: mcp {level}：{line}");
            }
        }
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

/// 橋的執行緒的主體。正常回來時明寫順序：`runtime`（連同裡面分離的任務）先收掉，`guard` 最後，旗標才設。
/// `serve` panic 展開時走不到這兩句，靠參數照宣告的反序丟（`runtime` 在後、先丟，`guard` 在前、後丟），所以 `guard` 要留在第一個。
fn thread_main(
    guard: CloseGuard,
    runtime: tokio::runtime::Runtime,
    rx: mpsc::UnboundedReceiver<Command>,
    deliver: Deliver,
    http: reqwest::Client,
    secrets: Vec<String>,
) {
    runtime.block_on(serve(rx, deliver, http, secrets));
    drop(runtime);
    drop(guard);
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
                            let opened = opened(&acquired.shared, acquired.error);
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

fn opened(shared: &Shared<Generation>, warning: Option<String>) -> Result<Opened, String> {
    let (tools, instructions) = match shared.listed() {
        Some(listed) => (
            outgoing_tools(
                shared,
                serde_json::to_value(&listed.tools).map_err(|e| e.to_string())?,
            ),
            shared.redact_text(&listed.instructions),
        ),
        None => ("[]".to_string(), String::new()),
    };
    Ok(Opened {
        tools,
        instructions,
        warning,
    })
}

/// 成功結果（含 `isError`）與 resources 交回宿主那一側之前：先原地遮掉這一份的秘密，再序列化成 JSON 文字。
fn outgoing(shared: &Shared<Generation>, mut value: Value) -> String {
    shared.redact_json(&mut value);
    serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string())
}

/// 同 [`outgoing`]，對工具清單：每個工具的 `name` 不遮。
fn outgoing_tools(shared: &Shared<Generation>, mut tools: Value) -> String {
    shared.redact_tool_list(&mut tools);
    serde_json::to_string(&tools).unwrap_or_else(|_| "null".to_string())
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

/// 一次請求逾時或被取消之後，在背景探一次那一代還活不活著（#3073，同 TS `connection.ts` 的 `probeLiveness`），不擋那次請求回去。
/// 探的是 `tools/list`：新協定拿掉了 `ping`，而每台 server 都要回 `tools/list`。只有探活本身等滿 `livenessTimeoutMs` 才判卡死
/// （[`Shared::stalled`]）；任何回應都算活著，錯誤回應也是。transport 關了的失敗由掉線那條路管。同一代一次只探一個。
/// 只探 stdio：HTTP 沒有子行程可收，重連救不了對端。
fn probe(shared: &Arc<Shared<Generation>>, live: &Arc<Live<Generation>>) {
    let Some(limit) = shared.server.liveness_timeout else {
        return;
    };
    if !live.begin_probe() {
        return;
    }
    let (shared, live) = (Arc::clone(shared), Arc::clone(live));
    tokio::spawn(async move {
        let asked = async {
            let request = ClientRequest::ListToolsRequest(ListToolsRequest::default());
            let options = PeerRequestOptions::with_timeout(limit);
            let handle = live
                .peer
                .peer
                .send_request_with_option(request, options)
                .await?;
            handle.await_response().await
        };
        // 外面再套一層同樣的期限：rmcp 的逾時到了之後還要等取消通知寫進 stdin 才回，stdin 寫不進時它回不來。
        // 外層從送出前就起算，一定先到或同時到。
        let silent = match tokio::time::timeout(limit, asked).await {
            Err(_) | Ok(Err(ServiceError::Timeout { .. })) => true,
            Ok(_) => false,
        };
        live.end_probe();
        if silent {
            shared.stalled(&live);
        }
    });
}

/// 一次請求：送到當下那一代，結果編成 JSON 文字。
async fn request(
    shared: &Arc<Shared<Generation>>,
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
                    // 先起探活再送通知：通知要等寫進 stdin 才回，stdin 寫不進時等不到。
                    probe(shared, &live);
                    let _ = peer.send_notification(notice.into()).await;
                    return Err("cancelled".into());
                }
            }
        }
        Err(err) => Err(err),
    };
    match response {
        Ok(result) => serde_json::to_value(&result)
            .map(|v| outgoing(shared, v))
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
                live.lost();
                return Err(format!(
                    "{}: session expired (HTTP 404) — this call failed; the connection is being re-established, retry the call",
                    shared.label
                ));
            }
            if matches!(err, ServiceError::Timeout { .. }) {
                probe(shared, &live);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 旗標沒設時等到上限回_false() {
        assert!(!Closed::default().wait(Duration::from_millis(20)));
    }

    #[test]
    fn 橋的執行緒_panic_展開時也設旗標() {
        let closed: Arc<Closed> = Arc::default();
        let guard = CloseGuard(Arc::clone(&closed));
        let thread = std::thread::spawn(move || {
            let _guard = guard;
            panic!("模擬橋的執行緒 panic");
        });
        assert!(thread.join().is_err());
        assert!(closed.wait(Duration::from_secs(5)), "展開時 guard 沒設旗標");
    }
}
