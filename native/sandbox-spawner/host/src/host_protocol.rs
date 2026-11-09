//! 前台與對話行程連宿主 socket（`<run dir>/host.sock`）的協定。框格式同 [`nexus_sandbox_spawner::protocol`]（u32 LE 長度＋內容），內容是一份 JSON
//! 物件（[`crate::json`]），`type` 欄位分種類。兩邊從同一份向量檔 `host-vectors.json` 驗。
//!
//! 連上之後客戶端的第一框是 `hello`，帶協定版本（[`HOST_PROTOCOL_VERSION`]）與監督行程在控制通道上交給它的 token。宿主照 `SO_PEERCRED`
//! 的 pid 查監督行程給的身分表：pid 對得上、token 相同、版本相等才回 `hello`；否則回 `rejected` 並斷線。
//!
//! 之後客戶端送 `call`（叫一個服務的一個方法）與 `cancel`（不要某一次了）；宿主回 `chunk`（串流的一塊）、`result`（一次呼叫的終點，
//! 每個 `id` 剛好一框，取消的也有），並主動推 `event`。只傳資料。
//!
//! `call`、`cancel`、`chunk`、`result` 都帶 `side`：`id` 是哪一邊發的。現在只有客戶端發呼叫（`"c"`）；`"h"` 留給宿主反過來發請求，
//! 解得開，但宿主收到就判違反協定。
//!
//! 上限都是常數：一框最長 [`MAX_FRAME`]，JSON 巢狀最多 [`crate::json::MAX_DEPTH`] 層，每條連線未處理的位元組最多
//! [`nexus_sandbox_spawner::supervisor::process::INBOX_FRAMES`] 個框長，`id` 最大 [`MAX_ID`]。超過、解不開、種類不認得，都算違反協定。

use crate::json::{self, Value};
use nexus_sandbox_spawner::protocol::DecodeError;

/// 宿主連線的協定版本。跟監督行程控制通道的版本（[`nexus_sandbox_spawner::supervisor_protocol::PROTOCOL_VERSION`]）各自獨立。
/// 不用 3：那是控制通道的版本，送 3 進來的客戶端判版本不對，不當成這一版。
pub const HOST_PROTOCOL_VERSION: u32 = 4;

/// 宿主連線上一框最長多少。
pub const MAX_FRAME: usize = 256 * 1024;

/// `id` 最大多少：JavaScript 的 number 精確表示得了的最大整數。
pub const MAX_ID: u64 = (1 << 53) - 1;

/// `id` 是哪一邊發的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Client,
    Host,
}

/// 一次呼叫失敗的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    UnknownService,
    UnknownMethod,
    BadPayload,
    /// 這條連線同時在跑的呼叫已經到上限。
    Busy,
    Cancelled,
    /// 這一塊或結果編出來超過一框。
    TooLarge,
    ServiceError,
}

impl ErrorCode {
    /// 全部的錯誤碼；順序跟向量檔的 `errorCodes` 相同（兩邊的測試逐項比）。
    pub const ALL: [ErrorCode; 7] = [
        ErrorCode::UnknownService,
        ErrorCode::UnknownMethod,
        ErrorCode::BadPayload,
        ErrorCode::Busy,
        ErrorCode::Cancelled,
        ErrorCode::TooLarge,
        ErrorCode::ServiceError,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::UnknownService => "unknown_service",
            ErrorCode::UnknownMethod => "unknown_method",
            ErrorCode::BadPayload => "bad_payload",
            ErrorCode::Busy => "busy",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::TooLarge => "too_large",
            ErrorCode::ServiceError => "service_error",
        }
    }

    fn parse(text: &str) -> Option<ErrorCode> {
        ErrorCode::ALL
            .into_iter()
            .find(|code| code.as_str() == text)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CallError {
    pub code: ErrorCode,
    pub message: String,
}

/// 客戶端送給宿主的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClientMessage {
    Hello {
        version: u32,
        token: String,
    },
    Call {
        side: Side,
        id: u64,
        service: String,
        method: String,
        payload: Value,
    },
    Cancel {
        side: Side,
        id: u64,
    },
}

