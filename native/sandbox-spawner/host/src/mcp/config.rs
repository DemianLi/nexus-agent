//! 一台 MCP server 的設定：`mcpConfigSchema` 的 HTTP 與 stdio 兩支怎麼解、池的鍵、日誌裡的名字，與錯誤訊息裡要換掉的秘密。
//! 照 `packages/nexus-plugin-mcp/src/index.ts` 的設定；錯誤訊息講欄位，不帶值。
//!
//! stdio 收的是 TS 算好的成品（`apps/harness/src/mcp-host-stdio-row.ts`）：`command`／`args` 已經照沙箱政策包好，`env` 是清洗過的父環境疊上
//! 設定的整份，`credentialEnv` 標出其中哪幾個名字的值來自憑證。宿主只驗形狀，不重算政策、不疊自己的環境。

use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};
use reqwest::Url;

use super::redact::{check_value, Use};
use super::supervisor::Policy;
use crate::json::{Map, Value};

/// stdio 這一代從起行程到列完工具最久等多久（[`Stdio::startup_timeout`] 的預設），逾時就收掉子行程、回連線失敗。server 讀了 stdin 卻不回時，沒有它 `Open` 永遠不回、子行程活到橋關閉。
/// 30 秒：夠 `npx` 冷啟動下載與起動；TS 這邊沒有上限。HTTP 沒有這個上限。
pub const STDIO_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// 一次 `tools/call` 的預設逾時，同 `DEFAULT_TOOL_CALL_TIMEOUT_MS`。
pub const DEFAULT_TOOL_CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// 帶出處標頭的指引預設上限（UTF-8 位元組），同 `DEFAULT_MAX_INSTRUCTION_BYTES`。
pub const DEFAULT_MAX_INSTRUCTION_BYTES: usize = 32_768;
/// `livenessTimeoutMs` 的預設值，同 `DEFAULT_LIVENESS_TIMEOUT_MS`。
const DEFAULT_LIVENESS_TIMEOUT_MS: u64 = 15_000;
/// JS 的 `Number.MAX_SAFE_INTEGER`，zod 的 `int()` 收的上限。
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;
/// `livenessTimeoutMs` 的上限，同 `MAX_LIVENESS_TIMEOUT_MS`。
const MAX_LIVENESS_TIMEOUT_MS: u64 = 2_147_483_647;

/// 一台 server 怎麼連。
#[derive(Clone)]
pub enum Connection {
    Http {
        url: Url,
        headers: Vec<(HeaderName, HeaderValue)>,
        /// `headers` 裡值來自憑證的名字與各自的 prefix（值以 prefix 開頭，之後那一段是憑證本身）。每個名字在 `headers` 裡剛好一個。
        /// header 裡只有這些值進遮蔽器；沒列的 header 是字面值，不遮。
        credential_headers: Vec<(HeaderName, String)>,
    },
    Stdio(Stdio),
}

/// 一台 stdio server 的啟動方式，照 TS 算好的成品用。`Debug` 只印名字與個數，不印 `args`、`env` 的值。
#[derive(Clone)]
pub struct Stdio {
    /// 絕對路徑；沙箱包過的話是 spawner 的路徑。
    pub command: String,
    pub args: Vec<String>,
    /// 絕對路徑；省略就繼承宿主的工作目錄。
    pub cwd: Option<String>,
    /// 子行程的整份環境。宿主用 `env_clear` 再放這一份，不繼承自己的。
    pub env: Vec<(String, String)>,
    /// `env` 裡值來自憑證的名字（每個都在 `env` 裡）。只有這些值進遮蔽器。
    pub credential_env: Vec<String>,
    /// 起行程到列完工具最久等多久。不是設定欄位，固定 [`STDIO_STARTUP_TIMEOUT`]；測試改小它。
    pub startup_timeout: Duration,
}

impl std::fmt::Debug for Stdio {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.env.iter().map(|(n, _)| n.as_str()).collect();
        f.debug_struct("Stdio")
            .field("command", &self.command)
            .field("args", &self.args.len())
            .field("cwd", &self.cwd)
            .field("env", &names)
            .field("credential_env", &self.credential_env)
            .finish()
    }
}

