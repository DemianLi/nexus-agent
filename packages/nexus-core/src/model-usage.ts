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

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import type { SessionLookup } from './registry.js';

/** middleware 的名字。名字不撞基座任何一個，所以它是 novel entry。 */
export const MODEL_USAGE_MIDDLEWARE_NAME = 'nexusModelUsage';

/**
 * 一次模型呼叫報回來的 token 帳目。
 *
 * **三個數字都是供應商報的，沒有一個是我們算的。** `totalTokens` 不由
 * `inputTokens + outputTokens` 補——照 {@link ../../../apps/harness/src/scripted-model.ts |
 * ScriptedUsage} 檔頭那條原則：「成本算得出來」與「成本是我們捏的」要分得開。
 */
export interface ModelUsage {
  /** 這次請求的 prompt token 數。含快取讀取的部分，那是 LangChain 的語義。 */
  readonly inputTokens: number;
  /** 這次回應的 token 數。 */
  readonly outputTokens: number;
  /** 供應商報的完整總量。 */
  readonly totalTokens: number;
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
  } = metadata as Record<string, unknown>;
  if (!isCount(input) || !isCount(output) || !isCount(total)) return undefined;
  const prompt = total - output;
  if (!isCount(prompt) || prompt < input) return undefined;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
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
      const response = await handler(request);
      const usage = readModelUsage(response);
      if (usage === undefined) return response;
      // `runtime.configurable` 就是 `forCall` 要的那份 —— 包回一層 `configurable` 是因為
      // 它收的是 handler 的 config 形狀，不是 configurable 本身。
      const found = sessions.forCall({
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      });
      if (found.kind !== 'ok') return response;
      try {
        found.log.append('model/usage', usage);
      } catch {
        // 記不進去不能反過來殺掉這次模型呼叫。見檔頭最後一段。
      }
      return response;
    },
  }) as unknown as AgentMiddleware;
}
