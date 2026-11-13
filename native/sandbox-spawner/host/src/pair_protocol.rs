//! 一對裡的組合行程與葉子行程之間那條橋的協定（#2583）。框格式同 [`nexus_sandbox_spawner::protocol`]（u32 LE 長度＋內容），內容是一份
//! JSON 物件（[`crate::json`]），`type` 欄位分種類。兩種語言從同一份向量檔 `pair-vectors.json` 驗；TS 那一側是
//! `packages/nexus-host-bridge/src/pair-protocol.ts`。組合行程那一端的連線邏輯在 [`crate::pair`]。
//!
//! # 連線與 `hello`
//!
//! 組合行程 listen，葉子連進來，一對之間同時一條連線。葉子斷了不重連；組合行程要等監督行程再給一次 `leaf{pid}` 才再收。葉子的第一框是 `hello`，帶 [`PAIR_PROTOCOL_VERSION`]。不帶 token：身分是
//! `SO_PEERCRED` 的 pid（uid 要跟組合行程相同）等於監督行程用 `leaf{pid}` 告訴組合行程的那一個。pid 與版本都對，組合行程回 `hello`；
//! 否則回 `rejected{reason}` 再關。從組合行程收下連線那一步起 [`HELLO_TIMEOUT`] 內沒送 `hello`、或送了但葉子的 pid 還沒到，也回 `rejected` 再關。
//!
//! 葉子那一端要把兩種結果分開回報：連不上、送出 `hello` 後 [`HELLO_TIMEOUT`] 內沒收到 `hello`、或沒收到任何框就斷，是「對方不在」；
//! 收到 `rejected` 是「被拒」。
//!
//! # 之後的框
//!
//! - `register{tools, hooks}`：只有葉子送，名稱的陣列，每次整份取代。
//! - `call{side, id, parent, method, payload}`：兩邊都能發。`side` 是發起的一方（[`Side`]），`id` 兩邊各自一個空間，所以一次呼叫的識別是
//!   `(side, id)`（[`CallRef`]）。`parent` 是外層那一次呼叫，沒有就是 `null`；它要還在跑。waterfall 的前後段帶同一個 `parent`。沒有預設時限。
//! - `chunk{side, id, seq, payload}`：串流的一塊，`payload` 是字串，UTF-8 最長 [`MAX_CHUNK_BYTES`]；`seq` 每次呼叫從 0 起、一次加一。
//! - `result{side, id, ok | error}`：一次呼叫的終點，每個 `(side, id)` 剛好一框，取消的也有。錯誤碼是宿主那條的那一組
//!   （[`crate::host_protocol::ErrorCode`]）；橋沒有服務這一層，不發 `unknown_service`。
//! - `cancel{side, id}`：發起的一方不要這一次了。指到已經結束的不回任何東西（兩邊各自送出時會交錯）。
//!
//! `side` 是自己的 `call` 與 `cancel` 只由自己送，`chunk` 與 `result` 只由對方送。
//!
//! 組合行程叫葉子綁 thread 用 [`METHOD_ATTACH`]，`payload` 是 `{"threadId": …}`，葉子綁好才回 `result`。
//!
//! # 上限與違反協定
//!
//! 一框最長 [`MAX_FRAME`]，JSON 巢狀最多 [`crate::json::MAX_DEPTH`] 層，`id` 與 `seq` 最大 [`MAX_ID`]，每個方向同時最多 [`MAX_CALLS`] 個呼叫
//! （再來的回 `busy`）。一塊最長 [`MAX_CHUNK_BYTES`]：字串編成 JSON 最壞是六倍（控制字元寫成 `\u00XX`），加上 [`ENVELOPE_BYTES`] 仍然放得進一框。
//!
//! 框超過上限、解不開、種類不認得、欄位少了或多了、方向不對、`id` 還在跑又發一次、`chunk` 或 `result` 指到不在跑的呼叫、`seq` 沒接上、
//! `hello` 之前送別的、葉子送了 `hello` 還沒收到組合行程的 `hello` 就送別的、又送一次 `hello`、葉子送 `rejected`、
//! 收到的一塊超過 [`MAX_CHUNK_BYTES`]，都算違反協定：組合行程回 `rejected` 再關；葉子直接關（`rejected` 只有一個方向）。
//!
//! 只壞一次呼叫、連線不動的：自己要送的一塊超過 [`MAX_CHUNK_BYTES`]，不送，那一次以 `too_large` 收尾；結果編出來超過一框，換成 `too_large`；
//! 自己要送的 `call` 超過一框，不送，在本地回 `too_large`；不認得的 method 回 `unknown_method`；`parent` 不在跑回 `bad_payload`。
//!
//! # 背壓
//!
//! 送端排著沒寫出去的位元組到了 [`OUTBOX_PAUSE`]：先不讀對方、不處理已經讀進來的框，自己要發的新 `call` 與 `chunk` 在本地回「現在送不了」；
//! 降回 [`OUTBOX_PAUSE`] 以下再恢復。再排一框就超過 [`OUTBOX_LIMIT`]：關連線。收端沒切成框的最多
//! [`nexus_sandbox_spawner::supervisor::process::INBOX_FRAMES`] 個框長。兩個送端的常數是位元組數，不隨 [`MAX_FRAME`] 變。
//!
//! # 連線斷了
//!
//! 自己發出去還沒回的呼叫在本地收成「對方不在」，跟對方回的錯是不同的型別；對方發來還在跑的全部取消。

