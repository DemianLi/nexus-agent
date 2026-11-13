//! MCP 連線池：**一份設定一份連線**，同一個池共用。規則照 `packages/nexus-plugin-mcp/src/pool.ts`：
//!
//! - 鍵是整份設定加實際的 elicitation 旗標（[`Server::pool_key`]）。
//! - 舊的一份留到池關：不數使用者、不回收。
//! - 建立那一份的取用等第一次連線落定（建池給了 `first_acquire_wait`、又沒寫 `failOnStartupError` 時最多等那麼久）；
//!   寫了 `failOnStartupError` 就回錯、池裡不留。其餘的取用最多等 [`FIRST_CONNECT_WAIT`]；到期或第一次失敗時，
//!   寫了 `failOnStartupError` 就回錯，否則錯誤放在 [`Acquired::error`]、照樣回。
//! - 斷線空窗裡 [`Shared::current`] 是 `None`，[`Shared::listed`] 回最近一代的清單。
//! - 放棄重連之後，下一次取用替這一份重開一個監督者、重新起算預算。
//!
//! 查池關了沒、找表、建立與放進表都在同一段鎖裡，同時來的取用不會各建一份，關池之後也不會再建。
//!
//! 一代怎麼連由 [`Connector`] 決定，池只管上面這些規則。

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{oneshot, watch, Notify};
use tokio::task::JoinHandle;

use super::config::Server;
use super::redact::Redactor;
use super::supervisor::{self, Hooks, State};

/// 不是建立那一份的取用，最多等第一次連線多久，同 `FIRST_CONNECT_WAIT_MS`。
pub const FIRST_CONNECT_WAIT: Duration = Duration::from_secs(5);

/// 替池連一代。
pub trait Connector: Send + Sync + 'static {
    type Generation: Generation;

    /// 照 `server` 連一代。錯誤字串裡出現的 `secrets` 要先換掉。
    /// 回錯之前要自己把開出來的東西真的關掉，池不替失敗的嘗試叫 [`Generation::close`]；
    /// 停掉監督者時這個 future 可能在任何 await 點被丟掉，開出來的東西要靠 drop 收。
    fn connect(
        &self,
        server: &Server,
        secrets: &[String],
    ) -> impl Future<Output = Result<Self::Generation, String>> + Send;
}

/// 連上的一代。
pub trait Generation: Send + Sync + 'static {
    /// 呼叫這一代用的東西，交給 [`Live::peer`]。
    type Peer: Clone + Send + Sync + 'static;
    /// 這一代列出的東西；斷線空窗裡池照留最近一代的。
    type Listed: Send + Sync + 'static;

    fn peer(&self) -> Self::Peer;
    fn listed(&self) -> Self::Listed;
    /// 呼叫端判斷線時叫醒的訊號；[`Generation::down`] 要跟著回來。
    fn lost_signal(&self) -> Arc<Notify>;
    /// 等到這一代掉線。
    fn down(&self) -> impl Future<Output = ()> + Send;
    /// 收掉這一代，回來時它已經真的關了。
    fn close(self) -> impl Future<Output = ()> + Send;
}

/// 活著的那一代：呼叫用它。
pub struct Live<G: Generation> {
    pub generation: u64,
    pub peer: G::Peer,
    pub listed: Arc<G::Listed>,
    lost: Arc<Notify>,
}

impl<G: Generation> Live<G> {
    /// 呼叫判斷這一代斷線了。
    pub fn lost(&self) {
        self.lost.notify_one();
    }
}

/// 寫日誌的地方：一般與錯誤級。
#[derive(Clone)]
pub struct Log {
    pub info: Arc<dyn Fn(&str) + Send + Sync>,
    pub error: Arc<dyn Fn(&str) + Send + Sync>,
}

type Ready = Option<Result<(), String>>;

type Slot<T> = Arc<Mutex<Option<Arc<T>>>>;

