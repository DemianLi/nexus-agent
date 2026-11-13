//! 宿主送回對話行程的文字裡，已解析的憑證值要遮掉（#2570）。規則與樣本見 `docs/credentials-file.md`〈MCP 憑證值的遮蔽〉。
//!
//! 入口只有 [`Redactor::new`]：呼叫端把「這一份連線手上所有已解析的值」交進來，之後送出的每一段文字都過它。
//! 值的來源（header 的值、網址的 query、代理的帳密，之後還有憑證引用解出來的）由呼叫端決定，這裡不分來源。
//!
//! 遮的方式：每個值連同它的幾種編碼形式，在原文上找出所有命中的區間，合併重疊與相鄰的，一次換成 `[redacted]`。
//! 不是逐值各換一次，所以兩個重疊的值不會漏，占位字串也不會被後面的值打中。

/// 占位字串。
pub const PLACEHOLDER: &str = "[redacted]";

/// 憑證值修剪後至少要有幾個 code point（#2570）。更短的憑證值在值檢查拒絕，所以不到這個長度的只可能是設定裡的字面值（見 [`Redactor`] 的 `errors_only`）。
pub const MIN_VALUE_CODE_POINTS: usize = 8;

/// 一組要遮的值，與它們所有編碼形式的比對字串。
#[derive(Clone, Default)]
pub struct Redactor {
    /// 修剪後夠長的值的各形式：任何送出的文字都遮。
    everywhere: Vec<String>,
    /// 不到 [`MIN_VALUE_CODE_POINTS`] 的值的各形式：只遮錯誤與診斷。
    ///
    /// 憑證值短於門檻會在值檢查被拒，所以這些只可能是設定裡寫死的字面值（網址 query 的片段、短的 header 值）。
    /// 它們出現在 server 的成功結果裡是正常的內容（`limit=10` 的 `10`），遮了會把答案改壞；出現在連線錯誤裡則是 reqwest 印出來的網址，要遮。
    errors_only: Vec<String>,
}

/// `Debug` 不印比對字串：那就是秘密。
impl std::fmt::Debug for Redactor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Redactor")
            .field("everywhere", &self.everywhere.len())
            .field("errors_only", &self.errors_only.len())
            .finish()
    }
}

impl Redactor {
    /// 收一組值。空字串丟掉；重複的併成一個。值不修剪：要修剪的由呼叫端先做（值檢查回的就是修過的）。
    pub fn new<I: IntoIterator<Item = String>>(values: I) -> Self {
        let mut everywhere = Vec::new();
        let mut errors_only = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for value in values {
            if value.is_empty() || !seen.insert(value.clone()) {
                continue;
            }
            let target = if value.chars().count() >= MIN_VALUE_CODE_POINTS {
                &mut everywhere
            } else {
                &mut errors_only
            };
            for form in forms(&value) {
                if !target.contains(&form) {
                    target.push(form);
                }
            }
        }
        Redactor {
            everywhere,
            errors_only,
        }
    }

    /// 錯誤與診斷的文字：所有值都遮。
    pub fn scrub_text(&self, text: &str) -> String {
        let all: Vec<&str> = self
            .everywhere
            .iter()
            .chain(&self.errors_only)
            .map(String::as_str)
            .collect();
        replace_spans(text, &all)
    }

    /// 成功結果裡的一段文字：夠長的值遮。
    pub fn redact_text(&self, text: &str) -> String {
        let all: Vec<&str> = self.everywhere.iter().map(String::as_str).collect();
        replace_spans(text, &all)
    }

    /// 成功結果與 resources 的 JSON 值，原地遮：每個字串的內容都遮。
    ///
    /// 不動的有兩種，都是 server 之後要原樣收回去的識別，遮了就叫不動、讀不到：
    /// 物件的鍵（工具 schema 的參數名、結果的欄位名），與值是字串的 `uri`、`uriTemplate`（resources 與 resource_link）。
    /// 遮的是字串內容、不是序列化後的文字，所以換掉的區間不會跨過 JSON 的引號而把結果弄成不合法的 JSON。
    pub fn redact_json(&self, value: &mut serde_json::Value) {
        self.walk(value, &IDENTIFIER_KEYS);
    }

