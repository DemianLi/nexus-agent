//! 環境變數裡的代理不影響宿主：政策是直連時，`HTTPS_PROXY` 指的代理收不到任何連線；政策有代理時，`NO_PROXY` 不讓請求繞過它、`HTTPS_PROXY` 也不取代它。
//! 改行程環境，所以自成一個測試執行檔，兩種情境寫在同一條裡依序跑。

mod common;

use common::{ConnectProxy, ProxyMode, Response, TlsServer};
use nexus_host::json::Value;
use nexus_host::proxy::ProxyPolicy;
use nexus_host::tls::{client_config, http_client};
use std::sync::Arc;

fn get(policy: &ProxyPolicy, url: &str) -> Result<String, String> {
    let client = http_client(
        client_config(&common::fixture("ca-a.pem")).expect("根"),
        policy,
    )
    .expect("客戶端");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let response = client.get(url).send().await.map_err(|e| format!("{e:?}"))?;
        response.text().await.map_err(|e| format!("{e:?}"))
    })
}

#[test]
fn 環境裡的代理設定一律不讀() {
    let server = TlsServer::start(Arc::new(|_| Response::new(200, "text/plain", "ok")));
    let proxy = ConnectProxy::start(ProxyMode::Reject);
    let address = format!("http://127.0.0.1:{}", proxy.port);
    for name in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        std::env::set_var(name, &address);
    }
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");
    // 政策是直連：環境的 `HTTPS_PROXY` 收不到連線。
    assert_eq!(
        get(
            &ProxyPolicy::direct(),
            &format!("https://localhost:{}/", server.port)
        ),
        Ok("ok".into())
    );
    assert!(proxy.seen().is_empty());

    // 政策有代理：環境的 `NO_PROXY` 放行目標也照樣走政策的代理，環境的 `HTTPS_PROXY` 收不到連線。
    // `mcp.nexus.test` 解析不到，直連必定失敗；通了就表示走的是政策的代理。
    for name in ["NO_PROXY", "no_proxy"] {
        std::env::set_var(name, "mcp.nexus.test");
    }
    let tunnel = ConnectProxy::start(ProxyMode::Tunnel(server.port));
    let policy: Value = serde_json::from_str(&format!(
        r#"{{"httpsProxy":"http://127.0.0.1:{}","noProxy":""}}"#,
        tunnel.port
    ))
    .expect("JSON");
    let policy = ProxyPolicy::parse(&policy).expect("政策");
    assert_eq!(
        get(&policy, &format!("https://mcp.nexus.test:{}/", server.port)),
        Ok("ok".into())
    );
    assert_eq!(tunnel.seen().len(), 1);
    assert!(proxy.seen().is_empty());
}
