/**
 * 會話事件日誌——一份 per-session 的 append-only 序列，`seq` 由日誌長度決定。
 *
 * **這一層存在的理由是序號要有一個擁有者。**
 * [#89](https://github.com/DemianLi/nexus-agent/issues/89) 的決議是 (B)：遙測的 ledger
 * 記錄要鏡像會話事件、靠 `(session.id, seq)` 去重，而在這之前 nexus 沒有任何一個
 * append-only 序列可以鏡像——checkpointer 是 `MemorySaver`，只存狀態不存事件。
 *
 * **`seq` 出自 `this.#events.length`，不出自任何傳輸層。** 這不是風格選擇，是調研
 * 六個專案之後唯一的共同做法（見 `.docs/session-event-log-survey.md`）：dsh
 * `seq: this.log.length`、SWE-agent `n_step = len(self.trajectory) + 1`、
 * Codex CLI 由 recorder 自己持有 `ordinal`、Gemini CLI 每次寫入回讀磁碟重算。
 * **沒有一個拿 UI／傳輸層的計數器當耐久序號。**
 *
 * 反面教材同樣量到了：唯一 UI 與 API 各存一份的 Cline，兩份都沒有序號——它沒掉進
 * 「兩套編號」的坑，是因為它根本沒編號。所以
 * {@link ../../../apps/harness/src/thread-pump.ts | ThreadPump} 的 `#seq`
 * **要繼續留著、也不要去讀這裡的號**：那個是傳輸層給瀏覽器排序去重用的，這裡的是耐久
 * 序號，兩個號兩個工作。讓其中一個去冒充另一個，正是 (A) 被否掉的理由。
 *
 * **這一版刻意不記訊息內容。** 兩條路拿得到的顆粒度不一樣——web 那條經
 * `streamEvents` 收到的是 `messages` **分片**，CLI 那條經 `stream(['updates'])` 收到的是
 * **完整訊息**。要把兩者記成同一種事件，得在某一側重組，而重組出來的東西是合成的、
 * 不是量到的。v1 只收兩條路都**原樣**產得出來的那個交集：turn 邊界、中斷、失敗。
 * 補訊息是後面的事，補的時候要先講清楚顆粒度怎麼對齊。
 */

import type { GoalChangeMeta } from './goal.js';
import type { TodoItem } from './todo.js';

/**
 * 這一版收得下的事件種類。**加種類要同時回答「兩條路都產得出來嗎」。**
 *
 * `command/*` 這一對答得乾淨，理由值得留著：**它們根本不是模型串流事件**。產它們的是
 * 進入點（`runRepl` 手上就有這份日誌），不是 `streamEvents` 或 `stream(['updates'])`
 * ——上面那段排除訊息內容的「顆粒度對不齊」在這裡沒有指涉對象，同一段程式碼在兩條路
 * 上產出一模一樣的東西。見 [#118](https://github.com/DemianLi/nexus-agent/issues/118)。
 *
 * `goal/change` 同一條理由，但生產者換了一個：不是進入點，是**經 `registry.sessions`
 * 拿到這份日誌的 plugin**（{@link ./sessions.ts | SessionRegistrationPoint}）。兩條路都
 * 產得出來，因為兩條路都會接線——CLI 在 `runRepl` 之前接一次，web 那條每個 thread 建
 * pump 時接一次。它是**第一顆權威 domain 事件**：前面五種記的是「發生過什麼」，這一種
 * 記的是「現在的狀態是什麼」，所以它帶的是整份快照而不是差異。
 * 見 [#126](https://github.com/DemianLi/nexus-agent/issues/126)。
 *
 * `todo/write` 是**第三種生產者**：模型工具。前面六種由進入點寫，`goal/change` 由經
 * `registry.sessions` 接線的 plugin 寫，而這一種由模型呼叫工具當場寫——工具問
 * `registry.sessions.forCall(config)` 拿到自己這次該寫的那一份日誌
 * （{@link ./session-address.ts | toolCallSessionAddress}）。「兩條路都產得出來嗎」對它
 * 同樣成立，而且理由更硬：工具清單兩條路共用同一份組裝。
 *
 * **它也是第一種寫得進 subagent 那份日誌的事件。** 前七種全都只出現在 root 那一份上
 * ——進入點只包 root 的輪，goal 的參與者只接 root。`todo/write` 反過來，照 dsh 的單一
 * 所有者規則：每一次 spawn 各自維護自己的清單。
 * 見 [#132](https://github.com/DemianLi/nexus-agent/issues/132)。
 *
 * `model/usage` 是**第四種生產者：fold 自己建的 middleware**
 * （{@link ./model-usage.ts | createModelUsageRecorder}）。「兩條路都產得出來嗎」對它
 * 答得比前面每一種都硬——前三種要靠兩條路各自接線、或共用同一份工具清單，而這一種
 * **就是那一份組裝本身**：同一個 middleware 實例掛在同一張圖上，兩條進入點看到的是
 * 同一次模型呼叫。它跟 `todo/write` 一樣寫得進 subagent 那份。
 * 見 [#153](https://github.com/DemianLi/nexus-agent/issues/153)。
 *
 * `compaction/summary` 生產者同第四種，但**掛的位置不一樣**：它不是一顆新名字的
 * middleware，是{@link ./summarization.ts | 我們那個同名取代的摘要器}多包的一層。理由是
 * 基座**只在回傳值裡**交出摘要事件（`new Command({ update: { _summarizationEvent } })`），
 * 一顆排在它後面的新 middleware 看不到那個回傳值。「兩條路都產得出來嗎」跟 `model/usage`
 * 同一條理由：它就是那一份組裝本身。
 * 見 [#143](https://github.com/DemianLi/nexus-agent/issues/143)。
 */
