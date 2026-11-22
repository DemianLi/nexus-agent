//! 宿主用的 JSON：解析、編碼與值的型別都是 `serde_json`。這裡加的是巢狀層數的上限、固定的錯誤原因，與手排鍵順序的 [`encode_fields`]。
//!
//! [`encode`] 的物件鍵照碼位（位元組）順序；[`parse`] 遇到重複的鍵取後者（跟 `JSON.parse` 一致）。鍵的順序由 [`encode`] 自己排，
//! 不靠 [`Map`] 的順序：`serde_json` 開了 `preserve_order`（feature 在整個建置統一，相依裡的 serde_json 一樣生效），[`Map`] 留著插入順序，MCP 的工具定義才照 server 送的順序過橋。
//! 輸入要是合法的 UTF-8，`\u` 跳脫的代理對落單的不收。

use std::fmt;

use serde_json::error::Category;
pub use serde_json::{Map, Value};

/// 陣列與物件加起來最多幾層。`serde_json` 自己在 128 層停（那時回「不是合法的 JSON」），這個上限比它小，解完再核。
pub const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JsonError(pub &'static str);

impl fmt::Display for JsonError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}

/// 解一整份文件：前後可以有空白，之後不能再有別的。解外來輸入不 panic，錯誤只有三種：`截斷`（值還沒結束輸入就沒了）、
/// `巢狀太深`（超過 [`MAX_DEPTH`]），其餘一律是 `不是合法的 JSON`（含不合法的 UTF-8、落單的代理對、超出 f64 的數字、到 128 層）。
pub fn parse(input: &[u8]) -> Result<Value, JsonError> {
    let value = serde_json::from_slice(input).map_err(|err| match err.classify() {
        Category::Eof => JsonError("截斷"),
        Category::Io | Category::Syntax | Category::Data => JsonError("不是合法的 JSON"),
    })?;
    if depth(&value) > MAX_DEPTH {
        return Err(JsonError("巢狀太深"));
    }
    Ok(value)
}

fn depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(depth).max().unwrap_or(0),
        Value::Object(fields) => 1 + fields.values().map(depth).max().unwrap_or(0),
        _ => 0,
    }
}

/// 編成緊湊的 JSON（沒有空白）；物件的鍵照碼位順序。字串的跳脫跟 `JSON.stringify` 一樣；浮點數的寫法不一定一樣
/// （例如 `1.0` 編成 `1.0`，`JSON.stringify` 寫 `1`）。
pub fn encode(value: &Value) -> Vec<u8> {
    let mut out = Vec::new();
    write(&mut out, value);
    out
}

/// 編一個鍵照 `fields` 順序排的物件，值照 [`encode`]。不查重複的鍵。
pub fn encode_fields(fields: &[(&str, &Value)]) -> Vec<u8> {
    let mut out = vec![b'{'];
    for (i, (key, value)) in fields.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        write(&mut out, &Value::from(*key));
        out.push(b':');
        write(&mut out, value);
    }
    out.push(b'}');
    out
}

fn write(out: &mut Vec<u8>, value: &Value) {
    match value {
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write(out, item);
            }
            out.push(b']');
        }
        Value::Object(fields) => {
            let mut sorted: Vec<(&String, &Value)> = fields.iter().collect();
            sorted.sort_unstable_by(|a, b| a.0.cmp(b.0));
            out.push(b'{');
            for (i, (key, item)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                scalar(out, &Value::String(key.clone()));
                out.push(b':');
                write(out, item);
            }
            out.push(b'}');
        }
        _ => scalar(out, value),
    }
}