/// 一台 server 的設定：`mcpConfigSchema` 的 HTTP 與 stdio 兩支，`approval` 不經宿主。`Debug` 不印 header 的值與網址的 query。
#[derive(Clone)]
pub struct Server {
    pub name: String,
    pub connection: Connection,
    pub tool_call_timeout: Duration,
    /// 探活等多久；只有 stdio 有，HTTP 是 `None`（不探）。用在 `bridge` 的 `probe`。
    pub liveness_timeout: Option<Duration>,
    pub max_instruction_bytes: usize,
    pub reconnect: Policy,
    pub fail_on_startup_error: bool,
    pub elicitation: bool,
    /// [`Server::pool_key`] 用的編碼（含 header 的值，不進日誌）。
    canonical: String,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut shown = f.debug_struct("Server");
        shown.field("name", &self.name);
        match &self.connection {
            Connection::Http {
                headers,
                credential_headers,
                ..
            } => {
                let header_names: Vec<&str> = headers.iter().map(|(n, _)| n.as_str()).collect();
                let credential_names: Vec<&str> =
                    credential_headers.iter().map(|(n, _)| n.as_str()).collect();
                shown
                    .field("url", &self.shown_url())
                    .field("headers", &header_names)
                    .field("credential_headers", &credential_names);
            }
            Connection::Stdio(stdio) => {
                shown.field("stdio", stdio);
            }
        }
        shown
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

/// 需要列進 `credentialHeaders` 的 header：值沒有不是憑證的用法。與 TS 的 `AUTHORIZATION_HEADER_NAMES`（`packages/nexus-plugin-mcp/src/credentials.ts`）同一份，
/// 兩邊各有一支測試對 `credentials-vectors.json` 的 `credentialHeaderNames`。
pub const AUTHORIZATION_HEADERS: [&str; 2] = ["authorization", "proxy-authorization"];

/// HTTP 那一支：`url`、`headers`、`credentialHeaders`。回解好的連線，與池的鍵裡 `connection` 那一段。
///
/// `headers` 是 TS 代入之後的成品字串；`credentialHeaders` 標出其中哪幾個 header 的值來自憑證，與各自的 prefix。
/// `headers` 不是空的時候這個欄位一定要在（沒有憑證就給 `{}`），`headers` 裡的 `authorization`／`proxy-authorization` 一定要列進去：
/// 漏送時憑證不進遮蔽器、也沒有任何東西報錯，所以缺了就整列拒絕。錯誤訊息只講欄位與名字，不帶值。
fn parse_http(connection: &Map<String, Value>) -> Result<(Connection, Map<String, Value>), String> {
    for key in connection.keys() {
        if !["transport", "url", "headers", "credentialHeaders"].contains(&key.as_str()) {
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
    let mut headers: Vec<(HeaderName, HeaderValue)> = Vec::new();
    // 與 `headers` 同序，放 TS 給的原字串（`HeaderValue` 的位元組是它的 UTF-8），切 prefix 用。
    let mut header_texts: Vec<&str> = Vec::new();
    let mut header_keys: Vec<&str> = Vec::new();
    match connection.get("headers") {
        None => {}
        Some(Value::Object(map)) => {
            for (key, value) in map {
                let header = HeaderName::from_bytes(key.as_bytes())
                    .map_err(|_| format!("connection.headers 的鍵 {key} 不是合法的 header 名"))?;
                let text = match value {
                    Value::String(text) => text,
                    Value::Object(_) => {
                        return Err(format!(
                            "connection.headers.{key} 要是 TS 代入之後的字串，憑證用 connection.credentialHeaders 標出"
                        ))
                    }
                    _ => return Err(format!("connection.headers.{key} 要是字串")),
                };
                let value = HeaderValue::from_str(text)
                    .map_err(|_| format!("connection.headers.{key} 的值不是合法的 header 值"))?;
                headers.push((header, value));
                header_texts.push(text);
                header_keys.push(key);
            }
        }
        Some(_) => return Err("connection.headers 要是物件".into()),
    }
    let mut credential_headers: Vec<(HeaderName, String)> = Vec::new();
    match connection.get("credentialHeaders") {
        None if !headers.is_empty() => return Err(
            "connection.headers 不是空的時候 connection.credentialHeaders 要在（沒有憑證就給 {}）"
                .into(),
        ),
        None => {}
        Some(Value::Object(map)) => {
            for (key, prefix) in map {
                let Value::String(prefix) = prefix else {
                    return Err(format!(
                        "connection.credentialHeaders.{key} 要是字串（prefix，沒有就空字串）"
                    ));
                };
                let name = HeaderName::from_bytes(key.as_bytes()).map_err(|_| {
                    format!("connection.credentialHeaders 的鍵 {key} 不是合法的 header 名")
                })?;
                if credential_headers.iter().any(|(n, _)| *n == name) {
                    return Err(format!(
                        "connection.credentialHeaders 的 {key} 與另一個鍵是同一個 header 名（不分大小寫）"
                    ));
                }
                let mut hits = headers.iter().enumerate().filter(|(_, (n, _))| *n == name);
                let (at, _) = hits.next().ok_or_else(|| {
                    format!("connection.credentialHeaders 的 {key} 不在 connection.headers 裡")
                })?;
                if hits.next().is_some() {
                    return Err(format!(
                        "connection.credentialHeaders 的 {key} 對到 connection.headers 裡不只一個鍵（大小寫不同的同名 header）"
                    ));
                }
                let header = header_keys[at];
                let Some(rest) = header_texts[at].strip_prefix(prefix.as_str()) else {
                    return Err(format!(
                        "connection.headers.{header}（憑證）不是以 connection.credentialHeaders.{key} 的 prefix 開頭"
                    ));
                };
                let checked = check_value(rest, Use::Header).map_err(|rejection| {
                    rejection.message(&format!("connection.headers.{header}（憑證）"))
                })?;
                // 檢查的是修剪後的值，遮蔽器收的是 prefix 之後的原樣：兩者不同，server 回顯修剪後的值就遮不到。TS 只交修剪過的。
                if checked != rest {
                    return Err(format!(
                        "connection.headers.{header}（憑證）prefix 之後頭尾有空白，宿主只收 TS 修剪過的值"
                    ));
                }
                credential_headers.push((name, prefix.clone()));
            }
        }
        Some(_) => return Err("connection.credentialHeaders 要是物件".into()),
    }
    for (key, (name, _)) in header_keys.iter().zip(&headers) {
        if AUTHORIZATION_HEADERS.contains(&name.as_str())
            && !credential_headers.iter().any(|(n, _)| n == name)
        {
            return Err(format!(
                "connection.headers.{key} 是授權用的 header，要列進 connection.credentialHeaders"
            ));
        }
    }
    // 照 zod 解出來的樣子編；`credentialHeaders` 是宿主自己的欄位：空的與沒給是同一份，所以空的不進鍵；名字取小寫、值是 prefix，鍵的順序不計。
    let mut key = Map::new();
    key.insert("transport".into(), "http".into());
    key.insert("url".into(), connection["url"].clone());
    if let Some(headers) = connection.get("headers") {
        key.insert("headers".into(), headers.clone());
    }
    if !credential_headers.is_empty() {
        let mut listed = Map::new();
        for (name, prefix) in &credential_headers {
            listed.insert(name.as_str().into(), prefix.clone().into());
        }
        key.insert("credentialHeaders".into(), Value::Object(listed));
    }
    Ok((
        Connection::Http {
            url,
            headers,
            credential_headers,
        },
        key,
    ))
}

/// 絕對路徑、不含 NUL。
fn absolute_path(text: &str) -> bool {
    text.starts_with('/') && !text.contains('\0')
}

/// stdio 那一支：`command`、`args`、`cwd`、`env`、`credentialEnv`。形狀以外的（程式在不在、能不能跑）留給起行程那一刻。
/// 錯誤訊息只講欄位與名字，不帶值；`credentialEnv` 的值照 [`check_value`] 檢查，訊息指名那個環境變數。
fn parse_stdio(
    connection: &Map<String, Value>,
) -> Result<(Connection, Map<String, Value>), String> {
    for key in connection.keys() {
        if ![
            "transport",
            "command",
            "args",
            "cwd",
            "env",
            "credentialEnv",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("connection 不認得的欄位 {key}"));
        }
    }
    let command = connection
        .get("command")
        .and_then(Value::as_str)
        .filter(|c| absolute_path(c))
        .ok_or("stdio 的 connection.command 要是絕對路徑")?
        .to_string();
    let mut args = Vec::new();
    match connection.get("args") {
        None => {}
        Some(Value::Array(items)) => {
            for item in items {
                match item.as_str().filter(|a| !a.contains('\0')) {
                    Some(arg) => args.push(arg.to_string()),
                    None => return Err("stdio 的 connection.args 要是不含 NUL 的字串陣列".into()),
                }
            }
        }
        Some(_) => return Err("stdio 的 connection.args 要是字串陣列".into()),
    }
    let cwd = match connection.get("cwd") {
        None => None,
        Some(Value::String(cwd)) if absolute_path(cwd) => Some(cwd.clone()),
        Some(_) => return Err("stdio 的 connection.cwd 要是絕對路徑".into()),
    };
    let mut env = Vec::new();
    match connection.get("env") {
        Some(Value::Object(map)) => {
            for (name, value) in map {
                if name.is_empty() || name.contains(['=', '\0']) {
                    return Err(
                        "stdio 的 connection.env 有不合法的名字（空的，或含 = 或 NUL）".into(),
                    );
                }
                match value.as_str().filter(|v| !v.contains('\0')) {
                    Some(text) => env.push((name.clone(), text.to_string())),
                    None => {
                        return Err(format!(
                            "stdio 的 connection.env.{name} 要是不含 NUL 的字串"
                        ))
                    }
                }
            }
        }
        _ => return Err("stdio 的 connection.env 要是物件（TS 算好的整份環境）".into()),
    }
    let mut credential_env: Vec<String> = Vec::new();
    match connection.get("credentialEnv") {
        // 沒有憑證就給 `[]`。漏送會變成起不來，不是憑證靜靜沒被遮；它抓不到的是「送了 `[]` 但其實有憑證」。
        None => return Err("stdio 的 connection.credentialEnv 要在（沒有憑證就給 []）".into()),
        Some(Value::Array(items)) => {
            for item in items {
                let Some(name) = item.as_str() else {
                    return Err("stdio 的 connection.credentialEnv 要是字串陣列".into());
                };
                let Some((_, value)) = env.iter().find(|(n, _)| n == name) else {
                    return Err(format!(
                        "stdio 的 connection.credentialEnv 的 {name} 不在 connection.env 裡"
                    ));
                };
                let checked = check_value(value, Use::Env).map_err(|rejection| {
                    rejection.message(&format!("connection.env.{name}（憑證）"))
                })?;
                // 檢查的是修剪後的值，交給子行程與遮蔽器的是 `env` 裡的原值：兩者不同，server 回顯修剪後的值就遮不到。TS 只交修剪過的。
                if checked != *value {
                    return Err(format!(
                        "stdio 的 connection.env.{name}（憑證）頭尾有空白或換行，宿主只收 TS 修剪過的值"
                    ));
                }
                if !credential_env.iter().any(|n| n == name) {
                    credential_env.push(name.to_string());
                }
            }
        }
        Some(_) => return Err("stdio 的 connection.credentialEnv 要是字串陣列".into()),
    }
    // 池的鍵：宿主收到的成品。同一份成品是同一份（鍵的順序不計，`env` 與 `credentialEnv` 的順序也不計）；
    // 值帶在鍵裡，換了憑證就是另一份。
    let mut key = Map::new();
    key.insert("transport".into(), "stdio".into());
    key.insert("command".into(), command.clone().into());
    key.insert(
        "args".into(),
        Value::Array(args.iter().cloned().map(Value::from).collect()),
    );
    if let Some(cwd) = &cwd {
        key.insert("cwd".into(), cwd.clone().into());
    }
    let mut key_env = Map::new();
    for (name, value) in &env {
        key_env.insert(name.clone(), value.clone().into());
    }
    key.insert("env".into(), Value::Object(key_env));
    let mut sorted = credential_env.clone();
    sorted.sort();
    key.insert(
        "credentialEnv".into(),
        Value::Array(sorted.into_iter().map(Value::from).collect()),
    );
    Ok((
        Connection::Stdio(Stdio {
            command,
            args,
            cwd,
            env,
            credential_env,
            startup_timeout: STDIO_STARTUP_TIMEOUT,
        }),
        key,
    ))
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
        let (parsed, key_connection) = match connection.get("transport").and_then(Value::as_str) {
            Some("http") => parse_http(connection)?,
            Some("stdio") => parse_stdio(connection)?,
            _ => return Err("connection.transport 要是 http 或 stdio".into()),
        };
        let tool_call_timeout_ms = positive_int(fields, "toolCallTimeoutMs", MAX_SAFE_INTEGER)?
            .unwrap_or(DEFAULT_TOOL_CALL_TIMEOUT.as_millis() as u64);
        let max_instruction_bytes = positive_int(fields, "maxInstructionBytes", MAX_SAFE_INTEGER)?
            .map_or(Ok(DEFAULT_MAX_INSTRUCTION_BYTES), usize::try_from)
            .map_err(|_| "maxInstructionBytes 太大".to_string())?;
        let reconnect = Policy::parse(fields.get("reconnect"))?;
        let fail_on_startup_error = boolean(fields, "failOnStartupError", false)?;
        let elicitation = boolean(fields, "elicitation", true)?;
        // `livenessTimeoutMs` 只有 stdio 用；HTTP 照收、不用，型別照樣核。
        let liveness_timeout_ms =
            positive_int(fields, "livenessTimeoutMs", MAX_LIVENESS_TIMEOUT_MS)?
                .unwrap_or(DEFAULT_LIVENESS_TIMEOUT_MS);

        // 照 zod 解出來的樣子編：預設值填好，數字一律當浮點數寫，`500` 與 `500.0` 編成同一個。
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

        let liveness_timeout = matches!(parsed, Connection::Stdio(_))
            .then(|| Duration::from_millis(liveness_timeout_ms));
        Ok(Server {
            name,
            connection: parsed,
            tool_call_timeout: Duration::from_millis(tool_call_timeout_ms),
            liveness_timeout,
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

    /// 這一列要遮的字串，交給 [`super::redact::Redactor::new`]。
    ///
    /// - HTTP：`credentialHeaders` 標的那幾個 header：整個值與 prefix 之後的憑證本身（server 可能只回顯憑證），各取原始位元組，
    ///   能解成 UTF-8 就收那個字串，含非 ASCII 時另收逐位元組當 Latin-1 的字串；`Authorization` 與 `Proxy-Authorization` 另收 scheme 後面那一段
    ///   （沒寫 prefix 時 scheme 在憑證值裡，server 常只回顯 token）。沒標的 header 是字面值，不收。
    ///   網址的 query：整串、每個值的原樣與解碼後，設定格式分不出哪些是憑證所以一律收，代價是多遮、不會漏。reqwest 的錯誤會印出帶 query 的網址。
    /// - stdio：只收 `credentialEnv` 標的那幾個環境變數的值。TS 看得到每個值的來源，`PATH`、`HOME` 這類清洗後的父環境不進，否則成功結果會被遮得不能用。
    pub fn secrets(&self) -> Vec<String> {
        let (url, headers, credential_headers) = match &self.connection {
            Connection::Http {
                url,
                headers,
                credential_headers,
            } => (url, headers, credential_headers),
            Connection::Stdio(stdio) => {
                return stdio
                    .credential_env
                    .iter()
                    .filter_map(|name| stdio.env.iter().find(|(n, _)| n == name))
                    .map(|(_, value)| value.clone())
                    .filter(|value| !value.is_empty())
                    .collect();
            }
        };
        let mut out: Vec<String> = Vec::new();
        for (name, prefix) in credential_headers {
            let Some((_, value)) = headers.iter().find(|(n, _)| n == name) else {
                continue;
            };
            let Ok(text) = std::str::from_utf8(value.as_bytes()) else {
                continue;
            };
            let mut parts = vec![text];
            if !prefix.is_empty() {
                parts.extend(text.strip_prefix(prefix.as_str()));
            }
            let mut texts: Vec<String> = Vec::new();
            for part in parts {
                texts.push(part.to_string());
                if !part.is_ascii() {
                    texts.push(part.bytes().map(char::from).collect());
                }
            }
            if AUTHORIZATION_HEADERS.contains(&name.as_str()) {
                let tokens: Vec<String> = texts
                    .iter()
                    .filter_map(|t| t.split_once(char::is_whitespace))
                    .map(|(_, rest)| rest.trim().to_string())
                    .collect();
                texts.extend(tokens);
            }
            texts.sort();
            texts.dedup();
            out.extend(texts);
        }
        if let Some(query) = url.query() {
            out.push(query.to_string());
            for pair in query.split('&') {
                out.push(pair.split_once('=').map_or(pair, |(_, v)| v).to_string());
            }
            out.extend(url.query_pairs().map(|(_, v)| v.into_owned()));
        }
        out.retain(|s| !s.is_empty());
        out
    }

    /// 錯誤與日誌裡顯示的網址：拿掉 query 與 fragment。stdio 沒有網址，回空字串。
    pub fn shown_url(&self) -> String {
        let Connection::Http { url, .. } = &self.connection else {
            return String::new();
        };
        let mut url = url.clone();
        url.set_query(None);
        url.set_fragment(None);
        url.to_string()
    }
}

pub use super::redact::scrub;
