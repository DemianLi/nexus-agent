//! nexus 的沙箱 spawner：常駐行程，裝一次 seccomp，替每個工具子行程各上一份 Landlock 再 exec（#1946）。
//! 執行檔在 `main.rs`；這裡把協定與過濾器開給整合測試用。
//!
//! 同一個 crate 還有第二支執行檔 `nexus-supervisor`（`bin/nexus-supervisor.rs`，#1947 的監督行程），邏輯在 [`supervisor`]，
//! 控制面協定在 [`supervisor_protocol`]，跟 spawner 共用框格式。spawner 的執行檔不用這兩個模組；監督行程不裝 seccomp（理由見 README）。

pub mod landlock;
pub mod protocol;
pub mod seccomp;
pub mod supervisor;
pub mod supervisor_protocol;
