//! Landlock：每個子行程（單次模式是自己）在 exec 之前各自上一份，讀根與寫根由 Node 在每次要求裡帶來。
//!
//! 要的 ABI 上限是 6；核心支援的版本比 6 舊就是 partial（照跑，`Started` 帶 `partial`），核心根本不支援就是 none
//! （只有全權模式起得來，其餘回 `SandboxUnavailable`）。ABI 4 起也管 TCP：沒有任何 TCP 規則，等於 bind、connect 都不准。
//! ABI 6 起也管訊號：上了 Landlock 的子行程只能對同一個 Landlock domain 裡的行程（自己與自己的後代）送訊號，送不到 spawner、serve
//! 與同一個使用者的其他行程。

use landlock::{
    Access, AccessFs, AccessNet, BitFlags, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset, RulesetAttr,
    RulesetCreatedAttr, Scope, ABI,
};
use std::ffi::OsStr;
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::ffi::OsStrExt;

/// 一個授權路徑的規則。不是目錄的路徑只留檔案用得到的權限，`/dev/null` 靠這個成立。是不是目錄，用 fstat 看同一個已開的 fd：
/// 路徑在開檔與判斷之間被換掉，也不會放寬權限。
/// 打不開就回錯：crate 的 `path_beneath_rules` 會默默跳過打不開的路徑，那等於縮小授權，所以不用它。
fn rule(path: &[u8], access: BitFlags<AccessFs>, abi: ABI) -> Result<PathBeneath<PathFd>, String> {
    let path = OsStr::from_bytes(path);
    let fd = PathFd::new(path).map_err(|e| format!("打不開授權路徑 {}: {e}", path.to_string_lossy()))?;
    // SAFETY：fstat 寫進本地結構，fd 由 PathFd 持有。
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.as_fd().as_raw_fd(), &mut st) } != 0 {
        return Err(format!("fstat {}: {}", path.to_string_lossy(), std::io::Error::last_os_error()));
    }
    let is_dir = st.st_mode & libc::S_IFMT == libc::S_IFDIR;
    let access = if is_dir { access } else { access & AccessFs::from_file(abi) };
    Ok(PathBeneath::new(fd, access))
}

/// 要的 ABI 上限。
pub const WANTED_ABI: i32 = 6;

/// 核心支援的 Landlock ABI 版本；不支援（`ENOSYS`、`EOPNOTSUPP`）就是 0。
pub fn kernel_abi() -> i32 {
    const LANDLOCK_CREATE_RULESET_VERSION: libc::c_uint = 1;
    // SAFETY：查版本只讀旗標，不碰指標。
    let v = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if v < 0 {
        0
    } else {
        v as i32
    }
}

/// 實際要用的版本：核心支援的、上限、測試建置的上限三者取小。
pub fn effective_abi(kernel: i32, test_cap: Option<i32>) -> i32 {
    kernel.min(WANTED_ABI).min(test_cap.unwrap_or(WANTED_ABI))
}

fn abi_of(v: i32) -> ABI {
    match v {
        ..=0 => unreachable!("Landlock ABI {v}：none 不上 Landlock"),
        1 => ABI::V1,
        2 => ABI::V2,
        3 => ABI::V3,
        4 => ABI::V4,
        5 => ABI::V5,
        _ => ABI::V6,
    }
}

/// 對目前的行程上 Landlock。`abi` 必須 ≥ 1。
///
/// 有任何一個授權路徑打不開就整個失敗：不默默縮小授權。
pub fn restrict_self(abi: i32, readable: &[Vec<u8>], writable: &[Vec<u8>]) -> Result<(), String> {
    let abi = abi_of(abi);
    let mut ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(abi))
        .map_err(|e| e.to_string())?;
    if abi >= ABI::V4 {
        ruleset = ruleset.handle_access(AccessNet::from_all(abi)).map_err(|e| e.to_string())?;
    }
    if abi >= ABI::V6 {
        ruleset = ruleset.scope(Scope::Signal).map_err(|e| e.to_string())?;
    }
    let mut rules = Vec::new();
    for path in readable {
        rules.push(rule(path, AccessFs::from_read(abi), abi)?);
    }
    for path in writable.iter().map(Vec::as_slice).chain(std::iter::once(b"/dev/null".as_slice())) {
        rules.push(rule(path, AccessFs::from_all(abi), abi)?);
    }
    ruleset
        .create()
        .and_then(|r| r.add_rules(rules.into_iter().map(Ok::<_, landlock::RulesetError>)))
        .and_then(|r| r.restrict_self())
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effective_abi_takes_the_smallest() {
        assert_eq!(effective_abi(7, None), 6);
        assert_eq!(effective_abi(5, None), 5);
        assert_eq!(effective_abi(0, None), 0);
        assert_eq!(effective_abi(6, Some(3)), 3);
        assert_eq!(effective_abi(2, Some(3)), 2);
    }
}
