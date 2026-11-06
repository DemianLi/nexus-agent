//! 監督行程整合測試用的假前台：連上測試聽著的 Unix socket，把自己的 stdin 轉進去、把 socket 讀到的轉到 stdout。
//! 讓測試站在前台的位置跟監督行程講話。任一邊讀到 EOF 就以 0 結束。
//!
//! ```text
//! fake_front <socket 路徑>
//! ```

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;

fn pump(mut from: impl Read, mut to: impl Write) {
    let mut buf = [0u8; 4096];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => std::process::exit(0),
            Ok(n) => {
                if to.write_all(&buf[..n]).and_then(|()| to.flush()).is_err() {
                    std::process::exit(0);
                }
            }
        }
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("socket 路徑");
    let stream = UnixStream::connect(path).unwrap();
    let inbound = stream.try_clone().unwrap();
    std::thread::spawn(move || pump(std::io::stdin(), inbound));
    pump(stream, std::io::stdout());
}