/// 宿主送給客戶端的。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostMessage {
    Hello {
        version: u32,
    },
    /// 不收這條連線，送完就斷。
    Rejected {
        reason: String,
    },
    /// 串流的一塊；`seq` 每次呼叫從 0 起。
    Chunk {
        side: Side,
        id: u64,
        seq: u64,
        payload: Value,
    },
    Result {
        side: Side,
        id: u64,
        outcome: Result<Value, CallError>,
    },
    Event {
        service: String,
        topic: String,
        payload: Value,
    },
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
fn fields<'a, const N: usize>(
    fields: &'a [(String, Value)],
    keys: [&str; N],
) -> Result<[&'a Value; N], DecodeError> {
    if fields.len() != N + 1 {
        return Err(DecodeError("欄位不對"));
    }
    let mut out = [&Value::Null; N];
    for (slot, key) in out.iter_mut().zip(keys) {
        *slot = fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .ok_or(DecodeError("欄位不對"))?;
    }
    Ok(out)
}

fn version(value: &Value) -> Result<u32, DecodeError> {
    value
        .as_int()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or(DecodeError("版本不是 u32"))
}

fn string(value: &Value) -> Result<String, DecodeError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or(DecodeError("要是字串"))
}

fn id(value: &Value) -> Result<u64, DecodeError> {
    value
        .as_int()
        .and_then(|n| u64::try_from(n).ok())
        .filter(|&n| n <= MAX_ID)
        .ok_or(DecodeError("id 不在範圍內"))
}

fn seq(value: &Value) -> Result<u64, DecodeError> {
    value
        .as_int()
        .and_then(|n| u64::try_from(n).ok())
        .ok_or(DecodeError("seq 不在範圍內"))
}

fn side(value: &Value) -> Result<Side, DecodeError> {
    match value.as_str() {
        Some("c") => Ok(Side::Client),
        Some("h") => Ok(Side::Host),
        _ => Err(DecodeError("side 要是 c 或 h")),
    }
}

fn side_str(side: Side) -> Value {
    Value::Str(match side {
        Side::Client => "c".into(),
        Side::Host => "h".into(),
    })
}

fn int(n: u64) -> Value {
    // id 與 seq 都在 i64 放得下的範圍內：解碼時核過，宿主自己編的 seq 數不到那麼大。
    Value::Int(i64::try_from(n).unwrap_or(i64::MAX))
}

fn entry(key: &str, value: Value) -> (String, Value) {
    (key.to_string(), value)
}

/// 解一份 JSON 物件：`type` 不認得、欄位少了或多了、型別不對都回 [`DecodeError`]，不 panic。
pub fn decode_client_message(payload: &[u8]) -> Result<ClientMessage, DecodeError> {
    let (kind, all) = object(payload)?;
    match kind.as_str() {
        "hello" => {
            let [v, token] = fields(&all, ["version", "token"])?;
            Ok(ClientMessage::Hello {
                version: version(v)?,
                token: string(token)?,
            })
        }
        "call" => {
            let [s, i, service, method, payload] =
                fields(&all, ["side", "id", "service", "method", "payload"])?;
            Ok(ClientMessage::Call {
                side: side(s)?,
                id: id(i)?,
                service: string(service)?,
                method: string(method)?,
                payload: payload.clone(),
            })
        }
        "cancel" => {
            let [s, i] = fields(&all, ["side", "id"])?;
            Ok(ClientMessage::Cancel {
                side: side(s)?,
                id: id(i)?,
            })
        }
        _ => Err(DecodeError("不認得的種類")),
    }
}

