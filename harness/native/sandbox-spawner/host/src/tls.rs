//! 宿主對外的 HTTPS（#2570）：密碼學實作固定用 ring，信任的根只來自設定指定的 PEM 檔，不讀系統的信任庫。
//! 宿主裡要 HTTP 客戶端的地方都經 [`http_client`]，代理照 [`crate::proxy`] 的政策；`tests/tls.rs` 掃原始碼，擋掉幾種已知的繞過寫法（清單在那個測試）。

use crate::proxy::ProxyPolicy;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::CertificateDer;
use rustls::{ClientConfig, RootCertStore};
use std::path::Path;
use std::sync::Arc;

/// 從 `roots` 這個 PEM 檔讀根憑證，建一份用 ring 的 TLS 設定。檔裡沒有任何一張憑證、或有一張認不得，都回錯。
pub fn client_config(roots: &Path) -> Result<ClientConfig, String> {
    let shown = roots.display();
    let mut store = RootCertStore::empty();
    let certs = CertificateDer::pem_file_iter(roots)
        .map_err(|err| format!("讀不了根憑證檔 {shown}：{err}"))?;
    for (i, cert) in certs.enumerate() {
        let cert = cert.map_err(|err| format!("根憑證檔 {shown} 第 {} 張認不得：{err}", i + 1))?;
        store
            .add(cert)
            .map_err(|err| format!("根憑證檔 {shown} 第 {} 張認不得：{err}", i + 1))?;
    }
    if store.is_empty() {
        return Err(format!("根憑證檔 {shown} 裡沒有憑證"));
    }
    with_roots(store)
}

/// 沒設根憑證（`NODE_EXTRA_CA_CERTS` 沒設）時用的 TLS 設定：信任庫是空的，任何 HTTPS 伺服器（含 https 的代理）都驗不過。stdio，以及直連或走 http 代理的純 HTTP 不經 TLS，不受影響。
/// 設了卻讀不了、空檔、認不得的，[`client_config`] 回錯；呼叫端（`mcp` 插件）把它降成這一份空信任庫並記下原因，不讓整個插件起不來。
pub fn empty_client_config() -> Result<ClientConfig, String> {
    with_roots(RootCertStore::empty())
}

fn with_roots(store: RootCertStore) -> Result<ClientConfig, String> {
    ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|err| format!("TLS 設定建不起來：{err}"))
        .map(|builder| builder.with_root_certificates(store).with_no_client_auth())
}

/// 用 [`client_config`] 的設定建 HTTP 客戶端，照 `proxy` 走代理（[`crate::proxy`]）。
/// 只認 `proxy` 這份政策，不讀環境變數：一律先 `.no_proxy()` 關掉 reqwest 自己讀的環境代理，有代理時再裝 `Proxy::custom`。
/// 經 CONNECT 隧道的 HTTPS 一樣用這份 TLS 設定驗伺服器。
pub fn http_client(config: ClientConfig, proxy: &ProxyPolicy) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .no_proxy();
    let builder = if proxy.is_direct() {
        builder
    } else {
        let policy = proxy.clone();
        builder.proxy(reqwest::Proxy::custom(move |url| {
            policy.proxy_for(url).cloned()
        }))
    };
    builder
        .build()
        .map_err(|err| format!("HTTP 客戶端建不起來：{err}"))
}
