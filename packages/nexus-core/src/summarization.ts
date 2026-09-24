/**
 * 摘要的門檻與去向——**由我們選，不是基座在執行期二選一挑的**。
 *
 * ## 為什麼要有這個檔
 *
 * `createSummarizationMiddleware({ backend })` 被基座**無條件**寫死進 root 與每一個
 * subagent 的 stack，而 `CreateDeepAgentParams` 上一個 summarization 欄位都沒有。門檻
 * 從 `computeSummarizationDefaults` 來，它只有兩條路：模型的 `profile.maxInputTokens`
 * 是數字就走比例（`fraction`），否則退到一組與模型無關的固定值。
 *
 * **我們走的是後者，而且沒有人在檢查那組固定值跟真實窗口的關係**——`openai/gpt-oss-120b`
 * 這個字串在整個 `node_modules/.pnpm/` 裡零命中，沒有任何一張 profile 表認得它。調研與
 * 決議見 [#142](https://github.com/DemianLi/nexus-agent/issues/142)。
 *
 * ## `fraction` 一個都不准用，這是量出來的
 *
 * 同一個缺值（`profile.maxInputTokens`）在兩個消費點被**不同地**忽略，方向相反：
 *
 * ```js
 * // shouldSummarize —— 缺值時整個分支跳過，回 false（fail-closed，一輩子不觸發）
 * if (t.type === "fraction" && maxInputTokens) { ... }
 *
 * // determineCutoffIndex —— 缺值時把 0.1 當成「保留 0.1 個 token」（fail-open，一則不留）
 * const targetTokenCount = keep.type === "fraction" && maxInputTokens
 *   ? Math.floor(maxInputTokens * keep.value) : keep.value;
 * ```
 *
 * 實測（#142 的留言）：`trigger: { fraction, 0.0001 }` 六輪一次都沒觸發；
 * `keep: { fraction, 0.1 }` 則是每一輪都重新摘要、一則逐字訊息都不留。**兩個都不警告、
 * 不拋。** 而 dsh 的預設答案（`thresholdRatio` 0.8 / `retainRatio` 0.16）正是比例形式,
 * 照抄過來會踩中其中一個。
 *
 * 所以 {@link SummarizationThreshold} 的 `type` **在型別層就沒有 `'fraction'` 這個值**，
 * 另外配一道執行期檢查（{@link resolveSummarizationSettings}）擋住繞過型別的呼叫端。
 *
 * ## 偏離登記（AGENTS.md 的規則）
 *
 * dsh 把壓縮做成一個能力 seam：`ctx.compaction` 有四個動詞、有 provider、有載入期驗證的
 * `modelPolicies`、有 `compaction/start`→`summary`→`end` 三個日誌事件與一把括住整個操作
 * 的鎖。deepagents 給的是**一個寫死的 middleware**。
 *
 * - **表達得出來的**：按模型選門檻（就是這個檔）、每個 subagent 都吃到同一份
 *   （`foldSubAgents` 打底）、歷史去處是獨立的一格（`backend` 參數）。
 * - **部分表達得出來的**：事件三連退成**一顆**（`compaction/summary`，見
 *   {@link withCompactionLog}）。鎖與 `start`／`end` 表達不出來——基座只在成功走完之後回一個
 *   帶 `_summarizationEvent` 的 `Command`，沒有「開始壓縮」這個可觀測的時刻，硬記一顆
 *   `start` 只能記在我們的猜測上。登記在
 *   [#143](https://github.com/DemianLi/nexus-agent/issues/143)。
 * - **表達不出來的**：手動與指定範圍的動詞、供應商回上下文溢出之後的壓縮重試。各自登記在
 *   [#149](https://github.com/DemianLi/nexus-agent/issues/149)、
 *   [#150](https://github.com/DemianLi/nexus-agent/issues/150)。
 *
 *   ⚠️ **最後一項的理由要修正。** 這裡原本寫的是「`overflow` / `context_length` /
 *   `contextWindow` 三個字串在整份 dist 裡零命中」——那句話字面上還是真的（三個都是 0），
 *   但**由它推出的「沒有任何恢復路徑」是錯的**。2026-09-04 重新查證：`ContextOverflowError`
 *   （`@langchain/core/errors`）在 dist 裡有 5 處，`isContextOverflow` 沿著 `cause` 鏈認它，
 *   而摘要器有一條**緊急摘要**的恢復路徑掛在上面（`dist/langsmith-zm0ILQsV.js:3126`、
 *   `:3151`、`:3168`、`:3225`）。分類靠的是**型別化的錯誤**，不是字串嗅探。
 *   還沒查的是「我們的 `ChatOpenAI` 會不會真的拋出那個型別」——那正是 #150 的題目，
 *   它不該從一個錯的前提開始。
 * - **退到最接近的實作**：dsh 的門檻是比例（吃得到窗口大小），我們退到它提供的另一個
 *   形式——絕對值（`retainTokens` 那條路）。代價是那個數字**手維護**，所以配了一條絆索：
 *   模型解得出 `maxInputTokens` 的那天要紅。
 */

import { ContextOverflowError } from '@langchain/core/errors';
import type { BaseMessage } from '@langchain/core/messages';
import { createSummarizationMiddleware } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { z } from 'zod';
import type { AgentMiddleware } from './base-types.js';
import { toLoggedMessage } from './logged-message.js';
import type { NexusPlugin } from './plugin.js';
import type { PluginRegistry, SessionLookup } from './registry.js';
import { defaultTokenAnchorBook, estimateAnchoredTokens } from './token-estimate.js';
import type { EstimatedRequest, TokenAnchorBook } from './token-estimate.js';
import { DEFAULT_TOOL_RESULT_PRUNE, withToolResultPruning } from './tool-result-pruner.js';
import type { ToolResultPruneConfig } from './tool-result-pruner.js';

/**
 * 基座那個 middleware 的名字。
 *
 * **同名取代是唯一的縫**：`mergeMiddlewareStack` 把 custom 分成兩堆，名字在 default 裡
 * 的走一個以 `name` 為鍵的 `Map`（後設的贏），不在的才追加。所以一個名字剛好是這個字串
 * 的 middleware 會**原地取代**內建那個，而不是在旁邊多跑一份。
 *
 * 它是一個字串常數而不是基座 export 的東西——基座改名時這裡不會紅，紅的是
 * `summarization.test.ts` 那條數 stack 名字的測試。那條測試存在的理由就是這個。
 */
