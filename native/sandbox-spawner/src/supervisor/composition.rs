//! 一對（#2583）：組合行程 [`Composition`] 與它的葉子（[`Conversation`]，`pair` 指回組合行程）。這裡是只有成對時才走得到的部分：
//! 起一對、補葉子、送 `bind`、葉子與組合行程各自收完屍之後整對怎麼辦。成對與不成對共用的（`ensure`、名額、停機）留在上一層。

use super::*;

/// 送給組合行程的 `bind` 走到哪。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Bind {
    /// 沒有還沒回答的 `bind`：還沒送過，或上一個葉子死後清掉了。
    Unsent,
    /// 補了葉子，等組合行程替它送 `ready`：收到才送 `bind`。
    Refilling,
    /// 送了 `bind`，還沒回 `bound`。
    Sent,
    /// 現在這個葉子回過 `bound`。
    Bound,
}

/// 一對裡的組合行程（#2583）。葉子是 [`Conversation`]，`pair` 指回這裡；一對佔一個名額，從這個行程起到兩個行程都收完
/// （這個行程先收完時由葉子佔著，見 [`Supervisor::live`]）。
pub(super) struct Composition {
    pub(super) proc: Proc,
    /// 這一對的序號：三個 socket 的檔名與稽核的 `pair`。
    pub(super) serial: u64,
    pub(super) thread: Option<Vec<u8>>,
    /// 葉子還沒起時先記著開啟方式，起葉子時交給它。
    pub(super) read_only: bool,
    /// 前台連的 socket。
    pub(super) socket: PathBuf,
    /// 送過第一則 `ready`：第一個葉子在橋上登記完了。補起的葉子登記完會再送一則（[`Bind::Refilling`]）。
    pub(super) ready: bool,
    pub(super) bind: Bind,
    /// 葉子死了、這一個留著等下一個 `ensure`：從什麼時候起。
    pub(super) leafless_since: Option<Instant>,
    /// 葉子那一側已經算過這一對的死因（有 thread 的也回過 `down`）。補葉子（[`Self::refill`]）時清掉。
    pub(super) told: bool,
    /// 葉子不在了才收它的（葉子收完連帶收，或留著等葉子時因 `--idle-ms`、名額滿被收）：稽核記 `peer`，不回 `down`、不進死因累計。
    pub(super) peer: bool,
    pub(super) cause: Option<DeathCause>,
    pub(super) rss_now_kb: u64,
    pub(super) rss_kb: u64,
    /// 同 [`Conversation::heard_at`]：第一次送 `bind` 起算，換葉子不重來（它的心跳從第一則 `bind` 起沒停過）。
    pub(super) heard_at: Option<Instant>,
    pub(super) max_silence: Duration,
}

/// 一對走到哪：[`Composition`] 的 `ready`、`bind`、`leafless_since` 合起來只會是這六種。
#[cfg(any(test, debug_assertions))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PairState {
    /// 還沒讀到組合行程的 `ready`：葉子還沒起，或起了還沒在橋上登記完；葉子在這之前死了或起不來、整對正在收的也在這裡（之後讀到的 `ready` 照常處理）。
    Starting,
    /// 讀到過 `ready`，沒有在等回答的 `bind`：預熱好的；送過 `bind` 或補了葉子之後葉子死了、或補葉子起不來，整對正在收的也在這裡。
    Ready,
    /// 送了 `bind`，還沒回 `bound`。
    Binding,
    /// 組合行程替現在這個葉子回過 `bound`。
    Bound,
    /// 葉子死了、組合行程留著等下一個 `ensure`；因 `--idle-ms` 或名額滿被收的也停在這裡。
    Leafless { since: Instant },
    /// 補了葉子，等組合行程替它送 `ready`。
    Refilling,
}

