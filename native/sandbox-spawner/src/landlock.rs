//! Landlock：每個子行程在 exec 之前各自上一份，讀根與寫根由 Node 在每次要求裡帶來。
//!
//! 等級的判法同 dsh 的 launcher：要的 ABI 上限是 5；核心支援的版本比 5 舊就是 partial（照跑、由 Node 印通知），
//! 核心根本不支援就是 none（spawner 不啟動，回 `SANDBOX_UNAVAILABLE`）。管的範圍比 dsh 多了 TCP（ABI 4 起）：
//! 沒有任何 TCP 規則，等於 bind、connect 都不准。

use landlock::{
    Access, AccessFs, AccessNet, BitFlags, CompatLevel, Compatible, PathBeneath, PathFd, Ruleset, RulesetAttr,
    RulesetCreatedAttr, ABI,
};
use std::ffi::OsStr;
use std::os::unix::ffi::OsStrExt;

/// 一個授權路徑的規則。不是目錄的路徑只留檔案用得到的權限（同 dsh launcher `main.c:206-209`），`/dev/null` 靠這個成立。
/// 打不開就回錯：crate 的 `path_beneath_rules` 會默默跳過打不開的路徑，那等於縮小授權，所以不用它。
fn rule(path: &[u8], access: BitFlags<AccessFs>, abi: ABI) -> Result<PathBeneath<PathFd>, String> {
    let path = OsStr::from_bytes(path);
    let fd = PathFd::new(path).map_err(|e| format!("打不開授權路徑 {}: {e}", path.to_string_lossy()))?;
    let is_dir = std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false);
    let access = if is_dir { access } else { access & AccessFs::from_file(abi) };
    Ok(PathBeneath::new(fd, access))
}

/// 要的 ABI 上限。
pub const WANTED_ABI: i32 = 5;

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
        1 => ABI::V1,
        2 => ABI::V2,
        3 => ABI::V3,
        4 => ABI::V4,
        _ => ABI::V5,
    }
}

/// 對目前的行程上 Landlock。`abi` 必須 ≥ 1（none 的情形 spawner 根本不會啟動）。
///
/// 有任何一個授權路徑打不開就整個失敗，同 dsh launcher（`main.c:195-201`）：不默默縮小授權。
pub fn restrict_self(abi: i32, readable: &[Vec<u8>], writable: &[Vec<u8>]) -> Result<(), String> {
    let abi = abi_of(abi);
    let mut ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(abi))
        .map_err(|e| e.to_string())?;
    if abi >= ABI::V4 {
        ruleset = ruleset.handle_access(AccessNet::from_all(abi)).map_err(|e| e.to_string())?;
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
        assert_eq!(effective_abi(6, None), 5);
        assert_eq!(effective_abi(4, None), 4);
        assert_eq!(effective_abi(0, None), 0);
        assert_eq!(effective_abi(6, Some(3)), 3);
        assert_eq!(effective_abi(2, Some(3)), 2);
    }
}
