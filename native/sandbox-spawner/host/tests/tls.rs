//! `nexus_host::tls`：ring 的 TLS 設定只信設定指定的根，實際連一台本機 HTTPS 伺服器驗；代理照政策走，經 CONNECT 隧道照樣驗伺服器；
//! 再掃宿主的原始碼，擋掉繞過它建 HTTP 客戶端的寫法。
//!
//! **這裡證明不了的退化**：設定的根之外，另外又信了系統的信任庫。測試的 CA b 在哪裡都不受信任，系統信任庫加不加都一樣驗不過；
//! 要測出來得有一張公開受信任的憑證，完全內網做不到。這種退化只靠下面的原始碼掃描擋。

mod common;

use common::{fixture, ConnectProxy, ProxyMode, Response, TlsServer};
use nexus_host::json::Value;
use nexus_host::proxy::ProxyPolicy;
use nexus_host::tls::{client_config, http_client};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// 測試用的自簽根憑證（P-256），只拿來驗 PEM 讀得進來。
const ROOT: &str = "-----BEGIN CERTIFICATE-----
MIIBjDCCATGgAwIBAgIUYj3h6vGWPatY4i8P8SBj9X5gcd4wCgYIKoZIzj0EAwIw
GjEYMBYGA1UEAwwPbmV4dXMtdGVzdC1yb290MCAXDTI2MTExMDA4MTQyNloYDzIx
MjYxMDE3MDgxNDI2WjAaMRgwFgYDVQQDDA9uZXh1cy10ZXN0LXJvb3QwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAATBAiJuKTQfRUtCTyNeK5aGsi7qsvyL8yKfT2c0
s1XsDth9ongZ39AINemUv+RTcjAZscvqc9CAr6nWK0G4UYYno1MwUTAdBgNVHQ4E
FgQUhothN2pyxz18KKRSXts9+dbr4iEwHwYDVR0jBBgwFoAUhothN2pyxz18KKRS
Xts9+dbr4iEwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEAqnAW
eT6SJSwAai26kw9Rtsq8PV4+Butr7CVAyjbs4sECIQDGhLiX7mcfm5Zt4qLiK7Pu
fNJm79ErWimk6fvAU7uzDw==
-----END CERTIFICATE-----
";

fn temp_file(tag: &str, text: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("nexus-tls-{tag}-{}.pem", std::process::id()));
    std::fs::write(&path, text).expect("寫檔");
    path
}

#[test]
fn 用設定的根建得起來() {
    let path = temp_file("ok", &format!("# 前後的雜訊不算\n{ROOT}\n{ROOT}"));
    let config = client_config(&path).expect("建得起來");
    assert!(http_client(config, &ProxyPolicy::direct()).is_ok());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn 沒有憑證或認不得就回錯() {
    for (tag, text) in [
        ("empty", ""),
        ("no-cert", "not a pem\n"),
        (
            "broken",
            "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n",
        ),
    ] {
        let path = temp_file(tag, text);
        assert!(client_config(&path).is_err(), "{tag}");
        let _ = std::fs::remove_file(&path);
    }
    assert!(client_config(Path::new("/nonexistent/nexus-roots.pem")).is_err());
}

fn ok_server() -> TlsServer {
    TlsServer::start(Arc::new(|_| Response::new(200, "text/plain", "ok")))
}

fn policy(json: &str) -> ProxyPolicy {
    let value: Value = serde_json::from_str(json).expect("JSON");
    ProxyPolicy::parse(&value).expect("政策")
}

/// 用 `roots` 與 `proxy` 建客戶端，GET 一次；回主體或錯誤的完整說明（含 source 鏈）。
fn get(roots: &str, proxy: &ProxyPolicy, url: &str) -> Result<String, String> {
    let client = http_client(client_config(&fixture(roots)).expect("根"), proxy).expect("客戶端");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let response = client.get(url).send().await.map_err(|e| chain(&e))?;
        response.text().await.map_err(|e| chain(&e))
    })
}

fn chain(err: &dyn std::error::Error) -> String {
    let mut text = err.to_string();
    let mut source = err.source();
    while let Some(next) = source {
        text.push_str(&format!("：{next}"));
        source = next.source();
    }
    text
}

#[test]
fn 只信設定的根() {
    let server = ok_server();
    let url = format!("https://localhost:{}/", server.port);
    assert_eq!(
        get("ca-a.pem", &ProxyPolicy::direct(), &url),
        Ok("ok".into())
    );
    let err = get("ca-b.pem", &ProxyPolicy::direct(), &url).expect_err("CA b 不該驗過");
    assert!(err.contains("UnknownIssuer"), "{err}");
}

