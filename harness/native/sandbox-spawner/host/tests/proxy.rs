//! `nexus_host::proxy`：跑 TS 也在跑的 `proxy-vectors.json`（`packages/nexus-core/src/http-proxy/policy-vectors.test.ts`），
//! 再測 config 的解析與錯誤訊息不帶值。

use nexus_host::json::Value;
use nexus_host::proxy::{is_loopback_host, ProxyPolicy};
use reqwest::Url;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../proxy-vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("讀樣本檔")).expect("JSON")
}

#[test]
fn 共用樣本_proxy_for_url() {
    let all = vectors();
    let cases = all["proxyForUrl"].as_array().expect("陣列");
    assert!(!cases.is_empty());
    for case in cases {
        let name = case["name"].as_str().expect("name");
        let policy = ProxyPolicy::parse(&case["policy"]).expect(name);
        let url = Url::parse(case["url"].as_str().expect("url")).expect(name);
        let got = policy
            .proxy_for(&url)
            .map(|u| u.as_str().trim_end_matches('/').to_string());
        let want = case["proxy"].as_str().map(str::to_string);
        assert_eq!(got, want, "{name}");
    }
}

#[test]
fn 共用樣本_is_loopback_host() {
    for case in vectors()["isLoopbackHost"].as_array().expect("陣列") {
        let host = case["host"].as_str().expect("host");
        assert_eq!(
            is_loopback_host(host),
            case["loopback"].as_bool().expect("loopback"),
            "{host}"
        );
    }
}

#[test]
fn 設定不合法就回錯且不帶值() {
    for (json, want) in [
        (r#"[]"#, "proxy 要是物件"),
        (r#"{"httpsProxy":1}"#, "proxy.httpsProxy 要是字串"),
        (r#"{"noProxy":[]}"#, "proxy.noProxy 要是字串"),
        (r#"{"allProxy":"http://a"}"#, "proxy 不認得的欄位 allProxy"),
        (
            r#"{"httpsProxy":"FAKE-secret-not-a-url"}"#,
            "proxy.httpsProxy 不是合法的網址",
        ),
        (
            r#"{"httpProxy":"socks5://u:FAKE-secret@proxy.test:1080"}"#,
            "proxy.httpProxy 指到 SOCKS 代理，這裡不支援；請改設 http:// 或 https:// 的代理網址",
        ),
        (
            r#"{"httpsProxy":"ftp://u:FAKE-secret@proxy.test"}"#,
            "proxy.httpsProxy 用了不支援的協定；請改設 http:// 或 https:// 的代理網址",
        ),
    ] {
        let value: Value = serde_json::from_str(json).expect("JSON");
        assert_eq!(ProxyPolicy::parse(&value), Err(want.to_string()), "{json}");
    }
}

#[test]
fn 要遮的字串與_debug_不印網址() {
    let value: Value = serde_json::from_str(
        r#"{"httpsProxy":"http://nexus%40user:FAKE%2Fpass@proxy.test:3128","noProxy":"","source":"env"}"#,
    )
    .expect("JSON");
    let policy = ProxyPolicy::parse(&value).expect("政策");
    let secrets = policy.secrets();
    for want in ["nexus%40user", "nexus@user", "FAKE%2Fpass", "FAKE/pass"] {
        assert!(secrets.iter().any(|s| s == want), "{want}：{secrets:?}");
    }
    let shown = format!("{policy:?}");
    assert!(!shown.contains("FAKE"), "{shown}");
    assert!(ProxyPolicy::direct().is_direct());
    assert!(!policy.is_direct());
}
