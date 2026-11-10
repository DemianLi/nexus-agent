//! 一台 HTTP MCP server 的設定：`mcpConfigSchema` 的 HTTP 那一支怎麼解、池的鍵、日誌裡的名字，與錯誤訊息裡要換掉的秘密。
//! 照 `packages/nexus-plugin-mcp/src/index.ts` 的設定；錯誤訊息講欄位，不帶值。

use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};
use reqwest::Url;

use super::supervisor::Policy;
use crate::json::{Map, Value};

/// 一次 `tools/call` 的預設逾時，同 `DEFAULT_TOOL_CALL_TIMEOUT_MS`。
pub const DEFAULT_TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// 帶出處標頭的指引預設上限（UTF-8 位元組），同 `DEFAULT_MAX_INSTRUCTION_BYTES`。
pub const DEFAULT_MAX_INSTRUCTION_BYTES: usize = 32_768;
/// `livenessTimeoutMs` 的預設值，同 `DEFAULT_LIVENESS_TIMEOUT_MS`。宿主不用它，只進池的鍵。
const DEFAULT_LIVENESS_TIMEOUT_MS: u64 = 15_000;
/// JS 的 `Number.MAX_SAFE_INTEGER`，zod 的 `int()` 收的上限。
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// `livenessTimeoutMs` 的上限，同 `MAX_LIVENESS_TIMEOUT_MS`。
const MAX_LIVENESS_TIMEOUT_MS: u64 = 2_147_483_647;

/// 一台 HTTP server 的設定：`mcpConfigSchema` 的 HTTP 那一支，`approval` 不經宿主。`Debug` 不印 header 的值與網址的 query。
#[derive(Clone)]
pub struct Server {
    pub name: String,
    pub url: Url,
    pub(super) headers: Vec<(HeaderName, HeaderValue)>,
    pub tool_call_timeout: Duration,
    pub max_instruction_bytes: usize,
    pub reconnect: Policy,
    pub fail_on_startup_error: bool,
    pub elicitation: bool,
    /// [`Server::pool_key`] 用的編碼（含 header 的值，不進日誌）。
    canonical: String,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let header_names: Vec<&str> = self.headers.iter().map(|(n, _)| n.as_str()).collect();
        f.debug_struct("Server")
            .field("name", &self.name)
            .field("url", &self.shown_url())
            .field("headers", &header_names)
            .field("tool_call_timeout", &self.tool_call_timeout)
            .field("max_instruction_bytes", &self.max_instruction_bytes)
            .field("reconnect", &self.reconnect)
            .field("fail_on_startup_error", &self.fail_on_startup_error)
            .field("elicitation", &self.elicitation)
            .finish()
    }
}

/// 照 zod 的 `z.number().int().positive()` 收：`60000.0` 跟 `60000` 一樣收，超過 `max` 拒（`max` 不大於 [`MAX_SAFE_INTEGER`]）。
fn positive_int(fields: &Map<String, Value>, name: &str, max: u64) -> Result<Option<u64>, String> {
    match fields.get(name) {
        None => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|n| n.fract() == 0.0 && (1.0..=max as f64).contains(n))
            .map(|n| Some(n as u64))
            .ok_or_else(|| format!("{name} 要是不大於 {max} 的正整數")),
    }
}

fn boolean(fields: &Map<String, Value>, name: &str, default: bool) -> Result<bool, String> {
    fields.get(name).map_or(Ok(default), |v| {
        v.as_bool().ok_or(format!("{name} 要是布林"))
    })
}

