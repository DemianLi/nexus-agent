//! 一台 MCP server 的「一代」連線：建 transport、握手、`tools/list` 分頁走完、查指引上限，三步都過才算連上。
//! 照 `packages/nexus-plugin-mcp/src/connection.ts`；訊息的英文照它。池經 [`Http`] 拿一代（這個連接器 HTTP 與 stdio 都管）。
//!
//! - HTTP 的 transport 只用 rmcp 的 `StreamableHttpClientTransport::with_client`，客戶端由呼叫方傳入，要用 [`crate::tls::http_client`] 建，TLS 與代理才會照設定。
//! - stdio 的 transport 是 [`super::stdio::spawn`] 起的子行程的 stdin／stdout；一代結束時連子行程一起收（[`super::stdio::reap`]），[`pool::Generation::close`] 回來時子行程已經 `wait` 掉。
//! - rmcp 自己的重試全關（SSE 重連、session 過期重建），重連只交給監督者，同 TS 的 `maxRetries: 0`。
//! - 協定版本自動協商：先試新協定（`server/discover`），對方是舊協定就退回 `initialize`。握手時不宣告任何 client 能力；
//!   新協定的反問能力由呼叫端在每次 `tools/call` 的 `_meta` 帶（[`call_meta`]）。
//! - server 一則回應的大小上限是 [`MAX_RESPONSE_BYTES`]（JSON 與 SSE 一樣）；巢狀層數照 serde_json 的預設上限 128。
//! - 舊式 HTTP+SSE 的退回沒有做（rmcp 沒有這個 transport）。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

use reqwest::header::{HeaderName, HeaderValue};
use rmcp::model::{
    ClientCapabilities, Implementation, InitializeRequestParams, PaginatedRequestParams,
    ProtocolVersion, RequestMetaObject, Tool,
};
use rmcp::service::{Peer, RoleClient};
use rmcp::transport::common::client_side_sse::NeverRetry;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::{ClientLifecycleMode, ClientServiceExt};
use tokio::sync::{watch, Notify};

use super::config::{Connection, Server, Stdio};
use super::pool;
use super::redact::scrub;
use super::stdio;

/// 握手時報給 server 的身分，同 TS 的 `CLIENT_IDENTITY`：同一台 server 從 TS 或宿主連進來，看到的身分相同。
const CLIENT_NAME: &str = "@nexus/plugin-mcp";
const CLIENT_VERSION: &str = "0.6.0";
/// 新協定每次請求帶 client 能力的 `_meta` 鍵。
const CLIENT_CAPABILITIES_META_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
/// server 一則回應最多幾個位元組：JSON 回應是 rmcp 固定的 16 MiB，SSE 的一個事件在 [`connect`] 明寫成同一個值。
pub const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

/// 一個錯誤連同 source 鏈攤成一行，以 `: ` 串接；文字已出現在前文的 source 略過。
pub fn describe(err: &dyn std::error::Error) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(next) = source {
        let line = next.to_string();
        if !text.contains(&line) {
            text.push_str(": ");
            text.push_str(&line);
        }
        source = next.source();
    }
    text
}

/// 呼叫一代用的東西：rmcp 的 peer，與協商出的協定是不是新協定（[`call_meta`] 要看）。
#[derive(Clone)]
pub struct Caller {
    pub peer: Peer<RoleClient>,
    pub modern: bool,
}

/// 一代列出的東西。
#[derive(Clone)]
pub struct Listed {
    pub tools: Vec<Tool>,
    /// 帶出處標頭的指引；server 沒給就是空字串。
    pub instructions: String,
}

/// 這一代被丟下（沒走 [`pool::Generation::close`]，例如列工具中途連線的 future 被停掉）時也要收：服務迴圈與 stdio 子行程在背景 task 裡，
/// 不喊停就沒人收。
struct CancelOnDrop(Option<rmcp::service::RunningServiceCancellationToken>);

impl CancelOnDrop {
    fn cancel(&mut self) {
        if let Some(token) = self.0.take() {
            token.cancel();
        }
    }
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {}
}

/// 連上的一代。transport 關了（`closed` 變 `true`）或呼叫端判斷線（[`pool::Generation::lost_signal`]）就算掉線。
pub struct Generation {
    pub caller: Caller,
    pub listed: Listed,
    cancel: CancelOnDrop,
    closed: watch::Receiver<bool>,
    /// 子行程收掉了（沒有子行程的一代一開始就是 `true`）。
    reaped: watch::Receiver<bool>,
    lost: Arc<Notify>,
}

