//! nexus 的沙箱 spawner：常駐行程，裝一次 seccomp，替每個工具子行程各上一份 Landlock 再 exec（#1946）。
//! 執行檔在 `main.rs`；這裡把協定與過濾器開給整合測試用。監督行程的控制面協定（#1947）也放在這個 crate，跟 spawner 共用框格式；spawner 的執行檔與整合測試都不用它。

pub mod landlock;
pub mod protocol;
pub mod seccomp;
pub mod supervisor_protocol;