#[cfg(any(test, debug_assertions))]
impl Composition {
    /// 三個欄位湊不出 [`PairState`] 的任何一種就 panic。
    pub(super) fn state(&self) -> PairState {
        match (self.ready, self.bind, self.leafless_since) {
            (false, Bind::Unsent, None) => PairState::Starting,
            (true, Bind::Unsent, None) => PairState::Ready,
            (true, Bind::Sent, None) => PairState::Binding,
            (true, Bind::Bound, None) => PairState::Bound,
            (true, Bind::Unsent, Some(since)) => PairState::Leafless { since },
            (true, Bind::Refilling, None) => PairState::Refilling,
            (ready, bind, leafless_since) => panic!(
                "第 {} 對的狀態不該存在：ready={ready} bind={bind:?} leafless={}",
                self.serial,
                leafless_since.is_some()
            ),
        }
    }
}

#[cfg(test)]
impl Composition {
    /// 測試用：序號 1、走到 `state` 的組合行程。
    pub(super) fn staged(proc: Proc, thread: Option<Vec<u8>>, state: PairState) -> Self {
        let (ready, bind, leafless_since) = match state {
            PairState::Starting => (false, Bind::Unsent, None),
            PairState::Ready => (true, Bind::Unsent, None),
            PairState::Binding => (true, Bind::Sent, None),
            PairState::Bound => (true, Bind::Bound, None),
            PairState::Leafless { since } => (true, Bind::Unsent, Some(since)),
            PairState::Refilling => (true, Bind::Refilling, None),
        };
        Self {
            proc,
            serial: 1,
            thread,
            read_only: false,
            socket: PathBuf::new(),
            ready,
            bind,
            leafless_since,
            told: false,
            peer: false,
            cause: None,
            rss_now_kb: 0,
            rss_kb: 0,
            heard_at: None,
            max_silence: Duration::ZERO,
        }
    }
}

impl Composition {
    pub(super) fn hear(&mut self, now: Instant) {
        if let Some(at) = self.heard_at {
            self.max_silence = self.max_silence.max(now.saturating_duration_since(at));
            self.heard_at = Some(now);
        }
    }

    pub(super) fn stalled(&self, now: Instant, stall: Duration) -> bool {
        self.proc.stop.is_none()
            && self
                .heard_at
                .is_some_and(|at| now.saturating_duration_since(at) >= stall)
    }

    /// 預熱池裡的（還沒指派 thread、沒在收）。
    pub(super) fn warm(&self) -> bool {
        self.thread.is_none() && self.proc.stop.is_none()
    }

    /// 連帶收掉：葉子已經不在了。
    pub(super) fn collect(&mut self, now: Instant, eof_grace: Duration) {
        if self.proc.stop.is_none() {
            self.peer = true;
            self.proc.begin_stop(now, eof_grace);
        }
    }
}

impl Supervisor {
    /// 成對的葉子，組合行程正在收：它收完時整對一起收，不再回 `up`。
    pub(super) fn composition_stopping(&self, conversation: &Conversation) -> bool {
        conversation.pair.is_some_and(|serial| {
            self.compositions
                .iter()
                .any(|p| p.serial == serial && p.proc.stop.is_some())
        })
    }

