//! 受管憑證檔：跑 TS 也在跑的 `credentials-vectors.json`（`apps/harness/src/credentials-vectors.test.ts`），再測 [`Store`] 的重讀與續用上一份。
//! 只用暫存檔，不讀真的 home 或 `.env`。

#![cfg(unix)]

use nexus_host::credentials::{parse, Store, DOCUMENT_VERSION};
use serde_json::Value;
use std::cell::RefCell;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::rc::Rc;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../credentials-vectors.json");
    let text = std::fs::read_to_string(path).expect("讀樣本檔");
    serde_json::from_str(&text).expect("樣本檔是 JSON")
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .expect("陣列")
        .iter()
        .map(|v| v.as_str().expect("字串").to_string())
        .collect()
}

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nexus-credentials-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("建暫存資料夾");
    dir
}

/// 先刪再寫：上一筆可能把檔改成擁有者也不能寫。
fn write(path: &PathBuf, text: &str, mode: u32) {
    let _ = std::fs::remove_file(path);
    std::fs::write(path, text).expect("寫檔");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod");
}

type Warnings = Rc<RefCell<Vec<String>>>;

fn store(path: PathBuf) -> (Store, Warnings) {
    let warnings: Warnings = Rc::default();
    let sink = Rc::clone(&warnings);
    (
        Store::new(
            path,
            Box::new(move |line| sink.borrow_mut().push(line.to_string())),
        ),
        warnings,
    )
}

#[test]
fn 文件版本跟樣本檔一致() {
    assert_eq!(
        vectors()["documentVersion"].as_f64(),
        Some(DOCUMENT_VERSION)
    );
}

#[test]
fn 合法樣本() {
    let all = vectors();
    let accept = all["accept"].as_array().expect("accept");
    assert!(!accept.is_empty());
    for vector in accept {
        let name = vector["name"].as_str().expect("name");
        let parsed = parse(vector["text"].as_str().expect("text"))
            .unwrap_or_else(|err| panic!("{name}：不該拒絕，卻是 {}（{err}）", err.reason.code()));
        let refs: Vec<(String, String)> = vector["refs"]
            .as_array()
            .expect("refs")
            .iter()
            .map(|pair| {
                let pair = strings(pair);
                (pair[0].clone(), pair[1].clone())
            })
            .collect();
        assert_eq!(parsed.refs, refs, "{name}");
        assert_eq!(
            parsed.ignored_keys,
            strings(&vector["ignoredKeys"]),
            "{name}"
        );
    }
}

#[test]
fn 不合法樣本() {
    let all = vectors();
    let reject = all["reject"].as_array().expect("reject");
    assert!(!reject.is_empty());
    for vector in reject {
        let name = vector["name"].as_str().expect("name");
        let Err(err) = parse(vector["text"].as_str().expect("text")) else {
            panic!("{name}：該拒絕卻收了");
        };
        assert_eq!(
            err.reason.code(),
            vector["reason"].as_str().expect("reason"),
            "{name}：{err}"
        );
        if let Some(code) = vector["code"].as_str() {
            assert!(
                err.why.starts_with(&format!("YAML 錯誤 {code}")),
                "{name}：{err}"
            );
        }
        if let Some(secret) = vector["secret"].as_str() {
            assert!(!err.why.contains(secret), "{name}：訊息含值");
        }
    }
}

