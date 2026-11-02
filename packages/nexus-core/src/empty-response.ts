/**
 * 「停了但什麼都沒有」的回覆算一次失敗，交給重試那一層重打（[#1437](https://github.com/DemianLi/nexus-agent/issues/1437)）。
 *
 * ## dsh 怎麼做，這裡哪一格對得上
 *
 * dsh 的 `EMPTY_RESPONSE` 在 adapter 那一層產生：一次回應以 stop 收尾、卻沒有任何 content 區塊，就當成
 * `{ code: 'EMPTY_RESPONSE' }` 的失敗，它在預設可重試碼裡（`llm/src/retry-policy.ts:18`），所以一整次重打、
 * 預算用盡才讓這一步失敗。我們的重試迴圈在 {@link ./stream-retry.ts}，**碼決定重不重打**（#1437），所以這裡只要做
 * 一件事：看見「stop 但沒有 content」就回報 `EMPTY_RESPONSE` 並拋。
 *
 * ## 為什麼是一顆 middleware，而且排在這個位置
 *
 * 看得到「`finish_reason` 與整則內容」的最外面那一格是 `wrapModelCall`：adapter 層（fetch）只看得到位元組，
 * 還沒組成訊息。位置排在**起訖紀錄器的內側、用量記錄器的外側**：
 *
 * - 在紀錄器內側：空回覆那一次是 `model/end` 帶 `outcome: 'error'`，**不寫 `assistant/message`**——日誌裡沒有一則
 *   「沒有內容的助手訊息」，之後的歷史重放、web 的泡泡都不會看到空回覆。
 * - 在用量記錄器外側：那一次**真的燒了 token**，用量照記（用量記錄器在它內側，回應回來時已經寫完）。
 *
 * ## 什麼算「空」：明確、而且不誤傷
 *
 * 全部成立才算：
 *
 * 1. `response_metadata.finish_reason` **明確是 `stop`**。沒有這一格的（假模型、`length`、`tool_calls`、合成的
 *    中止收尾）一律不碰——**判準是供應商說「我講完了」，不是「我沒看到東西」**。`@langchain/core` 的
 *    `mapFinishReason`（`openai_completions_stream.js:261-268`）會把不認得的 `finish_reason` 先對映成 `stop`，但陌生的字串在
 *    `fetch` 層就被 `apps/harness/src/live-model.ts` 的 `withStreamCompletionCheck` 當成失敗（`UnknownFinishReasonError`，#1538），
 *    走不到這裡；沒有 `finish_reason` 的串流同樣在那一層算斷線（`TRANSPORT`）。CLI 的非串流那條拿到的是原字串。
 * 2. 沒有任何文字（空字串、或陣列裡沒有非空的文字區塊）。**只有空白的文字算有內容**（dsh 同：它數的是區塊）。
 * 3. 沒有工具呼叫（`tool_calls`、`invalid_tool_calls`、`additional_kwargs.tool_calls`、content 裡的呼叫區塊）。
 * 4. 沒有推理（`additional_kwargs.reasoning_content` 或 content 裡的 reasoning／thinking 區塊）。
 *
 * **只有推理、沒有答案的回覆不重打**（Q3 (a)，#1437 卡）：第一步量測 316 次呼叫裡 0 次，所以這一版只處理完全空的那一種；
 * 它留在「靜靜結束」，記在 PR 與卡上。
 *
 * ## 不歸這一顆管的
 *
 * 不在圖裡的呼叫（標題、摘要器、eval）直接走 `retryModelCall`，沒有經過這一格，**不產生** `EMPTY_RESPONSE`：它們沒有「這一步
 * 沒有答案就失敗」的語意，空的標題就是空的標題。
 *
 * @module
 */

import { AIMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { noteStreamFailure } from './stream-retry.js';
import { isSyntheticStopReply, modelCallAborted } from './turn-cancel.js';

/** 這顆 middleware 的名字。排序斷言用得到。 */
export const EMPTY_RESPONSE_MIDDLEWARE_NAME = 'nexusEmptyResponse';

/** 空回覆的失敗碼，與 dsh 的 `EMPTY_RESPONSE` 同名。 */
export const EMPTY_RESPONSE_CODE = 'EMPTY_RESPONSE';

/**
 * 一次回覆「停了但什麼都沒有」。**名字是 {@link EmptyResponseError} 的 `name`**：失敗分類器認名字，不認類別，這樣它
 * 不必 import 這個套件的內部。
 */
export class EmptyResponseError extends Error {
  override readonly name = 'EmptyResponseError';
  readonly code = EMPTY_RESPONSE_CODE;

  constructor() {
    super('模型回覆是空的：它說停了（stop），卻沒有任何文字、推理或工具呼叫。');
  }
}

/** content 區塊裡屬於推理的那幾種。 */
const REASONING_BLOCK_TYPES: ReadonlySet<string> = new Set(['reasoning', 'thinking']);
/** content 區塊裡屬於工具呼叫的那幾種（同 `max-tokens.ts`）。 */
const TOOL_CALL_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'tool_call',
  'tool_call_chunk',
  'invalid_tool_call',
]);

/** 這個 content 區塊是不是「有東西」：非空的文字、推理、工具呼叫，或任何不認得的非文字區塊（圖、檔案…）。 */
function blockCarriesContent(block: unknown): boolean {
  if (typeof block === 'string') return block !== '';
  if (typeof block !== 'object' || block === null) return false;
  const { type, text } = block as { type?: unknown; text?: unknown };
  if (type === 'text' || type === undefined) return typeof text === 'string' && text !== '';
  if (typeof type === 'string' && REASONING_BLOCK_TYPES.has(type)) return true;
  if (typeof type === 'string' && TOOL_CALL_BLOCK_TYPES.has(type)) return true;
  // 不認得的非文字區塊：保守當成有內容——寧可漏判（維持今天的行為），不要把有東西的回覆當成空的重打。
  return true;
}

/**
 * 這則回覆是不是「stop 但什麼都沒有」。
 *
 * @param message - 模型呼叫回來的那則。
 * @returns 全部條件成立（見檔頭）才是真。
 */
export function isEmptyStopReply(message: AIMessage): boolean {
  const finish = (message.response_metadata as { finish_reason?: unknown } | undefined)
    ?.finish_reason;
  if (finish !== 'stop') return false;
  if ((message.tool_calls ?? []).length > 0) return false;
  if ((message.invalid_tool_calls ?? []).length > 0) return false;
  const kwargs = message.additional_kwargs as Record<string, unknown>;
  const replayed = kwargs['tool_calls'];
  if (Array.isArray(replayed) ? replayed.length > 0 : replayed !== undefined && replayed !== null) {
    return false;
  }
  const reasoning = kwargs['reasoning_content'];
  if (typeof reasoning === 'string' && reasoning !== '') return false;
  const content: unknown = message.content;
  if (typeof content === 'string') return content === '';
  if (Array.isArray(content)) return !content.some(blockCarriesContent);
  return content === null || content === undefined;
}

/**
 * 造這顆 middleware。無狀態，一份實例走遍 root 與每個子代理。
 *
 * @returns 要排在起訖紀錄器內側、用量記錄器外側的 middleware。
 */
export function createEmptyResponseMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: EMPTY_RESPONSE_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      // **這裡不標「模型呼叫的失敗」**（#1778）：這一層在 plugin 的 `wrapModelCall` 外面，`catch` 收到的包含插件自己拋的錯。
      // 記號由最內層那一顆打，見 {@link ./model-call-failure.ts}。
      const response = await handler(request);
      if (
        !AIMessage.isInstance(response) ||
        isSyntheticStopReply(response) ||
        // 這一輪已經被中止：不管回來的是什麼都不是「模型給了空回覆」。
        modelCallAborted(request) ||
        !isEmptyStopReply(response)
      ) {
        return response;
      }
      // 回報給重試那一層（碼在 `retryableCodes` 裡才重打）；範圍外（沒有包重試的呼叫）是空操作，照樣拋——
      // 空回覆就是一次失敗，不論有沒有人替它重打。
      noteStreamFailure({ code: EMPTY_RESPONSE_CODE });
      throw new EmptyResponseError();
    },
  }) as unknown as AgentMiddleware;
}