export const SUMMARIZATION_MIDDLEWARE_NAME = 'SummarizationMiddleware';

/**
 * 一道門檻。
 *
 * **`'fraction'` 刻意不在這個聯集裡**，理由見檔頭：它需要
 * `model.profile.maxInputTokens`，而我們的模型解不出那個欄位，於是在兩個消費點各自
 * 靜默失敗一次、方向還相反。
 *
 * 這同時是一條**升版絆索**：基座哪天把 `'tokens'` 從它的 `ContextSize` 拿掉，
 * `fold.test.ts` 那條把設定指派給 `Parameters<typeof createSummarizationMiddleware>[0]`
 * 的型別斷言會在 typecheck 當場紅。
 */
export interface SummarizationThreshold {
  readonly type: 'messages' | 'tokens';
  readonly value: number;
}

/** 舊訊息裡過大的工具**參數**要不要剪。剪工具**結果**是另一件事，見 [#149](https://github.com/DemianLi/nexus-agent/issues/149)。 */
export interface SummarizationArgTruncation {
  /** 超過這個量就開始剪。 */
  readonly trigger: SummarizationThreshold;
  /** 最近這些則不剪。 */
  readonly keep: SummarizationThreshold;
  /** 單一參數的字元上限。省略即基座的 2000。 */
  readonly maxLength?: number;
}

/**
 * 摘要的完整設定。
 *
 * **四格全部必填，而這正是它買到的東西。** 基座的
 * `defaultsComputed = trigger != null` 讓 `applyModelDefaults` 在收到 `trigger` 的當下
 * 就 return，於是只給 `trigger` 會**同時**做兩件沒有徵兆的事：`truncateTrigger` 留在
 * `undefined`（arg 截斷停用），`keep` 留在建構初值 **20 而不是 fallback 的 6**。
 * 一個原因、兩個效果。設成必填之後，「只給一格」這種寫法在型別層就不成立。
 *
 * 呼叫端要覆寫的話給的是 `Partial<SummarizationSettings>`，逐格淺合併到
 * {@link DEFAULT_SUMMARIZATION} 上——所以四格永遠都在。
 */
export interface SummarizationSettings {
  /**
   * 觸發門檻，**並聯**：任一成立就摘要。
   *
   * 基座的 `shouldSummarize` 對陣列逐條試，`messages` 與 `tokens` 兩種都不看
   * `profile.maxInputTokens`。兩道並聯的用意是 token 估算靠不住時還有第二道兜著。
   */
  readonly trigger: readonly SummarizationThreshold[];
  /** 摘要之後最近這些則逐字留下。 */
  readonly keep: SummarizationThreshold;
  /** 工具參數截斷。 */
  readonly truncateArgs: SummarizationArgTruncation;
  /** 歷史落在 backend 的哪個前綴底下。 */
  readonly historyPathPrefix: string;
}

/**
 * 我們選的那一組。
 *
 * ## `trigger`：兩道並聯，都是絕對值
 *
 * **`tokens: 100_000` 原本是一個帶假設的常數，2026-09-04 那個假設被量到了。**
 * 它的來歷是「窗口至少 128k（模型卡上的數字）」取八成再往下取整——八成這一格照 dsh 的
 * `thresholdRatio` 0.8。當時真實窗口在我們這棵樹裡取不到（`gpt-oss` 在整個
 * `node_modules/.pnpm/` 零命中），所以那一句寫的是「未經實測」。
 *
 * **現在兩顆都量到了，而它們差五倍以上**（[#165](https://github.com/DemianLi/nexus-agent/issues/165)，
 * 做法見 `apps/harness/src/live-model.ts` 的 `DEFAULT_LIVE_MODEL_ID` 檔頭）：
 *
 * | 模型 | 量到的窗口 | `100_000` 佔它 |
 * | --- | --- | --- |
 * | `openai/gpt-oss-20b` | **131,007** | 76% |
 * | `nvidia/nemotron-3-super-120b-a12b`（今天的預設） | **≥ 700,045** | 14% |
 *
 * **值不改，但理由換了。** 它不再是「假設 128k 取八成」，而是「量過的最小那一顆是
 * 131,007，而 100,000 塞得進去」。塞得進去的餘裕有多少要扣掉輸出：那條路恆定送
 * `DEFAULT_LIVE_MAX_OUTPUT_TOKENS = 16_384`，所以最小那一顆的**輸入**上限其實是 114,623，
 * 而 100,000 離它只有 **14,623** 的餘裕。這是量過的最緊的一格，不是全部——**窗口是逐顆
 * 的性質，不是端點的性質**，同一個端點上這兩顆差五倍。換模型要重量一次。
 *
 * **反過來，對今天的預設模型它是很保守的**：700k 的窗口上 100,000 是 1/7，所以一場長任務
 * 會在還剩六分之五空間時就摘要，而每摘一次就往 backend 寫一份原文。這不是錯的（方向是
 * 安全的那一邊），但也不是**為它**挑的。要收緊得先讓窗口變成逐顆的設定而不是一個常數，
 * 那是另一張工——在那之前，這個數字守的是最小的那一顆。
 *
 * 窗口比這道還小的話它會來不及；`messages: 60` 那道就是為此存在的第二道。60 則約當
 * 30 輪模型呼叫，而 {@link DEFAULT_RECURSION_LIMIT} 換算後約 49 輪——所以一場跑滿的
 * 長任務會摘要一次，正常的基準任務（最長 3 次工具呼叫）碰不到它。
 *
 * ## `keep`：用訊息數，不用 token
 *
 * 這一格看起來該跟 `trigger` 同尺（token 對 token），但 `determineCutoffIndex` 的
 * `tokens` 分支是從**最新那則**往前累加、超過就切：
 *
 * ```js
 * if (tokensKept + msgTokens > targetTokenCount) { rawCutoff = i + 1; break; }
 * ```
 *
 * 最新那一則自己就超過門檻時（一個剛回來的超大工具結果），第一圈就 `rawCutoff =
 * messages.length`——**一則都不留**。那正是 `fraction` 那個 fail-open 的同一個形狀，
 * 而這張卡整個立論就是拒絕這種靜默失敗。`messages` 分支則是
 * `rawCutoff = messages.length - keep.value`，**恆定留下 20 則**。
 *
 * 代價是兩邊不同尺：留下的 20 則塞進一個超大工具結果時，摘要完可能立刻又過門檻。
 * 那個風險由 `summarization.test.ts` 的「超大工具結果不會逐輪重摘」釘住，不是靠這裡的
 * 一句註解。
 *
 * ## `truncateArgs`：顯式寫出來，是為了**保住**基座本來的行為
 *
 * 這一組正是基座 `FALLBACK_TRUNCATE_ARGS` 的值。我們不是在調它——我們是在避免它被
 * `defaultsComputed` 的提早 return 順手關掉。改動這裡的值要另外有理由。
 *
 * ## `historyPathPrefix`：同值明寫
 *
 * 值就是基座的預設。**明寫一次的意義是「去向也是我們選的」**，而且基座改預設時這個常數
 * 變成絆索。**改路徑不解決
 * [#66](https://github.com/DemianLi/nexus-agent/issues/66)**——那條路徑繞過 permissions
 * 是因為摘要器直接拿 backend 寫檔、不經過檔案工具那層規則，換個名字擋不住它。
 */
