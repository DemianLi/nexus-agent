//! 整合測試用的假客戶端（宿主、spawner、監督行程三支都用）：每個 `<token>` 依序各連一次 `<socket>`、送 `hello`，回答各印成一行（見 `common/host_client.rs`）。
//!
//! ```text
//! host_client [--wait-stdin] <socket> <token>...
//! ```
//!
//! `--wait-stdin`：先等 stdin 讀到一行才連，測試好先拿 pid 登記給宿主。

#[path = "common/host_client.rs"]
mod host_client;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--wait-stdin") {
        args.remove(0);
        let mut line = String::new();
        std::io::stdin().read_line(&mut line).unwrap();
    }
    let (socket, tokens) = args
        .split_first()
        .expect("用法：host_client [--wait-stdin] <socket> <token>...");
    for token in tokens {
        println!(
            "{}",
            host_client::hello_line(std::path::Path::new(socket), token)
        );
    }
}
