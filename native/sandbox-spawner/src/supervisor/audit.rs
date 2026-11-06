//! 稽核紀錄：每個行程結束寫一行 JSON，只追加。檔案以 `O_APPEND` 開，一行一次 `write`。

use crate::supervisor_protocol::DeathCause;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 一個行程怎麼結束的：結束碼與訊號只會有一個；沒起成兩個都沒有。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl Exit {
    pub const NOT_STARTED: Exit = Exit { code: None, signal: None };

    /// 從 `waitpid` 的狀態字。
    pub fn from_status(status: libc::c_int) -> Exit {
        if libc::WIFEXITED(status) {
            Exit { code: Some(libc::WEXITSTATUS(status)), signal: None }
        } else if libc::WIFSIGNALED(status) {
            Exit { code: None, signal: Some(libc::WTERMSIG(status)) }
        } else {
            Exit::NOT_STARTED
        }
    }
}

pub enum Record<'a> {
    Conversation { thread: &'a [u8], pid: i32, cause: DeathCause, exit: Exit, turns: u32, error: Option<&'a str> },
    Front { pid: i32, exit: Exit, error: Option<&'a str> },
}

pub fn cause_name(cause: DeathCause) -> &'static str {
    match cause {
        DeathCause::Heap => "heap",
        DeathCause::Memory => "memory",
        DeathCause::HostOom => "host-oom",
        DeathCause::Stalled => "stalled",
        DeathCause::Crash => "crash",
        DeathCause::Evicted => "evicted",
        DeathCause::Shutdown => "shutdown",
    }
}

pub struct Audit {
    file: File,
}

impl Audit {
    /// 開不了就回錯：沒有稽核紀錄就不起。
    pub fn open(path: &Path) -> std::io::Result<Audit> {
        let file = OpenOptions::new().append(true).create(true).mode(0o600).open(path)?;
        Ok(Audit { file })
    }

    /// 寫不進去只往 stderr 講，不停下監督行程。
    pub fn record(&mut self, record: &Record<'_>) {
        let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
        let line = line(ms, record);
        if let Err(err) = self.file.write_all(line.as_bytes()) {
            eprintln!("[nexus-supervisor] 稽核紀錄寫不進去：{err}；那一行是 {}", line.trim_end());
        }
    }
}

fn line(ts_ms: u128, record: &Record<'_>) -> String {
    let mut out = format!("{{\"ts_ms\":{ts_ms}");
    let (exit, error) = match record {
        Record::Conversation { thread, pid, cause, exit, turns, error } => {
            out.push_str(",\"role\":\"conversation\",\"thread\":");
            json_string(&mut out, &String::from_utf8_lossy(thread));
            out.push_str(&format!(",\"pid\":{pid},\"cause\":\"{}\",\"turns\":{turns}", cause_name(*cause)));
            (exit, error)
        }
        Record::Front { pid, exit, error } => {
            out.push_str(&format!(",\"role\":\"front\",\"pid\":{pid}"));
            (exit, error)
        }
    };
    out.push_str(&format!(",\"exit_code\":{},\"signal\":{}", json_number(exit.code), json_number(exit.signal)));
    if let Some(error) = error {
        out.push_str(",\"error\":");
        json_string(&mut out, error);
    }
    out.push_str("}\n");
    out
}

fn json_number(value: Option<i32>) -> String {
    value.map_or_else(|| "null".to_string(), |v| v.to_string())
}

fn json_string(out: &mut String, value: &str) {
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_line() {
        let record = Record::Conversation {
            thread: b"t\"1\\\n\x01\xff",
            pid: 42,
            cause: DeathCause::Crash,
            exit: Exit { code: Some(3), signal: None },
            turns: 2,
            error: None,
        };
        assert_eq!(
            line(7, &record),
            "{\"ts_ms\":7,\"role\":\"conversation\",\"thread\":\"t\\\"1\\\\\\u000a\\u0001\u{fffd}\",\"pid\":42,\
\"cause\":\"crash\",\"turns\":2,\"exit_code\":3,\"signal\":null}\n"
        );
    }

    #[test]
    fn front_line_with_error() {
        let record = Record::Front { pid: 0, exit: Exit::NOT_STARTED, error: Some("ENOENT") };
        assert_eq!(
            line(1, &record),
            "{\"ts_ms\":1,\"role\":\"front\",\"pid\":0,\"exit_code\":null,\"signal\":null,\"error\":\"ENOENT\"}\n"
        );
    }

    #[test]
    fn every_cause_has_a_distinct_name() {
        let names: std::collections::HashSet<_> = (1..=7).map(|c| cause_name(DeathCause::from_u8(c).unwrap())).collect();
        assert_eq!(names.len(), 7);
    }

    #[test]
    fn exit_from_status() {
        assert_eq!(Exit::from_status(3 << 8), Exit { code: Some(3), signal: None });
        assert_eq!(Exit::from_status(libc::SIGKILL), Exit { code: None, signal: Some(libc::SIGKILL) });
    }
}
