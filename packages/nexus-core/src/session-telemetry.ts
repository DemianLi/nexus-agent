/**
 * 會話遙測的**捕獲側契約**——記錄長什麼樣、後端最少要提供什麼、脫敏規則的形狀。
 *
 * 形狀照 dsh 的 `dsh-session-telemetry` Service Definition
 * （`references/deepseek-harness/packages/session/session-telemetry/src/index.ts`）。
 * `emit()` 之後的一切——批次、重試、排隊、丟失策略——**刻意不在這裡建模**，那是上報
 * SDK 的地盤。
 *
 * 這一層與 {@link ./session-log.ts | SessionLog} 的分工：日誌是**唯一的耐久序列**，
 * 遙測是它的鏡像出口。鏡像永遠不回頭改寫日誌——脫敏只作用在送出去的那份副本上。
 *
 * @see [#89](https://github.com/DemianLi/nexus-agent/issues/89)
 */

/**
 * 告警等級，**捕獲當下就映好**，讓收端零設定也能告警。
 *
 * 映射規則只有一條：`turn/failed` 是 `error`，其餘捕獲到的事件是 `info`。`warn` 留給
 * 脫敏規則與後端自己用——這一層不產生它。
 *
 * **與 dsh 的差別在來源不在規則**：dsh 另外看 `tool/result` 的 `isError` 與 `turn/end`
 * 的 error reason，而我們的日誌 v1 兩者都沒有（沒有工具事件，失敗是獨立的事件種類）。
 */
export type SessionTelemetrySeverity = 'info' | 'warn' | 'error';

/**
 * 交給後端的一筆邏輯記錄——捕獲側對外的全部詞彙。
 *
 * `ledger` 一對一鏡像會話事件，收端靠 `(session.id, event.seq)` 去重。
 * `ops` 是**在日誌裡沒有家**的運作訊號，它**刻意不帶 `event.seq` 這類識別**，這樣就
 * 不可能被誤當成 ledger 的一列。
 */
export interface SessionTelemetryRecord {
  /** ledger（日誌鏡像）或 ops（運作訊號）。後端應該把兩者放在不同的量測範圍下。 */
  readonly channel: 'ledger' | 'ops';
  /** Unix epoch 毫秒。ledger 是**來源事件的 append 時間**，ops 是發出的時間。 */
  readonly time: number;
  /** 捕獲時就映好的告警等級，見 {@link SessionTelemetrySeverity}。 */
  readonly severity: SessionTelemetrySeverity;
  /**
   * 識別屬性，**刻意最小**。ledger 帶 `session.id` / `event.type` / `event.seq`；
   * ops 帶 `telemetry.op` 與 `session.id`。**body 裡撈得到的東西一律不在這裡重複一份。**
   *
   * dsh 另有 `session.cwd` / `session.parent_id` / `session.seed_length`，**nexus 沒有
   * 來源**（沒有 session header、沒有 fork），所以那三個不會出現——是缺，不是省略。
   */
  readonly attributes: Readonly<Record<string, string | number>>;
  /**
   * 完整內容：ledger 是會話事件 `data` 的深拷貝（append 當下已經驗過是純 JSON），
   * ops 是該次運作訊號的酬載。交出去之後不再改動。
   */
  readonly body: unknown;
}

/**
 * 一條脫敏規則：收一筆記錄，回一筆記錄。
 *
 * **回傳型別沒有 `Promise` 這一格，這是刻意的。** 規則跑在捕獲熱路徑上，協調器靠
 * 「拋了就扣住這一筆」達成 fail-closed；簽章一旦收得下 async，折疊就沒辦法在拋錯時
 * 扣住記錄，fail-closed 當場變 fail-open。需要非同步的清洗（查表、呼叫外部服務）
 * **不屬於這一層**——那是後端在 `emit()` 之後自己的事。
 *
 * 規則**不得就地改動**傳進來的記錄，要回一個新的。傳進來的那筆連同它的 `body` 都已經
 * 是協調器自己的深拷貝，就地改動不會污染正典日誌——但下一條規則拿到的是你**回傳**的
 * 那個，就地改會讓「誰改了什麼」無從追。
 *
 * **與 dsh 的偏離**（AGENTS.md 的偏離規則）：dsh 用 Cordis 的 waterfall 事件
 * `session-telemetry/record`，listener 簽章是 `(record, next) => record`，**不呼叫
 * `next()` 就能截斷底下所有規則**。`NexusPlugin.apply(registry)` 沒有事件匯流排，
 * deepagents / LangChain JS / LangGraph JS 也都沒有可掛任意具名事件的 waterfall
 * （`CallbackManager` 是固定的一組生命週期回呼，而且是 async 的），**waterfall 這個
 * 形狀表達不出來**。退到最接近的：registry 上的註冊點加**依註冊順序的折疊**。
 *
 * 折疊丟掉的正是那個截斷能力，**而且是刻意丟的**：對脫敏來說，「一條規則能悄悄關掉
 * 另一條部署掛的清洗」不是擴充性，是洩漏。
 */
export type SessionTelemetryRedactRule = (record: SessionTelemetryRecord) => SessionTelemetryRecord;

/**
 * 協調器對後端的最低要求。
 *
 * dsh 這一格是 Cordis 的 `Service`（`ctx.sessionTelemetry`）；我們沒有 service 註冊，
 * 掛載走 registry 的 `telemetry.useSink()`，一個 registry 只收一個。
 */
export interface SessionTelemetrySink {
  /**
   * 收下一筆記錄。**必須是非阻塞的入隊。**
   *
   * 協調器是從日誌的 append 熱路徑**同步**呼叫它的——慢過一次 queue push 就會課稅到
   * agent loop。這裡拋的錯由協調器圍堵並記成一行 warn，不會外洩。
   *
   * @param record - 交出去之後由後端擁有。
   */
  emit(record: SessionTelemetryRecord): void;
  /**
   * 「一輪結束了」的提示，選配。後端可以轉給自己 SDK 的 flush，讓每輪結束就送出。
   *
   * fire-and-forget，實作**不得阻塞**。多數後端應該不實作它、讓 SDK 自己的批次節奏
   * 決定送出時機——實作了就得自己處理它與 {@link shutdown} 排空之間的交互。
   */
  flush?(): void;
  /**
   * 關機：把排著的東西送完、進入靜止，照後端自己 SDK 的關機約定。
   *
   * **這次呼叫之前 emit 過的每一筆都還是要送到。** 協調器會 await 它；reject 只換來
   * 一行 warn，**絕不讓應用程式的關機失敗**——盡力而為的旁路不該有這種權力。
   *
   * @returns 後端流水線靜止時 resolve。
   */
  shutdown(): Promise<void>;
}
