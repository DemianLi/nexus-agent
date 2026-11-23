#![cfg(target_os = "linux")]
//! 橋的兩種語言對接（#2583）：真的 [`nexus_host::pair::Pair`] listen，起 node 跑
//! `packages/nexus-host-bridge/src/pair-leaf-probe.ts`（TS 的葉子連線，印的事件見該檔檔頭），斷言兩邊看到的一致。
//! `收下就拒絕_葉子不讀就寫_hello_每一條都讀得到_rejected` 起的是 `src/pair-reject-probe.ts`：不經葉子的連線函式庫，直接用 node 的 socket。
//!
//! 只在 Linux 編：`Pair` 讀 `SO_PEERCRED`（`libc::ucred`），nexus-host 在 Linux 以外編不過。全部標 `#[ignore]`：要 node 與 `pnpm install` 過的相依，CI 在 `./.github/actions/setup` 之後另跑一步帶 `--ignored`
//! 並核對跑到的測試數（`.github/scripts/test_ci_workflow.py` 釘住那一步）。
//!
//! 時間是真的：每一次等待最多 [`LIMIT`]，等不到就把兩邊到目前為止的記錄印出來。起的 node 丟掉時殺掉並收屍；它自己在 stdin 關了時也會結束。

use std::io::{BufRead, BufReader};
use std::os::unix::net::UnixListener;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command as Process, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use nexus_host::pair::{Disconnect, Pair, PairEvent};
use serde_json::{json, Value};

/// 一次等待最多多久。
const LIMIT: Duration = Duration::from_secs(30);

/// 跑著的葉子。丟掉就關 stdin、殺掉、收屍。
struct Probe {
    child: Child,
    stdin: Option<ChildStdin>,
    events: Arc<Mutex<Vec<Value>>>,
}

impl Probe {
    /// 起葉子連 `rig`，驗過之後叫組合行程的 `method`；`second` 時再連第二條。
    fn start(rig: &Rig, method: &str, second: bool) -> Probe {
        let mut args = vec![method];
        if second {
            args.push("second");
        }
        Probe::launch(rig, "src/pair-leaf-probe.ts", &args)
    }