export type SessionEventType =
  | 'turn/start'
  | 'turn/end'
  | 'turn/failed'
  | 'interrupt/raised'
  | 'command/run'
  | 'command/done'
  | 'goal/change'
  | 'todo/write'
  | 'model/usage'
  | 'compaction/summary';

/** 每一種事件帶什麼。 */
export interface SessionEventMap {
  /** 一輪開始。`resume` 是回覆核准，它沒有使用者說的話。 */
  'turn/start': { readonly kind: 'message'; readonly text: string } | { readonly kind: 'resume' };
  /** 一輪正常結束——**跑完與停在核准點都算**，停在核准點時前面會有一顆 `interrupt/raised`。 */
  'turn/end': Record<string, never>;
  /** 一輪拋錯結束。只留訊息，堆疊不進日誌。 */
  'turn/failed': { readonly message: string };
  /** 掛上了一顆等人回答的中斷。 */
  'interrupt/raised': { readonly interruptId: string };
  /**
   * 一個解析得出來的斜線命令進了它的 handler。**只記日誌，永遠不進模型**。
   *
   * 與 `command/done` 靠 `commandId` 配對，形狀照 dsh 的 `tool/call`↔`tool/result`。
   * `name` 與 `args` 是 `parseCommand` 自己的切分（命令名，以及**含分隔空白的原文**），
   * 所以讀日誌的人不必再解析一次。
   *
   * **收不下的行不記**：語法不符或名字不認得的，從來沒進過 handler，日誌裡不留痕跡。
   * 這一條照 dsh 的 `execute`：「Admission misses log nothing」。
   *
   * **`args` 是使用者原話，而它會原樣進遙測**——協調器一律鏡像每一顆事件（見
   * `session-telemetry-coordinator.ts`）。要把使用者輸入擋在遙測外，得補 dsh 那個
   * `recordInput` 開關；這一版沒有它，理由見 [#118](https://github.com/DemianLi/nexus-agent/issues/118)。
   */
  'command/run': {
    readonly commandId: string;
    readonly name: string;
    readonly args: string;
    readonly source: { readonly kind: 'user' };
  };
  /**
   * 配對的那次執行落定了。handler 拋錯或被中止都落成 `kind: 'error'`。
   *
   * **`text` 沒話說的時候要整個不放這個 key，不能放 `undefined`**——`snapshotJsonValue`
   * 對 `undefined` 是當場拋的，而它拋的時候整筆不算，等於這次執行在日誌裡沒有落定。
   */
  'command/done': {
    readonly commandId: string;
    readonly kind: 'success' | 'error';
    readonly text?: string;
  };
  /**
   * 這個會話的長期目標動了一次。**每一筆帶整份耐久狀態**（六個 operation），或是一顆
   * clear 墓碑。
   *
   * 帶整份而不是帶差異，是因為讀它的是一個**嚴格重放**的折疊：差異要求讀的人先有正確
   * 的前一份狀態才解得開，而整份快照讓「這一筆自己合不合法」與「它接不接得上前一筆」
   * 分成兩道各自報得出理由的檢查。折疊在 `@nexus/plugin-goal`。
   *
   * **`goal.blockedReason` 沒有時要整個不放 key**，同 `command/done` 的 `text`。
   */
  'goal/change': GoalChangeMeta;
  /**
   * 這個會話的待辦清單被整份換掉了一次。**每一筆帶完整的替換清單**，重放時後寫覆蓋
   * 先寫。
   *
   * 帶整份的理由與 `goal/change` 一樣（讀它的是嚴格重放），但它是**模型**寫的而不是人
   * ——所以沒有 CAS、沒有修訂號：整表替換的語義本身就沒有「基於哪一版改的」這個問題。
   * 條目的形狀見 {@link ./todo.ts | TodoItem}，域住在 `@nexus/plugin-todo`。
   */
  'todo/write': { readonly todos: readonly TodoItem[] };
  /**
   * 一次模型呼叫的 token 帳目，**供應商報什麼記什麼**。
   *
   * 一輪有幾格就有幾筆（工具呼叫每一輪都要再叫一次模型）；一輪花了多少要自己加，
   * 日誌不寫彙總——照 dsh 的 `deriveTurnTokenUsage`，輪級的數字是一道讀日誌的純折疊。
   *
   * **沒報就整筆沒有這顆事件**，不是三個 0、也不是 `undefined`。同樣地，報得自相矛盾
   * （總量小於它的組成、有欄位不是非負安全整數）也整筆不記。理由與規則見
   * {@link ./model-usage.ts | readModelUsage}。
   *
   * **這一筆只有數字。** `command/run` 那條「使用者原話會原樣進遙測」的警告在這裡沒有
   * 指涉對象：三個欄位都是計數，不含 prompt、不含檔案路徑、不含模型 id。
   */
  'model/usage': {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
  };
  /**
   * 壓縮真的發生了一次：舊訊息被換成一份摘要。**一次摘要一筆**。
   *
   * ## 這是 dsh 三顆事件的哪一顆，以及另外兩顆為什麼不在
   *
   * dsh 是 `compaction/start` → `compaction/summary` → `compaction/end`，三顆由**一把括住
   * 整個操作的鎖**串起來：中途崩潰的形態是可偵測的遺留鎖（有 `start` 沒有配對的 `end`），
   * 而不是一個謊稱完成的 `end`。
   *
   * **我們湊不出那把鎖，所以只留中間那顆。** 基座沒有把「開始壓縮」與「壓縮結束」暴露成
   * 任何東西——它只在**成功走完**之後回一個帶 `_summarizationEvent` 的 `Command`。硬記
   * 一顆 `start` 只能記在「我們猜它要壓了」的時間點，而那個猜測正是 dsh 的鎖要消滅的
   * 那種東西。一顆誠實的事件勝過三顆撐不起語義的。**代價明寫**：壓縮失敗在日誌裡是
   * 沉默的，不是一顆帶 `error` 的 `end`。
   *
   * ## 欄位
   *
   * **`filePath` 是 [#66](https://github.com/DemianLi/nexus-agent/issues/66) 那個 fail-open
   * 的訊號**：`null` 代表歷史沒寫成功，被換掉的原文就此消失，而基座對這件事只印一行
   * `console.warn`。這一顆事件是它在耐久紀錄裡唯一的痕跡。
   *
   * ⚠️ **`filePath` 是一條檔案路徑，而它會原樣進遙測**——協調器一律鏡像每一顆事件（見
   * `session-telemetry-coordinator.ts`）。同 `command/run` 的 `args`：那條路徑含
   * `historyPathPrefix` 與一個隨機 session id，不含使用者輸入，但它仍然是路徑不是計數。
   *
   * **`cutoffIndex` 與 `messagesBefore` 是同一組座標**：原始訊息串（不是摘要器眼中的
   * 有效串）的索引與長度。基座存進 state 的就是原始座標——`getEffectiveMessages` 拿它去
   * `messages.slice(cutoffIndex)`。所以 `cutoffIndex / messagesBefore` 讀得出「這次換掉了
   * 多前面的多少」。
   *
   * **摘要本文刻意不記。** 檔頭那條「這一版不記訊息內容」在這裡是硬約束不是偏好：
   * `summaryMessage` 就是模型產的訊息，記了它等於從側門把訊息內容放進日誌與遙測。
   */
  'compaction/summary': {
    /** 切在原始訊息串的哪裡；`[0, cutoffIndex)` 被換成了那份摘要。 */
    readonly cutoffIndex: number;
    /** 切之前原始訊息串有多長。與 `cutoffIndex` 同一組座標。 */
    readonly messagesBefore: number;
    /** 被換掉的原文落在 backend 的哪個檔。**`null` ＝ 沒寫成功，原文消失了**。 */
    readonly filePath: string | null;
  };
}