/// 編成緊湊 JSON，鍵照 `type` 在前的固定順序；不會失敗。
pub fn encode_client_message(message: &ClientMessage) -> Vec<u8> {
    let fields = match message {
        ClientMessage::Hello { version, token } => vec![
            entry("type", Value::Str("hello".into())),
            entry("version", Value::Int(i64::from(*version))),
            entry("token", Value::Str(token.clone())),
        ],
        ClientMessage::Call {
            side,
            id,
            service,
            method,
            payload,
        } => vec![
            entry("type", Value::Str("call".into())),
            entry("side", side_str(*side)),
            entry("id", int(*id)),
            entry("service", Value::Str(service.clone())),
            entry("method", Value::Str(method.clone())),
            entry("payload", payload.clone()),
        ],
        ClientMessage::Cancel { side, id } => vec![
            entry("type", Value::Str("cancel".into())),
            entry("side", side_str(*side)),
            entry("id", int(*id)),
        ],
    };
    json::encode(&Value::Object(fields))
}

/// 同 [`decode_client_message`]，解宿主送給客戶端的。`result` 的 `ok` 與 `error` 剛好一個。
pub fn decode_host_message(payload: &[u8]) -> Result<HostMessage, DecodeError> {
    let (kind, all) = object(payload)?;
    match kind.as_str() {
        "hello" => {
            let [v] = fields(&all, ["version"])?;
            Ok(HostMessage::Hello {
                version: version(v)?,
            })
        }
        "rejected" => {
            let [reason] = fields(&all, ["reason"])?;
            Ok(HostMessage::Rejected {
                reason: string(reason)?,
            })
        }
        "chunk" => {
            let [s, i, n, payload] = fields(&all, ["side", "id", "seq", "payload"])?;
            Ok(HostMessage::Chunk {
                side: side(s)?,
                id: id(i)?,
                seq: seq(n)?,
                payload: payload.clone(),
            })
        }
        "result" => {
            let has_ok = all.iter().any(|(key, _)| key == "ok");
            let last = if has_ok { "ok" } else { "error" };
            let [s, i, value] = fields(&all, ["side", "id", last])?;
            let outcome = if has_ok {
                Ok(value.clone())
            } else {
                Err(call_error(value)?)
            };
            Ok(HostMessage::Result {
                side: side(s)?,
                id: id(i)?,
                outcome,
            })
        }
        "event" => {
            let [service, topic, payload] = fields(&all, ["service", "topic", "payload"])?;
            Ok(HostMessage::Event {
                service: string(service)?,
                topic: string(topic)?,
                payload: payload.clone(),
            })
        }
        _ => Err(DecodeError("不認得的種類")),
    }
}

fn call_error(value: &Value) -> Result<CallError, DecodeError> {
    let Value::Object(all) = value else {
        return Err(DecodeError("error 要是物件"));
    };
    if all.len() != 2 {
        return Err(DecodeError("欄位不對"));
    }
    let code = value
        .get("code")
        .and_then(Value::as_str)
        .and_then(ErrorCode::parse)
        .ok_or(DecodeError("不認得的錯誤碼"))?;
    let message = string(value.get("message").ok_or(DecodeError("欄位不對"))?)?;
    Ok(CallError { code, message })
}

/// 同 [`encode_client_message`]，編宿主送給客戶端的。
pub fn encode_host_message(message: &HostMessage) -> Vec<u8> {
    let fields = match message {
        HostMessage::Hello { version } => vec![
            entry("type", Value::Str("hello".into())),
            entry("version", Value::Int(i64::from(*version))),
        ],
        HostMessage::Rejected { reason } => vec![
            entry("type", Value::Str("rejected".into())),
            entry("reason", Value::Str(reason.clone())),
        ],
        HostMessage::Chunk {
            side,
            id,
            seq,
            payload,
        } => vec![
            entry("type", Value::Str("chunk".into())),
            entry("side", side_str(*side)),
            entry("id", int(*id)),
            entry("seq", int(*seq)),
            entry("payload", payload.clone()),
        ],
        HostMessage::Result { side, id, outcome } => {
            let mut out = vec![
                entry("type", Value::Str("result".into())),
                entry("side", side_str(*side)),
                entry("id", int(*id)),
            ];
            out.push(match outcome {
                Ok(value) => entry("ok", value.clone()),
                Err(err) => entry(
                    "error",
                    Value::Object(vec![
                        entry("code", Value::Str(err.code.as_str().into())),
                        entry("message", Value::Str(err.message.clone())),
                    ]),
                ),
            });
            out
        }
        HostMessage::Event {
            service,
            topic,
            payload,
        } => vec![
            entry("type", Value::Str("event".into())),
            entry("service", Value::Str(service.clone())),
            entry("topic", Value::Str(topic.clone())),
            entry("payload", payload.clone()),
        ],
    };
    json::encode(&Value::Object(fields))
}

