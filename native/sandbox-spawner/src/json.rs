//! 宿主連線上用的最小 JSON：只收這個 crate 自己的框會用到的那一部分，解外來輸入一律回 `Result`、不 panic。
//!
//! 跟標準 JSON 的差別都是收得比較少：數字只收整數（`i64` 放得下的），不收小數與指數；物件不收重複的鍵；巢狀最多 [`MAX_DEPTH`] 層。
//! 輸入必須是合法的 UTF-8；`\u` 跳脫的代理對要成對，落單的不收。

use std::fmt;

/// 陣列與物件加起來最多幾層。
pub const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Str(String),
    Array(Vec<Value>),
    /// 照出現的順序；鍵不重複。
    Object(Vec<(String, Value)>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsonError(pub &'static str);

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

impl Value {
    /// 物件裡這個鍵的值；不是物件或沒有這個鍵回 `None`。
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Value::Object(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<i64> {
        match self {
            Value::Int(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }
}

/// 解一整份文件：前後可以有空白，之後不能再有別的。
pub fn parse(input: &[u8]) -> Result<Value, JsonError> {
    let text = std::str::from_utf8(input).map_err(|_| JsonError("不是合法的 UTF-8"))?;
    let mut parser = Parser { bytes: text.as_bytes(), at: 0 };
    let value = parser.value(0)?;
    parser.skip_space();
    if parser.at != parser.bytes.len() {
        return Err(JsonError("文件之後還有東西"));
    }
    Ok(value)
}

/// 編成緊湊的 JSON（沒有空白），鍵照 `Value::Object` 裡的順序。
pub fn encode(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    write_value(&mut out, value);
    out
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn next(&mut self) -> Result<u8, JsonError> {
        let b = self.peek().ok_or(JsonError("截斷"))?;
        self.at += 1;
        Ok(b)
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
    }

    fn expect_word(&mut self, word: &[u8]) -> Result<(), JsonError> {
        let end = self.at.checked_add(word.len()).ok_or(JsonError("截斷"))?;
        if self.bytes.get(self.at..end) != Some(word) {
            return Err(JsonError("不認得的字"));
        }
        self.at = end;
        Ok(())
    }

    fn value(&mut self, depth: usize) -> Result<Value, JsonError> {
        self.skip_space();
        match self.peek().ok_or(JsonError("截斷"))? {
            b'n' => self.expect_word(b"null").map(|()| Value::Null),
            b't' => self.expect_word(b"true").map(|()| Value::Bool(true)),
            b'f' => self.expect_word(b"false").map(|()| Value::Bool(false)),
            b'"' => self.string().map(Value::Str),
            b'-' | b'0'..=b'9' => self.int().map(Value::Int),
            b'[' => self.array(depth),
            b'{' => self.object(depth),
            _ => Err(JsonError("不認得的字")),
        }
    }

    fn enter(depth: usize) -> Result<usize, JsonError> {
        if depth >= MAX_DEPTH {
            return Err(JsonError("巢狀太深"));
        }
        Ok(depth + 1)
    }

    fn array(&mut self, depth: usize) -> Result<Value, JsonError> {
        let depth = Self::enter(depth)?;
        self.at += 1;
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Value::Array(items));
        }
        loop {
            items.push(self.value(depth)?);
            self.skip_space();
            match self.next()? {
                b',' => continue,
                b']' => return Ok(Value::Array(items)),
                _ => return Err(JsonError("陣列少了逗號或右括號")),
            }
        }
    }

    fn object(&mut self, depth: usize) -> Result<Value, JsonError> {
        let depth = Self::enter(depth)?;
        self.at += 1;
        let mut fields: Vec<(String, Value)> = Vec::new();
        self.skip_space();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Value::Object(fields));
        }
        loop {
            self.skip_space();
            if self.peek() != Some(b'"') {
                return Err(JsonError("物件的鍵要是字串"));
            }
            let key = self.string()?;
            if fields.iter().any(|(k, _)| *k == key) {
                return Err(JsonError("重複的鍵"));
            }
            self.skip_space();
            if self.next()? != b':' {
                return Err(JsonError("鍵之後少了冒號"));
            }
            let value = self.value(depth)?;
            fields.push((key, value));
            self.skip_space();
            match self.next()? {
                b',' => continue,
                b'}' => return Ok(Value::Object(fields)),
                _ => return Err(JsonError("物件少了逗號或右括號")),
            }
        }
    }

    fn int(&mut self) -> Result<i64, JsonError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        let digits = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        let len = self.at - digits;
        if len == 0 {
            return Err(JsonError("數字沒有位數"));
        }
        if len > 1 && self.bytes.get(digits) == Some(&b'0') {
            return Err(JsonError("數字不能以 0 開頭"));
        }
        if matches!(self.peek(), Some(b'.' | b'e' | b'E')) {
            return Err(JsonError("只收整數"));
        }
        let text = std::str::from_utf8(self.bytes.get(start..self.at).ok_or(JsonError("截斷"))?)
            .map_err(|_| JsonError("不是合法的 UTF-8"))?;
        text.parse::<i64>().map_err(|_| JsonError("數字溢位"))
    }

    fn hex4(&mut self) -> Result<u32, JsonError> {
        let mut n = 0u32;
        for _ in 0..4 {
            let digit = char::from(self.next()?).to_digit(16).ok_or(JsonError("\\u 之後要四個十六進位數字"))?;
            n = n * 16 + digit;
        }
        Ok(n)
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            // 輸入整份是合法的 UTF-8，停下的位置都是 ASCII，切出來的這段一定也是。
            let run = self.bytes.get(start..self.at).ok_or(JsonError("截斷"))?;
            out.push_str(std::str::from_utf8(run).map_err(|_| JsonError("不是合法的 UTF-8"))?);
            match self.next()? {
                b'"' => return Ok(out),
                b'\\' => {}
                _ => return Err(JsonError("字串裡有控制字元")),
            }
            let c = match self.next()? {
                b'"' => '"',
                b'\\' => '\\',
                b'/' => '/',
                b'b' => '\u{8}',
                b'f' => '\u{c}',
                b'n' => '\n',
                b'r' => '\r',
                b't' => '\t',
                b'u' => self.unicode_escape()?,
                _ => return Err(JsonError("不認得的跳脫")),
            };
            out.push(c);
        }
    }

    fn unicode_escape(&mut self) -> Result<char, JsonError> {
        let first = self.hex4()?;
        let code = match first {
            0xD800..=0xDBFF => {
                if self.next()? != b'\\' || self.next()? != b'u' {
                    return Err(JsonError("代理對落單"));
                }
                let second = self.hex4()?;
                if !(0xDC00..=0xDFFF).contains(&second) {
                    return Err(JsonError("代理對落單"));
                }
                0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
            }
            0xDC00..=0xDFFF => return Err(JsonError("代理對落單")),
            _ => first,
        };
        char::from_u32(code).ok_or(JsonError("不是合法的字元"))
    }
}