fn scalar(out: &mut Vec<u8>, value: &Value) {
    // 寫進 Vec 不會有 IO 錯誤，純量編碼不會失敗。
    serde_json::to_writer(out, value).expect("Value 編進 Vec 不會失敗");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_escapes_like_json_stringify() {
        let text = br#"{"list":[true,false,null,-42,1.5,[]],"token":"ab\"\\\n\u0001\u00e9/","type":"hello","version":1}"#;
        let value = parse(text).unwrap();
        assert_eq!(value.get("version").and_then(Value::as_i64), Some(1));
        assert_eq!(
            value.get("token").and_then(Value::as_str),
            Some("ab\"\\\n\u{1}\u{e9}/")
        );
        assert_eq!(
            String::from_utf8(encode(&value)).unwrap(),
            r#"{"list":[true,false,null,-42,1.5,[]],"token":"ab\"\\\n\u0001é/","type":"hello","version":1}"#
        );
        assert_eq!(parse(&encode(&value)).unwrap(), value);
        assert_eq!(
            parse(" [ 1 , \"\\ud83d\\ude00\" ] ".as_bytes()).unwrap(),
            serde_json::json!([1, "😀"])
        );
    }

    #[test]
    fn keys_sort_except_where_fields_are_laid_out_by_hand() {
        let value = parse(br#"{"b":1,"a":{"d":2,"c":3}}"#).unwrap();
        assert_eq!(encode(&value), br#"{"a":{"c":3,"d":2},"b":1}"#);
        assert_eq!(
            encode_fields(&[("type", &Value::from("x")), ("a", &value)]),
            br#"{"type":"x","a":{"a":{"c":3,"d":2},"b":1}}"#
        );
        assert_eq!(encode_fields(&[]), b"{}");
    }

    #[test]
    fn keys_sort_by_code_point_whatever_the_insertion_order() {
        let mut inner = Map::new();
        for key in ["é", "z", "A", "a", "😀", "b"] {
            inner.insert(key.to_string(), Value::from(key.len()));
        }
        let mut outer = Map::new();
        outer.insert("y".into(), Value::Array(vec![Value::Object(inner)]));
        outer.insert("x".into(), Value::Null);
        assert_eq!(
            String::from_utf8(encode(&Value::Object(outer))).unwrap(),
            r#"{"x":null,"y":[{"A":1,"a":1,"b":1,"z":1,"é":2,"😀":4}]}"#
        );
    }

    #[test]
    fn duplicate_keys_take_the_last_one() {
        assert_eq!(
            parse(br#"{"a":1,"a":2}"#).unwrap(),
            serde_json::json!({"a": 2})
        );
    }

    #[test]
    fn depth_limit_is_exact() {
        let nest = |n: usize| parse(("[".repeat(n) + &"]".repeat(n)).as_bytes());
        let too_deep = Err(JsonError("巢狀太深"));
        assert!(nest(MAX_DEPTH).is_ok());
        assert_eq!(nest(MAX_DEPTH + 1), too_deep);
        let objects = "{\"a\":".repeat(MAX_DEPTH) + "{}" + &"}".repeat(MAX_DEPTH);
        assert_eq!(parse(objects.as_bytes()), too_deep);
        // 到 serde_json 自己的 128 層，它先停下來，原因是「不是合法的 JSON」；很深的輸入不會把堆疊用完。
        let invalid = Err(JsonError("不是合法的 JSON"));
        assert_eq!(nest(128), invalid);
        assert_eq!(parse("[".repeat(1 << 20).as_bytes()), invalid);
    }

    #[test]
    fn rejects_what_it_does_not_take() {
        for (input, why) in [
            (&b"{\"a\":1"[..], "截斷"),
            (b"\"\\u12\"", "截斷"),
            (b"", "截斷"),
            (b"-", "截斷"),
            (b"\"\xff\"", "不是合法的 JSON"),
            (b"\"\\ud800\"", "不是合法的 JSON"),
            (b"\"\\udc00\"", "不是合法的 JSON"),
            (b"[1e400]", "不是合法的 JSON"),
            (b"01", "不是合法的 JSON"),
            (b"\"a\nb\"", "不是合法的 JSON"),
            (b"\"\\x\"", "不是合法的 JSON"),
            (b"[1 2]", "不是合法的 JSON"),
            (b"{1:2}", "不是合法的 JSON"),
            (b"nul", "截斷"),
            (b"1 2", "不是合法的 JSON"),
        ] {
            assert_eq!(
                parse(input),
                Err(JsonError(why)),
                "{}",
                String::from_utf8_lossy(input)
            );
        }
    }

    #[test]
    fn numbers_keep_integers_and_take_decimals() {
        let past_f64 = 9_007_199_254_740_993;
        assert_eq!(parse(b"9007199254740993").unwrap().as_u64(), Some(past_f64));
        assert_eq!(parse(b"-1").unwrap().as_i64(), Some(-1));
        assert_eq!(parse(b"1.0").unwrap().as_u64(), None);
        assert_eq!(parse(b"1.0").unwrap().as_f64(), Some(1.0));
        // u64 放不下的整數變成浮點，不算整數。
        assert_eq!(parse(b"99999999999999999999").unwrap().as_u64(), None);
        assert_eq!(encode(&parse(b"1e21").unwrap()), b"1e+21");
    }
}
