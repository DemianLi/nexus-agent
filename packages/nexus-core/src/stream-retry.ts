/**
 * 模型請求失敗的整次重打：**首事件之前與之後共用同一份預算**
 * （[#520](https://github.com/DemianLi/nexus-agent/issues/520)、[#1427](https://github.com/DemianLi/nexus-agent/issues/1427)）。
 *
 * ## 管什麼、不管什麼
 *
 * 管所有「adapter 明著回報過」的可重試失敗（{@link noteStreamFailure}），不分第一則 SSE 事件之前或之後：
 *
 * - **第一則事件之前**：HTTP 錯誤（含沒有 `retry-after` 的 429）、連線失敗、到第一則事件的逾時。#1427 之前這一段歸 SDK 層
 *   （`AsyncCaller`，6 次、退避寫死 1／2／4／8／16／32 秒、日誌少報）；現在 SDK 層 `maxRetries` 是 0，由這一顆重打。
 * - **第一則事件之後**：吐了內容後中段出錯（in-band 的錯誤事件）、串流中途斷掉、吐了內容後停住（閒置逾時）。
 * - **整次回應之後**：模型說停了（stop）卻什麼都沒有的空回覆（`EMPTY_RESPONSE`，{@link ./empty-response.ts}，#1437）——
 *   它由圖裡的一顆 middleware 回報並拋，走同一份預算。
 *
 * **重打只看回報的碼**（#1437）：碼在 {@link StreamRetryOptions.retryableCodes} 裡才重打。回報的人只說「這是哪一種失敗」，
 * 不替政策下判斷。
 *
 * 沒有回報的失敗一律原樣往外拋。重試只此一層，所以預算不會相乘（#1341 的 G4：舊制下首事件前連續 503 打到端點 9 次、
 * 日誌只有 2 顆 `llm/retry`）。
 *
 * **不在模型呼叫圖裡的呼叫**（標題、摘要器生摘要的那一次、eval 的探測）沒有 middleware 可掛，改呼叫 {@link retryModelCall}：
 * 同一個迴圈、同一份政策，只是沒有日誌與通知。
 *
 * ## 為什麼用回報、不用在錯誤物件上貼標記
 *
 * 三類失敗拋出來的東西長得完全不同：in-band 的錯誤是 SDK 解析 SSE 時自己拋的 `APIError`（`status` 是 `undefined`），斷線是
 * undici 的 `TypeError: terminated`，停住是我們自己的 `StreamIdleTimeoutError`。前一類的錯誤物件不經過我們的任何一層，貼不上
 * 標記；改它的類別又會動到今天所有「不重試」那條路的失敗分類。所以由 fetch 那一層在**看到失敗的當下**回報進這一次嘗試的範圍
 * （用 `AsyncLocalStorage` 帶，範圍外的回報是空操作），這一顆在 catch 到錯誤時讀它。錯誤本身原樣往外拋。
 * （#1437：回報的碼與 `turn/failed` 記的碼出自同一支分類器；讀端斷線那一類在錯誤物件上另有一個 `WeakSet` 記號，不改它的形狀。）
 *
 * ## 位置：記錄器外面
 *
 * 排在 `modelCalls` 與用量記錄器的**外側**（見 `fold.ts`）。每一次嘗試因此各是一對 `model/start`／`model/end`，失敗那次帶
 * `outcome: 'error'`、用量照記——「哪一次作廢了」在日誌上就有現成的識別，不需要新事件。內側（plugin）的做法會讓失敗那次沒有任何
 * 痕跡。
 *
 * ## 照 dsh 與偏離
 *
 * dsh 的 `TIMEOUT`、`TRANSPORT` 都在預設可重試碼裡（`packages/llm/llm/src/retry-policy.ts:18-24`），由步級掛點重試整次請求；
 * 第一級載體 `assistant/attempt` 表示「那一次作廢」（`core/agent-loop/src/agent.ts:466-476`、`:489-493`；以上皆 `5badb15009a`）。
 * 這裡同向：整次重打、失敗那次作廢。
 *
 * ## 失敗當下就通知 pump（擦除、`llm/retry`、倒數）
 *
 * 決定重試的那一刻，middleware 做三件事：①日誌寫 `llm/retry`（帶 `delayMs`），②用 `config.writer` 送一顆
 * {@link StreamRetrySignal} 給 pump，③才開始退避；退避完、重打之前寫 `llm/retry-started` 並再送一顆。pump 收到第一顆就把
 * 還沒收尾的 root 回覆作廢（`assistant/attempt` ＋ `message-discard`）並送 `llm-retry` frame，同 dsh 在失敗當下記
 * `assistant/attempt`（`core/agent-loop/src/agent.ts:466-476`、`:489-493`，`5badb15009a`）。
 *
 * **載體是 `config.writer`，不是 `dispatchCustomEvent`**。後者走 callback 的 `handleCustomEvent`，langgraph 1.4.19 裡沒有任何
 * handler 把它轉成串流 chunk（只有 `pregel/timeout.js:77` 碰它），在 v3 `streamEvents` 上浮不出來（實測 0 次）；`writer`
 * （`pregel/index.js:1086-1094`）則直接 `stream.push`。
 *
 * **順序有保證**（`@langchain/core` 1.2.9、`@langchain/langgraph` 1.4.19）：字片段與 `writer` 的 chunk 落在**同一條**輸出佇列。
 * 字片段：`chat_models.js:243` 對每個串流事件先 `await runManager.handleChatModelStreamEvent`、再 yield；
 * `callbacks/manager.js:179-188` 用 `consumeCallback` 跑 handler，`singletons/callbacks.js` 在 `wait === true` 時當場 await，
 * 而 `messages-v2.js:85` 的 `awaitHandlers = true`；`messages-v2.js:104-113` 的 `emit` 落到 `pregel/index.js:1065` 的 `stream.push`。
 * `writer` 同樣落到 `stream.push`（`index.js:1086-1094`），`stream.js:74-77` 同步 `enqueue`。消費側是單一 for-await
 * （`index.js:1169`）接 `stream/mux.js:302-321` 的 `pump`，依序蓋 `seq`、推進 mux，`run` 的迭代器就是依到達順序讀它
 * （`stream/run-stream.js:106`）。失敗那次的最後一個字片段在模型呼叫拋錯之前就入列了，middleware 的 catch 在那之後才推
 * `writer`，所以 pump 讀到通知時，失敗那次的片段一個都不會再來。這條不是從版本號推的：`apps/harness/src/stream-retry.test.ts`
 * 有常駐的順序測試（密集片段加慢消費者），升級 langgraph 改了順序它會紅；探針 200 次（密集 300 片段、慢消費者、中段 503 與
 * 斷線）零亂序。
 *
 * 這取代了第一版的做法（等下一次嘗試的第一則 `message-start` 到來才擦，畫面在退避期間凍著半截字，也沒有地方放倒數）。
 *
 * - **政策照 dsh**（`retry-policy.ts:14-24`）：倍增、單次封頂（`maxDelayMs`）、抖動，**抖動之後再夾到 `maxDelayMs`**
 *   （`llm-retry/src/index.ts` 的 `localDelay`）。數值與欄位見 `apps/harness/src/settings/live-model.ts` 的 `retryPolicy`：
 *   出廠 6 次、500 毫秒起、封頂 10 秒、抖動 0.1（#1427，demian 2026-10-14 拍板；dsh 預設 5 次，6 是它開放的設定值）。
 * - **`retry-after`**（照 dsh 的 `recover`）：供應商給的延遲不超過 `maxDelayMs` 就照它等（不加抖動）；超過就放棄、原錯誤往外拋。
 * - **退避聽中止訊號**：等待中按停止就立刻收，不再打一次。
 *
 * ## 偏離：重試掛在 `wrapModelCall`，不是 `agent/request-error`
 *
 * dsh 的重試聽 `agent/request-error`（步級掛點）。LangChain 沒有這個掛點（S2 地圖 #1339 才會補三事件），所以退到 #1341 指出的
 * 同一個位置：模型呼叫的 `wrapModelCall`。S2 落地之後撤除。重試計數只活在一次模型呼叫裡，不像 dsh 從事件折出、跨重啟接著數。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfig } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { llmFailure, thrownMessage } from './llm-failure.js';
import { captureModelCallSettled, withModelCall } from './model-call-scope.js';
import type { CapturedModelCall } from './model-call-scope.js';
import type { SessionLookup } from './registry.js';
import type { LlmFailure, SessionLog } from './session-log.js';
import { turnCancelSignalOf } from './turn-cancel.js';

/** middleware 的名字。 */
export const STREAM_RETRY_MIDDLEWARE_NAME = 'nexusStreamRetry';

