//! 子行程：怎麼起、控制通道怎麼讀寫、怎麼收。

use crate::protocol::{frame, take_frame, DecodeError};
use std::ffi::OsString;
use std::os::fd::IntoRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn close(fd: libc::c_int) {
    // SAFETY：fd 是這個模組開的、只關一次（呼叫端關完就把它換成 None）。
    unsafe { libc::close(fd) };
}

fn set_nonblocking(fd: libc::c_int) {
    // SAFETY：只改這個 fd 的狀態旗標。
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

/// 起一個子行程：stdin、stdout 是給監督行程的 pipe（這一側非阻塞），stderr 照監督行程的。
///
/// 子行程在 exec 之前：清空訊號遮罩（監督行程擋著的訊號改由 signalfd 收，不能傳下去）、自成一個行程群組（之後殺整個群組）、
/// 設 `PR_SET_PDEATHSIG` 為 SIGKILL（監督行程死了它跟著死），設好之後再核一次父行程還是監督行程。
pub fn spawn(program: &OsString, args: &[OsString]) -> std::io::Result<(libc::pid_t, Chan)> {
    let parent = std::process::id() as libc::pid_t;
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    // SAFETY：pre_exec 在 fork 之後的子行程裡跑，這裡只做系統呼叫，不配置記憶體。
    unsafe {
        cmd.pre_exec(move || {
            let mut set: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut set);
            if libc::sigprocmask(libc::SIG_SETMASK, &set, std::ptr::null_mut()) != 0
                || libc::setpgid(0, 0) != 0
                || libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if libc::getppid() != parent {
                return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    let pid = child.id() as libc::pid_t;
    let stdin = child.stdin.take().map(IntoRawFd::into_raw_fd);
    let stdout = child.stdout.take().map(IntoRawFd::into_raw_fd);
    for fd in [stdin, stdout].into_iter().flatten() {
        set_nonblocking(fd);
    }
    Ok((pid, Chan { write: stdin, read: stdout, inbox: Vec::new(), outbox: Vec::new() }))
}

/// 送訊號給整個行程群組（群組號就是 leader 的 pid）。群組已空（ESRCH）不算錯。
pub fn signal_group(pid: libc::pid_t, signal: libc::c_int) {
    // SAFETY：只送訊號。leader 收屍之前它的 pid 不會被別人拿去用，見 `reap`。
    unsafe { libc::kill(-pid, signal) };
}

/// 收掉所有已經結束的子行程，每一個叫一次 `on_exit(pid, status)`。
///
/// 先用 `WNOWAIT` 看是誰結束，叫 `before_reap(pid)` 之後才真的收：leader 還是 zombie 時，它的 pid（也是它的群組號）不會被重用，
/// 這時對群組送的 SIGKILL 不會打到別人。
pub fn reap(mut before_reap: impl FnMut(libc::pid_t), mut on_exit: impl FnMut(libc::pid_t, libc::c_int)) {
    loop {
        // SAFETY：`info` 歸零後交給 waitid 填；WNOHANG 下沒有結束的子行程時 si_pid 留在 0。
        let pid = unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            if libc::waitid(libc::P_ALL, 0, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) != 0 {
                return;
            }
            info.si_pid()
        };
        if pid == 0 {
            return;
        }
        before_reap(pid);
        let mut status = 0;
        // SAFETY：pid 是剛剛看到已結束的子行程。
        if unsafe { libc::waitpid(pid, &mut status, 0) } == pid {
            on_exit(pid, status);
        }
    }
}

/// 一條控制通道：寫子行程的 stdin、讀它的 stdout，兩邊都非阻塞。關掉的那一邊換成 `None`，不再放進 poll。
pub struct Chan {
    write: Option<libc::c_int>,
    read: Option<libc::c_int>,
    inbox: Vec<u8>,
    outbox: Vec<u8>,
}

impl Chan {
    /// 要 poll 的 fd：讀端還開著就要 `POLLIN`；寫端只在還有沒寫完的才要 `POLLOUT`。
    pub fn poll_fds(&self) -> (Option<libc::c_int>, Option<libc::c_int>) {
        (self.read, self.write.filter(|_| !self.outbox.is_empty()))
    }

    /// 排一框，能寫多少寫多少。寫端關了就丟掉。
    pub fn send(&mut self, payload: &[u8]) {
        if self.write.is_none() {
            return;
        }
        self.outbox.extend_from_slice(&frame(payload));
        self.flush();
    }

    /// 把排著的寫出去，寫到 EAGAIN 為止。對方不收了（EPIPE 之類）就關掉寫端、丟掉排著的。
    pub fn flush(&mut self) {
        let Some(fd) = self.write else { return };
        while !self.outbox.is_empty() {
            // SAFETY：寫 outbox 的內容。
            let n = unsafe { libc::write(fd, self.outbox.as_ptr().cast(), self.outbox.len()) };
            if n > 0 {
                self.outbox.drain(..n as usize);
                continue;
            }
            match errno() {
                libc::EINTR => continue,
                libc::EAGAIN => return,
                _ => {
                    self.close_write();
                    return;
                }
            }
        }
    }

    /// 關寫端：對方的 stdin 讀到 EOF。
    pub fn close_write(&mut self) {
        if let Some(fd) = self.write.take() {
            close(fd);
        }
        self.outbox.clear();
    }

    /// 讀到 EAGAIN 為止，切出完整的框。讀到 EOF 或讀錯就關讀端，已經讀到的照樣切。框太大回錯（之後的位元組都對不上了），讀端也關掉。
    pub fn receive(&mut self) -> Result<Vec<Vec<u8>>, DecodeError> {
        if let Some(fd) = self.read {
            let mut buf = [0u8; 4096];
            loop {
                // SAFETY：讀進 buf。
                let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
                if n > 0 {
                    self.inbox.extend_from_slice(&buf[..n as usize]);
                    continue;
                }
                if n < 0 && errno() == libc::EINTR {
                    continue;
                }
                if n < 0 && errno() == libc::EAGAIN {
                    break;
                }
                self.close_read();
                break;
            }
        }
        let mut frames = Vec::new();
        loop {
            match take_frame(&mut self.inbox) {
                Ok(Some(payload)) => frames.push(payload),
                Ok(None) => return Ok(frames),
                Err(err) => {
                    self.close_read();
                    self.inbox.clear();
                    return Err(err);
                }
            }
        }
    }

    /// 只關 fd：EOF 之前讀到的還留在 inbox 裡切框。
    fn close_read(&mut self) {
        if let Some(fd) = self.read.take() {
            close(fd);
        }
    }
}

impl Drop for Chan {
    fn drop(&mut self) {
        self.close_write();
        self.close_read();
    }
}
