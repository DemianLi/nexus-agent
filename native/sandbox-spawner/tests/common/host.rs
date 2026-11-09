//! 測試站在監督行程的位置起真的 `nexus-host`：握手、送身分表、讀它的回報。

use nexus_sandbox_spawner::protocol::{frame, take_frame};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_host_report, encode_host_command, HostCommand, HostReport, Role, PROTOCOL_VERSION,
};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

pub const HOST: &str = env!("CARGO_BIN_EXE_nexus-host");

/// [`HostProc::grant`] 送的序號。
pub const GRANTED: u32 = 1;

pub fn example(name: &str) -> PathBuf {
    Path::new(HOST).parent().unwrap().join("examples").join(name)
}

pub struct HostProc {
    pub child: Child,
    pub socket: PathBuf,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
    inbox: Vec<u8>,
}

impl HostProc {
    /// 起宿主、還沒握手。
    pub fn spawn(socket: &Path) -> HostProc {
        HostProc::spawn_with(socket, Command::new(HOST))
    }

    /// 同 [`HostProc::start`]，但宿主的開檔數軟硬上限都是 `limit`：它拉不高，連線到一定數量開檔數就會用完。
    pub fn start_with_open_file_limit(socket: &Path, limit: u64) -> HostProc {
        let mut command = Command::new(HOST);
        // SAFETY：fork 之後只呼叫 setrlimit。
        unsafe {
            command.pre_exec(move || {
                let rlimit = libc::rlimit { rlim_cur: limit, rlim_max: limit };
                if libc::setrlimit(libc::RLIMIT_NOFILE, &rlimit) == 0 {
                    Ok(())
                } else {
                    Err(std::io::Error::last_os_error())
                }
            });
        }
        let mut host = HostProc::spawn_with(socket, command);
        host.handshake();
        host
    }

    fn spawn_with(socket: &Path, mut command: Command) -> HostProc {
        let mut child = command.arg("--socket").arg(socket).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        // SAFETY：只改這個 fd 的狀態旗標。
        unsafe {
            let fd = stdout.as_raw_fd();
            libc::fcntl(fd, libc::F_SETFL, libc::fcntl(fd, libc::F_GETFL) | libc::O_NONBLOCK);
        }
        HostProc { child, socket: socket.to_path_buf(), stdin, stdout, inbox: Vec::new() }
    }

    /// 起宿主、握手、等到 `ready`。
    pub fn start(socket: &Path) -> HostProc {
        let mut host = HostProc::spawn(socket);
        host.handshake();
        host
    }

    fn handshake(&mut self) {
        assert_eq!(self.report(), Some(HostReport::Hello { version: PROTOCOL_VERSION }));
        self.command(&HostCommand::Hello { version: PROTOCOL_VERSION });
        assert_eq!(self.report(), Some(HostReport::Ready));
        assert!(self.socket.exists());
    }

    pub fn command(&mut self, command: &HostCommand) {
        self.stdin.as_mut().unwrap().write_all(&frame(&encode_host_command(command))).unwrap();
    }

    /// 送一筆序號 [`GRANTED`] 的身分。
    pub fn grant(&mut self, pid: u32, token: &str, role: Role, thread: &str) {
        self.grant_as(pid, GRANTED, token, role, thread);
    }

    pub fn grant_as(&mut self, pid: u32, generation: u32, token: &str, role: Role, thread: &str) {
        let (token, thread) = (token.as_bytes().to_vec(), thread.as_bytes().to_vec());
        self.command(&HostCommand::Grant { pid, generation, token, role, thread });
    }

    /// 關 stdin（監督行程走拆除梯度的第一步）。
    pub fn close_stdin(&mut self) {
        self.stdin = None;
    }

    /// 下一則回報；宿主關了 stdout 回 `None`。
    pub fn report(&mut self) -> Option<HostReport> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(payload) = take_frame(&mut self.inbox).unwrap() {
                return Some(decode_host_report(&payload).unwrap());
            }
            let mut buf = [0u8; 4096];
            match self.stdout.read(&mut buf) {
                Ok(0) => return None,
                Ok(n) => self.inbox.extend_from_slice(&buf[..n]),
                Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline, "等不到宿主的回報");
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(err) => panic!("讀宿主的 stdout：{err}"),
            }
        }
    }

    /// 現在已經送到的回報，不等。
    pub fn reports_so_far(&mut self) -> Vec<HostReport> {
        let mut buf = [0u8; 4096];
        while let Ok(n) = self.stdout.read(&mut buf) {
            if n == 0 {
                break;
            }
            self.inbox.extend_from_slice(&buf[..n]);
        }
        let mut out = Vec::new();
        while let Some(payload) = take_frame(&mut self.inbox).unwrap() {
            out.push(decode_host_report(&payload).unwrap());
        }
        out
    }

    pub fn wait(&mut self) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "宿主沒結束");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for HostProc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub fn violation(pid: u32, generation: u32, reason: &str) -> HostReport {
    HostReport::Violation { pid, generation, reason: reason.as_bytes().to_vec() }
}

/// `unregistered` 回報的 pid 與理由；連線編號不比，另有 `unregistered_reports_number_each_connection`。收到別種回報就 panic。
pub fn unregistered(report: Option<HostReport>) -> Option<(u32, String)> {
    match report? {
        HostReport::Unregistered { pid, reason, .. } => Some((pid, String::from_utf8(reason).unwrap())),
        other => panic!("不是 unregistered：{other:?}"),
    }
}