/// 池裡的一份：一個監督者，與它最近一代列出的東西。
pub struct Shared<G: Generation> {
    pub label: String,
    pub server: Server,
    /// 這一份要遮的值：池的（代理帳密等）與這份設定的。
    redactor: Redactor,
    current: Slot<Live<G>>,
    last: Slot<G::Listed>,
    state: watch::Receiver<State>,
    ready: watch::Receiver<Ready>,
    stop: watch::Sender<bool>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl<G: Generation> Shared<G> {
    /// 目前活著的那一代；斷線空窗或還沒連上是 `None`。
    pub fn current(&self) -> Option<Arc<Live<G>>> {
        self.current.lock().ok()?.clone()
    }

    /// 目前這一代的清單；空窗裡是最近一代的；一代都還沒連上是 `None`。
    pub fn listed(&self) -> Option<Arc<G::Listed>> {
        self.current()
            .map(|live| Arc::clone(&live.listed))
            .or_else(|| self.last.lock().ok()?.clone())
    }

    /// 監督者這一刻的狀態。
    pub fn state(&self) -> State {
        self.state.borrow().clone()
    }

    /// 錯誤與診斷的文字：換掉這一份所有的秘密。
    pub fn scrub(&self, text: &str) -> String {
        self.redactor.scrub_text(text)
    }

    /// 成功結果與 resources：原地遮這一份夠長的秘密，見 [`Redactor::redact_json`]。
    pub fn redact_json(&self, value: &mut serde_json::Value) {
        self.redactor.redact_json(value);
    }

    /// 工具清單，見 [`Redactor::redact_tool_list`]。
    pub fn redact_tool_list(&self, tools: &mut serde_json::Value) {
        self.redactor.redact_tool_list(tools);
    }

    /// instructions 這類單獨的一段文字，規則同 [`Shared::redact_json`]。
    pub fn redact_text(&self, text: &str) -> String {
        self.redactor.redact_text(text)
    }

    /// 監督者停了，見 [`State::Stopped`]。
    pub fn gave_up(&self) -> bool {
        *self.state.borrow() == State::Stopped
    }

    /// 等第一次連線落定，最多 `limit`；逾時回 `None`。
    async fn settled(&self, limit: Option<Duration>) -> Option<Result<(), String>> {
        let mut ready = self.ready.clone();
        let wait = async move {
            ready
                .wait_for(Option::is_some)
                .await
                .ok()
                .and_then(|r| r.clone())
                .unwrap_or_else(|| Err(format!("{}: supervisor ended", self.label)))
        };
        match limit {
            None => Some(wait.await),
            Some(limit) => tokio::time::timeout(limit, wait).await.ok(),
        }
    }

    /// 停掉監督者，等它收完（它自己對每一代套收線期限）。
    pub async fn dispose(&self) {
        self.stop.send_replace(true);
        let task = self.task.lock().ok().and_then(|mut t| t.take());
        if let Some(task) = task {
            let _ = task.await;
        }
    }

    fn still_connecting(&self, limit: Duration) -> String {
        format!(
            "{}: still connecting after {}ms — this assembly goes without its tools; the connection keeps trying in the background",
            self.label,
            limit.as_millis()
        )
    }
}

/// 一次取用拿到的東西。
pub struct Acquired<G: Generation> {
    pub shared: Arc<Shared<G>>,
    /// 第一次連線失敗或等到期限還沒落定時的錯誤；第一次連線成功才是 `None`。
    /// 第一次失敗、之後重連上的那一份，之後的取用照樣帶第一次的錯，同 TS。
    pub error: Option<String>,
}

/// 監督者的 [`Hooks`]：每一代用池的 [`Connector`] 連。
struct PoolHooks<C: Connector> {
    server: Server,
    connector: Arc<C>,
    secrets: Vec<String>,
    current: Slot<Live<C::Generation>>,
    last: Slot<<C::Generation as Generation>::Listed>,
    log: Log,
}

impl<C: Connector> PoolHooks<C> {
    fn set_current(&self, live: Option<Arc<Live<C::Generation>>>) {
        if let Ok(mut current) = self.current.lock() {
            *current = live;
        }
    }
}

impl<C: Connector> Hooks for PoolHooks<C> {
    type Generation = C::Generation;

    async fn connect(&mut self) -> Result<C::Generation, String> {
        self.connector.connect(&self.server, &self.secrets).await
    }

    fn adopted(&mut self, generation: u64, gen: &C::Generation) {
        let listed = Arc::new(gen.listed());
        if let Ok(mut last) = self.last.lock() {
            *last = Some(Arc::clone(&listed));
        }
        self.set_current(Some(Arc::new(Live {
            generation,
            peer: gen.peer(),
            listed,
            lost: gen.lost_signal(),
        })));
    }

    async fn down(&mut self, gen: &C::Generation) {
        gen.down().await;
    }

    async fn close(&mut self, gen: C::Generation) {
        self.set_current(None);
        gen.close().await;
    }

    fn report(&mut self, message: &str) {
        (self.log.info)(message);
    }

    fn error(&mut self, message: &str) {
        (self.log.error)(message);
    }
}

/// MCP 連線池。要在 tokio 執行環境裡用。
pub struct Pool<C: Connector> {
    connector: Arc<C>,
    /// 代理的帳密等，每一份連線的錯誤都要換掉。
    secrets: Vec<String>,
    log: Log,
    first_acquire_wait: Option<Duration>,
    entries: Mutex<HashMap<String, Arc<Shared<C::Generation>>>>,
    opened: Mutex<Vec<Arc<Shared<C::Generation>>>>,
    closed: Mutex<bool>,
}

impl<C: Connector> Pool<C> {
    /// `secrets`：每一份連線的錯誤都要換掉的字串（代理帳密等）。`first_acquire_wait`：建立那一份的取用最多等多久，
    /// 只套在沒寫 `failOnStartupError` 的列；`None` 等到落定。
    pub fn new(
        connector: C,
        secrets: Vec<String>,
        log: Log,
        first_acquire_wait: Option<Duration>,
    ) -> Pool<C> {
        Pool {
            connector: Arc::new(connector),
            secrets,
            log,
            first_acquire_wait,
            entries: Mutex::default(),
            opened: Mutex::default(),
            closed: Mutex::new(false),
        }
    }

