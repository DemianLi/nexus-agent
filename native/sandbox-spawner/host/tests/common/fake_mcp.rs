//! 手寫的 Streamable HTTP MCP server，掛在 [`super::TlsServer`] 上：每個 POST 回一則 `application/json`，不開 SSE。
//! 新協定答 `server/discover`；舊協定對 `server/discover` 回「方法不存在」，客戶端退回 `initialize`。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::{Handler, Request, Response};

/// 這台假 server 怎麼回。
#[derive(Clone, Default)]
pub struct FakeMcp {
    /// 講新協定（`server/discover`）。
    pub modern: bool,
    /// `tools/list` 的分頁：cursor（第一頁是空字串）→（工具名, 下一頁的 cursor）。
    pub pages: HashMap<String, (Vec<String>, Option<String>)>,
    pub instructions: Option<String>,
    /// `tools/list` 一律回 JSON-RPC 錯誤。
    pub list_fails: bool,
}

impl FakeMcp {
    /// 一頁、這些工具。
    pub fn with_tools(modern: bool, tools: &[&str]) -> FakeMcp {
        let mut pages = HashMap::new();
        pages.insert(
            String::new(),
            (tools.iter().map(|t| t.to_string()).collect(), None),
        );
        FakeMcp {
            modern,
            pages,
            ..FakeMcp::default()
        }
    }
}

fn tool(name: &str) -> Value {
    json!({ "name": name, "description": format!("tool {name}"), "inputSchema": { "type": "object" } })
}

fn reply(id: &Value, body: Value) -> Response {
    let mut message = json!({ "jsonrpc": "2.0", "id": id });
    let key = if body.get("code").is_some() {
        "error"
    } else {
        "result"
    };
    message[key] = body;
    Response::new(200, "application/json", message.to_string())
}

/// 記下每個請求、照 `fake` 回。
pub fn handler(fake: FakeMcp, log: Arc<Mutex<Vec<Request>>>) -> Handler {
    Arc::new(move |request: &Request| {
        log.lock().expect("鎖").push(request.clone());
        match request.method.as_str() {
            "POST" => {}
            "DELETE" => return Response::empty(200),
            _ => return Response::empty(405),
        }
        let Ok(message) = serde_json::from_slice::<Value>(&request.body) else {
            return Response::empty(400);
        };
        let Some(id) = message.get("id") else {
            return Response::empty(202);
        };
        let method = message["method"].as_str().unwrap_or("");
        let params = &message["params"];
        let complete = |mut result: Value| {
            if fake.modern {
                result["resultType"] = json!("complete");
            }
            result
        };
        match method {
            "server/discover" if fake.modern => {
                let mut result = json!({
                    "resultType": "complete",
                    "supportedVersions": ["2026-07-28"],
                    "capabilities": { "tools": {} },
                    "ttlMs": 0,
                    "cacheScope": "private",
                    "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "fake", "version": "0" } },
                });
                if let Some(text) = &fake.instructions {
                    result["instructions"] = json!(text);
                }
                reply(id, result)
            }
            "initialize" if !fake.modern => {
                let mut result = json!({
                    "protocolVersion": "2025-11-25",
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "fake", "version": "0" },
                });
                if let Some(text) = &fake.instructions {
                    result["instructions"] = json!(text);
                }
                let mut response = reply(id, result);
                response
                    .headers
                    .push(("Mcp-Session-Id".into(), "fake-session".into()));
                response
            }
            "tools/list" if fake.list_fails => {
                reply(id, json!({ "code": -32603, "message": "list exploded" }))
            }
            "tools/list" => {
                let cursor = params["cursor"].as_str().unwrap_or("");
                let Some((names, next)) = fake.pages.get(cursor) else {
                    return reply(id, json!({ "code": -32602, "message": "bad cursor" }));
                };
                let mut result =
                    json!({ "tools": names.iter().map(|n| tool(n)).collect::<Vec<_>>() });
                if let Some(next) = next {
                    result["nextCursor"] = json!(next);
                }
                reply(id, complete(result))
            }
            "tools/call" => {
                let text = format!("{}:{}", params["name"], params["arguments"]);
                reply(
                    id,
                    complete(
                        json!({ "content": [{ "type": "text", "text": text }], "isError": false }),
                    ),
                )
            }
            _ => reply(id, json!({ "code": -32601, "message": "Method not found" })),
        }
    })
}
