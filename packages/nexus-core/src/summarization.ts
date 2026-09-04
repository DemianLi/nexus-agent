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

import type { BaseMessage } from '@langchain/core/messages';
import { createSummarizationMiddleware } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { countTokensApproximately } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import type { SessionLookup } from './registry.js';
import { pruneToolResults } from './tool-result-pruner.js';

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
 * **`tokens: 100_000` 不是量出來的，是一個帶假設的常數**——這一句刻意跟
 * `DEFAULT_RECURSION_LIMIT` 與 `LIVE_TIMEOUT_MS` 的措辭相反，那兩個是實測值。
 * 真實上下文窗口在我們這棵樹裡**取不到**：`gpt-oss` 在整個 `node_modules/.pnpm/` 零命中，
 * 也沒有一支不花錢的端點查得到。所以這個數字建立在「窗口至少 128k（模型卡上的數字）」
 * 這個**未經實測**的假設上，取它的八成再往下取整——八成這一格是照 dsh 的
 * `thresholdRatio` 0.8。
 *
 * 窗口比 128k 小的話這道會來不及；`messages: 60` 那道就是為此存在的第二道。60 則約當
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
 * **那一輪摘要用的模型呼叫就不會發生**。
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
 * @param backend - 歷史寫去哪。
 * @param settings - 補滿的設定，來自 {@link resolveSummarizationSettings}。
 * @param sessions - 註冊表的 `sessions` 通道，用來問「這次壓縮該記進哪一份日誌」。
 *   **省略即不記**，而那是常態不是異常：`eval/runner.ts` 與絕大多數測試的組裝都沒有
 *   會話註冊表，它們不該為此拿到一個例外。同 {@link ./model-usage.ts} 的 `not-attached`。
 * @returns 可以直接放進 `middleware` 的 middleware。
 */
export function createSummarizer(
  backend: AnyBackendProtocol,
  settings: SummarizationSettings,
  sessions?: { forCall(config: unknown): SessionLookup },
): AgentMiddleware {
  const base = createSummarizationMiddleware({
    backend,
    trigger: settings.trigger.map((threshold) => ({ ...threshold })),
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
  // 兩層各管一個方向，刻意不合成一層：剪刀改請求、日誌讀回傳，合起來寫會讓兩個獨立的
  // 失敗模式共用一個 try。順序無所謂——它們碰的不是同一樣東西。
  const logged = sessions === undefined ? base : withCompactionLog(base, sessions);
  return withToolResultPruning(logged, settings.trigger);
}

/**
 * 把一把剪刀包在摘要器外面。
 *
 * 基座那顆是一個普通物件（`name` / `stateSchema` / `wrapModelCall` ／其餘鉤子皆為
 * `undefined`，全部可列舉），所以展開它就能原封不動保住 `name` 與 `stateSchema`——
 * **這兩樣少一樣，同名取代就不成立、狀態就對不上**，實測過才這樣寫。
 *
 * 這一層**沒有 closure 狀態**，所以 `foldSummarizer` 逐個 agent 建一份的理由沒有變多也
 * 沒有變少，還是原本那一條（基座那顆的 `sessionId` 在它自己的 closure 裡）。
 *
 * @param base - 基座那顆摘要器。
 * @param trigger - 我們配的那組門檻，同時當成「壓縮即將運行」的判準。
 * @returns 同名、同狀態、外面多一層前處理的 middleware。
 */
function withToolResultPruning(
  base: AgentMiddleware,
  trigger: readonly SummarizationThreshold[],
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 基座那顆一定有 wrapModelCall；沒有的話包了也沒意義，原樣回去。 */
  if (inner === undefined) return base;
  return {
    ...base,
    wrapModelCall: async (request, handler) => {
      const messages = request.messages ?? [];
      if (!isUnderCompactionPressure(effectiveMessages(messages, request.state), trigger))
        return inner(request, handler);
      const { prunedCount, messages: pruned } = pruneToolResults(messages);
      if (prunedCount === 0) return inner(request, handler);
      return inner({ ...request, messages: [...pruned] }, handler);
    },
  } as AgentMiddleware;
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
        });
      } catch {
        // 記不進去不能反過來把摘要器殺掉。見上面最後一段。
      }
      return response;
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
 * @param response - 摘要器 `wrapModelCall` 的回傳值。
 * @returns 這次壓縮的切點與落點，或 `undefined`（這一輪沒壓縮）。
 */
export function readSummarizationEvent(
  response: unknown,
): { cutoffIndex: number; filePath: string | null } | undefined {
  if (typeof response !== 'object' || response === null) return undefined;
  const update = (response as { update?: unknown }).update;
  if (typeof update !== 'object' || update === null) return undefined;
  const event = (update as { _summarizationEvent?: unknown })._summarizationEvent;
  if (typeof event !== 'object' || event === null) return undefined;
  const { cutoffIndex, filePath } = event as { cutoffIndex?: unknown; filePath?: unknown };
  if (typeof cutoffIndex !== 'number') return undefined;
  // `filePath` 是 `string | null`，而 `null` 是**有意義的那個值**（#66 的 fail-open），
  // 所以它不能被當成「沒有」而讓整筆消失。其餘型別當成沒寫成功。
  return { cutoffIndex, filePath: typeof filePath === 'string' ? filePath : null };
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
 * `pruneSession()`。我們的對應就是「基座摘要器這一輪會不會觸發」，所以這裡照抄它
 * `shouldSummarize` 的判準：門檻陣列並聯，任何一道成立就算壓力到了。
 *
 * **這個量測允許不準。** 因果鏈是「我們決定要不要試著剪 → 剪 → **基座自己重新計量**、
 * 由它決定要不要摘要」，權威永遠是基座那次重算。所以這裡不必去補 `systemMessage` 與
 * `tools` 的額外開銷，寧可略估得小一點（少剪一次，不會剪錯）。
 *
 * 但**允許不準不等於允許量錯東西**：要量的是 {@link effectiveMessages}，不是原串。
 *
 * `countTokensApproximately` 是 `langchain` 的公開匯出，**基座的 `countTotalTokens` 底下
 * 叫的就是它**，不是我們另外估一套。
 *
 * @param messages - 摘要器眼中的那一串（{@link effectiveMessages} 的輸出）。
 * @param trigger - 我們配的那組門檻。
 * @returns 任何一道門檻成立就 `true`。
 */
export function isUnderCompactionPressure(
  messages: readonly BaseMessage[],
  trigger: readonly SummarizationThreshold[],
): boolean {
  for (const threshold of trigger) {
    if (threshold.type === 'messages' && messages.length >= threshold.value) return true;
    if (threshold.type === 'tokens' && countTokensApproximately([...messages]) >= threshold.value)
      return true;
  }
  return false;
}
