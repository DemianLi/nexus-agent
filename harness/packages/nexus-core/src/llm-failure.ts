/**
 * 一次模型失敗的紀錄怎麼組：欄位驗證、凍結，以及拋出來的怪值怎麼變成一句話
 * （[#1557](https://github.com/DemianLi/nexus-agent/issues/1557)）。
 *
 * 照 dsh 的 `LlmError` 建構期驗證（`packages/llm/llm/src/index.ts:80-131`，`687f282e`）與 `thrownMessage`
 * （`packages/llm/llm/src/adapter-failure.ts:30-38`）。這一層跑在 `catch` 裡——記失敗的那一步自己不能拋，否則
 * `turn/failed` 沒寫成、原本的錯誤也被換掉。
 *
 * ## 與 dsh 的偏離（理由 1：基座表達不出來）
 *
 * dsh 的 `LlmError` 在欄位不合格時**拋錯**，因為它的呼叫端是 adapter 內部、拋了有人接。這裡的呼叫端是 `catch` 區塊，
 * 沒有人接，所以壞值是**丟掉那一格**，不拋：`message` 空的退回固定字、`code` 不是非空字串退回 `UNKNOWN`、
 * `status` 不是 100–599 的整數就不帶、`requestId` 空的就不帶。dsh 的 `normalizeLlmFailure` 對不合格的快照同樣是「不採用」，
 * 不拋（`adapter-failure.ts:19-23`）。
 *
 * 沒有搬的：`providerRetryAfterMs`（`turn/failed` 上沒有消費者，重試那一層另有通道，`retryAfterMsOf`）、`offloadImages`
 * （我們走 `IMAGE_OFFLOAD_REQUIRED` 碼，`image-offload.ts`）、`LlmError` 類別本身與跨套件重建（我們沒有東西靠類別路由）。
 *
 * @module
 */

import type { LlmFailure } from './session-log.js';

/** 拋出來的東西轉不成字、或轉出來是空字串時的固定字（dsh `adapter-failure.ts:30-38` 同字）。 */
export const LLM_FAILURE_FALLBACK_MESSAGE = 'LLM adapter failed';

/** 碼不合格時的退路；詞彙同 `classifyTurnFailure` 認不出來的那一格。 */
const UNKNOWN_CODE = 'UNKNOWN';

/**
 * 把任何被拋出的值轉成一句話，而且**不會拋**。
 *
 * `Error` 取 `message`，其餘 `String()`；`toString` 或 `message` 的存取子拋錯、或結果是空字串，一律退回
 * {@link LLM_FAILURE_FALLBACK_MESSAGE}。
 *
 * @param value - catch 到的值（`unknown`）。
 * @returns 非空的一行字。
 */
export function thrownMessage(value: unknown): string {
  try {
    const message = value instanceof Error ? value.message : String(value);
    return typeof message === 'string' && message.length > 0
      ? message
      : LLM_FAILURE_FALLBACK_MESSAGE;
  } catch {
    return LLM_FAILURE_FALLBACK_MESSAGE;
  }
}

/** {@link llmFailure} 收的欄位；全部當作不可信（呼叫端可能拿著 `any`、`NaN`、空字串）。 */
export interface LlmFailureFields {
  readonly message: unknown;
  readonly code: unknown;
  readonly status?: unknown;
  readonly requestId?: unknown;
}

/**
 * 組一份驗證過、凍結的 {@link LlmFailure}。壞值丟掉那一格，不拋（理由見檔頭）。
 *
 * @param fields - 訊息、碼、狀態、供應商請求編號。
 * @returns 凍結的失敗描述；`status`／`requestId` 只有合格才帶。
 */
export function llmFailure(fields: LlmFailureFields): LlmFailure {
  const { message, code, status, requestId } = fields;
  return Object.freeze({
    message:
      typeof message === 'string' && message.length > 0 ? message : LLM_FAILURE_FALLBACK_MESSAGE,
    code: typeof code === 'string' && code.length > 0 ? code : UNKNOWN_CODE,
    ...(typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599 && { status }),
    ...(typeof requestId === 'string' && requestId.length > 0 && { requestId }),
  });
}
