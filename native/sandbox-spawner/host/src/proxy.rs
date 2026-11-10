//! 宿主對外 HTTP 走哪個代理（#2570）。政策由呼叫端用 [`ProxyPolicy::parse`] 解好，交給 [`crate::tls::http_client`]；宿主不讀環境變數。
//! 比對規則跟 `packages/nexus-core/src/http-proxy/policy.ts` 的 `proxyForUrl` 一致，兩邊用 `proxy-vectors.json` 驗：
//! 迴圈位址一律直連；放行清單只比主機名與埠，不比 CIDR。代理網址只收 `http:`／`https:`。
//!
//! 代理網址可能帶帳密，所以這裡的錯誤訊息只講欄位名，不帶值；[`ProxyPolicy`] 的 `Debug` 也不印網址。

use std::fmt;

use reqwest::Url;

use crate::json::Value;

/// 一份代理政策。兩個代理都沒有就是直連。
#[derive(Clone, Default, PartialEq, Eq)]
pub struct ProxyPolicy {
    http_proxy: Option<Url>,
    https_proxy: Option<Url>,
    no_proxy: String,
}

impl fmt::Debug for ProxyPolicy {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ProxyPolicy")
            .field("http_proxy", &self.http_proxy.is_some())
            .field("https_proxy", &self.https_proxy.is_some())
            .field("no_proxy", &self.no_proxy)
            .finish()
    }
}

const SOCKS: [&str; 5] = ["socks", "socks4", "socks4a", "socks5", "socks5h"];

impl ProxyPolicy {
    pub fn direct() -> ProxyPolicy {
        ProxyPolicy::default()
    }

    /// 兩個代理都沒有。
    pub fn is_direct(&self) -> bool {
        self.http_proxy.is_none() && self.https_proxy.is_none()
    }

    /// 解 `{ httpProxy?, httpsProxy?, noProxy? }`（`policy.ts` 的 `ProxyPolicy`，`source` 可有可無、不看）。
    /// 不認得的欄位、型別不對、網址解析不了、SOCKS 或其他協定，都回錯；訊息不帶值。
    pub fn parse(value: &Value) -> Result<ProxyPolicy, String> {
        let Value::Object(fields) = value else {
            return Err("proxy 要是物件".into());
        };
        let mut policy = ProxyPolicy::default();
        for (key, field) in fields {
            match key.as_str() {
                "httpProxy" => policy.http_proxy = Some(proxy_url("httpProxy", field)?),
                "httpsProxy" => policy.https_proxy = Some(proxy_url("httpsProxy", field)?),
                "noProxy" => {
                    policy.no_proxy = field.as_str().ok_or("proxy.noProxy 要是字串")?.to_string()
                }
                "source" => {}
                _ => return Err(format!("proxy 不認得的欄位 {key}")),
            }
        }
        Ok(policy)
    }

    /// 這個網址走哪個代理；直連回 `None`。
    pub fn proxy_for(&self, url: &Url) -> Option<&Url> {
        let proxy = match url.scheme() {
            "https" => self.https_proxy.as_ref(),
            "http" => self.http_proxy.as_ref(),
            _ => None,
        }?;
        let host = url.host_str().unwrap_or("");
        if is_loopback_host(host) || bypasses_proxy(&self.no_proxy, url) {
            return None;
        }
        Some(proxy)
    }

    /// 錯誤訊息裡要換掉的字串：代理網址整串，以及它的帳號與密碼（原樣與解碼後）。
    pub fn secrets(&self) -> Vec<String> {
        let mut out = Vec::new();
        for url in self.http_proxy.iter().chain(&self.https_proxy) {
            out.push(url.as_str().to_string());
            for part in [url.username(), url.password().unwrap_or("")] {
                if part.is_empty() {
                    continue;
                }
                out.push(part.to_string());
                let decoded = percent_decode(part);
                if decoded != part {
                    out.push(decoded);
                }
            }
        }
        out
    }
}

