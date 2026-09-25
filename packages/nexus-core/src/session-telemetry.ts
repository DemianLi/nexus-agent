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

import type { SessionEvent, SessionEventType } from './session-log.js';

/**
 * 告警等級，**捕獲當下就映好**，讓收端零設定也能告警。
 *
 * 映射規則兩條：`turn/failed` 與 `isError` 的 `tool/result` 是 `error`，其餘捕獲到的事件是
 * `info`。`warn` 留給脫敏規則與後端自己用——這一層不產生它。
 *
 * **與 dsh 的差別在來源不在規則**：dsh 另外看 `turn/end` 的 error reason，而我們的失敗是
 * 獨立的事件種類（`turn/failed`）。`tool/result` 那一格從
 * [#264](https://github.com/DemianLi/nexus-agent/issues/264) 起跟 dsh 一樣。
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
 * **這裡沒有 `sharing`，是刻意的**——協調器從頭到尾不讀它。共享策略是**掛載**這件事的
 * 要求，不是捕獲的要求，所以它落在 {@link SessionTelemetryService} 上：`feedback-only` 要怎麼捕獲，
 * 是組裝點讀了它之後替協調器挑 `capture`（`apps/harness` 的 `attachTelemetry`，
 * [#279](https://github.com/DemianLi/nexus-agent/issues/279)），協調器只知道 live 或 on-demand。dsh 同一個切法：
 * `sharing` 在可載入的 `SessionTelemetryBackend` 上，`SessionTelemetrySink` 上沒有。
 * 把它塞進這裡只會讓每個測試替身實作一個沒人看的欄位。
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

/**
 * 部署選定的會話共享策略，由**掛載中的後端**說出來。
 *
 * 詞彙歸 seam 所有而不是歸某個後端，這樣披露就不必知道掛的是誰。三個值照抄 dsh 的
 * `SessionTelemetrySharingStatus`。
 *
 * `'feedback-only'` 只在人明白送出回饋時補送日誌，哪幾顆算回饋見 {@link isFeedbackEvent}
 * （[#279](https://github.com/DemianLi/nexus-agent/issues/279)）。
 */
export type SessionTelemetrySharingStatus = 'full' | 'feedback-only' | 'disabled';

/**
 * 每一種事件**准不准 `feedback-only` 把日誌補送出去**。只有人明白送出的回饋准：三顆 `feedback/*`。
 * 照 dsh 的 `isFeedback`（`packages/session/session-telemetry-otel/src/index.ts:58-64`，`c291e79`）。
 *
 * **逐種列舉、不給預設值**：多一種事件而沒在這裡表態就編不過。漏放行與誤放行是相反的兩種病——
 * 漏了，人按了送出卻什麼都沒送；多了，人沒同意就整份送出去。
 */
const RELEASES_FEEDBACK_ONLY_CAPTURE = {
  'turn/start': false,
  'turn/end': false,
  'turn/failed': false,
  'interrupt/raised': false,
  'command/run': false,
  'command/done': false,
  'goal/change': false,
  'todo/write': false,
  'model/usage': false,
  'model/start': false,
  'model/end': false,
  'assistant/message': false,
  'user/message': false,
  'compaction/summary': false,
  'context/measure': false,
  'sandbox/mode': false,
  'plan/mode': false,
  'tool/call': false,
  'tool/result': false,
  'feedback/message-put': true,
  'feedback/message-delete': true,
  'feedback/record': true,
  'deliverables/presented': false,
  'workspace/changes': false,
  'inbox/spliced': false,
  'session/title': false,
  'session/end-seed': false,
} as const satisfies Record<SessionEventType, boolean>;

/**
 * 這一顆是不是人送出的回饋——`feedback-only` 靠它決定什麼時候補送。
 *
 * dsh 的另外兩道守衛在我們這裡不需要，理由各一：
 *
 * - **分叉繼承來的回饋不算**（`event.seq < session.inheritedEventCount`）：我們不分叉。續接帶進來的
 *   seed 裡就算有回饋也碰不到這裡——seed 不發給任何觀察者（`SessionLogOptions.seed`），接線那側
 *   用的是不重播的 `log.subscribe`。
 * - **`message-put`／`message-delete` 比 `sessionId`**：我們的事件沒有那一格（`feedback.ts` 的偏離）。
 *
 * @param event - 剛進日誌的那一顆。
 * @returns 是回饋就 `true`。
 */
export function isFeedbackEvent(event: SessionEvent): boolean {
  return RELEASES_FEEDBACK_ONLY_CAPTURE[event.type];
}

/**
 * 可掛載的後端形：{@link SessionTelemetrySink} 的能力，**加上必須表態的共享策略**。
 *
 * `registry.services.provide(SESSION_TELEMETRY_SERVICE, …)` 收的是這個。dsh 的對應物是 `SessionTelemetryBackend`
 * ——Cordis `Service` 的可載入形，`abstract readonly sharing` 就在它上面。
 *
 * **每個掛上來的後端都必須表態。** 消費端只有在「一個都沒掛」的時候才渲染未配置，
 * 這是 dsh 的規矩，也是為什麼 `sharing` 不能是選配的：選配就等於「掛了但沒說」，
 * 而那在畫面上跟「沒掛」長得一模一樣。
 */
export interface SessionTelemetryService extends SessionTelemetrySink {
  /** 這個後端當前的共享策略。**只陳述策略，不承諾投遞。** */
  readonly sharing: SessionTelemetrySharingStatus;
}

/**
 * 遙測後端這個服務的名字。**照 dsh 的 `ctx.sessionTelemetry`**
 * （`references/deepseek-harness/packages/session/session-telemetry/src/index.ts:19-21`，SHA `6b1808f`）。
 *
 * 型別那一格在 {@link ./registry.ts | NexusServices} 上，所以
 * `registry.services.get(SESSION_TELEMETRY_SERVICE)` 回的是
 * `SessionTelemetryService | undefined`，不必轉型。
 */
export const SESSION_TELEMETRY_SERVICE = 'sessionTelemetry';