impl pool::Generation for Generation {
    type Peer = Caller;
    type Listed = Listed;

    fn peer(&self) -> Caller {
        self.caller.clone()
    }

    fn listed(&self) -> Listed {
        self.listed.clone()
    }

    fn lost_signal(&self) -> Arc<Notify> {
        Arc::clone(&self.lost)
    }

    async fn down(&self) {
        let mut closed = self.closed.clone();
        tokio::select! {
            _ = closed.wait_for(|c| *c) => {}
            _ = self.lost.notified() => {}
        }
    }

    /// 回來時 rmcp 的服務迴圈已經結束，stdio 的子行程也已經收掉。
    async fn close(self) {
        let mut cancel = self.cancel;
        cancel.cancel();
        let mut closed = self.closed;
        let _ = closed.wait_for(|c| *c).await;
        let mut reaped = self.reaped;
        let _ = reaped.wait_for(|r| *r).await;
    }
}

/// 池用的 [`pool::Connector`]：每一代都用同一個客戶端（TLS 與代理在建它時就定了）。
pub struct Http {
    client: reqwest::Client,
}

impl Http {
    pub fn new(client: reqwest::Client) -> Http {
        Http { client }
    }
}

impl pool::Connector for Http {
    type Generation = Generation;

    fn connect(
        &self,
        server: &Server,
        secrets: &[String],
    ) -> impl Future<Output = Result<Generation, String>> + Send {
        connect(server, &self.client, secrets)
    }
}

/// 新協定、而且開了反問時，每次 `tools/call` 要帶的 `_meta`（同 `tool-call.ts` 的 `inBand`）。rmcp 從握手設定帶的 client 能力是空的，
/// 呼叫端在 `_meta` 明寫的值蓋過它。
pub fn call_meta(modern: bool, elicitation: bool) -> Option<RequestMetaObject> {
    if !(modern && elicitation) {
        return None;
    }
    serde_json::from_value(serde_json::json!({
        CLIENT_CAPABILITIES_META_KEY: { "elicitation": { "form": {}, "url": {} } }
    }))
    .ok()
}

fn client_info() -> InitializeRequestParams {
    InitializeRequestParams::new(
        ClientCapabilities::default(),
        Implementation::new(CLIENT_NAME, CLIENT_VERSION),
    )
}

fn lifecycle() -> ClientLifecycleMode {
    ClientLifecycleMode::Auto {
        preferred_versions: vec![ProtocolVersion::V_2026_07_28],
        legacy_version: Some(ProtocolVersion::V_2025_11_25),
    }
}

/// 連一代。錯誤訊息照 TS，網址不帶 query，`secrets` 一律換掉。握手之後的步驟失敗時，回錯前先收掉這一代（stdio 連子行程一起）。
pub async fn connect(
    server: &Server,
    http: &reqwest::Client,
    secrets: &[String],
) -> Result<Generation, String> {
    match &server.connection {
        Connection::Http { url, headers } => {
            connect_http(server, url, headers, http, secrets).await
        }
        Connection::Stdio(spec) => {
            match tokio::time::timeout(spec.startup_timeout, connect_stdio(server, spec, secrets))
                .await
            {
                Ok(result) => result,
                Err(_) => Err(scrub(
                    &format!(
                        "Failed to connect to stdio server \"{}\" in auto mode: timed out after {:?}",
                        server.name, spec.startup_timeout
                    ),
                    secrets,
                )),
            }
        }
    }
}

async fn connect_http(
    server: &Server,
    url: &reqwest::Url,
    headers: &[(HeaderName, HeaderValue)],
    http: &reqwest::Client,
    secrets: &[String],
) -> Result<Generation, String> {
    let fail = |what: String| scrub(&what, secrets);
    let mut config = StreamableHttpClientTransportConfig::with_uri(url.as_str());
    config.retry_config = Arc::new(NeverRetry::default());
    config.reinit_on_expired_session = false;
    config.max_sse_event_size = MAX_RESPONSE_BYTES;
    config.custom_headers = headers.iter().cloned().collect::<HashMap<_, _>>();
    let transport = StreamableHttpClientTransport::with_client(http.clone(), config);
    let running = client_info()
        .serve_with_lifecycle(transport, lifecycle())
        .await
        .map_err(|err| {
            fail(format!(
                "Failed to connect to streamable HTTP server \"{}, url: {}\" in auto mode: {}",
                server.name,
                server.shown_url(),
                describe(&err)
            ))
        })?;
    fill(server, assemble(running, None)).await.map_err(fail)
}