export const DEFAULT_SUMMARIZATION: SummarizationSettings = {
  trigger: [
    { type: 'tokens', value: 100_000 },
    { type: 'messages', value: 60 },
  ],
  keep: { type: 'messages', value: 20 },
  truncateArgs: {
    trigger: { type: 'messages', value: 20 },
    keep: { type: 'messages', value: 20 },
  },
  historyPathPrefix: '/conversation_history',
};

/**
 * 把呼叫端的覆寫合到 {@link DEFAULT_SUMMARIZATION} 上，順便擋掉繞過型別的門檻。
 *
 * **逐格淺合併**：給了 `trigger` 就整個換掉那個陣列（不是逐條併），給了 `keep` 就整個
 * 換掉那道門檻。四格永遠都在，所以「只給 trigger」那個陷阱在這裡不成立。
 *
 * @param override - 呼叫端的覆寫。省略即整份預設。
 * @returns 補滿的設定。
 * @throws 任何一道門檻的 `type` 不是 `'messages'` / `'tokens'`，或 `value` 不是正的
 *   有限數。
 */
export function resolveSummarizationSettings(
  override?: Partial<SummarizationSettings>,
): SummarizationSettings {
  const settings: SummarizationSettings = { ...DEFAULT_SUMMARIZATION, ...override };
  for (const [index, threshold] of settings.trigger.entries())
    assertThreshold(threshold, `trigger[${index}]`);
  assertThreshold(settings.keep, 'keep');
  assertThreshold(settings.truncateArgs.trigger, 'truncateArgs.trigger');
  assertThreshold(settings.truncateArgs.keep, 'truncateArgs.keep');
  if (settings.trigger.length === 0)
    throw new Error(
      'summarization.trigger 是空陣列。基座的 `shouldSummarize` 對空陣列一律回 false，' +
        '所以那等於沒有摘要器——要那個效果請明著傳 `summarization: false`。',
    );
  return settings;
}

/** 一道門檻的執行期檢查。型別已經擋掉 `'fraction'`，這道擋的是繞過型別的呼叫端。 */
function assertThreshold(threshold: SummarizationThreshold, where: string): void {
  const { type, value } = threshold;
  if (type !== 'messages' && type !== 'tokens')
    throw new Error(
      `summarization.${where} 的 type 是 "${String(type)}"，只收 "messages" 與 "tokens"。` +
        '"fraction" 一律不准：它要 `model.profile.maxInputTokens`，而我們的模型解不出那個' +
        '欄位——實測的下場是 trigger 一輩子不觸發、keep 一則逐字訊息都不留，兩邊都不警告。' +
        '模型哪天解得出那個欄位，`summarization.test.ts` 那條絆索會紅，那時再回頭決定。',
    );
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`summarization.${where} 的 value 是 ${String(value)}，要正的有限數。`);
}

/**
 * 依設定建一個摘要器，名字剛好撞上基座那個——**那就是取代它的方法**。
 *
 * `backend` 收成參數而不是沿用 agent 那個，是因為它**是獨立的一格**：摘要器寫歷史用的
 * backend 不必是 agent 的。fold 餵進來的是組裝點的 default backend 而不是折出來的
 * `CompositeBackend`，理由見 `foldRegistry`。
 *
 * ## 它外面還包了一把剪刀
 *
 * 回傳的不是基座那顆本人，是**它加一層前處理**：壓力達標時先剪掉過大的工具結果，再把
 * 剪過的訊息串交給基座那顆去決定要不要摘要。剪完壓力若已消失，基座自己會判 `false`，
 * **那一輪摘要用的模型呼叫就不會發生**。`pruning: false` 就不包，其餘照舊。
 *
 * **包住它是唯一的做法，不是偏好。** 基座的 `mergeMiddlewareStack` 回的是
 * `[...預設（同名就地取代）, ...新名字的, ...tail]`，而 `SummarizationMiddleware` 在預設
 * 那一段——所以一顆新名字的 middleware 一定排在它後面，也就是更**內層**，看到的已經是
 * 摘要器決定過的請求。詳見 {@link ./tool-result-pruner.ts} 檔頭的偏離登記二。
 *
 * ## 它也負責把「壓縮發生過」記進日誌
 *
 * 同一層縫再包一次，方向相反：剪刀看的是**請求**，日誌看的是**回傳值**。基座只在成功
 * 走完之後回一個 `new Command({ update: { _summarizationEvent } })`，而那個回傳值只有包住
 * 它的人拿得到——一顆排在它後面的新名字 middleware 看到的是更內層，看不到它的回傳。
 * 見 {@link withCompactionLog}。
 *
 * ## 生摘要的那次模型呼叫不上線
 *
 * 最內層還有一層 {@link withQuietSummaryCall}：摘要本身不是誰講的話，不該即時畫成一則 AI 訊息
 * （[#584](https://github.com/DemianLi/nexus-agent/issues/584)）。
 *
 * ## `tokens` 門檻不交給基座
 *
 * 基座只拿到 `messages` 那幾道。`tokens` 那幾道由 {@link withTokenBudget} 用錨定估算
 * （{@link ./token-estimate.ts}）比，理由與做法見那裡（[#588](https://github.com/DemianLi/nexus-agent/issues/588)）。
 * 剪刀的「壓力到了沒」也讀同一套估算。
 *
 * @param backend - 歷史寫去哪。
 * @param settings - 補滿的設定，來自 {@link resolveSummarizationSettings}。
 * @param sessions - 註冊表的 `sessions` 通道，用來問「這次壓縮該記進哪一份日誌」。
 *   **省略即不記**，而那是常態不是異常：`eval/runner.ts` 與絕大多數測試的組裝都沒有
 *   會話註冊表，它們不該為此拿到一個例外。同 {@link ./model-usage.ts} 的 `not-attached`。
 * @param pruning - 包在外面的那把剪刀的預算，來自 `resolveToolResultPruneConfig`；
 *   `false` 就不包（[#446](https://github.com/DemianLi/nexus-agent/issues/446)）。
 * @param book - 錨定估算的帳。省略即行程共用的那本；測試要隔離才傳。
 * @returns 可以直接放進 `middleware` 的 middleware。
 */