/** 一次串流失敗，由 adapter（fetch 那一層）在看到的當下回報。 */
export interface StreamFailure {
  /**
   * 失敗的種類，照 dsh 的碼：`TIMEOUT`（停住）、`TRANSPORT`（斷線）、`EMPTY_RESPONSE`、`RATE_LIMIT`、`SERVER`，
   * 其餘取 HTTP 狀態（`HTTP_<n>`）或供應商碼。**重打與否只看它**（#1437）：碼在 {@link StreamRetryOptions.retryableCodes}
   * 裡才重打，同 dsh 的 `retryableCodes`——沒有另一個「這次有沒有用」的旗標。
   */
  readonly code: string;
  /** 供應商給的 HTTP 狀態（串流內的錯誤信封帶得出來時）。寫進 `llm/retry` 的 `failure.status`。 */
  readonly status?: number;
  /**
   * 供應商要求的等待（毫秒，來自 `retry-after`）。沒給就用本機的退避；不超過 `maxDelayMs` 就照它等，超過就放棄
   * （照 dsh 的 normal 模式）。
   */
  readonly retryAfterMs?: number;
  /** 供應商的請求編號（回應標頭，非空字串才帶）。寫進 `llm/retry` 的 `failure.requestId`（#1536）。 */
  readonly requestId?: string;
}

