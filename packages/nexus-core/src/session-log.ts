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
 * **從格式 9 起它記訊息內容，而且日誌是對話的真相**（[#305](https://github.com/DemianLi/nexus-agent/issues/305)）。
 * 1 到 8 刻意不記，理由是兩條路拿得到的顆粒度不一樣——web 那條經 `streamEvents` 收到的是
 * `messages` **分片**，CLI 那條經 `stream(['updates'])` 收到的是**完整訊息**，要記成同一種事件
 * 得在某一側重組。**那個理由綁的是寫入點在進入點**：寫入點換成 fold 自己建的 middleware 之後
 * （模型回覆在 {@link ./model-calls.ts} 的 `wrapModelCall`，工具結果在{@link ./containment.ts | 圍堵}），
 * 兩條路看到的是同一次呼叫回來的同一則完整訊息，沒有東西要重組。訊息的形狀是
 * {@link ./logged-message.ts | LoggedMessage}。
 *
 * 照 dsh，模型歷史由日誌推出來（`packages/core/session/src/index.ts` 的 `deriveMessages()`），推的
 * 那一側是 [#306](https://github.com/DemianLi/nexus-agent/issues/306)。所以**模型看得到的每一則
 * 訊息都要有一顆事件帶著它**：哪幾種事件產訊息是型別 {@link ModelVisibleEventType}，不在這裡手列。**三個例外
 * 都是基座寫的、推得回來的**：`patchToolCallsMiddleware` 替沒配到結果的呼叫補的結果（推的一側照 dsh
 * 的 `repair.ts` 自己補），過大的工具結果被搬去檔案之後換上的預覽（見 `tool/result`），過長的一則
 * 人話被標上的 `lc_evicted_to`（基座在模型那一格照記號重算，推回來的那則沒有記號就不重算——那是
 * 20 萬字元以上的一則話，推的一側要自己判）。
 */

import type { MessageContent } from '@langchain/core/messages';
import type { AttachmentRef } from './attachment-ref.js';
import type { SubagentMentionRef } from './subagent-mention.js';
import type { ModelRoute } from './model-route.js';
import type { ApprovalPolicyValue } from './approval-policy.js';
import type { FeedbackRecord, MessageFeedbackDelete, MessageFeedbackPut } from './feedback.js';
import type { GoalId } from './goal.js';
import type { InboxSplice, SubagentSettleReason } from './inbox.js';
import { KNOWN_SESSION_EVENT_TYPES } from './known-event-types.js';
import type { LoggedMessage } from './logged-message.js';
import type { RequestHeader, RequestSnapshotReason } from './request-snapshot.js';
import type { SessionHeaderBuildMetadata } from './session-store.js';
import type { SubagentCatalogData } from './subagent-catalog.js';
import type { SubagentDescriptorData } from './subagent-descriptor.js';
import type { ToolErrorInfo } from './tool-events.js';

/**
 * 這一版收得下的事件種類。**加種類要同時回答「兩條路都產得出來嗎」。**
 *
 * **種類是 {@link SessionEventMap} 的鍵，而鍵不全在核心**（[#679](https://github.com/DemianLi/nexus-agent/issues/679)
 * 第 4 步，照 dsh 的 `SessionEventType = keyof SessionEventMap`）：核心留下的是跨 plugin 的流程骨架（輪、中斷、模型
 * 呼叫、訊息、壓縮、工具、子代理、回饋、收件匣），領域的種類由擁有者用 `declare module '@nexus/core'` 補——
 * `command/*`（`@nexus/plugin-commands`）、`goal/change`（`@nexus/plugin-goal`）、`todo/write`（`@nexus/plugin-todo`）、
 * `plan/mode`（`@nexus/plugin-plan-mode`）、`sandbox/mode`（`@nexus/plugin-sandbox-policy`）、`deliverables/presented`
 * （`@nexus/plugin-present`）、`workspace/changes`（`@nexus/plugin-workspace-changes`）、`session/title*`
 * （`apps/harness/src/session-title.ts`）。**宣告合併是以編譯單元為單位的**：一個套件只看得到自己 import 的擁有者補的
 * 鍵，要讀就加一行 `import type {} from '@nexus/plugin-x'`。認得哪些種類的執行期清單是生成的，見
 * {@link isKnownSessionEventType}。下面各段講的寫入規則照舊適用，種類的酬載型別去擁有者那裡找。
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
 *
 * `session/end-seed` 是**第五種生產者：建構子自己**。它不是任何人「記」下來的事，是一份
 * 帶 seed 開出來的日誌替自己畫的那條線（[#251](https://github.com/DemianLi/nexus-agent/issues/251)，
 * 照 dsh：Session 建構子是唯一合法的寫者）。「兩條路都產得出來嗎」答得出來，因為產它的
 * 是這個 class，不是哪一個進入點——CLI 的 `--resume` 與 serve 碰到以前寫過的 thread，兩條
 * 都帶 seed 開日誌。
 *
 * `plan/mode` 沒有帶來新的生產者，兩個寫者各走一條舊路：`/plan` 走 `goal/change` 那條
 * （經 `registry.sessions` 接到 root 那一份的 plugin），`exit_plan_mode` 的同意走 `todo/write` 那條
 * （問 `forCall`）——只是寫的那一刻從工具本體挪到下一次模型呼叫前的 middleware（#652，照 dsh 在
 * pre-step 提交）。「兩條路都產得出來嗎」答得出來——命令面與工具清單兩條路共用。
 *
 * `tool/call`／`tool/result` 生產者同第四種（fold 自己建的 middleware），而且就是**圍堵那一顆**
 * （{@link ./containment.ts | createContainmentMiddleware}）：只有第 0 格同時看得到內層拋出的
 * 錯與內層回的錯誤訊息。「兩條路都產得出來嗎」同 `model/usage`：它就是那一份組裝本身，而
 * 工具結果在兩條路上都是一則完整的 ToolMessage，檔頭那條「顆粒度對不齊」在這裡沒有指涉對象。
 * 跟 `model/usage` 一樣寫得進 subagent 那份。見 [#264](https://github.com/DemianLi/nexus-agent/issues/264)。
 *
 * `model/start`／`model/end` 生產者同第四種（{@link ./model-calls.ts | createModelCallRecorder}），
 * 理由同 `model/usage`：同一個 middleware 實例、同一次模型呼叫，也寫得進 subagent 那份。
 * 見 [#266](https://github.com/DemianLi/nexus-agent/issues/266)。
 *
 * **`tool/result` 有第二個寫者：web 的 pump**，只在一種情況——停在核准點時人按了停止，那幾顆
 * 等核准的呼叫被收回（[#276](https://github.com/DemianLi/nexus-agent/issues/276)）。那時沒有 run 在跑，
 * 圍堵看不到它們，所以由 pump 寫 `turn/start {kind:'resume'}` → 每一顆的 `tool/result`
 * （`ABORTED_BEFORE_DISPATCH`）→ `turn/end` 帶 aborted。配對規則不變：每一顆都配著前面那顆沒結果的
 * `tool/call`。
 *
 * `feedback/*` 三顆**沒有帶來新的生產者，帶來的是新的觸發者：人在事後按的**，只寫 root 那一份。
 * `feedback/record` 兩個寫者各走一條舊路：`/feedback` 走 `goal/change` 那條（經 `registry.sessions`
 * 接到 root 那一份的 plugin），web 的回饋對話框走 `turn/start` 那條（進入點——wire-handler 把
 * pump 那一份交給同一份規則）；`feedback/message-put`／`message-delete` 只有後面那條。**CLI 產不出
 * 後兩顆**——評分只在 web
 * （[#267](https://github.com/DemianLi/nexus-agent/issues/267) 的 Q4），這是第一種只有一條路產得
 * 出來的事件；它們描述的是人事後怎麼看，不是模型做了什麼，所以「兩條路的顆粒度要對齊」在這裡
 * 沒有指涉對象。**三顆都只進日誌、不進模型**：寫它們的人沒有一個碰 `updateState`，推模型歷史的
 * 一側也不讀它們。見 [#278](https://github.com/DemianLi/nexus-agent/issues/278)。
 *
 * `assistant/message` 生產者同第四種（{@link ./model-calls.ts | createModelCallRecorder}，就是寫
 * `model/start`／`model/end` 那一顆），理由同 `model/usage`，也寫得進 subagent 那份。**它有第二個
 * 寫者：web 的 pump**，只在一種情況——人按了停止、模型講到一半，那半段由 pump 寫回對話，同時寫
 * 一顆 `interrupted: true` 的（CLI 沒有停止這條路，見 `cli.ts` 的 `runRepl`）。
 *
 * `user/message` 兩個寫者各走一條舊路：repeat-reminder 走 `model/usage` 那條（fold 自己建的
 * middleware，它的 `beforeModel`），goal 的收尾走 `tool/result` 那條（圍堵，從工具回的 `Command`
 * 裡讀出來）。見 [#305](https://github.com/DemianLi/nexus-agent/issues/305)。
 *
 * `deliverables/presented` 走 `todo/write` 那條（模型工具問 `forCall` 拿到自己那一份），**但不在工具
 * 本體裡寫**：本體只記下這次要交付什麼，等 `tools/result` 說結果不是錯誤（照 dsh 的 `ctx.on('tools/result')`）
 * 再**同步**寫——被外層改判成錯誤的結果不發布交付。`tools/result` 在圍堵記 `tool/result` **之前**派發，所以交付落在
 * 配對的 `tool/result` **之前**（次序同 dsh：`tool/call → deliverables/presented → tool/result`）；#1286 之前的日誌
 * 是交付在結果之後，讀它的一方兩種都要收。見 [#441](https://github.com/DemianLi/nexus-agent/issues/441)、
 * [#1286](https://github.com/DemianLi/nexus-agent/issues/1286)。
 *
 * `context/measure` 走 `compaction/summary` 那條（摘要器外面包的一層，fold 逐個 agent 建），也寫得進
 * subagent 那份；web 只讀 root 那份。見 [#528](https://github.com/DemianLi/nexus-agent/issues/528)。
 *
 * `inbox/spliced` 是**只有一條路產得出來的第二種**（第一種是 `feedback/message-*`）：寫的是 web 的 pump，CLI 的 REPL
 * 一行一輪、沒有排隊。它記的是人送出、還沒開跑的那幾句，只寫 root 那一份。**它不進模型**：開跑那一刻的文字由
 * `turn/start` 帶，推模型歷史的一側不讀它。見 [#637](https://github.com/DemianLi/nexus-agent/issues/637)。
 *
 * `session/title` 兩個寫者各走一條舊路：web 的 pump 與 CLI 的 `runTurn`，都在自己寫下 `turn/start {kind:'message'}`
 * 的那一段裡接著寫（`apps/harness/src/session-title.ts`），只寫 root 那一份。**它不進模型**：推模型歷史的一側
 * 不讀它，同 dsh 的「log-only」。見 [#647](https://github.com/DemianLi/nexus-agent/issues/647)。
 *
 * `session/title` 另有第三個寫者、`session/title-llm-request` 只有它一個：LLM 標題（[#650](https://github.com/DemianLi/nexus-agent/issues/650)，
 * `apps/harness/src/session-title-llm.ts`）。它是 root 日誌的訂閱者，在背景跑，**寫在一輪之外**——主回覆不等它。
 * 兩顆都不進模型。
 *
 * `subagent/catalog` 兩個寫者各走一條舊路：前景走 `tool/call` 那條（圍堵登記、會話註冊點在子日誌出生時寫），背景走
 * 背景子代理的 host（它自己開子日誌的那一刻）。只寫父那一份，不進模型。見 [#1023](https://github.com/DemianLi/nexus-agent/issues/1023)。
 */
export type SessionEventType = keyof SessionEventMap;

/**
 * 一次核准的結局。**四值封閉，照 dsh 的 `ApprovalOutcome`**（`packages/interaction/user-approval/src/types.ts:34`，`5badb15`）：
 * `allowed-once` 是唯一的放行，其餘都不執行（fail closed）。見 `approval/decided`。
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * 一輪為什麼沒有正常結束。四種：
 *
 * - **`aborted`**：被中止。原因兩種：`user`（人按了停止）與 `parent`（父代理用 `interrupt_agent` 只停這個背景
 *   子代理當下那一輪，[#838](https://github.com/DemianLi/nexus-agent/issues/838)，dsh 同名，
 *   `subagent/src/continuation-activation.ts:323`，`477b4f4`）。dsh 的 `hook`／`disposed` 在我們這側沒有生產者，
 *   有了再加成員。**兩種都是「這一輪被打斷」**：讀 `reason.kind === 'aborted'` 的人（goal 續行、歷史、掃描）不看 `cause`。
 * - **`max-tokens`**：這一輪裡**至少一次** root 的模型回覆撞到輸出上限
 *   （[#433](https://github.com/DemianLi/nexus-agent/issues/433)）。照 dsh 的 `'max-tokens'`
 *   （`packages/core/session/src/types.ts:213-214`，`477b4f4`）：「at least one step reached its
 *   output-token ceiling」，後面的步正常收也不降級（sticky，`agent-loop/src/agent.ts:332-337`）。
 *   判法見 {@link ./max-tokens.ts}。中止蓋過它（`agent.ts:349-355`）。
 * - **`interrupted`**：行程在這一輪中間死了，**續接時補寫的收尾**（[#721](https://github.com/DemianLi/nexus-agent/issues/721)，
 *   {@link ./interrupted-turn.ts}）。照 dsh 的 `interrupted`（`packages/core/session/src/types.ts:215-221`，`477b4f4`）。
 *   它由續接那一刻的 agent 層寫，不是那一輪自己寫的：行程活著的時候沒有人寫得出它。**讀者把它當「這一輪不是正常
 *   結束」**；goal 續行不看它（續接回來的授權從 `disarmed` 起，且 `currentTurnStart` 不往 end-seed 之前找）。
 *
 * - **`blocked`**：這一輪的某一步在送出模型請求**之前**被準入閘門擋下，一個請求都沒發
 *   （[#633](https://github.com/DemianLi/nexus-agent/issues/633)，封存的會話：dsh 的 `ArchivedSessionGate` 在 `agent/pre-step`
 *   回 `reject`，迴圈把那一輪以 `{ kind: 'blocked' }` 收掉，`packages/core/agent-loop/src/agent.ts:316-319`，`5badb15009a`）。
 *   **被領走的輸入沒有進對話**：dsh 的 `user/message` 要到 pre-step 放行之後才寫（`agent.ts:419-423`），`consumed-work.ts` 明說
 *   「被擋下的那一輪把領走的訊息丟掉了，它帶走的工作不會再跑」。我們的 `turn/start` 照既有的登記帶著那句話的文字，所以日誌與歷史
 *   仍看得到使用者打了什麼；只有模型的對話狀態沒有它。**讀者把它當「這一輪沒有做事」**：goal 續行看到它不是看 `reason`，而是
 *   那一輪的目標預約被擋就把目標擋下（`prompt-rejected`，照 dsh `goal-round-driver/src/index.ts:403-415`）。
 *
 * dsh 另有 `completed`、`error`、`forked`：正常結束在我們這側是不放
 * `reason`，拋錯是另一顆 `turn/failed`，其餘沒有生產者。
 */
export type TurnEndReason =
  | { readonly kind: 'aborted'; readonly cause: { readonly kind: 'user' | 'parent' } }
  | { readonly kind: 'max-tokens' }
  | { readonly kind: 'interrupted' }
  | { readonly kind: 'blocked' };

/**
 * 一次模型呼叫沒有正常回來的方式（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）。
 *
 * 判準是**這一輪的中止訊號有沒有舉起來**（`turn-cancel.ts`），不是錯誤長什麼樣——被切斷的那次拋什麼要看供應商與抽法。
 */
export type ModelCallOutcome = 'error' | 'aborted';

/**
 * 一次模型請求失敗的穩定描述。照 dsh 的 `LlmFailure`（`packages/llm/llm/src/types.ts:45`）：訊息給人看，
 * `code` 給機器路由，`status` 是供應商回的 HTTP 狀態（有才帶）。
 *
 * `code` 的詞彙取 dsh 預設可重試集裡那幾個（`llm/src/retry-policy.ts:18`）：`RATE_LIMIT`、`SERVER`、
 * `TIMEOUT`、`TRANSPORT`——我們的重試只對這幾類發生。分類歸 adapter（`live-model.ts`），這裡只是形狀。
 * `turn/failed.error` 用同一個形狀（#434）；那裡的碼詞彙比這裡寬，見 `live-model.ts` 的 `classifyTurnFailure`。
 */
export interface LlmFailure {
  readonly message: string;
  readonly code: string;
  readonly status?: number;
}

/** 產生標題的那一次模型呼叫走的路由。照 dsh 的 `SessionTitleModelIdentity`。 */
export interface SessionTitleModelIdentity {
  /** 端點。dsh 是註冊過的 provider 名；我們只有一條 OpenAI 相容的連線，它的身分就是端點的根。 */
  readonly provider: string;
  /** 模型 id。 */
  readonly model: string;
}

/**
 * 一個標題是誰給的。見 `SessionEventMap['session/title']`。
 *
 * - `fallback`：第一則合格的人話照規則截出來的（#647）。
 * - `provider`：模型依第一則合格的人話產生的（#650）。`provider` 是產生器的身分，`model` 是那一次走的路由。
 *
 * - `user`：使用者改的名（[#633](https://github.com/DemianLi/nexus-agent/issues/633)，dsh `rename` 寫的那一種）。**釘住這個標題**：
 *   之後不會再有自動產生的標題蓋過它（退回標題本來就只在沒有標題時寫；模型標題在寫入前看到最後一顆是 `user` 就放棄）。`messageSeqs`
 *   是空陣列——沒有哪幾則人話推出它。
 */
export type SessionTitleSource =
  | { readonly kind: 'fallback' }
  | { readonly kind: 'user' }
  | {
      readonly kind: 'provider';
      readonly provider: string;
      readonly model?: SessionTitleModelIdentity;
    };

/** 送給標題模型的一則訊息。只有文字，所以只存字串。 */
export interface SessionTitleLlmMessage {
  readonly role: 'user';
  readonly content: string;
}

/**
 * 引用別的會話時，快照裡每一條來源留下的事實（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）。
 * 照 dsh 的 `SessionReferenceSource.references[]`（`packages/context/session-reference/src/types.ts`，`477b4f4`）。
 */
export interface SessionReferenceSourceEntry {
  /** 被引用的會話。 */
  readonly sessionId: string;
  /** 使用者看到的標題（mention 上的那一個）。 */
  readonly label: string;
  /** 被引用那份日誌的格式版本。 */
  readonly capturedFormatVersion: number;
  /** 快照涵蓋到被引用那份日誌的哪一顆事件；日誌是空的就是 `null`。 */
  readonly capturedThroughSeq: number | null;
  /** 被引用的會話壓縮過（快照裡有一則摘要）。 */
  readonly compacted: boolean;
  readonly originalMessages: number;
  readonly retainedMessages: number;
  readonly omittedMessages: number;
  readonly omittedBytes: number;
  readonly truncated: boolean;
  /** 這一條在使用者那句話的引用裡排第幾（去重之後）。 */
  readonly inputIndex: number;
}

/** `user/message` 是誰塞的，見 {@link SessionEventMap} 的 `user/message`。 */
export type UserMessageSource =
  | { readonly kind: 'plugin'; readonly plugin: string }
  | {
      readonly kind: 'user';
      /**
       * 客戶端給這句話的請求編號（`run.start` 的 `request_id`，[#1335](https://github.com/DemianLi/nexus-agent/issues/1335)），
       * 就是 dsh 的 `rpcId`。只有輪中插話被領走時記的這一顆帶得到它（一輪開頭那句在 `turn/start`）。客戶端沒帶就整個不放
       * 這個 key。**格式 48 起才有**。
       */
      readonly requestId?: string;
    }
  | {
      readonly kind: 'session-reference';
      /** 從別的會話日誌裡抬出來的素材（dsh 的 `recall` 形式）。 */
      readonly form: 'recall';
      readonly version: 1;
      readonly references: readonly SessionReferenceSourceEntry[];
    }
  | {
      readonly kind: 'subagent-settled';
      /** 執行期自己的記帳，不展開就能看（dsh 的 `notice` 形式）。 */
      readonly form: 'notice';
      /** 一行摘要，說這個背景子代理怎麼收的。 */
      readonly summary: string;
      /**
       * 怎麼收的（#884）。**選填只為了格式 26 以前的日誌**：沒帶就是不知道，畫面退成中性的說法，不假裝成「已完成」。
       */
      readonly reason?: SubagentSettleReason;
      /** 結算的那個背景子代理的會話 id。 */
      readonly senderSessionId: string;
    }
  | {
      readonly kind: 'agent-message';
      /** 另一個 agent 明確寫給這條會話的話（dsh 的 `relay` 形式）。 */
      readonly form: 'relay';
      /** 寄件的會話 id。內容是寄件人自己選的話，所以與 `subagent-settled` 分開，記帳不能被呈現成子代理寫的。 */
      readonly senderSessionId: string;
    };

/** 每一種事件帶什麼。 */
export interface SessionEventMap {
  /**
   * 一輪開始。`resume` 是回覆核准，它沒有使用者說的話。
   *
   * ## `kind` 是**授權的判別欄**，不是一個給人看的標籤
   *
   * 這個聯集的成員決定「這一輪背後有沒有一個人」，而
   * `@nexus/plugin-goal` 的 `authority.ts` 拿它當執行時的權限判準。所以**加一個成員就是
   * 開一條新的授權路徑**：`goal` 這一種是機器自己排的，它不帶人類授權。
   *
   * dsh 的對應物是 `user/message` 上的 `source` 欄（`packages/core/session/`，對讀版本
   * `d347e703908d0406b7a7ef80e3a0e594d86b2215`）。**我們不另外加一個平行的 `source`
   * 欄**：這個酬載已經是 `kind` 判別的聯集，多一個判別式就有兩個真相，而讀錯哪一個都
   * 不會紅。
   *
   * `goal` 那幾格**全部必填**。選填的話，一個忘記填的生產者會讓「缺席」被當成人類，
   * 而那正是這個判別欄要擋的東西。
   */
  'turn/start':
    | {
        readonly kind: 'message';
        readonly text: string;
        /**
         * 這句話帶的附件（[#732](https://github.com/DemianLi/nexus-agent/issues/732)），照選取順序，**只放參照**：位元組在日誌之外
         * （`apps/harness` 的 `attachment-store.ts`）。沒有附件就整個不放這個 key。送進模型的 `HumanMessage` 由它和 `text` 造
         * （`message-source.ts` 的 `humanMessageForTurnStart`），重放用同一個函式。
         *
         * **格式 38 起才有**，而且不標 `ignorable`：一台 37 的 runtime 讀到會把它略過，排著的項目被折回來重跑時附件就悄悄不見了。
         */
        readonly attachments?: readonly AttachmentRef[];
        /**
         * 這句話點名派哪一個子代理（[#328](https://github.com/DemianLi/nexus-agent/issues/328) 第 2 項，`run.start` 的 `mention`）。沒有點名就整個不放這個 key。
         * 送進模型的 `HumanMessage` 由它和 `text` 造（同 `attachments`），形狀見 `subagent-mention.ts`。
         *
         * **格式 42 起才有**，而且不標 `ignorable`：一台 41 的 runtime 讀到會把它略過，排著的項目被折回來重跑時點名就悄悄不見了。
         */
        readonly mention?: SubagentMentionRef;
        /**
         * 客戶端給這句話的請求編號（`run.start` 的 `request_id`，[#1335](https://github.com/DemianLi/nexus-agent/issues/1335)）。
         * 照 dsh 落在 `user/message` 的 `source.rpcId`（`packages/api/session-controller/src/commands.ts:331-335`，`d7432673886`）；
         * 我們一輪開頭那句人話記在這裡（見本事件的偏離），所以放在這一顆。客戶端沒帶就整個不放這個 key。
         *
         * **和 `runId` 一起寫、一起缺**：重送認出這個編號時要回原本那一件的 `run_id`，而領走之後佇列項目就不在收件匣上了。
         * **格式 48 起才有**，不標 `ignorable`：一台 47 的 runtime 會略過它，重啟之後同一個編號再送就排第二次，沒有任何東西報錯。
         */
        readonly requestId?: string;
        /** 這句話在送出佇列裡的 id，也就是 `run.start` 回給客戶端的 `run_id`；只在帶 `requestId` 時才寫。 */
        readonly runId?: string;
      }
    | { readonly kind: 'resume' }
    | {
        readonly kind: 'agent-message';
        /**
         * 送進模型的那一串字，**含 dsh 的前綴** `Agent <寄件人> sent a message: `。這一份與圖那一份是同一個值。
         * 前綴是模型分辨「這是父代理說的、不是任務本身」的唯一線索，所以記進日誌的就是它。
         */
        readonly text: string;
        /**
         * 寄件的會話 id（父代理）。照 dsh 的 `AgentMessageSource`（`subagent/src/continuation-messages.ts`，`477b4f4`）：
         * **只記寄件人，不授予權限**。這一輪背後沒有人：`hasDirectHumanTurn` 對認不得的 `kind` 停住回假，
         * 所以它拿不到直接人類授權（#152 的底線）。
         */
        readonly senderSessionId: string;
      }
    | {
        readonly kind: 'subagent-settled';
        /**
         * 送進模型的那一串字：一行摘要，加上子代理最後一則回覆的非空文字（沒有就是 `It left no closing message.`）。
         * **這一份與圖那一份是同一個值**。
         */
        readonly text: string;
        /** 一行摘要，同 {@link UserMessageSource} 的 `subagent-settled`。 */
        readonly summary: string;
        /** 怎麼收的，同 {@link UserMessageSource} 的 `subagent-settled`。 */
        readonly reason?: SubagentSettleReason;
        /**
         * 結算的背景子代理的會話 id。照 dsh 的 `SubagentSettledMessageSource`（`subagent/src/continuation-messages.ts`，`477b4f4`）：
         * 這是**執行期自己的記帳**，不是人說的話、也不是子代理自己寫的話（所以不併進 `agent-message`）。
         * 這一輪背後沒有人：`hasDirectHumanTurn` 對認不得的 `kind` 停住回假（#152 的底線）。
         */
        readonly senderSessionId: string;
      }
    | {
        readonly kind: 'goal';
        /** 送進模型的那一串字。**這一份與圖那一份是同一個值**，見 `thread-pump.ts`。 */
        readonly text: string;
        /** 這一輪是為哪一個目標排的。 */
        readonly goalId: GoalId;
        /** 排它的時候那個目標的修訂號。對不上就不是同一份目標了。 */
        readonly revision: number;
        /** 第幾輪，從 1 起算。折疊拿它推進 `roundsStarted`。 */
        readonly round: number;
      };
  /**
   * 一輪結束——**跑完與停在核准點都算**，停在核准點時前面會有一顆 `interrupt/raised`。
   *
   * **被人中止的那一輪也以這一顆收尾，帶 `reason`**；正常結束時整個不放這個 key（同
   * `command/done` 的 `text`）。照 dsh 的 `turn/end {reason: {kind: 'aborted', reason: cause}}`
   * （`packages/core/session/src/types.ts:203`，`c291e79`），dsh 沒有 `turn/cancelled`。
   * 內層那一格叫 `cause` 不叫 dsh 的 `reason`：外層已經叫 `reason`，兩層同名讀起來會混
   * （[#265](https://github.com/DemianLi/nexus-agent/issues/265) 的 Q5）。
   *
   * **撞到輸出上限的那一輪一樣帶 `reason`**（`max-tokens`，#433），見 {@link TurnEndReason}。
   *
   * **讀它判「這一輪收了、可以接著排」的人要看這一格**：中止之後 goal 不續行、撞到上限之後
   * goal 收回續行授權（`goal-driver.ts`）。
   */
  'turn/end': { readonly reason?: TurnEndReason };
  /**
   * 一輪拋錯結束。訊息之外帶一份分類（[#434](https://github.com/DemianLi/nexus-agent/issues/434)），堆疊不進日誌。
   *
   * **`error` 是選填，舊日誌沒有**：那時只有 `message`，讀的人要容忍缺欄位（缺就是缺，不是 `UNKNOWN`）。新日誌四個寫入點
   * （`thread-pump` 兩處、`cli`、背景子代理）一律帶，不是模型的錯也帶——`code` 是 `UNKNOWN`，同 dsh
   * （`packages/core/session/src/types.ts:206-210`）。碼的詞彙與判法見 `live-model.ts` 的 `classifyTurnFailure`。
   *
   * **與 dsh 的形狀差（偏離登記）**：dsh 沒有這顆事件，失敗放在 `turn/end` 的 `reason: { kind: 'error', error: LlmFailure }`。
   * 獨立的 `turn/failed` 從 #98 就在，二十個非測試的讀者（goal 續行、歷史、統計、遙測、軌跡、token 用量…）都認它。
   * **這裡退的不是「基座表達不出來」，是改動面**：照 dsh 搬要動那些讀者、升日誌格式版本、而且舊日誌的 `turn/failed`
   * 得永遠雙讀。`error` 的形狀照 dsh 的 `LlmFailure`，搬家那天這個欄位原封不動搬進 `reason`。
   */
  'turn/failed': { readonly message: string; readonly error?: LlmFailure };
  /** 掛上了一顆等人回答的中斷。 */
  'interrupt/raised': { readonly interruptId: string };
  /**
   * 一顆中斷（或其中幾個 key）**不是人答的，是系統代答的**（[#1098](https://github.com/DemianLi/nexus-agent/issues/1098)，MCP 反問）。
   *
   * 日誌上人的回答只有「那一輪是 `turn/start { kind: 'resume' }`」這一個痕跡，分不出是誰按的；代答的那一輪要讓讀的人看得出
   * 這不是人的決定。`reason` 是為什麼不問人（`url-mode`：網址授權一律回絕；`subagent`：子代理背後沒有人），`keys` 是被代答的
   * 反問 key（`interrupt/raised` 只記 id，反問的內容不進日誌）。代答一律是回絕，沒有代人同意的路。
   *
   * 寫在回答它的那一輪裡（`turn/start` 之後），同 `approval/decided`。標 `ignorable`：純資訊，不進模型、不左右重建（#507）。
   */
  'interrupt/system-answered': {
    readonly interruptId: string;
    readonly reason: string;
    readonly keys: readonly string[];
  };
  /**
   * 核准閘門把一個問題擺到了人面前（或確定沒有人可以問）——**只做審計，不進模型、不左右任何折疊**
   * （[#1029](https://github.com/DemianLi/nexus-agent/issues/1029)，翻了 [#220](https://github.com/DemianLi/nexus-agent/issues/220)
   * 的「認帳不做」：側欄是第一個消費者）。
   *
   * 照 dsh 的同名事件（`packages/interaction/user-approval/src/types.ts:44-58`，`5badb15`）：`id` 配對隨後那顆
   * `approval/decided`，`toolName` 是被問的工具，`callId` 是那一次呼叫（配得上 `tool/call`），`reason` 是發問的一方
   * 寫的人話。**每一顆 asked 最後都該有一顆同 `id` 的 decided**；停在核准點的那一輪若沒人答，那一對就是開著的，
   * 讀的人照「還在等」表態，不是推一個結果。
   *
   * **兩條路寫它**：人那條由 pump 在記 `interrupt/raised` 的同一刻寫，`id` 就是那顆中斷的 `interruptId`
   * （閘門在圖內、續接時會從頭重跑，在 `interrupt()` 之前寫會寫成兩筆）；不必問人就確定結果的
   * （政策關掉、沒有管道、子代理）由閘門在圖內一次寫一對，`id` 是新產的。
   *
   * 標 `ignorable`：它不進模型也不左右重建，舊 runtime 略過它是對的（#507，所以不升格式版本）。
   *
   * ⚠️ `reason` 是發問的一方寫的字，可能帶工具參數裡的片段，原樣進本機日誌；**會話遙測的鏡像是預設放行**
   * （`isMirroredEvent` 只擋 `request/header` 與 `request/system`），所以它跟 `tool/call` 的參數一樣會被鏡像出去
   * ——要擋就在 `isMirroredEvent` 明列，不要靠這裡的說明。
   */
  'approval/asked': {
    readonly id: string;
    readonly toolName: string;
    readonly callId?: string;
    readonly reason?: string;
  };
  /**
   * 一次 `approval/asked` 的結局（同 `id`），**每一顆 asked 至多一顆**。
   *
   * 詞彙照 dsh 的 `ApprovalOutcome`：`allowed-once` 是唯一的放行；`rejected` 是人按了拒絕，**也是政策關掉核准時的確定性
   * 拒絕**（dsh 同：`approval` 服務在 `never` 政策下直接回 `rejected`）；`cancelled` 是問題在被答之前被收回（按了停止）；
   * `unavailable` 是沒有人可以答（沒有管道）。**fail closed**：除了 `allowed-once` 都不執行。
   *
   * 「是誰拒的」在 dsh 靠 `approval/policy` 事件分；我們多一格「入口沒有人在」（不進日誌），所以日誌上分人拒與政策拒
   * 最準的是那一次 `tool/result` 的碼（`APPROVAL_REJECTED_BY_USER`／`APPROVAL_POLICY_NEVER`／
   * `APPROVAL_NO_CHANNEL`，見 `tool-events.ts`）。
   */
  'approval/decided': {
    readonly id: string;
    readonly outcome: ApprovalOutcome;
  };
  /**
   * 這個會話的**核准政策**現在是哪一格（[#437](https://github.com/DemianLi/nexus-agent/issues/437)）：`ask` 去問人、`never` 一律回絕。
   * **每一筆帶整個值**，不是差異。照 dsh 的同名事件（`packages/interaction/user-approval/src/index.ts:100-104`，`5badb15`）。
   *
   * ## 誰寫它
   *
   * root：`ApprovalPolicyController`（`approval-policy.ts`）接上日誌的當下寫一顆**起始值**，之後每一次真的變了的切換各寫一顆；
   * 切到已經生效的那一格不寫。**子代理的日誌只有一顆、帶 `source: 'delegation'`**：委派時一律釘成 `never`（照 dsh
   * `child-agent.ts:254-275`），子代理之後都照它，root 再切不影響——所以要記在子代理自己的日誌上，讀的人才答得出。
   *
   * ## 為什麼不標 `ignorable`、而且升格式版本（34）
   *
   * 同 `sandbox/mode`、也同 dsh（dsh 的 `append('approval/policy', …)` 沒有略過旗標）：它**左右續接之後的行為**。一台 33 的舊 runtime
   * 讀到它若只是略過，會把一份記著 `never` 的日誌當 `ask` 續接；拒絕讀才是 fail-closed 的方向。
   *
   * ## 缺席的意思
   *
   * #437 以前的日誌沒有這一顆：續接時照 `ask` 起算，也就是以前的行為。**入口沒有人在**（CLI、評測）是另一件事，不寫在這裡，
   * 由組裝時的核准管道表達（`ApprovalChannel`）。
   */
  'approval/policy': {
    readonly policy: ApprovalPolicyValue;
    /** 子代理日誌上委派時寫的那一顆；省略是 root 的起始值或一次切換。照 dsh 同名欄位。 */
    readonly source?: 'delegation';
  };
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
   *
   * ## 失敗與中止的呼叫也記（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）
   *
   * 帶 `outcome` 的是**沒有正常回來的那次呼叫**，供應商在串流裡報了用量才記（照 dsh 的 `assistant/attempt`：串流最後一個
   * `usage` chunk 算數）。數字一樣進總帳——那些 token 真的花掉了。**沒報就沒有這顆**，不是 0：「燒了但不知道燒多少」靠
   * 配對的 `model/end.outcome` 看出來，兩者分得開。重試掉的中間幾次拿不到（SDK 的重試在記錄器底下，見 `llm-retry.ts`）。
   * 沒有 `outcome` ＝ 正常回來的那次，舊日誌全是這一種。
   */
  'model/usage': {
    /**
     * **未快取**的輸入 token（[#724](https://github.com/DemianLi/nexus-agent/issues/724)，格式 36 起；照 dsh `TokenUsage.inputTokens`）。
     * 這次請求完整的 prompt 是它加上下面兩格（`promptTokensOf`）。供應商沒報快取細節時就是整個 prompt——35 以前的日誌全是這一種，
     * 所以舊檔照舊讀就是對的。
     */
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly totalTokens: number;
    /** 命中快取、從快取讀出來的輸入 token。**缺席＝沒記，不是 0**（舊日誌、供應商沒報快取細節）。 */
    readonly cacheReadTokens?: number;
    /** 寫進快取的輸入 token。缺席＝沒記。 */
    readonly cacheWriteTokens?: number;
    /**
     * 這次呼叫沒有正常回來：`error` ＝ 拋錯，`aborted` ＝ 使用者按了停止。**只有失敗那一種才帶這一格。**
     * 讀者**都照常讀**：加總的照加，「目前大小」讀最新一筆的也照讀——同 dsh，它的 `contextPressure` 連
     * `assistant/attempt` 的用量也取樣（那份請求真的送出去過，prompt 大小是真的）。名字借 dsh `TurnEndReason` 的
     * `kind`（`aborted`／`error`，`core/session/src/types.ts:204-212`）。
     */
    readonly outcome?: ModelCallOutcome;
    /**
     * 所屬那次模型呼叫，值是它的 `model/start` 的 `seq`（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)，見 `model-call-scope.ts`）。
     * 舊日誌與寫入點不在呼叫範圍裡時沒有這一格——讀的人標「—」，不是推位置。
     */
    readonly modelCall?: number;
  };
  /**
   * 一次模型呼叫開始了。與下一顆 `model/end` 配對；會話統計拿這一對數步數、量模型耗時
   * （`session-stats.ts`）。**這一顆的 `seq` 就是這次呼叫的識別**（#1021）：`model/end` 等事件的 `modelCall` 指它。
   *
   * **這不是 dsh 的 `step/start`，名字是故意換的**：dsh 的一步包含它派發的工具，`step/end` 在
   * 工具之後；這一對只包模型那一段，工具事件落在 `model/end` **之後**。顆數對得上（一步一次
   * 模型請求），時刻對不上。理由見 `model-calls.ts`。
   *
   * **`route`：這次請求實際走的模型與強度**（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）。照 dsh 的
   * `requestHeader().config`：換模型的通知拿「最近一次請求走的路由」跟這一步選定的比，續接沒選過的會話也先沿用它，再沒有才讀
   * 部署預設。認不出路由的呼叫（沒貼標籤、也沒報名字的模型替身）不放這一格；格式 37 以前的日誌沒有它。選填、不影響別的讀者。
   */
  'model/start': { readonly route?: ModelRoute };
  /**
   * 使用者替這條會話選了下一步起用的模型與推理強度（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）。
   *
   * 照 dsh 的 `model/selection`（`packages/api/session-controller/src/agent.ts:333-336`，`5badb15`）：通過型錄驗證之後才寫，**記意圖**；
   * 實際走了哪一顆由後面每次請求的 `model/start.route` 說。**選擇從下一步生效，跑著的那一步不換。**
   * `reasoningEffort` 缺席＝預設行為（`'default'` 在寫入前就正規化掉）。
   *
   * **不標 `ignorable`、格式 37**：它左右續接之後走哪一顆模型，一台 36 的 runtime 略過它會悄悄換回別顆。**不進模型**
   * （換模型的通知是另一顆 `user/message`）。
   */
  'model/selection': { readonly modelId: string; readonly reasoningEffort?: string };
  /**
   * 配對的那次模型呼叫結束了——**完成、拋錯、中止都記**（在 `finally` 裡），同 dsh 那條「每一
   * 個進入的步恰好一顆 `step/end`」。
   *
   * **`outcome` 只在沒有正常回來時帶**（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）：拋錯是 `error`、
   * 使用者按了停止是 `aborted`，兩者同 {@link ModelCallOutcome}。這一格讓「這次呼叫燒了多少不知道」讀得出來——配對的
   * `model/usage` 不在，而這裡有 `outcome`。沒有這一格 ＝ 正常回來，或舊日誌（那時只能看後面有沒有 `turn/failed`）。
   *
   * 沒配到 `model/end` 的 `model/start` 只有一種成因：行程在呼叫中途死了。
   */
  'model/end': {
    /** 這次呼叫沒有正常回來的方式；正常回來沒有這一格。 */
    readonly outcome?: ModelCallOutcome;
    /**
     * 所屬那次模型呼叫，值是它的 `model/start` 的 `seq`（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)，見 `model-call-scope.ts`）。
     * 舊日誌與寫入點不在呼叫範圍裡時沒有這一格——讀的人標「—」，不是推位置。
     */
    readonly modelCall?: number;
  };
  /**
   * 這次呼叫**實際送出**的呼叫設定與工具清單，**變了才記一份**（[#1020](https://github.com/DemianLi/nexus-agent/issues/1020)）。
   * 照 dsh 的 `request/header`（`packages/core/session/src/types.ts:390-397`，`5badb15`）。記錄點在模型被叫的那一刻
   * （callback），不是 middleware——見 `request-snapshot.ts` 檔頭，那裡有偏離與理由。
   *
   * **不進模型**，用 `{ ignorable: true }` 寫（純資訊性的新種類不升格式版本，#507）；會話遙測的鏡像**不送**它
   * （`isMirroredEvent`）。⚠️ 工具描述與設定值原樣進本機日誌。
   *
   * 落在配對的 `model/start` 之後、回覆之前；`modelCall` 指回記下它的那次呼叫。這份日誌沒有快照時第一份的
   * `reason` 是 `'initial'`，之後不同才記、`reason` 是 `'change'`；**續接後沒變不重記**（偏離 dsh 的 `'resume'`）。
   */
  'request/header': {
    readonly header: RequestHeader;
    readonly reason: RequestSnapshotReason;
    readonly modelCall?: number;
  };
  /**
   * 這次呼叫**實際送出**的系統提示詞全文，**變了才記一份**（#1020）。dsh 的對應物是 `system/message`——它是模型可見的
   * surface 節點、對話史從它導出；這一顆**只是快照、不進模型**，所以換了名字（理由見 `request-snapshot.ts`）。
   * 沒有系統提示詞時第一份是空字串（明著記「沒有」，不是「沒記」）。其餘規則同 `request/header`。
   *
   * ⚠️ **系統提示詞可能含工作區內容**（AGENTS.md、記憶檔），原樣進本機日誌，**不進遙測**。
   */
  'request/system': {
    readonly system: string;
    readonly reason: RequestSnapshotReason;
    readonly modelCall?: number;
  };
  /**
   * 一次模型請求失敗、而且**排定了重試**（[#712](https://github.com/DemianLi/nexus-agent/issues/712)）。照 dsh 的
   * `llm/retry`（`packages/llm/llm-retry/src/types.ts:9`）：排定時先寫，再開始等。**只記排定、不記完成**——
   * 成敗看後面的 `model/end`／`turn/failed`；預算用盡的那一次不排，所以不寫。
   *
   * SDK 層的重試（#712）落在一次模型呼叫的 `model/start`／`model/end` 之間（重試包在那一對之內），一次呼叫的所有重試共用一個
   * `retryId`。**串流中段出錯的整次重打（#520，`stream-retry.ts`）的在兩對之間**：失敗那一對已經收尾、下一對還沒開，由 `modelCall`
   * 指回失敗的那次；所有讀的人靠 `modelCall` 歸屬、不靠落在哪一對之間（`indexModelCalls`、軌跡投影、token-meter 都是；
   * token-meter 的 `llm/retry-started` 在呼叫之外不扣牆鐘，因為退避本來就不在起訖之內）。**不進模型**：推模型歷史的一側不讀。
   *
   * 欄位比 dsh 少，理由與計數的壽命見 {@link ./llm-retry.ts}：SDK 層沒有 `delayMs`（接縫看不到退避）、沒有
   * `turn`（由 `seq` 推）。`step` 的對應物是 `modelCall`（#1021）：所屬那次呼叫的 `model/start` 的 `seq`。
   */
  'llm/retry': {
    readonly retryId: string;
    /** 第幾次重試，從 1 起算。 */
    readonly retry: number;
    readonly maxRetries: number;
    readonly failure: LlmFailure;
    /**
     * 排定要等多久（毫秒，已含抖動）。**只有串流中段出錯的重打有**（[#520](https://github.com/DemianLi/nexus-agent/issues/520)，
     * `stream-retry.ts` 自己算退避）；**SDK 層（#712，`llm-retry.ts`）沒有這一格**——`onFailedAttempt` 在 `p-retry` 算退避之前就被叫，
     * 事前不可知，那一側的實際等待看配對的 `llm/retry-started.waitedMs`。
     */
    readonly delayMs?: number;
    /**
     * 所屬那次模型呼叫，值是它的 `model/start` 的 `seq`（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)，見 `model-call-scope.ts`）。
     * 舊日誌與寫入點不在呼叫範圍裡時沒有這一格——讀的人標「—」，不是推位置。
     */
    readonly modelCall?: number;
  };
  /**
   * 排定的那次重試等完、**真的要重打**了。與同一個 `retryId` 與 `retry` 的 `llm/retry` 配對；等待中被取消的
   * 重試沒有這一顆（{@link ./llm-retry.ts} 的「取消之後不再寫」）。`waitedMs` 是**實際**等了多久——dsh 在
   * `llm/retry` 上帶的是排定的 `delayMs`，這裡的接縫拿不到。
   */
  'llm/retry-started': {
    readonly retryId: string;
    readonly retry: number;
    readonly waitedMs: number;
    /**
     * 所屬那次模型呼叫，值是它的 `model/start` 的 `seq`（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)，見 `model-call-scope.ts`）。
     * 舊日誌與寫入點不在呼叫範圍裡時沒有這一格——讀的人標「—」，不是推位置。
     */
    readonly modelCall?: number;
  };
  /**
   * 一次模型呼叫回來的那一則回覆，**模型看到的原樣**：文字、推理、`tool_calls` 都在 `message` 裡
   * （{@link ./logged-message.ts | LoggedMessage}）。推模型歷史的一側讀的就是它。
   *
   * 照 dsh 的 `assistant/message`（`packages/core/session/src/types.ts:321-329`，`c291e79`）：每一次模型
   * 呼叫收尾時一顆，不逐字寫。**寫在配對的 `model/end` 之前**，所以順序同 dsh——回覆在前，它派發的
   * `tool/call` 在後。記的是 {@link ./invalid-tool-args.ts} 改寫過的那則（那顆在它內側）：解不開的呼叫
   * 在這裡是 `args: {}`，原字串在配對的 `tool/call.arguments`——同一次呼叫兩處不同，但這一則才是之後
   * 回送給供應商的那則。撞到輸出上限的那則也是清過呼叫之後的樣子（{@link ./max-tokens.ts}，排得更內側）：
   * 沒有 `tool_calls`，`response_metadata.finish_reason` 原樣留著。
   *
   * ## `interrupted`
   *
   * 人按了停止、畫面上已經有字時，那半段以這一顆記下，帶 `interrupted: true`；正常的回覆整個不放
   * 這個 key。**這一顆由 pump 在這一輪收尾時寫，落在 `model/end` 之後**——被切斷的那次呼叫在寫入點
   * 看到的是拋錯，不是回覆。一個字都沒送出就整顆不寫，同 dsh：沒有看得見的內容就不算一則回覆。
   * 子代理那一層被切斷時回的空訊息同理不寫（`turn-cancel.ts` 的 `stopHere`）。
   *
   * ## 對 dsh 的三處偏離
   *
   * - **沒有 `stream`**（逐字的時間紀錄）。dsh 重播用的是整則訊息；`stream` 只在串流中途斷線、要把
   *   還在跑的那次接回來時用，而我們沒有中途重接（wire 拒收 `since`）。寫入點也看不到逐字片段：v3 的
   *   逐字片段不走模型層的回呼，只有 pump 看得到。
   * - **`assistant/attempt` 只在串流中途失敗又整次重打時才有**（#520，見下一格）。其餘失敗、沒產出看得見內容的那一次，
   *   dsh 記下它的串流；我們沒有 `stream` 可記，那一次在日誌上是一對中間沒有 `assistant/message` 的 `model/start`／`model/end`。
   * - **沒有 `turn`，也沒有 `usage`**。`turn` 同 `tool/call`（由 `seq` 推）；`step` 的對應物是 `modelCall`（#1021，
   *   所屬那次呼叫的 `model/start` 的 `seq`）；用量另有 `model/usage`，而 `message` 裡的 `usage_metadata` 本來就在。
   *
   * ⚠️ **回覆全文原樣進本機日誌、也原樣進遙測**，同 `tool/call` 的 `arguments`。
   */
  'assistant/message': {
    readonly message: LoggedMessage;
    readonly interrupted?: true;
    /**
     * 所屬那次模型呼叫，值是它的 `model/start` 的 `seq`（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)，見 `model-call-scope.ts`）。
     * 舊日誌與寫入點不在呼叫範圍裡時沒有這一格——讀的人標「—」，不是推位置。
     */
    readonly modelCall?: number;
  };
  /**
   * 一次**作廢的**模型嘗試吐出來的部分回覆（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）：串流在第一則事件之後出錯，
   * 整次重打（{@link ./stream-retry.ts}）之前，畫面上已經有字的那一半。照 dsh 的 `assistant/attempt`
   * （`packages/core/session/src/types.ts`，`5badb15009a`）：「一次沒有落進對話的模型嘗試」，留下它吐了什麼，不編造模型可見的歷史。
   *
   * **不進模型**，用 `{ ignorable: true }` 寫（純資訊性的新種類不升格式版本，#507）；推模型歷史的一側不讀。**由 pump 寫**
   * ——只有它握有那半段文字（同 `assistant/message` 的 `interrupted`），在**失敗當下**收到 `stream-retry.ts` 的通知時寫：落在失敗那一對
   * `model/start`／`model/end`（`outcome: 'error'`）與配對的 `llm/retry` 之後、下一次嘗試的 `model/start` 之前（等退避時按停止也有這一顆）。
   * `modelCall` 指回失敗那一對。
   *
   * 畫面據它送一顆 `message-discard`（`@nexus/wire`，酬載是 `messageId`）擦掉那則回覆。dsh 的是精確的計時串流記錄
   * （`AssistantStreamRecord[]`），我們留的是被擦掉的那則的文字與推理——我們的日誌沒有逐片段的串流記錄。
   *
   * ⚠️ **回覆內容原樣進本機日誌、也原樣進遙測**，同 `assistant/message`（遙測預設放行，這一顆沒有理由例外）。
   */
  'assistant/attempt': {
    readonly message: LoggedMessage;
    /** 被作廢的那次呼叫的 `model/start` 的 `seq`（它的 `model/end` 是 `outcome: 'error'`）。拿不到就沒有這一格。 */
    readonly modelCall?: number;
  };
  /**
   * 塞進對話的一則 user-role 訊息。兩種來源：
   *
   * - **`plugin`：外掛塞的，不是人打的字**。照 dsh 的 `user/message` 帶 `source: {kind: 'plugin', plugin}`
   *   （`packages/llm/llm/src/message.ts`，`c291e79`；repeat-tool-reminder 與 tool-goal 都這樣注入）。今天兩個生產者：
   *   - repeat-reminder 的提醒，`plugin` 是那顆 middleware 的名字。落在它提醒的那次模型呼叫的
   *     `model/start` 之前，同 dsh 在 `agent/pre-step` 注入。
   *   - goal 收尾時注入的那段指示，`plugin` 是回它的那顆**工具**的名字：它包在工具回的 `Command` 裡，
   *     由圍堵讀出來，而圍堵只知道工具、不知道工具屬於哪個 plugin。落在那次呼叫的 `tool/result` 之後，
   *     同它在對話裡的位置。
   * - **`user`：人在一輪跑著時插的話**（[#710](https://github.com/DemianLi/nexus-agent/issues/710)），照 dsh 輪中領走
   *   `next-step` 時寫的 `user/message`（`packages/core/agent-loop/src/agent.ts:403-405`，`477b4f4`）。**唯一的生產者是
   *   pump 領走插話的那條路**（`apps/harness/src/thread-pump.ts`），緊跟在領走那顆 `inbox/spliced` 後面、那次模型呼叫
   *   的 `model/start` 之前。goal 的直接人類授權認它（dsh `packages/goal/tool-goal/src/authority.ts:82-83`），所以外掛
   *   與工具不能寫這一種：上面兩個生產者都寫死 `plugin`。
   *   **子代理日誌上的 `user` 不是人**（[#1159](https://github.com/DemianLi/nexus-agent/issues/1159)）：前景子代理出生時，註冊表
   *   在它自己的日誌開頭寫一顆 `user`，內容是父模型寫的委派指示（`registry.ts` 的 `expectSpawn`），同 dsh
   *   `child.followup(createUserMessage({content: prompt, source: {kind: 'user'}}))`；背景子代理插話的 `user` 也在子日誌上。
   *   這不構成授權：goal 的三顆工具 `rootOnly`，授權只讀 root 那一份日誌。**讀 `user` 當「有人在場」的人，要先確定讀的是 root。**
   *
   * - **`session-reference`：引用別的會話時附上的快照**（[#713](https://github.com/DemianLi/nexus-agent/issues/713)），照 dsh 的
   *   `user/message` 帶 `source: {kind: 'session-reference', form: 'recall', version: 1, references}`。緊跟在引用它的那句人話後面
   *   （一輪開頭的是 `turn/start` 與領走那顆 `inbox/spliced` 之後，插話的是那句 `user` 來源之後），**內容凍在這一顆裡**：續接與重播
   *   讀的是這一份，不重讀被引用的會話。**它不是人打的字**——goal 的直接人類授權只認 `user`（正向判準），畫面不當人話畫，
   *   內容搜尋不收（不然別的會話的字會讓這一條被搜到）。唯一的生產者是 pump 的準備那一步（`apps/harness/src/session-reference.ts`）。
   *
   * **偏離**：dsh 一輪開頭那句人話也是 `user/message`；我們的在 `turn/start`，而那一格是授權的判別欄，不動它。
   * 所以一輪開頭的人話不在這裡，只有輪中插的話在。**`turn/start.text` 記的是換過的 `@標題`**，同 dsh 落在 `user/message` 的是換過的內容
   * （`prepareDirectMessages`）：引用網址不進日誌，網頁要的「哪一段對應哪條會話」由後面那顆快照的 `references` 帶。
   *
   * ⚠️ 原樣進遙測；快照是**別的會話的內容**，共享策略按這一份算，不按被引用的那份算。
   */
  'user/message': {
    readonly message: LoggedMessage;
    readonly source: UserMessageSource;
  };
  /**
   * 把幾張圖永久從之後每一次模型請求裡省略（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)，#732 第 8 項）。
   *
   * ## 為什麼有這一種
   *
   * 看圖模型的請求有張數與位元組的額度（型錄的 `imageBudget`），圖一多請求就超過端點收得下的量。dsh 的做法（`packages/compaction/
   * compaction-image-offload`，`5badb15009a`）：adapter 量到超額就以 `IMAGE_OFFLOAD_REQUIRED` 失敗（帶還要省略幾張），上層接住、**記一筆這個決定**、把**最舊的**幾張換成佔位字再送一次，之後每一次請求都沿用。我們照做（見 `image-offload.ts` 檔頭）。
   *
   * ## 欄位
   *
   * 逐字照 dsh `image/offload`：`targets` 非空；每一格 `seq` 是**會產出訊息的那一顆事件**的 `seq`（`turn/start`、`user/message`、
   * `tool/result`），`imageIndexes` 是那則訊息裡圖片區塊由前往後的位置（**含已被省略的**，所以同一張圖的編號不因別張被省略而移動），
   * 嚴格遞增。一格代表「這則訊息的這幾張」，不是「這個附件」：同一個檔附在兩句話裡是兩個獨立的出現。
   *
   * ## 它是 dsh 唯一「進模型的效果要另寫解譯器」的事件
   *
   * 不產出訊息（所以不在 {@link ModelVisibleEventType} 裡），但左右之後模型看到什麼（`known-event-types.ts:84-87`，
   * {@link MESSAGE_PROJECTION_EVENT_TYPES}）。解譯者是每次叫模型前的 `createImageOffloadMiddleware`（`image-offload.ts`；下決定的是接住 adapter 拋碼的 `createImageOffloadRecoveryMiddleware`）：
   * 它從日誌讀出所有 `image/offload`、把落在請求裡的圖標成已省略；續接時訊息由 {@link ./conversation-replay.ts | replayConversation}
   * 推回來並蓋上來源 `seq`，同一條路徑讓被省略的圖維持被省略。
   *
   * **升版，不標 `ignorable`**（格式 43）：一台 42 的 runtime 讀到這一筆會拒絕重建（不認得又沒標可忽略），那是對的方向——略過它，
   * 模型就又看到本來已經省略的圖，請求再度超額，沒有任何東西說為什麼。
   *
   * 不帶圖的內容與位元組：只有位置，不含像素或檔名。
   */
  'image/offload': {
    readonly targets: readonly {
      /** 產出那則訊息的事件的 `seq`。 */
      readonly seq: number;
      /** 那則訊息裡被省略的圖片區塊位置（由前往後、含已省略者），非空、嚴格遞增。 */
      readonly imageIndexes: readonly number[];
    }[];
  };
  /**
   * 工具結果剪刀剪了幾顆（[#1302](https://github.com/DemianLi/nexus-agent/issues/1302)，格式 46）：這幾顆工具結果從這次起，模型看到的是
   * 剪成「頭＋標記＋尾」之後的內容。**每顆工具結果只記一次，之後的每次請求都沿用**——照 dsh 的 `compaction/prune`：落盤的替換，
   * 永久有效，不是每次重算。
   *
   * ## 為什麼記內容，不記規則
   *
   * 2026-10-09 拍板的理由是「歷史要能只從日誌推導，不能依賴程式碼版本」：剪刀的門檻、頭尾長度、標記字都是設定與程式碼，改了就推不回
   * 當時送出去的那份。所以記**剪過的內容本身**（`content`）。代價是日誌多一份剪過的內容（上界是門檻之內，預設約 5,000 個 code point），
   * 且每顆只記一次（見下）。
   *
   * ## 與 dsh 的差別（偏離登記）
   *
   * dsh 先記一顆 `compaction/prune`（影子價格：`shadowedRange`、`shadowedSeqs`、`shadowedTokenCount`），緊接著 append 一顆替換用的
   * `tool/result`（`surfaceOp: replace`、`sourceEventSeqs: [原 seq]`）。**我們沒有 surface 那一軸**（沒有 `surfaceOp`），替換不能掛在事件上，
   * 所以兩顆合成一顆：這一筆自己帶替換的內容，以 `callId` 指向被替換的那顆 `tool/result`（請求端的剪刀看到的是訊息、不是事件，
   * 沒有 `seq` 可指）。影子價格沒有——我們沒有可注入的 token meter（`tool-result-pruner.ts` 檔頭），省下的量讀者要自己從
   * `originalChars` 與 `content` 算。
   *
   * ## 位置與讀法
   *
   * 記在用到它的那次 `model/start` **之前**（承 #1301 定下的規則：改寫請求的事件排在用到它的呼叫之前），而且在同一次呼叫的
   * `compaction/summary` 之前——剪刀跑在摘要器外面。**不產出訊息**（所以不在 {@link ModelVisibleEventType} 裡），但左右模型看到什麼
   * （{@link MESSAGE_PROJECTION_EVENT_TYPES}）。解譯者有兩個：請求端是剪刀本身（`tool-result-pruner.ts`，每次呼叫前讀日誌、把記過的
   * 換上去、再剪新的）；推導端是 {@link ./conversation-replay.ts | replayConversation} 的 `applyPrunes` 選項。
   * **續接灌回 graph state 的那一串不套用**（state 裡留原文，剪刀下一次請求會照日誌換上），所以預設不套。
   *
   * **升版，不標 `ignorable`**（格式 46）：一台 45 的 runtime 讀到這一筆會拒絕重建。略過它，推出來的歷史就比實際送出去的長，
   * 而且沒有任何東西說為什麼。**讀舊檔**：45 以前沒有這一筆，照舊讀得回來；沒有剪過的會話，日誌與以前位元組相同。
   *
   * ⚠️ 剪過的內容原樣進遙測，同 `tool/result`。
   */
  'compaction/prune': {
    readonly results: readonly {
      /** 被剪的工具結果的 `tool_call_id`。 */
      readonly callId: string;
      /**
       * 剪之前的文字總量（Unicode code point，非文字區塊不算）。**兼作對得上的檢查**：套用時這個數字與那則訊息現在的文字量不相等，
       * 就不換——有的供應商會重用 `tool_call_id`，或訊息在這之間被別人改過，不能把另一顆結果的剪法套上去。
       */
      readonly originalChars: number;
      /** 剪過的內容，模型實際看到的那一份（字串，或保留了非文字區塊的複合區塊陣列）。 */
      readonly content: MessageContent;
    }[];
  };
  /**
   * 舊的 `write_file`／`edit_file` 呼叫的長參數被縮短了（[#1303](https://github.com/DemianLi/nexus-agent/issues/1303)，格式 47）：這幾個參數從這次起，
   * 模型看到的是縮短後的字串（開頭 20 個字加標記）。**每個參數只記一次，之後的每次請求都沿用。**
   *
   * ## 這是誰做的事
   *
   * 基座（`deepagents@1.13.1`）的摘要 middleware 在每次請求前對有效串重算 `truncateArgs`：訊息數到 `trigger`、在 `keep` 之前的助手訊息，
   * `write_file`／`edit_file` 的字串參數超過 `maxLength` 的，換成 `substring(0, 20) + truncationText`。只改請求，state 與日誌是完整參數。
   * 我們不擁有那段程式碼，所以這一筆**不是規則的紀錄，是觀察**：基座把請求交下去的那一刻，拿交下去的串跟進來的串逐個工具呼叫比，
   * 參數字串變短的就記。因此門檻、名單、標記字改了，日誌照樣對。
   *
   * ## 為什麼記內容，不記規則
   *
   * 同 `compaction/prune`：歷史要能只從日誌推導，不能依賴程式碼版本。代價是每個被縮短的參數多一份縮短後的字串（約 50 個字），
   * 而不是原本的幾千字；原文本來就在 `assistant/message` 上。
   *
   * ## 與 dsh 的差別（偏離登記）
   *
   * **dsh 沒有這個行為**：在 `references/deepseek-harness`（`d7432673886`）搜 `truncateArgs`、`truncate-args`、`argument truncated`、
   * `compaction/truncate` 零命中，沒有形狀可抄。形狀退到最接近的鄰居 `compaction/prune`（#1302）：事件自己帶替換的內容、不掛 surface、
   * 以 id 指到被改的那一個——只是這裡指的是 `tool_calls[i]` 的某個參數（`callId` ＋ 參數名），不是整顆 `tool/result`。
   * 不用 `seq` 的理由同 `compaction/prune`：請求端看到的是訊息，不是事件。
   *
   * ## 位置與讀法
   *
   * 記在用到它的那次 `model/start` **之前**（承 #1301），在同一次呼叫的 `compaction/summary` 之後（基座先摘要、再交下去；兩者互不依賴，
   * 讀者以 `callId` 套用，順序無關）。**不產出訊息**，但左右模型看到什麼（{@link MESSAGE_PROJECTION_EVENT_TYPES}）。解譯者有兩個：
   * 請求端是摘要器外面那一層（`summarization.ts` 的 `withArgTruncationLog`，每次呼叫前讀日誌、把記過的換上去再交給基座，基座交下去時記新的）；
   * 推導端是 {@link ./conversation-replay.ts | replayConversation} 的 `applyArgTruncations` 選項（預設不套，理由同 `applyPrunes`）。
   *
   * **升版，不標 `ignorable`**（格式 47）：一台 46 的 runtime 讀到這一筆會拒絕重建；略過它，推出來的歷史比實際送出去的長。
   * **讀舊檔**：46 以前沒有這一筆，照舊讀得回來；沒有被縮短的會話，日誌與以前位元組相同。
   *
   * ⚠️ 縮短後的字串原樣進遙測，同 `tool/result`。
   */
  'compaction/truncate-args': {
    readonly calls: readonly {
      /** 被縮短的工具呼叫的 `id`（`tool_calls[i].id`）。 */
      readonly callId: string;
      /**
       * 這個呼叫被縮短的參數，鍵是參數名。**`originalChars` 兼作對得上的檢查**：套用時它與那個參數現在的長度（UTF-16 code unit，
       * 同基座的 `value.length > maxLength`）不相等就不換——供應商可能重用工具呼叫 id，不能把另一個呼叫的縮短套上去。
       */
      readonly args: Readonly<
        Record<string, { readonly originalChars: number; readonly value: string }>
      >;
    }[];
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
   * **位置：在用到它的那次 `model/start` 之前**（格式 45，#1301；以前記在那次呼叫的回覆之後）。摘要生好、基座把摘要過的
   * 請求交下去的那一刻記，所以呼叫本身失敗了，這顆也已經在日誌上（dsh 同：壓縮在組請求之前落地、是耐久的）。
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
   * **`summary` 是換上去的那則摘要訊息**（從格式 9 起，[#305](https://github.com/DemianLi/nexus-agent/issues/305)），
   * 照 dsh 的 `compaction/summary` 帶 `summary`（`packages/compaction/compaction/src/types.ts`）。1 到 8 刻意
   * 不記，理由是檔頭那條「不記訊息內容」；推模型歷史的一側要把被壓掉的那一段換成它，所以它要在日誌裡。
   * dsh 由緊接著的一顆 `user/message {surfaceOp: replace}` 真正取代那一段；我們沒有 surface 那一軸，
   * 取代的規則是基座的 `getEffectiveMessages`——`[summaryMessage, ...messages.slice(cutoffIndex)]`，
   * graph state 裡的 `messages` 本身不動（`deepagents@1.13.1` `dist/langsmith-zm0ILQsV.js:2697-2702`）。
   * 8 以前的檔沒有這一格，所以型別上是選填。
   *
   * ⚠️ 摘要本文原樣進遙測，同 `assistant/message`。
   */
  'compaction/summary': {
    /** 切在原始訊息串的哪裡；`[0, cutoffIndex)` 被換成了那份摘要。 */
    readonly cutoffIndex: number;
    /** 切之前原始訊息串有多長。與 `cutoffIndex` 同一組座標。 */
    readonly messagesBefore: number;
    /** 被換掉的原文落在 backend 的哪個檔。**`null` ＝ 沒寫成功，原文消失了**。 */
    readonly filePath: string | null;
    /** 換上去的那則摘要訊息。 */
    readonly summary?: LoggedMessage;
    /**
     * 這顆記在用到它的那次 `model/start` **之前**（格式 45，[#1301](https://github.com/DemianLi/nexus-agent/issues/1301)），
     * 照 dsh：摘要在組請求之前落地。**有這一格＝新順序**，推導端據此檢查則數：那一刻 graph state 還沒有這次呼叫的回覆，
     * 推出來的恰好是 `messagesBefore` 則；沒有這一格是舊順序（記在那次呼叫的回覆之後），是 `messagesBefore + 1`。
     * **逐顆判，不看檔頭的格式版本**：續寫舊檔時 header 的版本會被蓋成新的（`session-store.ts`），同一份檔會同時有兩種。
     */
    readonly beforeCall?: true;
    /**
     * 生這份摘要的那一次模型呼叫報的用量（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)），照 dsh 的
     * `compaction/summary.usage`（選填）。**不進 `model/usage`、不進總帳**：基座直接 `request.model.invoke` 生摘要，
     * 它不是一次對話呼叫，記進總帳會讓「目前大小」與逐呼叫的歸屬都對不上。要算它的人（#1028）明寫口徑另加。
     * 沒有這一格 ＝ 沒報、報得對不起來、或舊日誌——**不是 0**。
     */
    readonly usage?: {
      /** 未快取的輸入（#724，語義同 `model/usage.inputTokens`）。 */
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly cacheReadTokens?: number;
      readonly cacheWriteTokens?: number;
    };
  };
  /**
   * 摘要器量到的一次模型呼叫：**那份請求離自動摘要還有多遠**（[#528](https://github.com/DemianLi/nexus-agent/issues/528)）。
   *
   * 量的是摘要器交給下一層的那份請求——沒摘要時是截過參數的那串，摘要了就是 `[摘要, ...留下的]`。
   * `approxTokens` 就是 `tokens` 門檻拿來比的那個數，`messageCount` 就是 `messages` 門檻比的那個長度，
   * `thresholds` 是那次呼叫實際生效的門檻（patch 改過就是改過的）。細節與偏離見 `summarization.ts` 的
   * `withTokenBudget`。
   *
   * **`approxTokens` 的算法換過一次，形狀沒換**（[#588](https://github.com/DemianLi/nexus-agent/issues/588)）：
   * 之前是「四個字元一個」的純估算，之後是錨在供應商實數上的估算。讀的一方只拿它顯示與比門檻，兩種都讀得懂，
   * 所以沒有升日誌格式版本。
   *
   * 下一層正常回來才記，一次一筆；拋錯的那次不記。**停止閘門擋下的那一次也記**：摘要器排在它外層，閘門回的
   * 合成收尾對摘要器來說是正常回來——量的是判準看過的那份請求，數字照樣成立。摘要關掉時沒有這顆事件。
   * **這一筆只有數字與門檻**，不含訊息內容。
   */
  'context/measure': {
    /** 估算的 token 數：錨在上一次供應商報的實數上、只估增量，見 `token-estimate.ts`。 */
    readonly approxTokens: number;
    /** 訊息則數，同 `messages` 那道門檻比的數。 */
    readonly messageCount: number;
    /** 那次呼叫生效的觸發門檻，並聯，任一成立就摘要。 */
    readonly thresholds: readonly {
      readonly type: 'messages' | 'tokens';
      readonly value: number;
    }[];
    /**
     * 所屬那次模型呼叫，值是它的 `model/start` 的 `seq`（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)，見 `model-call-scope.ts`）。
     * 舊日誌與寫入點不在呼叫範圍裡時沒有這一格——讀的人標「—」，不是推位置。
     */
    readonly modelCall?: number;
  };
  /**
   * 這個會話**允許子代理逐次挑哪些模型**（[#875](https://github.com/DemianLi/nexus-agent/issues/875)，卡 [#709](https://github.com/DemianLi/nexus-agent/issues/709)）。
   * 照 dsh 的同名事件（`packages/subagent/tool-subagent/src/model-selection-state.ts:17`，`477b4f4`）。
   *
   * ## 誰寫它
   *
   * `apps/harness` 的組裝點（`attachSession`），**只寫 root 那一份、只寫一顆**：政策是**沒有歷史的新會話**在建立時從設定取樣
   * 一次（`serve.ts`），之後只讀日誌這一份；設定事後再改只影響新會話。日誌已經有這一顆就不再寫——這一點跟 `sandbox/mode`
   * 每次 attach 都重寫不同。
   *
   * ## 它的意義
   *
   * **事件存在＝政策開著；沒有這一顆就是關**。所以舊會話（沒有這一顆）把設定打開再續接，仍然沒有政策；開著時建的會話
   * 把設定關掉再續接，政策仍在。`allowedModels` 是型錄 id 的清單（我們只有一個端點，dsh 的 `{provider, model}` 路由在這裡
   * 就是型錄 id，見 [#875](https://github.com/DemianLi/nexus-agent/issues/875) 的偏離登記）。
   *
   * 子代理的日誌不寫（我們的子代理不巢狀，沒有「子會話繼承父政策」這條路）。
   */
  'subagent/model-selection-policy': { readonly allowedModels: readonly string[] };
  /**
   * 派出去的一個子代理**出生了**：子會話的 id 與派它的那一顆 `tool/call`（[#1023](https://github.com/DemianLi/nexus-agent/issues/1023)）。
   * 照 dsh 的同名事件（`packages/subagent/subagent/src/catalog.ts`，`5badb15`），多一格 `callId`、少三格，理由見
   * {@link ./subagent-catalog.ts}。
   *
   * ## 誰寫、寫在哪
   *
   * 只寫**父**那一份（今天一律是 root），同 dsh「parent-owned」。只發布成功的事實，兩個寫者各在子代理成立的那一刻寫：
   *
   * - **前景**（基座的 `task`）：子會話日誌**出生**的那一刻，由註冊點的觀察者寫（`registry.ts` 的 `expectSpawn`；圍堵在
   *   記下 `tool/call` 之後登記「這次呼叫可能派出子代理」）。我們沒有 dsh 的 spawn 點，日誌出生是看得到的最接近那一刻，
   *   同 `SessionRegistry` 的偏離 1。從頭到尾沒寫過日誌的子代理（例如 `subagent_type` 打錯）就沒有這一顆——它也沒有日誌可指。
   * - **背景**（`subagent`）：`BackgroundSubagentHost.start` 開好子日誌、接受第一句話之後寫，同 dsh continuable 的順序。
   *
   * 所以它永遠落在配對的 `tool/call` **之後**、同一輪之內，前景也在配對的 `tool/result` 之前。
   *
   * **它不進模型**，同 dsh 的 log-only：推模型歷史的一側不讀它。web 的工具卡讀它（`@nexus/wire` 的 `SUBAGENT_CATALOG`）。
   */
  'subagent/catalog': SubagentCatalogData;
  /**
   * 子代理**自己的日誌**上的身分與可續接的組成（[#1271](https://github.com/DemianLi/nexus-agent/issues/1271)）：哪一種規格、指定的模型與推理等級。
   * 照 dsh 的同名事件（`packages/subagent/subagent/src/descriptor.ts`，`5badb15009a`），欄位與沒抄的幾格見 {@link ./subagent-descriptor.ts}。
   *
   * 行程重啟之後 host 的記憶體沒了，冷復活（有人對這個編號 `subagent.send`）只靠這一顆加上 header 的 `parentSession` 重建；
   * 沒有這一顆的子日誌（44 以前、前景子代理）分不出身分，不能復活。
   *
   * 只由 `BackgroundSubagentHost.start` 寫：開好子日誌之後、第一個 `turn/start` 之前，是這份日誌的**第一顆**；折疊取第一顆為準。
   * **不進模型**（log-only，推模型歷史的一側不讀它）、**不標 `ignorable`**（格式 44）：一台 43 的 runtime 看不懂它，也就不該以為自己讀得懂
   * 這份子日誌。
   */
  'subagent/descriptor': SubagentDescriptorData;
  /**
   * 模型要叫一次工具，**在它進任何一層之前記**——照 dsh 在核准之前就記
   * （`packages/core/agent-loop/src/tool-calls.ts:168`，`c291e79`），所以被核准閘門擋掉的
   * 呼叫一樣有這一顆。與 `tool/result` 靠 `callId` 配對。生產者是圍堵，見 `containment.ts`。
   *
   * ## 對 dsh 的兩處偏離
   *
   * - **`arguments` 平常是參數物件序列化後的字串，不是模型吐的原字串。** 原字串只留在供應商那一層
   *   的 `additional_kwargs.tool_calls`，形狀隨供應商而變，`wrapToolCall` 只拿得到解析過的
   *   `toolCall.args`。**JSON 都不合格的那顆例外：記的就是模型吐的原字串，所以這一格不一定解得開
   *   JSON**（[#281](https://github.com/DemianLi/nexus-agent/issues/281)，見 `invalid-tool-args.ts`）。
   *   格式版本不升：dsh 只在結構變更時升，這一格的型別沒變（dsh 這一格本來就是原字串）。
   * - **沒有 `turn`／`step` 欄位。** 我們沒有 `step/*` 事件（`model/start`／`model/end` 不是步的邊界，
   *   這一顆落在它們之後，見那兩顆），subagent 的日誌裡也沒有 `turn/start`
   *   （入口點只包 root 的輪）。root 那份以落在哪一對 `turn/start`／`turn/end` 之間定輪。
   *   **步**不另存：`callId` 出現在發出它的那則 `assistant/message` 的 `tool_calls` 裡，那則帶 `modelCall`
   *   （#1021，`indexModelCalls` 做這個歸屬；供應商重用 `callId` 時取最近一則）。
   *
   * ## 同一個 `callId` 可能有兩顆
   *
   * 被核准閘門中斷的那次，resume 之後以同一個 `callId` 再進一次（實測；同批沒被擋的不重跑）。
   * 所以暫停那一輪留一顆沒配對的、後面跟著 `interrupt/raised`，resume 那一輪再一對——
   * **配對取最後那一顆**。這樣結果永遠跟呼叫落在同一輪，dsh `session-stats` 在 `turn/end`
   * 丟掉沒配對的呼叫那條規則（`packages/session/session-stats/src/projection.ts:190-194`）
   * 照抄得動。
   *
   * ⚠️ **`arguments` 原樣進本機日誌、也原樣進遙測**——`write_file` 寫的內容就在這裡。照 dsh
   * 不加開關（它的 `recordInput` 只蓋斜線命令，`packages/interaction/commands/src/index.ts:376`）；
   * 要擋在遙測外靠部署方掛脫敏規則，而脫敏只作用在送出去的那份，**本機的 jsonl 照舊是原文**。
   */
  'tool/call': {
    readonly callId: string;
    /** 模型叫的名字，不經過任何解析——未知工具也照記。 */
    readonly name: string;
    readonly arguments: string;
  };
  /**
   * 配對的那次呼叫落定了，**帶模型收到的那則結果**（`message`，從格式 9 起）。
   *
   * 照 dsh 的 `tool/result {message, error?}`（`packages/core/session/src/types.ts:353-360`，`c291e79`）。
   * 1 到 8 只記判別、不記內容，那是 [#264](https://github.com/DemianLi/nexus-agent/issues/264) 拍板的
   * 偏離，理由是「下游用不到內容」——[#305](https://github.com/DemianLi/nexus-agent/issues/305) 之後推模型
   * 歷史的一側就是下游，那個前提不在了，偏離收回。
   *
   * **`message` 是選填，兩個理由**：8 以前的檔沒有；以及圍堵在 handler 的回傳裡找不到屬於這次呼叫的
   * ToolMessage 時不放（一個不帶那則訊息的 `Command`——今天沒有生產者）。
   *
   * ## 記的是圍堵看得到的那一則：外溢層開著時是預覽，關著（或存不下）時超過 80,000 字元的仍是全文
   *
   * **外溢層（[#719](https://github.com/DemianLi/nexus-agent/issues/719)，`spill-policy.ts`）排在圍堵內層**：一則結果超過
   * `maxInlineTokens`（出貨 12,500）就在那裡換成頭尾預覽加一句帶路徑的通知，圍堵看到的、記進日誌的就是那一則——
   * **照 dsh 只記預覽**（dsh `tool-calls.ts:152-156`，日誌記外溢換過之後的那則）。超過保留期（預設 30 天）之後原文沒了，
   * 日誌與評估掃描、web 工具卡讀到的只剩預覽。這一段先前登記的偏離（「記換之前的全文」）**收窄成下面這一半，沒有刪**：
   *
   * 外溢層關掉（把 `maxInlineTokens` 刪掉）、沒有存處（沒有會話鑰匙），或存不下（保留原結果）時，超過 80,000 字元的仍由基座換成
   * 預覽，而基座排在圍堵**外層**，下面整段原樣成立。
   *
   * 基座的 `FilesystemMiddleware` 排在圍堵**外層**（`createDeepAgent` 把它放在每一顆自訂 middleware
   * 之前），它的 `wrapToolCall` 在文字超過 80,000 字元時把結果搬去 `/large_tool_results/`、換上一段
   * 預覽（`apps/harness` 的 `TOOL_RESULT_STASH_PREFIX`）。**圍堵看不到換過的那一則**，所以這一格記的
   * 是換之前的全文——偏離 dsh 的「模型看到的那則」。退到這裡說得通：預覽由全文照同一條規則推得回來
   * （門檻、路徑、預覽都是確定的），全文由預覽推不回來。推模型歷史的一側要自己重算這一步。
   *
   * `error` 只在 `isError` 時出現，碼照 dsh（見 `tool-events.ts`）；**一般拋錯與核准被拒不帶**
   * ——dsh 只替帶碼的錯誤填這一格。**沒碼的時候整個不放 key**，同 `command/done` 的 `text`。
   *
   * **「這次呼叫沒有生效」也是 `isError`**：goal、todo、計劃模式、root-only 樁的拒絕回的是錯誤
   * 訊息（[#273](https://github.com/DemianLi/nexus-agent/issues/273)）。在那之前寫下的日誌把它們
   * 記成 `isError: false`，**格式版本沒有跟著升**——詞彙沒變，dsh 也只在結構變更時升版
   * （`references/deepseek-harness/AGENTS.md` 的 `SESSION_FORMAT_VERSION` 那條）——所以讀舊檔
   * 數錯誤的分不出這一段。
   *
   * 中斷不是落定：暫停的那次沒有這一顆，見 `tool/call`。
   *
   * **web 的工具卡以這一顆定終態**（[#296](https://github.com/DemianLi/nexus-agent/issues/296)，
   * 照 dsh 的卡由 `tool/result` 收）：pump 訂閱每一份日誌，失敗的就把卡畫成失敗，紅字就是 `message`
   * 的文字。
   *
   * ⚠️ **工具讀到的檔案內容、指令輸出，連同裡面可能有的秘密，原樣進本機日誌、也原樣進遙測**，同
   * `tool/call` 的 `arguments`。
   */
  'tool/result': {
    readonly callId: string;
    readonly isError: boolean;
    readonly error?: ToolErrorInfo;
    readonly message?: LoggedMessage;
    /**
     * 給畫面的結構化結果：讀檔讀到哪幾行、搜尋命中什麼、改檔改了哪幾段（格式 16 起，
     * [#617](https://github.com/DemianLi/nexus-agent/issues/617)）。形狀同 dsh，逐工具列在 `tool-result-meta.ts`。
     *
     * **模型看不到它**，同 dsh（surface 投影只回 `message`）：推模型歷史的一側不讀這一格。失敗的呼叫
     * 不帶。**這裡存完整的一份**，上線那一刻才截（harness 的 `capToolResultMeta`）。`message` 的文字自 #736 起上線不截。
     *
     * ⚠️ **讀到的行、搜尋命中的行、改檔前後的片段都原樣在裡面**，跟著整顆事件進本機日誌、也進遙測
     * （協調器把整份 `data` 當 body 送，同 dsh 的 `coordinator.ts:189`，`477b4f4`）。沒有另外的上限。
     */
    readonly meta?: unknown;
  };
  /**
   * 一則回覆的評分新建或改了，**帶修改之後的完整值**。後寫覆蓋先寫，被 `feedback/message-delete`
   * 收回的就沒了——折疊是 `feedback.ts` 的 `currentMessageFeedback`。
   *
   * 照 dsh 的同名事件（`packages/feedback/message-feedback/src/types.ts:54-58`，`ddefc45`），偏離一處：
   * 拿掉 `sessionId`，理由見 {@link ./feedback.ts}。**格式 10 以前的目標是輪**（`item.turn`），照舊讀。
   *
   * ⚠️ **`note` 是使用者的原話，而它會原樣進遙測**，同 `command/run` 的 `args`。
   */
  'feedback/message-put': MessageFeedbackPut;
  /** 一則回覆的評分被收回了。**之前的評分與備註仍留在日誌裡**——收回不是抹掉。格式 10 以前指名的是輪。 */
  'feedback/message-delete': MessageFeedbackDelete;
  /**
   * 一則對整個會話的評語。**跟任何一輪都沒有綁**。照 dsh 的 `feedback/record`
   * （`packages/feedback/command-feedback/src/types.ts:33-40`）。
   *
   * ⚠️ **`text` 是使用者的原話，而它會原樣進遙測**。所以 `/feedback` 宣告 `recordInput: false`
   * ——同一段話不在 `command/run` 再記一次。
   */
  'feedback/record': FeedbackRecord;
  /**
   * 送出佇列的一次變動（[#637](https://github.com/DemianLi/nexus-agent/issues/637)）：送進來、領走、改、刪。
   * 形狀與折疊見 {@link ./inbox.ts}。
   *
   * 照 dsh 的 `agent/inbox/spliced`（`packages/core/agent/src/types.ts:96-102`，`477b4f4`），名字少了 `agent/`：
   * 我們的日誌只有一種寫者的命名空間。落點有三種：
   *
   * - **送進來**：收下 `run.start` 的那一刻。閒著時也一樣，所以一輪前面多一顆；停在核准點時收下的那句落在
   *   `interrupt/raised` 之後、`resume` 的 `turn/start` 之前。
   * - **領走**：一輪開始時，**落在那一輪的 `turn/start` 之後**，同 dsh 的 `turn()` 先寫 `turn/start`、`preStep`
   *   才領。所以它不會落在輪與輪之間，切頁不受影響。
   * - **改、刪**：任何時候（排著的那一件還沒被領走就行）。
   */
  'inbox/spliced': InboxSplice;
  /**
   * 一段 seed 的結尾——這一顆之前的事件是上一個行程寫的，這個行程一顆都沒寫
   * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。
   *
   * 照 dsh 的 `session/end-seed`（`packages/core/session/src/types.ts:379-398`，`c291e79`）：
   * **建構子是唯一合法的寫者**，seed 已經以一顆它結尾時不再補（重開一份沒動過的會話不
   * 疊標記）。它存在的理由是 seed 的歷史與這個行程的活動**逐位元組長得一樣**：一顆在它
   * 之前沒配到的開頭（`turn/start`、`command/run`、`interrupt/raised`）屬於一個已經結束
   * 的生命週期，不管它是怎麼結束的。所以讀「當前這一段」的人與帶開關狀態的配套入口都
   * 要在這裡重設——見 {@link currentTurnStart} 與 core、todo、commands 三份配套入口。
   */
  'session/end-seed': Record<string, never>;
  /**
   * 這一次續接**實際載入**的建置版本、插件清單與設定雜湊（[#1138](https://github.com/DemianLi/nexus-agent/issues/1138)
   * 量到的缺口 2）——形狀同 header 的那三格（{@link SessionHeaderBuildMetadata}），**不帶 `config`**，理由同
   * `StoredSessionPluginRow`。
   *
   * **為什麼需要它**：header 只記建立當下那一份，續接不回填（`build` 的規則），所以換成新版插件之後續接的
   * thread，header 仍把它列成舊版的使用者。header 不動，這一顆補上「後來是誰接手的」：最後一顆
   * `session/resumed` 是這份日誌目前跑的清單，沒有就是 header 那份。
   *
   * **寫在 `session/end-seed` 之後**，由 `attachSessionPersistence` 在續接的 root 接上時寫；新建的會話不寫
   * （header 就是它）。前一顆已經是同樣內容的 `session/resumed` 就不再疊——空轉的續接不讓日誌長。
   *
   * 標 `ignorable`：純資訊性、不進模型也不左右重建，舊 runtime 略過它是對的（#507，所以不升格式版本）。
   * **不鏡像到會話遙測**（`isMirroredEvent`）：裡面有本機的模組路徑與只能在同一台機器上比的設定雜湊。
   */
  'session/resumed': SessionHeaderBuildMetadata;
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
      /**
       * 讀方碰到不認得的 `type` 時可以安全略過這一筆（[#507](https://github.com/DemianLi/nexus-agent/issues/507)）。
       * **沒有＝必需**：讀方碰到不認得、又沒有這個標記的種類，必須拒絕重建整份日誌（{@link ./session-store.ts | SessionEventUnsupportedError}），
       * 不能靜靜丟掉——不認得的必需事件可能左右後面每一筆怎麼讀。
       *
       * 寫方只在**純資訊性、遺失了也不影響重建**的種類上標 `true`。預設必需是刻意的：忘了標只會多拒（不便），
       * 預設可略過則會讓同一個疏忽變成靜靜接續一份被掏空的日誌（安全失敗）。同 dsh
       * （`packages/core/session/src/types.ts:501-511`，`5badb15`）。
       *
       * **對已經認得的種類沒有作用**：認得就照該種類的語意讀，標不標都一樣。
       */
      readonly ignorable?: true;
    }
  : never;

/**
 * 這個 `type` 是這一版認得的事件種類嗎。表外的（更新的版本寫的、或別的東西寫的）回 `false`。
 *
 * **這一版的程式認得的事件種類**——讀方碰到表外的 `type` 時拒絕重建，除非那一筆標了
 * {@link SessionEvent.ignorable}（[#507](https://github.com/DemianLi/nexus-agent/issues/507)，
 * 同 dsh 的 `KNOWN_SESSION_EVENT_TYPES`，`packages/core/session/src/known-event-types.ts`，`5badb15`）。
 *
 * **表是生成的**（[#679](https://github.com/DemianLi/nexus-agent/issues/679) 第 4 步）：詞彙是 {@link SessionEventMap}
 * 的鍵，各套件用宣告合併補的種類在這個檔裡看不到，所以由 `apps/harness/src/gen-known-event-types.ts` 掃過每一處
 * 宣告生成 `./known-event-types.ts`，`apps/harness/src/known-event-types.test.ts` 驗它沒過期。不是讓各 plugin 在
 * 執行期登記（登記只說「有這個名字」，說不出「略過它安不安全」，而且會讓同一份日誌在不同組裝下讀出不同結果，
 * dsh 的 `2026-08-10-session-log-version-mechanism.md` 的 Alternatives considered）。
 *
 * **種類只增不減**：舊日誌沒有 `ignorable` 旗標，缺席＝必需，所以任何一版寫過的種類，這一版都必須認得，否則那份舊日誌
 * 從此讀不回來。要退役一種，留在 {@link SessionEventMap} 裡、只是不再寫；`session-log.test.ts` 的凍結清單擋著。
 *
 * 回傳 `boolean` 而不是型別守衛：表是執行期的生成集合，認得不等於這個字串此刻在這個編譯單元看得到——各套件的宣告
 * 合併只在 import 了該套件的編譯單元裡進得了 {@link SessionEventType}。
 */
export function isKnownSessionEventType(type: string): boolean {
  return KNOWN_SESSION_EVENT_TYPES.has(type);
}

/**
 * 一筆事件的 `type` 這一版認得嗎——**不認得、又沒標 {@link SessionEvent.ignorable} 的就是讀方必須拒絕的**。
 * 參數收 `{ type: string; ignorable?: unknown }` 而不是 {@link SessionEvent}：它的用途是檢查剛從磁碟讀回來、
 * 還沒驗過形狀的東西。
 */
export function isUnreadableSessionEvent(event: {
  readonly type: string;
  readonly ignorable?: unknown;
}): boolean {
  return !isKnownSessionEventType(event.type) && event.ignorable !== true;
}

/**
 * **產生模型訊息的那幾種事件**——續接時 {@link ./conversation-replay.ts | replayConversation} 從日誌推回
 * 模型歷史，靠的就是這一份子聯集（[#681](https://github.com/DemianLi/nexus-agent/issues/681)）。
 *
 * 人打的字在 `turn/start`（`kind` 不是 `resume` 才有），模型回覆在 `assistant/message`，工具結果在
 * `tool/result`，外掛塞進對話的在 `user/message`，壓縮的摘要在 `compaction/summary`。**其餘每一種都
 * 不進模型**，各種類自己的說明（見 {@link SessionEventType}）照舊講它為什麼不進。
 *
 * 照 dsh 的 `SurfaceEventType`（`packages/core/session/src/types.ts:439-444`，`477b4f4`），**但不照它的
 * 名字**：dsh 的成員要帶 `surfaceOp`，我們沒有那一軸（不做它是縮小範圍，不是表達不出來），叫
 * `SurfaceEventType` 會讓人以為有。**封閉**，同 dsh：其他套件日後補進來的種類只會走到守衛的另一支。
 *
 * 加一種會進模型的事件要同時動三處，缺一處都編不過：這個聯集、{@link MODEL_VISIBLE_EVENT_TYPES}
 * 那張表、replay 守衛之內的 `switch`（它的 `default` 是 `satisfies never`）。
 *
 * `image/offload`（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）在 dsh 不是產訊息的那一類，
 * 而是進模型的**效果**要另寫解譯器的事件（`known-event-types.ts:84-87`）。它走的是另一份子聯集
 * {@link MESSAGE_PROJECTION_EVENT_TYPES}，**不在這裡**：它不替模型多出一則訊息，replay 對它沒有 case。續接時被省略的圖維持被省略，
 * 靠的是 replay 替推回來的訊息蓋上來源 `seq`、解譯者在每次叫模型前讀日誌（見 `image-offload.ts`）。
 */
export type ModelVisibleEventType =
  'turn/start' | 'assistant/message' | 'tool/result' | 'user/message' | 'compaction/summary';

/**
 * {@link ModelVisibleEventType} 的執行期那一份。**逐種列出、型別綁死**（借 dsh `MESSAGE_ROLE_BY_TYPE:
 * Record<SurfaceEventType, …>` 的形狀）：聯集多一種或少一種，這張表都編不過。
 */
const MODEL_VISIBLE_EVENT_TABLE = {
  'turn/start': true,
  'assistant/message': true,
  'tool/result': true,
  'user/message': true,
  'compaction/summary': true,
} as const satisfies Record<ModelVisibleEventType, true>;

/** 會進模型的事件種類，`MODEL_VISIBLE_EVENT_TABLE` 的鍵。 */
export const MODEL_VISIBLE_EVENT_TYPES: readonly ModelVisibleEventType[] = Object.keys(
  MODEL_VISIBLE_EVENT_TABLE,
) as ModelVisibleEventType[];

/**
 * 這一筆會不會進模型。**把整個詞彙收窄成子聯集**（同 dsh 的 `isSurfaceEvent`），窮舉只做在收窄之後。
 * 整個詞彙照舊不窮舉：不認得的種類（含別的套件補進來的）回 `false`。
 */
export function isModelVisibleEvent(
  event: SessionEvent,
): event is SessionEvent<ModelVisibleEventType> {
  return Object.hasOwn(MODEL_VISIBLE_EVENT_TABLE, event.type);
}

/**
 * **不產出訊息、卻左右模型看到什麼的事件**（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)），對應 dsh 的
 * `MESSAGE_PROJECTION_EVENT_TYPES`（`packages/core/session/src/known-event-types.ts:84-87`，`5badb15009a`）：「進模型的效果要另外
 * 寫解譯器」的那一類。今天有 `image/offload`、`compaction/prune` 與 `compaction/truncate-args`。
 *
 * 跟 {@link ModelVisibleEventType} 的差別：那一份是**替模型多出一則訊息**的事件，replay 對它們窮舉；這一份**改變已經存在的訊息**
 * 怎麼送出去，解譯者各自負責（見 `image/offload`、`compaction/prune` 的說明）。兩份都不能標 `ignorable`。
 */
export const MESSAGE_PROJECTION_EVENT_TYPES = [
  'image/offload',
  'compaction/prune',
  'compaction/truncate-args',
] as const satisfies readonly SessionEventType[];

/** {@link MESSAGE_PROJECTION_EVENT_TYPES} 的成員。 */
export type MessageProjectionEventType = (typeof MESSAGE_PROJECTION_EVENT_TYPES)[number];

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
  /**
   * 上一個行程留下的事件，**原樣接上**，`seq` 從它的長度續號
   * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。
   *
   * 照 dsh 的帶 seed 建構（`packages/core/session/src/index.ts:477-497,584-609`，`c291e79`）：
   * seed **不發給任何觀察者**——建構當下本來就沒有人訂閱，而之後掛上來的消費者要看歷史
   * 就自己讀 {@link SessionLog.events}（持久化協調器、參與者、不變量都是這樣接的）。
   * seed 結尾自動補一顆 `session/end-seed`，已經以它結尾的不再補。
   *
   * 每一顆照 `append` 的規矩拷、凍：從磁碟讀回來的是純物件，不凍的話「改不動」只對這個
   * 行程寫的那些成立。`seq` 必須等於它在陣列裡的位置——缺號或重號的 seed 開出來的日誌
   * `length` 與 `seq` 對不上，下一筆 append 會跟已存的撞號。
   */
  readonly seed?: readonly SessionEvent[];
}

/** {@link SessionLog.append} 的選項。 */
export interface SessionAppendOptions {
  /**
   * 把這一筆標成可略過（{@link SessionEvent.ignorable}），落盤時原樣寫進去。**只給純資訊性、遺失了也不影響重建的新種類**：
   * 讀方碰到不認得的種類又沒有這個標記就拒絕整份日誌，所以標了，一台還沒學會這個種類的舊 runtime 才讀得回這份日誌。
   * 已經是既有種類的事件不需要標（認得就照該種類的語意讀）。**會進模型的種類（{@link MODEL_VISIBLE_EVENT_TYPES}）標了會當場拋**：
   * 略過它就是模型看到的對話少一截。
   */
  readonly ignorable?: true;
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
    if (options.seed !== undefined) this.#adoptSeed(options.seed);
  }

  /**
   * 接上 seed：逐顆驗連續、拷、凍，最後補一顆 `session/end-seed`。
   * 見 {@link SessionLogOptions.seed}。
   *
   * @throws 某一顆的 `seq` 不等於它的位置，或帶了 JSON 表達不出來的東西。
   */
  #adoptSeed(seed: readonly SessionEvent[]): void {
    for (const [index, event] of seed.entries()) {
      if (event.seq !== index) {
        throw new Error(
          `會話 "${this.#sessionId}" 的 seed 不連續：第 ${index} 顆的 seq 是 ${event.seq}。`,
        );
      }
      const snapshot = snapshotJsonValue(event, `seed 第 ${index} 顆`, new Set());
      this.#events.push(deepFreeze(snapshot) as SessionEvent);
    }
    // 末尾的 `session/resumed` 是上一次續接寫在 end-seed 之後的，不算「有新東西」：算的話每次空轉的續接
    // 都多疊一顆 end-seed。
    let last = this.#events.length - 1;
    while (last >= 0 && this.#events[last]?.type === 'session/resumed') last -= 1;
    if (this.#events[last]?.type === 'session/end-seed') return;
    this.#events.push(
      deepFreeze({
        type: 'session/end-seed',
        seq: this.#events.length,
        time: Date.now(),
        data: {},
      }) as SessionEvent,
    );
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
   * @param type - 事件種類。
   * @param data - 酬載，必須是純 JSON。
   * @param options - 見 {@link SessionAppendOptions}。
   * @throws 會進模型的種類帶了 `options.ignorable`（{@link SessionAppendOptions.ignorable}）。
   * @throws `data` 帶了 JSON 表達不出來的東西（class 實例、函式、`undefined`、
   *   `NaN`、循環參考）——**當場拋，日誌不變**。
   * @throws 在某個 listener 的回呼裡被呼叫——重入防護，見 class 註解。
   */
  append<T extends SessionEventType>(
    type: T,
    data: SessionEventMap[T],
    options: SessionAppendOptions = {},
  ): SessionEvent<T> {
    // 會進模型的種類不能標可忽略：略過它就是模型看到的對話少一截，正是「靜靜讀錯」那一類。同 dsh 的論證——
    // 模型看得到的內容只走產訊息的那幾種，所以危險的不認得事件就是這幾種與左右重建的非訊息事件（版本機制筆記）。
    if (
      options.ignorable === true &&
      (Object.hasOwn(MODEL_VISIBLE_EVENT_TABLE, type) ||
        (MESSAGE_PROJECTION_EVENT_TYPES as readonly string[]).includes(type))
    ) {
      throw new TypeError(`會話事件 "${type}" 會進模型，不能標可忽略（#507）`);
    }
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
      ...(options.ignorable === true && { ignorable: true }),
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

/**
 * 最後一顆 `turn/start` 的位置——也就是**當前這一段物理輪次的頭**。
 *
 * ## 為什麼這個走法要有一個擁有者
 *
 * 讀日誌有兩種走法，而它們的答案不一樣：**往回追鏈**（`resume` 一路穿過去找根）回答
 * 「這條鏈的根是不是人」，**只讀當前這一段**回答「我現在人在哪一輪裡」。第二種今天有
 * 三個消費者——goal 工具的續行輪次授權、續行排程器的就緒判準，以及底下那個中斷檢查。
 * 三份各寫一次的話，某一份哪天多穿一格，而**多穿的那一格不會讓任何測試變紅**：它只是
 * 讓一個更早的輪次替現在這一輪背書。
 *
 * 所以走法住在**詞彙的擁有者**旁邊，兩種走法各自有一個名字，見
 * `@nexus/plugin-goal` 的 `authority.ts` 檔頭那張對照。
 *
 * **往回找只找到最後一顆 `session/end-seed` 為止。** 那顆之前的輪屬於上一個行程——它
 * 開著沒收，是當掉還是被關掉，這裡分不出來也不必分。越過去的話，resume 之後的每一個
 * 消費者都會以為自己人在上一個行程那一輪裡：續行判成 `turn-open`、一顆沒人答得了的
 * 中斷判成 `interrupt-pending`（[#251](https://github.com/DemianLi/nexus-agent/issues/251)）。
 *
 * @param events - 一份會話日誌到目前為止的全部事件，照 `seq` 排。
 * @returns 那一顆的索引；一顆 `turn/start` 都沒有、或最後一顆 `session/end-seed` 之後
 *   還沒有時是 `-1`。
 */
export function currentTurnStart(events: readonly SessionEvent[]): number {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const type = events[at]?.type;
    if (type === 'session/end-seed') return -1;
    if (type === 'turn/start') return at;
  }
  return -1;
}

/**
 * 當前這一段物理輪次**還開著**的話，它的 `turn/start` 的位置；已經收工（`turn/end` 或 `turn/failed`）或根本沒有
 * 就是 `-1`（[#953](https://github.com/DemianLi/nexus-agent/issues/953)）。
 *
 * 「開著」＝這一輪正在跑：`turn/start` 在 `try` 之前 append（見 `apps/harness` 的 `goal-driver.ts` `turnClosed` 那段），所以日誌上
 * 開著的那一輪不會是「跑過但沒有頭」，也不會是上一個行程留下的——續接時補寫 `turn/end { interrupted }`、舊檔補
 * `session/end-seed`，{@link currentTurnStart} 本來就停在那顆。**停在核准點的那一輪有 `turn/end`**，所以不算開著。
 *
 * 讀它的人是**畫面那一側**要知道「日誌尾巴上有一輪還沒寫完」：它的回覆還沒落盤，不是缺。續行排程器的就緒判準
 * （`turnClosed`）要的是為什麼收工的原因，不只是有沒有，所以不共用這個。
 *
 * @param events - 一份會話日誌到目前為止的全部事件，照 `seq` 排。
 * @returns 開著的那一輪的 `turn/start` 索引；沒有開著的是 `-1`。
 */
export function openTurnStart(events: readonly SessionEvent[]): number {
  const start = currentTurnStart(events);
  if (start < 0) return -1;
  for (let at = start + 1; at < events.length; at += 1) {
    const type = events[at]?.type;
    if (type === 'turn/end' || type === 'turn/failed') return -1;
  }
  return start;
}

/** 開新的邏輯輪的那一種 `turn/start`：`kind` 收窄成不是 `resume`。守衛的假支不會被誤收窄掉整個 `turn/start`。 */
export type LogicalTurnStartEvent = Omit<SessionEvent<'turn/start'>, 'data'> & {
  readonly data: Exclude<SessionEventMap['turn/start'], { readonly kind: 'resume' }>;
};

/**
 * 這一顆**開不開新的邏輯輪**：是 `turn/start`，而且 `kind` 不是 `resume`（[#682](https://github.com/DemianLi/nexus-agent/issues/682)）。
 *
 * 一筆事件屬於哪一輪，規則是「由 `seq` 往前找最近一顆開邏輯輪的 `turn/start`」——`resume` 是回覆核准，
 * 接著上一輪停在核准點的那幾顆呼叫，不另開一輪。這條規則原本每個讀方各寫一次，**多寫一份的人把
 * `resume` 當成新輪，不會讓任何測試變紅**（只是畫面上多一輪、評分掛錯輪），所以跟
 * {@link currentTurnStart} 一樣住在詞彙的擁有者旁邊。
 *
 * 逐顆的述詞，不是往回走：讀方都是往前折的迴圈或觀察者。它只回答「這一顆開不開新的邏輯輪」，
 * `session/end-seed` 留給各讀方自己處理（各份對「end-seed 之後來的 `resume`」的假設不一樣，見 #682）。
 * 不是 `turn/start` 的事件回 `false`。長期照 dsh 讓 `turn/start` 自己帶輪號的話，這個述詞是要改的那一處。
 *
 * @param event - 日誌的一顆事件。
 * @returns 開新的邏輯輪就是 `true`。
 */
export function isLogicalTurnStart(event: SessionEvent): event is LogicalTurnStartEvent {
  return event.type === 'turn/start' && event.data.kind !== 'resume';
}

/**
 * 當前這一段物理輪次裡掛著一顆沒人回答的中斷。
 *
 * **「回答」在日誌上的樣子是下一顆 `turn/start`**（`kind` 為 `resume`），所以「還沒被
 * 回答」等同於「這一顆中斷之後沒有新的一輪開始」——也就是它落在當前這一段裡。停在核准
 * 點的那一輪照樣有 `turn/end`（見 `SessionEventMap` 的說明），所以拿 `turn/end` 判收工
 * 的人**一定要再問這一句**，不然它會把一個等著人按批准的會話當成閒下來了。
 *
 * @param events - 一份會話日誌到目前為止的全部事件，照 `seq` 排。
 * @returns 當前這一段裡有 `interrupt/raised` 時為真。
 */
export function hasUnansweredInterrupt(events: readonly SessionEvent[]): boolean {
  const start = currentTurnStart(events);
  if (start < 0) return false;
  for (let at = start + 1; at < events.length; at += 1) {
    if (events[at]?.type === 'interrupt/raised') return true;
  }
  return false;
}