export function createSummarizer(
  backend: AnyBackendProtocol,
  settings: SummarizationSettings,
  sessions?: { forCall(config: unknown): SessionLookup },
  pruning: ToolResultPruneConfig | false = DEFAULT_TOOL_RESULT_PRUNE,
  book: TokenAnchorBook = defaultTokenAnchorBook,
): AgentMiddleware {
  const base = createSummarizationMiddleware({
    backend,
    // 只交 `messages` 那幾道，`tokens` 由 withTokenBudget 比。一道都沒有時是空陣列：基座逐條試，一條都不成立。
    trigger: settings.trigger
      .filter((threshold) => threshold.type === 'messages')
      .map((threshold) => ({ ...threshold })),
    keep: { ...settings.keep },
    historyPathPrefix: settings.historyPathPrefix,
    truncateArgsSettings: {
      trigger: { ...settings.truncateArgs.trigger },
      keep: { ...settings.truncateArgs.keep },
      ...(settings.truncateArgs.maxLength !== undefined && {
        maxLength: settings.truncateArgs.maxLength,
      }),
    },
  }) as unknown as AgentMiddleware;
  // 貼著基座包：外面幾層看到的 `request.model` 與交下去的都是原本那顆，不會碰到替身。
  const quiet = withQuietSummaryCall(base);
  // 兩層各管一個方向，刻意不合成一層：剪刀改請求、日誌讀回傳，合起來寫會讓兩個獨立的
  // 失敗模式共用一個 try。順序無所謂——它們碰的不是同一樣東西。預算那層讀的是基座交下去的
  // 請求，不是進來的那份，也不碰回傳值。
  const logged = sessions === undefined ? quiet : withCompactionLog(quiet, sessions);
  const budgeted = withTokenBudget(logged, settings.trigger, book, sessions);
  if (pruning === false) return budgeted;
  return withToolResultPruning(
    budgeted,
    (request) => isUnderCompactionPressure(request, settings.trigger, book),
    pruning,
  );
}

/**
 * LangGraph 的 messages handler 認得的「這次呼叫不要串上線」標記。
 *
 * v3 用的 `pregel/messages-v2.js` 與舊的 `pregel/messages.js` 都在 `handleChatModelStart` 查它（另一個認得的是
 * `langsmith:nostream`）：帶著它的那次呼叫不進 `metadatas`，之後的 `message-start`／逐段片段／`message-finish`
 * 全部不送。
 */
const SUMMARY_CALL_TAG = 'nostream';

/**
 * 讓生摘要的那次模型呼叫不上線（[#584](https://github.com/DemianLi/nexus-agent/issues/584)）。
 *
 * ## 病
 *
 * 基座在 `wrapModelCall` 裡用 `request.model.invoke([摘要提示])` 生摘要，沒帶 config
 * （`dist/langsmith-zm0ILQsV.js:3084`）。那次呼叫繼承圖的 callback，LangGraph 的 messages handler 就把它當成一則
 * root 的 AI 訊息送上線——而且是**串流**的：pump 走 v3 時基座裝了串流 handler，`invoke` 也被導去走
 * `_streamResponseChunks`。它跟主模型那次同一個節點、同一個 namespace，線上的 frame 分不出來；歷史則從日誌折，
 * 那一則根本不在，於是即時多一則、重新整理就沒了。
 *
 * ## 做法
 *
 * 交給基座的 `request.model` 換成一個替身：只攔 `invoke`，補上 {@link SUMMARY_CALL_TAG}，其餘一律照讀本尊
 * （基座還會讀它的 `profile`）。基座對那顆模型只呼叫 `invoke` 這一個方法，而那正是生摘要的地方。
 * 基座把請求交下去時（`handler({ ...request, messages })`），再把替身換回本尊——主模型那次照常上線。
 *
 * **不用 `withConfig`**：`ChatOpenAI` 覆寫了它，重建實例時會弄丟 `signal`；換成核心的 `RunnableBinding` 則丟掉
 * `profile`。替身兩樣都不碰。
 *
 * tags 只蓋掉從父層繼承的那一格 `tags`，callbacks 照樣從父層來（`ensureConfig`），父層 callback manager 上的可繼承
 * tags 也還在，所以那次呼叫照樣被計量、照樣歸在同一份日誌。
 *
 * ## 與 dsh 的偏離（AGENTS.md 的規則）
 *
 * dsh 的摘要走 `ctx.llm.stream`（`purpose: 'compaction'`），在自己那一層組 chunk
 * （`packages/compaction/compaction-basic/src/summarizer.ts`，`46a7f68`），本來就不經過對話紀錄的串流。我們的
 * 摘要呼叫長在基座的 middleware 裡、跟主模型共用一條 callback 鏈，表達不出「另起一條不上線的呼叫」。
 * 退到最接近的：同一次呼叫，貼一個串流層認得的標記。結果一樣：摘要文字不進對話，只以 `compaction/summary`
 * 那一顆存在。
 *
 * @param base - 基座那顆摘要器。
 * @returns 同名、同狀態、生摘要那次不上線的 middleware。
 */