/** 日誌裡的一筆。凍過的，拿到之後改不動。 */
/**
 * 日誌裡的一筆。
 *
 * **刻意是分配式的條件型別，不是 interface。** 寫成 `interface { type: T; data:
 * SessionEventMap[T] }` 的話，`SessionEvent`（T 是整個 union）的 `data` 是所有酬載的
 * 聯集，而 `event.type === 'command/run'` **narrow 不動它**——不變量檢查與遙測投影都
 * 只拿得到聯集，只能靠轉型硬讀。分配之後 `SessionEvent` 是六個具體形狀的 union，
 * `type` 就是它的判別欄位。
 */
export type SessionEvent<T extends SessionEventType = SessionEventType> = T extends SessionEventType
  ? {
      readonly type: T;
      /** 這一筆在這份日誌裡的位置。**append 當下由長度決定**，一個 session 內單調遞增。 */
      readonly seq: number;
      /** Unix epoch 毫秒。 */
      readonly time: number;
      readonly data: SessionEventMap[T];
    }
  : never;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 深拷貝成純 JSON，**拷不動就當場拋**。
 *
 * 這一條是 fail-closed 的，照 dsh `Session.append` 的
 * `snapshotJsonValue`（`packages/core/session/src/index.ts`）。**存參考會讓日誌變成活的**
 * ——LangGraph 的 payload 帶的是 `BaseMessage` 實例，存進去之後別人改那顆訊息，
 * 歷史就跟著被改寫，而且沒有任何徵兆。所以這裡連 class 實例都不收，只認
 * null / boolean / 有限 number / string / 陣列 / 純物件。
 */
