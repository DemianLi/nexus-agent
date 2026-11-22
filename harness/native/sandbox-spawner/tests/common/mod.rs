//! 整合測試共用的東西；每支測試只用到其中一部分。
//!
//! `host/tests/host.rs` 也用 `#[path]` 把這裡編進 `nexus-host` 的測試，所以只能用兩個 package 都有的東西：不 use `nexus_host`、不用 `CARGO_BIN_EXE_*`。
#![allow(dead_code)]

pub mod host;

use std::path::PathBuf;

/// workspace 裡任一個 package 的執行檔或 example：`cargo` 只給測試自己 package 的 `CARGO_BIN_EXE_*`，
/// 但整個 workspace 共用同一個 target 目錄，所以從這支測試執行檔（`<target>/<profile>/deps/…`）往上兩層找。
/// 要先把整個 workspace 編好（`cargo test --workspace`）。
pub fn built(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let path = exe.parent().unwrap().parent().unwrap().join(name);
    assert!(
        path.exists(),
        "{} 不存在：要用 `cargo test --workspace` 把兩個 package 一起編",
        path.display()
    );
    path
}