fn write_value(out: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Null => out.extend_from_slice(b"null"),
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Int(n) => out.extend_from_slice(n.to_string().as_bytes()),
        Value::Str(s) => write_string(out, s),
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_value(out, item);
            }
            out.push(b']');
        }
        Value::Object(fields) => {
            out.push(b'{');
            for (i, (key, item)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_string(out, key);
                out.push(b':');
                write_value(out, item);
            }
            out.push(b'}');
        }
    }
}

/// 跟 `JSON.stringify` 同一套跳脫：`"`、`\`、`\b\f\n\r\t` 用短的，其他控制字元用 `\u00XX`，其餘照原字。
fn write_string(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for c in s.chars() {
        match c {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{8}' => out.extend_from_slice(b"\\b"),
            '\u{c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => out.extend_from_slice(format!("\\u{:04x}", c as u32).as_bytes()),
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_what_it_accepts() {
        let text = br#"{"type":"hello","version":1,"token":"ab\"\\\n\u0001\u00e9","list":[true,false,null,-42,[]],"empty":{}}"#;
        let value = parse(text).unwrap();
        assert_eq!(value.get("version").and_then(Value::as_int), Some(1));
        assert_eq!(value.get("token").and_then(Value::as_str), Some("ab\"\\\n\u{1}\u{e9}"));
        assert_eq!(parse(&encode(&value)).unwrap(), value);
        assert_eq!(parse(" [ 1 , \"\\ud83d\\ude00\" ] ".as_bytes()).unwrap(), Value::Array(vec![Value::Int(1), Value::Str("😀".into())]));
    }

    #[test]
    fn depth_limit_is_exact() {
        let ok = "[".repeat(MAX_DEPTH) + &"]".repeat(MAX_DEPTH);
        assert!(parse(ok.as_bytes()).is_ok());
        let deep = "[".repeat(MAX_DEPTH + 1) + &"]".repeat(MAX_DEPTH + 1);
        assert_eq!(parse(deep.as_bytes()), Err(JsonError("巢狀太深")));
        // 很深的輸入不會因為遞迴把堆疊用完：第 33 層就停。
        let huge = "[".repeat(1 << 20);
        assert_eq!(parse(huge.as_bytes()), Err(JsonError("巢狀太深")));
    }

    #[test]
    fn rejects_what_it_does_not_take() {
        for (input, why) in [
            (&b"{\"a\":1"[..], "截斷"),
            (b"{\"a\":1,\"a\":2}", "重複的鍵"),
            (b"\"\xff\"", "不是合法的 UTF-8"),
            (b"\"\\u12\"", "\\u 之後要四個十六進位數字"),
            (b"\"\\ud800\"", "代理對落單"),
            (b"\"\\udc00\"", "代理對落單"),
            (b"9223372036854775808", "數字溢位"),
            (b"1.5", "只收整數"),
            (b"1e3", "只收整數"),
            (b"01", "數字不能以 0 開頭"),
            (b"-", "數字沒有位數"),
            (b"\"a\nb\"", "字串裡有控制字元"),
            (b"\"\\x\"", "不認得的跳脫"),
            (b"[1 2]", "陣列少了逗號或右括號"),
            (b"{1:2}", "物件的鍵要是字串"),
            (b"nul", "不認得的字"),
            (b"1 2", "文件之後還有東西"),
            (b"", "截斷"),
        ] {
            assert_eq!(parse(input), Err(JsonError(why)), "{}", String::from_utf8_lossy(input));
        }
    }
}
