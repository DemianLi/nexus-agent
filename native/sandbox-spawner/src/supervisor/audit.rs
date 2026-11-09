//! 稽核紀錄：每個行程結束寫一行 JSON，只追加；宿主回報的違反協定也寫一行（[`Record::Protocol`]，那個行程沒有結束）。
//! 欄位與值只加不改：讀它的人照 `role`（行程結束）或 `event`（事件）分辨每一行。檔案以 `O_APPEND` 開，一行一次 `write`；
//! 短寫（磁碟滿、被訊號打斷）會留下沒有換行的殘行，下一筆先補一個換行，不黏上去。

use crate::supervisor_protocol::DeathCause;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// 一個行程怎麼結束的：結束碼與訊號只會有一個；沒起成兩個都沒有。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl Exit {
    pub const NOT_STARTED: Exit = Exit {
        code: None,
        signal: None,
    };

    /// 從 `waitpid` 的狀態字。
    pub fn from_status(status: libc::c_int) -> Exit {
        if libc::WIFEXITED(status) {
            Exit {
                code: Some(libc::WEXITSTATUS(status)),
                signal: None,
            }
        } else if libc::WIFSIGNALED(status) {
            Exit {
                code: None,
                signal: Some(libc::WTERMSIG(status)),
            }
        } else {
            Exit::NOT_STARTED
        }
    }
}

pub enum Record<'a> {
    Conversation {
        thread: &'a [u8],
        pid: i32,
        cause: DeathCause,
        exit: Exit,
        turns: u32,
        /// 輪詢看到的最高 RSS（kB）；沒量到是 0。
        rss_kb: u64,
        /// 送出 `bind` 起，每次聽到它與上一次（第一次是與送出 `bind`）之間最長隔了多久；最後一次聽到之後到結束的那段不算。
        /// 監督行程判定自己被停住過時，從最後一次聽到到醒來的那段不算。判 `stalled` 之前先讀一次通道而救回來的那一段會算進來，
        /// 所以可能大於等於 `--stall-ms`。沒送過 `bind` 是 0。
        max_silence_ms: u64,
        error: Option<&'a str>,
    },
    Front {
        pid: i32,
        exit: Exit,
        error: Option<&'a str>,
    },
    /// 宿主結束了。`ready`：它結束前送過 `ready` 沒有。
    Host {
        pid: i32,
        exit: Exit,
        ready: bool,
        error: Option<&'a str>,
    },
    /// 宿主斷了一條違反協定的連線（[`crate::supervisor_protocol::HostReport::Violation`]）。`role` 是那個 pid 在身分表上是誰
    /// （不在表上是 `unknown`），`thread` 是它綁的那條（沒有是空的）。
    Protocol {
        pid: i32,
        role: &'a str,
        thread: &'a [u8],
        reason: &'a str,
    },
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
        DeathCause::Protocol => "protocol",
    }
}

pub struct Audit {
    file: File,
    /// 上一筆可能只寫了一半（沒有換行），下一筆先補一個換行，不黏在殘行後面。
    torn: bool,
}

impl Audit {
    /// 開不了就回錯：沒有稽核紀錄就不起。主機多人共用：路徑不能是連結；已存在的要是自己擁有、0600 的一般檔，
    /// 別人不能先建好檔來讀，也不能用連結把紀錄導走。
    pub fn open(path: &Path) -> std::io::Result<Audit> {
        let file = OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        let meta = file.metadata()?;
        // SAFETY：geteuid 不會失敗。
        let me = unsafe { libc::geteuid() };
        if !meta.file_type().is_file() || meta.uid() != me || meta.mode() & 0o777 != 0o600 {
            return Err(std::io::Error::other(format!(
                "{} 要是自己擁有、權限 0600 的一般檔（現在是 uid {}、{:o}）",
                path.display(),
                meta.uid(),
                meta.mode() & 0o7777
            )));
        }
        Ok(Audit { file, torn: false })
    }

    /// 寫不進去只往 stderr 講，不停下監督行程。
    pub fn record(&mut self, record: &Record<'_>) {
        let ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let mut line = line(ms, record);
        if self.torn {
            line.insert(0, '\n');
        }
        match self.file.write_all(line.as_bytes()) {
            Ok(()) => self.torn = false,
            Err(err) => {
                self.torn = true;
                say!("稽核紀錄寫不進去：{err}；那一行是 {}", line.trim());
            }
        }
    }
}