use std::time::Duration;

use crate::host_protocol::{CallError, ErrorCode};
use crate::json::{self, Map, Value};
use nexus_sandbox_spawner::protocol::DecodeError;

/// 橋的協定版本。跟監督行程控制通道、宿主連線的版本各自獨立。
pub const PAIR_PROTOCOL_VERSION: u32 = 1;

/// 橋上一框最長多少。
pub const MAX_FRAME: usize = 1 << 20;

/// `id` 與 `seq` 最大多少：JavaScript 的 number 精確表示得了的最大整數。
pub const MAX_ID: u64 = (1 << 53) - 1;

/// `chunk` 框裡 `payload` 以外的部分最多佔多少；`id`、`seq` 都取 [`MAX_ID`] 時不到 100 位元組。
pub const ENVELOPE_BYTES: usize = 256;

/// 一塊的字串以 UTF-8 計最長多少。
pub const MAX_CHUNK_BYTES: usize = 128 * 1024;

/// 每個方向同時最多幾個呼叫。
pub const MAX_CALLS: usize = 64;

/// 從組合行程收下連線那一步起，這麼久內要送 `hello`、葉子的 pid 也要到，否則回 `rejected`；葉子送出 `hello` 後等組合行程回 `hello` 也是這麼久。
pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);

/// 排著沒寫出去的位元組到了這麼多，先不讀對方、不發新的 `call` 與 `chunk`。
pub const OUTBOX_PAUSE: usize = 512 * 1024;

/// 排著沒寫出去的位元組不超過這麼多；再排一框就超過的，關連線。
pub const OUTBOX_LIMIT: usize = 2 * 1024 * 1024;

/// 組合行程同時留著幾條還沒驗過身分的連線；再來的回 `rejected` 再關。
pub const MAX_PENDING: usize = 4;

/// 組合行程叫葉子綁 thread 的 method。
pub const METHOD_ATTACH: &str = "attach";

const _: () = assert!(MAX_CHUNK_BYTES * 6 + ENVELOPE_BYTES <= MAX_FRAME);
// 沒到暫停線時，任何一框都排得進去。
const _: () = assert!(OUTBOX_PAUSE + MAX_FRAME + 4 <= OUTBOX_LIMIT);

/// 一次呼叫是哪一邊發的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Side {
    Leaf,
    Composition,
}

