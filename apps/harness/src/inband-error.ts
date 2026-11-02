/**
 * 串流內錯誤信封（`{ "error": { type, code, message } }`）→ 失敗碼與載體狀態（[#1805](https://github.com/DemianLi/nexus-agent/issues/1805)）。
 *
 * 照 dsh 的 `providerError`（`packages/llm/llm-deepseek/src/transport.ts:22-35`，`687f282e`）的梯子：每一階都是
 * 「狀態條件**或**欄位／字樣條件」，順序是 `AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`，
 * 都對不上才看有沒有狀態（有：`HTTP_<狀態>`；沒有：`SERVER`）。dsh 的串流內信封不帶狀態
 * （`packages/llm/llm-deepseek/src/sse.ts:25`：`providerError(event, undefined)`），所以它只看 `error.type`、字串型的
 * `error.code` 與訊息。
 *
 * ## 與 dsh 的偏離（理由 1）
 *
 * **數字碼那一階是我們加的**：信封的數字 `code`／`status`（400–599）當成 dsh 的 `status` 餵進同一條梯子。理由：基座
 * （OpenAI SDK／LangChain 的重試與分類）整條路只看 HTTP 狀態，第一則事件就是信封的端點（#516）必須翻成帶狀態的 HTTP 回應
 * 基座才認得出來，所以信封裡的數字要當成狀態。數字碼與 `type`／字樣**同時**出現時，沒有誰蓋掉誰：每一階是「或」，
 * 先到的階贏——`{ code: 503, type: 'authentication_error' }` 是 `AUTH`（dsh 對 `status = 503` 加同樣的 `type` 也是 `AUTH`，
 * 因為 `AUTH` 在 `SERVER` 前面）。
 *
 * **載體狀態**：梯子的結果還要翻回一個 HTTP 狀態（第一則事件合成的 Response 要帶、`turn/failed.status` 要寫），讓
 * `failureCodeOfStatus` 回到同一個碼。`AUTH`（401／403）、`INVALID_REQUEST`（400／413）、`SERVER`（≥ 500）、`HTTP_<狀態>` 沿用信封自己的數字碼，沒有就補該階的代表狀態（401／400／500；`permission_error` 是 403）；`QUOTA` 一律 402（信封說 429 也是——否則合成的 429 回應會被讀成 `RATE_LIMIT`），`RATE_LIMIT` 一律 429。
 * `CONTEXT_WINDOW_EXCEEDED` 沒有對應的狀態（400 與 413 在表裡是 `INVALID_REQUEST`），只能靠 {@link InbandFailure.overflow} 旗標，
 * 旗標只有串流中段（`classifyTurnFailure` 的 `isInbandApiError` 那一格）要用；第一則事件之後的監看（`createInbandWatcher`）直接取
 * {@link InbandFailure.code}。第一則事件就是信封的那一條不靠旗標：合成的 400 回應交給 `@langchain/openai` 的轉接器，它自己認得超窗的 400，
 * 實測（`model-failure-classification.test.ts` 的 `typedRows`）也是 `CONTEXT_WINDOW_EXCEEDED`。
 *
 * **字樣偵測**：下面兩支照搬 dsh `isContextWindowExceededError`／`isQuotaExceededError`。#1805 只套在信封上；#1557 起
 * `classifyTurnFailure` 也把它套到模型呼叫錯誤鏈上每一環的 `type`、`code`、`message`（dsh 的 deepseek adapter 與 pi-ai 兩條路都這樣做）。
 */

/** 逐字照 dsh：`packages/llm/llm/src/error.ts:53-58`（`687f282e`）。 */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(
  String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` +
    String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`,
  'i',
);

/** 逐字照 dsh：`error.ts:61-65`。 */
const TOO_LARGE_FOR_CONTEXT = new RegExp(
  String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` +
    String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` +
    String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`,
  'i',
);

/** 逐字照 dsh：`error.ts:68-73`。 */
const EXCEEDS_MODEL_CONTEXT = new RegExp(
  String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` +
    String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` +
    String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`,
  'i',
);

/** 照搬 dsh `isContextWindowExceededError`（`error.ts:83-89`）：請求超出模型上下文窗口的字樣。 */
export function isContextWindowExceededDetail(detail: string): boolean {
  return (
    STRUCTURED_CONTEXT_OVERFLOW.test(detail) ||
    /\b(?:maximum|max)(?:\s+(?:allowed|supported))?\s+context\s+(?:length|window)\b/i.test(
      detail,
    ) ||
    TOO_LARGE_FOR_CONTEXT.test(detail) ||
    /\b(?:input|prompt|request)\s+(?:is\s+)?too\s+(?:long|large)\s+for\s+(?:this|the)\s+model\b/i.test(
      detail,
    ) ||
    EXCEEDS_MODEL_CONTEXT.test(detail)
  );
}