fn proxy_url(name: &str, value: &Value) -> Result<Url, String> {
    let text = value
        .as_str()
        .ok_or_else(|| format!("proxy.{name} 要是字串"))?;
    let url = Url::parse(text.trim()).map_err(|_| format!("proxy.{name} 不是合法的網址"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme if SOCKS.contains(&scheme) => Err(format!(
            "proxy.{name} 指到 SOCKS 代理，這裡不支援；請改設 http:// 或 https:// 的代理網址"
        )),
        _ => Err(format!(
            "proxy.{name} 用了不支援的協定；請改設 http:// 或 https:// 的代理網址"
        )),
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1..i + 3].iter().all(u8::is_ascii_hexdigit)
        {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn normalize_host(hostname: &str) -> String {
    let host = hostname.strip_prefix('[').unwrap_or(hostname);
    let host = host.strip_suffix(']').unwrap_or(host);
    let host = host.strip_suffix('.').unwrap_or(host);
    host.to_ascii_lowercase()
}

/// IPv4 的一個位元組：0–255，不帶前導零。
fn octet(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 3
        && part.bytes().all(|b| b.is_ascii_digit())
        && (part.len() == 1 || !part.starts_with('0'))
        && part.parse::<u16>().is_ok_and(|n| n <= 255)
}

fn loopback_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4 && parts[0] == "127" && parts[1..].iter().all(|p| octet(p))
}

fn hex_group(part: &str) -> bool {
    (1..=4).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 主機是不是這台機器（`policy.ts` 的 `isLoopbackHost`）：`localhost` 與它的子網域、`::1`、`::`、`0.0.0.0`、整段 `127.0.0.0/8`，
/// 以及 IPv4-mapped 的兩種寫法。
pub fn is_loopback_host(hostname: &str) -> bool {
    let host = normalize_host(hostname);
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    if host == "::1" || host == "::" || host == "0.0.0.0" {
        return true;
    }
    if let Some(rest) = host.strip_prefix("::ffff:") {
        if let Some((high, low)) = rest.split_once(':') {
            if hex_group(high) && hex_group(low) {
                return u16::from_str_radix(high, 16).is_ok_and(|n| n >> 8 == 127);
            }
        }
        return loopback_ipv4(rest);
    }
    loopback_ipv4(&host)
}

/// 放行項目拆成主機與埠：有中括號的從括號後面取埠；只有單一冒號的才拆。
fn split_host_port(entry: &str) -> (&str, Option<&str>) {
    if let Some(rest) = entry.strip_prefix('[') {
        if let Some(close) = rest.find(']') {
            let host = &rest[..close];
            let tail = &rest[close + 1..];
            return (host, tail.strip_prefix(':'));
        }
    }
    if let Some(colon) = entry.find(':') {
        if !entry[colon + 1..].contains(':') {
            return (&entry[..colon], Some(&entry[colon + 1..]));
        }
    }
    (entry, None)
}

/// 放行清單放不放行這個網址（`policy.ts` 的 `bypassesProxy`）：項目指名的主機連同子網域都放行，開頭的 `.` 或 `*.` 視為同一件事，
/// 可帶 `:埠`，`*` 放行全部。不比 CIDR。
pub fn bypasses_proxy(no_proxy: &str, url: &Url) -> bool {
    let host = normalize_host(url.host_str().unwrap_or(""));
    let port = url.port().map_or_else(
        || if url.scheme() == "https" { "443" } else { "80" }.to_string(),
        |p| p.to_string(),
    );
    for raw in no_proxy.split(|c: char| c == ',' || c.is_whitespace()) {
        let entry = raw.trim().to_lowercase();
        if entry.is_empty() {
            continue;
        }
        if entry == "*" {
            return true;
        }
        let (entry_host, entry_port) = split_host_port(&entry);
        if entry_port.is_some_and(|p| p != port) {
            continue;
        }
        let candidate = entry_host
            .strip_prefix("*.")
            .or_else(|| entry_host.strip_prefix('.'))
            .unwrap_or(entry_host);
        let candidate = candidate.strip_suffix('.').unwrap_or(candidate);
        if candidate.is_empty() {
            continue;
        }
        if host == candidate || host.ends_with(&format!(".{candidate}")) {
            return true;
        }
    }
    false
}