/// 帶 [`HOST_PROTOCOL_VERSION`] 的 `hello`。
pub fn hello(token: &str) -> ClientMessage {
    ClientMessage::Hello {
        version: HOST_PROTOCOL_VERSION,
        token: token.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_sandbox_spawner::protocol::take_frame_within;

    const VECTORS: &str = include_str!("../../host-vectors.json");

    fn vectors() -> Value {
        json::parse(VECTORS.as_bytes()).unwrap()
    }

    fn group<'a>(all: &'a Value, name: &str) -> &'a [Value] {
        all.get(name)
            .and_then(Value::as_array)
            .unwrap_or_else(|| panic!("向量檔少了 {name}"))
    }

    fn text<'a>(entry: &'a Value, key: &str) -> &'a str {
        entry
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("{entry:?} 少了 {key}"))
    }

    fn unhex(hex: &str) -> Vec<u8> {
        (0..hex.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
            .collect()
    }

    fn client_value(message: &ClientMessage) -> Value {
        json::parse(&encode_client_message(message)).unwrap()
    }

    #[test]
    fn limits_and_version_match_the_vector_file() {
        let all = vectors();
        assert_eq!(
            all.get("protocolVersion").and_then(Value::as_int),
            Some(i64::from(HOST_PROTOCOL_VERSION))
        );
        assert_eq!(
            all.get("maxFrame").and_then(Value::as_int),
            Some(MAX_FRAME as i64)
        );
        assert_eq!(
            all.get("maxId").and_then(Value::as_int),
            Some(MAX_ID as i64)
        );
        assert_eq!(
            all.get("maxDepth").and_then(Value::as_int),
            Some(json::MAX_DEPTH as i64)
        );
        assert_eq!(
            all.get("bufferedFrames").and_then(Value::as_int),
            Some(nexus_sandbox_spawner::supervisor::process::INBOX_FRAMES as i64)
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
    fn invalid_host_messages_are_rejected_with_the_listed_reason() {
        let all = vectors();
        let entries = group(&all, "invalidHostMessages");
        assert!(entries.len() >= 5);
        for entry in entries {
            let got = decode_host_message(text(entry, "json").as_bytes()).map_err(|err| err.0);
            assert_eq!(got, Err(text(entry, "error")), "{}", text(entry, "name"));
        }
    }

    #[test]
    fn every_error_code_round_trips() {
        for code in ErrorCode::ALL {
            assert_eq!(ErrorCode::parse(code.as_str()), Some(code));
        }
        let all = vectors();
        let listed: Vec<&str> = group(&all, "errorCodes")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        let ours: Vec<&str> = ErrorCode::ALL.iter().map(|code| code.as_str()).collect();
        assert_eq!(listed, ours);
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
        inputs.extend(
            group(&all, "invalidMessages")
                .iter()
                .map(|entry| unhex(text(entry, "hex"))),
        );
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
                    assert_eq!(
                        decode_client_message(&encode_client_message(&message)),
                        Ok(message)
                    );
                }
                if let Ok(message) = decode_host_message(&case) {
                    assert_eq!(
                        decode_host_message(&encode_host_message(&message)),
                        Ok(message)
                    );
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
