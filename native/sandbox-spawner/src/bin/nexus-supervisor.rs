//! 監督行程（#1947）的執行檔，只在 Linux 上跑。行為見 [`nexus_sandbox_spawner::supervisor`]。

fn main() {
    std::process::exit(nexus_sandbox_spawner::supervisor::run(std::env::args_os().skip(1).collect()));
}