impl Side {
    pub fn other(self) -> Side {
        match self {
            Side::Leaf => Side::Composition,
            Side::Composition => Side::Leaf,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Side::Leaf => "l",
            Side::Composition => "m",
        }
    }
}

/// 一次呼叫的識別。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct CallRef {
    pub side: Side,
    pub id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairMessage {
    Hello {
        version: u32,
    },
    /// 不收這條連線，送完就關。只有組合行程送。
    Rejected {
        reason: String,
    },
    /// 只有葉子送。
    Register {
        tools: Vec<String>,
        hooks: Vec<String>,
    },
    Call {
        call: CallRef,
        parent: Option<CallRef>,
        method: String,
        payload: Value,
    },
    Chunk {
        call: CallRef,
        seq: u64,
        payload: String,
    },
    Result {
        call: CallRef,
        outcome: Result<Value, CallError>,
    },
    Cancel {
        call: CallRef,
    },
}

/// 照 `keys` 的順序取欄位：每一個都要有，連同 `extra` 個別的鍵之外不能再多。
fn fields<'a, const N: usize>(
    all: &'a Map<String, Value>,
    keys: [&str; N],
    extra: usize,
) -> Result<[&'a Value; N], DecodeError> {
    if all.len() != N + extra {
        return Err(DecodeError("欄位不對"));
    }
    let mut out = [&Value::Null; N];
    for (slot, key) in out.iter_mut().zip(keys) {
        *slot = all.get(key).ok_or(DecodeError("欄位不對"))?;
    }
    Ok(out)
}

fn string(value: &Value) -> Result<String, DecodeError> {
    value
        .as_str()
        .map(str::to_string)
        .ok_or(DecodeError("要是字串"))
}

fn strings(value: &Value) -> Result<Vec<String>, DecodeError> {
    const BAD: DecodeError = DecodeError("要是字串的陣列");
    value
        .as_array()
        .ok_or(BAD)?
        .iter()
        .map(|item| item.as_str().map(str::to_string).ok_or(BAD))
        .collect()
}

fn id(value: &Value) -> Result<u64, DecodeError> {
    value
        .as_u64()
        .filter(|&n| n <= MAX_ID)
        .ok_or(DecodeError("id 不在範圍內"))
}

fn side(value: &Value) -> Result<Side, DecodeError> {
    match value.as_str() {
        Some("l") => Ok(Side::Leaf),
        Some("m") => Ok(Side::Composition),
        _ => Err(DecodeError("side 要是 l 或 m")),
    }
}

fn call_ref(side_value: &Value, id_value: &Value) -> Result<CallRef, DecodeError> {
    Ok(CallRef {
        side: side(side_value)?,
        id: id(id_value)?,
    })
}

fn parent(value: &Value) -> Result<Option<CallRef>, DecodeError> {
    match value {
        Value::Null => Ok(None),
        Value::Object(all) => {
            let [i, s] = fields(all, ["id", "side"], 0)?;
            call_ref(s, i).map(Some)
        }
        _ => Err(DecodeError("parent 要是 null 或物件")),
    }
}

fn call_error(value: &Value) -> Result<CallError, DecodeError> {
    let Value::Object(all) = value else {
        return Err(DecodeError("error 要是物件"));
    };
    let [code, message] = fields(all, ["code", "message"], 0)?;
    let code = code
        .as_str()
        .and_then(|text| {
            ErrorCode::ALL
                .into_iter()
                .find(|code| code.as_str() == text)
        })
        .ok_or(DecodeError("不認得的錯誤碼"))?;
    Ok(CallError {
        code,
        message: string(message)?,
    })
}