    /// 工具清單（`tools/list` 列出的陣列）：同 [`Redactor::redact_json`]，另外每個工具自己的 `name` 不動（`tools/call` 要用它）。
    pub fn redact_tool_list(&self, tools: &mut serde_json::Value) {
        let Some(list) = tools.as_array_mut() else {
            return self.redact_json(tools);
        };
        for tool in list {
            match tool.as_object_mut() {
                Some(fields) => {
                    for (key, field) in fields.iter_mut() {
                        if true {
                            self.walk(field, &IDENTIFIER_KEYS);
                        }
                    }
                }
                None => self.walk(tool, &IDENTIFIER_KEYS),
            }
        }
    }

    fn walk(&self, value: &mut serde_json::Value, keep: &[&str]) {
        use serde_json::Value as J;
        if self.everywhere.is_empty() {
            return;
        }
        match value {
            J::String(s) => {
                let redacted = self.redact_text(s);
                if redacted != *s {
                    *s = redacted;
                }
            }
            J::Array(items) => items.iter_mut().for_each(|v| self.walk(v, keep)),
            J::Object(map) => {
                for (key, field) in map.iter_mut() {
                    if !(field.is_string() && keep.contains(&key.as_str())) {
                        self.walk(field, keep);
                    }
                }
            }
            _ => {}
        }
    }
}

/// 值是字串時不遮的欄位名：server 之後要原樣收回去的識別。
const IDENTIFIER_KEYS: [&str; 0] = [];

/// 長的值先換、重疊不漏：這是舊的逐值替換的入口，給只有一組字串、要遮錯誤文字的呼叫端。
pub fn scrub(text: &str, secrets: &[String]) -> String {
    Redactor::new(secrets.iter().cloned()).scrub_text(text)
}

/// 一個值的比對形式：原值、`encodeURIComponent`、form 編碼（空白寫成 `+`）、JSON 字串裡的跳脫（含把 `/` 寫成 `\\/` 的）。
/// 百分號與 `\u` 的十六進位只收全大寫與全小寫，不收同一段裡大小寫混用的。
fn forms(value: &str) -> Vec<String> {
    let mut out = vec![value.to_string()];
    for upper in [true, false] {
        out.push(percent(value, upper, false));
        out.push(percent(value, upper, true));
        out.push(json_escaped(value, upper, false));
        out.push(json_escaped(value, upper, true));
    }
    // 別家的 JSON 編碼器（PHP 等）把 `/` 寫成 `\/`。
    let slashed: Vec<String> = out
        .iter()
        .filter(|f| f.contains('/'))
        .map(|f| f.replace('/', "\\/"))
        .collect();
    let _ = slashed;
    out.retain(|f| !f.is_empty());
    out.sort();
    out.dedup();
    out
}

/// `encodeURIComponent`（`form` 為假）或 `application/x-www-form-urlencoded`（`form` 為真）。
fn percent(value: &str, upper: bool, form: bool) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let keep = byte.is_ascii_alphanumeric()
            || if form {
                matches!(byte, b'*' | b'-' | b'.' | b'_')
            } else {
                matches!(
                    byte,
                    b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
                )
            };
        if keep {
            out.push(byte as char);
        } else if form && byte == b' ' {
            out.push('+');
        } else if upper {
            out.push_str(&format!("%{byte:02X}"));
        } else {
            out.push_str(&format!("%{byte:02x}"));
        }
    }
    out
}