/** 圖裡 `config.writer` 送出的通知的記號。pump 認它，其餘的 `custom` 一律不上線。 */
export const STREAM_RETRY_SIGNAL = 'nexus/stream-retry';

/**
 * middleware 在決定重試與重打開始時送給 pump 的通知（走 `config.writer`，順序理由見檔頭）。
 *
 * - `scheduled`：這一次失敗了、排定了重試，還沒開始等。pump 據此作廢 root 還沒收尾的回覆、送 `llm-retry`。
 * - `started`：退避等完、下一次嘗試就要開始。
 */
export type StreamRetrySignal =
  | {
      readonly kind: typeof STREAM_RETRY_SIGNAL;
      readonly phase: 'scheduled';
      readonly retryId: string;
      /** 第幾次重試，從 1 起算。 */
      readonly retry: number;
      readonly maxRetries: number;
      readonly delayMs: number;
      /** 失敗的種類（同 `llm/retry.failure.code`）。 */
      readonly code: string;
      /** 失敗的那次呼叫的 `model/start` 的 `seq`；日誌沒接上就沒有。 */
      readonly modelCall?: number;
    }
  | {
      readonly kind: typeof STREAM_RETRY_SIGNAL;
      readonly phase: 'started';
      readonly retryId: string;
      readonly retry: number;
      readonly modelCall?: number;
    };

/** 把 `config.writer` 送出的東西認回 {@link StreamRetrySignal}；不是（或形狀不對）就是 `undefined`。 */
export function streamRetrySignalOf(payload: unknown): StreamRetrySignal | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = payload as Record<string, unknown>;
  if (value['kind'] !== STREAM_RETRY_SIGNAL) return undefined;
  const { retryId, retry, modelCall } = value;
  if (typeof retryId !== 'string' || retryId === '' || typeof retry !== 'number') return undefined;
  if (modelCall !== undefined && typeof modelCall !== 'number') return undefined;
  const call = modelCall === undefined ? {} : { modelCall };
  if (value['phase'] === 'started') {
    return { kind: STREAM_RETRY_SIGNAL, phase: 'started', retryId, retry, ...call };
  }
  const { maxRetries, delayMs, code } = value;
  if (value['phase'] !== 'scheduled') return undefined;
  if (typeof maxRetries !== 'number' || typeof delayMs !== 'number' || typeof code !== 'string') {
    return undefined;
  }
  return {
    kind: STREAM_RETRY_SIGNAL,
    phase: 'scheduled',
    retryId,
    retry,
    maxRetries,
    delayMs,
    code,
    ...call,
  };
}

/** dsh 的預設退避上限（`retry-policy.ts:16`）：單次等待最多 10 秒。 */
export const DEFAULT_STREAM_RETRY_MAX_DELAY_MS = 10_000;
/** dsh 的預設抖動（`retry-policy.ts:17`）：每次等待乘上 1 ± 0.1 的隨機倍數。 */
export const DEFAULT_STREAM_RETRY_JITTER_RATIO = 0.1;