    /// 每一對的狀態說不通就 panic，訊息帶兩邊的狀態：組合行程自己的（[`Composition::state`]），以及它跟葉子兩邊對不對得上。
    #[cfg(any(test, debug_assertions))]
    pub(super) fn check_pairs(&self) {
        for composition in &self.compositions {
            let serial = composition.serial;
            let state = composition.state();
            let leaf = self.conversations.iter().find(|c| c.pair == Some(serial));
            let broken = |what: &str| -> ! {
                panic!(
                    "第 {serial} 對兩邊對不上（{what}）：{state:?} told={} peer={} 在收={} thread={}，葉子={:?}",
                    composition.told,
                    composition.peer,
                    composition.proc.stop.is_some(),
                    composition.thread.is_some(),
                    leaf.map(|c| (c.phase, c.proc.stop.is_some(), c.peer, c.thread.is_some())),
                )
            };
            if composition.told && leaf.is_some() {
                broken("葉子那一側算過了卻還有葉子");
            }
            if matches!(state, PairState::Leafless { .. }) && !composition.told {
                broken("沒有葉子、留著的，葉子那一側一定算過");
            }
            if composition.proc.stop.is_some() {
                continue;
            }
            let Some(leaf) = leaf else {
                if !matches!(state, PairState::Starting | PairState::Leafless { .. }) {
                    broken("這個狀態該有葉子");
                }
                continue;
            };
            if leaf.thread != composition.thread {
                broken("兩邊的 thread 不同");
            }
            if state != PairState::Starting && state != PairState::Ready && leaf.thread.is_none() {
                broken("送過 bind 卻沒有 thread");
            }
            if leaf.proc.stop.is_some() {
                continue;
            }
            let phase = match state {
                PairState::Starting | PairState::Refilling => Phase::Starting,
                PairState::Ready if composition.thread.is_none() => Phase::Warm,
                PairState::Ready => broken("有 thread、送過 ready 卻沒送 bind"),
                PairState::Binding => Phase::Binding,
                PairState::Bound => Phase::Up,
                PairState::Leafless { .. } => broken("Leafless 卻有葉子"),
            };
            if leaf.phase != phase {
                broken("葉子的 phase 跟一對的狀態不同");
            }
        }
    }

    pub(super) fn has_leaf(&self, serial: u64) -> bool {
        self.conversations.iter().any(|c| c.pair == Some(serial))
    }

    /// 一對的三個 socket：前台連的、橋、葉子自己收連線的。
    pub(super) fn pair_sockets(&self, serial: u64) -> [PathBuf; 3] {
        ["sock", "p.sock", "l.sock"]
            .map(|suffix| self.args.run_dir.join(format!("c{serial}.{suffix}")))
    }

    /// 起一對（#2583）：先起組合行程，等它的 `hello` 才起葉子（[`Self::start_leaf`]）；它送 `ready`（葉子在橋上登記完）才算預熱好。
    pub(super) fn start_pair(&mut self, thread: Option<Vec<u8>>, open: OpenMode) {
        let Some(program) = self.args.composition.clone() else {
            return;
        };
        self.next_socket += 1;
        let serial = self.next_socket;
        let [front, bridge, leaf] = self.pair_sockets(serial);
        for socket in [&front, &bridge, &leaf] {
            let _ = std::fs::remove_file(socket);
        }
        let mut args = self.args.composition_args.clone();
        args.push("--socket".into());
        args.push(front.clone().into_os_string());
        args.push("--pair-socket".into());
        args.push(bridge.into_os_string());
        args.push("--leaf-socket".into());
        args.push(leaf.into_os_string());
        match process::spawn(&program, &args, false) {
            Ok((pid, chan, _)) => {
                let mut proc = Proc::new(pid, chan);
                // 組合行程還不連宿主，身分表上沒有它那一筆：token 是空的。
                let hello = ConversationCommand::Hello {
                    version: PROTOCOL_VERSION,
                    token: Vec::new(),
                };
                proc.chan.send(&encode_conversation_command(&hello));
                self.compositions.push(Composition {
                    proc,
                    serial,
                    thread,
                    read_only: open == OpenMode::ReadOnly,
                    socket: front,
                    ready: false,
                    bind: Bind::Unsent,
                    leafless_since: None,
                    told: false,
                    peer: false,
                    cause: None,
                    rss_now_kb: 0,
                    rss_kb: 0,
                    heard_at: None,
                    max_silence: Duration::ZERO,
                });
            }
            Err(err) => {
                say!("組合行程起不來：{err}");
                let error = err.to_string();
                self.audit.record(&Record::Conversation {
                    pair: Some(audit::Pair {
                        serial,
                        composition: true,
                        peer: false,
                    }),
                    thread: thread.as_deref().unwrap_or_default(),
                    pid: 0,
                    cause: DeathCause::Crash,
                    exit: Exit::NOT_STARTED,
                    turns: 0,
                    rss_kb: 0,
                    max_silence_ms: 0,
                    error: Some(&error),
                });
                self.count_death(DeathCause::Crash);
                match thread {
                    Some(thread) => self.tell_front(&FrontEvent::Down {
                        thread_id: thread,
                        cause: DeathCause::Crash,
                    }),
                    None => self.warm_retry_at = Some(Instant::now() + self.args.front_restart),
                }
            }
        }
    }

