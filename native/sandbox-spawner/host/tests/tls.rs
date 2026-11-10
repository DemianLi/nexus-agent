//! `nexus_host::tls`：ring 的 TLS 設定只信設定指定的根；再掃宿主的原始碼，擋掉繞過它建 HTTP 客戶端的寫法。

use nexus_host::tls::{client_config, http_client};
use std::path::{Path, PathBuf};

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
    assert!(http_client(config).is_ok());
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
    // 建 reqwest 客戶端只准在 `src/tls.rs` 的 `http_client` 裡。
    let builder = "Client::builder(";
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
            if *file != tls && line.contains(builder) {
                hits.push(format!("{}:{}：{builder}", file.display(), n + 1));
            }
        }
    }
    assert!(hits.is_empty(), "{hits:#?}");
}