fn line(ts_ms: u128, record: &Record<'_>) -> String {
    let mut out = format!("{{\"ts_ms\":{ts_ms}");
    let (exit, error) = match record {
        Record::Conversation {
            thread,
            pid,
            cause,
            exit,
            turns,
            rss_kb,
            max_silence_ms,
            error,
        } => {
            out.push_str(",\"role\":\"conversation\",\"thread\":");
            json_string(&mut out, &String::from_utf8_lossy(thread));
            out.push_str(&format!(
                ",\"pid\":{pid},\"cause\":\"{}\",\"turns\":{turns},\"rss_kb\":{rss_kb},\"max_silence_ms\":{max_silence_ms}",
                cause_name(*cause)
            ));
            (exit, error)
        }
        Record::Front { pid, exit, error } => {
            out.push_str(&format!(",\"role\":\"front\",\"pid\":{pid}"));
            (exit, error)
        }
        Record::Host {
            pid,
            exit,
            ready,
            error,
        } => {
            out.push_str(&format!(
                ",\"role\":\"host\",\"pid\":{pid},\"ready\":{ready}"
            ));
            (exit, error)
        }
        Record::Protocol {
            pid,
            role,
            thread,
            reason,
        } => {
            out.push_str(&format!(",\"event\":\"protocol\",\"pid\":{pid},\"role\":"));
            json_string(&mut out, role);
            out.push_str(",\"thread\":");
            json_string(&mut out, &String::from_utf8_lossy(thread));
            out.push_str(",\"reason\":");
            json_string(&mut out, reason);
            out.push_str("}\n");
            return out;
        }
    };
    out.push_str(&format!(
        ",\"exit_code\":{},\"signal\":{}",
        json_number(exit.code),
        json_number(exit.signal)
    ));
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
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                out.push_str(&format!("\\u{:04x}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_after_a_failed_write_starts_on_its_own_line() {
        let record = Record::Front {
            pid: 1,
            exit: Exit::NOT_STARTED,
            error: None,
        };
        let mut audit = Audit {
            file: OpenOptions::new().append(true).open("/dev/full").unwrap(),
            torn: false,
        };
        audit.record(&record);
        assert!(audit.torn);
        let path = std::env::temp_dir().join(format!("nsup-unit-torn-{}", std::process::id()));
        std::fs::write(&path, "{\"ts_ms\":1,\"ro").unwrap();
        audit.file = OpenOptions::new().append(true).open(&path).unwrap();
        audit.record(&record);
        audit.record(&record);
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 3, "{text}");
        assert_eq!(lines[0], "{\"ts_ms\":1,\"ro");
        assert!(
            lines[1].starts_with("{\"ts_ms\":") && lines[2].starts_with("{\"ts_ms\":"),
            "{text}"
        );
        assert!(!audit.torn);
    }

    #[test]
    fn conversation_line() {
        let record = Record::Conversation {
            thread: b"t\"1\\\n\x01\xff",
            pid: 42,
            cause: DeathCause::Crash,
            exit: Exit {
                code: Some(3),
                signal: None,
            },
            turns: 2,
            rss_kb: 81920,
            max_silence_ms: 5012,
            error: None,
        };
        assert_eq!(
            line(7, &record),
            "{\"ts_ms\":7,\"role\":\"conversation\",\"thread\":\"t\\\"1\\\\\\u000a\\u0001\u{fffd}\",\"pid\":42,\
\"cause\":\"crash\",\"turns\":2,\"rss_kb\":81920,\"max_silence_ms\":5012,\"exit_code\":3,\"signal\":null}\n"
        );
    }

    #[test]
    fn front_line_with_error() {
        let record = Record::Front {
            pid: 0,
            exit: Exit::NOT_STARTED,
            error: Some("ENOENT"),
        };
        assert_eq!(
            line(1, &record),
            "{\"ts_ms\":1,\"role\":\"front\",\"pid\":0,\"exit_code\":null,\"signal\":null,\"error\":\"ENOENT\"}\n"
        );
    }

    #[test]
    fn host_line_and_protocol_event() {
        let record = Record::Host {
            pid: 9,
            exit: Exit {
                code: None,
                signal: Some(9),
            },
            ready: true,
            error: None,
        };
        assert_eq!(
            line(1, &record),
            "{\"ts_ms\":1,\"role\":\"host\",\"pid\":9,\"ready\":true,\"exit_code\":null,\"signal\":9}\n"
        );
        let record = Record::Host {
            pid: 0,
            exit: Exit::NOT_STARTED,
            ready: false,
            error: Some("ENOENT"),
        };
        assert_eq!(
            line(1, &record),
            "{\"ts_ms\":1,\"role\":\"host\",\"pid\":0,\"ready\":false,\"exit_code\":null,\"signal\":null,\"error\":\"ENOENT\"}\n"
        );
        let record = Record::Protocol {
            pid: 42,
            role: "conversation",
            thread: b"t\"1",
            reason: "框太大",
        };
        assert_eq!(
            line(2, &record),
            "{\"ts_ms\":2,\"event\":\"protocol\",\"pid\":42,\"role\":\"conversation\",\"thread\":\"t\\\"1\",\"reason\":\"框太大\"}\n"
        );
    }

    #[test]
    fn every_cause_has_a_distinct_name() {
        let count = crate::supervisor_protocol::DEATH_CAUSES;
        let names: std::collections::HashSet<_> = (1..=count as u8)
            .map(|c| cause_name(DeathCause::from_u8(c).unwrap()))
            .collect();
        assert_eq!(names.len(), count);
    }

    #[test]
    fn exit_from_status() {
        assert_eq!(
            Exit::from_status(3 << 8),
            Exit {
                code: Some(3),
                signal: None
            }
        );
        assert_eq!(
            Exit::from_status(libc::SIGKILL),
            Exit {
                code: None,
                signal: Some(libc::SIGKILL)
            }
        );
    }
}
