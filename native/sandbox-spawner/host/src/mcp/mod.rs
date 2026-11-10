//! 宿主的 MCP 連線（#2570）：[`config`] 解一台 HTTP server 的設定，[`pool`] 讓一份設定共用一份連線，
//! [`supervisor`] 管一台 server 的連上、掉線與重連。

pub mod config;
pub mod pool;
pub mod supervisor;