/** 照搬 dsh `isQuotaExceededError`（`error.ts:97-103`）：帳號額度耗盡（不是限流）的字樣。 */
export function isQuotaExceededDetail(detail: string): boolean {
  return (
    /\binsufficient[\s_-]+(?:quota|balance|credits?)\b/i.test(detail) ||
    /\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b/i.test(detail) ||
    /\bexceed(?:ed|s)?[\s_-]+(?:(?:your|the)[\s_-]+)?(?:current[\s_-]+)?quota\b/i.test(detail) ||
    /\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b/i.test(detail) ||
    /\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i.test(detail)
  );
}

/** 一則串流內錯誤信封的分類結果。 */
export interface InbandFailure {
  /** 失敗碼，詞彙同 `LlmFailure.code`（`AUTH`、`QUOTA`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED`、`INVALID_REQUEST`、`SERVER`、`HTTP_<狀態>`）。 */
  readonly code: string;
  /** 載體狀態：第一則事件合成的 Response 帶它、`turn/failed.status` 寫它；`failureCodeOfStatus(status)` 與 {@link code} 同碼（`CONTEXT_WINDOW_EXCEEDED` 例外，見檔頭）。 */
  readonly status: number;
  /** 上下文超窗：`classifyTurnFailure` 的 `overflow` 旗標（沒有對應的狀態）。 */
  readonly overflow: boolean;
}

/** 信封裡的數字碼（400–599 才算）：`code` 先、`status` 後；不是就 `undefined`。 */
function numericStatusOf(error: Record<string, unknown>): number | undefined {
  for (const candidate of [error.code, error.status]) {
    if (
      typeof candidate === 'number' &&
      Number.isInteger(candidate) &&
      candidate >= 400 &&
      candidate <= 599
    ) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * 把信封裡的那個 `error` 物件（SDK 的 `APIError.error` 就是它）分類。梯子與詞彙見檔頭。
 *
 * @param error - 信封的 `error` 物件；不是物件就當空的（`SERVER`／500）。
 */
export function classifyInbandError(error: Record<string, unknown> | undefined): InbandFailure {
  const fields = error ?? {};
  const status = numericStatusOf(fields);
  const type = typeof fields.type === 'string' ? fields.type : '';
  // 照 dsh：`${type} ${code（字串才算）} ${message}`。
  const detail = `${type} ${typeof fields.code === 'string' ? fields.code : ''} ${typeof fields.message === 'string' ? fields.message : ''}`;

  if (
    status === 401 ||
    status === 403 ||
    type === 'authentication_error' ||
    type === 'permission_error'
  ) {
    return {
      code: 'AUTH',
      status: status === 401 || status === 403 ? status : type === 'permission_error' ? 403 : 401,
      overflow: false,
    };
  }
  if (isQuotaExceededDetail(detail) || status === 402) {
    return { code: 'QUOTA', status: 402, overflow: false };
  }
  if (status === 429 || type === 'rate_limit_error') {
    return { code: 'RATE_LIMIT', status: 429, overflow: false };
  }
  const invalidStatus = status === 400 || status === 413 ? status : 400;
  if (isContextWindowExceededDetail(detail)) {
    return { code: 'CONTEXT_WINDOW_EXCEEDED', status: invalidStatus, overflow: true };
  }
  if (status === 400 || status === 413 || type === 'invalid_request_error') {
    return { code: 'INVALID_REQUEST', status: invalidStatus, overflow: false };
  }
  if (
    (status !== undefined && status >= 500) ||
    type === 'api_error' ||
    type === 'overloaded_error'
  ) {
    const serverStatus = status !== undefined && status >= 500 ? status : 500;
    return { code: 'SERVER', status: serverStatus, overflow: false };
  }
  // 有數字碼但不在上面任何一階（404、408、410、422…）：`HTTP_<狀態>`；完全沒有狀態：`SERVER`（照 dsh，載體 500）。
  return status === undefined
    ? { code: 'SERVER', status: 500, overflow: false }
    : { code: `HTTP_${String(status)}`, status, overflow: false };
}