/// 解一框的內容：`type` 不認得、欄位少了或多了、型別不對都回 [`DecodeError`]，不 panic。誰能送哪一種由 [`crate::pair`] 判。
pub fn decode(payload: &[u8]) -> Result<PairMessage, DecodeError> {
    let Value::Object(all) = json::parse(payload).map_err(|err| DecodeError(err.0))? else {
        return Err(DecodeError("不是物件"));
    };
    let kind = all
        .get("type")
        .and_then(Value::as_str)
        .ok_or(DecodeError("少了 type"))?;
    match kind {
        "hello" => {
            let [version] = fields(&all, ["version"], 1)?;
            let version = version
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or(DecodeError("版本不是 u32"))?;
            Ok(PairMessage::Hello { version })
        }
        "rejected" => {
            let [reason] = fields(&all, ["reason"], 1)?;
            Ok(PairMessage::Rejected {
                reason: string(reason)?,
            })
        }
        "register" => {
            let [tools, hooks] = fields(&all, ["tools", "hooks"], 1)?;
            Ok(PairMessage::Register {
                tools: strings(tools)?,
                hooks: strings(hooks)?,
            })
        }
        "call" => {
            let [s, i, p, method, payload] =
                fields(&all, ["side", "id", "parent", "method", "payload"], 1)?;
            Ok(PairMessage::Call {
                call: call_ref(s, i)?,
                parent: parent(p)?,
                method: string(method)?,
                payload: payload.clone(),
            })
        }
        "chunk" => {
            let [s, i, n, payload] = fields(&all, ["side", "id", "seq", "payload"], 1)?;
            let call = call_ref(s, i)?;
            let seq = n
                .as_u64()
                .filter(|&n| n <= MAX_ID)
                .ok_or(DecodeError("seq 不在範圍內"))?;
            let payload = payload.as_str().ok_or(DecodeError("塊要是字串"))?;
            if payload.len() > MAX_CHUNK_BYTES {
                return Err(DecodeError("塊太大"));
            }
            Ok(PairMessage::Chunk {
                call,
                seq,
                payload: payload.to_string(),
            })
        }
        "result" => {
            let last = if all.contains_key("ok") {
                "ok"
            } else {
                "error"
            };
            let [s, i, value] = fields(&all, ["side", "id", last], 1)?;
            let call = call_ref(s, i)?;
            let outcome = if last == "ok" {
                Ok(value.clone())
            } else {
                Err(call_error(value)?)
            };
            Ok(PairMessage::Result { call, outcome })
        }
        "cancel" => {
            let [s, i] = fields(&all, ["side", "id"], 1)?;
            Ok(PairMessage::Cancel {
                call: call_ref(s, i)?,
            })
        }
        _ => Err(DecodeError("不認得的種類")),
    }
}

fn call_fields(kind: &'static str, call: CallRef) -> Vec<(&'static str, Value)> {
    vec![
        ("type", Value::from(kind)),
        ("side", Value::from(call.side.as_str())),
        ("id", Value::from(call.id)),
    ]
}

