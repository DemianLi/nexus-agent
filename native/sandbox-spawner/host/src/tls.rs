//! 宿主對外的 HTTPS（#2570）：密碼學實作固定用 ring，信任的根只來自設定指定的 PEM 檔，不讀系統的信任庫。
//! 宿主裡要 HTTP 客戶端的地方都經 [`http_client`]；`tests/tls.rs` 掃原始碼，擋掉幾種已知的繞過寫法（清單在那個測試）。

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
    ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|err| format!("TLS 設定建不起來：{err}"))
        .map(|builder| builder.with_root_certificates(store).with_no_client_auth())
}

/// 用 [`client_config`] 的設定建 HTTP 客戶端。不走環境變數裡的代理，跟 Node 的 `fetch` 一樣。
pub fn http_client(config: ClientConfig) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .tls_backend_preconfigured(config)
        .no_proxy()
        .build()
        .map_err(|err| format!("HTTP 客戶端建不起來：{err}"))
}