/**
 * dsh 的預設可重試碼（`retry-policy.ts:18-24`）：空回覆、限流、伺服器、逾時、斷線。**五個都有生產者**（#1437）：
 * `RATE_LIMIT`／`SERVER`／`TIMEOUT`／`TRANSPORT` 由 `@nexus/harness` 的 live-model 那支分類器產生（429、5xx 與 HTTP 之前的
 * 串流內信封、逾時、斷線），`EMPTY_RESPONSE` 由 {@link createEmptyResponseMiddleware} 在「stop 但什麼都沒有」時產生。
 * 其餘的碼（`AUTH`、`QUOTA`、`INVALID_REQUEST`、`HTTP_<n>`、`UNKNOWN`…）不在這裡，所以不重打。
 */
export const DEFAULT_STREAM_RETRYABLE_CODES: readonly string[] = Object.freeze([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
]);

/** 重試政策。退避的形狀照 dsh：指數倍增、有上限、對稱抖動（`packages/llm/llm/src/retry-policy.ts:14-17`，`d7432673`）。 */
export interface StreamRetryOptions {
  /** 最多重打幾次（不含第一次）。0 就是不重試。 */
  readonly maxRetries: number;
  /** 第一次重打前等多久（毫秒）；之後每次加倍。 */
  readonly initialDelayMs: number;
  /** 單次等待的上限（毫秒），也是 `retry-after` 肯等的上限。省略取 {@link DEFAULT_STREAM_RETRY_MAX_DELAY_MS}。 */
  readonly maxDelayMs?: number;
  /** 抖動比例，0–1：每次等待乘上 `1 ± jitterRatio` 內的隨機倍數。省略取 {@link DEFAULT_STREAM_RETRY_JITTER_RATIO}。 */
  readonly jitterRatio?: number;
  /**
   * 哪些失敗碼才重打（照 dsh 的 `retryableCodes`）。失敗的碼不在清單裡就當不可重試、原錯誤往外拋。
   * 省略取 {@link DEFAULT_STREAM_RETRYABLE_CODES}。
   */
  readonly retryableCodes?: readonly string[];
  /** 抖動用的亂數來源（`[0, 1)`）。省略取 `Math.random`；測試用它定住結果。 */
  readonly random?: () => number;
}

/**
 * 第 `attempt` 次重打（從 0 起算）之前要等多久：`initial × 2^attempt` 封頂在 `maxDelayMs`，乘上抖動倍數，**再夾到
 * `maxDelayMs`**（照 dsh 的 `localDelay`：抖動不能把單次等待推過上限）。
 *
 * @param options - 政策。
 * @param attempt - 已經失敗了幾次減一（第一次重打前是 0）。
 * @returns 毫秒。
 */
export function streamRetryDelayMs(options: StreamRetryOptions, attempt: number): number {
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_STREAM_RETRY_MAX_DELAY_MS;
  const jitter = options.jitterRatio ?? DEFAULT_STREAM_RETRY_JITTER_RATIO;
  const random = options.random ?? Math.random;
  const local = Math.min(options.initialDelayMs * 2 ** attempt, maxDelayMs);
  const jittered = Math.round(local * (1 + (random() * 2 - 1) * jitter));
  return Math.min(Math.max(0, jittered), maxDelayMs);
}

interface AttemptScope {
  failure: StreamFailure | undefined;
}

const scopes = new AsyncLocalStorage<AttemptScope>();

/**
 * 在一次嘗試外開一個範圍，嘗試結束就讀它。
 *
 * @param call - 這一次嘗試。
 * @returns 嘗試的結果，加上期間回報過的失敗（沒有就是 `undefined`）。
 */
async function runInAttempt<T>(call: () => Promise<T>): Promise<{
  readonly scope: AttemptScope;
  readonly outcome: PromiseSettledResult<T>;
  readonly captured: CapturedModelCall;
}> {
  const scope: AttemptScope = { failure: undefined };
  const { outcome, call: captured } = await scopes.run(scope, () => captureModelCallSettled(call));
  return { scope, outcome, captured };
}