function withQuietSummaryCall(base: AgentMiddleware): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 同 withCompactionLog。 */
  if (inner === undefined) return base;
  return {
    ...base,
    wrapModelCall: (request, handler) => {
      const model = request.model;
      // 基座自己有退路（`getChatModel()`），沒有模型可換就原樣交給它。
      /* v8 ignore next */
      if (model === undefined) return inner(request, handler);
      const quiet = quietInvoke(model);
      return inner({ ...request, model: quiet }, (sent) =>
        handler(sent.model === quiet ? { ...sent, model } : sent),
      );
    },
  } as AgentMiddleware;
}

/**
 * 一顆只有 `invoke` 會補上 {@link SUMMARY_CALL_TAG} 的替身。
 *
 * 其餘屬性照讀本尊。`Reflect.get` 不給 receiver，所以 getter 以本尊為 `this`，碰到私有欄位也不會因為 `this` 是
 * Proxy 而拋；`invoke` 也綁在本尊上。**經替身叫的其他方法 `this` 仍是替身**——今天基座對它只讀 `profile`、只叫
 * `invoke`，交下去之前又換回本尊，所以碰不到那種呼叫。
 *
 * @param model - 本尊。
 * @returns 替身。
 */
function quietInvoke<T extends object>(model: T): T {
  return new Proxy(model, {
    get(target, key) {
      if (key !== 'invoke') return Reflect.get(target, key) as unknown;
      const invoke = (target as { invoke(input: unknown, config?: unknown): unknown }).invoke;
      return (input: unknown, config?: { tags?: readonly string[] }) =>
        invoke.call(target, input, {
          ...config,
          tags: [...(config?.tags ?? []), SUMMARY_CALL_TAG],
        });
    },
  });
}

/**
 * 把「壓縮發生過」記進這次呼叫所屬的那一份會話日誌。
 *
 * ## 為什麼是包住它，而不是一顆新 middleware
 *
 * 基座交出摘要事件的方式**只有一個**：`performSummarization` 成功走完之後
 * `return new Command({ update: { _summarizationEvent: {...}, _summarizationSessionId } })`
 * （`dist/langsmith-zm0ILQsV.js:3181`）。那是一個**回傳值**，不是鉤子、不是廣播。所以：
 *
 * - 一顆新名字的 middleware 一定排在 `SummarizationMiddleware` 後面（更內層，見
 *   {@link SUMMARIZATION_MIDDLEWARE_NAME}），它連那次呼叫都看不到，更別說回傳值。
 * - 從 `request.state._summarizationEvent` 讀是**上一輪**留下的殘值，而 `filePath` 這一格
 *   只在剛生出來的那一份上有意義（要的是「這次寫成功了沒」）。
 * - 事後讀 `agent.getState(config)` 要求呼叫端有 checkpointer，而 `eval/runner.ts` 沒有。
 *
 * 包住它三個問題一起沒有：拿到的是當下、是完整的、而且不要求 checkpointer。
 *
 * ## subagent 那側**寫得進去**，而這是 #143 卡上決定 3 的反面
 *
 * 卡上原本判斷 subagent 的壓縮紀錄結構上取不到，依據是 `EXCLUDED_STATE_KEYS`（`:3263`）
 * 把 `_summarizationEvent` 擋在「傳進／傳出 subagent」兩個方向之外。**那條擋的是 root 的
 * 快照讀得到什麼，不是這裡。** 我們不經過 root 的 state：`foldSummarizer` 逐個 agent 建
 * 一份摘要器，subagent 那份的 `wrapModelCall` 就在 subagent 自己的圖裡跑，回傳值當場拿到，
 * 再用 `checkpoint_ns` 問這次呼叫屬於哪一份日誌——跟 `model/usage` 同一把鑰匙。
 *
 * ## 它不准拋
 *
 * `model/usage` 那顆坐在 request path 上就已經不准拋了；**這裡更嚴，因為這一層是同名
 * 取代**：從這裡漏出去的錯不只是掉一行日誌，是把摘要器本身連根拔掉。所以 `forCall` 的
 * 三種非 `ok` 與 `append` 自己拋（`snapshotJsonValue` 對非純 JSON 是當場拋的）全部吃掉。
 *
 * @param base - 基座那顆摘要器。
 * @param sessions - 註冊表的 `sessions` 通道。
 * @returns 同名、同狀態、多一層事後紀錄的 middleware。
 */
function withCompactionLog(
  base: AgentMiddleware,
  sessions: { forCall(config: unknown): SessionLookup },
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 基座那顆一定有 wrapModelCall；沒有的話包了也沒意義，原樣回去。 */
  if (inner === undefined) return base;
  return {
    ...base,
    wrapModelCall: async (request, handler) => {
      const response = await inner(request, handler);
      const event = readSummarizationEvent(response);
      if (event === undefined) return response;
      try {
        // `runtime.configurable` 就是 `forCall` 要的那份——包回一層 `configurable` 是因為
        // 它收的是 handler 的 config 形狀，不是 configurable 本身。同 model-usage.ts。
        const found = sessions.forCall({
          configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
        });
        if (found.kind !== 'ok') return response;
        found.log.append('compaction/summary', {
          cutoffIndex: event.cutoffIndex,
          messagesBefore: (request.messages ?? []).length,
          filePath: event.filePath,
          // 推模型歷史要拿它換掉被壓掉的那一段（#305）。基座一定給；沒給就整個不放 key。
          ...(event.summaryMessage === undefined
            ? {}
            : { summary: toLoggedMessage(event.summaryMessage) }),
        });
      } catch {
        // 記不進去不能反過來把摘要器殺掉。見上面最後一段。
      }
      return response;
    },
  } as AgentMiddleware;
}

