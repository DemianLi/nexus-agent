//! 插件設定：嚴格解析成 Rust 型別。
//!
//! - 任何一層出現 `__jsExpr` 鍵就整份拒絕，不求值。
//! - [`Fields`] 逐欄取值，`finish` 時還有沒取過的鍵就回錯，值是 `null` 也一樣：打錯的鍵名不會被靜靜忽略。
//! - 值是 `null` 的欄位當成沒寫：`opt_*` 回 `None`，[`merge`] 不拿它蓋掉原值。
//!
//! 解析失敗的那一列不 apply（[`super::KernelEvent::ConfigRejected`]），同一層其他列照掛。

use std::fmt;

use crate::json::Value;

/// 拒絕求值的鍵名。只看鍵名、不看值的型別。
pub const JS_EXPR_KEY: &str = "__jsExpr";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// 整份設定裡任何一層有 `__jsExpr` 鍵就回錯，錯誤指到那個鍵的路徑。
pub fn reject_js_expr(value: &Value) -> Result<(), ConfigError> {
    fn walk(value: &Value, path: &mut Vec<String>) -> Result<(), ConfigError> {
        match value {
            Value::Object(fields) => {
                for (key, child) in fields {
                    path.push(key.clone());
                    if key == JS_EXPR_KEY {
                        return Err(ConfigError(format!(
                            "設定不支援 {JS_EXPR_KEY}（在 {}）",
                            path.join(".")
                        )));
                    }
                    walk(child, path)?;
                    path.pop();
                }
            }
            Value::Array(items) => {
                for (i, child) in items.iter().enumerate() {
                    path.push(i.to_string());
                    walk(child, path)?;
                    path.pop();
                }
            }
            _ => {}
        }
        Ok(())
    }
    walk(value, &mut Vec::new())
}

/// 把 `patch` 疊到 `base` 上：兩邊都是物件就逐鍵遞迴；`patch` 的值是 `null` 時保留 `base` 的值；
/// 其他情形一律以 `patch` 為準（陣列整個換掉，不逐項合併）。
pub fn merge(base: &Value, patch: &Value) -> Value {
    match (base, patch) {
        (_, Value::Null) => base.clone(),
        (Value::Object(old), Value::Object(new)) => {
            let mut out = old.clone();
            for (key, value) in new {
                match out.get_mut(key) {
                    Some(slot) => *slot = merge(slot, value),
                    None if value.is_null() => {}
                    None => {
                        out.insert(key.clone(), value.clone());
                    }
                }
            }
            Value::Object(out)
        }
        _ => patch.clone(),
    }
}

/// 逐欄取設定值。每取一個鍵就記下來，[`Fields::finish`] 檢查有沒有剩下沒人認的鍵。
pub struct Fields<'a> {
    fields: Vec<(&'a str, &'a Value)>,
    used: Vec<bool>,
}

impl<'a> Fields<'a> {
    /// 設定必須是物件；`null` 當成空物件。
    pub fn new(value: &'a Value) -> Result<Fields<'a>, ConfigError> {
        let fields: Vec<(&'a str, &'a Value)> = match value {
            Value::Object(fields) => fields.iter().map(|(k, v)| (k.as_str(), v)).collect(),
            Value::Null => Vec::new(),
            _ => return Err(ConfigError("設定必須是物件".to_string())),
        };
        let used = vec![false; fields.len()];
        Ok(Fields { fields, used })
    }

    /// 這個鍵的值；鍵不存在或值是 `null` 都回 `None`。
    pub fn value(&mut self, key: &str) -> Option<&'a Value> {
        let index = self.fields.iter().position(|(k, _)| *k == key)?;
        self.used[index] = true;
        match self.fields[index].1 {
            Value::Null => None,
            value => Some(value),
        }
    }

    pub fn opt_int(&mut self, key: &str) -> Result<Option<i64>, ConfigError> {
        match self.value(key) {
            None => Ok(None),
            Some(value) if value.is_i64() => Ok(value.as_i64()),
            Some(_) => Err(ConfigError(format!("{key} 必須是整數"))),
        }
    }

    pub fn int(&mut self, key: &str) -> Result<i64, ConfigError> {
        self.opt_int(key)?
            .ok_or_else(|| ConfigError(format!("缺少 {key}")))
    }

    pub fn opt_str(&mut self, key: &str) -> Result<Option<&'a str>, ConfigError> {
        match self.value(key) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s)),
            Some(_) => Err(ConfigError(format!("{key} 必須是字串"))),
        }
    }

    pub fn str(&mut self, key: &str) -> Result<&'a str, ConfigError> {
        self.opt_str(key)?
            .ok_or_else(|| ConfigError(format!("缺少 {key}")))
    }

    pub fn opt_bool(&mut self, key: &str) -> Result<Option<bool>, ConfigError> {
        match self.value(key) {
            None => Ok(None),
            Some(Value::Bool(b)) => Ok(Some(*b)),
            Some(_) => Err(ConfigError(format!("{key} 必須是 true 或 false"))),
        }
    }

    /// 還有沒取過的鍵就回錯，錯誤列出全部。
    pub fn finish(self) -> Result<(), ConfigError> {
        let unknown: Vec<&str> = self
            .fields
            .iter()
            .zip(&self.used)
            .filter(|(_, used)| !**used)
            .map(|((k, _), _)| *k)
            .collect();
        if unknown.is_empty() {
            Ok(())
        } else {
            Err(ConfigError(format!(
                "不認得的設定鍵：{}",
                unknown.join(", ")
            )))
        }
    }
}