/**
 * 取得「回報這一次嘗試的串流失敗」的函式，**綁在呼叫當下的範圍上**。
 *
 * fetch 那一層要在**回應的串流被讀的時候**才看得到失敗，而那已經是 `fetch` 回傳之後的事；`ReadableStream` 的 `pull`
 * 是在誰的非同步脈絡裡被喚起的，要看是哪一次讀觸發的。所以在 `fetch` 被呼叫的當下就把範圍抓起來，之後不論從哪裡回報都
 * 落在這一次嘗試上。範圍外（沒有開範圍的呼叫，例如不經 `retryModelCall` 直接打模型的路徑）拿到的是空操作；標題與 eval 現在也經 `retryModelCall`，各自開範圍。
 *
 * 同一次嘗試回報多次時**以第一次為準**：同一條串流只死一次，後面的是連帶的（例如斷線之後讀端再拋）。
 *
 * @returns 回報函式；參數是失敗的種類與重打有沒有用。
 */
export function streamFailureReporter(): (failure: StreamFailure) => void {
  const scope = scopes.getStore();
  return (failure) => {
    if (scope === undefined || scope.failure !== undefined) return;
    scope.failure = failure;
  };
}

/** 即時回報（等於 `streamFailureReporter()(failure)`）。 */
export function noteStreamFailure(failure: StreamFailure): void {
  streamFailureReporter()(failure);
}

/** 等 `ms` 毫秒；中止訊號舉起來就立刻回 `false`（不再打）。 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 送一顆通知給 pump（`config.writer`）。範圍外（沒有圖、沒開 `custom`）是空操作；送不出去不能扳倒重試。 */
function signal(payload: StreamRetrySignal): void {
  try {
    (getConfig() as { writer?: (chunk: unknown) => void } | undefined)?.writer?.(payload);
  } catch {
    // 通知是附帶的：沒有圖脈絡（單測、直接叫 handler）就算了。
  }
}

/**
 * 記一顆重試事件；**記不進去就不重打，這次呼叫失敗**（[#1702](https://github.com/DemianLi/nexus-agent/issues/1702)）。
 * 照 dsh `llm-retry/src/index.ts:188`、`:190`：兩顆都直接 `append`，沒有 catch，寫入錯從退避裡拋出去、這一輪失敗。
 * 這裡已經在失敗路徑上（那次嘗試的錯還沒交出去），所以兩個錯一起拋，原錯在前、也是 `cause`（同 `containment.ts` 的
 * `recordUnknownOutcome`、dsh `agent.ts:353`）：沿 `cause` 認錯誤種類的人看到的仍是原錯。
 */
function appendOrFail(write: () => void, original: unknown, type: string): void {
  try {
    write();
  } catch (appendError) {
    throw new AggregateError(
      [original, appendError],
      `模型呼叫失敗，${type} 也記不進去，不再重打`,
      { cause: original },
    );
  }
}

/** 失敗的穩定描述：碼與狀態是 adapter 回報的，原話取自拋出來的錯誤。 */
function failureOf(reported: StreamFailure, reason: unknown): LlmFailure {
  return llmFailure({
    message: thrownMessage(reason),
    code: reported.code,
    status: reported.status,
    requestId: reported.requestId,
  });
}

/** {@link retryModelCall} 的周邊：往哪裡記、通知誰、聽哪個中止訊號。全部可省略。 */
export interface RetryRunContext {
  /** 退避中舉起就立刻收、不再打。省略就是不聽。 */
  readonly signal?: AbortSignal;
  /**
   * 重試記進哪一份日誌（`llm/retry`、`llm/retry-started`）。**省略就不記**：標題那一顆不是這一輪對話的步，記進去會冒充成對話在
   * 重試（#712）；摘要器與 eval 同理沒有那一輪的日誌。
   */
  readonly log?: SessionLog;
  /** 每次排定重試與重打開始時的通知（middleware 傳 `config.writer`）。省略就不送。 */
  readonly notify?: (payload: StreamRetrySignal) => void;
}

/**
 * 依政策重打一次模型呼叫：成功就回，失敗而且 adapter 回報過可重試就退避、再打，直到預算用盡。
 *
 * **這是整個重試迴圈**；`createStreamRetryMiddleware` 只是替圖裡的模型呼叫把日誌、通知與中止訊號接上去。不在圖裡的呼叫
 * （標題、摘要器、eval）直接呼叫它，吃同一份政策（#1427：沒有任何一條路徑保留 SDK 層重試）。
 *
 * @param options - 政策。
 * @param context - 日誌、通知、中止訊號。
 * @param call - 一次嘗試。**每次重打都重新呼叫它**，所以它要能重入。
 * @returns 成功那一次的結果。
 * @throws 沒回報過可重試的失敗、預算用盡、`retry-after` 超過上限、退避中被中止：原本那個錯誤，原樣。
 */