    /// 替這一對起葉子：第一個（組合行程剛 `hello`）或補起的。起不來就連帶收掉組合行程。
    pub(super) fn start_leaf(&mut self, index: usize) -> bool {
        let composition = &self.compositions[index];
        let serial = composition.serial;
        let thread = composition.thread.clone();
        let open = if composition.read_only {
            OpenMode::ReadOnly
        } else {
            OpenMode::Run
        };
        let [front, bridge, leaf] = self.pair_sockets(serial);
        if self
            .spawn_conversation(thread.clone(), open, leaf, Some((serial, bridge, front)))
            .is_some()
        {
            return true;
        }
        let composition = &mut self.compositions[index];
        composition.told = true;
        composition.collect(Instant::now(), self.args.eof_grace);
        false
    }

    /// 這一對的組合行程還在、葉子死了：補一個葉子，等組合行程替它送 `ready` 再重送 `bind`。上一則 `bind` 回過 `bound` 才會留著
    /// 沒有葉子的組合行程（[`Self::on_leaf_gone`]），所以它那邊沒有還留著的 `bind`，重送不會撞上。
    pub(super) fn refill(&mut self, index: usize, open: OpenMode) {
        let composition = &mut self.compositions[index];
        composition.leafless_since = None;
        composition.told = false;
        composition.read_only = open == OpenMode::ReadOnly;
        if self.start_leaf(index) {
            self.compositions[index].bind = Bind::Refilling;
        }
    }

    /// 成對時 `bind` 送給組合行程，由它經橋轉給葉子。葉子的沉默每次從這裡重新起算；組合行程的只從第一次 `bind` 起算。
    pub(super) fn bind_pair(&mut self, index: usize) {
        let composition = &mut self.compositions[index];
        let Some(thread) = composition.thread.clone() else {
            return;
        };
        let now = Instant::now();
        composition.bind = Bind::Sent;
        composition.heard_at.get_or_insert(now);
        let bind = ConversationCommand::Bind { thread_id: thread };
        composition
            .proc
            .chan
            .send(&encode_conversation_command(&bind));
        let serial = composition.serial;
        if let Some(leaf) = self
            .conversations
            .iter_mut()
            .find(|c| c.pair == Some(serial))
        {
            leaf.phase = Phase::Binding;
            leaf.heard_at = Some(now);
        }
    }

    /// 把預熱池裡的一對指派給 `thread`，先挑已經 `ready` 的；葉子正在收的不挑。還沒 `ready` 的等它 `ready` 再送 `bind`。
    pub(super) fn take_warm_pair(&mut self, thread: &[u8], open: OpenMode) -> bool {
        let free = |p: &Composition| {
            p.warm()
                && !self
                    .conversations
                    .iter()
                    .any(|c| c.pair == Some(p.serial) && c.proc.stop.is_some())
        };
        let Some(index) = self
            .compositions
            .iter()
            .position(|p| free(p) && p.ready)
            .or_else(|| self.compositions.iter().position(free))
        else {
            return false;
        };
        let composition = &mut self.compositions[index];
        composition.thread = Some(thread.to_vec());
        composition.read_only = open == OpenMode::ReadOnly;
        let (serial, ready) = (composition.serial, composition.ready);
        let leaf = self
            .conversations
            .iter_mut()
            .find(|c| c.pair == Some(serial));
        let pid = leaf.map(|leaf| {
            leaf.thread = Some(thread.to_vec());
            leaf.read_only = open == OpenMode::ReadOnly;
            leaf.used_at = Instant::now();
            leaf.proc.pid
        });
        if ready {
            self.bind_pair(index);
        }
        if let Some(pid) = pid {
            self.regrant(pid);
        }
        true
    }

