//! 自管道：別的執行緒有東西要交給宿主的單執行緒迴圈時，寫一個位元組叫醒它（[`crate::kernel::Remote::wake_fd`]）。
//!
//! - 兩端都是 `O_CLOEXEC`、非阻塞。
//! - [`Waker::wake`] 不會卡：管道滿了（`EAGAIN`）表示讀端本來就可讀，少寫一個位元組不影響；讀端已經關了（`EPIPE`，Rust 執行檔忽略 SIGPIPE）也照樣回。
//! - 讀端由 [`Wake`] 擁有；寫端由 [`Wake`] 與它發出的每個 [`Waker`] 共用，最後一個放掉才關，所以 `Wake` 活著時讀端讀不到 EOF。讀端先關，`wake` 照樣回。

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::Arc;

/// 讀端（連同發 [`Waker`] 用的一份寫端）：給宿主 poll、由服務讀乾淨。
pub struct Wake {
    read: OwnedFd,
    write: Arc<OwnedFd>,
}

/// 寫端：可以交給別的執行緒。
#[derive(Clone)]
pub struct Waker(Arc<OwnedFd>);

impl Wake {
    pub fn new() -> io::Result<Wake> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: `fds` 是兩個 c_int 的陣列，pipe2 成功時寫進兩個新的 fd。
        if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: 兩個 fd 剛由 pipe2 開出來，這裡是唯一的擁有者。
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        Ok(Wake {
            read,
            write: Arc::new(write),
        })
    }

    pub fn waker(&self) -> Waker {
        Waker(Arc::clone(&self.write))
    }

    /// 讀端的 fd，借出不交出：`Wake` 活著時有效，呼叫方不得 close。
    pub fn fd(&self) -> RawFd {
        self.read.as_raw_fd()
    }

    /// 讀到 `EAGAIN` 為止。
    pub fn drain(&self) {
        let mut buf = [0u8; 256];
        loop {
            // SAFETY: 讀進本地的緩衝，長度就是它的大小。
            let n = unsafe { libc::read(self.fd(), buf.as_mut_ptr().cast(), buf.len()) };
            if n > 0 {
                continue;
            }
            if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
    }
}

impl Waker {
    /// 叫醒讀端。不會卡、不會失敗。
    pub fn wake(&self) {
        loop {
            // SAFETY: 寫一個位元組的本地值。
            let n = unsafe { libc::write(self.0.as_raw_fd(), [1u8].as_ptr().cast(), 1) };
            if n < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn readable(fd: RawFd) -> bool {
        let mut p = libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: 一個 pollfd，不等。
        unsafe { libc::poll(&mut p, 1, 0) == 1 }
    }

    fn flags(fd: RawFd) -> (libc::c_int, libc::c_int) {
        // SAFETY: 只查 fd 的旗標。
        unsafe {
            (
                libc::fcntl(fd, libc::F_GETFD),
                libc::fcntl(fd, libc::F_GETFL),
            )
        }
    }

    #[test]
    fn 兩端都是_cloexec_與非阻塞() {
        let wake = Wake::new().expect("開管道");
        for fd in [wake.fd(), wake.write.as_raw_fd()] {
            let (fd_flags, fl_flags) = flags(fd);
            assert_ne!(fd_flags & libc::FD_CLOEXEC, 0);
            assert_ne!(fl_flags & libc::O_NONBLOCK, 0);
        }
    }

    #[test]
    fn 叫醒之後可讀_讀乾淨就不可讀() {
        let wake = Wake::new().expect("開管道");
        assert!(!readable(wake.fd()));
        wake.waker().wake();
        assert!(readable(wake.fd()));
        wake.drain();
        assert!(!readable(wake.fd()));
    }

    #[test]
    fn 寫滿不卡() {
        let wake = Wake::new().expect("開管道");
        let waker = wake.waker();
        // 管道預設 64 KiB，寫二十萬次一定寫滿。
        for _ in 0..200_000 {
            waker.wake();
        }
        assert!(readable(wake.fd()));
        wake.drain();
        assert!(!readable(wake.fd()));
    }

    #[test]
    fn 讀端先關_寫端照樣回() {
        let wake = Wake::new().expect("開管道");
        let waker = wake.waker();
        drop(wake);
        waker.wake();
        waker.wake();
    }

    #[test]
    fn waker_先放掉_讀端照樣讀得乾淨() {
        let wake = Wake::new().expect("開管道");
        let waker = wake.waker();
        waker.wake();
        drop(waker);
        wake.drain();
    }
}
