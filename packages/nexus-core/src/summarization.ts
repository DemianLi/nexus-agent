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
 *
 * ## 摘要的提示詞（[#432](https://github.com/DemianLi/nexus-agent/issues/432)）
 *
 * 基座預設的 `DEFAULT_SUMMARY_PROMPT` 只要「主話題、關鍵決策、必要背景」，沒有一個字保護使用者
 * 的原意與糾正。dsh 的 `COMPACTION_INSTRUCTION`
 * （`packages/compaction/compaction-basic/src/summarizer.ts`，`5badb15`）是八段固定結構，第一段
 * 「Primary Request and Intent」要求逐字引用、第四段「Errors and Fixes」連同使用者的回饋，規則裡
 * 還有「忠實保留指示，尤其是糾正」。{@link SUMMARY_PROMPT} 取它的文字，**用英文**（dsh 明寫要英文，
 * 這是給模型讀的，不是給 demian 讀的）。**沒有把「是哪一版提示詞」寫進日誌**：dsh 的
 * `compaction/summary` 也沒有這一格，指令是程式碼常數，事件記的是那次呼叫的信封。
 *
 * ### 與 dsh 的差，各自的理由（AGENTS.md 的偏離規則）
 *
 * - **形狀：模板，不是「重播整串對話再接一則 user 訊息」。** dsh 把整串原對話（連同 system 與工具
 *   schema）原樣重播，指令放在最後一則，這樣那次摘要呼叫是上一次主請求的**前綴**，吃得到供應商的
 *   KV cache。基座的縫表達不出這個：`createSummary` 只把 `getBufferString(要摘的那段)` 攤成**一個
 *   字串**、塞進 `summaryPrompt` 的 `{conversation}`、包成**一則** `HumanMessage` 交給 `request.model.invoke`；
 *   切點在基座裡算，這一層拿不到那串訊息；那顆 `request.model` 也是還沒綁工具、不帶主 system prompt 的本尊。
 *   要重播得換掉基座整顆摘要器（切點、offload、事件都跟著重寫），不是這一張卡的量。退到最接近的：
 *   模板，**對話在前、指令在後**（dsh 的先後），所以 dsh 那句「Condense the conversation ABOVE」不用改
 *   就成立。代價：這一次呼叫的輸入按全價算，沒有量過重播能省多少。
 * - **前一次摘要的標籤。** dsh 認 `<compacted-summary>`；我們的是基座 `buildSummaryMessage` 包的：有
 *   `filePath` 時是一段前言加 `<summary>…</summary>`，**沒有**（offload 失敗）時只有
 *   「Here is a summary of the conversation to date:」一句，不包標籤。所以那條規則兩種都要認。
 *
 * ### 摘要輸出 fail-closed（[#1539](https://github.com/DemianLi/nexus-agent/issues/1539)）
 *
 * 基座的 `createSummary` 只取回覆的 `.text`，不看結束原因、不看是否為空、不看有沒有圖：被截斷的半份、全空白、只有推理、
 * 夾了圖的摘要都會被換上去。dsh 的 `summarizeWithLlm` 對這幾種一律拒收（`compaction-basic/src/summarizer.ts:164-171`、
 * `:196-221`，`687f282e`）。我們在 {@link quietInvoke} 拿得到完整的那則 `AIMessage`，在那裡照同樣的順序檢查，拋
 * {@link SummaryRejectedError}，走 #1374 既有的退路。不是偏離：dsh 判的是組好的區塊與 `FinishReason`，我們判的是
 * `response_metadata.finish_reason` 與 `content`。圖片區塊 dsh 只認 `type === 'image'`（`llm/src/content.ts:126-128`）；
 * LangChain 的圖片另有 OpenAI 形狀的 `image_url`，兩種都認是同一個語意。
 *
 * ⚠️ **基座的 `{conversation}` 替換有一個已知的小缺陷，我們這層擋不住**：`createSummary` 用
 * `String.prototype.replace(字串, 字串)`，替換字串裡的 `$&`、`` $` ``、`$'`、`$$` 會被當成特殊樣式解讀。
 * 對話文字裡有 `$$`（shell 的行程號、Makefile）時，餵給模型的那份會少一個 `$`；有 `$&` 時會多出一段
 * 字面的 `{conversation}`（實測）。只影響「要摘的那份」的字面，不影響摘要的結構，也沒有東西會因此拋。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ContextOverflowError } from '@langchain/core/errors';