    pub(super) fn on_composition_readable(&mut self, index: usize) {
        let composition = &mut self.compositions[index];
        let frames = match composition.proc.chan.receive() {
            Ok(frames) => frames,
            Err(err) => {
                say!(
                    "組合行程 {} 送來解不開的框（{}），殺掉",
                    composition.proc.pid,
                    err.0
                );
                composition.cause.get_or_insert(DeathCause::Crash);
                composition.proc.kill_now();
                return;
            }
        };
        if !frames.is_empty() {
            composition.hear(Instant::now());
        }
        for payload in frames {
            let composition = &mut self.compositions[index];
            let report = match decode_conversation_report(&payload) {
                Ok(report) => report,
                Err(err) => {
                    say!(
                        "組合行程 {} 送來解不開的訊息（{}），殺掉",
                        composition.proc.pid,
                        err.0
                    );
                    composition.cause.get_or_insert(DeathCause::Crash);
                    composition.proc.kill_now();
                    return;
                }
            };
            if !composition.proc.hello {
                // 一對裡只有 loop 所在的那個宣告：loop 在葉子，所以組合行程的 `hello` 不能宣告。
                // TODO(#2573)：loop 搬進組合行程時對調。
                if report
                    == (ConversationReport::Hello {
                        version: PROTOCOL_VERSION,
                        runs_loop: false,
                    })
                {
                    composition.proc.hello = true;
                    if composition.proc.stop.is_none() && !self.shutting_down {
                        self.start_leaf(index);
                    }
                    continue;
                }
                say!(
                    "組合行程 {} 的第一框不是版本 {PROTOCOL_VERSION}、不宣告 loop 的 hello（{}），殺掉",
                    composition.proc.pid,
                    match report {
                        ConversationReport::Hello {
                            version: PROTOCOL_VERSION,
                            ..
                        } => "宣告了 loop".to_string(),
                        ConversationReport::Hello { version, .. } => format!("版本 {version}"),
                        _ => "別的訊息".to_string(),
                    }
                );
                composition.cause.get_or_insert(DeathCause::Protocol);
                composition.proc.kill_now();
                return;
            }
            let serial = composition.serial;
            match report {
                ConversationReport::Ready if composition.bind == Bind::Refilling => {
                    self.bind_pair(index);
                }
                ConversationReport::Ready if !composition.ready => {
                    composition.ready = true;
                    if composition.thread.is_some() {
                        self.bind_pair(index);
                    } else if let Some(leaf) = self
                        .conversations
                        .iter_mut()
                        .find(|c| c.pair == Some(serial))
                    {
                        leaf.phase = Phase::Warm;
                    }
                }
                ConversationReport::Bound { thread_id } if composition.bind == Bind::Sent => {
                    if Some(&thread_id) != composition.thread.as_ref() {
                        say!("組合行程 {} 綁錯 thread，殺掉", composition.proc.pid);
                        composition.cause.get_or_insert(DeathCause::Crash);
                        composition.proc.kill_now();
                        return;
                    }
                    composition.bind = Bind::Bound;
                    let serving = composition.proc.stop.is_none();
                    let socket = composition.socket.as_os_str().as_bytes().to_vec();
                    let Some(leaf) = self
                        .conversations
                        .iter_mut()
                        .find(|c| c.pair == Some(serial))
                    else {
                        continue;
                    };
                    leaf.phase = Phase::Up;
                    if serving && leaf.proc.stop.is_none() {
                        self.tell_front(&FrontEvent::Up { thread_id, socket });
                    }
                }
                _ => {}
            }
        }
    }

    /// 沒有葉子的組合行程留了 `--idle-ms` 還沒人要：連帶收掉。
    pub(super) fn check_leafless(&mut self, now: Instant) {
        let Some(idle) = self.args.idle else { return };
        for composition in &mut self.compositions {
            if composition
                .leafless_since
                .is_some_and(|at| at + idle <= now)
                && composition.proc.stop.is_none()
            {
                say!(
                    "組合行程 {} 沒有葉子已經 {} ms，收掉",
                    composition.proc.pid,
                    idle.as_millis()
                );
                composition.collect(now, self.args.eof_grace);
            }
        }
    }