/**
 * `tokens` 門檻由這一層比，比的是**錨定估算**（{@link ./token-estimate.ts}），順手把比過的那個數記進日誌
 * （`context/measure`，web 的用量表讀它，[#528](https://github.com/DemianLi/nexus-agent/issues/528)）。
 * [#588](https://github.com/DemianLi/nexus-agent/issues/588)。
 *
 * ## 比的是交下去的那份
 *
 * 基座的 `wrapModelCall` 最後一定是 `handler({ ...request, messages })`：剪刀剪過、參數截過、摘要了的話是
 * `[摘要, ...留下的]`（`dist/langsmith-zm0ILQsV.js:3220`、`:3163`）。所以這裡包的是**傳給基座的 `handler`**，
 * 估它收到的那份——**就是要送上線的那份**，錨上的實數也是同一個階段的東西，兩邊同一把尺。記進日誌的正是這次
 * 比過的那個數，所以用量表的環與摘要時機是同一個數：環到 100% 就是這一層觸發摘要。
 *
 * ## 超過就借基座的溢出恢復路徑摘要
 *
 * 基座的判準寫死在 `countTotalTokens`（純估算），沒有縫注入別的數。但它在「不摘要」那條路上把
 * `handler` 包在 `try` 裡，接到 `ContextOverflowError` 就走緊急摘要：摘要、再叫一次 `handler`
 * （`:3219-3229`）。所以超過預算時這裡**拋一顆合成的 `ContextOverflowError`**，由基座自己摘要——保留、切點、
 * 寫歷史、回 `_summarizationEvent` 全是基座原本那套。摘要完再叫進來的那一次照常放行。
 *
 * **只在基座會接的地方拋**，其他三條路上的 `handler` 沒有 `try`，拋了就是整輪失敗：
 *
 * - 摘要器眼中那串是空的（`:3197` 直接交下去）——不拋。
 * - 有一道 `messages` 門檻成立（基座走 `performSummarization`，`cutoffIndex <= 0` 那條直接交下去，`:3137`）——不拋。
 *   這裡照抄 `shouldSummarize` 的 `messages` 判準；截參數不改則數，所以用摘要器眼中那串的長度就對得上。
 * - 已經拋過一次（摘要完、或切不出東西又交下來的那一次）——不拋。一次呼叫最多一次。
 *
 * **不數成一步**：拋在內層 `handler` 之前，`model-calls.ts` 那顆在更內層，根本沒被叫到；日誌上只有摘要完
 * 送出去的那一對起訖。真的溢出（供應商回的）照舊算兩步。
 *
 * ## 與 dsh 的偏離（AGENTS.md 的規則）
 *
 * 1. **分子：錨照 dsh，估算器與內容比例不照**，見 {@link ./token-estimate.ts} 的檔頭。dsh 的壓縮與
 *    `contextPressure` 讀同一個 `measure()`，顯示與判準本來就同一個數；我們這一層就是那個「同一個」。
 * 2. **觸發借基座的溢出恢復路徑**：基座的判準表達不出錨（沒有注入點），能改變它決定的唯一入口是那條 `catch`。
 *    **絆索**：模型哪天解得出 `profile.maxInputTokens`，那條 `catch` 會拿合成的這顆去調 `tokenEstimationMultiplier`、
 *    也可能走 `compactToolResults`——`summarization.test.ts` 那條「解得出就要紅」的絆索也管這件事。
 * 3. **載體：一顆事件**。dsh 不記這種事件，壓力從 `request/header` 與 surface 投影。我們的日誌不記 system、工具
 *    定義與請求標頭，重建不出這份請求，所以退到只帶量測結果的一顆，同 `model/usage` 那條偏離。**分母也不同**：
 *    dsh 除的是模型窗口，我們除的是摘要門檻（#528 grilling Q2）。
 *
 * ## 量與記都不准拋
 *
 * 估不出來就不比、不記，退回基座自己的 `messages` 門檻；記不進去吃掉，同 {@link withCompactionLog}。**`handler`
 * 本身拋的錯原樣往外傳**——那是基座的緊急摘要要接的。
 *
 * **記的時刻是「下一層正常回來」**：拋錯的那次不記；停止閘門（`turnCancel`）擋下的那一次照記——閘門在更內層，
 * 它回的合成收尾對這裡就是正常回來。`turn-cancel.test.ts` 的委派那條釘著這件事。
 *
 * @param base - 摘要器（包過 {@link withCompactionLog} 的也行，它原樣轉交 `handler`）。
 * @param trigger - 全部門檻；比的是 `tokens` 那幾道，`messages` 那幾道用來判斷基座走哪條路。原樣記進每一筆。
 * @param book - 錨定估算的帳。
 * @param sessions - 註冊表的 `sessions` 通道。省略即不記，照樣比。
 * @returns 同名、同狀態、多一層預算的 middleware。
 */
function withTokenBudget(
  base: AgentMiddleware,
  trigger: readonly SummarizationThreshold[],
  book: TokenAnchorBook,
  sessions?: { forCall(config: unknown): SessionLookup },
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 同 withCompactionLog。 */
  if (inner === undefined) return base;
  const thresholds = trigger.map(({ type, value }) => ({ type, value }));
  const budgets = trigger.filter((t) => t.type === 'tokens').map((t) => t.value);
  const budget = budgets.length === 0 ? undefined : Math.min(...budgets);
  const byMessages = trigger.filter((t) => t.type === 'messages').map((t) => t.value);
  return {
    ...base,
    wrapModelCall: (request, handler) => {
      const view = effectiveMessages(request.messages ?? [], request.state);
      const baseWillCatch = view.length > 0 && !byMessages.some((value) => view.length >= value);
      let thrown = false;
      return inner(request, async (sent) => {
        let estimate: ReturnType<typeof estimateAnchoredTokens> | undefined;
        try {
          estimate = estimateAnchoredTokens(sent, book);
        } catch {
          // 估不出來就不比、不記，不能反過來擋住這次呼叫。
        }
        if (estimate !== undefined && budget !== undefined && baseWillCatch && !thrown) {
          if (estimate.tokens >= budget) {
            thrown = true;
            throw new ContextOverflowError(
              `摘要預算：這份請求估計 ${estimate.tokens} token，到了 ${budget} 的門檻。`,
            );
          }
        }
        const response = await handler(sent);
        if (estimate === undefined) return response;
        try {
          book.record(response, sent, estimate.estimated, estimate.basis);
        } catch {
          // 記帳失敗只是下一次少一個錨。
        }
        if (sessions === undefined) return response;
        try {
          const found = sessions.forCall({
            configurable: (request as { runtime?: { configurable?: unknown } }).runtime
              ?.configurable,
          });
          if (found.kind === 'ok')
            found.log.append('context/measure', {
              approxTokens: estimate.tokens,
              messageCount: (sent.messages ?? []).length,
              thresholds,
            });
        } catch {
          // 記不進去不能反過來把摘要器殺掉。見 withCompactionLog。
        }
        return response;
      });
    },
  } as AgentMiddleware;
}

