//! 受管憑證檔（`<home>/.credentials.yaml`）：宿主自己讀（#2570）。契約在 `docs/credentials-file.md`，兩邊跑同一份樣本
//! `credentials-vectors.json`；TS 的解析器是 `apps/harness/src/credentials.ts`，這裡照它實際跑出的結果做。
//!
//! - [`parse`]：一份文字 → `refs` 與不認得的頂層鍵。YAML 用 `saphyr-parser` 的事件，純量讀成什麼照 `scalar` 子模組。
//! - [`Store`]：讀檔、查權限位元、`stat` 簽章沒變就用快取；讀好過之後壞了續用上一份並警告。
//!
//! **錯誤只帶錯誤碼與位置**：不引原文、不印鍵名與值，因為那一行可能就是秘密。`saphyr-parser` 自己的訊息也不轉出去。

mod scalar;

use std::collections::HashSet;
use std::fmt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use saphyr_parser::{Event, Parser, ScalarStyle, Span};

pub use scalar::{js_number_to_string, Scalar};

/// 這個版本讀得懂的文件版本。
pub const DOCUMENT_VERSION: f64 = 1.0;

/// mapping 與序列加起來最多幾層：根的那一個（mapping 或序列）是第 1 層。超過的整份拒絕（`NESTING_TOO_DEEP`）。
pub const MAX_DEPTH: usize = 64;

/// group 或 other 的任何權限位元。
pub const GROUP_OTHER_BITS: u32 = 0o077;

/// 拒絕的原因，粒度同樣本檔的 `reason`。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    NotMapping,
    Version,
    Records,
    RefsNotMapping,
    BadName,
    NotString,
    EmptyString,
    DuplicateKey,
    Yaml,
}

impl Reason {
    /// 樣本檔裡的寫法。
    pub fn code(self) -> &'static str {
        match self {
            Reason::NotMapping => "not-mapping",
            Reason::Version => "version",
            Reason::Records => "records",
            Reason::RefsNotMapping => "refs-not-mapping",
            Reason::BadName => "bad-name",
            Reason::NotString => "not-string",
            Reason::EmptyString => "empty-string",
            Reason::DuplicateKey => "duplicate-key",
            Reason::Yaml => "yaml",
        }
    }
}

/// 一份內容為什麼不收。`why` 是給人看的那句，只有錯誤碼、行欄與固定的說明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
    pub reason: Reason,
    pub why: String,
}

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.why)
    }
}

/// [`parse`] 的結果。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Parsed {
    /// `refs`：名字與值，照檔案順序。
    pub refs: Vec<(String, String)>,
    /// `version`、`refs` 之外的頂層鍵名，照檔案順序。不擋，呼叫端只講個數與行號。
    pub ignored_keys: Vec<String>,
    /// [`Parsed::ignored_keys`] 各在第幾行（從 1 起），一一對應。
    pub ignored_lines: Vec<usize>,
}

/// 行與欄，都從 1 起；欄以字元計。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Pos {
    index: usize,
    line: usize,
    col: usize,
}

impl Pos {
    fn of(span: Span) -> Pos {
        Pos {
            index: span.start.index(),
            line: span.start.line(),
            col: span.start.col() + 1,
        }
    }
}

impl fmt::Display for Pos {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "第 {} 行第 {} 欄", self.line, self.col)
    }
}

enum Node {
    Scalar { value: Scalar, at: Pos },
    Map { entries: Vec<(Node, Node)> },
    Seq,
    Alias,
}

/// 判重複鍵用的鍵：`yaml` 的 `uniqueKeys` 只比純量的值，`NaN` 不等於任何東西（不進表），`-0` 與 `0` 相等。
#[derive(PartialEq, Eq, Hash)]
enum KeyId {
    Null,
    Bool(bool),
    Number(u64),
    Str(String),
}

fn key_id(value: &Scalar) -> Option<KeyId> {
    Some(match value {
        Scalar::Null => KeyId::Null,
        Scalar::Bool(b) => KeyId::Bool(*b),
        Scalar::Number(n) if n.is_nan() => return None,
        Scalar::Number(n) => KeyId::Number((n + 0.0).to_bits()),
        Scalar::Str(s) => KeyId::Str(s.clone()),
    })
}