#[test]
fn 經_connect_隧道照樣只信設定的根() {
    let server = ok_server();
    let proxy = ConnectProxy::start(ProxyMode::Tunnel(server.port));
    let policy = policy(&format!(
        r#"{{"httpsProxy":"http://nexus-user:FAKE-proxy-pass@127.0.0.1:{}","noProxy":"localhost,127.0.0.1"}}"#,
        proxy.port
    ));
    // 目標不能是迴圈位址：迴圈位址一律直連。`mcp.nexus.test` 只有代理知道要接到哪裡；`--network=none` 裡也通，表示客戶端沒有自己解析它。
    let url = format!("https://mcp.nexus.test:{}/", server.port);
    assert_eq!(get("ca-a.pem", &policy, &url), Ok("ok".into()));
    let seen = proxy.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].method, "CONNECT");
    assert_eq!(seen[0].path, format!("mcp.nexus.test:{}", server.port));
    // `nexus-user:FAKE-proxy-pass` 的 base64。
    assert_eq!(
        seen[0].header("proxy-authorization"),
        Some("Basic bmV4dXMtdXNlcjpGQUtFLXByb3h5LXBhc3M=")
    );

    let err = get("ca-b.pem", &policy, &url).expect_err("CA b 不該驗過");
    assert!(err.contains("UnknownIssuer"), "{err}");
    assert_eq!(proxy.seen().len(), 2);
}

#[test]
fn 放行清單與迴圈位址不走代理() {
    let server = ok_server();
    let proxy = ConnectProxy::start(ProxyMode::Reject);
    let policy = policy(&format!(
        r#"{{"httpsProxy":"http://127.0.0.1:{}","noProxy":""}}"#,
        proxy.port
    ));
    for host in ["localhost", "127.0.0.1"] {
        let url = format!("https://{host}:{}/", server.port);
        assert_eq!(get("ca-a.pem", &policy, &url), Ok("ok".into()), "{host}");
    }
    assert!(proxy.seen().is_empty());
}

#[test]
fn 代理拒絕時錯誤不帶帳密() {
    let proxy = ConnectProxy::start(ProxyMode::Reject);
    let policy = policy(&format!(
        r#"{{"httpsProxy":"http://nexus-user:FAKE-proxy-pass@127.0.0.1:{}","noProxy":""}}"#,
        proxy.port
    ));
    let err = get("ca-a.pem", &policy, "https://mcp.nexus.test/").expect_err("該失敗");
    assert_eq!(proxy.seen().len(), 1);
    for secret in [
        "FAKE-proxy-pass",
        "nexus-user",
        "bmV4dXMtdXNlcjpGQUtFLXByb3h5LXBhc3M",
    ] {
        assert!(!err.contains(secret), "{err}");
    }
}

fn sources(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("讀資料夾") {
        let path = entry.expect("項目").path();
        if path.is_dir() {
            sources(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// rmcp 的 `from_uri`／`from_config` 與 reqwest 的預設建構會自己挑 TLS 實作與信任庫；`ClientConfig::builder()` 用行程的預設 provider。
/// reqwest 帶進來的 `rustls-platform-verifier` 留在相依樹裡，只靠這個測試擋住繞過 [`http_client`] 的寫法。
#[test]
fn 宿主原始碼不繞過_tls_模組() {
    let forbidden = [
        "from_uri(",
        "from_config(",
        "reqwest::Client::new(",
        "Client::new()",
        "ClientConfig::builder()",
        "ClientBuilder::new(",
        "Client::default(",
        "rustls_native_certs",
        "rustls_platform_verifier",
        "webpki_roots",
        "webpki_root_certs",
    ];
    // 建 reqwest 客戶端與裝代理只准在 `src/tls.rs` 的 `http_client` 裡。
    let only_in_tls = ["Client::builder(", ".proxy("];
    let tls = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("tls.rs");
    let mut files = Vec::new();
    for dir in ["src", "examples"] {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join(dir);
        if dir.is_dir() {
            sources(&dir, &mut files);
        }
    }
    assert!(!files.is_empty());
    let mut hits = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).expect("讀檔");
        for (n, line) in text.lines().enumerate() {
            for word in forbidden {
                if line.contains(word) {
                    hits.push(format!("{}:{}：{word}", file.display(), n + 1));
                }
            }
            for word in only_in_tls {
                if *file != tls && line.contains(word) {
                    hits.push(format!("{}:{}：{word}", file.display(), n + 1));
                }
            }
        }
    }
    assert!(hits.is_empty(), "{hits:#?}");
}