/// 編成緊湊 JSON：框的外層鍵照 `type` 在前的固定順序，裡面的物件照 [`json::encode`]（鍵照碼位排序）；不會失敗，也不看長度。
pub fn encode(message: &PairMessage) -> Vec<u8> {
    let fields = match message {
        PairMessage::Hello { version } => vec![
            ("type", Value::from("hello")),
            ("version", Value::from(*version)),
        ],
        PairMessage::Rejected { reason } => vec![
            ("type", Value::from("rejected")),
            ("reason", Value::from(reason.as_str())),
        ],
        PairMessage::Register { tools, hooks } => vec![
            ("type", Value::from("register")),
            ("tools", Value::from(tools.clone())),
            ("hooks", Value::from(hooks.clone())),
        ],
        PairMessage::Call {
            call,
            parent,
            method,
            payload,
        } => {
            let mut out = call_fields("call", *call);
            out.push((
                "parent",
                parent.map_or(
                    Value::Null,
                    |parent| serde_json::json!({"id": parent.id, "side": parent.side.as_str()}),
                ),
            ));
            out.push(("method", Value::from(method.as_str())));
            out.push(("payload", payload.clone()));
            out
        }
        PairMessage::Chunk { call, seq, payload } => {
            let mut out = call_fields("chunk", *call);
            out.push(("seq", Value::from(*seq)));
            out.push(("payload", Value::from(payload.as_str())));
            out
        }
        PairMessage::Result { call, outcome } => {
            let mut out = call_fields("result", *call);
            out.push(match outcome {
                Ok(value) => ("ok", value.clone()),
                Err(err) => (
                    "error",
                    serde_json::json!({"code": err.code.as_str(), "message": err.message}),
                ),
            });
            out
        }
        PairMessage::Cancel { call } => call_fields("cancel", *call),
    };
    let refs: Vec<(&str, &Value)> = fields.iter().map(|(key, value)| (*key, value)).collect();
    json::encode_fields(&refs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_sandbox_spawner::protocol::take_frame_within;
    use nexus_sandbox_spawner::supervisor::process::INBOX_FRAMES;

    const VECTORS: &str = include_str!("../../pair-vectors.json");
    const HOST_VECTORS: &str = include_str!("../../host-vectors.json");

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

    fn chunk(payload: String) -> PairMessage {
        PairMessage::Chunk {
            call: CallRef {
                side: Side::Leaf,
                id: MAX_ID,
            },
            seq: MAX_ID,
            payload,
        }
    }

    #[test]
    fn limits_and_version_match_the_vector_file() {
        let all = vectors();
        let number = |key: &str| all.get(key).and_then(Value::as_u64);
        assert_eq!(
            number("protocolVersion"),
            Some(u64::from(PAIR_PROTOCOL_VERSION))
        );
        assert_eq!(number("maxFrame"), Some(MAX_FRAME as u64));
        assert_eq!(number("maxId"), Some(MAX_ID));
        assert_eq!(number("maxDepth"), Some(json::MAX_DEPTH as u64));
        assert_eq!(number("bufferedFrames"), Some(INBOX_FRAMES as u64));
        assert_eq!(number("envelopeBytes"), Some(ENVELOPE_BYTES as u64));
        assert_eq!(number("maxChunkBytes"), Some(MAX_CHUNK_BYTES as u64));
        assert_eq!(number("maxCalls"), Some(MAX_CALLS as u64));
        assert_eq!(
            number("helloTimeoutMs"),
            Some(HELLO_TIMEOUT.as_millis() as u64)
        );
        assert_eq!(number("outboxPauseBytes"), Some(OUTBOX_PAUSE as u64));
        assert_eq!(number("outboxLimitBytes"), Some(OUTBOX_LIMIT as u64));
        assert_eq!(number("pendingConnections"), Some(MAX_PENDING as u64));
        assert_eq!(
            all.get("attachMethod").and_then(Value::as_str),
            Some(METHOD_ATTACH)
        );
    }

    #[test]
    fn error_codes_are_the_host_connection_ones() {
        let host = json::parse(HOST_VECTORS.as_bytes()).unwrap();
        let listed = group(&host, "errorCodes");
        assert_eq!(listed.len(), ErrorCode::ALL.len());
        for (entry, code) in listed.iter().zip(ErrorCode::ALL) {
            let call = CallRef {
                side: Side::Leaf,
                id: 1,
            };
            let message = PairMessage::Result {
                call,
                outcome: Err(CallError {
                    code,
                    message: String::new(),
                }),
            };
            let bytes = encode(&message);
            assert_eq!(
                json::parse(&bytes).unwrap().pointer("/error/code"),
                Some(entry)
            );
            assert_eq!(decode(&bytes), Ok(message));
        }
    }

    #[test]
    fn valid_vectors_decode_and_encode_byte_for_byte() {
        let all = vectors();
        let entries = group(&all, "messages");
        for entry in entries {
            let bytes = text(entry, "json").as_bytes();
            let message = decode(bytes).unwrap();
            assert_eq!(encode(&message), bytes, "{}", text(entry, "json"));
            assert_eq!(&json::parse(bytes).unwrap(), entry.get("value").unwrap());
        }
        // 四種帶 `side` 的框，兩個方向都要有。
        for kind in ["call", "chunk", "result", "cancel"] {
            for side in ["l", "m"] {
                let covered = entries.iter().any(|entry| {
                    entry.pointer("/value/type").and_then(Value::as_str) == Some(kind)
                        && entry.pointer("/value/side").and_then(Value::as_str) == Some(side)
                });
                assert!(covered, "向量檔少了 side {side} 的 {kind}");
            }
        }
    }

    #[test]
    fn duplicate_keys_decode_to_the_last_one() {
        let all = vectors();
        let entries = group(&all, "duplicateKeys");
        assert!(!entries.is_empty());
        for entry in entries {
            let message = decode(text(entry, "json").as_bytes()).unwrap();
            assert_eq!(
                &json::parse(&encode(&message)).unwrap(),
                entry.get("value").unwrap()
            );
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
        assert!(entries.len() >= 30);
        for entry in entries {
            let got = decode(text(entry, "json").as_bytes()).map_err(|err| err.0);
            assert_eq!(got, Err(text(entry, "error")), "{}", text(entry, "name"));
        }
        let entries = group(&all, "invalidBytes");
        assert!(entries.len() >= 8);
        for entry in entries {
            let got = decode(&unhex(text(entry, "hex"))).map_err(|err| err.0);
            assert_eq!(got, Err(text(entry, "error")), "{}", text(entry, "name"));
        }
    }

    #[test]
    fn an_integer_written_as_a_decimal_is_not_an_id() {
        let got = decode(br#"{"type":"cancel","side":"l","id":1.0}"#);
        assert_eq!(got, Err(DecodeError("id 不在範圍內")));
    }

    #[test]
    fn the_largest_chunk_fits_a_frame_however_it_escapes() {
        for unit in ["\u{1}", "\"", "x", "é", "😀"] {
            let payload = unit.repeat(MAX_CHUNK_BYTES / unit.len());
            let bytes = encode(&chunk(payload.clone()));
            assert!(bytes.len() <= MAX_FRAME, "{unit:?} 編出來 {}", bytes.len());
            assert_eq!(decode(&bytes), Ok(chunk(payload)));
        }
        let envelope = encode(&chunk(String::new())).len();
        assert!(envelope <= ENVELOPE_BYTES, "信封 {envelope}");
        let worst = encode(&chunk("\u{1}".repeat(MAX_CHUNK_BYTES))).len();
        assert_eq!(worst, envelope + 6 * MAX_CHUNK_BYTES);
    }

    #[test]
    fn a_chunk_one_byte_over_the_limit_does_not_decode() {
        let at_limit = encode(&chunk("x".repeat(MAX_CHUNK_BYTES)));
        assert!(decode(&at_limit).is_ok());
        let over = encode(&chunk("x".repeat(MAX_CHUNK_BYTES + 1)));
        assert_eq!(decode(&over), Err(DecodeError("塊太大")));
    }

    #[test]
    fn every_truncation_and_bit_flip_decodes_without_panicking() {
        let all = vectors();
        let mut tried = 0;
        let mut inputs: Vec<Vec<u8>> = group(&all, "messages")
            .iter()
            .chain(group(&all, "invalidMessages"))
            .map(|entry| text(entry, "json").as_bytes().to_vec())
            .collect();
        inputs.extend(
            group(&all, "invalidBytes")
                .iter()
                .map(|entry| unhex(text(entry, "hex")))
                .filter(|bytes| bytes.len() < 256),
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
                if let Ok(message) = decode(&case) {
                    assert_eq!(decode(&encode(&message)), Ok(message));
                }
                let mut framed = (case.len() as u32).to_le_bytes().to_vec();
                framed.extend_from_slice(&case);
                let _ = take_frame_within(&mut framed, MAX_FRAME);
            }
        }
        assert!(tried > 1000, "只試了 {tried} 次");
    }
}