enum Frame {
    Map {
        entries: Vec<(Node, Node)>,
        key: Option<Node>,
        seen: HashSet<KeyId>,
    },
    Seq,
}

/// 事件串收成樹時記下的問題：每類記位置最前的那一個，深度記最深的層數。
#[derive(Default)]
struct Findings {
    /// 語法錯（含第二份文件），只會有一個：事件串在那裡停。
    error: Option<(Pos, &'static str)>,
    duplicate: Option<Pos>,
    forbidden: Option<(Pos, &'static str)>,
    collection_key: Option<Pos>,
    depth: usize,
}

impl Findings {
    fn forbid(&mut self, at: Pos, code: &'static str) {
        if self.forbidden.is_none_or(|(first, _)| at < first) {
            self.forbidden = Some((at, code));
        }
    }
}

/// JS `String.prototype.trim` 去掉的字元：WhiteSpace 加 LineTerminator（含 U+FEFF，不含 U+0085）。
fn is_js_trim_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}'..='\u{D}'
            | ' '
            | '\u{A0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200A}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202F}'
            | '\u{205F}'
            | '\u{3000}'
            | '\u{FEFF}'
    )
}

/// 解析之前就拒絕的字元：NUL、tab、不接 LF 的 CR、不在開頭的 U+FEFF。這幾種 `saphyr-parser` 與 TS 的 `yaml` 各自解讀
/// （照收、當換行或當錯），兩邊都在解析前拒絕，同一份檔才會讀出同樣的結果。
fn forbidden_character(text: &str) -> Option<Pos> {
    let (mut line, mut col) = (1, 1);
    let mut chars = text.chars().enumerate().peekable();
    while let Some((index, c)) = chars.next() {
        let bad = match c {
            '\0' | '\t' => true,
            '\r' => chars.peek().is_none_or(|(_, next)| *next != '\n'),
            '\u{FEFF}' => index > 0,
            _ => false,
        };
        if bad {
            return Some(Pos { index, line, col });
        }
        if c == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    None
}

/// 指令只能出現在第一份文件明示的 `---` 之前，一行以 `%` 開頭。`before` 是那個 `---` 之前的原文。
fn directive_in(before: &str) -> Option<Pos> {
    let mut index = 0;
    for (n, line) in before.split_inclusive('\n').enumerate() {
        let body = if n == 0 {
            line.trim_start_matches('\u{FEFF}')
        } else {
            line
        };
        if body.starts_with('%') {
            let skipped = line.chars().count() - body.chars().count();
            return Some(Pos {
                index: index + skipped,
                line: n + 1,
                col: 1 + skipped,
            });
        }
        index += line.chars().count();
    }
    None
}

fn fail<T>(reason: Reason, why: String) -> Result<T, ParseError> {
    Err(ParseError { reason, why })
}

fn yaml_error<T>(code: &str, at: Pos) -> Result<T, ParseError> {
    fail(Reason::Yaml, format!("YAML 錯誤 {code}（{at}）"))
}

/// 事件串收成樹。只收到根；語法錯就停，之前收到的問題照記。
fn build(text: &str, findings: &mut Findings) -> Option<Node> {
    let mut parser = Parser::new_from_str(text);
    let mut stack: Vec<Frame> = Vec::new();
    // 每個還沒關上的集合從哪裡開始：集合鍵的位置指到它的開頭，跟 TS 一樣。
    let mut starts: Vec<Pos> = Vec::new();
    // saphyr 的位置不算檔頭的 BOM，TS 算（第 1 行的欄多 1）：照 TS 補回來。
    let bom = text.starts_with('\u{FEFF}');
    let raw = |mut at: Pos| {
        if bom {
            at.index += 1;
            if at.line == 1 {
                at.col += 1;
            }
        }
        at
    };
    let mut root: Option<Node> = None;
    let mut documents = 0;
    loop {
        let (event, span) = match parser.next_event() {
            None => break,
            Some(Err(err)) => {
                let m = err.marker();
                let at = raw(Pos {
                    index: m.index(),
                    line: m.line(),
                    col: m.col() + 1,
                });
                match err.info() {
                    // flow 的層數在 saphyr 是 u8，超過 255 層就是這個錯；TS 那邊 `yaml` 用光呼叫堆疊也講成太深。
                    "recursion limit exceeded" => findings.error = Some((at, "NESTING_TOO_DEEP")),
                    // 沒有對應錨點的別名：TS 的 `yaml` 不當語法錯，由別名的檢查擋下。
                    "while parsing node, found unknown anchor" => {
                        findings.forbid(at, "ALIAS_NOT_ALLOWED")
                    }
                    _ => findings.error = Some((at, "YAML_SYNTAX")),
                }
                break;
            }
            Some(Ok(pair)) => pair,
        };
        let mut at = raw(Pos::of(span));
        let node = match event {
            Event::StreamStart | Event::DocumentEnd | Event::Nothing => continue,
            Event::StreamEnd => break,
            Event::DocumentStart(explicit) => {
                documents += 1;
                if documents > 1 {
                    findings.error = Some((at, "MULTIPLE_DOCS"));
                    break;
                }
                if explicit {
                    let before: String = text.chars().take(at.index).collect();
                    if let Some(directive) = directive_in(&before) {
                        findings.forbid(directive, "DIRECTIVE_NOT_ALLOWED");
                    }
                }
                continue;
            }
            Event::Alias(_) => {
                findings.forbid(at, "ALIAS_NOT_ALLOWED");
                Node::Alias
            }
            Event::Scalar(value, style, anchor, tag) => {
                if tag.is_some() {
                    findings.forbid(at, "TAG_NOT_ALLOWED");
                }
                if anchor != 0 {
                    findings.forbid(at, "ANCHOR_NOT_ALLOWED");
                }
                let value = if style == ScalarStyle::Plain {
                    Scalar::plain(&value)
                } else {
                    Scalar::Str(value.into_owned())
                };
                Node::Scalar { value, at }
            }
            Event::MappingStart(anchor, ref tag) | Event::SequenceStart(anchor, ref tag) => {
                if tag.is_some() {
                    findings.forbid(at, "TAG_NOT_ALLOWED");
                }
                if anchor != 0 {
                    findings.forbid(at, "ANCHOR_NOT_ALLOWED");
                }
                stack.push(if matches!(event, Event::MappingStart(..)) {
                    Frame::Map {
                        entries: Vec::new(),
                        key: None,
                        seen: HashSet::new(),
                    }
                } else {
                    Frame::Seq
                });
                starts.push(at);
                findings.depth = findings.depth.max(stack.len());
                continue;
            }
            Event::MappingEnd | Event::SequenceEnd => {
                at = starts.pop().unwrap_or(at);
                match stack.pop() {
                    Some(Frame::Map { entries, .. }) => Node::Map { entries },
                    Some(Frame::Seq) | None => Node::Seq,
                }
            }
        };
        match stack.last_mut() {
            None => root = Some(node),
            Some(Frame::Seq) => {}
            Some(Frame::Map { entries, key, seen }) => match key.take() {
                Some(k) => entries.push((k, node)),
                None => {
                    match &node {
                        Node::Scalar { value, at } => {
                            if let Some(id) = key_id(value) {
                                if !seen.insert(id) && findings.duplicate.is_none() {
                                    findings.duplicate = Some(*at);
                                }
                            }
                        }
                        Node::Map { .. } | Node::Seq => {
                            if findings.collection_key.is_none_or(|first| at < first) {
                                findings.collection_key = Some(at);
                            }
                        }
                        Node::Alias => {}
                    }
                    *key = Some(node);
                }
            },
        }
    }
    root
}

/// 一個 mapping 的條目轉成（名字、鍵的位置、值），照檔案順序；換成同一個名字的兩個鍵是 `DUPLICATE_KEY`。
fn named(entries: &[(Node, Node)]) -> Result<Vec<(String, Pos, &Node)>, ParseError> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(entries.len());
    for (key, value) in entries {
        // 集合鍵與別名鍵在前面就拒絕了。
        let Node::Scalar { value: k, at } = key else {
            continue;
        };
        let name = k.key_name();
        if !seen.insert(name.clone()) {
            return fail(
                Reason::DuplicateKey,
                format!("YAML 錯誤 DUPLICATE_KEY（{at}）"),
            );
        }
        out.push((name, *at, value));
    }
    Ok(out)
}