    /// 在 `packages/nexus-host-bridge` 底下起 node 跑 `script`，參數是 `rig` 的 socket 再接 `args`。
    fn launch(rig: &Rig, script: &str, args: &[&str]) -> Probe {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/nexus-host-bridge");
        let mut command = Process::new("node");
        command
            .args(["--import", "tsx", script])
            .arg(&rig.socket)
            .args(args);
        let mut child = command
            .current_dir(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("起 node");
        let stdout = child.stdout.take().expect("stdout");
        let stdin = child.stdin.take();
        let events: Arc<Mutex<Vec<Value>>> = Arc::default();
        let sink = Arc::clone(&events);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Ok(value) = serde_json::from_str::<Value>(&line) {
                    sink.lock().expect("鎖").push(value);
                }
            }
        });
        Probe {
            child,
            stdin,
            events,
        }
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// 葉子印過的某一種事件，照順序。
    fn events(&self, event: &str) -> Vec<Value> {
        self.events
            .lock()
            .expect("鎖")
            .iter()
            .filter(|e| e["event"] == event)
            .cloned()
            .collect()
    }

    fn dump(&self) -> String {
        self.events
            .lock()
            .expect("鎖")
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl Drop for Probe {
    fn drop(&mut self) {
        self.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// 組合行程那一端：替葉子做 `echo` 與 `hold`。
struct Rig {
    pair: Pair,
    dir: PathBuf,
    socket: PathBuf,
    seen: Vec<PairEvent>,
}

impl Rig {
    fn new(tag: &str) -> Rig {
        let dir = std::env::temp_dir().join(format!("npair-leaf-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let socket = dir.join("pair.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        Rig {
            pair: Pair::new(listener, &["echo", "hold"]).unwrap(),
            dir,
            socket,
            seen: Vec::new(),
        }
    }

    fn step(&mut self) {
        let events = self.pair.step(Instant::now());
        self.seen.extend(events);
    }

    /// 一直走到 `done` 回得出東西；超過 [`LIMIT`] 就失敗，印兩邊的記錄。
    fn until<T>(
        &mut self,
        probe: &Probe,
        what: &str,
        mut done: impl FnMut(&Rig, &Probe) -> Option<T>,
    ) -> T {
        let deadline = Instant::now() + LIMIT;
        loop {
            self.step();
            if let Some(found) = done(self, probe) {
                return found;
            }
            assert!(
                Instant::now() < deadline,
                "等不到：{what}\n組合行程看到的：{:#?}\n葉子印的：\n{}",
                self.seen,
                probe.dump()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// 等葉子驗過。
    fn connected(&mut self, probe: &Probe) {
        let pid = probe.pid();
        self.until(probe, "葉子驗過", |rig, probe| {
            (rig.seen.contains(&PairEvent::Connected { pid })
                && !probe.events("connected").is_empty())
            .then_some(())
        });
    }

    /// 等葉子發來叫 `method` 的那一次，回本地代號。
    fn their_call(&mut self, probe: &Probe, method: &str) -> u64 {
        self.until(probe, "葉子發來的呼叫", |rig, _| {
            rig.seen.iter().find_map(|event| match event {
                PairEvent::Call {
                    id,
                    parent: None,
                    method: name,
                    payload,
                } if name == method && *payload == json!({ "from": "leaf" }) => Some(*id),
                _ => None,
            })
        })
    }

    /// 等自己發的那一次結束，回結果。
    fn finished(&mut self, probe: &Probe, id: u64) -> Value {
        self.until(probe, "自己發的呼叫結束", |rig, _| {
            rig.seen.iter().find_map(|event| match event {
                PairEvent::Finished {
                    id: done,
                    outcome: Ok(value),
                } if *done == id => Some(value.clone()),
                _ => None,
            })
        })
    }

    fn refusals(&self) -> Vec<String> {
        self.seen
            .iter()
            .filter_map(|event| match event {
                PairEvent::Refused { reason, .. } => Some(reason.clone()),
                _ => None,
            })
            .collect()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
#[ignore = "要 node 與裝好的相依；CI 另跑一步帶 --ignored"]
fn 握手之後兩個方向各一來一回() {
    let mut rig = Rig::new("roundtrip");
    let probe = Probe::start(&rig, "echo", false);
    rig.pair.set_leaf(probe.pid());
    rig.connected(&probe);

    rig.until(&probe, "葉子登記的名稱", |rig, _| {
        rig.seen
            .contains(&PairEvent::Registered {
                tools: vec!["probe-tool".to_string()],
                hooks: vec!["probe-hook".to_string()],
            })
            .then_some(())
    });

    let theirs = rig.their_call(&probe, "echo");
    rig.pair
        .finish(theirs, Ok(json!({ "from": "composition" })))
        .unwrap();
    let result = rig.until(&probe, "葉子收到結果", |_, probe| {
        probe.events("result").into_iter().next()
    });
    assert_eq!(result["ok"], json!({ "from": "composition" }));

    let mine = rig
        .pair
        .call(None, "echo", json!({ "n": 1, "文": "字" }))
        .unwrap();
    assert_eq!(rig.finished(&probe, mine), json!({ "n": 1, "文": "字" }));

    let attach = rig.pair.attach("thread-1").unwrap();
    assert_eq!(rig.finished(&probe, attach), json!({ "bound": "thread-1" }));

    assert_eq!(probe.events("retry"), Vec::<Value>::new());
    assert_eq!(rig.refusals(), Vec::<String>::new());
}

#[test]
#[ignore = "要 node 與裝好的相依；CI 另跑一步帶 --ignored"]
fn 葉子比_pid_早到_被要求稍後再試_pid_到了就進去() {
    let mut rig = Rig::new("early");
    let probe = Probe::start(&rig, "echo", false);

    let retry = rig.until(&probe, "葉子被要求稍後再試", |_, probe| {
        probe.events("retry").into_iter().next()
    });
    assert_eq!(retry["attempt"], 1);
    assert_eq!(retry["outcome"], "retry_later");
    assert_eq!(retry["detail"], "還沒有葉子的 pid");
    assert_eq!(rig.refusals(), ["還沒有葉子的 pid"]);

    rig.pair.set_leaf(probe.pid());
    rig.connected(&probe);
    assert!(probe.events("failed").is_empty());
}

#[test]
#[ignore = "要 node 與裝好的相依；CI 另跑一步帶 --ignored"]
fn 組合行程沒讀_hello_就回_rejected_並關_葉子照_retry_later_判() {
    let mut rig = Rig::new("unread");
    // 手上是別人的 pid：收下連線的那一步就拒絕，不讀葉子的 `hello`。
    rig.pair.set_leaf(std::process::id());
    let probe = Probe::start(&rig, "echo", false);

    // 組合行程回了 `rejected` 之後留著連線等葉子關，葉子的 `hello` 寫得進去：前五次每一次讀到的都是 `rejected`。
    let retries = rig.until(&probe, "葉子的前五次重試", |_, probe| {
        let retries = probe.events("retry");
        (retries.len() >= 5 || !probe.events("failed").is_empty()).then_some(retries)
    });
    println!("沒讀 hello 就被拒的前幾次：{retries:?}");
    assert!(probe.events("failed").is_empty(), "{}", probe.dump());
    let read = retries
        .iter()
        .filter(|retry| retry["outcome"] == "retry_later" && retry["detail"] == "pid 不對")
        .count();
    assert_eq!(read, retries.len(), "{retries:?}");
    assert_eq!(rig.refusals().first().map(String::as_str), Some("pid 不對"));

    rig.pair.set_leaf(probe.pid());
    rig.connected(&probe);
}

#[test]
#[ignore = "要 node 與裝好的相依；CI 另跑一步帶 --ignored"]
fn 同一個_pid_再連一條被拒_不重試_原來那條不動() {
    let mut rig = Rig::new("second");
    let probe = Probe::start(&rig, "echo", true);
    rig.pair.set_leaf(probe.pid());
    rig.connected(&probe);
    let theirs = rig.their_call(&probe, "echo");
    rig.pair.finish(theirs, Ok(json!(null))).unwrap();

    let second = rig.until(&probe, "第二條的結局", |_, probe| {
        probe.events("second").into_iter().next()
    });
    assert_eq!(second["failure"]["kind"], "rejected");
    assert_eq!(second["failure"]["code"], "protocol");
    assert_eq!(second["failure"]["reason"], "已經有連線");
    assert_eq!(second["failure"]["attempts"], 1);
    assert_eq!(rig.refusals(), ["已經有連線"]);

    assert!(rig.pair.connected());
    let mine = rig.pair.call(None, "echo", json!("還在")).unwrap();
    assert_eq!(rig.finished(&probe, mine), json!("還在"));
    assert!(probe.events("closed").is_empty());
}

#[test]
#[ignore = "要 node 與裝好的相依；CI 另跑一步帶 --ignored"]
fn 驗過之後組合行程關連線_葉子的呼叫收成對方不在_不重連() {
    let mut rig = Rig::new("drop");
    let probe = Probe::start(&rig, "hold", false);
    rig.pair.set_leaf(probe.pid());
    rig.connected(&probe);
    rig.their_call(&probe, "hold");

    // 同一個 pid 再給一次：驗過的那條被換掉，之後這個 pid 再連就會被收下。
    rig.pair.set_leaf(probe.pid());
    rig.until(&probe, "組合行程這一端斷了", |rig, _| {
        rig.seen
            .contains(&PairEvent::Disconnected {
                reason: Disconnect::Replaced,
            })
            .then_some(())
    });

    let failed = rig.until(&probe, "葉子的呼叫結算", |_, probe| {
        probe.events("call_failed").into_iter().next()
    });
    assert_eq!(failed["name"], "PairPeerGoneError");
    let closed = rig.until(&probe, "葉子知道斷了", |_, probe| {
        probe.events("closed").into_iter().next()
    });
    assert_eq!(closed["kind"], "closed");

    // 重連的話，最短的退避過後就會被收下；等它的好幾倍都沒有。
    let quiet = Instant::now() + Duration::from_secs(2);
    while Instant::now() < quiet {
        rig.step();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!rig.pair.connected());
    let connects = rig
        .seen
        .iter()
        .filter(|event| matches!(event, PairEvent::Connected { .. }))
        .count();
    assert_eq!(connects, 1);
    assert_eq!(probe.events("connected").len(), 1);
}

/// 組合行程收下連線的那一步就拒絕（手上是別人的 pid），不停地走 `step`；node 這一端 `connect` 當下就寫 `hello`。
/// 每一條都要寫得進去、讀得到 `rejected`（#2737）。
#[test]
#[ignore = "要 node 與裝好的相依；CI 另跑一步帶 --ignored"]
fn 收下就拒絕_葉子不讀就寫_hello_每一條都讀得到_rejected() {
    const COUNT: u64 = 200;

    let mut rig = Rig::new("reject-race");
    rig.pair.set_leaf(std::process::id());
    let probe = Probe::launch(&rig, "src/pair-reject-probe.ts", &[&COUNT.to_string()]);

    let deadline = Instant::now() + LIMIT;
    let cell = loop {
        rig.step();
        rig.seen.clear();
        if let Some(cell) = probe.events("cell").into_iter().next() {
            break cell;
        }
        assert!(
            Instant::now() < deadline,
            "等不到結果，葉子印的：\n{}",
            probe.dump()
        );
        std::thread::yield_now();
    };
    println!("收下就拒絕、不讀就寫：{cell}");
    assert_eq!(cell.get("aborted"), None, "{cell}");
    assert_eq!(cell["total"], COUNT, "{cell}");
    assert_eq!(cell["rejected"], COUNT, "{cell}");
    assert_eq!(cell["writeFailed"], json!({}), "{cell}");
}