/// JSON 字串裡的樣子（不含兩側的引號）。`ascii` 為真時非 ASCII 字元也寫成 `\uXXXX`（補充平面用代理對）；
/// 為假時只跳脫 `"`、`\` 與控制字元，跟 `serde_json` 與 `JSON.stringify` 一樣。
fn json_escaped(value: &str, upper: bool, ascii: bool) -> String {
    let mut out = String::new();
    let unit = |out: &mut String, u: u16| {
        if upper {
            out.push_str(&format!("\\u{u:04X}"));
        } else {
            out.push_str(&format!("\\u{u:04x}"));
        }
    };
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => unit(&mut out, c as u16),
            c if ascii && !c.is_ascii() => {
                let mut buf = [0u16; 2];
                for u in c.encode_utf16(&mut buf) {
                    unit(&mut out, *u);
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// 找出所有樣式在 `text` 裡的命中區間（同一個樣式自己重疊的也找），合併重疊與相鄰的，每一段換成 [`PLACEHOLDER`]。
fn replace_spans(text: &str, patterns: &[&str]) -> String {
    let mut spans: Vec<(usize, usize)> = Vec::new();
    for pattern in patterns.iter().filter(|p| !p.is_empty()) {
        let mut from = 0;
        while let Some(at) = text[from..].find(pattern) {
            let start = from + at;
            spans.push((start, start + pattern.len()));
            // 從命中處的下一個字元再找：`aa` 在 `aaa` 裡有兩處。
            from = start + text[start..].chars().next().map_or(1, char::len_utf8);
        }
    }
    if spans.is_empty() {
        return text.to_string();
    }
    spans.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(spans.len());
    for (start, end) in spans {
        match merged.last_mut() {
            Some(last) if start < last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    let mut out = String::with_capacity(text.len());
    let mut at = 0;
    for (start, end) in merged {
        out.push_str(&text[at..start]);
        out.push_str(PLACEHOLDER);
        at = end;
    }
    out.push_str(&text[at..]);
    out
}

/// 值要代入哪裡。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Use {
    Env,
    Header,
}

/// 值為什麼被拒。訊息只講憑證名、來源層與規則，不含值的任何片段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejection {
    /// 修剪後是空的。
    Empty,
    /// 修剪後少於 [`MIN_VALUE_CODE_POINTS`] 個 code point。
    TooShort,
    /// `env` 的值含 NUL。
    Nul,
    /// `header` 的值含放不下的字元。
    HeaderChars,
}

impl Rejection {
    /// 樣本檔 `mcpValue[].reason` 用的名字。
    pub fn code(self) -> &'static str {
        match self {
            Rejection::Empty => "empty",
            Rejection::TooShort => "too-short",
            Rejection::Nul => "nul",
            Rejection::HeaderChars => "header-chars",
        }
    }

    /// 拒收的訊息，`from` 是「名字（來自哪一層）」。同 TS 的 `assertUsableMcpCredential`。
    pub fn message(self, from: &str) -> String {
        match self {
            Rejection::Empty => {
                format!("{from}是空白的。請把它改成憑證本身，或把那一行拿掉。")
            }
            Rejection::TooShort => format!(
                "{from}修掉頭尾空白之後不到 {MIN_VALUE_CODE_POINTS} 個字元。太短的值在回應裡偶然撞上的機率高，遮蔽會把正常內容一起遮掉；請換成較長的憑證，或把它改寫成字面值。"
            ),
            Rejection::Nul => format!("{from}含有 NUL 字元，放不進環境變數。"),
            Rejection::HeaderChars => format!(
                "{from}含有 HTTP header 放不下的字元（換行、NUL 等控制字元，或 U+00FF 之後的字元）。"
            ),
        }
    }
}

/// 跟 JS 的 `String.prototype.trim` 一樣的空白：Rust 的 `char::is_whitespace` 多收 U+0085、少收 U+FEFF。
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{FEFF}'
}

/// 收下一個要交給 MCP server 的憑證值，或拒收。回修掉頭尾空白的值。同 TS 的 `assertUsableMcpCredential`，兩邊用同一份樣本（`mcpValue`）。
pub fn check_value(value: &str, using: Use) -> Result<String, Rejection> {
    let value = value.trim_matches(is_js_space);
    if value.is_empty() {
        return Err(Rejection::Empty);
    }
    match using {
        Use::Env if value.contains('\0') => return Err(Rejection::Nul),
        Use::Header
            if !value
                .chars()
                .all(|c| matches!(c, '\t' | '\u{20}'..='\u{7E}' | '\u{80}'..='\u{FF}')) =>
        {
            return Err(Rejection::HeaderChars);
        }
        _ => {}
    }

    Ok(value.to_string())
}
