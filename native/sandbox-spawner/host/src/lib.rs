//! 宿主（#2569）：監督行程起的第三種子行程，全機共用一個。邏輯在 [`host`]；前台與對話行程連它的協定在 [`host_protocol`]，
//! 框內容是 [`json`]；主機級的插件樹在 [`kernel`]；一對裡組合行程與葉子之間那條橋的協定在 [`pair_protocol`]，組合行程那一端在 [`pair`]；受管憑證檔在 [`credentials`]；對外 HTTPS 的 TLS 設定在 [`tls`]，代理政策在 [`proxy`]；MCP 的設定、連線池與監督者在 [`mcp`]；別的執行緒叫醒宿主迴圈的自管道在 [`wake`]。執行檔 `main.rs`、examples 與整合測試都經這裡。
//!
//! 跟 spawner 分成兩個 package：框格式（`nexus_sandbox_spawner::protocol`）、控制面協定與 `Chan` 從那邊拿，那邊不依賴這裡。

pub mod credentials;
pub mod host;
pub mod host_protocol;
pub mod json;
pub mod kernel;
pub mod mcp;
pub mod pair;
pub mod pair_protocol;
pub mod proxy;
pub mod tls;
pub mod wake;