function snapshotJsonValue(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`會話事件的 ${path} 是 ${String(value)}，JSON 表達不出來`);
    }
    return value;
  }
  if (typeof value === 'object' && seen.has(value)) {
    throw new TypeError(`會話事件的 ${path} 繞回自己，日誌不收循環參考`);
  }
  if (Array.isArray(value)) {
    seen.add(value);
    const copy = value.map((entry, index) => snapshotJsonValue(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return copy;
  }
  if (isPlainObject(value)) {
    seen.add(value);
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = snapshotJsonValue(entry, `${path}.${key}`, seen);
    }
    seen.delete(value);
    return copy;
  }
  throw new TypeError(
    `會話事件的 ${path} 是 ${value === undefined ? 'undefined' : typeof value}，日誌只收純 JSON`,
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

/** 日誌的觀察者。**同步呼叫，在事件已經進到日誌之後**。 */
export type SessionLogListener = (event: SessionEvent) => void;

/** 建一份日誌時可以換掉的東西。 */
export interface SessionLogOptions {
  /**
   * 某個 listener 拋錯或 reject 時往哪裡講。省略即 `console.warn`。
   *
   * 這是一個縫而不是寫死 `console`，因為「listener 拋了但日誌沒事」這件事**只能靠它
   * 驗**——圍堵成功的外顯就是這一行 warn，沒有它測試只能斷言「沒拋」，斷言不到
   * 「有被記下來」。
   */
  readonly onListenerError?: (message: string) => void;
}

/**
 * 一份日誌**看得到的那一面**：身分、長度、事件。沒有 `append`，也沒有 `subscribe`。
 *
 * 它是為了 {@link ./invariants.ts | InvariantSubject} 而存在的。那條路的語義是「觀察，
 * 違規時 `fail`」——`fail` 的型別甚至是 `never`。在這之前它交出的是完整的
 * {@link SessionLog}，於是**任何註冊了配套入口的 package 都寫得動會話日誌**：通道的
 * 名字說它只是來看的，型別說它可以寫。
 *
 * **這是照 dsh，不是我們自己加嚴。** dsh 的不變量註冊表交給配套入口的是一個乾淨的子
 * Cordis context——`InvariantInstaller` 的簽章是 `(ctx, fail)`
 * （`references/deepseek-harness/packages/runtime-diagnostics/invariants/src/index.ts:32`），
 * `register()` 裡是 `ctx.plugin(installInvariant)`（同檔 `:160-168`），**註冊表一份
 * session 都不交**。要看得到 session 的配套入口自己 `inject: ['sessions']`
 * （`packages/goal/goal/src/invariant.ts:71`），而那樣拿到的 `Session` 是寫得動的
 * （`append` 在 `packages/core/session/src/index.ts:602`）。
 *
 * 所以 dsh 的答案不是「配套入口不准寫」，是「**寫入要另外去要**」。收窄之後我們一樣：
 * 要寫日誌走 {@link ./sessions.ts | registry.sessions}，那個通道的名字認這件事。
 *
 * **收窄只發生在型別上。** 接線那一層傳的仍然是同一個 `SessionLog` 實例
 * （`invariants.ts` 的 `log: options.log`），runtime 上 `append` 還在，一個 cast 就穿得
 * 過去。這裡要擋的是順手寫一筆，不是惡意。包一層真物件換不到多少，卻要記得 `length`
 * 與 `events` 都得是 getter——照抄成快照的話，重播之後讀到的是凍住的那一份。
 *
 * @see [#127](https://github.com/DemianLi/nexus-agent/issues/127)
 */
export interface SessionLogView {
  /** 這份日誌屬於誰。遙測的 `session.id` 就是它。 */
  readonly sessionId: string;
  /** 目前為止的全部事件，照 `seq` 排。 */
  readonly events: readonly SessionEvent[];
  /** 目前的長度，也就是下一筆會拿到的 `seq`。 */
  readonly length: number;
}

/**
 * 一個 session 一份。
 *
 * **`append` 會同步回呼觀察者，所以它帶著一道重入防護。** 順序照 dsh 的
 * `Session.append`（`references/deepseek-harness/packages/core/session/src/index.ts:614-654`）：
 * **先驗 → 先算好 listener 清單 → 推進日誌 → 才回呼**。觀察者被叫到的時候，日誌裡
 * 已經有這一筆了——遙測協調器讀 `event.seq` 當去重鍵，看到的必須是已定案的日誌。
 *
 * 三道防護，三個不同的東西：
 *
 * 1. **重入**——回呼裡再 `append` 直接拋。listener 清單是在推進前就凍住的，回呼中途
 *    插進來的那一筆會拿到一份算舊了的清單、而且會讓「誰看到什麼」變成呼叫順序的
 *    函數。dsh 拋的是 `session append cannot reenter while another append is being
 *    published`，同一件事。
 * 2. **圍堵**——每個 listener 各自 try / catch，拋錯只換來一行 warn。遙測是盡力而為的
 *    旁路，**不能有能力扳倒 agent loop**。
 * 3. **不中斷**——前一個 listener 拋錯不影響後面的。照 dsh 的
 *    `invokeContainedSessionObservers`：一個訂閱者壞掉不該餓死其他訂閱者。
 */
export class SessionLog implements SessionLogView {
  readonly #sessionId: string;
  readonly #events: SessionEvent[] = [];
  readonly #listeners = new Set<SessionLogListener>();
  readonly #onListenerError: (message: string) => void;
  /** 正在回呼中。重入防護唯一的狀態。 */
  #publishing = false;

  constructor(sessionId: string, options: SessionLogOptions = {}) {
    this.#sessionId = sessionId;
    this.#onListenerError =
      options.onListenerError ??
      ((message) => {
        console.warn(message);
      });
  }

  /** 這份日誌屬於誰。遙測的 `session.id` 就是它。 */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** 目前為止的全部事件，照 `seq` 排。**回的是副本**，拿去改動不到日誌。 */
  get events(): readonly SessionEvent[] {
    return [...this.#events];
  }

  /** 目前的長度，也就是下一筆會拿到的 `seq`。 */
  get length(): number {
    return this.#events.length;
  }

  /**
   * 訂閱後續的事件。**不補發歷史**——訂閱之前的那些要自己讀 {@link events}，
   * 協調器就是這樣接上一份已經有內容的日誌的。
   *
   * @param listener - 每筆事件進到日誌之後被同步呼叫；拋錯會被圍堵成一行 warn。
   * @returns 只退訂這一次的冪等函式。
   */
  subscribe(listener: SessionLogListener): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /**
   * 記一筆，回傳記進去的那一筆。
   *
   * @throws `data` 帶了 JSON 表達不出來的東西（class 實例、函式、`undefined`、
   *   `NaN`、循環參考）——**當場拋，日誌不變**。
   * @throws 在某個 listener 的回呼裡被呼叫——重入防護，見 class 註解。
   */
  append<T extends SessionEventType>(type: T, data: SessionEventMap[T]): SessionEvent<T> {
    // 先驗再推進：拷不動的話這一筆整個不算，日誌不會留下半筆。
    const snapshot = snapshotJsonValue(data, `${type} 的 data`, new Set()) as SessionEventMap[T];
    if (this.#publishing) {
      throw new Error(
        `會話 "${this.#sessionId}" 的 append 不能在另一次 append 的回呼裡重入` +
          `（想記的是 "${type}"）。要在觀察到事件之後再記一筆，把它排到下一個 tick。`,
      );
    }
    // **這層轉型是型別推導的縫，不是行為的縫。** `SessionEvent` 是分配式的條件型別
    // （見它自己的說明），而 `T` 在這裡還是個泛型參數——TypeScript 不會把條件型別對
    // 未解析的 `T` 展開，所以字面量對不上 `SessionEvent<T>`。欄位本身完全吻合。
    const event = deepFreeze({
      type,
      seq: this.#events.length,
      time: Date.now(),
      data: snapshot,
    }) as SessionEvent<T>;
    // 清單先凍住：回呼期間的訂閱／退訂不影響這一輪看得到誰。
    const listeners = [...this.#listeners];
    this.#events.push(event);
    if (listeners.length === 0) return event;
    this.#publishing = true;
    try {
      for (const listener of listeners) this.#publish(listener, event);
    } finally {
      this.#publishing = false;
    }
    return event;
  }

  /** 叫一個 listener，把它的同步例外與非同步 reject 都收成一行 warn。 */
  #publish(listener: SessionLogListener, event: SessionEvent): void {
    try {
      const returned: unknown = listener(event);
      // 型別上 listener 回 void，但 JS 那側塞得進 async 函式——不接住的話它的 reject
      // 會變成 unhandled rejection，在 Node 預設設定下是直接殺掉整個行程。
      void Promise.resolve(returned).catch((error: unknown) => {
        this.#onListenerError(
          `會話 "${this.#sessionId}" 的 ${event.type} 觀察者 reject 了：${String(error)}`,
        );
      });
    } catch (error: unknown) {
      this.#onListenerError(
        `會話 "${this.#sessionId}" 的 ${event.type} 觀察者拋了：${String(error)}`,
      );
    }
  }
}
