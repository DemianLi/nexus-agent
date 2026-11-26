//! 組合行程（#2583）的執行檔，只在 Linux 上跑。行為見 [`nexus_host::composition`]。

fn main() {
    let args = std::env::args_os().skip(1).collect();
    std::process::exit(nexus_host::composition::run(args));
}