impl Server {
    /// 解一台 server 的設定。錯誤訊息只講欄位，不帶值（header 的值可能是秘密）。
    pub fn parse(value: &Value) -> Result<Server, String> {
        let Value::Object(fields) = value else {
            return Err("server 要是物件".into());
        };
        for key in fields.keys() {
            if ![
                "serverName",
                "connection",
                "toolCallTimeoutMs",
                "livenessTimeoutMs",
                "failOnStartupError",
                "maxInstructionBytes",
                "reconnect",
                "elicitation",
            ]
            .contains(&key.as_str())
            {
                return Err(format!("server 不認得的欄位 {key}"));
            }
        }
        let name = fields
            .get("serverName")
            .and_then(Value::as_str)
            .filter(|n| {
                (1..=32).contains(&n.len())
                    && n.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .ok_or("serverName 只能是 1 到 32 個 [A-Za-z0-9_-]")?
            .to_string();
        let Some(Value::Object(connection)) = fields.get("connection") else {
            return Err("connection 要是物件".into());
        };
        match connection.get("transport").and_then(Value::as_str) {
            Some("http") => {}
            Some("stdio") => return Err("connection.transport 是 stdio：宿主還不支援".into()),
            _ => return Err("connection.transport 要是 http".into()),
        }
        for key in connection.keys() {
            if !["transport", "url", "headers"].contains(&key.as_str()) {
                return Err(format!("connection 不認得的欄位 {key}"));
            }
        }
        let url = connection
            .get("url")
            .and_then(Value::as_str)
            .and_then(|u| Url::parse(u).ok())
            .filter(|u| matches!(u.scheme(), "http" | "https"))
            .ok_or("connection.url 要是 http 或 https 的網址")?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err("connection.url 不能帶帳號或密碼".into());
        }
        let mut headers = Vec::new();
        match connection.get("headers") {
            None => {}
            Some(Value::Object(map)) => {
                for (key, value) in map {
                    let header = HeaderName::from_bytes(key.as_bytes()).map_err(|_| {
                        format!("connection.headers 的鍵 {key} 不是合法的 header 名")
                    })?;
                    let text = match value {
                        Value::String(text) => text,
                        Value::Object(_) => {
                            return Err(format!(
                                "connection.headers.{key} 是憑證引用：宿主還不支援"
                            ))
                        }
                        _ => return Err(format!("connection.headers.{key} 要是字串")),
                    };
                    let value = HeaderValue::from_str(text).map_err(|_| {
                        format!("connection.headers.{key} 的值不是合法的 header 值")
                    })?;
                    headers.push((header, value));
                }
            }
            Some(_) => return Err("connection.headers 要是物件".into()),
        }
        let tool_call_timeout_ms = positive_int(fields, "toolCallTimeoutMs", MAX_SAFE_INTEGER)?
            .unwrap_or(DEFAULT_TOOL_CALL_TIMEOUT.as_millis() as u64);
        let max_instruction_bytes = positive_int(fields, "maxInstructionBytes", MAX_SAFE_INTEGER)?
            .map_or(Ok(DEFAULT_MAX_INSTRUCTION_BYTES), usize::try_from)
            .map_err(|_| "maxInstructionBytes 太大".to_string())?;
        let reconnect = Policy::parse(fields.get("reconnect"))?;
        let fail_on_startup_error = boolean(fields, "failOnStartupError", false)?;
        let elicitation = boolean(fields, "elicitation", true)?;
        // `livenessTimeoutMs` 只給 stdio；HTTP 照收、不用，型別照樣核。
        let liveness_timeout_ms =
            positive_int(fields, "livenessTimeoutMs", MAX_LIVENESS_TIMEOUT_MS)?
                .unwrap_or(DEFAULT_LIVENESS_TIMEOUT_MS);

        // 照 zod 解出來的樣子編：預設值填好，數字一律當浮點數寫，`500` 與 `500.0` 編成同一個。
        let mut key_connection = Map::new();
        key_connection.insert("transport".into(), "http".into());
        key_connection.insert("url".into(), connection["url"].clone());
        if let Some(headers) = connection.get("headers") {
            key_connection.insert("headers".into(), headers.clone());
        }
        let mut key_reconnect = Map::new();
        key_reconnect.insert("enabled".into(), reconnect.enabled.into());
        key_reconnect.insert("initialDelayMs".into(), reconnect.initial_delay_ms.into());
        key_reconnect.insert("maxDelayMs".into(), reconnect.max_delay_ms.into());
        key_reconnect.insert("maxAttempts".into(), (reconnect.max_attempts as f64).into());
        let mut key = Map::new();
        key.insert("serverName".into(), name.clone().into());
        key.insert("connection".into(), Value::Object(key_connection));
        key.insert(
            "toolCallTimeoutMs".into(),
            (tool_call_timeout_ms as f64).into(),
        );
        key.insert(
            "livenessTimeoutMs".into(),
            (liveness_timeout_ms as f64).into(),
        );
        key.insert("failOnStartupError".into(), fail_on_startup_error.into());
        key.insert(
            "maxInstructionBytes".into(),
            (max_instruction_bytes as f64).into(),
        );
        key.insert("reconnect".into(), Value::Object(key_reconnect));
        key.insert("elicitation".into(), elicitation.into());
        let canonical = String::from_utf8(crate::json::encode(&Value::Object(key)))
            .map_err(|_| "設定編不成 JSON".to_string())?;

        Ok(Server {
            name,
            url,
            headers,
            tool_call_timeout: Duration::from_millis(tool_call_timeout_ms),
            max_instruction_bytes,
            reconnect,
            fail_on_startup_error,
            elicitation,
            canonical,
        })
    }

    /// 池的鍵：整份設定加實際的 elicitation 旗標，同 `poolKey`。TS 的鍵是 zod 填好預設值之後的設定，這裡也先填好再編，
    /// 數字一律當浮點數、鍵照碼位排（[`crate::json::encode`]）：省略一個欄位跟寫出它的預設值、`500` 跟 `500.0`、鍵的順序不同，都是同一份。
    pub fn pool_key(&self, elicitation: bool) -> String {
        format!("{}\0elicitation={elicitation}", self.canonical)
    }

    /// 日誌與錯誤裡用的名字，同 TS 的 `mcp-client(<serverName>)`。
    pub fn label(&self) -> String {
        format!("mcp-client({})", self.name)
    }

    /// 錯誤訊息裡要換掉的字串：header 的值、網址的 query（整串、每個值的原樣與解碼後）。
    /// reqwest 的錯誤會印出帶 query 的網址。
    pub fn secrets(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .headers
            .iter()
            .filter_map(|(_, v)| v.to_str().ok())
            .map(str::to_string)
            .collect();
        if let Some(query) = self.url.query() {
            out.push(query.to_string());
            for pair in query.split('&') {
                out.push(pair.split_once('=').map_or(pair, |(_, v)| v).to_string());
            }
            out.extend(self.url.query_pairs().map(|(_, v)| v.into_owned()));
        }
        out.retain(|s| !s.is_empty());
        out
    }

    /// 錯誤與日誌裡顯示的網址：拿掉 query 與 fragment。
    pub fn shown_url(&self) -> String {
        let mut url = self.url.clone();
        url.set_query(None);
        url.set_fragment(None);
        url.to_string()
    }
}

/// 把 `secrets` 在 `text` 裡出現的地方換成 `[redacted]`，長的先換。只做逐字替換，不處理其他編碼與重疊區間。
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let mut sorted: Vec<&String> = secrets.iter().filter(|s| !s.is_empty()).collect();
    sorted.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut out = text.to_string();
    for secret in sorted {
        out = out.replace(secret.as_str(), "[redacted]");
    }
    out
}