import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage, MessageContent } from '@langchain/core/messages';
import { createSummarizationMiddleware } from 'deepagents';
import type { AnyBackendProtocol } from 'deepagents';
import { z } from 'zod';
import type { AgentMiddleware } from './base-types.js';
import {
  assumedFileLine,
  hasAttachmentBlocks,
  rewriteAttachmentBlocks,
  summaryImageText,
} from './attachment-projection.js';
import { isFileBlock } from './attachment-ref.js';
import { toLoggedMessage } from './logged-message.js';
import { isMaxTokensFinish } from './max-tokens.js';
import { captureModelCall, withModelCall } from './model-call-scope.js';
import { readModelUsage, type ModelUsage } from './model-usage.js';
import type { NexusPlugin } from './plugin.js';
import type { PluginRegistry, SessionLookup } from './registry.js';
import { retryModelCall } from './stream-retry.js';
import type { StreamRetryOptions } from './stream-retry.js';
import { estimateAnchoredTokens, estimateMessageTokens } from './token-estimate.js';
import type { EstimatedRequest, TokenAnchorBook } from './token-estimate.js';
import {
  applyRecordedArgTruncations,
  newlyTruncatedArgs,
  restoreNewlyTruncatedArgs,
  recordedArgTruncationsOf,
} from './tool-arg-truncation-log.js';
import { withSummaryCatchUp } from './summary-catch-up.js';
import { createHistoryStaging } from './summary-history-staging.js';
import { applyRecordedPrunes, recordedPrunesOf } from './tool-result-prune-log.js';
import { turnCancelSignalOf } from './turn-cancel.js';
import { DEFAULT_TOOL_RESULT_PRUNE, withToolResultPruning } from './tool-result-pruner.js';
import type {
  PruneRequest,
  ToolResultPruneConfig,
  ToolResultPruneLog,
} from './tool-result-pruner.js';

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
 * 交給基座 `summaryPrompt` 的模板（[#432](https://github.com/DemianLi/nexus-agent/issues/432)）。
 *
 * 文字照 dsh 的 `COMPACTION_INSTRUCTION`，**只動三處**，理由見檔頭「摘要的提示詞」：
 *
 * 1. 前面接一段 `{conversation}`。基座**只換第一個** `{conversation}`，所以指令本文裡一個都不能有。
 * 2. 「PRIOR checkpoint」那條規則改認我們的包法（`<summary>` 與「Here is a summary…」兩種）。
 * 3. 分隔線讓「ABOVE」指到那一段。
 *
 * 前六條規則、八個段落與 `(none)` 的寫法都是 dsh 的原句，改了就不是 #432 要的東西。
 */
export const SUMMARY_PROMPT = [
  'Conversation to condense:',
  '{conversation}',
  '',
  '--- END OF CONVERSATION ---',
  '',
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains an earlier summary — a message that starts with "You are in the middle of a conversation that has been summarized" and holds a <summary> block, or one that starts with "Here is a summary of the conversation to date:" — it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n');

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

/**
 * 一顆模型自己的上限（[#723](https://github.com/DemianLi/nexus-agent/issues/723)）：窗口，與這顆每次請求送出去的輸出上限。
 * 來自型錄（`apps/harness/src/model-catalog.ts`）。
 */
export interface ModelContextLimits {
  readonly contextWindow: number;
  /** 每次請求保留給輸出的 token 數（型錄的 `maxTokens`）。 */
  readonly maxOutputTokens: number;
}

/** 窗口的幾成當上限：dsh 的 `thresholdRatio` 預設（`compaction-basic/src/config.ts`，`DEFAULT_THRESHOLD_RATIO`）。 */
export const WINDOW_THRESHOLD_RATIO = 0.8;

/**
 * 這顆模型能撐的 `tokens` 門檻上限：`floor(min(窗口 × 0.8, 窗口 − 輸出上限))`，至少 1。
 *
 * 照 dsh `resolveCompactSpec`（`compaction-basic/src/config.ts:153-200`，`5badb15`）的 `min(contextWindow × thresholdRatio,
 * contextWindow − 保留的輸出 − headroom)`，**少一項 headroom**（見 {@link effectiveTrigger} 的登記）。
 */
export function windowThreshold(limits: ModelContextLimits): number {
  return Math.max(
    1,
    Math.floor(
      Math.min(
        limits.contextWindow * WINDOW_THRESHOLD_RATIO,
        limits.contextWindow - limits.maxOutputTokens,
      ),
    ),
  );
}

/**
 * 這一步實際用的門檻：配置的 `tokens` 門檻，**夾在這顆模型撐得住的上限之下**（{@link windowThreshold}）；`messages` 門檻不動。
 *
 * ## 為什麼要逐步算
 *
 * 換模型之後窗口跟著換（#723）。dsh 的壓縮每次檢查都向路由後的模型問窗口（`compaction-basic/src/index.ts:305-318` 的
 * `resolveModelInfo(target.provider, target.model)`），所以門檻跟著當步的模型走；我們照做。
 *
 * ## 與 dsh 的偏離（登記）
 *
 * - **配置的絕對值留著當上限，只往下夾。** dsh 的門檻只由窗口導出（沒有絕對值）。我們的 `100_000` 是量出來的（見
 *   {@link DEFAULT_SUMMARIZATION}：最小那顆 131,007 塞得進、預設那顆 700k 偏保守），拿掉它預設模型的摘要時機會從 10 萬跳到 56 萬，
 *   是另一個行為決定。所以窗口只負責「更小的窗口不會來不及」，**預設模型與 131k 級的模型門檻不變**。
 * - **沒有型錄的模型不夾**：dsh 對解不出窗口的目標會 warn 一次然後不壓縮（`TargetPressureConfigError`，`index.ts:163-170`）；我們用
 *   配置的絕對門檻接住它，所以 `limits` 是 `undefined` 時原樣回。
 * - **沒有 headroom。** dsh 的 `headroomTokens` 預設 65,536，是為百萬級窗口定的；套在 131k 的窗口上門檻會掉到 49,087，比我們量過
 *   安全的 100,000 低一半，無謂地多摘要。輸出上限那一項（`窗口 − maxTokens`）已經守住「請求加回應不超過窗口」。
 *
 * @param trigger - 配置的門檻。
 * @param limits - 這一步用的模型的上限；不知道（沒貼型錄的模型）就原樣回。
 * @returns 沒有東西被夾時回**同一個陣列**。
 */
export function effectiveTrigger(
  trigger: readonly SummarizationThreshold[],
  limits: ModelContextLimits | undefined,
): readonly SummarizationThreshold[] {
  if (limits === undefined) return trigger;
  const ceiling = windowThreshold(limits);
  if (!trigger.some((each) => each.type === 'tokens' && each.value > ceiling)) return trigger;
  return trigger.map((each) =>
    each.type === 'tokens' && each.value > ceiling ? { type: 'tokens', value: ceiling } : each,
  );
}

/** 保留量的比例預設：dsh 的 `DEFAULT_RETAIN_RATIO`（`compaction-basic/src/config.ts:23`）。 */
export const RETAIN_RATIO = 0.16;

/**
 * 保留量的封頂：有效 `tokens` 門檻的幾成。**登記的偏離**：dsh 沒有這一項（它的門檻只由窗口導出，保留量一定小於門檻）；
 * 我們的絕對門檻 100,000 讓 dsh 的值在大窗口上超過門檻（預設那顆 109,385），所以用這一項封頂。90b（窗口 32,768）上
 * 這一項是 5,242，高於 dsh 的值 4,587，不生效——也就是只在大窗口上與 dsh 不同。
 */
export const RETAIN_THRESHOLD_CAP_RATIO = 0.2;

/** 算不出 token 保留量時（沒型錄、也沒有 `tokens` 門檻）退回的則數：基座本來的預設。 */
export const RETAIN_FALLBACK_MESSAGES = 20;

/**
 * 這一步摘要之後要逐字留下的 token 數。
 *
 * `min(wanted, cap)`：
 * - `wanted`：`retainTokens` 照給；`retainRatio` 是 `floor((窗口 − 輸出上限) × 比例)`，要型錄（dsh 的訊息預算）；
 * - `cap`：`floor(有效 tokens 門檻 × 0.2)`（{@link RETAIN_THRESHOLD_CAP_RATIO}），見該常數的偏離登記。
 *
 * @param retain - 設定上的 `retainRatio` 或 `retainTokens`（只有一個有值）。
 * @param limits - 這一步用的模型的上限；不知道就是 `undefined`。
 * @param trigger - **有效**門檻（{@link effectiveTrigger} 的結果）。
 * @returns 保留量；兩項都算不出來時 `undefined`，呼叫端退回 {@link RETAIN_FALLBACK_MESSAGES}。
 */
export function retainTokensFor(
  retain: { readonly retainRatio?: number; readonly retainTokens?: number },
  limits: ModelContextLimits | undefined,
  trigger: readonly SummarizationThreshold[],
): number | undefined {
  const budgets = trigger.filter((each) => each.type === 'tokens').map((each) => each.value);
  const cap =
    budgets.length === 0
      ? undefined
      : Math.floor(Math.min(...budgets) * RETAIN_THRESHOLD_CAP_RATIO);
  let wanted: number | undefined;
  if (retain.retainTokens !== undefined) wanted = retain.retainTokens;
  else if (retain.retainRatio !== undefined && limits !== undefined)
    wanted = Math.floor((limits.contextWindow - limits.maxOutputTokens) * retain.retainRatio);
  if (wanted === undefined) return cap;
  return cap === undefined ? wanted : Math.min(wanted, cap);
}

/**
 * 摘要之後要留的尾巴有幾則。照 dsh `selectCompactableRange`（`compaction-basic/src/region.ts:133-148`）：
 *
 * 1. 從最新往前累加，到 **≥** `retainTokens` 為止，**跨過的那則也留**——所以至少留一則，最新一則再大也不會一則不留
 *    （基座的 `tokens` 形式會，見 {@link DEFAULT_SUMMARIZATION} 的「保留量」一節）；
 * 2. 切點不能把工具呼叫和它的結果拆開：切點後面有任何一則工具結果的呼叫在切點前面，就把切點退到那則呼叫。
 *    退到底（0）就是整串都留，基座看到 `messages.length <= keep` 不摘要。
 *
 * 這一步的價是 {@link estimateMessageTokens}（不錨）。錨定只對整份請求有意義；選尾巴要的是「誰占多大」，相對比例夠用。
 *
 * @param messages - 摘要器看到的那一串（摘要事件套用過的）。
 * @param retainTokens - 保留量。
 * @returns 尾巴則數，`0` 只在 `messages` 是空的時候。
 */
export function retainedTailCount(messages: readonly BaseMessage[], retainTokens: number): number {
  const length = messages.length;
  if (length === 0) return 0;
  let accumulated = 0;
  let cut = length;
  for (let index = length - 1; index >= 0; index -= 1) {
    accumulated += estimateMessageTokens(messages[index]!);
    cut = index;
    if (accumulated >= retainTokens) break;
  }
  const calls = new Map<string, number>();
  messages.forEach((message, index) => {
    for (const call of (message as { tool_calls?: readonly { id?: unknown }[] }).tool_calls ?? [])
      if (typeof call.id === 'string') calls.set(call.id, index);
  });
  for (;;) {
    let earliest = cut;
    for (let index = cut; index < length; index += 1) {
      const message = messages[index]!;
      if (!ToolMessage.isInstance(message)) continue;
      const at = calls.get(message.tool_call_id);
      if (at !== undefined && at < earliest) earliest = at;
    }
    if (earliest === cut) break;
    cut = earliest;
  }
  return length - cut;
}

/**
 * 這一步摘要之後要留幾則：{@link retainTokensFor} 算得出 token 保留量就照 {@link retainedTailCount} 選尾巴，算不出就是
 * {@link RETAIN_FALLBACK_MESSAGES} 則。{@link withRetainedTail}（交給基座的 `keep`）與 {@link isUnderCompactionPressure}
 * （剪刀的閘門）用的是這同一個數，兩邊才會對「這一步摘不摘得到東西」有同一個答案。
 *
 * **切點前只剩上一顆摘要，也算摘不到東西**（[#2086](https://github.com/DemianLi/nexus-agent/issues/2086)）：回整串的長度。
 * 這時摘要只會拿新摘要換舊摘要，沒有新的內容卸得掉。少了這條，切點被一則自己就撐過保留量的大訊息卡住、
 * 訊息數門檻（`messages`）每一步都成立時，每一步都會多打一次摘要模型。
 *
 * @param messages - 摘要器眼中的那一串（{@link effectiveMessages}）。
 * @param settings - 補滿的設定。
 * @param limits - 這一步模型的上限；不知道就是 `undefined`。
 * @returns 尾巴則數；`>= messages.length` 就是這一步摘不到東西（尾巴蓋住全部，或切點前只剩上一顆摘要），基座不摘要。
 */
export function retainedMessageCount(
  messages: readonly BaseMessage[],
  settings: Pick<SummarizationSettings, 'trigger' | 'retainRatio' | 'retainTokens'>,
  limits: ModelContextLimits | undefined,
): number {
  const retain = retainTokensFor(settings, limits, effectiveTrigger(settings.trigger, limits));
  const retained =
    retain === undefined ? RETAIN_FALLBACK_MESSAGES : retainedTailCount(messages, retain);
  const onlyPreviousSummary =
    messages.length - retained === 1 && isSummarizationMessage(messages[0]!);
  return onlyPreviousSummary ? messages.length : retained;
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
 * **四格永遠都在（保留量算一格：`retainRatio` 與 `retainTokens` 擇一），而這正是它買到的東西。** 基座的
 * `defaultsComputed = trigger != null` 讓 `applyModelDefaults` 在收到 `trigger` 的當下
 * 就 return，於是只給 `trigger` 會**同時**做兩件沒有徵兆的事：`truncateTrigger` 留在
 * `undefined`（arg 截斷停用），`keep` 留在建構初值 **20 而不是 fallback 的 6**。
 * 一個原因、兩個效果。我們建構基座時四格都明著給，「只給一格」這種寫法就不會走到那裡。
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
  /**
   * 摘要之後最近這些逐字留下，**用比例**：占這顆模型訊息預算（窗口 − 輸出上限）的幾成。與 {@link retainTokens} 擇一。
   * 照 dsh `compaction-basic` 的 `retainRatio`；實際留多少見 {@link retainTokensFor}。
   */
  readonly retainRatio?: number;
  /** 摘要之後最近這些逐字留下，**用 token 數**。與 {@link retainRatio} 擇一。照 dsh 的 `retainTokens`。 */
  readonly retainTokens?: number;
  /** 工具參數截斷。 */
  readonly truncateArgs: SummarizationArgTruncation;
  /** 歷史落在 backend 的哪個前綴底下。 */
  readonly historyPathPrefix: string;
  /**
   * 摘要之後重新量測仍不低於 token 門檻時，換保留 0 再摘要的次數（[#2028](https://github.com/DemianLi/nexus-agent/issues/2028)）。
   * **只收 0 或 1**（理由見 {@link assertCompactionRetries}）；保留的尾巴已經最短時不重試。重試用完、不重試或尾巴已最短時，
   * 記一條 warn、照摘要完的那份送出。
   */
  readonly compactionRetries: number;
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
 * 30 輪模型呼叫，而迴圈上限的預設值（harness 的 `#settings/recursion-limit` 條目，100）照
 * `模型輪數 = floor((上限 - 1) / 每輪格數)` 換算：預設組裝每輪三格是 33 輪；CLI 的出貨清單另有四顆
 * 每次 invoke 走一次的 `beforeAgent`（基座 skills 中介層一顆、pre-step listener 三顆），每顆從分子再扣一格，
 * 是 `floor((上限 - 2 - 3) / 3)` ＝ 31 輪（2026-10-23，#1574），兩者跑到上限前都越過 60 則——所以一場跑滿的
 * 長任務會摘要一次，正常的基準任務（最長 3 次工具呼叫）碰不到它。serve 每輪四格只有 23 輪，
 * 單次 invoke 湊不到 60 則（2026-10-02 實測最多 51 則），要靠同一條 thread 後面幾輪累積才碰得到。
 *
 * **#1374 之後，則數到了不等於會摘要。** 保留量改成 token（下一節），則數到 60 時尾巴若裝得下整串（出廠是 20,000 token），
 * 基座切不出東西、原樣送出。所以這一道實際的意思是「則數 ≥ 60 **而且**訊息本身超過保留量」——訊息短的對話不會在第 60 則摘要
 * （PM 在 #1374 驗收時列為已知、刻意的變化；2026-10-14 發版模擬實測到 70 則、整份請求約 33k token，一次都沒摘、
 * serve 也沒有任何「摘要失敗」——每一步都是尾巴蓋住全部）。
 * 剪刀的閘門跟著這個意思走，見 {@link isUnderCompactionPressure}。
 *
 * ## 保留量：`retainRatio` 0.16，依這一步的模型算 token（[#1374](https://github.com/DemianLi/nexus-agent/issues/1374)）
 *
 * 這一格原本叫 `keep`，是 20 則。**則數不是尺**：小窗口模型（32,768）上每則 3,000 字，20 則自己就 30,342 token，
 * 比它的門檻還大——摘要完下一步又過門檻，每一步都重摘。dsh 的 `compaction-basic` 每個目標模型有
 * `retainTokens`／`retainRatio`（互斥，`config.ts:292`），所以現在照辦：
 *
 * - **留多少**：`retainTokensFor`——`min(floor((窗口 − 輸出上限) × retainRatio), floor(有效 token 門檻 × 0.2))`。前一項是 dsh
 *   的公式；後一項是**登記的偏離**：我們的 100,000 絕對門檻讓 dsh 的值（預設那顆 109,385）超過門檻，dsh 的載入期驗證
 *   （`retainTokens < thresholdTokens`，`config.ts:198`）會當場不過，所以封在門檻的兩成。
 * - **怎麼選尾巴**：照 dsh `selectCompactableRange`（`region.ts:133-140`）——從最新往前累加到 **≥** 保留量，跨過的那則也留；
 *   再往前退到「工具呼叫與它的結果沒被切開」的位置。基座的 `{type:'tokens'}` 是反過來的（加上去會超過就切，最新一則自己
 *   就超過時**一則不留**，`langsmith-zm0ILQsV.js:2872`），而且用的是 `countTokensApproximately`，所以不用它。
 * - **誰來切**：基座的 `keep` 在建構時就定了，不能每次請求換，而 `fraction` 要偽造 `profile.maxInputTokens`（見上面
 *   「`fraction` 一個都不准用」）。所以 {@link createSummarizer} 在每次請求算出「這一步該留幾則」N，轉給 `keep: { messages, N }`
 *   那一顆基座實例。
 *
 * 沒型錄的模型（`limitsOf` 回 `undefined`）只剩後一項；連 token 門檻都沒有（只有 `messages` 門檻）就退回
 * {@link RETAIN_FALLBACK_MESSAGES} 則。
 *
 * **端點真的回超窗時不用這個保留量**（[#1381](https://github.com/DemianLi/nexus-agent/issues/1381)）：dsh 的 overflow 路徑
 * 繞過保留政策、`selectCompactableRange(session, measurement, 0)` 只留配對需要的尾巴（`index.ts:262`、`:294`），
 * `retainTokens` 只用在 pressure 路徑。我們的兩條觸發走同一顆基座，所以由 {@link withRetainedTail} 分開：**真超窗**（錯誤鏈上
 * 第一顆 `ContextOverflowError` 不在我們合成的 WeakSet 裡）換上 retain 0 的實例、現在就摘要；**我們自己合成的預算超窗**
 * 保留量照常。
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
  retainRatio: RETAIN_RATIO,
  truncateArgs: {
    trigger: { type: 'messages', value: 20 },
    keep: { type: 'messages', value: 20 },
  },
  historyPathPrefix: '/conversation_history',
  compactionRetries: 1,
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
 *   有限數；或 `compactionRetries` 不是 0 或 1。
 */
export function resolveSummarizationSettings(
  override?: Partial<SummarizationSettings>,
): SummarizationSettings {
  if (override !== undefined && 'keep' in override) throw new Error(LEGACY_KEEP_MESSAGE);
  // 兩個保留量互斥：呼叫端給了任何一個，預設的 `retainRatio` 就不算，不然給 `retainTokens` 會與預設的比例同時在場。
  const { retainRatio: defaultRatio, ...defaults } = DEFAULT_SUMMARIZATION;
  const overridesRetain =
    override?.retainRatio !== undefined || override?.retainTokens !== undefined;
  return validateSettings({
    ...defaults,
    ...override,
    ...(!overridesRetain && { retainRatio: defaultRatio }),
  });
}

/** 舊的 `keep` 欄位被拿掉了（#1374）：靜靜忽略會讓人以為保留量還是自己設的那個，所以載入就拋，並說明改成什麼。 */
const LEGACY_KEEP_MESSAGE =
  'summarization.keep 已經拿掉（#1374）：保留量改成依這一步的模型算 token，不再是固定則數。' +
  '請改用 `retainRatio`（占訊息預算的比例，出廠 0.16）或 `retainTokens`（固定 token 數），兩者擇一。';

/** 補滿之後的設定的執行期檢查。 */
function validateSettings(settings: SummarizationSettings): SummarizationSettings {
  for (const [index, threshold] of settings.trigger.entries())
    assertThreshold(threshold, `trigger[${index}]`);
  assertRetain(settings);
  assertCompactionRetries(settings.compactionRetries);
  assertThreshold(settings.truncateArgs.trigger, 'truncateArgs.trigger');
  assertThreshold(settings.truncateArgs.keep, 'truncateArgs.keep');
  if (settings.trigger.length === 0)
    throw new Error(
      'summarization.trigger 是空陣列。基座的 `shouldSummarize` 對空陣列一律回 false，' +
        '所以那等於沒有摘要器——要那個效果請明著傳 `summarization: false`。',
    );
  return settings;
}

/**
 * `compactionRetries` 只收 0 或 1（#2028）：重試一律從原請求換保留 0（最小的保留量）重走，{@link withRetainedTail} 只升級一次、
 * 升級之後把 `canRetainLess` 設成 false。再重試一次也是切同一段；而保留 0 那一次再要求重摘沒有人接（那裡沒有 `try`，
 * {@link withTokenBudget} 也不認它），整輪會失敗。
 */
function assertCompactionRetries(value: unknown): void {
  if (value !== 0 && value !== 1)
    throw new Error(
      `summarization.compactionRetries 是 ${String(value)}，只收 0 或 1：重試固定換最小的保留量，再重試也是同一段（#2028）。`,
    );
}

/**
 * 保留量的執行期檢查：兩個擇一、數值合理。`retainRatio` 要小於窗口門檻的比例（dsh 的 `validateRatioRetention`，
 * `config.ts:235`）；`retainTokens` 是非負整數（`config.ts:291`），0 的意思是「只留跨過的那一則」。
 */
function assertRetain(settings: {
  readonly retainRatio?: number;
  readonly retainTokens?: number;
}): void {
  const { retainRatio, retainTokens } = settings;
  if (retainRatio !== undefined && retainTokens !== undefined)
    throw new Error('summarization.retainRatio 與 retainTokens 互斥，只能給一個。');
  if (retainRatio === undefined && retainTokens === undefined)
    throw new Error('summarization 要有 retainRatio 或 retainTokens 其中一個。');
  if (retainRatio !== undefined) {
    if (!Number.isFinite(retainRatio) || retainRatio <= 0 || retainRatio >= WINDOW_THRESHOLD_RATIO)
      throw new Error(
        `summarization.retainRatio 是 ${String(retainRatio)}，要在 0 與 ${WINDOW_THRESHOLD_RATIO}（窗口門檻的比例）之間。`,
      );
  }
  if (retainTokens !== undefined && (!Number.isInteger(retainTokens) || retainTokens < 0))
    throw new Error(`summarization.retainTokens 是 ${String(retainTokens)}，要非負整數。`);
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
 * @param book - 錨定估算的帳，由進入點建、注入（[#702](https://github.com/DemianLi/nexus-agent/issues/702)）：同一本帳的組裝彼此借錨。
 * @param sessions - 註冊表的 `sessions` 通道，用來問「這次壓縮該記進哪一份日誌」。
 *   **省略即不記**，而那是常態不是異常：`eval/runner.ts` 與絕大多數測試的組裝都沒有
 *   會話註冊表，它們不該為此拿到一個例外。同 {@link ./model-usage.ts} 的 `not-attached`。
 * @param pruning - 包在外面的那把剪刀的預算，來自 `resolveToolResultPruneConfig`；
 *   `false` 就不剪新的（[#446](https://github.com/DemianLi/nexus-agent/issues/446)）：有 `sessions` 時仍包一層壓力永遠不到的剪刀，
 *   只把日誌上記過的剪法換上去（[#1567](https://github.com/DemianLi/nexus-agent/issues/1567)），沒有 `sessions` 就不包。
 * @param report - 摘要失敗時往哪裡講一條 warn（[#1374](https://github.com/DemianLi/nexus-agent/issues/1374)）；省略即 `console.warn`。
 * @returns 可以直接放進 `middleware` 的 middleware。
 */
export function createSummarizer(
  backend: AnyBackendProtocol,
  settings: SummarizationSettings,
  book: TokenAnchorBook,
  sessions?: { forCall(config: unknown): SessionLookup },
  pruning: ToolResultPruneConfig | false = DEFAULT_TOOL_RESULT_PRUNE,
  limitsOf?: (model: unknown) => ModelContextLimits | undefined,
  summaryModelOf?: (request: { model?: unknown; runtime?: { configurable?: unknown } }) => unknown,
  report?: (message: string) => void,
  retry?: StreamRetryOptions,
): AgentMiddleware {
  // 歷史檔的寫入先暫存、這一步結束才依「有沒有生出摘要」提交（#1389，見 summary-history-staging.ts）。
  // 沒有會話註冊表就查不了日誌，維持直接寫。
  const staging =
    sessions === undefined
      ? undefined
      : createHistoryStaging(backend, settings.historyPathPrefix, report);
  // 壓縮事件記不進去、這次壓縮不生效時往哪裡講（#1702）。
  const warn = report ?? ((message: string) => console.warn(message));
  // 基座的 `keep` 在建構時就定了，每次請求換不了：保留則數 N 由 {@link withRetainedTail} 逐步算，各用一顆
  // `keep: { messages, N }` 的實例（同一個 backend、同一份 `stateSchema`）。
  const makeChain = (keepMessages: number, force = false): AgentMiddleware => {
    const base = createSummarizationMiddleware({
      backend: staging?.backend ?? backend,
      summaryPrompt: SUMMARY_PROMPT,
      // 只交 `messages` 那幾道，`tokens` 由 withTokenBudget 比。一道都沒有時是空陣列：基座逐條試，一條都不成立。
      // 「這一次不要摘要」那顆（{@link SUPPRESS_SUMMARY}）連 `messages` 那幾道也不給；「端點已經說裝不下」那顆
      // （`force`，見 {@link withRetainedTail}）給一道 1 則的門檻：基座一進來就判 `shouldSummarize`，現在就摘要。
      trigger: force
        ? [{ type: 'messages', value: 1 }]
        : keepMessages === SUPPRESSED_CHAIN
          ? []
          : settings.trigger
              .filter((threshold) => threshold.type === 'messages')
              .map((threshold) => ({ ...threshold })),
      keep: { type: 'messages', value: Math.max(1, keepMessages) },
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
    return withQuietSummaryCall(withAttachmentText(base), summaryModelOf, retry);
  };
  const quiet = withRetainedTail(makeChain, settings, limitsOf);
  // 兩層各管一個方向，刻意不合成一層：剪刀改請求、日誌讀回傳，合起來寫會讓兩個獨立的
  // 失敗模式共用一個 try。順序無所謂——它們碰的不是同一樣東西。預算那層讀的是基座交下去的
  // 請求，不是進來的那份，也不碰回傳值。
  const logged = sessions === undefined ? quiet : withCompactionLog(quiet, sessions);
  // 基座的 `truncateArgs` 是它自己的事，這一層只在交給它之前換上記過的、在它交下去時記新的（#1303）。
  const truncationLogged =
    sessions === undefined ? logged : withArgTruncationLog(logged, sessions, warn);
  const budgeted = withTokenBudget(
    truncationLogged,
    settings.trigger,
    book,
    sessions,
    limitsOf,
    report,
    settings.compactionRetries,
  );
  // 暫存的範圍要罩住基座的寫入與日誌那層記下事件的時點，所以在預算層外面、剪刀裡面。
  const staged =
    staging === undefined || sessions === undefined ? budgeted : staging.wrap(budgeted, sessions);
  // 最外層：state 的摘要事件在這一步請求之前先跟上日誌（#1390）。外面的預算與剪刀看到的有效訊息串要是補過的。
  const catchUp = (middleware: AgentMiddleware): AgentMiddleware =>
    sessions === undefined ? middleware : withSummaryCatchUp(middleware, sessions);
  // 剪刀關掉：不剪新的，但記過的照樣換上去（#1567 N0780）。續接灌回 state 的是原文，換上去的只有這一層。
  if (pruning === false) {
    return catchUp(
      sessions === undefined
        ? staged
        : withToolResultPruning(
            staged,
            NEVER_UNDER_PRESSURE,
            DEFAULT_TOOL_RESULT_PRUNE,
            pruneLogOf(sessions, warn),
          ),
    );
  }
  return catchUp(
    withToolResultPruning(
      staged,
      (request) =>
        isUnderCompactionPressure(
          request,
          effectiveTrigger(settings.trigger, limitsOf?.(request.model)),
          book,
          (messages) => retainedMessageCount(messages, settings, limitsOf?.(request.model)),
        ),
      pruning,
      sessions === undefined ? undefined : pruneLogOf(sessions, warn),
    ),
  );
}

/** 剪刀關掉時的壓力判斷：永遠沒到，於是只換記過的、不剪新的。 */
const NEVER_UNDER_PRESSURE = (): boolean => false;

/**
 * 摘要關掉時（`summarization: false` 或那一列 `disabled: true`）發的同名空殼：**不摘要、不縮新的參數、不剪新的結果，記過的照樣換上去**
 * （[#1567](https://github.com/DemianLi/nexus-agent/issues/1567) N0780）。
 *
 * 剪刀與參數截斷都包在摘要器上（{@link createSummarizer}），摘要那一列關掉時兩層跟著不在。續接灌回 graph state 的是原文
 * （`apps/harness/src/conversation-restore.ts`），記過的 `compaction/prune` 與 `compaction/truncate-args` 沒人換上去，模型就拿到
 * 原文，日誌上卻記著它看到的是剪過的。這一顆只做「換上去」：順序同正常那條（剪刀在外、截斷在內）。
 *
 * 摘要的切點不歸這裡：續接灌回去的本來就是「摘要＋之後的」，不帶 `_summarizationEvent`。所以這一顆沒有 `stateSchema`，
 * 也沒有 `beforeModel` 之類會變成圖節點的鉤子，只有 `wrapModelCall`。
 *
 * 查不到這次屬於哪一份日誌（沒接註冊表、認不出呼叫者）就原樣往下交；套用記過的剪法時拋錯就往外拋，同剪刀開著時那條
 * （{@link withToolResultPruning}）：靜靜送出原文，模型看到的就跟日誌記的不一樣。
 *
 * @param sessions - 註冊表的 `sessions` 通道；省略就是一顆什麼都不做的空殼（沒有日誌就沒有記過的）。
 * @returns 名字是 {@link SUMMARIZATION_MIDDLEWARE_NAME} 的 middleware。
 */
export function createRecordedProjectionShell(sessions?: {
  forCall(config: unknown): SessionLookup;
}): AgentMiddleware {
  if (sessions === undefined) return { name: SUMMARIZATION_MIDDLEWARE_NAME } as AgentMiddleware;
  return {
    name: SUMMARIZATION_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const original: readonly BaseMessage[] = request.messages ?? [];
      let messages = original;
      const found = sessions.forCall({
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      });
      if (found.kind === 'ok') {
        const events = found.log.events;
        messages = applyRecordedPrunes(messages, recordedPrunesOf(events));
        messages = applyRecordedArgTruncations(messages, recordedArgTruncationsOf(events));
      }
      return handler(
        (messages === original
          ? request
          : { ...request, messages: [...messages] }) as typeof request,
      );
    },
  } as AgentMiddleware;
}

/**
 * 剪刀的日誌接口（[#1302](https://github.com/DemianLi/nexus-agent/issues/1302)）：讀出這次請求所屬那份日誌上記過的剪法，記下新剪的。
 *
 * **只記這次請求真正送得出去的那一段**：`request.messages` 是 graph state 的原始串，摘要之前的舊訊息還在裡面，但模型看不到
 * （{@link effectiveMessages}）。剪刀對整串動手，這裡只把落在有效串裡的記下來——日誌要證明的是「模型看到的那一份」，
 * 不是 state 裡每一顆大結果的剪法。
 *
 * **先記、記進去了才剪**（[#1702](https://github.com/DemianLi/nexus-agent/issues/1702)）：`append` 拋了就回 `false`、講一條 warn，
 * 剪刀這次不套用新剪的（記過的照樣套用）。照 dsh 壓縮的 pressure 路徑：壓縮失敗記 warn、這一輪照原樣繼續
 * （`packages/compaction/compaction-basic/src/index.ts:163-173`）；dsh 的剪裁是一筆事件，寫不進去就沒有剪，不會「模型看到剪過的、
 * 日誌卻沒有」。查找本身失敗（認不出這次呼叫屬於哪一份）不是寫入失敗：`recorded` 回 `undefined`，剪刀退回每次重算，不會叫到這裡。
 *
 * @param sessions - 註冊表的 `sessions` 通道。
 * @param report - 記不進去時的 warn。
 * @returns 接口。
 */
function pruneLogOf(
  sessions: { forCall(config: unknown): SessionLookup },
  report: (message: string) => void,
): ToolResultPruneLog {
  const lookup = (request: PruneRequest): SessionLookup =>
    sessions.forCall({
      configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
    });
  return {
    recorded(request) {
      try {
        const found = lookup(request);
        return found.kind === 'ok' ? recordedPrunesOf(found.log.events) : undefined;
      } catch {
        return undefined;
      }
    },
    record(request, results) {
      let found: SessionLookup;
      try {
        found = lookup(request);
      } catch {
        // 認不出這次呼叫屬於哪一份：同 `recorded` 回 `undefined`，不是寫入失敗。
        return true;
      }
      if (found.kind !== 'ok') return true;
      const sendable = new Set<string>();
      for (const message of effectiveMessages(request.messages ?? [], request.state)) {
        if (ToolMessage.isInstance(message)) sendable.add(message.tool_call_id);
      }
      const kept = results.filter((result) => sendable.has(result.callId));
      // 剪到的都在送不出去的那一段：沒有要記的，模型也看不到它們。
      if (kept.length === 0) return true;
      try {
        found.log.append('compaction/prune', {
          results: kept.map((result) => ({
            callId: result.callId,
            originalChars: result.originalChars,
            // 純 JSON：日誌收不下 `undefined` 的欄位（同 `toLoggedMessage`）。
            content: JSON.parse(JSON.stringify(result.content)) as MessageContent,
          })),
        });
        return true;
      } catch (error) {
        report(
          `compaction/prune 記不進去，這次新剪的工具結果不套用：${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    },
  };
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
 * 摘要器看見的訊息裡，附件區塊換成文字（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * ## 病
 *
 * 基座把要摘要的訊息用 `getBufferString` 串成一段文字（`dist/langsmith-zm0ILQsV.js:3082`，歷史檔 `:3035` 也是），而它對不認得的
 * 區塊只寫 `[<type>]`——`[nexus-file]`。使用者附過哪個檔、存在哪裡全部消失，摘要寫不出「使用者給了 report.csv」，
 * 摘要之後模型也不知道去哪讀。歷史檔裡同理。
 *
 * ## 做法
 *
 * 進基座之前，把訊息裡的檔案區塊換成**組請求時同一行字**（{@link assumedFileLine}，假設讀得到），圖換成
 * {@link summaryImageText}。基座再把請求交下去時（留下的那幾則給主模型），**換回原本那幾則**：留下的訊息裡有圖，
 * 主模型還要看，那一步是 `ChatOpenAI` 子類（`apps/harness`）依模型能力投影，不是這裡。
 *
 * ## 與 dsh 的偏離（AGENTS.md 的規則）
 *
 * dsh 的摘要器把圖當圖重播給摘要模型（`packages/compaction/compaction-basic/src/summarizer.ts:105-152`，`5badb150`；
 * 檔案換成 handle 那一行，與這裡相同）。我們的摘要輸入是基座的 `getBufferString` 範本、輸入是一段字串，表達不出
 * 「一則帶圖的訊息」，所以圖退到文字佔位。檔案那一行逐字相同。
 *
 * @param base - 基座那顆摘要器。
 * @returns 同名、同狀態、摘要輸入裡附件是文字的 middleware。沒有附件時請求原樣通過。
 */
function withAttachmentText(base: AgentMiddleware): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 同 withCompactionLog。 */
  if (inner === undefined) return base;
  return {
    ...base,
    wrapModelCall: async (request, handler) => {
      const messages = request.messages ?? [];
      if (!messages.some(hasAttachmentBlocks)) return inner(request, handler);
      const projected = await rewriteAttachmentBlocks(messages, (block) => ({
        type: 'text',
        text: isFileBlock(block)
          ? assumedFileLine(block.attachment)
          : summaryImageText(block.attachment),
      }));
      // 投影後的訊息 → 原本那則；基座交下去時（留下給主模型的那幾則）換回來。
      const originals = new Map<BaseMessage, BaseMessage>();
      for (const [index, message] of projected.entries()) {
        const original = messages[index];
        if (original !== undefined && message !== original) originals.set(message, original);
      }
      return inner({ ...request, messages: [...projected] }, (sent) =>
        handler(
          sent.messages === undefined
            ? sent
            : {
                ...sent,
                messages: sent.messages.map((message) => originals.get(message) ?? message),
              },
        ),
      );
    },
  } as AgentMiddleware;
}

/**
 * 生摘要那一次呼叫報回的用量（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）：外層 {@link withCompactionLog}
 * 放一格，內層 {@link quietInvoke} 的替身在 `invoke` 回來時填。兩層是分開的 middleware，沒有共同的區域變數，
 * 所以用 `AsyncLocalStorage` 把格子帶進去（同 {@link ./model-call-scope.ts} 的 `captureModelCall`）。
 */
interface SummaryUsageCell {
  usage: ModelUsage | undefined;
  /** 生摘要的模型呼叫完成過幾次。{@link withCompactionLog} 靠它認得「交下去的這一份剛摘要過」。 */
  summaries: number;
}
const summaryUsageCells = new AsyncLocalStorage<SummaryUsageCell>();

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
 * ## 生摘要用哪一顆（[#1377](https://github.com/DemianLi/nexus-agent/issues/1377)）
 *
 * **門檻跟選中那顆（偏離 dsh，#1378 登記、PM 接受），生摘要跟最近一次已送出的請求那顆（照 dsh `summarizer.ts:127-137` 的
 * `latest ?? agentTarget`）。** 替身的 `invoke` 轉給 `summaryModelOf` 挑的那顆；其餘屬性仍讀 `request.model`（基座讀它的
 * `profile`）。`summaryModelOf` 沒給或回 `undefined`＝摘要打到 `request.model`，與沒有模型選擇的組裝一樣。
 *
 * @param base - 基座那顆摘要器。
 * @param summaryModelOf - 這次生摘要用哪一顆；省略＝`request.model`。
 * @returns 同名、同狀態、生摘要那次不上線的 middleware。
 */
function withQuietSummaryCall(
  base: AgentMiddleware,
  summaryModelOf?: (request: { model?: unknown; runtime?: { configurable?: unknown } }) => unknown,
  retry?: StreamRetryOptions,
): AgentMiddleware {
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
      // 生摘要的模型（#1377）：門檻跟 `request.model`（選中那顆），摘要跟最近一次已送出的請求那顆；沒有意見就是 `request.model`。
      const target = summaryModelOf?.(request);
      // 生摘要的呼叫完成過幾次、已經檢查過幾次：基座生完摘要緊接著交下去的第一份請求就是要檢查的那一份（#1396）。
      let generated = 0;
      let checked = 0;
      const afterSummary = (request as { [AFTER_SUMMARY]?: AfterSummary })[AFTER_SUMMARY];
      const quiet = quietInvoke(
        model,
        summaryUsageCells.getStore(),
        typeof target === 'object' && target !== null ? target : undefined,
        () => {
          generated += 1;
        },
        // 生摘要的那一次呼叫在重試那一格外面，SDK 層又不重試了（#1427）：自己吃同一份政策。沒有日誌（同 #1341：摘要器的呼叫不是
        // 模型呼叫圖裡的一步），按了停止在退避中收。
        retry === undefined || retry.maxRetries <= 0
          ? undefined
          : {
              policy: retry,
              signal: turnCancelSignalOf({
                configurable: (request as { runtime?: { configurable?: unknown } }).runtime
                  ?.configurable,
              }),
            },
      );
      return inner({ ...request, model: quiet }, (sent) => {
        const restored = sent.model === quiet ? { ...sent, model } : sent;
        if (generated > checked) {
          checked = generated;
          assertSummaryShrinks(request, sent);
          afterSummary?.(restored);
        }
        return handler(restored);
      });
    },
  } as AgentMiddleware;
}

/**
 * 摘要生出來了，但加上框架之後不比它取代的那一段小（[#1396](https://github.com/DemianLi/nexus-agent/issues/1396)）。
 *
 * 型別化是為了讓測試與日後的讀者認得它，**也記進 {@link summaryCallFailures}**：外面的 {@link withTokenBudget} 靠那個認
 * 「摘要這一格壞了」，走 #1383 既有的兩條路——自己的門檻觸發就 warn、照原請求送；端點真的超窗就 warn、保留原錯誤。
 * 日誌不記 `compaction/summary`（拋在往外交之前），#1395 的歷史檔暫存因此丟掉這一步的寫入。
 */
export class SummaryNotSmallerError extends Error {
  constructor(
    /** 加上框架的摘要訊息的估計 token。 */
    readonly framedTokens: number,
    /** 被它取代的那一段的估計 token 總和。 */
    readonly replacedTokens: number,
  ) {
    super(
      `摘要不比被取代的內容小（框好的摘要 ${framedTokens} token ≥ 被取代的 ${replacedTokens} token）`,
    );
    this.name = 'SummaryNotSmallerError';
  }
}

/**
 * dsh 的 shrink 檢查（`compaction-basic/src/region.ts:417-420`）：摘要生出來、提交之前，框好的摘要訊息要**比它取代的那段小**，
 * 不然整次壓縮不提交。擋的是壓了反而變大或沒變小的壓縮。照保留量切時，切點前只剩舊摘要那一類在 {@link retainedMessageCount}
 * 就判成摘不到、不會到這裡；端點超窗、保留量降到 0 時仍可能走到。
 *
 * - **框好的摘要**：基座生完摘要緊接著交下去的那份請求的第一則（`buildSummaryMessage` 加過框架與歷史檔路徑）。
 * - **被取代的那段**：這一步開始時摘要器眼中的有效串（{@link effectiveMessages}），去掉交下去那份留下的尾巴。
 * - **兩邊同一把量具**：{@link estimateMessageTokens}。**偏離 dsh**：它用 route price（`meter.estimateMessage` 對 `shadowedRouteTokenCount`），
 *   我們沒有逐路由的計價，退到這把與保留量選尾巴同一把的估算（#1383 的 D3 同一個理由）。被取代那段取的是參數截斷之前的有效串，
 *   所以只會略高估被取代的量（檢查寬鬆一點，不會多擋）。
 *
 * 估不出來（形狀不對、估算拋）就不擋：檢查不能反過來把摘要殺掉。
 *
 * @throws {SummaryNotSmallerError} 框好的摘要 ≥ 被取代的那段。
 */
function assertSummaryShrinks(
  request: { messages?: readonly BaseMessage[]; state?: unknown },
  sent: { messages?: readonly BaseMessage[] },
): void {
  const head = sent.messages?.[0];
  if (head === undefined) return;
  let framed: number;
  let replaced: number;
  try {
    const before = effectiveMessages(request.messages ?? [], request.state);
    const kept = Math.max(0, (sent.messages?.length ?? 1) - 1);
    const span = before.slice(0, Math.max(0, before.length - kept));
    if (span.length === 0) return;
    framed = estimateMessageTokens(head);
    replaced = span.reduce((total, message) => total + estimateMessageTokens(message), 0);
  } catch {
    return;
  }
  if (framed < replaced) return;
  const error = new SummaryNotSmallerError(framed, replaced);
  summaryCallFailures.add(error);
  throw error;
}

/** {@link SummaryRejectedError} 的原因。前兩個與 dsh 同名；`EMPTY_SUMMARY` 在 dsh 只有訊息沒有碼，這裡給名字讓測試與 warn 認得。 */
export type SummaryRejectedCode = 'MAX_TOKENS' | 'UNSUPPORTED_CONTENT' | 'EMPTY_SUMMARY';

const SUMMARY_REJECTED_MESSAGES: Readonly<Record<SummaryRejectedCode, string>> = {
  MAX_TOKENS: '摘要被輸出上限截斷，不接受不完整的摘要',
  UNSUPPORTED_CONTENT: '摘要含圖片，不接受',
  EMPTY_SUMMARY: '摘要沒有文字內容，不接受',
};

/**
 * 摘要生出來了，但不能當摘要用：被截斷、含圖、或沒有文字（[#1539](https://github.com/DemianLi/nexus-agent/issues/1539)）。
 *
 * 同 {@link SummaryNotSmallerError}，**記進 {@link summaryCallFailures}**，走 {@link withTokenBudget} 既有的兩條退路。
 * 訊息只講原因、不引摘要內容。
 */
export class SummaryRejectedError extends Error {
  constructor(readonly code: SummaryRejectedCode) {
    super(SUMMARY_REJECTED_MESSAGES[code]);
    this.name = 'SummaryRejectedError';
  }
}

/** LangChain 輸出區塊裡的圖片：`image`（v1 標準區塊）與 `image_url`（OpenAI 形狀）是同一種東西。 */
const IMAGE_BLOCK_TYPES: ReadonlySet<string> = new Set(['image', 'image_url']);

/**
 * dsh `summarizeWithLlm` 對摘要輸出的 fail-closed（`compaction-basic/src/summarizer.ts:164-171`、`:196-221`），順序也照它：
 * 結束原因、圖片、有沒有文字。
 *
 * **鴨子型別**：測試替身回的是 `{ text }`，沒有 `response_metadata` 也沒有 `content`。沒有 `response_metadata` 就不判截斷；
 * 沒有 `content` 就退回讀 `.text`。
 *
 * @param result - 摘要模型回的那則訊息。
 * @returns 拒收的原因；能用就是 `undefined`。
 */
function summaryRejection(result: unknown): SummaryRejectedCode | undefined {
  const message = (typeof result === 'object' && result !== null ? result : {}) as {
    response_metadata?: unknown;
    content?: unknown;
    text?: unknown;
  };
  if (isMaxTokensFinish(message.response_metadata)) return 'MAX_TOKENS';
  const { content } = message;
  const blocks: readonly unknown[] = Array.isArray(content) ? content : [];
  if (blocks.some((block) => IMAGE_BLOCK_TYPES.has(blockType(block)))) return 'UNSUPPORTED_CONTENT';
  // 只取文字區塊（同 dsh 的 `summaryText`）：只有推理的輸出在這裡是空的。
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? blocks.flatMap((block) =>
            blockType(block) === 'text' && typeof (block as { text?: unknown }).text === 'string'
              ? [(block as { text: string }).text]
              : [],
          )
        : typeof message.text === 'string'
          ? [message.text]
          : [];
  if (!texts.some((text) => text.trim().length > 0)) return 'EMPTY_SUMMARY';
  return undefined;
}

function blockType(block: unknown): string {
  const type = (block as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? type : '';
}

/**
 * 「這一次請求不要摘要」的記號，掛在請求物件上（`{...request}` 會帶著走，與 `ROUTED_FROM` 同一個做法）。
 *
 * 摘要壞了、退回「照原請求送出」時（{@link withTokenBudget}）要送的是**沒動手摘要時本來會往下交的那份**：
 * 摘要事件套用過的有效串、基座的 `truncateArgs` 也照做、記過的參數截斷與日誌的記帳也照走。這些全在基座與它外面那幾層裡，
 * 所以不是在外面把 `request` 原樣丟給 `handler`，而是帶著這個記號再走一遍同一條鏈，由 {@link withRetainedTail} 換上一顆
 * **沒有訊息數門檻**的基座實例——它判 `shouldSummarize` 為 false，走的就是平常不摘要的那條路。
 */
const SUPPRESS_SUMMARY = Symbol.for('nexus.summarization.suppress');

/**
 * {@link withRetainedTail} 這一步的保留決定，交還給外面的 {@link withTokenBudget} 記 `messagesCompactable` 用
 * （[#1443](https://github.com/DemianLi/nexus-agent/issues/1443)）。同 {@link SUPPRESS_SUMMARY} 掛在請求物件上，由外層放一個空格子、
 * 內層填。**外層不自己重算**：中間隔著 {@link withArgTruncationLog}，它把日誌上記過的參數截斷換上去之後才交下來，外層手上的那串
 * 跟選尾巴用的不是同一份。
 */
const RETAIN_DECISION = Symbol.for('nexus.summarization.retain-decision');

/** {@link RETAIN_DECISION} 的格子：選尾巴的那一串有幾則、照保留政策要留幾則，以及 #2028 的重量判斷能不能重摘。 */
interface RetainDecision {
  retained?: number;
  length?: number;
  /** 這一步還能不能換更少的保留量重摘：`zero < normal` 時為 true；已升級到保留 0 之後設回 false（#2028）。 */
  canRetainLess?: boolean;
}

/**
 * 摘要完、基座交下來的那一份要過的重量（[#2028](https://github.com/DemianLi/nexus-agent/issues/2028)）：外面的 {@link withTokenBudget} 放一支函式，
 * 最內層的 {@link withQuietSummaryCall} 在檢查摘要有沒有變小的同一點叫它。**要在那裡叫**：那一點在 {@link withCompactionLog} 記事件之前，
 * 拋出來的話這份摘要不進日誌、不進 state；接它的是 {@link withRetainedTail}（換保留 0 重摘），同一個暫存範圍裡後寫的歷史
 * 蓋掉這一份（#1389）。
 */
const AFTER_SUMMARY = Symbol.for('nexus.summarization.after-summary');

/** {@link AFTER_SUMMARY} 掛的函式：收摘要完要交下去的那份請求；要重摘就拋 {@link RetainLessSignal}。 */
type AfterSummary = (sent: Parameters<typeof estimateAnchoredTokens>[0]) => void;

/**
 * 摘要完重量仍超過門檻、而且少留一點還有用（#2028）：從 {@link AFTER_SUMMARY} 那一點拋出，**故意不是** `ContextOverflowError`
 * 也不帶 `cause`，基座認不出它、不會拿同一個保留量重摘，錯誤冒回 {@link withRetainedTail}，由它換 retain 0 的實例重走一遍——
 * 跟端點真的超窗（{@link EndpointOverflowSignal}）同一條升級。
 */
class RetainLessSignal extends Error {
  constructor() {
    super('still above the summarization threshold after compaction');
    this.name = 'RetainLessSignal';
  }
}

/** 沒有訊息數門檻的那顆實例在快取裡的鍵（保留則數不會是負的）。 */
const SUPPRESSED_CHAIN = -1;

/** 保留則數實例的快取上限。N 是整數、理論上沒有上限，但實際只在「最近一次摘要之後的對話長度」附近移動；超過就丟最久沒用的。 */
const MAX_RETAIN_CHAINS = 32;

/**
 * 每次請求算出「這一步該留幾則」，轉給對應那顆基座實例（[#1374](https://github.com/DemianLi/nexus-agent/issues/1374)）。
 *
 * 見 {@link DEFAULT_SUMMARIZATION} 的「保留量」一節。回傳的是**一顆** middleware：`name` 與 `stateSchema` 取自參考實例，
 * 所有實例共用同一個 backend、同一份 `stateSchema`，疊上只有它一顆。
 *
 * ## 實例之間沒有狀態要同步
 *
 * 基座實例的 closure 裡有三樣：`tokenEstimationMultiplier`（只在 `profile.maxInputTokens` 有值時才會改，我們的模型沒有，
 * 見 {@link createSummarizer} 的絆索說明）、`cachedModel`（只在 `request.model` 缺席時用）、`sessionId`（歷史檔名的退路）。
 * 前兩樣不會動；第三樣這裡統一：state 上沒有 `_summarizationSessionId` 時補一個**這顆摘要器自己的**，所以不論用到哪顆實例，
 * 歷史都寫進同一個檔（`session_…` 名字與基座一致）。這一份與基座原本的「一顆摘要器一個 closure」同一個範圍：
 * 摘要器逐個 agent 各建一份（見 `foldSummarizer`），root 與子代理照舊不共用。
 *
 * @param makeChain - 建「`keep` 是 N 則」的那一顆（含它外面貼著的兩層）。
 * @param settings - 補滿的設定。
 * @param limitsOf - 這一步模型的上限；沒給（沒有型錄）就只剩門檻那一項。
 * @returns 與 `makeChain` 回傳的同名、同狀態的 middleware。
 */
function withRetainedTail(
  makeChain: (keepMessages: number, force?: boolean) => AgentMiddleware,
  settings: SummarizationSettings,
  limitsOf?: (model: unknown) => ModelContextLimits | undefined,
): AgentMiddleware {
  // 鍵是「N」與「是不是強制摘要那顆」：同一個 N 兩種都可能用到，各自一顆。
  const chains = new Map<string, AgentMiddleware>();
  const chainFor = (keepMessages: number, force = false): AgentMiddleware => {
    const key = `${force ? 'force' : 'keep'}:${keepMessages}`;
    const cached = chains.get(key);
    if (cached !== undefined) {
      // 最近用過的排到最後。
      chains.delete(key);
      chains.set(key, cached);
      return cached;
    }
    const made = makeChain(keepMessages, force);
    chains.set(key, made);
    if (chains.size > MAX_RETAIN_CHAINS) chains.delete(chains.keys().next().value!);
    return made;
  };
  const reference = makeChain(RETAIN_FALLBACK_MESSAGES);
  const fallbackSessionId = `session_${randomUUID().substring(0, 8)}`;
  return {
    ...reference,
    wrapModelCall: (request, handler) => {
      const suppressed = (request as { [SUPPRESS_SUMMARY]?: boolean })[SUPPRESS_SUMMARY] === true;
      const view = effectiveMessages(request.messages ?? [], request.state);
      const retained = retainedMessageCount(view, settings, limitsOf?.(request.model));
      // 交出去的是保留政策下的決定：不要摘要的那一次也照算（問的是「門檻到了會不會摘」），端點超窗的升級不算。
      const decision = (request as { [RETAIN_DECISION]?: RetainDecision })[RETAIN_DECISION];
      if (decision !== undefined) {
        decision.retained = retained;
        decision.length = view.length;
      }
      const keepMessages = suppressed ? SUPPRESSED_CHAIN : retained;
      const state = request.state as Record<string, unknown> | undefined;
      const seeded = (
        state !== undefined && typeof state._summarizationSessionId !== 'string'
          ? { ...request, state: { ...state, _summarizationSessionId: fallbackSessionId } }
          : request
      ) as typeof request;
      const normal = keepMessages === SUPPRESSED_CHAIN ? keepMessages : Math.max(1, keepMessages);
      // 端點真的回超窗：照 dsh 的 overflow 路徑（`compaction-basic/src/index.ts:262`、`:294`）繞過保留政策，retain 取 0，
      // 只留工具呼叫與結果配對需要的尾巴（#1381）。**我們合成的預算超窗不算**：那不是端點說的，保留量照常。
      // 已經是最小尾巴（`zero >= normal`）時不用換，基座自己的緊急摘要就是這個保留量。
      const zero = suppressed ? undefined : Math.max(1, retainedTailCount(view, 0));
      const escalate = zero !== undefined && zero < normal;
      if (decision !== undefined) decision.canRetainLess = escalate;
      const watched: typeof handler = escalate
        ? async (sent) => {
            try {
              return await handler(sent);
            } catch (error) {
              if (isRealOverflow(error)) throw new EndpointOverflowSignal(error);
              throw error;
            }
          }
        : handler;
      if (!escalate) return chainFor(normal).wrapModelCall!(seeded, handler);
      return (async () => {
        try {
          return await chainFor(normal).wrapModelCall!(seeded, watched);
        } catch (error) {
          if (!(error instanceof EndpointOverflowSignal) && !(error instanceof RetainLessSignal))
            throw error;
          // 現在就摘要、尾巴只留配對需要的那幾則；這一次的錯誤（含第二次又超窗）照原樣往外走，不再升級。
          // 摘要完重量仍超過門檻（{@link RetainLessSignal}，#2028）也走這裡：第一次的摘要沒有交出去，歷史檔由 #1389 的暫存只留這一次的。
          // 這一次已經是最小的保留量，`canRetainLess` 設成 false：這裡沒有 `try`，再拋 RetainLessSignal 會冒過 withTokenBudget，整輪失敗。
          if (decision !== undefined) decision.canRetainLess = false;
          return chainFor(zero, true).wrapModelCall!(seeded, handler);
        }
      })();
    },
  } as AgentMiddleware;
}

/**
 * 生摘要那次模型呼叫拋出來的錯（物件本身），以及摘要記不進去時 {@link summaryLogFailure} 造的那一顆。見 {@link quietInvoke}、
 * {@link withTokenBudget}。
 */
const summaryCallFailures = new WeakSet<object>();

/**
 * `compaction/summary` 記不進去：包成一顆「生摘要失敗」的錯（[#1702](https://github.com/DemianLi/nexus-agent/issues/1702)），
 * 由 {@link withTokenBudget} 走 dsh 的 pressure／overflow 兩條路。見 {@link withCompactionLog}。
 *
 * @param error - `append` 拋的錯，放進 `cause`。
 * @returns 登記過的錯。
 */
function summaryLogFailure(error: unknown): Error {
  const failure = new Error(
    `compaction/summary 記不進去，這次摘要不生效：${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
  summaryCallFailures.add(failure);
  return failure;
}

/** 我們自己（{@link withTokenBudget}）合成的預算超窗：不是端點說的，不走 dsh 的 overflow 路徑。 */
const syntheticOverflows = new WeakSet<object>();

/**
 * 合成一顆預算超窗並記下它是我們自己的。基座只認型別（`ContextOverflowError`），所以它得是真的那個類別；
 * 「是不是我們合成的」靠這個 WeakSet 的物件身分，不靠訊息字串。
 *
 * @internal 匯出只給測試用，不在 `index.ts` 的公開面上。
 */
export function syntheticOverflow(message: string): ContextOverflowError {
  const error = new ContextOverflowError(message);
  syntheticOverflows.add(error);
  return error;
}

/**
 * 端點真的回了超窗，從 {@link withRetainedTail} 的觀察點拋出來、**故意不是** `ContextOverflowError` 也不帶 `cause`：
 * 基座認不出它，不會拿 N 則的保留量去做緊急摘要，錯誤整個冒回分派器，由分派器換上 retain 0 的實例重走一遍。
 */
class EndpointOverflowSignal extends Error {
  constructor(readonly original: unknown) {
    super('endpoint reported a context overflow');
    this.name = 'EndpointOverflowSignal';
  }
}

/**
 * 這個錯的鏈上第一顆 `ContextOverflowError` 是不是端點真的回的（不是 {@link syntheticOverflows} 裡我們自己合成的）。
 * 不設深度上限、以走過的物件防環，原因同 {@link isContextOverflowError}。
 *
 * **判的是「鏈上找到的那一顆」的身分，不是最外層那個。** 合成的超窗被包了很多層之後仍然是合成的。
 *
 * @internal 匯出只給測試用，不在 `index.ts` 的公開面上。
 */
export function isRealOverflow(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cause: unknown = error;
  while (typeof cause === 'object' && cause !== null && !seen.has(cause)) {
    if (ContextOverflowError.isInstance(cause)) return !syntheticOverflows.has(cause);
    seen.add(cause);
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * 這個錯（或它的 `cause` 鏈上任何一層）是不是超窗：基座自己的判法（`isContextOverflow`，不設深度上限）。
 *
 * **不能設深度上限。** 模型拋出來的錯每經過一顆 middleware 就被 `MiddlewareError.wrap` 包一層，疊裡有十幾顆，
 * 原錯誤埋在十幾層 `cause` 底下；上限設 8 時這裡認不出它，而基座認得——兩邊對同一個錯的判斷分歧，
 * 端點超窗就被當成「我們自己的門檻觸發」。以走過的物件防環取代深度上限。
 */
function isContextOverflowError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let cause: unknown = error;
  while (typeof cause === 'object' && cause !== null && !seen.has(cause)) {
    if (ContextOverflowError.isInstance(cause)) return true;
    seen.add(cause);
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
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
function quietInvoke<T extends object>(
  model: T,
  cell: SummaryUsageCell | undefined,
  generator?: object,
  onGenerated?: () => void,
  retry?: { readonly policy: StreamRetryOptions; readonly signal: AbortSignal | undefined },
): T {
  return new Proxy(model, {
    get(target, key) {
      if (key !== 'invoke') return Reflect.get(target, key) as unknown;
      // 生摘要的那顆可以不是本尊（#1377）：`invoke` 轉給 `generator`，其餘屬性（基座讀的 `profile`）照讀本尊。
      const caller = generator ?? target;
      const invoke = (caller as { invoke(input: unknown, config?: unknown): unknown }).invoke;
      return async (input: unknown, config?: { tags?: readonly string[] }) => {
        let result: unknown;
        const attempt = (): Promise<unknown> =>
          Promise.resolve(
            invoke.call(caller, input, {
              ...config,
              tags: [...(config?.tags ?? []), SUMMARY_CALL_TAG],
            }),
          );
        try {
          result =
            retry === undefined
              ? await attempt()
              : await retryModelCall(
                  retry.policy,
                  retry.signal === undefined ? {} : { signal: retry.signal },
                  attempt,
                );
        } catch (error) {
          // 記下「這個錯是生摘要那次拋的」（#1374）：基座不包它，原物件一路冒到外面，外面的 {@link withTokenBudget}
          // 靠這個分得出它與「摘要成功、之後的模型呼叫才失敗」。
          if (typeof error === 'object' && error !== null) summaryCallFailures.add(error);
          throw error;
        }
        // 摘要輸出 fail-closed（#1539）：在重試外面檢查，拒收的不重打（同 dsh，摘要那次呼叫不經步級重試）；
        // 也在記用量之前，被拒收的那次不記（dsh 只在成功時回 usage）。
        const rejected = summaryRejection(result);
        if (rejected !== undefined) {
          const error = new SummaryRejectedError(rejected);
          summaryCallFailures.add(error);
          throw error;
        }
        // 摘要的用量（#1022）：回來的那則訊息上讀，驗不過就是沒有。拋錯的那次連 `compaction/summary` 都不記，
        // 用量也就跟著沒有（見 withCompactionLog 的說明）。
        if (cell !== undefined) {
          cell.usage = readModelUsage(result);
          cell.summaries += 1;
        }
        onGenerated?.();
        return result;
      };
    },
  });
}

/**
 * 把「壓縮發生過」記進這次呼叫所屬的那一份會話日誌——**記在用到它的那次 `model/start` 之前**
 * （[#1301](https://github.com/DemianLi/nexus-agent/issues/1301)）。
 *
 * ## 為什麼是在「交下去」的那一刻記
 *
 * 基座生完摘要、**呼叫 `handler` 之前**，摘要、切點、歷史檔路徑都已經定了；但它交出摘要事件的方式只有一個：
 * 整個 `performSummarization` 走完（含 `await handler(...)`，也就是那次模型呼叫）之後
 * `return new Command({ update: { _summarizationEvent: {...} } })`（`dist/langsmith-zm0ILQsV.js:3181`）。
 * 讀回傳值就只能記在那次呼叫的回覆之後，而日誌要能「只取 `model/start` 之前的事件就推出那次請求的歷史」
 * （S2 的前置，地圖 [#1298](https://github.com/DemianLi/nexus-agent/issues/1298)），摘要必須在前面。
 * 所以這裡包的是**傳給基座的 `handler`**：基座把摘要過的請求交下去的那一刻，事件的欄位自己算出來：
 *
 * - **認得「剛摘要過」**：{@link quietInvoke} 的替身每完成一次生摘要的 `invoke` 就把格子的 `summaries` 加一；
 *   `handler` 被叫到時 `summaries` 比記過的多，這一份就是剛摘要過的，`sent.messages[0]` 是摘要。基座把請求交下去有
 *   好幾處（沒摘要、切不出東西、壓縮工具結果、摘要、溢出後重摘），只有摘要那兩處前面有一次生摘要的呼叫。
 * - **`cutoffIndex`**：基座的 `stateCutoffIndex = 上一次的切點 + 這次在有效串裡的切點 - 1`（沒有上一次就是切點本身，
 *   `summarizeMessages`）；有效串是 {@link effectiveMessages}，這次在有效串裡的切點＝有效串長度 −（交下去的長度 − 1）。
 * - **`filePath`**：從摘要文字讀（{@link summaryFilePathOf}）。基座寫歷史檔失敗時摘要文字沒有那句，就是 `null`（#66）。
 * - **`messagesBefore`**：`request.messages.length`，同以前；只是那時的 graph state 還沒有這次呼叫的回覆，所以推導端的
 *   則數檢查是 `messagesBefore`，不是舊順序的 `messagesBefore + 1`（`conversation-replay.ts`），事件帶 `beforeCall: true` 標明。
 *
 * **這幾個欄位是反推的，會跟基座的 `Command` 對不上就是基座改了內部**：`summarization.test.ts` 的差分測試拿真的基座，
 * 每條路徑（第一次、第二次、歷史檔失敗、預算觸發、真的溢出後重摘）逐欄比日誌與 `_summarizationEvent`。
 *
 * ## 摘要記了，那次呼叫卻失敗
 *
 * 以前拋錯的那次連 `compaction/summary` 都不記；現在它在呼叫之前，呼叫失敗了事件也已經在日誌上。這是 dsh 的行為：
 * 壓縮在 `agent/pre-step`（組請求之前）落地，事件是耐久的，之後的請求失敗不會收回它
 * （`packages/compaction/compaction-basic/src/index.ts`，`d7432673886`）。我們的 graph state 在那種情形沒有
 * `_summarizationEvent`（`Command` 沒回來），下一次呼叫基座會從沒摘要過的狀態重摘，日誌上就有兩顆摘要、中間沒有新訊息；
 * 推導以後面那顆為準（切點都是原始串的座標），結果相同。
 *
 * ## 範圍怎麼表示：與 dsh 的偏離
 *
 * dsh 在摘要事件後面緊接一顆 `user/message {surfaceOp: replace}`，用 `shadowedRange`／`shadowedSeqs` 蓋住被壓的範圍。
 * **我們沒有 surface 這一軸**（`conversation-replay.ts` 檔頭），表達不出「蓋住一段 seq」。退到最接近的：仍是一顆
 * `compaction/summary`，範圍用原始訊息串的切點 `cutoffIndex` 表達，推導端據此切。
 *
 * ## 為什麼是包住它，而不是一顆新 middleware
 *
 * 一顆新名字的 middleware 排在 `SummarizationMiddleware` 後面（更內層，見 {@link SUMMARIZATION_MIDDLEWARE_NAME}），
 * 看不到基座交下去之前的那一刻。（例外是換模型、子代理跟隨與圖片省略：`mergeMiddlewareStack` 在合併時把它們搬到預設疊
 * 前面，所以它們在摘要器**外面**——#1369。）
 *
 * ## subagent 那側**寫得進去**，而這是 #143 卡上決定 3 的反面
 *
 * 卡上原本判斷 subagent 的壓縮紀錄結構上取不到，依據是 `EXCLUDED_STATE_KEYS`（`:3263`）
 * 把 `_summarizationEvent` 擋在「傳進／傳出 subagent」兩個方向之外。**那條擋的是 root 的
 * 快照讀得到什麼，不是這裡。** 我們不經過 root 的 state：`foldSummarizer` 逐個 agent 建
 * 一份摘要器，subagent 那份的 `wrapModelCall` 就在 subagent 自己的圖裡跑，再用 `checkpoint_ns` 問這次呼叫
 * 屬於哪一份日誌——跟 `model/usage` 同一把鑰匙。
 *
 * ## 記不進去，這次摘要不生效（[#1702](https://github.com/DemianLi/nexus-agent/issues/1702)）
 *
 * dsh 的不變量是日誌與送給模型的內容一致：壓縮是一筆事件，寫不進去就等於這次壓縮沒發生；自動壓縮的失敗在 pressure 路徑記 warn、
 * 這一輪照原樣繼續（`packages/compaction/compaction-basic/src/index.ts:163-173`），在 overflow 路徑記 warn、保留原本的請求錯誤
 * （`:204-227`）。我們的摘要事件在基座交下去的那一刻記，而摘要要生效還有三處：送出去的請求（`sent` 開頭那則摘要）、
 * 基座最後回的 `Command`（`_summarizationEvent` 進 graph state）、歷史檔（#1389 的暫存層依日誌與 `Command` 決定提交）。
 *
 * 所以 `append` 拋了就**不叫 `handler`**，改拋一顆登記成「生摘要失敗」的錯（{@link summaryLogFailure}）：
 *
 * - 基座不認它是超窗，原樣往外拋，不會回 `Command`——state 沒有 `_summarizationEvent`；暫存層看不到事件也看不到 `Command`，
 *   歷史檔丟掉；#1390 的補回（{@link withSummaryCatchUp}）在日誌上找不到它，不會補。
 * - {@link withTokenBudget} 把它當成生摘要失敗走 dsh 的兩條路：我們自己的門檻觸發的，記 warn、照原請求（不摘要）送出；
 *   端點回超窗之後的恢復，記 warn、拋原本的超窗錯。照原請求送出的那一次若又碰到端點超窗、基座再摘要又記不進去，
 *   也是拋原本的超窗錯，不再重摘（重摘的次數由基座與 {@link withRetainedTail} 各自最多一次界住）。
 *
 * **偏離 dsh，理由 1（基座表達不出來）。** dsh 的壓縮是一筆交易，寫不進去就沒有提交；基座的 `Command` 要等 `handler` 回來才組，
 * 寫日誌沒辦法跟 state 的提交合成一步，所以退到「交下去之前寫、寫不進去不交、錯走生摘要失敗那條路」。
 * **回頭點**：底座換成 Cordis、送給模型的內容改由日誌推出之後（#1385），壓縮改成一筆交易，拿掉 {@link summaryLogFailure} 這條繞路。
 *
 * `forCall` 的三種非 `ok` 不是寫入失敗（這次呼叫不屬於任何一份日誌），照舊不記、`handler` 照常被叫。
 *
 * @param base - 基座那顆摘要器。
 * @param sessions - 註冊表的 `sessions` 通道。
 * @returns 同名、同狀態、交下去之前多一層紀錄的 middleware。
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
    wrapModelCall: (request, handler) => {
      const cell: SummaryUsageCell = { usage: undefined, summaries: 0 };
      let logged = 0;
      const effective = effectiveMessages(request.messages ?? [], request.state);
      const previousCutoff = previousCutoffOf(request.state);
      return summaryUsageCells.run(cell, () =>
        inner(request, (sent) => {
          // 生摘要的呼叫完成過、而且這一份還沒記過：這一份就是剛摘要過的。
          if (cell.summaries > logged) {
            logged = cell.summaries;
            const summary = sent.messages?.[0];
            if (summary !== undefined && isSummarizationMessage(summary)) {
              // `runtime.configurable` 就是 `forCall` 要的那份——包回一層 `configurable` 是因為
              // 它收的是 handler 的 config 形狀，不是 configurable 本身。同 model-usage.ts。
              const found = sessions.forCall({
                configurable: (request as { runtime?: { configurable?: unknown } }).runtime
                  ?.configurable,
              });
              if (found.kind === 'ok') {
                const local = effective.length - ((sent.messages ?? []).length - 1);
                try {
                  found.log.append('compaction/summary', {
                    cutoffIndex: previousCutoff === undefined ? local : previousCutoff + local - 1,
                    messagesBefore: (request.messages ?? []).length,
                    filePath: summaryFilePathOf(summary),
                    summary: toLoggedMessage(summary),
                    // 生這份摘要的那一次報的用量（#1022）：沒報、報得對不上就不放 key。**不進 `model/usage`**。
                    ...(cell.usage === undefined ? {} : { usage: cell.usage }),
                    beforeCall: true,
                  });
                } catch (error) {
                  // 不叫 `handler`：這次摘要不生效。見上面「記不進去，這次摘要不生效」。
                  throw summaryLogFailure(error);
                }
              }
            }
          }
          return handler(sent);
        }),
      );
    },
  } as AgentMiddleware;
}

/**
 * 舊工具呼叫參數的縮短寫進日誌（[#1303](https://github.com/DemianLi/nexus-agent/issues/1303)）。
 *
 * 基座每次請求前對有效串重算 `truncateArgs`，把 `keep` 之前的助手訊息裡 `write_file`／`edit_file` 的長字串參數縮成「開頭 20 字＋標記」，
 * 只改請求、不寫日誌。這一層做兩件事，**都不重寫基座的規則**：
 *
 * 1. **交給基座之前**，把日誌上記過的縮短換上去（{@link applyRecordedArgTruncations}）。記過的就一直是縮短的——基座每次從原文重算，
 *    正常情形下算出來一樣，但摘要把有效串縮短之後切點會重置，不換的話「這個參數這次是縮短還是原文」就要看基座的狀態，而不是日誌。
 *    這是 #1302 剪刀同款的黏性（那邊是自己的剪刀、這邊是別人的）。**行為差有兩處**：(a) 摘要把有效串縮短、切點重置的少見情形下，縮短過的不會再回到原文；
 *    (b) 基座看到的有效串已經是短的，`countTotalTokens` 變小，所以 `truncateArgs.trigger` 設成 `tokens` 型時，新的長參數會比以前**晚一點**才被截
 *    （預設是 `messages` 型，不受影響）。
 * 2. **基座把請求交下去的那一刻**，拿交下去的串跟交進去的串比（{@link newlyTruncatedArgs}），新縮短的記一筆 `compaction/truncate-args`。
 *    包的是傳給基座的 `handler`，理由與 {@link withCompactionLog} 同：記在那次模型呼叫之前，而且在同一次呼叫的 `compaction/summary` 之後。
 *
 * **記不進去，這次的縮短不生效**（[#1702](https://github.com/DemianLi/nexus-agent/issues/1702)）：講一條 warn，把新縮短的那幾則換回
 * 交給基座之前的原訊息再交下去（{@link restoreNewlyTruncatedArgs}），模型看到的跟日誌一致，這一輪照常繼續——照 dsh 自動壓縮的
 * pressure 路徑（`packages/compaction/compaction-basic/src/index.ts:163-173`）。基座的縮短只改請求、不進 graph state，所以換回請求就是
 * 全部。記過的縮短在交給基座之前就換上去了，照樣生效。
 *
 * @param base - 外一層（已包過 {@link withCompactionLog}）。
 * @param sessions - 註冊表的 `sessions` 通道。
 * @param report - 記不進去時的 warn。
 * @returns 同名、同狀態、多一層紀錄的 middleware。
 */
function withArgTruncationLog(
  base: AgentMiddleware,
  sessions: { forCall(config: unknown): SessionLookup },
  report: (message: string) => void,
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 基座那顆一定有 wrapModelCall；沒有的話包了也沒意義，原樣回去。 */
  if (inner === undefined) return base;
  return {
    ...base,
    wrapModelCall: (request, handler) => {
      let before: readonly BaseMessage[] = request.messages ?? [];
      let lookup: SessionLookup | undefined;
      try {
        lookup = sessions.forCall({
          configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
        });
        if (lookup.kind === 'ok') {
          before = applyRecordedArgTruncations(before, recordedArgTruncationsOf(lookup.log.events));
        }
      } catch {
        lookup = undefined;
      }
      const found = lookup;
      const forwarded =
        before === request.messages ? request : { ...request, messages: [...before] };
      return inner(forwarded as typeof request, (sent) => {
        if (found?.kind !== 'ok') return handler(sent);
        const calls = newlyTruncatedArgs(before, sent.messages ?? []);
        if (calls.length === 0) return handler(sent);
        try {
          found.log.append('compaction/truncate-args', { calls });
        } catch (error) {
          report(
            `compaction/truncate-args 記不進去，這次縮短的工具參數換回原文：${error instanceof Error ? error.message : String(error)}`,
          );
          return handler({
            ...sent,
            messages: [...restoreNewlyTruncatedArgs(before, sent.messages ?? [], calls)],
          });
        }
        return handler(sent);
      });
    },
  } as AgentMiddleware;
}

/** 基座的摘要訊息：`buildSummaryMessage` 蓋的 `lc_source`。`skill-catalog.ts` 的 {@link isHumanSpeech} 也用它。 */
export function isSummarizationMessage(message: BaseMessage): boolean {
  return (
    (message.additional_kwargs as { lc_source?: unknown } | undefined)?.lc_source ===
    'summarization'
  );
}

/** 上一次壓縮的切點（`request.state._summarizationEvent.cutoffIndex`）。沒有、或不是數字就是 `undefined`，同基座。 */
function previousCutoffOf(state: unknown): number | undefined {
  const event = (state as { readonly _summarizationEvent?: unknown } | null | undefined)
    ?._summarizationEvent;
  if (event === null || typeof event !== 'object') return undefined;
  const { cutoffIndex } = event as { readonly cutoffIndex?: unknown };
  return typeof cutoffIndex === 'number' ? cutoffIndex : undefined;
}

/**
 * 摘要文字裡寫的歷史檔路徑。基座的 `buildSummaryMessage`：寫成功時有一句
 * 「The full conversation history has been saved to <路徑> should you need to refer back to it for details.」，
 * 寫失敗（`filePath` 是 `null`）時整句沒有。**錨在開頭**，免得摘要本文裡剛好有同樣的句子。
 *
 * @param message - 基座的摘要訊息。
 * @returns 路徑；沒有那一句就是 `null`。
 */
export function summaryFilePathOf(message: BaseMessage): string | null {
  const match =
    /^\s*You are in the middle of a conversation that has been summarized\.\s+The full conversation history has been saved to (.+?) should you need to refer back/s.exec(
      message.text,
    );
  return match?.[1] ?? null;
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
 * ## `messages` 那道到了摘不摘得到：`messagesCompactable`
 *
 * 上面那句只對 `tokens` 那道成立。`messages` 那道到了，基座還要切得出東西才會摘要：保留量是 token 算的（#1374），
 * 訊息本身還沒超過保留量時尾巴蓋住整串，原樣送出（#1441）。所以每一筆多記一格 `messagesCompactable`
 * （[#1443](https://github.com/DemianLi/nexus-agent/issues/1443)）：{@link withRetainedTail} 這一步選尾巴的那一串，照保留政策要留的
 * 則數比它短就是 `true`，也就是交給基座的 `keep` 比則數小。**不看則數到了沒**，問的是「這道門檻到了的話摘不摘得到東西」；
 * `false` 只有一個意思，不會同時代表「還沒到」。沒有 `messages` 門檻就不給這一格。
 *
 * **數字是內層交出來的，這裡不重算**（{@link RETAIN_DECISION}）：中間隔著 {@link withArgTruncationLog}，它把日誌上記過的參數截斷
 * 換上去之後才交下來，選尾巴用的那串比這裡手上的便宜。在這裡拿自己的有效串重算，記過截斷之後就會記 `true`、實際卻不摘。
 *
 * 跟 `messageCount` 量的不一定是同一串：
 *
 * - 沒摘要的那一步，兩串則數相同（截參數不改則數）。
 * - 摘要了的那一步，選尾巴的是摘要前的串，所以記 `true`；`messageCount` 仍是交下去的 `[摘要, ...留下的]` 的則數。
 *
 * ## 超過就借基座的溢出恢復路徑摘要
 *
 * 基座的判準寫死在 `countTotalTokens`（純估算），沒有縫注入別的數。但它在「不摘要」那條路上把
 * `handler` 包在 `try` 裡，接到 `ContextOverflowError` 就走緊急摘要：摘要、再叫一次 `handler`
 * （`:3219-3229`）。所以超過預算時這裡**拋一顆合成的 `ContextOverflowError`**，由基座自己摘要——保留、切點、
 * 寫歷史、回 `_summarizationEvent` 全是基座原本那套。摘要完再叫進來的那一次不拋溢出（已經拋過一次），由下一節的重量處理。
 *
 * ## 摘要完再量一次（[#2028](https://github.com/DemianLi/nexus-agent/issues/2028)）
 *
 * 摘要完的請求交下來之前（{@link withQuietSummaryCall} 呼叫 {@link AFTER_SUMMARY}，比 {@link withCompactionLog} 記摘要早），用同一把量具再估一次。
 * 仍不低於門檻、還有重試次數、而且保留的尾巴還能更短時，拋 {@link RetainLessSignal}：{@link withRetainedTail} 接住，改用保留 0
 * 重摘一次（同 #1381 端點溢出的升級）。這一顆在基座的 `try` 裡拋出（`:3162-3168`），不是溢出，基座原樣往外拋、不拿它重摘。
 * 只有 `canRetainLess` 為 true 時才拋：那顆的 `handler` 被 `watched` 包住，端點超窗變成 {@link EndpointOverflowSignal}，走不到基座
 * 沒有 `try` 的再摘要（`:3178`）；其餘的實例 `canRetainLess` 都是 false，在 `:3178` 交下去時只會記 warn。
 * 白摘的第一份不進日誌也不進歷史：拋在記之前，歷史在同一個 `wrapModelCall` 裡後寫的蓋前寫的（#1389）。
 * 重摘之後仍超過、沒有重試次數、或尾巴已經最短：講一條 warn，照這份送出，不退回基座的再摘要。
 *
 * **合成的超窗只在基座會接的地方拋**，其他三條路上的 `handler` 沒有 `try`，拋了就是整輪失敗：
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
 * 4. **`messagesCompactable` 是 dsh 沒有的一格**（產品需求超出 dsh，#1443）。dsh 的 `ContextPressureProjection`
 *    （`llm/token-meter/src/projection.ts:30-48`，`5719020`）只有 token 數與窗口；「切不切得出東西」只在壓縮內部問
 *    （`selectCompactableRange` 回 `null`，`compaction-basic/src/region.ts:117-155`、`index.ts:299`／`331`／`394`）
 *    與 `/compact` 的回覆裡講（`command-compact/src/index.ts:68`），不進投影。dsh 也沒有 `messages` 門檻（觸發只比 token，
 *    `index.ts:319`）；那道是我們自己加的（{@link DEFAULT_SUMMARIZATION} 的「`messages: 60` 那道」），這一格補的是它的誠實。
 * 5. **`compactionRetries` 只收 0 或 1，重試固定用保留 0**；≥2 在載入時就拒（{@link assertCompactionRetries}）。兩條理由都在
 *    {@link withRetainedTail}：
 *    - 重試交下去的永遠是原請求 `seeded`，換的只有保留量（`chainFor(zero, true)`），再試一次切到的是同一段；
 *    - 保留 0 那一次在 `catch` 裡，外面沒有 `try`，再拋 {@link RetainLessSignal} 會冒過 {@link withTokenBudget}，整輪失敗。
 *
 * ## 量與記都不准拋
 *
 * 唯一刻意拋的是 {@link RetainLessSignal}，見〈摘要完再量一次〉；估不出來時 `afterSummary` 照樣不比、不拋。
 * 估不出來就不比、不記，退回基座自己的 `messages` 門檻。**`context/measure` 記不進去講一條 warn**（`report`），這次呼叫照常回來
 * （[#1702](https://github.com/DemianLi/nexus-agent/issues/1702) 歸 (C)）：它不改請求、不改 state，只是量測，跟 dsh 自動壓縮的失敗同一類
 * （`packages/compaction/compaction-basic/src/index.ts:163-173`）。**`handler` 本身拋的錯原樣往外傳**——那是基座的緊急摘要要接的。
 *
 * **記的時刻是「下一層正常回來」**：拋錯的那次不記；停止閘門（`turnCancel`）擋下的那一次照記——閘門在更內層，
 * 它回的合成收尾對這裡就是正常回來。`turn-cancel.test.ts` 的委派那條釘著這件事。
 *
 * @param base - 摘要器（包過 {@link withCompactionLog} 的也行，它原樣轉交 `handler`）。
 * @param trigger - 全部門檻；比的是 `tokens` 那幾道，`messages` 那幾道用來判斷基座走哪條路。原樣記進每一筆。
 * @param book - 錨定估算的帳。
 * @param sessions - 註冊表的 `sessions` 通道。省略即不記，照樣比。
 * @param compactionRetries - 摘要後重量可以要求的重摘次數，0 或 1。
 * @returns 同名、同狀態、多一層預算的 middleware。
 */
function withTokenBudget(
  base: AgentMiddleware,
  trigger: readonly SummarizationThreshold[],
  book: TokenAnchorBook,
  sessions?: { forCall(config: unknown): SessionLookup },
  limitsOf?: (model: unknown) => ModelContextLimits | undefined,
  report: (message: string) => void = (message) => console.warn(message),
  compactionRetries = DEFAULT_SUMMARIZATION.compactionRetries,
): AgentMiddleware {
  const inner = base.wrapModelCall?.bind(base);
  /* v8 ignore next -- 同 withCompactionLog。 */
  if (inner === undefined) return base;
  const byMessages = trigger.filter((t) => t.type === 'messages').map((t) => t.value);
  return {
    ...base,
    wrapModelCall: (request, handler) => {
      // 門檻逐步算：換模型之後窗口跟著換（#723）。沒有夾住時 `effective` 就是 `trigger` 本身。
      const effective = effectiveTrigger(trigger, limitsOf?.(request.model));
      const thresholds = effective.map(({ type, value }) => ({ type, value }));
      const budgets = effective.filter((t) => t.type === 'tokens').map((t) => t.value);
      const budget = budgets.length === 0 ? undefined : Math.min(...budgets);
      const view = effectiveMessages(request.messages ?? [], request.state);
      const baseWillCatch = view.length > 0 && !byMessages.some((value) => view.length >= value);
      let thrown = false;
      // 內層 {@link withRetainedTail} 填的保留決定，`messagesCompactable` 讀它（#1443）。
      const decision: RetainDecision = {};
      // 端點真的回的超窗（不是我們合成的）：基座接住它、走緊急摘要；摘要若失敗，這一份是要還給呼叫端的原錯誤。
      let endpointOverflow: unknown;
      let retriesLeft = compactionRetries;
      // 摘要完、基座交下來的那一份：重量（#2028）。仍超過就換 retain 0 再摘一次；用完、或少留也沒用，記一條 warn、照這份送。
      const afterSummary: AfterSummary = (sent) => {
        let tokens: number;
        try {
          tokens = estimateAnchoredTokens(sent, book).tokens;
        } catch {
          return;
        }
        if (budget === undefined || tokens < budget) return;
        if (retriesLeft > 0 && decision.canRetainLess === true) {
          retriesLeft -= 1;
          throw new RetainLessSignal();
        }
        const why =
          retriesLeft < compactionRetries
            ? `已經換最小的保留量重摘過 ${compactionRetries - retriesLeft} 次`
            : compactionRetries === 0
              ? '沒有設定重試（compactionRetries 是 0）'
              : '保留的尾巴已經是最小的，再摘也一樣';
        report(
          `摘要之後仍超過門檻：這份請求估計 ${tokens} token，門檻 ${budget}；${why}，照這份送出。`,
        );
      };
      const measured: Parameters<NonNullable<typeof inner>>[1] = async (sent) => {
        let estimate: ReturnType<typeof estimateAnchoredTokens> | undefined;
        try {
          estimate = estimateAnchoredTokens(sent, book);
        } catch {
          // 估不出來就不比、不記，不能反過來擋住這次呼叫。
        }
        if (estimate !== undefined && budget !== undefined && baseWillCatch && !thrown) {
          if (estimate.tokens >= budget) {
            thrown = true;
            throw syntheticOverflow(
              `摘要預算：這份請求估計 ${estimate.tokens} token，到了 ${budget} 的門檻。`,
            );
          }
        }
        // 夾住下一層，拿回它裡面那次模型呼叫的識別：量測寫在 `model/end` 之後，位置歸不對（#1021）。
        const { result: response, call } = await captureModelCall(async () => {
          try {
            return await handler(sent);
          } catch (error) {
            if (isContextOverflowError(error)) endpointOverflow ??= error;
            throw error;
          }
        });
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
          if (found.kind === 'ok') {
            const { retained, length } = decision;
            found.log.append(
              'context/measure',
              withModelCall(
                {
                  approxTokens: estimate.tokens,
                  messageCount: (sent.messages ?? []).length,
                  thresholds,
                  // 不看則數到了沒，只問「到了的話摘不摘得到東西」（#1443）。沒有 `messages` 門檻就不給這一格。
                  ...(thresholds.some((threshold) => threshold.type === 'messages') &&
                    retained !== undefined &&
                    length !== undefined && { messagesCompactable: retained < length }),
                  // 這份請求的組成（#1571）：系統與工具是 `sent` 的純估算，訊息拿環上的數扣掉這兩格，三格相加等於 `approxTokens`。
                  breakdown: {
                    systemTokens: estimate.parts.system,
                    toolsTokens: estimate.parts.tools,
                    messageTokens: Math.max(
                      0,
                      estimate.tokens - estimate.parts.system - estimate.parts.tools,
                    ),
                  },
                },
                call.of(found.log),
              ),
            );
          }
        } catch (error) {
          report(
            `context/measure 記不進去：${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return response;
      };
      return (async () => {
        try {
          return await inner(
            {
              ...request,
              [RETAIN_DECISION]: decision,
              [AFTER_SUMMARY]: afterSummary,
            } as typeof request,
            measured,
          );
        } catch (error) {
          // 只認「生摘要那次模型呼叫拋的」：摘要成功、之後的模型呼叫才失敗的錯照原樣冒出去。
          if (typeof error !== 'object' || error === null || !summaryCallFailures.has(error))
            throw error;
          // 使用者按停止不是摘要壞了，不吞。
          if ((error as { name?: unknown }).name === 'AbortError') throw error;
          const reason = error instanceof Error ? error.message : String(error);
          if (endpointOverflow !== undefined) {
            // 端點真的超窗、摘要也失敗：照 dsh 的 overflow 路徑（`compaction-basic/src/index.ts:205-224`），
            // 記一條 warn、**保留原本的請求錯誤**，不拿摘要那個錯蓋掉它，也不發明修剪。
            report(`摘要失敗（端點回超窗後的恢復）：${reason}；保留原本的請求錯誤。`);
            throw endpointOverflow;
          }
          // 我們自己的門檻（token 預算或訊息數）觸發、摘要失敗：照 dsh 的 pressure 路徑（`index.ts:158-175`，
          // 「step compaction failed … continuing the turn」）——記一條 warn，照原請求送出去，讓端點自己決定裝不裝得下。
          // 不是任何真的請求錯誤，所以沒有「原錯誤」可保留：拿合成的「摘要預算」那句丟出去只會讓人看不懂。
          report(`摘要失敗（門檻觸發）：${reason}；照原請求送出。`);
          thrown = true;
          // 送「沒動手摘要時本來會往下交的那份」，不是 `request.messages` 的原串（那裡面摘要之前的舊訊息還在）：
          // 帶著 {@link SUPPRESS_SUMMARY} 再走一遍同一條鏈，有效串、參數截斷與日誌記帳都照平常的路。
          try {
            return await inner(
              {
                ...request,
                [SUPPRESS_SUMMARY]: true,
                [RETAIN_DECISION]: decision,
              } as typeof request,
              measured,
            );
          } catch (retryError) {
            // 照原請求送出又碰到端點超窗、基座的緊急摘要又失敗（含摘要記不進去，#1702）：同上面的 overflow 路徑，
            // 保留原本的請求錯誤，不再重摘。
            if (
              endpointOverflow !== undefined &&
              typeof retryError === 'object' &&
              retryError !== null &&
              summaryCallFailures.has(retryError)
            ) {
              report(
                `摘要失敗（照原請求送出後端點回超窗的恢復）：${retryError instanceof Error ? retryError.message : String(retryError)}；保留原本的請求錯誤。`,
              );
              throw endpointOverflow;
            }
            throw retryError;
          }
        }
      })();
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
 * ## `messages` 門檻要「摘得到東西」才算
 *
 * 則數到了，基座才走 `performSummarization`；但保留量改成 token 之後（[#1374](https://github.com/DemianLi/nexus-agent/issues/1374)），
 * 尾巴可能蓋住整串，基座算出 `cutoffIndex <= 0`、原樣送出——**這一步不會摘要**。出廠設定下，訊息本身不到 20,000 token
 * 的對話就是這樣（2026-10-14 發版模擬實測：到 70 則、整份請求約 33k token，一次都沒摘）。那時照則數判壓力，剪刀就會在
 * 一個離任何門檻都還很遠的對話上，把每一則大工具結果（包括模型剛查回來的那一則）剪掉中段，正是 dsh「低于压力的对话绝不被碰」
 * 禁止的事。所以 `messages` 那道多一個條件：{@link retainedMessageCount} 算出的尾巴要比有效串短。
 *
 * `tokens` 那道不加：保留量封在門檻的兩成（{@link RETAIN_THRESHOLD_CAP_RATIO}），越過門檻時尾巴通常蓋不住全部。例外是 system
 * 與工具定義自己就占掉門檻八成以上——那時摘不到東西、剪刀照剪，而剪掉的確實是讓整份請求逼近窗口的那一截，所以不擋。
 *
 * @param request - 剪刀收到的那份請求。
 * @param trigger - 我們配的那組門檻。
 * @param book - 錨定估算的帳。
 * @param retainedCount - 這一步摘要之後會留幾則，見 {@link retainedMessageCount}；收的是有效串。
 * @returns 任何一道門檻成立就 `true`。
 */
export function isUnderCompactionPressure(
  request: EstimatedRequest & { readonly state?: unknown },
  trigger: readonly SummarizationThreshold[],
  book: TokenAnchorBook,
  retainedCount: (messages: readonly BaseMessage[]) => number,
): boolean {
  const messages = effectiveMessages(request.messages ?? [], request.state);
  let tokens: number | undefined;
  let compactable: boolean | undefined;
  for (const threshold of trigger) {
    if (threshold.type === 'messages' && messages.length >= threshold.value) {
      compactable ??= retainedCount(messages) < messages.length;
      if (compactable) return true;
    }
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
  /** 見 {@link SummarizationSettings.retainRatio}。與 `retainTokens` 擇一；都沒給就是 {@link RETAIN_RATIO}。 */
  retainRatio: z.number().optional(),
  /** 見 {@link SummarizationSettings.retainTokens}。 */
  retainTokens: z.number().optional(),
  /**
   * **已拿掉**（#1374）。收下它只為了給一句看得懂的錯誤——`strictObject` 的「不認得的欄位」不會說要改成什麼。
   * 驗過之後這一格一定不在。
   */
  keep: z.unknown().optional(),
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
  /** 見 {@link SummarizationSettings.compactionRetries}。值的規則在 resolve 裡。 */
  compactionRetries: z.number().default(DEFAULT_SUMMARIZATION.compactionRetries),
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
