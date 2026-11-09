//! 宿主（#2569）：監督行程起的第三種子行程，全機共用一個。邏輯在 [`host`]；前台與對話行程連它的協定在 [`host_protocol`]，
//! 框內容是 [`json`]；主機級的插件樹在 [`kernel`]。執行檔在 `main.rs`，這裡開給整合測試用。
//!
//! 跟 spawner 分成兩個 package：框格式（`nexus_sandbox_spawner::protocol`）、控制面協定與 `Chan` 從那邊拿，那邊不依賴這裡。

pub mod host;
pub mod host_protocol;
pub mod json;
pub mod kernel;
