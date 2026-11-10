//! 整合測試共用的本機 HTTPS 伺服器與 CONNECT 代理。只用 std 與 rustls（ring），不需要別的相依；憑證是 `tests/fixtures/tls/` 的夾具。每支測試只用到其中一部分。

#![allow(dead_code)]

pub mod fake_mcp;

use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};

pub fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/tls")
        .join(name)
}

fn server_config() -> Arc<ServerConfig> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(fixture("leaf.pem"))
        .expect("讀葉憑證")
        .map(|c| c.expect("葉憑證"))
        .collect();
    let key = PrivateKeyDer::from_pem_file(fixture("leaf.key")).expect("讀私鑰");
    let config =
        ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("協定版本")
            .with_no_client_auth()
            .with_single_cert(certs, key)
            .expect("伺服器憑證");
    Arc::new(config)
}

/// 一個 HTTP 請求：請求行、標頭（名字小寫）與主體。
#[derive(Debug, Clone)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// 讀一個 HTTP/1.1 請求。連線收了或格式不對回 `None`。
pub fn read_request(reader: &mut impl BufRead) -> Option<Request> {
    let mut line = String::new();
    if reader.read_line(&mut line).ok()? == 0 {
        return None;
    }
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let mut headers = Vec::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).ok()?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':')?;
        headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
    }
    let length = headers
        .iter()
        .find(|(n, _)| n == "content-length")
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0; length];
    reader.read_exact(&mut body).ok()?;
    Some(Request {
        method,
        path,
        headers,
        body,
    })
}

/// 一個回應：狀態、標頭與主體。`Content-Length` 自動補。
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn new(status: u16, content_type: &str, body: impl Into<Vec<u8>>) -> Response {
        Response {
            status,
            headers: vec![("Content-Type".into(), content_type.into())],
            body: body.into(),
        }
    }

    pub fn empty(status: u16) -> Response {
        Response {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    fn write(&self, out: &mut impl Write) -> std::io::Result<()> {
        let mut head = format!("HTTP/1.1 {} X\r\n", self.status);
        for (name, value) in &self.headers {
            head.push_str(&format!("{name}: {value}\r\n"));
        }
        head.push_str(&format!("Content-Length: {}\r\n\r\n", self.body.len()));
        out.write_all(head.as_bytes())?;
        out.write_all(&self.body)?;
        out.flush()
    }
}

pub type Handler = Arc<dyn Fn(&Request) -> Response + Send + Sync>;

/// 本機的 HTTPS 伺服器：每條連線一個執行緒，keep-alive，照 `handler` 回。握手失敗的連線直接丟掉。
pub struct TlsServer {
    pub port: u16,
}

impl TlsServer {
    pub fn start(handler: Handler) -> TlsServer {
        let listener = TcpListener::bind("127.0.0.1:0").expect("綁埠");
        let port = listener.local_addr().expect("位址").port();
        let config = server_config();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let config = Arc::clone(&config);
                let handler = Arc::clone(&handler);
                thread::spawn(move || {
                    let Ok(conn) = ServerConnection::new(config) else {
                        return;
                    };
                    let mut reader = BufReader::new(StreamOwned::new(conn, stream));
                    while let Some(request) = read_request(&mut reader) {
                        let response = handler(&request);
                        if response.write(reader.get_mut()).is_err() {
                            return;
                        }
                    }
                });
            }
        });
        TlsServer { port }
    }
}

/// 代理怎麼回 CONNECT。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProxyMode {
    /// 回 200，把隧道接到 `127.0.0.1:<port>`，不管 CONNECT 指名哪台主機。
    Tunnel(u16),
    /// 回 407。
    Reject,
}

/// 本機的 HTTP CONNECT 代理：記下每個請求的請求行與標頭。
pub struct ConnectProxy {
    pub port: u16,
    pub seen: Arc<Mutex<Vec<Request>>>,
}

impl ConnectProxy {
    pub fn start(mode: ProxyMode) -> ConnectProxy {
        let listener = TcpListener::bind("127.0.0.1:0").expect("綁埠");
        let port = listener.local_addr().expect("位址").port();
        let seen: Arc<Mutex<Vec<Request>>> = Arc::default();
        let log = Arc::clone(&seen);
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(client) = stream else { continue };
                let log = Arc::clone(&log);
                thread::spawn(move || tunnel(client, mode, &log));
            }
        });
        ConnectProxy { port, seen }
    }

    pub fn seen(&self) -> Vec<Request> {
        self.seen.lock().expect("鎖").clone()
    }
}

fn tunnel(client: TcpStream, mode: ProxyMode, log: &Mutex<Vec<Request>>) {
    let mut reader = BufReader::new(client.try_clone().expect("複製"));
    let Some(request) = read_request(&mut reader) else {
        return;
    };
    log.lock().expect("鎖").push(request.clone());
    let mut client = client;
    let ProxyMode::Tunnel(target) = mode else {
        let _ = Response::empty(407).write(&mut client);
        return;
    };
    if request.method != "CONNECT" {
        let _ = Response::empty(405).write(&mut client);
        return;
    }
    let Ok(upstream) = TcpStream::connect(("127.0.0.1", target)) else {
        let _ = Response::empty(502).write(&mut client);
        return;
    };
    if client
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .is_err()
    {
        return;
    }
    // CONNECT 的請求頭之後，客戶端在收到 200 之前不會送 TLS，所以 reader 裡沒有多讀的位元組。
    let mut up_write = upstream.try_clone().expect("複製");
    let mut client_read = client.try_clone().expect("複製");
    let pump = thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut up_write);
        let _ = up_write.shutdown(Shutdown::Write);
    });
    let mut up_read = upstream;
    let _ = std::io::copy(&mut up_read, &mut client);
    let _ = client.shutdown(Shutdown::Write);
    let _ = pump.join();
}
