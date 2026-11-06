//! 子行程：怎麼起、控制通道怎麼讀寫、stderr 怎麼轉送、怎麼收。

use super::memory::{HEAP_LINE_PREFIX, HEAP_MARKER, HEAP_TAIL};
use crate::protocol::{frame, take_frame, DecodeError};
use std::ffi::OsString;
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::atomic::{AtomicU64, Ordering};
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

/// `receive` 與 stderr 轉送一次最多讀這麼多：對方一直寫也會交回迴圈，計時器、訊號與別的通道照樣輪得到。
pub const READ_BUDGET: usize = 64 * 1024;

fn errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

fn set_nonblocking(fd: &OwnedFd) {
    // SAFETY：只改這個 fd 的狀態旗標。
    unsafe {
        let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
        libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK);
    }
}

/// 起一個子行程：stdin、stdout 是給監督行程的 pipe（這一側非阻塞）。`tap_stderr` 時 stderr 也接到監督行程（[`StderrTap`]），
/// 否則照監督行程的。
///
/// 子行程在 exec 之前：清空訊號遮罩（監督行程擋著的訊號改由 signalfd 收，不能傳下去）、自成一個行程群組（之後殺整個群組）、
/// 設 `PR_SET_PDEATHSIG` 為 SIGKILL（監督行程死了它跟著死），設好之後再核一次父行程還是監督行程（fork 之後、prctl 之前監督行程若已經死了，PDEATHSIG 不會再觸發）。
pub fn spawn(
    program: &OsString,
    args: &[OsString],
    tap_stderr: bool,
) -> std::io::Result<(libc::pid_t, Chan, Option<StderrTap>)> {
    let parent = std::process::id() as libc::pid_t;
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::piped()).stdout(Stdio::piped());
    cmd.stderr(if tap_stderr { Stdio::piped() } else { Stdio::inherit() });
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
    let stdin = child.stdin.take().map(OwnedFd::from);
    let stdout = child.stdout.take().map(OwnedFd::from);
    let stderr = child.stderr.take().map(OwnedFd::from);
    for fd in [&stdin, &stdout, &stderr].into_iter().flatten() {
        set_nonblocking(fd);
    }
    let chan = Chan { write: stdin, read: stdout, inbox: Vec::new(), outbox: Vec::new(), finishing: false };
    Ok((pid, chan, stderr.map(StderrTap::new)))
}

/// 送訊號給整個行程群組（群組號就是 leader 的 pid）。錯一律不理（例如群組已空的 ESRCH）。
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
    write: Option<OwnedFd>,
    read: Option<OwnedFd>,
    inbox: Vec<u8>,
    outbox: Vec<u8>,
    /// 排著的寫完就關寫端。
    finishing: bool,
}

impl Chan {
    /// 要 poll 的 fd：讀端還開著就要 `POLLIN`；寫端只在還有沒寫完的才要 `POLLOUT`。
    pub fn poll_fds(&self) -> (Option<libc::c_int>, Option<libc::c_int>) {
        let read = self.read.as_ref().map(AsRawFd::as_raw_fd);
        let write = self.write.as_ref().filter(|_| !self.outbox.is_empty()).map(AsRawFd::as_raw_fd);
        (read, write)
    }

    /// 排一框，能寫多少寫多少。寫端關了就丟掉。
    pub fn send(&mut self, payload: &[u8]) {
        if self.write.is_none() {
            return;
        }
        self.outbox.extend_from_slice(&frame(payload));
        self.flush();
    }

    /// 把排著的寫出去，寫到 EAGAIN 為止；寫完了而且叫過 `finish` 就關寫端。對方不收了（EPIPE 之類）就關掉寫端、丟掉排著的。
    pub fn flush(&mut self) {
        let Some(fd) = self.write.as_ref().map(AsRawFd::as_raw_fd) else { return };
        while !self.outbox.is_empty() {
            // SAFETY：寫 outbox 的內容。
            let n = unsafe { libc::write(fd, self.outbox.as_ptr().cast(), self.outbox.len()) };
            if n > 0 {
                self.outbox.drain(..n as usize);
                continue;
            }
            if n < 0 && errno() == libc::EINTR {
                continue;
            }
            if n < 0 && errno() == libc::EAGAIN {
                return;
            }
            self.close_write();
            return;
        }
        if self.finishing {
            self.close_write();
        }
    }

    /// 排著的寫完再關寫端：對方先讀完已經送出的框，再讀到 EOF。
    pub fn finish(&mut self) {
        self.finishing = true;
        self.flush();
    }

    /// 當場關寫端（對方的 stdin 讀到 EOF），排著沒寫完的一併丟掉。
    pub fn close_write(&mut self) {
        self.write = None;
        self.outbox.clear();
    }