fn is_credential_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn too_deep() -> Result<Parsed, ParseError> {
    fail(
        Reason::Yaml,
        format!("YAML 錯誤 NESTING_TOO_DEEP（mapping 與序列最多 {MAX_DEPTH} 層）"),
    )
}

/// 解析一份受管檔的文字。空檔、只有空白或註解、根是 null、空的 mapping，都是沒有憑證，不要求 `version`。
pub fn parse(text: &str) -> Result<Parsed, ParseError> {
    if text.chars().all(is_js_trim_space) {
        return Ok(Parsed::default());
    }
    if let Some(at) = forbidden_character(text) {
        return yaml_error("CHARACTER_NOT_ALLOWED", at);
    }
    let mut findings = Findings::default();
    let root = build(text, &mut findings);
    // 順序照 TS：YAML 函式庫自己的錯（語法與重複鍵，照位置先後）在前，解析後的 nexus 檢查在後。
    match (findings.error, findings.duplicate) {
        (Some((at, _)), Some(dup)) if dup < at => {
            return fail(
                Reason::DuplicateKey,
                format!("YAML 錯誤 DUPLICATE_KEY（{dup}）"),
            );
        }
        (Some((_, "NESTING_TOO_DEEP")), _) => return too_deep(),
        (Some((at, code)), _) => return yaml_error(code, at),
        (None, Some(dup)) => {
            return fail(
                Reason::DuplicateKey,
                format!("YAML 錯誤 DUPLICATE_KEY（{dup}）"),
            );
        }
        (None, None) => {}
    }
    if findings.depth > MAX_DEPTH {
        return too_deep();
    }
    if let Some((at, code)) = findings.forbidden {
        return yaml_error(code, at);
    }
    if let Some(at) = findings.collection_key {
        return yaml_error("COLLECTION_KEY_NOT_ALLOWED", at);
    }
    let entries = match root {
        None
        | Some(Node::Scalar {
            value: Scalar::Null,
            ..
        }) => return Ok(Parsed::default()),
        Some(Node::Map { entries }) => entries,
        Some(_) => {
            return fail(
                Reason::NotMapping,
                "根要是一個 mapping（version 與 refs）".into(),
            )
        }
    };
    if entries.is_empty() {
        return Ok(Parsed::default());
    }
    let top = named(&entries)?;
    let field = |name: &str| top.iter().find(|(n, _, _)| n == name).map(|(_, _, v)| *v);
    let version_ok = matches!(
        field("version"),
        Some(Node::Scalar { value: Scalar::Number(n), .. }) if *n == DOCUMENT_VERSION
    );
    if !version_ok {
        return fail(
            Reason::Version,
            format!("version 要是 {}", js_number_to_string(DOCUMENT_VERSION)),
        );
    }
    if field("records").is_some() {
        return fail(
            Reason::Records,
            "nexus 沒有 records 這種憑證（只有 refs 底下的 名字: 值）；留著它會讓人以為存進去的東西有作用".into(),
        );
    }
    let refs: &[(Node, Node)] = match field("refs") {
        None
        | Some(Node::Scalar {
            value: Scalar::Null,
            ..
        }) => &[],
        Some(Node::Map { entries }) => entries,
        Some(_) => {
            return fail(
                Reason::RefsNotMapping,
                "refs 要是 mapping（名字: 值）".into(),
            )
        }
    };
    let mut out = Vec::new();
    for (name, at, value) in named(refs)? {
        if !is_credential_name(&name) {
            return fail(
                Reason::BadName,
                format!(
                    "refs {at}的鍵不是環境變數形狀的名字（長 {} 個字元；鍵名不印出，以免誤貼在這裡的 key 進日誌）",
                    name.chars().count()
                ),
            );
        }
        let Node::Scalar {
            value: Scalar::Str(value),
            ..
        } = value
        else {
            return fail(Reason::NotString, format!("refs {at}那一把要是字串"));
        };
        if value.is_empty() {
            return fail(
                Reason::EmptyString,
                format!("refs {at}那一把是空字串（要移除一把憑證就刪掉那一行，不要留空）"),
            );
        }
        out.push((name, value.clone()));
    }
    let ignored: Vec<_> = top
        .iter()
        .filter(|(name, _, _)| name != "version" && name != "refs")
        .collect();
    Ok(Parsed {
        refs: out,
        ignored_keys: ignored.iter().map(|(name, _, _)| name.clone()).collect(),
        ignored_lines: ignored.iter().map(|(_, at, _)| at.line).collect(),
    })
}

