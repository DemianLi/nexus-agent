//! 宿主的 HTTP MCP（#2570）：插件 `mcp` 與它 expose 的服務在 [`service`]，連線池與監督者在自己的執行緒（[`bridge`]）。
//! [`config`] 解一台 HTTP server 的設定，[`connection`] 連一代，[`pool`] 讓一份設定共用一份連線，[`redact`] 遮蔽送回對話行程的文字裡的憑證值，
//! [`supervisor`] 管一台 server 的連上、掉線與重連。

pub mod bridge;
pub mod config;
pub mod connection;
pub mod pool;
pub mod redact;
pub mod service;
pub mod supervisor;