    /// 取這份設定的那一份連線；沒有就建，已放棄重連就重開。
    /// 回錯：池已經關了；或寫了 `failOnStartupError`，而第一次連線失敗或等到期限還沒落定。
    pub async fn acquire(
        &self,
        server: &Server,
        elicitation: bool,
    ) -> Result<Acquired<C::Generation>, String> {
        let key = server.pool_key(elicitation);
        let (shared, created) = {
            let closed = self.closed.lock().map_err(|_| "池的鎖壞了")?;
            if *closed {
                return Err("MCP 連線池已經關了".into());
            }
            let mut entries = self.entries.lock().map_err(|_| "池的鎖壞了")?;
            match entries.get(&key) {
                Some(existing) if !existing.gave_up() => (Arc::clone(existing), false),
                _ => {
                    let shared = self.open(server);
                    entries.insert(key.clone(), Arc::clone(&shared));
                    (shared, true)
                }
            }
        };
        if !created {
            let error = match shared.settled(Some(FIRST_CONNECT_WAIT)).await {
                None => Some(shared.still_connecting(FIRST_CONNECT_WAIT)),
                Some(outcome) => outcome.err(),
            };
            if let (Some(error), true) = (&error, server.fail_on_startup_error) {
                return Err(error.clone());
            }
            return Ok(Acquired { shared, error });
        }
        let wait = (!server.fail_on_startup_error)
            .then_some(self.first_acquire_wait)
            .flatten();
        let Some(outcome) = shared.settled(wait).await else {
            let error = Some(shared.still_connecting(wait.unwrap_or_default()));
            return Ok(Acquired { shared, error });
        };
        match outcome {
            Ok(()) => Ok(Acquired {
                shared,
                error: None,
            }),
            Err(error) if server.fail_on_startup_error => {
                if let Ok(mut entries) = self.entries.lock() {
                    if entries.get(&key).is_some_and(|e| Arc::ptr_eq(e, &shared)) {
                        entries.remove(&key);
                    }
                }
                shared.dispose().await;
                Err(error)
            }
            Err(error) => Ok(Acquired {
                shared,
                error: Some(error),
            }),
        }
    }

    /// 收掉池裡每一份（含被重開取代的、還在連第一次的），同時收。冪等。
    pub async fn close(&self) {
        let opened: Vec<Arc<Shared<C::Generation>>> = {
            let mut closed = self.closed.lock().unwrap_or_else(|e| e.into_inner());
            *closed = true;
            self.opened
                .lock()
                .map(|mut o| std::mem::take(&mut *o))
                .unwrap_or_default()
        };
        futures_join_all(opened).await;
    }

    /// 建一份、起它的監督者；呼叫端同步放進表裡。
    fn open(&self, server: &Server) -> Arc<Shared<C::Generation>> {
        let label = server.label();
        let current: Slot<Live<C::Generation>> = Arc::default();
        let last: Slot<<C::Generation as Generation>::Listed> = Arc::default();
        let (state_tx, state) = watch::channel(State::Connecting);
        let (ready_tx, ready) = watch::channel::<Ready>(None);
        let (stop, stop_rx) = watch::channel(false);
        let mut secrets = self.secrets.clone();
        secrets.extend(server.secrets());
        let hooks = PoolHooks {
            server: server.clone(),
            connector: Arc::clone(&self.connector),
            secrets: secrets.clone(),
            current: Arc::clone(&current),
            last: Arc::clone(&last),
            log: self.log.clone(),
        };
        let (first_tx, first_rx) = oneshot::channel();
        let policy = server.reconnect;
        let retry_first = !server.fail_on_startup_error;
        let run_label = label.clone();
        let task = tokio::spawn(async move {
            let forward = async move {
                if let Ok(outcome) = first_rx.await {
                    ready_tx.send_replace(Some(outcome));
                }
            };
            tokio::join!(
                supervisor::run(
                    hooks,
                    policy,
                    run_label,
                    retry_first,
                    first_tx,
                    state_tx,
                    stop_rx
                ),
                forward
            );
        });
        let shared = Arc::new(Shared {
            label,
            server: server.clone(),
            redactor: Redactor::new(secrets),
            current,
            last,
            state,
            ready,
            stop,
            task: Mutex::new(Some(task)),
        });
        if let Ok(mut opened) = self.opened.lock() {
            opened.push(Arc::clone(&shared));
        }
        shared
    }
}

/// 同時收每一份。
async fn futures_join_all<G: Generation>(all: Vec<Arc<Shared<G>>>) {
    let handles: Vec<JoinHandle<()>> = all
        .into_iter()
        .map(|shared| tokio::spawn(async move { shared.dispose().await }))
        .collect();
    for handle in handles {
        let _ = handle.await;
    }
}