    /// 讀到 EAGAIN 或讀滿 `READ_BUDGET` 為止，切出完整的框；沒讀完的留給下一次 poll。讀到 EOF 或讀錯就關讀端，已經讀到的照樣切。
    /// 框太大回錯（之後的位元組都對不上了），讀端也關掉。
    pub fn receive(&mut self) -> Result<Vec<Vec<u8>>, DecodeError> {
        if let Some(fd) = &self.read {
            let fd = fd.as_raw_fd();
            let mut buf = [0u8; 4096];
            let mut budget = READ_BUDGET;
            while budget > 0 {
                // SAFETY：讀進 buf。
                let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
                if n > 0 {
                    self.inbox.extend_from_slice(&buf[..n as usize]);
                    budget = budget.saturating_sub(n as usize);
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
        self.read = None;
    }
}

/// 子行程的 stderr：讀到的原樣寫到監督行程自己的 stderr，順便逐行找 V8 的 heap 訊息（一行跨兩次讀也找得到）。
pub struct StderrTap {
    read: Option<OwnedFd>,
    /// 還沒讀到換行的這一行，最多留 [`LINE_CAP`] 個位元組；超過的那一行不可能是 heap 訊息。
    line: Vec<u8>,
    line_overflow: bool,
    /// 到目前為止讀到的位元組數。
    total: u64,
    /// 最後一則 heap 訊息那一行結尾時的 `total`。
    heap_line_end: Option<u64>,
}

/// heap 訊息一行最長約 104 位元組（`Ineffective mark-compacts …` 那種）；512 留了餘量。
const LINE_CAP: usize = 512;

impl StderrTap {
    pub fn new(read: OwnedFd) -> StderrTap {
        StderrTap { read: Some(read), line: Vec::new(), line_overflow: false, total: 0, heap_line_end: None }
    }

    pub fn poll_fd(&self) -> Option<libc::c_int> {
        self.read.as_ref().map(AsRawFd::as_raw_fd)
    }

    /// 最後一則以 [`HEAP_LINE_PREFIX`] 開頭、含 [`HEAP_MARKER`]、不超過 [`LINE_CAP`] 的行，結尾是否落在 stderr 最後 [`HEAP_TAIL`]
    /// 位元組內。還沒換行的那一行會被當成結束：只在讀完之後（收屍時）呼叫。
    pub fn heap_message_near_end(&mut self) -> bool {
        self.end_line();
        self.heap_line_end.is_some_and(|end| self.total - end <= HEAP_TAIL)
    }

    /// 讀到 EAGAIN 或讀滿 `budget` 為止，轉出去；讀到 EOF 或讀錯就關掉。
    pub fn pump(&mut self, budget: usize) {
        let Some(fd) = self.read.as_ref().map(AsRawFd::as_raw_fd) else { return };
        let mut buf = [0u8; 4096];
        let mut left = budget;
        while left > 0 {
            // SAFETY：讀進 buf。
            let n = unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n > 0 {
                let chunk = &buf[..n as usize];
                write_stderr(chunk);
                self.scan(chunk);
                left = left.saturating_sub(chunk.len());
                continue;
            }
            if n < 0 && errno() == libc::EINTR {
                continue;
            }
            if n < 0 && errno() == libc::EAGAIN {
                return;
            }
            self.read = None;
            return;
        }
    }

    fn scan(&mut self, mut chunk: &[u8]) {
        while !chunk.is_empty() {
            let (part, newline) = match chunk.iter().position(|&b| b == b'\n') {
                Some(i) => (&chunk[..i], true),
                None => (chunk, false),
            };
            let room = LINE_CAP - self.line.len();
            self.line.extend_from_slice(&part[..part.len().min(room)]);
            self.line_overflow |= part.len() > room;
            self.total += part.len() as u64;
            chunk = &chunk[part.len()..];
            if newline {
                self.end_line();
                self.total += 1;
                chunk = &chunk[1..];
            }
        }
    }

    fn end_line(&mut self) {
        let line = std::mem::take(&mut self.line);
        if !std::mem::take(&mut self.line_overflow)
            && line.starts_with(HEAP_LINE_PREFIX)
            && line.windows(HEAP_MARKER.len()).any(|window| window == HEAP_MARKER)
        {
            self.heap_line_end = Some(self.total);
        }
    }
}

/// 寫不出去而丟掉的位元組，還沒報過的。
static DROPPED: AtomicU64 = AtomicU64::new(0);

/// 寫到監督行程自己的 fd 2。fd 2 是阻塞的而讀者不讀時，整個監督行程停在這裡。寫不出去（fd 2 非阻塞而滿了、或壞了）就丟掉剩下的、
/// 記下丟了多少，等下一次寫得出去時先講一句。
fn write_stderr(bytes: &[u8]) {
    let dropped = DROPPED.load(Ordering::Relaxed);
    if dropped > 0 {
        let note = format!("[nexus-supervisor] 對話行程的 stderr 寫不出去，丟掉了 {dropped} 位元組\n");
        if write_all(2, note.as_bytes()).is_ok() {
            DROPPED.fetch_sub(dropped, Ordering::Relaxed);
        }
    }
    if let Err(left) = write_all(2, bytes) {
        DROPPED.fetch_add(left as u64, Ordering::Relaxed);
    }
}

/// 寫完回 `Ok`；EINTR 以外的錯（含 EAGAIN）停下，回還沒寫出去的位元組數。
fn write_all(fd: libc::c_int, mut bytes: &[u8]) -> Result<(), usize> {
    while !bytes.is_empty() {
        // SAFETY：寫一個開著的 fd。
        let n = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if n > 0 {
            bytes = &bytes[n as usize..];
        } else if !(n < 0 && errno() == libc::EINTR) {
            return Err(bytes.len());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::fd::FromRawFd;

    #[test]
    fn finish_writes_what_is_queued_before_eof() {
        let mut fds = [0; 2];
        // SAFETY：拿一對新的 pipe。
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY：兩個 fd 都是剛開的，各交給一個擁有者。
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        set_nonblocking(&write);
        let mut chan = Chan { write: Some(write), read: None, inbox: Vec::new(), outbox: Vec::new(), finishing: false };
        let big = vec![7u8; 256 * 1024];
        chan.send(&big);
        chan.finish();
        assert!(chan.write.is_some(), "pipe 滿了，排著的還沒寫完就關了");

        let mut reader = std::fs::File::from(read);
        let mut got = Vec::new();
        let mut buf = [0u8; 65536];
        loop {
            chan.flush();
            let n = reader.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            got.extend_from_slice(&buf[..n]);
        }
        assert_eq!(got, frame(&big));
        assert!(chan.write.is_none());
    }

    #[test]
    fn stderr_tap_finds_the_heap_line_split_across_reads() {
        let (r, _w) = pipe();
        let mut tap = StderrTap::new(r);
        tap.scan(b"<--- Last few GCs --->\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript he");
        tap.scan(b"ap out of memory\n----- Native stack trace -----\n");
        assert!(tap.heap_message_near_end());

        // 一個位元組一個位元組來，最後一行沒換行也算。
        let (r, _w) = pipe();
        let mut tap = StderrTap::new(r);
        for byte in b"FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory" {
            tap.scan(&[*byte]);
        }
        assert!(tap.heap_message_near_end());
    }

    #[test]
    fn heap_words_in_the_middle_of_a_line_or_long_ago_do_not_count() {
        // 工具輸出被轉印出來，那句話夾在行中間。
        let (r, _w) = pipe();
        let mut tap = StderrTap::new(r);
        tap.scan(b"tool said: FATAL ERROR: x - JavaScript heap out of memory\n");
        assert!(!tap.heap_message_near_end());

        // 真的印過，但之後又寫了超過 HEAP_TAIL 才死。
        let (r, _w) = pipe();
        let mut tap = StderrTap::new(r);
        tap.scan(b"FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n");
        // 那一行的換行加上之後的填充，剛好 HEAP_TAIL 還算。
        tap.scan(&vec![b'x'; HEAP_TAIL as usize - 1]);
        assert!(tap.heap_message_near_end());
        tap.scan(b"y");
        assert!(!tap.heap_message_near_end());

        // 超長的一行就算開頭對也不算。
        let (r, _w) = pipe();
        let mut tap = StderrTap::new(r);
        let mut long = b"FATAL ERROR: ".to_vec();
        long.extend(vec![b'z'; LINE_CAP]);
        long.extend_from_slice(b" JavaScript heap out of memory\n");
        tap.scan(&long);
        assert!(!tap.heap_message_near_end());

        // 標記落在前 LINE_CAP 之內，但整行超長，也不算。
        let (r, _w) = pipe();
        let mut tap = StderrTap::new(r);
        let mut long = b"FATAL ERROR: x - JavaScript heap out of memory ".to_vec();
        long.extend(vec![b'z'; LINE_CAP]);
        long.push(b'\n');
        tap.scan(&long);
        assert!(!tap.heap_message_near_end());
    }

    fn pipe() -> (OwnedFd, OwnedFd) {
        let mut fds = [0; 2];
        // SAFETY：拿一對新的 pipe。
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        // SAFETY：兩個 fd 都是剛開的，各交給一個擁有者。
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }
}
