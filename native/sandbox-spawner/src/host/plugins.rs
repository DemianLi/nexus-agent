//! `--plugins` 指到的插件清單：讀檔、嚴格解析成內核的 [`Row`]。
//!
//! 檔案是 JSON 陣列，一個元素一列：
//!
//! ```json
//! [{ "name": "<插件名>", "config": { ... }, "disabled": false }]
//! ```
//!
//! - `name` 必填，要是編進這支執行檔的插件（[`specs`]）。
//! - `config` 選填，原封不動交給插件的 `build`：裡面的鍵由插件自己判，判不過是那一列的 `ConfigRejected`，其他列照掛。
//! - `disabled` 選填，只收字面布林。
//! - `intercept` 還沒做（#2596），寫了就整份拒絕；其他不認得的鍵也一樣。
//!
//! 檔案不存在是空樹；讀不了、超過 [`MAX_FILE`]、JSON 壞了或哪一列不合上面的規則，整份拒絕，宿主以設定壞了結束。

use std::io::Read;
use std::path::Path;

use crate::json::{self, Value};
use crate::kernel::{Fields, Row, Spec};

/// 插件清單最大幾個位元組。
pub const MAX_FILE: u64 = 1 << 20;

/// 還沒做的列欄位：寫了就拒絕，指到它的卡。
const INTERCEPT_KEY: &str = "intercept";

/// 編進這支執行檔、`--plugins` 可以用名字指到的插件。出貨的建置沒有任何一支。
pub fn specs() -> &'static [&'static Spec] {
    #[cfg(feature = "test-hooks")]
    static SPECS: &[&Spec] = &[&super::test_plugin::SPEC];
    #[cfg(not(feature = "test-hooks"))]
    static SPECS: &[&Spec] = &[];
    SPECS
}

/// [`load`] 的結果：缺檔跟空陣列分開，宿主才能記「不存在」那一行。
pub enum Loaded {
    Rows(Vec<Row>),
    /// 檔案不存在：空樹。
    Missing,
}

/// 讀 `path` 並解析。回錯時的字串是給人看的一句話，宿主照寫 log 並以設定壞了結束。
pub fn load(path: &Path, specs: &[&'static Spec]) -> Result<Loaded, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Loaded::Missing),
        Err(err) => return Err(format!("讀不了 {}：{err}", path.display())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE + 1).read_to_end(&mut bytes).map_err(|err| format!("讀不了 {}：{err}", path.display()))?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(format!("{} 超過 {MAX_FILE} 位元組", path.display()));
    }
    parse(&bytes, specs).map(Loaded::Rows).map_err(|err| format!("{}：{err}", path.display()))
}

/// 錯在某一列時，回的那句以「第 N 列：」開頭（N 從 1 起）。
pub fn parse(bytes: &[u8], specs: &[&'static Spec]) -> Result<Vec<Row>, String> {
    let value = json::parse(bytes).map_err(|err| format!("不是合法的 JSON（{err}）"))?;
    let Value::Array(items) = value else { return Err("最外層必須是陣列".to_string()) };
    items.iter().enumerate().map(|(i, item)| row(item, specs).map_err(|err| format!("第 {} 列：{err}", i + 1))).collect()
}

fn row(item: &Value, specs: &[&'static Spec]) -> Result<Row, String> {
    if !matches!(item, Value::Object(_)) {
        return Err("必須是物件".to_string());
    }
    if item.get(INTERCEPT_KEY).is_some() {
        return Err(format!(
            "{INTERCEPT_KEY} 還沒做，見 https://github.com/DemianLi/nexus-agent/issues/{}",
            crate::kernel::CARD_LOADER_DIFF
        ));
    }
    let mut fields = Fields::new(item).map_err(|err| err.0)?;
    let name = fields.str("name").map_err(|err| err.0)?;
    let config = fields.value("config").cloned().unwrap_or(Value::Null);
    let disabled = fields.opt_bool("disabled").map_err(|err| err.0)?.unwrap_or(false);
    fields.finish().map_err(|err| err.0)?;
    let spec = specs.iter().find(|spec| spec.name == name).ok_or_else(|| format!("沒有叫 {name} 的插件"))?;
    Ok(Row::Plugin { spec, config, disabled })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kernel::{Applied, ConfigError, Cx, Plugin, PluginError};

    struct Nop;
    impl Plugin for Nop {
        fn apply(&mut self, _cx: &mut Cx<'_>) -> Result<Applied, PluginError> {
            Ok(Applied::Done)
        }
    }

    fn build(_: &Value) -> Result<Box<dyn Plugin>, ConfigError> {
        Ok(Box::new(Nop))
    }

    static A: Spec = Spec { name: "a", inject: &[], required: false, build };
    static SPECS: &[&Spec] = &[&A];

    fn parsed(text: &str) -> Result<Vec<(&'static str, Value, bool)>, String> {
        parse(text.as_bytes(), SPECS).map(|rows| {
            rows.into_iter()
                .map(|row| match row {
                    Row::Plugin { spec, config, disabled } => (spec.name, config, disabled),
                    Row::Group { .. } => unreachable!("清單不產生 group"),
                })
                .collect()
        })
    }

    #[test]
    fn rows_keep_their_config_and_disabled() {
        let rows = parsed(r#"[{"name":"a","config":{"x":1,"不認得":true}},{"name":"a","disabled":true}]"#).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].0, "a");
        assert_eq!(rows[0].1, json::parse(r#"{"x":1,"不認得":true}"#.as_bytes()).unwrap());
        assert!(!rows[0].2);
        assert_eq!(rows[1].1, Value::Null);
        assert!(rows[1].2);
        assert!(parsed("[]").unwrap().is_empty());
    }

    #[test]
    fn intercept_is_refused_with_its_card() {
        let err = parsed(r#"[{"name":"a"},{"name":"a","intercept":{}}]"#).unwrap_err();
        assert!(err.starts_with("第 2 列："), "{err}");
        assert!(err.contains("intercept") && err.contains("/issues/2596"), "{err}");
    }

    #[test]
    fn unknown_row_keys_are_refused() {
        let err = parsed(r#"[{"name":"a","confg":{}}]"#).unwrap_err();
        assert!(err.contains("第 1 列") && err.contains("confg"), "{err}");
    }

    #[test]
    fn malformed_lists_are_refused() {
        for (text, needle) in [
            ("", "JSON"),
            ("{}", "陣列"),
            ("[1]", "物件"),
            (r#"[{}]"#, "name"),
            (r#"[{"name":1}]"#, "name"),
            (r#"[{"name":"b"}]"#, "沒有叫 b"),
            (r#"[{"name":"a","disabled":"yes"}]"#, "disabled"),
            (r#"[{"name":"a","disabled":null,"x":null}]"#, "x"),
        ] {
            let err = parsed(text).unwrap_err();
            assert!(err.contains(needle), "{text}：{err}");
        }
    }

    #[test]
    fn a_missing_file_is_an_empty_tree_and_an_unreadable_one_is_refused() {
        let dir = std::env::temp_dir().join(format!("nexus-host-plugins-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(load(&dir.join("沒有"), SPECS), Ok(Loaded::Missing)));
        let err = load(&dir, SPECS).err().expect("目錄讀不了");
        assert!(err.contains("讀不了"), "{err}");
        let big = dir.join("big.json");
        std::fs::write(&big, vec![b' '; MAX_FILE as usize + 1]).unwrap();
        let err = load(&big, SPECS).err().expect("太大");
        assert!(err.contains("超過"), "{err}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
