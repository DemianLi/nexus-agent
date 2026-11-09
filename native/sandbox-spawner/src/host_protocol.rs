//! 前台與對話行程連宿主 socket（`<run dir>/host.sock`）的協定。框格式同 [`crate::protocol`]（u32 LE 長度＋內容），內容是一份 JSON
//! 物件（[`crate::json`]），`type` 欄位分種類。兩邊從同一份向量檔 `host-vectors.json` 驗。
//!
//! 連上之後客戶端的第一框是 `hello`，帶協定版本與監督行程在控制通道上交給它的 token。宿主照 `SO_PEERCRED` 的 pid 查監督行程給的身分表：
//! pid 對得上、token 相同、版本相等才回 `hello`；否則回 `rejected` 並斷線。客戶端目前只送 `hello` 一種（服務的種類見 #2569）。
//!
//! 上限都是常數：一框最長 [`MAX_FRAME`]，JSON 巢狀最多 [`crate::json::MAX_DEPTH`] 層，每條連線未處理的位元組最多
//! [`crate::supervisor::process::INBOX_FRAMES`] 個框長。超過、解不開、種類不認得，都算違反協定。

use crate::json::{self, Value};
use crate::protocol::DecodeError;
use crate::supervisor_protocol::PROTOCOL_VERSION;

/// 宿主連線上一框最長多少。
pub const MAX_FRAME: usize = 256 * 1024;

/// 客戶端送給宿主的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    Hello { version: u32, token: String },
}

/// 宿主送給客戶端的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostMessage {
    Hello { version: u32 },
    /// 不收這條連線，送完就斷。
    Rejected { reason: String },
}

fn object(payload: &[u8]) -> Result<(String, Vec<(String, Value)>), DecodeError> {
    let Value::Object(fields) = json::parse(payload).map_err(|err| DecodeError(err.0))? else {
        return Err(DecodeError("不是物件"));
    };
    let kind = fields
        .iter()
        .find(|(key, _)| key == "type")
        .and_then(|(_, value)| value.as_str())
        .ok_or(DecodeError("少了 type"))?
        .to_string();
    Ok((kind, fields))
}

/// 照 `keys` 的順序取欄位：每一個都要有，也不能多出別的。
fn fields<'a, const N: usize>(fields: &'a [(String, Value)], keys: [&str; N]) -> Result<[&'a Value; N], DecodeError> {
    if fields.len() != N + 1 {
        return Err(DecodeError("欄位不對"));
    }
    let mut out = [&Value::Null; N];
    for (slot, key) in out.iter_mut().zip(keys) {
        *slot = fields.iter().find(|(k, _)| k == key).map(|(_, v)| v).ok_or(DecodeError("欄位不對"))?;
    }
    Ok(out)
}

fn version(value: &Value) -> Result<u32, DecodeError> {
    value.as_int().and_then(|n| u32::try_from(n).ok()).ok_or(DecodeError("版本不是 u32"))
}

fn string(value: &Value) -> Result<String, DecodeError> {
    value.as_str().map(str::to_string).ok_or(DecodeError("要是字串"))
}

/// 解一份 JSON 物件：`type` 不認得、欄位少了或多了、型別不對都回 [`DecodeError`]，不 panic。
pub fn decode_client_message(payload: &[u8]) -> Result<ClientMessage, DecodeError> {
    let (kind, all) = object(payload)?;
    match kind.as_str() {
        "hello" => {
            let [v, token] = fields(&all, ["version", "token"])?;
            Ok(ClientMessage::Hello { version: version(v)?, token: string(token)? })
        }
        _ => Err(DecodeError("不認得的種類")),
    }
}

/// 編成緊湊 JSON，鍵照 `type` 在前的固定順序；不會失敗。
pub fn encode_client_message(message: &ClientMessage) -> Vec<u8> {
    let fields = match message {
        ClientMessage::Hello { version, token } => vec![
            ("type".to_string(), Value::Str("hello".into())),
            ("version".to_string(), Value::Int(i64::from(*version))),
            ("token".to_string(), Value::Str(token.clone())),
        ],
    };
    json::encode(&Value::Object(fields))
}

/// 同 [`decode_client_message`]，解宿主送給客戶端的。
pub fn decode_host_message(payload: &[u8]) -> Result<HostMessage, DecodeError> {
    let (kind, all) = object(payload)?;
    match kind.as_str() {
        "hello" => {
            let [v] = fields(&all, ["version"])?;
            Ok(HostMessage::Hello { version: version(v)? })
        }
        "rejected" => {
            let [reason] = fields(&all, ["reason"])?;
            Ok(HostMessage::Rejected { reason: string(reason)? })
        }
        _ => Err(DecodeError("不認得的種類")),
    }
}

/// 同 [`encode_client_message`]，編宿主送給客戶端的。
pub fn encode_host_message(message: &HostMessage) -> Vec<u8> {
    let fields = match message {
        HostMessage::Hello { version } => vec![
            ("type".to_string(), Value::Str("hello".into())),
            ("version".to_string(), Value::Int(i64::from(*version))),
        ],
        HostMessage::Rejected { reason } => vec![
            ("type".to_string(), Value::Str("rejected".into())),
            ("reason".to_string(), Value::Str(reason.clone())),
        ],
    };
    json::encode(&Value::Object(fields))
}

