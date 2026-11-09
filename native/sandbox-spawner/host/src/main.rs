//! 宿主（#2569）的執行檔，只在 Linux 上跑，由監督行程起。行為見 [`nexus_host::host`]。

fn main() {
    let args = std::env::args_os().skip(1).collect();
    std::process::exit(nexus_host::host::run(args));
}