/**
 * 從摘要器的回傳值裡認出「這一次真的壓縮了」。
 *
 * **鴨子型別，不是 `instanceof Command`。** `Command` 是 `@langchain/langgraph` 的 class，
 * 而 pnpm 的樹底下同一個套件可能有多份實例（基座相依的那份與我們相依的那份），
 * `instanceof` 跨實例是 `false`——那種錯不會拋，只會讓事件永遠記不到。
 *
 * 沒壓縮的那些輪回的是模型的回應，`update` 這個 key 根本不存在，所以判別是乾淨的。
 *
 * **`summaryMessage` 也是鴨子型別**，同一條理由：認的是它有 `toDict()`，也就是
 * {@link ./logged-message.ts | toLoggedMessage} 要的那一個方法。
 *
 * @param response - 摘要器 `wrapModelCall` 的回傳值。
 * @returns 這次壓縮的切點、落點與換上去的摘要訊息，或 `undefined`（這一輪沒壓縮）。
 */
export function readSummarizationEvent(
  response: unknown,
): { cutoffIndex: number; filePath: string | null; summaryMessage?: BaseMessage } | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const update = (response as { update?: unknown }).update;
  if (typeof update !== 'object' || update === null) return undefined;
  const event = (update as { _summarizationEvent?: unknown })._summarizationEvent;
  if (typeof event !== 'object' || event === null) return undefined;
  const { cutoffIndex, filePath, summaryMessage } = event as {
    cutoffIndex?: unknown;
    filePath?: unknown;
    summaryMessage?: unknown;
  };
  if (typeof cutoffIndex !== 'number') return undefined;
  const summary =
    typeof summaryMessage === 'object' &&
    summaryMessage !== null &&
    typeof (summaryMessage as { toDict?: unknown }).toDict === 'function'
      ? (summaryMessage as BaseMessage)
      : undefined;
  // `filePath` 是 `string | null`，而 `null` 是**有意義的那個值**（#66 的 fail-open），
  // 所以它不能被當成「沒有」而讓整筆消失。其餘型別當成沒寫成功。
  return {
    cutoffIndex,
    filePath: typeof filePath === 'string' ? filePath : null,
    ...(summary === undefined ? {} : { summaryMessage: summary }),
  };
}

/**
 * **摘要器眼中的那一串訊息**，也就是量壓力該量的東西。
 *
 * 基座的每一步計量走的都是 `getEffectiveMessages(request.messages, request.state)`：
 * 摘要發生過之後那是 `[摘要, ...messages.slice(cutoffIndex)]`——**一串短得多的東西**。
 *
 * 照 `request.messages` 原串去量會出一個很難看見的錯：**圖的狀態只會長不會縮**（原文都
 * 還在，那正是這個做法「原文沒有消失」的另一面），所以門檻**從第一次摘要起就永遠成立**，
 * 閘門卡在開，剪刀退化成「每次超預算就剪」——正是 [#149](https://github.com/DemianLi/nexus-agent/issues/149)
 * 明著否掉的那筆偏離，也正是 dsh 那句「低于压力的对话绝不被碰」禁止的事。而它不會拋、
 * 不會少剪，只會多剪，所以行為上幾乎看不出來。
 *
 * 這是**抄一份**基座那個函式，不是叫它——它沒有匯出。基座改了這個形狀時這裡不會紅，
 * 紅的是 `summarization.test.ts` 那條「摘要之後照樣剪得到」加這個檔的單元測試。
 *
 * @param messages - 這次請求的訊息串。
 * @param state - 這次請求的 graph state；摘要事件在裡面。
 * @returns 摘要器會拿去計量的那一串。沒有摘要事件時就是原串。
 */
export function effectiveMessages(
  messages: readonly BaseMessage[],
  state: unknown,
): readonly BaseMessage[] {
  const event = (state as { readonly _summarizationEvent?: unknown } | null | undefined)
    ?._summarizationEvent;
  if (event === null || typeof event !== 'object') return messages;
  const { summaryMessage, cutoffIndex } = event as {
    readonly summaryMessage?: unknown;
    readonly cutoffIndex?: unknown;
  };
  if (typeof cutoffIndex !== 'number' || summaryMessage === undefined) return messages;
  return [summaryMessage as BaseMessage, ...messages.slice(cutoffIndex)];
}

/**
 * 壓力到了沒。
 *
 * dsh 那側「低于压力的对话绝不被碰」是**呼叫端**的性質——`compaction-basic` 壓力達標才
 * `pruneSession()`。我們的對應就是「摘要器這一輪會不會觸發」，所以這裡跟摘要判準用同一套：`messages` 門檻照抄
 * 基座的 `shouldSummarize`，`tokens` 門檻讀 {@link withTokenBudget} 那個錨定估算（[#588](https://github.com/DemianLi/nexus-agent/issues/588)）。
 *
 * **估的是還沒剪的那一份**：剪刀在最外層，看到的是原串，錨上的實數是上一次**送出去**（剪過、截過）的那份。
 * 上一次剪過、這一次沒剪的話，被剪掉的那一截會出現在增量裡——所以這裡的數一定不小於摘要器那一層比的數，
 * 上一次剪過不會讓這一次誤判成沒壓力、下一次又剪（來回震盪）。差的是還沒截的工具參數那一截，有界，而且
 * 只會讓剪刀早一點動，不會讓摘要早一點發生。
 *
 * 要量的是 {@link effectiveMessages}，不是原串：摘要過之後原串只長不縮，照原串量門檻會從第一次摘要起永遠成立。
 *
 * @param request - 剪刀收到的那份請求。
 * @param trigger - 我們配的那組門檻。
 * @param book - 錨定估算的帳。
 * @returns 任何一道門檻成立就 `true`。
 */
