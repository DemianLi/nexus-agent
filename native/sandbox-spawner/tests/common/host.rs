//! 測試站在監督行程的位置起真的 `nexus-host`：握手、送身分表、讀它的回報。

use nexus_sandbox_spawner::protocol::{frame, take_frame};
use nexus_sandbox_spawner::supervisor_protocol::{
    decode_host_report, encode_host_command, HostCommand, HostReport, Role, PROTOCOL_VERSION,
};
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

pub const HOST: &str = env!("CARGO_BIN_EXE_nexus-host");

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
        let mut child = Command::new(HOST)
            .arg("--socket")
            .arg(socket)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
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
        assert_eq!(host.report(), Some(HostReport::Hello { version: PROTOCOL_VERSION }));
        host.command(&HostCommand::Hello { version: PROTOCOL_VERSION });
        assert_eq!(host.report(), Some(HostReport::Ready));
        assert!(socket.exists());
        host
    }

    pub fn command(&mut self, command: &HostCommand) {
        self.stdin.as_mut().unwrap().write_all(&frame(&encode_host_command(command))).unwrap();
    }

    pub fn grant(&mut self, pid: u32, token: &str, role: Role, thread: &str) {
        self.command(&HostCommand::Grant { pid, token: token.as_bytes().to_vec(), role, thread: thread.as_bytes().to_vec() });
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

pub fn violation(pid: u32, reason: &str) -> HostReport {
    HostReport::Violation { pid, reason: reason.as_bytes().to_vec() }
}

/// 連線編號記 0：跟 [`ignoring_conn`] 處理過的回報比。
pub fn unregistered(pid: u32) -> HostReport {
    HostReport::Unregistered { pid, conn: 0 }
}

/// `unregistered` 的連線編號換成 0，只比 pid。編號本身另有測試。
pub fn ignoring_conn(report: Option<HostReport>) -> Option<HostReport> {
    report.map(|report| match report {
        HostReport::Unregistered { pid, .. } => HostReport::Unregistered { pid, conn: 0 },
        other => other,
    })
}