    /// 一對的葉子收完屍、判完死因之後。上一則 `bind` 回過 `bound`、葉子是自己壞掉的（不是逐出、停機、協定錯）：組合行程留著，等下一個
    /// `ensure` 補葉子。其餘的連帶收掉組合行程：`bind` 還沒回 `bound` 時，從外面分不出組合行程是把它留著等葉子登記（再送一次它會以協定錯誤結束）、
    /// 還是已經轉給葉子而作廢（不再送就永遠不會 `bound`），所以整對收掉，下一個 `ensure` 起新的一對。
    /// 補起的葉子還沒等到 `ready` 就死（[`Bind::Refilling`]）也整對收：留著的話，它登記完才死時晚到的那則 `ready` 會被當成下一個葉子的，
    /// `bind` 提早送、新葉子的沉默提早起算。
    pub(super) fn on_leaf_gone(&mut self, serial: u64, cause: DeathCause) {
        let Some(composition) = self.compositions.iter_mut().find(|p| p.serial == serial) else {
            return;
        };
        composition.told = true;
        let keep = composition.bind == Bind::Bound
            && composition.proc.stop.is_none()
            && !self.shutting_down
            && matches!(
                cause,
                DeathCause::Crash
                    | DeathCause::Heap
                    | DeathCause::Memory
                    | DeathCause::HostOom
                    | DeathCause::Stalled
            );
        composition.bind = Bind::Unsent;
        let now = Instant::now();
        if keep {
            composition.leafless_since = Some(now);
            // 有排著的就讓出名額：沒有葉子的組合行程，最早留下的先收。
            self.make_room();
        } else {
            composition.collect(now, self.args.eof_grace);
        }
    }

    /// 組合行程結束：整對收。先判完它的死因（以 SIGKILL 結束的在 [`memory::classify`] 裡領走它那一次 `oom_kill`），才對葉子送 SIGKILL：
    /// 反過來的話葉子可能先被收屍，把那一次領走。`down` 一對只送一次：葉子那一側送過（`told`）、或葉子已經在收（它收完會送）的，這裡不送。
    pub(super) fn on_composition_exit(&mut self, index: usize, exit: Exit) {
        let composition = self.compositions.remove(index);
        let oom = &mut self.oom;
        let cause = memory::classify(composition.cause, exit.signal, false, || oom.claim());
        self.audit.record(&Record::Conversation {
            pair: Some(audit::Pair {
                serial: composition.serial,
                composition: true,
                peer: composition.peer,
            }),
            thread: composition.thread.as_deref().unwrap_or_default(),
            pid: composition.proc.pid,
            cause,
            exit,
            turns: 0,
            rss_kb: composition.rss_kb,
            max_silence_ms: composition
                .max_silence
                .as_millis()
                .min(u128::from(u64::MAX)) as u64,
            error: None,
        });
        for socket in self.pair_sockets(composition.serial) {
            let _ = std::fs::remove_file(socket);
        }
        // 葉子那一側算過的（`told`）不再算。葉子已經在收：這一對的 `down` 與死因累計留給葉子收屍時做。
        let mut counted = !composition.peer && !composition.told;
        if let Some(leaf) = self
            .conversations
            .iter_mut()
            .find(|c| c.pair == Some(composition.serial))
        {
            if leaf.proc.stop.is_none() {
                leaf.peer = true;
            } else {
                counted = false;
            }
            leaf.proc.kill_now();
        }
        if counted {
            self.count_death(cause);
            match composition.thread {
                Some(thread) => self.tell_front(&FrontEvent::Down {
                    thread_id: thread,
                    cause,
                }),
                None if cause != DeathCause::Shutdown => {
                    self.warm_retry_at = Some(Instant::now() + self.args.front_restart)
                }
                _ => {}
            }
        }
        self.serve_pending();
    }
}
