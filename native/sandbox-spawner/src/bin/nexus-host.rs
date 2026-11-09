//! 宿主（#2569）的執行檔，只在 Linux 上跑，由監督行程起。行為見 [`nexus_sandbox_spawner::host`]。

fn main() {
    std::process::exit(nexus_sandbox_spawner::host::run(
        std::env::args_os().skip(1).collect(),
    ));
}
