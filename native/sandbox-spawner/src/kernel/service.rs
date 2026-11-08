//! 服務：以名稱登記、以型別取用；以及插件宣告依賴時用的 semver 範圍。
//!
//! 服務表全樹只有一份，同一個名字同一時間只能有一個提供者（隔離見 #2598，還沒做）；不同型別可以用同一個 `NAME`。取用時同時核名稱與 [`TypeId`]：
//! 名稱對、型別不對回 [`KernelError::TypeMismatch`]，不會拿錯型別的值。

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::fmt;

use super::{FiberId, KernelError};

/// 可以登記進樹的服務。`NAME` 是插件 `inject` 宣告時用的名字。
pub trait Service: Any {
    const NAME: &'static str;
}

/// 插件對一個服務的依賴宣告。`range` 是 semver 範圍，掛載時解析，不合法就拒絕那一列；`None` 是不限版本。
/// 有寫範圍（`"*"` 也算）時，沒有版本的提供者一律不符合。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Inject {
    pub name: &'static str,
    pub range: Option<&'static str>,
}

impl Inject {
    pub const fn new(name: &'static str) -> Inject {
        Inject { name, range: None }
    }

    pub const fn with_range(name: &'static str, range: &'static str) -> Inject {
        Inject { name, range: Some(range) }
    }
}

/// 一次 provide 的實體。`uid` 每次 provide 都不同，依賴它的 fiber 用它算 epoch：提供者換手，epoch 就跟著變。
pub(crate) struct Impl {
    pub name: &'static str,
    pub type_id: TypeId,
    pub value: Box<dyn Any>,
    pub owner: FiberId,
    pub version: Option<Version>,
    /// 目前 committed 了這個實體的 fiber。不是空的，提供者就不能收掉自己的 effect。
    pub dependents: Vec<FiberId>,
}

#[derive(Default)]
pub(crate) struct Store {
    impls: HashMap<u64, Impl>,
    by_name: HashMap<&'static str, u64>,
    next_uid: u64,
}

impl Store {
    /// 登記一個實體，回它的 uid；同名已經有人提供時回那一個的 uid。
    pub fn insert(&mut self, imp: Impl) -> Result<u64, u64> {
        if let Some(&uid) = self.by_name.get(imp.name) {
            return Err(uid);
        }
        self.next_uid += 1;
        let uid = self.next_uid;
        self.by_name.insert(imp.name, uid);
        self.impls.insert(uid, imp);
        Ok(uid)
    }

    pub fn remove(&mut self, uid: u64) -> Option<Impl> {
        let removed = self.impls.remove(&uid)?;
        if self.by_name.get(removed.name) == Some(&uid) {
            self.by_name.remove(removed.name);
        }
        Some(removed)
    }

    pub fn uid_of(&self, name: &str) -> Option<u64> {
        self.by_name.get(name).copied()
    }

    pub fn get(&self, uid: u64) -> Option<&Impl> {
        self.impls.get(&uid)
    }

    pub fn get_mut(&mut self, uid: u64) -> Option<&mut Impl> {
        self.impls.get_mut(&uid)
    }
}

/// 把實體的值轉成 `S`；型別對不上回錯，不 panic。
pub(crate) fn downcast<S: Service>(imp: &Impl) -> Result<&S, KernelError> {
    if imp.type_id != TypeId::of::<S>() {
        return Err(KernelError::TypeMismatch { service: S::NAME });
    }
    imp.value.downcast_ref::<S>().ok_or(KernelError::TypeMismatch { service: S::NAME })
}

pub(crate) fn downcast_mut<S: Service>(imp: &mut Impl) -> Result<&mut S, KernelError> {
    if imp.type_id != TypeId::of::<S>() {
        return Err(KernelError::TypeMismatch { service: S::NAME });
    }
    imp.value.downcast_mut::<S>().ok_or(KernelError::TypeMismatch { service: S::NAME })
}

/// `主.次.修`，三段都是十進位整數，不帶前導 0。不收 pre-release 與 build metadata：契約檢查只比這三段。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemverError(pub String);

impl fmt::Display for SemverError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Version {
    pub fn parse(text: &str) -> Result<Version, SemverError> {
        let bad = || SemverError(format!("版本「{text}」不是「主.次.修」"));
        let parts: Vec<&str> = text.split('.').collect();
        if parts.len() != 3 {
            return Err(bad());
        }
        let mut nums = [0u64; 3];
        for (slot, part) in nums.iter_mut().zip(&parts) {
            if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) {
                return Err(bad());
            }
            *slot = part.parse().map_err(|_| bad())?;
        }
        Ok(Version { major: nums[0], minor: nums[1], patch: nums[2] })
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// 收得下的範圍寫法：`*`、`1.2.3`（完全相等）、`^1.2.3`、`~1.2.3`、`>=1.2.3`。`^` 與 `~` 的意思同 npm。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Range {
    Any,
    Exact(Version),
    Caret(Version),
    Tilde(Version),
    AtLeast(Version),
}

impl Range {
    pub fn parse(text: &str) -> Result<Range, SemverError> {
        let text = text.trim();
        if text == "*" {
            return Ok(Range::Any);
        }
        if let Some(rest) = text.strip_prefix(">=") {
            return Ok(Range::AtLeast(Version::parse(rest)?));
        }
        if let Some(rest) = text.strip_prefix('^') {
            return Ok(Range::Caret(Version::parse(rest)?));
        }
        if let Some(rest) = text.strip_prefix('~') {
            return Ok(Range::Tilde(Version::parse(rest)?));
        }
        Ok(Range::Exact(Version::parse(text)?))
    }

    pub fn satisfies(&self, v: Version) -> bool {
        match *self {
            Range::Any => true,
            Range::Exact(want) => v == want,
            Range::AtLeast(want) => v >= want,
            Range::Tilde(want) => v.major == want.major && v.minor == want.minor && v >= want,
            Range::Caret(want) => {
                if v < want {
                    false
                } else if want.major > 0 {
                    v.major == want.major
                } else if want.minor > 0 {
                    v.major == 0 && v.minor == want.minor
                } else {
                    v == want
                }
            }
        }
    }
}