export async function retryModelCall<T>(
  options: StreamRetryOptions,
  context: RetryRunContext,
  call: () => Promise<T>,
): Promise<T> {
  const { signal: signalAbort, log, notify } = context;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_STREAM_RETRY_MAX_DELAY_MS;
  const codes = options.retryableCodes ?? DEFAULT_STREAM_RETRYABLE_CODES;
  // 一次呼叫的所有重試共用一個，同 dsh 的 `retryId`。
  const retryId = randomUUID();
  for (let attempt = 0; ; attempt += 1) {
    const { scope, outcome, captured } = await runInAttempt(call);
    if (outcome.status === 'fulfilled') return outcome.value;
    const reported = scope.failure;
    // 碼決定重不重打（#1437）：adapter 只回報「是哪一種失敗」，不替政策下判斷。
    const retriable =
      reported !== undefined && codes.includes(reported.code) && attempt < options.maxRetries;
    if (reported === undefined || !retriable) throw outcome.reason;
    // 供應商要求的等待：不超過上限就照它等，超過就放棄（照 dsh 的 normal 模式，原錯誤往外拋）。
    const asked = reported.retryAfterMs;
    const hasAsked = asked !== undefined && Number.isFinite(asked) && asked > 0;
    if (hasAsked && asked > maxDelayMs) throw outcome.reason;
    const retry = attempt + 1;
    const delayMs = hasAsked ? asked : streamRetryDelayMs(options, attempt);
    // 失敗的是哪一次呼叫：起訖紀錄器在裡面，這裡只能從放的格子裡問（拋了也問得到）。
    const modelCall = log === undefined ? undefined : captured.of(log);
    const code = reported.code;
    if (log !== undefined) {
      appendOrFail(
        () =>
          log.append(
            'llm/retry',
            withModelCall(
              {
                retryId,
                retry,
                maxRetries: options.maxRetries,
                failure: failureOf(reported, outcome.reason),
                delayMs,
              },
              modelCall,
            ),
          ),
        outcome.reason,
        'llm/retry',
      );
    }
    const callField = modelCall === undefined ? {} : { modelCall };
    notify?.({
      kind: STREAM_RETRY_SIGNAL,
      phase: 'scheduled',
      retryId,
      retry,
      maxRetries: options.maxRetries,
      delayMs,
      code,
      ...callField,
    });
    // 退避：1 倍、2 倍、4 倍……；這一輪已經中止、或等待中按了停止，原本的錯誤照樣往外拋，不再打（`sleep` 兩種都認）。
    // 取消之後不寫 `llm/retry-started`。
    const waitStart = Date.now();
    const waited = await sleep(delayMs, signalAbort);
    if (!waited) throw outcome.reason;
    if (log !== undefined) {
      appendOrFail(
        () =>
          log.append(
            'llm/retry-started',
            withModelCall(
              { retryId, retry, waitedMs: Math.max(0, Date.now() - waitStart) },
              modelCall,
            ),
          ),
        outcome.reason,
        'llm/retry-started',
      );
    }
    notify?.({ kind: STREAM_RETRY_SIGNAL, phase: 'started', retryId, retry, ...callField });
  }
}

/**
 * 建那顆 middleware。無狀態：每次呼叫的嘗試計數與範圍都在呼叫自己的閉包裡。
 *
 * @param options - 政策。
 * @param sessions - 註冊表的 `sessions` 通道，用來問「這次呼叫該寫進哪一份日誌」。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createStreamRetryMiddleware(
  options: StreamRetryOptions,
  sessions: { forCall(config: unknown): SessionLookup },
): AgentMiddleware {
  return createMiddleware({
    name: STREAM_RETRY_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const configurable = (request as { runtime?: { configurable?: unknown } }).runtime
        ?.configurable;
      const signalAbort = turnCancelSignalOf({ configurable });
      const found = sessions.forCall({ configurable });
      const log: SessionLog | undefined = found.kind === 'ok' ? found.log : undefined;
      return retryModelCall(
        options,
        {
          ...(signalAbort !== undefined && { signal: signalAbort }),
          ...(log !== undefined && { log }),
          notify: signal,
        },
        () => Promise.resolve(handler(request)),
      );
    },
  }) as unknown as AgentMiddleware;
}