#[test]
fn 權限位元() {
    let dir = temp_dir("modes");
    let file = dir.join(".credentials.yaml");
    for vector in vectors()["modes"].as_array().expect("modes") {
        let mode = u32::from_str_radix(vector["mode"].as_str().expect("mode"), 8).expect("八進位");
        write(&file, "version: 1\nrefs:\n  A: FAKE-mode\n", mode);
        let (mut credentials, _) = store(file.clone());
        let result = credentials.refs().map(<[_]>::to_vec);
        if vector["accept"].as_bool().expect("accept") {
            assert_eq!(
                result,
                Ok(vec![("A".to_string(), "FAKE-mode".to_string())]),
                "{mode:o}"
            );
        } else {
            let why = result.expect_err("該拒絕");
            assert!(
                why.contains(&format!("chmod 600 {}", file.display())),
                "{mode:o}：{why}"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 檔案不存在是沒有憑證() {
    let dir = temp_dir("missing");
    let (mut credentials, warnings) = store(dir.join(".credentials.yaml"));
    assert_eq!(credentials.refs().map(<[_]>::len), Ok(0));
    assert!(warnings.borrow().is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 第一次就壞是錯誤且不含值() {
    let dir = temp_dir("first-bad");
    let file = dir.join(".credentials.yaml");
    write(
        &file,
        "version: 1\nrefs:\n  A: !!str nvapi-FAKE-first\n",
        0o600,
    );
    let (mut credentials, _) = store(file);
    let why = credentials.refs().expect_err("該拒絕");
    assert!(why.contains("TAG_NOT_ALLOWED"), "{why}");
    assert!(!why.contains("nvapi-FAKE-first"), "{why}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 變了才重讀_壞了續用上一份且同一個原因只講一次() {
    let dir = temp_dir("reload");
    let file = dir.join(".credentials.yaml");
    write(&file, "version: 1\nrefs:\n  A: FAKE-one\n", 0o600);
    let (mut credentials, warnings) = store(file.clone());
    let one = vec![("A".to_string(), "FAKE-one".to_string())];
    assert_eq!(credentials.refs().map(<[_]>::to_vec), Ok(one.clone()));

    // 大小不同，簽章一定變。
    write(&file, "version: 1\nrefs:\n  A: FAKE-second\n", 0o600);
    let two = vec![("A".to_string(), "FAKE-second".to_string())];
    assert_eq!(credentials.refs().map(<[_]>::to_vec), Ok(two.clone()));

    write(
        &file,
        "version: 1\nrefs:\n  A: [nvapi-FAKE-broken]\n",
        0o600,
    );
    assert_eq!(credentials.refs().map(<[_]>::to_vec), Ok(two.clone()));
    assert_eq!(credentials.refs().map(<[_]>::to_vec), Ok(two.clone()));
    {
        let seen = warnings.borrow();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert!(seen[0].contains("繼續用上一份"), "{}", seen[0]);
        assert!(!seen[0].contains("nvapi-FAKE-broken"), "{}", seen[0]);
    }

    write(&file, "version: 1\nrefs:\n  A: FAKE-one\n", 0o640);
    assert_eq!(credentials.refs().map(<[_]>::to_vec), Ok(two.clone()));
    assert_eq!(warnings.borrow().len(), 2);
    assert!(warnings.borrow()[1].contains("chmod 600"));

    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("chmod");
    assert_eq!(credentials.refs().map(<[_]>::to_vec), Ok(one));
    assert_eq!(warnings.borrow().len(), 2);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn 不認得的頂層鍵只講個數與行號() {
    let dir = temp_dir("ignored");
    let file = dir.join(".credentials.yaml");
    write(
        &file,
        "version: 1\nnvapi-FAKE-keyname: x\nrefs:\n  A: v\n",
        0o600,
    );
    let (mut credentials, warnings) = store(file);
    assert_eq!(credentials.refs().map(<[_]>::len), Ok(1));
    let seen = warnings.borrow();
    assert_eq!(seen.len(), 1);
    assert!(
        seen[0].contains("1 個不認得的頂層鍵（第 2 行）"),
        "{}",
        seen[0]
    );
    assert!(!seen[0].contains("nvapi-FAKE-keyname"), "{}", seen[0]);
    drop(seen);
    let _ = std::fs::remove_dir_all(&dir);
}

/// `? ` 每層只多兩個字元，不像區塊縮排那樣越深越長，幾百 KB 就能套到幾十萬層。堆疊釘在 2 MiB，是 Rust 目前在 Tier-1 平台開新 thread 的預設值；`stack_size` 蓋過 `RUST_MIN_STACK`，結果不受環境變數影響。
#[test]
fn 極深的顯式鍵回錯而不是爆堆疊() {
    let text = format!("{}x\n", "? ".repeat(200_000));
    let why = std::thread::Builder::new()
        .stack_size(2 << 20)
        .spawn(move || parse(&text).expect_err("該拒絕").why)
        .expect("開 thread")
        .join()
        .expect("thread 正常結束");
    assert_eq!(
        why,
        "YAML 錯誤 NESTING_TOO_DEEP（mapping 與序列最多 64 層）"
    );
}

/// 位置跟 TS 一字不差：集合鍵指到它的開頭，檔頭的 BOM 算在第 1 行的欄裡，BMP 以外的字元算一欄。
#[test]
fn 位置跟_ts_一字不差() {
    for (text, why) in [
        (
            "version: 1\n?\n  nvapi-FAKE-pos: 1\n: x\n",
            "YAML 錯誤 EXPLICIT_KEY_NOT_ALLOWED（第 2 行第 1 欄）",
        ),
        (
            "version: 1\nrefs:\n  A: x\n  ? nvapi-FAKE-pos\n  : 1\n",
            "YAML 錯誤 EXPLICIT_KEY_NOT_ALLOWED（第 4 行第 3 欄）",
        ),
        (
            "version: 1\nx: {a: 1, ? b : 2}\n",
            "YAML 錯誤 EXPLICIT_KEY_NOT_ALLOWED（第 2 行第 11 欄）",
        ),
        (
            "version: 1\nrefs:\n  A: nvapi-FAKE-pos\n  : x\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 4 行第 3 欄）",
        ),
        (
            "version: 1\n\"\": x\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 2 行第 1 欄）",
        ),
        (
            "version: 1\nx: { : y }\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 2 行第 6 欄）",
        ),
        (
            "\u{FEFF}: x\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 1 行第 2 欄）",
        ),
        (
            "version: 1\n\"\": 1\n? a\n: 2\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 2 行第 1 欄）",
        ),
        (
            "version: 1\nrefs:\n  A: x\n  [nvapi-FAKE-pos]: 1\n",
            "YAML 錯誤 COLLECTION_KEY_NOT_ALLOWED（第 4 行第 3 欄）",
        ),
        (
            "\u{FEFF}[nvapi-FAKE-pos]: 1\n",
            "YAML 錯誤 COLLECTION_KEY_NOT_ALLOWED（第 1 行第 2 欄）",
        ),
        (
            "\u{FEFF}%YAML 1.2\n---\nversion: 1\n",
            "YAML 錯誤 DIRECTIVE_NOT_ALLOWED（第 1 行第 2 欄）",
        ),
        (
            "\u{FEFF}!!map\nversion: 1\n",
            "YAML 錯誤 TAG_NOT_ALLOWED（第 1 行第 2 欄）",
        ),
        (
            "version: 1\nnote: 😀\0\n",
            "YAML 錯誤 CHARACTER_NOT_ALLOWED（第 2 行第 8 欄）",
        ),
        (
            "x: [😀, !!str a]\n",
            "YAML 錯誤 TAG_NOT_ALLOWED（第 1 行第 8 欄）",
        ),
        (
            "x: {😀: 1, [a]: 2}\n",
            "YAML 錯誤 COLLECTION_KEY_NOT_ALLOWED（第 1 行第 11 欄）",
        ),
        (
            "{😀: 1, a: 1, a: 2}\n",
            "YAML 錯誤 DUPLICATE_KEY（第 1 行第 14 欄）",
        ),
        (
            &format!("version: 1\nnote: {}{}\n", "[".repeat(300), "]".repeat(300)),
            "YAML 錯誤 NESTING_TOO_DEEP（mapping 與序列最多 64 層）",
        ),
    ] {
        let err = parse(text).expect_err(text);
        assert_eq!(err.why, why, "{text:?}");
    }
}

/// 沒寫鍵的 `:` 後面同一行接區塊集合：TS 的 `yaml` 自己報語法錯（`BLOCK_AS_IMPLICIT_KEY`、`UNEXPECTED_TOKEN`），
/// `saphyr-parser` 照收成「空鍵加值」，這裡走到空鍵（或顯式鍵）那一步。共用樣本只釘 `reason`，錯誤碼各自釘在這裡與
/// `apps/harness/src/credentials.test.ts`；已知差異，見 `docs/credentials-file.md`〈拒絕〉。
#[test]
fn 沒寫鍵的冒號後面接區塊集合_錯誤碼跟_ts_不同() {
    for (text, why) in [
        (
            "version: 1\nrefs:\n  A: nvapi-FAKE-0110\n: : x\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 4 行第 1 欄）",
        ),
        (
            ": : x\nversion: 1\nrefs:\n  A: nvapi-FAKE-0111\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 1 行第 1 欄）",
        ),
        (
            "version: 1\n: - x\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 2 行第 1 欄）",
        ),
        (
            "version: 1\nrefs:\n  A: nvapi-FAKE-0112\n  : - x\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 4 行第 3 欄）",
        ),
        (
            "version: 1\nextra:\n  - : : x\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 3 行第 5 欄）",
        ),
        (
            "version: 1\n? : - x\n: 1\n",
            "YAML 錯誤 EXPLICIT_KEY_NOT_ALLOWED（第 2 行第 1 欄）",
        ),
        (
            "version: 1\n: ? x\n",
            "YAML 錯誤 EMPTY_KEY_NOT_ALLOWED（第 2 行第 1 欄）",
        ),
    ] {
        let err = parse(text).expect_err(text);
        assert_eq!(err.why, why, "{text:?}");
        assert!(!err.why.contains("nvapi-FAKE"), "{text:?}：訊息含值");
    }
}
