//! `nexus_host::mcp::config`：一台 HTTP server 的設定解析，與錯誤訊息裡的秘密遮蔽。

use std::time::Duration;

use nexus_host::mcp::config::{scrub, Server};
use serde_json::json;

#[test]
fn 設定_預設與拒絕() {
    let s = Server::parse(&json!({
        "serverName": "ok_1-x",
        "connection": { "transport": "http", "url": "http://mcp.nexus.test/x" },
        "livenessTimeoutMs": 10,
    }))
    .expect("最少的設定");
    assert_eq!(s.tool_call_timeout, Duration::from_secs(60));
    assert_eq!(s.max_instruction_bytes, 32_768);
    assert!(!s.fail_on_startup_error);
    assert!(s.elicitation);
    assert_eq!(s.label(), "mcp-client(ok_1-x)");

    let base =
        json!({ "serverName": "a", "connection": { "transport": "http", "url": "https://h/" } });
    let reject = |patch: serde_json::Value, expect: &str| {
        let mut config = base.clone();
        for (k, v) in patch.as_object().expect("物件") {
            config[k] = v.clone();
        }
        let err = Server::parse(&config).expect_err("要拒絕");
        assert!(err.contains(expect), "{err} 不含 {expect}");
    };
    reject(json!({ "serverName": "bad name" }), "serverName");
    reject(json!({ "serverName": "x".repeat(33) }), "serverName");
    reject(json!({ "approval": {} }), "不認得的欄位 approval");
    reject(
        json!({ "connection": { "transport": "stdio", "command": "x" } }),
        "stdio",
    );
    reject(
        json!({ "connection": { "transport": "http", "url": "ftp://h/" } }),
        "connection.url",
    );
    reject(
        json!({ "connection": { "transport": "http", "url": "https://h/", "headers": { "A": { "credential": "c" } } } }),
        "是憑證引用：宿主還不支援",
    );
    reject(
        json!({ "connection": { "transport": "http", "url": "https://h/", "headers": { "A": "line\nbreak-secret" } } }),
        "connection.headers.A",
    );
    reject(json!({ "toolCallTimeoutMs": 0 }), "toolCallTimeoutMs");
    reject(json!({ "elicitation": "yes" }), "elicitation");
    reject(json!({ "reconnect": { "maxAttempts": 0 } }), "maxAttempts");
    reject(json!({ "livenessTimeoutMs": -1 }), "livenessTimeoutMs");

    let err = Server::parse(&json!({
        "serverName": "a",
        "connection": { "transport": "http", "url": "https://h/", "headers": { "A": "line\nbreak-secret" } },
    }))
    .expect_err("要拒絕");
    assert!(!err.contains("break-secret"), "錯誤不帶 header 值：{err}");
}

#[test]
fn 遮蔽先換長的() {
    let secrets = vec!["ab".to_string(), "abcd".to_string(), String::new()];
    assert_eq!(scrub("x abcd y ab", &secrets), "x [redacted] y [redacted]");
}

#[test]
fn debug_不印秘密() {
    let s = Server::parse(&json!({
        "serverName": "a",
        "connection": {
            "transport": "http",
            "url": "https://u-55:p-66@h/x?k=q-77",
            "headers": { "Authorization": "Bearer hdr-88" },
        },
    }))
    .expect("設定");
    let shown = format!("{s:?}");
    for secret in ["u-55", "p-66", "q-77", "hdr-88"] {
        assert!(!shown.contains(secret), "{shown}");
    }
    assert!(shown.contains("authorization"), "{shown}");
}