/// 帶 [`PROTOCOL_VERSION`] 的 `hello`。
pub fn hello(token: &str) -> ClientMessage {
    ClientMessage::Hello { version: PROTOCOL_VERSION, token: token.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::take_frame_within;

    const VECTORS: &str = include_str!("../host-vectors.json");

    fn vectors() -> Value {
        json::parse(VECTORS.as_bytes()).unwrap()
    }

    fn group<'a>(all: &'a Value, name: &str) -> &'a [Value] {
        all.get(name).and_then(Value::as_array).unwrap_or_else(|| panic!("向量檔少了 {name}"))
    }

    fn text<'a>(entry: &'a Value, key: &str) -> &'a str {
        entry.get(key).and_then(Value::as_str).unwrap_or_else(|| panic!("{entry:?} 少了 {key}"))
    }

    fn unhex(hex: &str) -> Vec<u8> {
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
    }

    fn client_value(message: &ClientMessage) -> Value {
        json::parse(&encode_client_message(message)).unwrap()
    }

    #[test]
    fn limits_and_version_match_the_vector_file() {
        let all = vectors();
        assert_eq!(all.get("protocolVersion").and_then(Value::as_int), Some(i64::from(PROTOCOL_VERSION)));
        assert_eq!(all.get("maxFrame").and_then(Value::as_int), Some(MAX_FRAME as i64));
        assert_eq!(all.get("maxDepth").and_then(Value::as_int), Some(json::MAX_DEPTH as i64));
        assert_eq!(
            all.get("bufferedFrames").and_then(Value::as_int),
            Some(crate::supervisor::process::INBOX_FRAMES as i64)
        );
    }

    #[test]
    fn valid_vectors_decode_and_encode_byte_for_byte() {
        let all = vectors();
        for entry in group(&all, "clientMessages") {
            let bytes = text(entry, "json").as_bytes();
            let message = decode_client_message(bytes).unwrap();
            assert_eq!(encode_client_message(&message), bytes);
            assert_eq!(&client_value(&message), entry.get("value").unwrap());
        }
        for entry in group(&all, "hostMessages") {
            let bytes = text(entry, "json").as_bytes();
            let message = decode_host_message(bytes).unwrap();
            assert_eq!(encode_host_message(&message), bytes);
            assert_eq!(&json::parse(bytes).unwrap(), entry.get("value").unwrap());
        }
    }

    #[test]
    fn invalid_frames_are_errors_or_wait_for_more() {
        let all = vectors();
        for entry in group(&all, "invalidFrames") {
            let mut buf = unhex(text(entry, "hex"));
            let got = take_frame_within(&mut buf, MAX_FRAME);
            match text(entry, "expect") {
                "error" => assert_eq!(got, Err(DecodeError("框太大")), "{}", text(entry, "name")),
                "wait" => assert_eq!(got, Ok(None), "{}", text(entry, "name")),
                other => panic!("不認得的 expect {other}"),
            }
        }
    }

    #[test]
    fn invalid_messages_are_rejected_with_the_listed_reason() {
        let all = vectors();
        let entries = group(&all, "invalidMessages");
        assert!(entries.len() >= 10);
        for entry in entries {
            let got = decode_client_message(&unhex(text(entry, "hex"))).map_err(|err| err.0);
            assert_eq!(got, Err(text(entry, "error")), "{}", text(entry, "name"));
        }
    }

    #[test]
    fn every_truncation_and_bit_flip_decodes_without_panicking() {
        let all = vectors();
        let mut tried = 0;
        let mut inputs: Vec<Vec<u8>> = group(&all, "clientMessages")
            .iter()
            .chain(group(&all, "hostMessages"))
            .map(|entry| text(entry, "json").as_bytes().to_vec())
            .collect();
        inputs.extend(group(&all, "invalidMessages").iter().map(|entry| unhex(text(entry, "hex"))));
        for bytes in &inputs {
            let mut cases: Vec<Vec<u8>> = (0..bytes.len()).map(|n| bytes[..n].to_vec()).collect();
            for bit in 0..bytes.len() * 8 {
                let mut flipped = bytes.clone();
                flipped[bit / 8] ^= 1 << (bit % 8);
                cases.push(flipped);
            }
            for case in cases {
                tried += 1;
                if let Ok(message) = decode_client_message(&case) {
                    assert_eq!(decode_client_message(&encode_client_message(&message)), Ok(message));
                }
                if let Ok(message) = decode_host_message(&case) {
                    assert_eq!(decode_host_message(&encode_host_message(&message)), Ok(message));
                }
                let _ = json::parse(&case);
                let mut framed = (case.len() as u32).to_le_bytes().to_vec();
                framed.extend_from_slice(&case);
                let _ = take_frame_within(&mut framed, MAX_FRAME);
            }
        }
        assert!(tried > 1000, "只試了 {tried} 次");
    }
}
