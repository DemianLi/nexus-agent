//! 環境變數裡的代理不影響宿主：政策是直連時，`HTTPS_PROXY` 指的代理收不到任何連線。改行程環境，所以自成一個測試執行檔、只有這一條。

mod common;

use common::{ConnectProxy, ProxyMode, Response, TlsServer};
use nexus_host::proxy::ProxyPolicy;
use nexus_host::tls::{client_config, http_client};
use std::sync::Arc;

#[test]
fn 直連時不讀環境裡的代理() {
    let server = TlsServer::start(Arc::new(|_| Response::new(200, "text/plain", "ok")));
    let proxy = ConnectProxy::start(ProxyMode::Reject);
    let address = format!("http://127.0.0.1:{}", proxy.port);
    for name in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
        std::env::set_var(name, &address);
    }
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");
    let client = http_client(
        client_config(&common::fixture("ca-a.pem")).expect("根"),
        &ProxyPolicy::direct(),
    )
    .expect("客戶端");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let body = runtime.block_on(async {
        client
            .get(format!("https://localhost:{}/", server.port))
            .send()
            .await
            .expect("送")
            .text()
            .await
            .expect("主體")
    });
    assert_eq!(body, "ok");
    assert!(proxy.seen().is_empty());
}
