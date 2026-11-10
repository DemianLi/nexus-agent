//! 一台 HTTP MCP server 的「一代」連線：建 transport、握手、`tools/list` 分頁走完、查指引上限，三步都過才算連上。
//! 照 `packages/nexus-plugin-mcp/src/connection.ts` 的 HTTP 那一半；訊息的英文照它。池經 [`Http`] 拿一代。
//!
//! - transport 只用 rmcp 的 `StreamableHttpClientTransport::with_client`，客戶端由呼叫方傳入，要用 [`crate::tls::http_client`] 建，TLS 與代理才會照設定。
//! - rmcp 自己的重試全關（SSE 重連、session 過期重建），重連只交給監督者，同 TS 的 `maxRetries: 0`。
//! - 協定版本自動協商：先試新協定（`server/discover`），對方是舊協定就退回 `initialize`。握手時不宣告任何 client 能力；
//!   新協定的反問能力由呼叫端在每次 `tools/call` 的 `_meta` 帶（[`call_meta`]）。
//! - server 一則回應的大小上限是 [`MAX_RESPONSE_BYTES`]（JSON 與 SSE 一樣）；巢狀層數照 serde_json 的預設上限 128。
//! - 舊式 HTTP+SSE 的退回沒有做（rmcp 沒有這個 transport）。

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::Arc;

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

use super::config::{scrub, Server};
use super::pool;

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

/// 連上的一代。transport 關了（`closed` 變 `true`）或呼叫端判斷線（[`pool::Generation::lost_signal`]）就算掉線。
pub struct Generation {
    pub caller: Caller,
    pub listed: Listed,
    cancel: rmcp::service::RunningServiceCancellationToken,
    closed: watch::Receiver<bool>,
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

    /// 回來時 rmcp 的服務迴圈已經結束。
    async fn close(self) {
        self.cancel.cancel();
        let mut closed = self.closed;
        let _ = closed.wait_for(|c| *c).await;
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

/// 連一代。錯誤訊息照 TS，網址不帶 query，`secrets` 一律換掉。握手之後的步驟失敗時，回錯前先收掉這一代。
pub async fn connect(
    server: &Server,
    http: &reqwest::Client,
    secrets: &[String],
) -> Result<Generation, String> {
    let fail = |what: String| scrub(&what, secrets);
    let mut config = StreamableHttpClientTransportConfig::with_uri(server.url.as_str());
    config.retry_config = Arc::new(NeverRetry::default());
    config.reinit_on_expired_session = false;
    config.max_sse_event_size = MAX_RESPONSE_BYTES;
    config.custom_headers = server.headers.iter().cloned().collect::<HashMap<_, _>>();
    let transport = StreamableHttpClientTransport::with_client(http.clone(), config);
    let info = InitializeRequestParams::new(
        ClientCapabilities::default(),
        Implementation::new(CLIENT_NAME, CLIENT_VERSION),
    );
    let running = info
        .serve_with_lifecycle(
            transport,
            ClientLifecycleMode::Auto {
                preferred_versions: vec![ProtocolVersion::V_2026_07_28],
                legacy_version: Some(ProtocolVersion::V_2025_11_25),
            },
        )
        .await
        .map_err(|err| {
            fail(format!(
                "Failed to connect to streamable HTTP server \"{}, url: {}\" in auto mode: {}",
                server.name,
                server.shown_url(),
                describe(&err)
            ))
        })?;
    let peer = running.peer().clone();
    let cancel = running.cancellation_token();
    let (closed_tx, closed) = watch::channel(false);
    tokio::spawn(async move {
        let _ = running.waiting().await;
        closed_tx.send_replace(true);
    });
    let generation = Generation {
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
        lost: Arc::default(),
    };
    fill(server, generation).await.map_err(fail)
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