async fn connect_stdio(
    server: &Server,
    spec: &Stdio,
    secrets: &[String],
) -> Result<Generation, String> {
    let fail = |what: String| scrub(&what, secrets);
    let failed = |err: &dyn std::error::Error| {
        fail(format!(
            "Failed to connect to stdio server \"{}\" in auto mode: {}",
            server.name,
            describe(err)
        ))
    };
    let stdio::Spawned { child, transport } = stdio::spawn(spec).map_err(|err| failed(&err))?;
    // `child` 在 guard 裡：這個 future 在任何一個 await 被丟下，子行程都會被殺並收掉。
    let running = match client_info()
        .serve_with_lifecycle(transport, lifecycle())
        .await
    {
        Ok(running) => running,
        Err(err) => {
            stdio::reap(child).await;
            return Err(failed(&err));
        }
    };
    fill(server, assemble(running, Some(child)))
        .await
        .map_err(fail)
}

/// 握手完的服務變成一代：背景 task 等服務迴圈結束，通報 `closed`，再收子行程（有的話），通報 `reaped`。
fn assemble(
    running: rmcp::service::RunningService<RoleClient, InitializeRequestParams>,
    child: Option<stdio::ChildGuard>,
) -> Generation {
    let peer = running.peer().clone();
    let cancel = CancelOnDrop(Some(running.cancellation_token()));
    let (closed_tx, closed) = watch::channel(false);
    let (reaped_tx, reaped) = watch::channel(child.is_none());
    tokio::spawn(async move {
        let _ = running.waiting().await;
        closed_tx.send_replace(true);
        if let Some(child) = child {
            stdio::reap(child).await;
            reaped_tx.send_replace(true);
        }
    });
    Generation {
        caller: Caller {
            modern: peer
                .peer_info()
                .is_some_and(|info| !info.protocol_version.has_initialize()),
            peer,
        },
        listed: Listed {
            tools: Vec::new(),
            instructions: String::new(),
        },
        cancel,
        closed,
        reaped,
        lost: Arc::default(),
    }
}

/// 列工具、查指引，填進這一代；失敗就先把它收掉。
async fn fill(server: &Server, mut generation: Generation) -> Result<Generation, String> {
    let peer = &generation.caller.peer;
    let listed = match list_all_tools(peer).await {
        Err(err) => Err(format!(
            "Failed to load tools from server \"{}\": {err}",
            server.name
        )),
        Ok(tools) => {
            let raw = peer.peer_info().and_then(|info| info.instructions.clone());
            instructions_of(raw.as_deref(), server).map(|instructions| Listed {
                tools,
                instructions,
            })
        }
    };
    match listed {
        Ok(listed) => {
            generation.listed = listed;
            Ok(generation)
        }
        Err(message) => {
            pool::Generation::close(generation).await;
            Err(message)
        }
    }
}

/// `tools/list` 分頁走完：同一個 cursor 再出現就停，沒有名字的略過。
async fn list_all_tools(peer: &Peer<RoleClient>) -> Result<Vec<Tool>, String> {
    let mut tools = Vec::new();
    let mut seen = HashSet::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = cursor
            .clone()
            .map(|c| PaginatedRequestParams::default().with_cursor(Some(c)));
        let page = peer.list_tools(params).await.map_err(|e| describe(&e))?;
        tools.extend(page.tools.into_iter().filter(|t| !t.name.is_empty()));
        match page.next_cursor {
            Some(next) if seen.insert(next.clone()) => cursor = Some(next),
            _ => break,
        }
    }
    Ok(tools)
}

/// 帶出處標頭的指引（`instructionsOf`）：結尾空白去掉，全空白當沒有；加了標頭超過上限就回 `Err`（訊息同 TS）。
pub fn instructions_of(raw: Option<&str>, server: &Server) -> Result<String, String> {
    let text = raw.unwrap_or("").trim_end();
    if text.trim().is_empty() {
        return Ok(String::new());
    }
    let attributed = format!("### MCP server: {}\n\n{text}", server.name);
    if attributed.len() > server.max_instruction_bytes {
        return Err(format!(
            "server instructions exceed maxInstructionBytes ({})",
            server.max_instruction_bytes
        ));
    }
    Ok(attributed)
}