/// 權限位元：group 或 other 有任何一個就拒絕。訊息帶 `chmod 600` 那一行。
pub fn check_owner_only(path: &Path, mode: u32) -> Result<(), String> {
    if mode & GROUP_OTHER_BITS == 0 {
        return Ok(());
    }
    Err(format!(
        "受管憑證檔 {} 其他使用者讀得到（mode {:o}）；先跑 chmod 600 {} 再啟動。",
        path.display(),
        mode & 0o777,
        path.display()
    ))
}

/// 讀受管檔。每次 [`Store::refs`] 先 `stat`，簽章（mtime、大小、inode、mode）變了才重讀；檔案不存在是沒有憑證。
/// 還沒讀好過就回錯；讀好過之後壞了續用上一份，經 `warn` 講一次（同一個原因連續只講一次，讀成功就清掉）。
pub struct Store {
    path: PathBuf,
    good: Option<(String, Vec<(String, String)>)>,
    warned: Option<String>,
    warn: Box<dyn FnMut(&str)>,
}

impl Store {
    /// 建構時不碰檔案，第一次 [`Store::refs`] 才 `stat`。`warn` 收到的一行不帶換行。
    pub fn new(path: PathBuf, warn: Box<dyn FnMut(&str)>) -> Store {
        Store {
            path,
            good: None,
            warned: None,
            warn,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 目前的 `refs`。錯誤訊息不含值，也不含鍵名。
    pub fn refs(&mut self) -> Result<&[(String, String)], String> {
        let meta = match std::fs::metadata(&self.path) {
            Ok(meta) => meta,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                self.good = None;
                return Ok(&[]);
            }
            Err(err) => {
                let key = format!("stat:{}", err.raw_os_error().unwrap_or(0));
                let why = format!("讀不了受管憑證檔 {}：{err}", self.path.display());
                return self.keep_last_good(why, key);
            }
        };
        let signature = format!(
            "{}.{}:{}:{}:{}",
            meta.mtime(),
            meta.mtime_nsec(),
            meta.size(),
            meta.ino(),
            meta.mode()
        );
        if self.good.as_ref().is_some_and(|(s, _)| *s == signature) {
            self.warned = None;
            return Ok(self.good.as_ref().map_or(&[], |(_, refs)| refs.as_slice()));
        }
        let parsed = check_owner_only(&self.path, meta.mode()).and_then(|()| {
            let bytes = std::fs::read(&self.path)
                .map_err(|err| format!("讀不了受管憑證檔 {}：{err}", self.path.display()))?;
            parse(&String::from_utf8_lossy(&bytes))
                .map_err(|err| format!("受管憑證檔 {} 認不得：{err}", self.path.display()))
        });
        let parsed = match parsed {
            Ok(parsed) => parsed,
            Err(why) => return self.keep_last_good(why, signature),
        };
        self.warned = None;
        if !parsed.ignored_keys.is_empty() {
            let lines: Vec<String> = parsed.ignored_lines.iter().map(usize::to_string).collect();
            (self.warn)(&format!(
                "credentials: 受管憑證檔 {} 有 {} 個不認得的頂層鍵（第 {} 行），已略過；只有 version 與 refs 底下的憑證會生效",
                self.path.display(),
                parsed.ignored_keys.len(),
                lines.join("、")
            ));
        }
        let refs = &self.good.insert((signature, parsed.refs)).1;
        Ok(refs)
    }

    fn keep_last_good(&mut self, why: String, key: String) -> Result<&[(String, String)], String> {
        if self.good.is_none() {
            return Err(why);
        }
        if self.warned.as_deref() != Some(key.as_str()) {
            (self.warn)(&format!(
                "credentials: 重載失敗，繼續用上一份可用的內容：{why}"
            ));
            self.warned = Some(key);
        }
        Ok(self.good.as_ref().map_or(&[], |(_, refs)| refs.as_slice()))
    }
}
