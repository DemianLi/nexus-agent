//! 可單獨跑的本機 HTTPS MCP server，行為同 `tests/common/fake_mcp.rs`（憑證是 `tests/fixtures/tls/` 的夾具）：
//! 起來之後把埠印成一行，stdin 關了就結束。
//!
//! ```text
//! fake_mcp_server [--modern] [--tools a,b,...] [--instructions <text>]
//! ```

#[path = "../tests/common/mod.rs"]
mod common;

use std::io::{Read, Write};
use std::sync::Arc;

use common::fake_mcp::{handler, FakeMcp};
use common::TlsServer;

fn main() {
    let mut fake = FakeMcp::with_tools(false, &[]);
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--modern" => fake.modern = true,
            "--tools" => {
                let list = args.next().expect("--tools 要接名字");
                let names: Vec<&str> = list.split(',').filter(|n| !n.is_empty()).collect();
                fake.pages = FakeMcp::with_tools(false, &names).pages;
            }
            "--instructions" => {
                fake.instructions = Some(args.next().expect("--instructions 要接文字"))
            }
            _ => {
                panic!("用法：fake_mcp_server [--modern] [--tools a,b,...] [--instructions <text>]")
            }
        }
    }
    let server = TlsServer::start(handler(fake, Arc::default()));
    let mut out = std::io::stdout();
    writeln!(out, "{}", server.port).expect("寫埠");
    out.flush().expect("寫埠");
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
}
