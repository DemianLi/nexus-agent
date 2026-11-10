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

/// 一台 HTTP server 的設定：`mcpConfigSchema` 的 HTTP 那一支，`approval` 不經宿主。`Debug` 不印 header 的值與網址的帳密、query。
#[derive(Clone)]
pub struct Server {
    pub name: String,
    pub url: Url,
    headers: Vec<(HeaderName, HeaderValue)>,
    pub tool_call_timeout: Duration,
    pub max_instruction_bytes: usize,
    pub reconnect: Policy,
    pub fail_on_startup_error: bool,
    pub elicitation: bool,
    /// 整份設定排好鍵的編碼，池的鍵用（含 header 的值，不進日誌）。
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

fn positive_int(fields: &Map<String, Value>, name: &str) -> Result<Option<u64>, String> {
    match fields.get(name) {
        None => Ok(None),
        Some(v) => v
            .as_u64()
            .filter(|n| *n > 0)
            .map(Some)
            .ok_or_else(|| format!("{name} 要是正整數")),
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
        Ok(Server {
            name,
            url,
            headers,
            tool_call_timeout: positive_int(fields, "toolCallTimeoutMs")?
                .map_or(DEFAULT_TOOL_CALL_TIMEOUT, Duration::from_millis),
            max_instruction_bytes: positive_int(fields, "maxInstructionBytes")?
                .map_or(Ok(DEFAULT_MAX_INSTRUCTION_BYTES), usize::try_from)
                .map_err(|_| "maxInstructionBytes 太大".to_string())?,
            reconnect: Policy::parse(fields.get("reconnect"))?,
            fail_on_startup_error: boolean(fields, "failOnStartupError", false)?,
            elicitation: boolean(fields, "elicitation", true)?,
            canonical: String::from_utf8(crate::json::encode(value))
                .map_err(|_| "設定編不成 JSON".to_string())?,
        })
        .and_then(|server| {
            // `livenessTimeoutMs` 只給 stdio；HTTP 照收、不用，型別照樣核。
            positive_int(fields, "livenessTimeoutMs")?;
            Ok(server)
        })
    }

    /// 池的鍵：整份設定（`serde_json` 的物件是 BTreeMap，編出來的鍵已經排好）加實際的 elicitation 旗標，照 `poolKey`。
    /// 鍵用原始輸入、不填預設值：省略一個欄位跟寫出它的預設值算兩份，TS 算同一份。
    pub fn pool_key(&self, elicitation: bool) -> String {
        format!("{}\0elicitation={elicitation}", self.canonical)
    }

    /// 日誌與錯誤裡用的名字，同 TS 的 `mcp-client(<serverName>)`。
    pub fn label(&self) -> String {
        format!("mcp-client({})", self.name)
    }

    /// 錯誤訊息裡要換掉的字串：header 的值、網址的帳號與密碼（原樣）、query（整串、每個值的原樣與解碼後）。
    /// reqwest 的錯誤會印出帶 query 的網址。
    pub fn secrets(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .headers
            .iter()
            .filter_map(|(_, v)| v.to_str().ok())
            .map(str::to_string)
            .collect();
        out.push(self.url.username().to_string());
        out.push(self.url.password().unwrap_or("").to_string());
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

    /// 錯誤與日誌裡顯示的網址：拿掉帳密、query 與 fragment。
    pub fn shown_url(&self) -> String {
        let mut url = self.url.clone();
        let _ = url.set_username("");
        let _ = url.set_password(None);
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
