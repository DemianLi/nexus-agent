/**
 * 每一次模型呼叫的 token 帳目，記進**這次呼叫所屬的那一份**會話日誌。
 *
 * ## dsh 怎麼做，以及我們哪一格對不上
 *
 * dsh 的用量**不是一種獨立事件**。它掛在 `assistant/message` 上，那顆事件的註解自己
 * 講明白了（`references/deepseek-harness/packages/core/session/src/types.ts:300`，
 * SHA `4e84901`；動工當天對過 upstream，這條路徑只有 `package.json` 的版號差別）：
 *
 * > Carries the step's `usage` when the adapter reported token accounting, so the model
 * > output and its accounting travel together (**there is no separate usage record**).
 * > `usage` is absent when the adapter reported none.
 *
 * 輪級的彙總則是**一道純折疊**（`packages/llm/token-meter/src/turn-usage.ts` 的
 * `deriveTurnTokenUsage`），從 `turn/start` 讀到 `turn/end`，不回寫任何東西。
 *
 * **我們沒有那顆載體。** {@link ./session-log.ts} 的檔頭寫著這一版刻意不記訊息內容，
 * 理由是兩條進入點拿得到的顆粒度不一樣。所以照 AGENTS.md 那條偏離規則退到最接近的
 * 實作：**一顆只帶帳目的獨立事件**（`model/usage`）。退的是載體，不是紀律——
 * 「有報才記、沒報不記、報得自相矛盾也不記」整條照抄。
 *
 * 沒退的還有第二件：**輪級彙總我們同樣不寫回日誌**。要一輪花了多少，讀日誌自己加，
 * 跟 dsh 的 `deriveTurnTokenUsage` 一樣。
 *
 * ## 沒有正常回來的呼叫也記（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）
 *
 * dsh 的 `assistant/attempt` 串流裡報了用量就算，失敗與中止的 attempt 也在帳上
 * （`packages/llm/token-meter/src/usage-projection.ts`）。我們的呼叫拋錯時沒有回應物件可讀，v3 串流的模型層又收不到 token 回呼，
 * 供應商的用量只活在 `fetch` 回來的位元組裡——所以由 adapter（`live-model.ts` 的串流用量嗅探）在請求開跑時拿一個回報函式
 * （`beginAttemptReport`，{@link ./model-call-scope.ts}），串流裡看到用量就回報；這顆 middleware 在呼叫拋錯（或子代理被中止回合成收尾）
 * 時讀它，**過同一把尺**（{@link validateUsage}）才記，記成帶 `outcome` 的 `model/usage`。**沒報就不記**：「不知道花了多少」
 * 不是 0，由配對的 `model/end.outcome` 表態。每次請求（含 SDK 的重試）各換一格，所以只有**最後一次請求**的用量算數。
 *
 * ## 生產者是一個 `wrapModelCall`，而那個鉤子是選的
 *
 * `beforeModel`／`afterModel` 會各自展開成 `StateGraph` 上的一個節點，每一輪多吃一格
 * super-step（[#147](https://github.com/DemianLi/nexus-agent/pull/157) 量到的：預設組裝
 * 在 `recursionLimit: 100` 下從 49 輪掉到 33 輪）。`wrapModelCall` 跑在既有節點**內部**，
 * 不吃格。這裡只要讀回應，不需要動訊息串，所以沒有理由付那個價錢。
 *
 * ## 「這次呼叫屬於哪一份日誌」與工具那條是同一把鑰匙
 *
 * 實測（2026-09-03，`langchain@1.5.10` ＋ `deepagents@1.13.1`）：
 *
 * | 情境 | `checkpoint_ns` |
 * | --- | --- |
 * | root 的模型呼叫 | `model_request:<uuid>` |
 * | subagent 的模型呼叫 | `tools:<父圖那次 task 呼叫的 id>｜model_request:<uuid>` |
 *
 * 去掉最後一段之後 root 剩空的、subagent 剩 `tools:<task id>`——**跟同一次 spawn 裡的
 * 工具呼叫算出來的 `runId` 是同一個值**。所以 {@link ./session-address.ts |
 * toolCallSessionAddress} 原封不動就對，兩列已經補進那個檔頭的表與它的測試。
 *
 * ## 這顆 middleware 坐在 request path 上，所以它不准拋
 *
 * 三件事都會拋，三件都被吃掉：`forCall` 的三種非 `ok`、`usage_metadata` 驗不過、
 * `append` 自己拋（`snapshotJsonValue` 對 `NaN` 是當場拋的）。理由照
 * {@link ./session-log.ts} 對遙測那句「盡力而為的旁路，**不能有能力扳倒 agent loop**」
 * ——而這裡更嚴，因為遙測掛在事件之後，這顆掛在模型呼叫本身上。
 *
 * **`not-attached` 是常態不是異常。** 兩條產品進入點都接（`cli.ts` 的 `runRepl`、
 * web 那條的 `wire-handler.ts`），但 `eval/runner.ts`、`spike/spike-agent.ts` 與絕大多數
 * 測試的組裝都沒有 `attachSession`——它們不需要日誌，不該為此拿到一個例外。
 *
 * @module
 */

import { AIMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import {
  currentModelCall,
  reportedAttemptUsage,
  withModelCall,
  type AttemptUsage,
} from './model-call-scope.js';
import type { NexusPlugin } from './plugin.js';
import type { SessionLookup } from './registry.js';
import type { ModelCallOutcome } from './session-log.js';
import { isSyntheticStopReply, modelCallAborted } from './turn-cancel.js';

/** middleware 的名字。名字不撞基座任何一個，所以它是 novel entry。 */
export const MODEL_USAGE_MIDDLEWARE_NAME = 'nexusModelUsage';

/**
 * 一次模型呼叫報回來的 token 帳目。
 *
 * **數字都是供應商報的，沒有一個是我們編的。** `totalTokens` 不由
 * `inputTokens + outputTokens` 補——照 {@link ../../../apps/harness/src/scripted-model.ts |
 * ScriptedUsage} 檔頭那條原則：「成本算得出來」與「成本是我們捏的」要分得開。
 *
 * ## 四桶互不重疊（[#724](https://github.com/DemianLi/nexus-agent/issues/724)，照 dsh）
 *
 * `inputTokens` 是**未快取**的輸入，快取讀與快取寫另放；這次請求完整的 prompt 是三桶相加（{@link promptTokensOf}）。
 * dsh `TokenUsage` 同形（`packages/llm/llm/src/types.ts:170-187`）：供應商把快取併進 prompt 總數的，由 adapter 減出來——
 * 我們的 adapter 就是這裡（{@link validateUsage}）。
 *
 * **要減哪幾桶：OpenAI 相容端點的 `prompt_tokens` 兩桶都含。** 出處：OpenAI 的 prompt caching 指南範例把未快取輸入算成
 * `inputTokens - cachedTokens - cacheWriteTokens`（<https://developers.openai.com/api/docs/guides/prompt-caching>，2026-10-09 讀）；
 * OpenRouter 的用量範例 `prompt_tokens` 194、`cache_write_tokens` 100、`total_tokens` 196（= 194 + 2 個輸出），寫快取那段在 prompt
 * 之內（<https://openrouter.ai/docs/use-cases/usage-accounting>）。dsh 經 pi-ai 對 OpenAI 相容端點同樣是 input 減掉兩桶。
 *
 * **缺席是「沒記」，不是 0。** 供應商沒報快取細節（或 LangChain 在整個 `prompt_tokens_details` 缺席時建出的
 * `{ cache_read: undefined }`）就不放 key，`inputTokens` 仍是整個 prompt。舊日誌（格式 35 以前）全是這一種。
 */
export interface ModelUsage {
  /** 這次請求**未快取**的輸入 token 數。沒報快取細節時就是整個 prompt。 */
  readonly inputTokens: number;
  /** 這次回應的 token 數。 */
  readonly outputTokens: number;
  /** 供應商報的完整總量。 */
  readonly totalTokens: number;
  /** 命中快取、從快取讀出來的輸入 token 數。缺席＝沒報。 */
  readonly cacheReadTokens?: number;
  /** 寫進快取的輸入 token 數。缺席＝沒報。 */
  readonly cacheWriteTokens?: number;
}

/**
 * 這次請求完整的 prompt 有多大：未快取、快取讀、快取寫三桶相加。壓力、「目前大小」、舊 `inputTokens`（含快取）的讀者都用它；
 * 沒報快取的桶當 0 加。
 */
export function promptTokensOf(usage: {
  readonly inputTokens: number;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

/**
 * 一個數字算不算數。照 dsh `turn-usage.ts` 的 `isCount`：安全整數且非負。
 *
 * `Number.isSafeInteger` 順手把 `NaN`、`Infinity`、小數與超出安全範圍的整數一起擋掉
 * ——那四種進了 {@link ./session-log.ts | SessionLog.append} 不是拋就是記下一個
 * 沒有意義的數字。
 *
 * @param value - 要檢查的東西。
 * @returns 是不是一個算得上數量的值。
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 把 LangChain 的 `usage_metadata` 讀成帳目，**驗不過就整筆不要**。
 *
 * 兩道檢查照 dsh 的 `normalizeUsage`：
 *
 * 1. 每一欄各自要是一個數量。
 * 2. **總量不得與它的組成矛盾**——`totalTokens - outputTokens` 要是一個數量、而且不小於
 *    已知的 prompt（`inputTokens`）。小於就是報回來的數字自己對不起來，那種寧可沒有。
 *
 *    **不強制相等，因為我們不替供應商決定它怎麼加總。** 照 LangChain 自己的契約
 *    `total_tokens === input_tokens + output_tokens` 會成立（它的 `input_tokens` 是含快取的
 *    完整 prompt），所以實務上兩邊會剛好相等；夾成 `===` 只會讓一個多報了某個桶的供應商
 *    整筆消失。**注意 dsh 那側用 `>=` 的理由與這裡不同**：它的 `inputTokens` 是**未快取**
 *    的那部分，比真正的 prompt 小，所以鬆弛在它那邊有具體的對應物，在我們這邊沒有。
 *    規則同形，理由不同——不要照抄它的理由。
 *
 * **部分披露不做。** 任一欄壞掉就整筆不記，不記一半——同 dsh：任何矛盾讓整個 attempt
 * 不可用。
 *
 * @param message - 模型回的那顆訊息，形狀不確定所以當 `unknown` 收。
 * @returns 驗得過的帳目，或 `undefined`（沒報、或報得不對）。
 */
export function readModelUsage(message: unknown): ModelUsage | undefined {
  if (typeof message !== 'object' || message === null) return undefined;
  const metadata = (message as { usage_metadata?: unknown }).usage_metadata;
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    input_token_details: details,
  } = metadata as Record<string, unknown>;
  const { cache_read: cacheRead, cache_creation: cacheWrite } =
    typeof details === 'object' && details !== null
      ? (details as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  return validateUsage(input, output, total, { cacheRead, cacheWrite });
}

/**
 * 數字驗得過就成一筆帳目，驗不過整筆不要——{@link readModelUsage} 的檢查，給「數字不是從訊息上讀的」那條路
 * 共用：adapter 在串流裡看到的用量（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）同一把尺。
 *
 * 快取兩桶（#724）照 dsh `turn-usage.ts` 的 `normalizeUsage`：
 *
 * - 快取值是 `undefined` 或 `null` ＝ 供應商沒報，不放 key；有值就得是一個數量，不是就整筆不要。
 * - 兩桶加起來不得超過 prompt（超過就是自相矛盾）；`inputTokens` 回傳的是減掉兩桶之後的未快取那格。
 * - **兩桶都報時 `total - output` 要恰好等於 prompt**，否則整筆不要（只報一桶時不強制，維持原本的 `>=`）。
 *
 * @param input - 供應商報的 prompt token 數，**含**快取兩桶。
 * @param output - 回應 token 數。
 * @param total - 供應商報的完整總量。
 * @param cache - 快取讀、快取寫（還沒驗）；省略＝沒報。
 * @returns 驗得過的帳目（`inputTokens` 已減掉快取），或 `undefined`。
 */
export function validateUsage(
  input: unknown,
  output: unknown,
  total: unknown,
  cache: { readonly cacheRead?: unknown; readonly cacheWrite?: unknown } = {},
): ModelUsage | undefined {
  if (!isCount(input) || !isCount(output) || !isCount(total)) return undefined;
  const reported = (value: unknown): boolean => value !== undefined && value !== null;
  const hasRead = reported(cache.cacheRead);
  const hasWrite = reported(cache.cacheWrite);
  if (hasRead && !isCount(cache.cacheRead)) return undefined;
  if (hasWrite && !isCount(cache.cacheWrite)) return undefined;
  const cacheRead = hasRead ? (cache.cacheRead as number) : undefined;
  const cacheWrite = hasWrite ? (cache.cacheWrite as number) : undefined;
  const prompt = total - output;
  if (!isCount(prompt) || prompt < input) return undefined;
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0);
  if (cached > input) return undefined;
  if (hasRead && hasWrite && prompt !== input) return undefined;
  return {
    inputTokens: input - cached,
    outputTokens: output,
    totalTokens: total,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  };
}

/** adapter 回報的用量（還沒驗）過同一把尺。 */
function validateAttempt(reported: AttemptUsage | undefined): ModelUsage | undefined {
  if (reported === undefined) return undefined;
  return validateUsage(reported.inputTokens, reported.outputTokens, reported.totalTokens, {
    cacheRead: reported.cacheReadTokens,
    cacheWrite: reported.cacheWriteTokens,
  });
}

/**
 * 沒有正常回來的呼叫：adapter 在串流裡報過用量才記一筆帶 `outcome` 的 `model/usage`（[#1022](https://github.com/DemianLi/nexus-agent/issues/1022)）。
 *
 * **沒報、或報得對不起來就什麼都不記**——「不知道花了多少」不是 0，由配對的 `model/end.outcome` 表態。這個函式不准拋：
 * 它跑在 `catch` 裡，從這裡漏出去的錯會蓋掉原本那個，所以 `forCall` 與 `append` 的失敗一律吃掉。
 */
function recordUnfinished(
  sessions: { forCall(config: unknown): SessionLookup },
  request: unknown,
  outcome: ModelCallOutcome,
): void {
  try {
    const found = sessions.forCall({
      configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
    });
    if (found.kind !== 'ok') return;
    const usage = validateAttempt(reportedAttemptUsage(found.log));
    if (usage === undefined) return;
    found.log.append(
      'model/usage',
      withModelCall({ ...usage, outcome }, currentModelCall(found.log)),
    );
  } catch {
    // 見檔頭最後一段。
  }
}

/**
 * 建那顆 middleware。**無狀態，所以一份實例掛到哪裡都行**——鏈與身分每次都從執行期的
 * `configurable` 現算。
 *
 * 這是 [#142](https://github.com/DemianLi/nexus-agent/pull/156) 摘要器的相反面：那個的
 * `sessionId` 在 closure 裡，共用會讓兩個 agent 的歷史混進同一個檔，所以必須逐個建。
 * 這裡沒有 closure 狀態可以混。
 *
 * @param sessions - 註冊表的 `sessions` 通道，用來問「這次呼叫該寫進哪一份」。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createModelUsageRecorder(sessions: {
  forCall(config: unknown): SessionLookup;
}): AgentMiddleware {
  return createMiddleware({
    name: MODEL_USAGE_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      let response: Awaited<ReturnType<typeof handler>>;
      try {
        response = await handler(request);
      } catch (error) {
        // 拋錯的呼叫：供應商若在串流裡報過用量，那些 token 照樣花掉了（#1022）。
        recordUnfinished(sessions, request, modelCallAborted(request) ? 'aborted' : 'error');
        throw error;
      }
      const usage = readModelUsage(response);
      if (usage === undefined) {
        // 子代理被中止回的是合成的空收尾，不是拋錯：同樣是沒有正常回來的呼叫。
        if (AIMessage.isInstance(response) && isSyntheticStopReply(response)) {
          recordUnfinished(sessions, request, 'aborted');
        }
        return response;
      }
      // `runtime.configurable` 就是 `forCall` 要的那份 —— 包回一層 `configurable` 是因為
      // 它收的是 handler 的 config 形狀，不是 configurable 本身。
      const found = sessions.forCall({
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      });
      if (found.kind !== 'ok') return response;
      try {
        found.log.append('model/usage', withModelCall(usage, currentModelCall(found.log)));
      } catch {
        // 記不進去不能反過來殺掉這次模型呼叫。見檔頭最後一段。
      }
      return response;
    },
  }) as unknown as AgentMiddleware;
}

/**
 * 這個條目的 plugin 名。
 *
 * **承重的常數**：{@link ./fold.ts | foldRegistry} 拿它去問
 * {@link ./registry.ts | DisabledEntryView}，所以它是「這一顆被明著關掉了」的唯一鍵。
 * 刻意不是條目的 `id`——id 是使用者的 patch 改得動的字串
 * （[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 *
 * **取名沒有跟 dsh 的套件名走，而那是刻意的。** 它那側最接近的是 `llm/token-meter`，
 * 但那個套件做的是輪級彙總（`deriveTurnTokenUsage`，一道純折疊），而我們這一顆做的是
 * 逐次呼叫的記錄——檔頭第一段講的就是兩邊對不上的那一格。借它的名字會讓設定檔裡出現
 * 一個指著別的東西的詞。
 */
export const MODEL_USAGE_PLUGIN_NAME = 'model-usage';

/**
 * 用量記錄器的**設定條目**（[#456](https://github.com/DemianLi/nexus-agent/issues/456)）。
 *
 * **它一顆服務都不註冊，`apply` 是空的**，形狀同
 * {@link ./observation.ts | observationPolicyPlugin}：這一顆**沒有設定**——
 * {@link createModelUsageRecorder} 只收一個 `sessions` 通道，沒有任何數字或開關可以調。
 * 所以它只有三態而不是四態，「條目在場」與「這次組裝沒有經過部署設定層」的正確答案都是
 * 「照預設開著」。要分的只有**有沒有被明著關掉**，而那件事 `disabledEntries` 已經記著了。
 *
 * **因此這一列沒有 `config`**：沒有 Config schema，寫了也沒有作用——`parseEntryConfig` 照 dsh 原樣交給 `apply`、
 * 不驗，產品路徑上啟動時印一句警告（見 {@link ./plugin.ts | parseEntryConfig}）。
 *
 * **關掉它之後不見的是日誌裡的 `model/usage`**——檔頭第一段講的那本帳——**連帶 web 用量表
 * 的「目前大小」那一行**：pump 與歷史路由把 root 最新那一筆的 `inputTokens` 送上線
 * （[#528](https://github.com/DemianLi/nexus-agent/issues/528)）。那是**讀最新一筆**，不是加總；
 * 環與比例讀的是摘要器的 `context/measure`，不受這一顆影響。**加總它的仍然沒有**，而關掉它
 * 沒有任何東西會紅——那正是這個代價非寫下來不可的理由。數過（2026-09-22，#528 之後再對過）：
 *
 * - `apps/harness/src/eval/runner.ts` 的用量是它**自己從 `usage_metadata` 加的**，而且
 *   那條路連 `attachSession` 都不接（它的檔頭寫明「這條路沒有消費者」，還配了
 *   `session-absence.test.ts` 當絆索）。**評估那邊的數字跟這一顆無關。**
 * - `apps/harness/src/eval/session-scan.ts` 只把它列在「這一版認得的事件種類」裡，不算它。
 * - `deriveSessionStats` 的 `steps` 數的是 `model/start`／`model/end`，不是這一顆。
 *
 * 所以不見的是落盤日誌裡那本逐次呼叫的帳與用量表的那一行。這件事也寫在 `docs/operations.md` 的表上，
 * 因為從這個條目本身看不出來。
 *
 * **偏離登記**同 {@link ./repeat-reminder.ts | repeatReminderPlugin}：載體是
 * `@nexus/core` 的子路徑而不是獨立套件；而這一顆更前面還有一條**檔頭本來就登記過**的
 * 偏離（dsh 沒有獨立的用量事件，它掛在 `assistant/message` 上）。條目這一層不新增偏離，
 * 建構與排位仍由 fold 決定——位置是承重的，見 {@link ./fold.ts | foldMiddleware} 講
 * 「用量記錄器排在其餘 plugin middleware 之前」那一段。
 */
export const modelUsagePlugin: NexusPlugin = {
  name: MODEL_USAGE_PLUGIN_NAME,
  apply() {
    // 空的，而且是承重的空：見上面的檔頭。這一顆唯一的作用是「在場、可以被 disabled」。
  },
};

export default modelUsagePlugin;
