//! nexus 的沙箱 spawner：常駐行程，裝一次 seccomp，替每個工具子行程各上一份 Landlock 再 exec（#1946）。
//! 執行檔在 `main.rs`；這裡把協定與過濾器開給整合測試用。

pub mod landlock;
pub mod protocol;
pub mod seccomp;