export function isUnderCompactionPressure(
  request: EstimatedRequest & { readonly state?: unknown },
  trigger: readonly SummarizationThreshold[],
  book: TokenAnchorBook = defaultTokenAnchorBook,
): boolean {
  const messages = effectiveMessages(request.messages ?? [], request.state);
  let tokens: number | undefined;
  for (const threshold of trigger) {
    if (threshold.type === 'messages' && messages.length >= threshold.value) return true;
    if (threshold.type === 'tokens') {
      tokens ??= estimateAnchoredTokens({ ...request, messages }, book).tokens;
      if (tokens >= threshold.value) return true;
    }
  }
  return false;
}

/**
 * 摘要設定的服務名。fold 從這裡讀條目提供的那一份。
 *
 * **沒人提供不等於「關掉」**：那兩種成因的正確答案相反，分野見
 * {@link ./registry.ts | DisabledEntryView}。
 */
export const SUMMARIZATION_SERVICE = 'summarization';

/**
 * 這個條目的 plugin 名。
 *
 * **承重的常數**：{@link ./fold.ts | foldRegistry} 拿它去問
 * {@link ./registry.ts | DisabledEntryView}。刻意不是條目的 `id`——id 是使用者的 patch
 * 改得動的字串（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 */
export const SUMMARIZATION_PLUGIN_NAME = 'summarization';

/**
 * 一道門檻的形狀。
 *
 * **`type` 用 `z.enum` 是為了型別對得上，不是因為它在守門。** 這一格必須是
 * {@link SummarizationThreshold} 的那個聯集，`resolveSummarizationSettings` 才收得下；而值
 * 的規則（正的有限數、`trigger` 不可以是空陣列）留在那個 resolve 裡，沒有抄過來。
 *
 * **把它放寬成 `z.string()` 不會改變任何結果——量過的。** 那時擋下 `'fraction'` 的換成
 * `assertThreshold`，載入一樣失敗、訊息一樣指得出是哪一格，只有措辭不同（zod 的
 * 「expected one of」換成那段講 `'fraction'` 為什麼一律不准的長篇）。所以**不要**把這一行
 * 當成那條規則的守衛去釘它：它是等價突變，釘了只會釘住 zod 的措辭。
 */
const thresholdSchema = z.strictObject({
  type: z.enum(['messages', 'tokens']),
  value: z.number(),
});

/**
 * 條目收的設定。每一格都可省，省掉的那格用 {@link DEFAULT_SUMMARIZATION} 的值。
 *
 * **預設值只寫在一個地方**：這裡的 `.default()` 指的就是那個常數的欄位。物件與陣列的
 * 預設寫成 thunk 並且複製一份，因為 zod 的 `.default()` 只收可變的東西，而
 * {@link DEFAULT_SUMMARIZATION} 的欄位是 `readonly`——複製也順帶保證沒有人能從驗出來的
 * 設定改到那個常數。
 *
 * **`truncateArgs` 是整顆有預設，不是逐格。** 所以只給 `truncateArgs: { trigger: ... }`
 * 會在 zod 當場失敗（`keep` 是必填）。**這比今天那條路好**：`resolveSummarizationSettings`
 * 是淺合併，給半顆 `truncateArgs` 之後 `assertThreshold` 會去讀 `undefined.type`。
 * 兩條路不一致是刻意的，不是漏對齊。
 */
export const summarizationConfigSchema = z.strictObject({
  /** 見 {@link SummarizationSettings.trigger}。 */
  trigger: z
    .array(thresholdSchema)
    .default(() => DEFAULT_SUMMARIZATION.trigger.map((threshold) => ({ ...threshold }))),
  /** 見 {@link SummarizationSettings.keep}。 */
  keep: thresholdSchema.default(() => ({ ...DEFAULT_SUMMARIZATION.keep })),
  /** 見 {@link SummarizationSettings.truncateArgs}。 */
  truncateArgs: z
    .strictObject({
      trigger: thresholdSchema,
      keep: thresholdSchema,
      maxLength: z.number().optional(),
    })
    .default(() => ({
      trigger: { ...DEFAULT_SUMMARIZATION.truncateArgs.trigger },
      keep: { ...DEFAULT_SUMMARIZATION.truncateArgs.keep },
    })),
  /** 見 {@link SummarizationSettings.historyPathPrefix}。 */
  historyPathPrefix: z.string().default(DEFAULT_SUMMARIZATION.historyPathPrefix),
});

/** {@link summarizationConfigSchema} 驗完的形狀。 */
export type SummarizationConfig = z.infer<typeof summarizationConfigSchema>;

/**
 * 摘要的**設定條目**（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 *
 * 它只做一件事：把驗過的設定提供成 {@link SUMMARIZATION_SERVICE} 服務。
 * **摘要器不在這裡建**——它由 {@link ./fold.ts | foldRegistry} 逐個 agent 各建一份
 * （`sessionId` 在 closure 裡，共用會讓兩個 agent 的歷史寫進同一個檔）。
 *
 * **關掉它跟前兩顆不同形。** `disabled: true` 之後 fold 發出去的不是「沒有」，是一顆
 * **同名空殼**——基座無條件建的那顆摘要器靠同名取代才消得掉，真的不掛的話它會補回來。
 * 射程是 root、宣告的 subagent 與 fold 補的 `general-purpose` 各一顆。
 *
 * **這是登記過的偏離**，同前兩顆：dsh 那側 `compaction-basic` 是 base 的一個獨立套件。
 * 我們表達不出來的是「逐個 agent 各建一份」與「同名取代基座那顆」。偏的是載體。
 */
export const summarizationPlugin: NexusPlugin<SummarizationConfig> = {
  name: SUMMARIZATION_PLUGIN_NAME,
  Config: summarizationConfigSchema,
  apply(registry: PluginRegistry, config: SummarizationConfig) {
    // **驗在這裡、只驗一次。** 值的規則住在 resolve 裡，所以提供出去的是已經正規化過的
    // 設定，fold 拿到就直接用。
    registry.services.provide(SUMMARIZATION_SERVICE, resolveSummarizationSettings(config));
  },
};

export default summarizationPlugin;
