/**
 * 串流**第一則事件之後**才出錯的模型呼叫，整次重打（[#520](https://github.com/DemianLi/nexus-agent/issues/520)）。
 *
 * ## 管什麼、不管什麼
 *
 * 管三類，全是「第一則 SSE 事件之後」的失敗：吐了內容後中段出錯（in-band 的錯誤事件）、串流中途斷掉、吐了內容後停住
 * （閒置逾時）。第一則事件**之前**的失敗 SDK 層已經重試過了（最多 6 次），這裡若也接就是乘法——所以這一顆**只認 adapter
 * 明著回報過的失敗**（{@link noteStreamFailure}），沒有回報的一律原樣往外拋。
 *
 * ## 為什麼用回報、不用在錯誤物件上貼標記
 *
 * 三類失敗拋出來的東西長得完全不同：in-band 的錯誤是 SDK 解析 SSE 時自己拋的 `APIError`（`status` 是 `undefined`），斷線是
 * undici 的 `TypeError: terminated`，停住是我們自己的 `StreamIdleTimeoutError`。前一類的錯誤物件不經過我們的任何一層，貼不上
 * 標記；改它的類別又會動到今天所有「不重試」那條路的失敗分類。所以由 fetch 那一層在**看到失敗的當下**回報進這一次嘗試的範圍
 * （同 {@link ./llm-retry.ts} 的 `noteFailedAttempt`：用 `AsyncLocalStorage` 帶，範圍外的回報是空操作），這一顆在 catch 到
 * 錯誤時讀它。錯誤本身原樣往外拋，失敗分類一個字不變。
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
 * - **次數與起點先保守**：預設最多 2 次、1 秒起（卡上 2026-10-06 拍板；dsh 預設 5 次、500 毫秒起，`retry-policy.ts:14-15`）。每次重試都重付
 *   整個回覆的費用，所以不照抄。**退避的形狀照 dsh**：倍增、單次封頂 10 秒、抖動 0.1（`:16-17`），欄位見
 *   `apps/harness/src/settings/live-model.ts`。
 * - **退避聽中止訊號**：等待中按停止就立刻收，不再打一次。
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfig } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { captureModelCallSettled, withModelCall } from './model-call-scope.js';
import type { CapturedModelCall } from './model-call-scope.js';
import type { SessionLookup } from './registry.js';
import type { LlmFailure, SessionLog } from './session-log.js';
import { turnCancelSignalOf } from './turn-cancel.js';

/** middleware 的名字。 */
export const STREAM_RETRY_MIDDLEWARE_NAME = 'nexusStreamRetry';

/** 一次串流失敗，由 adapter（fetch 那一層）在看到的當下回報。 */
export interface StreamFailure {
  /** 失敗的種類，照 dsh 的碼：`TIMEOUT`（停住）、`TRANSPORT`（斷線）、其餘取 HTTP 狀態或供應商碼。只給人讀。 */
  readonly code: string;
  /** 重打會不會有用。供應商說「請求本身有問題」（例如 400）的不重試。 */
  readonly retryable: boolean;
  /** 供應商給的 HTTP 狀態（串流內的錯誤信封帶得出來時）。寫進 `llm/retry` 的 `failure.status`。 */
  readonly status?: number;
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

/** dsh 的預設退避上限（`retry-policy.ts:16`）：本機排程的單次等待最多 10 秒。 */
export const DEFAULT_STREAM_RETRY_MAX_DELAY_MS = 10_000;
/** dsh 的預設抖動（`retry-policy.ts:17`）：每次等待乘上 1 ± 0.1 的隨機倍數。 */
export const DEFAULT_STREAM_RETRY_JITTER_RATIO = 0.1;

/** 重試預算。退避的形狀照 dsh：指數倍增、有上限、對稱抖動（`packages/llm/llm/src/retry-policy.ts:14-17`，`5badb15009a`）。 */
export interface StreamRetryOptions {
  /** 最多重打幾次（不含第一次）。0 就是不重試。 */
  readonly maxRetries: number;
  /** 第一次重打前等多久（毫秒）；之後每次加倍。 */
  readonly baseDelayMs: number;
  /** 單次等待的上限（毫秒）。省略取 {@link DEFAULT_STREAM_RETRY_MAX_DELAY_MS}。 */
  readonly maxDelayMs?: number;
  /** 抖動比例，0–1：每次等待乘上 `1 ± jitterRatio` 內的隨機倍數。省略取 {@link DEFAULT_STREAM_RETRY_JITTER_RATIO}。 */
  readonly jitterRatio?: number;
  /** 抖動用的亂數來源（`[0, 1)`）。省略取 `Math.random`；測試用它定住結果。 */
  readonly random?: () => number;
}

/**
 * 第 `attempt` 次重打（從 0 起算）之前要等多久：`base × 2^attempt` 封頂在 `maxDelayMs`，再乘上抖動倍數。
 *
 * @param options - 預算。
 * @param attempt - 已經失敗了幾次減一（第一次重打前是 0）。
 * @returns 毫秒。
 */
export function streamRetryDelayMs(options: StreamRetryOptions, attempt: number): number {
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_STREAM_RETRY_MAX_DELAY_MS;
  const jitter = options.jitterRatio ?? DEFAULT_STREAM_RETRY_JITTER_RATIO;
  const random = options.random ?? Math.random;
  const local = Math.min(options.baseDelayMs * 2 ** attempt, maxDelayMs);
  return Math.max(0, Math.round(local * (1 + (random() * 2 - 1) * jitter)));
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
 * 落在這一次嘗試上。範圍外（沒有這顆 middleware、標題那一顆、eval）拿到的是空操作。
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

/** 記一顆事件；記不進去不能扳倒重試（同 `model-calls.ts`）。 */
function tryAppend(write: () => void): void {
  try {
    write();
  } catch {
    // 見上。
  }
}

/** 失敗的穩定描述：碼與狀態是 adapter 回報的，原話取自拋出來的錯誤。 */
function failureOf(reported: StreamFailure, reason: unknown): LlmFailure {
  const message = reason instanceof Error ? reason.message : String(reason);
  return {
    message,
    code: reported.code,
    ...(reported.status !== undefined && { status: reported.status }),
  };
}

/**
 * 建那顆 middleware。無狀態：每次呼叫的嘗試計數與範圍都在呼叫自己的閉包裡。
 *
 * @param options - 預算。
 * @param sessions - 註冊表的 `sessions` 通道，用來問「這次呼叫該寫進哪一份日誌」。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createStreamRetryMiddleware(
  options: StreamRetryOptions,
  sessions: { forCall(config: unknown): SessionLookup },
): AgentMiddleware {
  return createMiddleware({
    name: STREAM_RETRY_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const configurable = (request as { runtime?: { configurable?: unknown } }).runtime
        ?.configurable;
      const signalAbort = turnCancelSignalOf({ configurable });
      const found = sessions.forCall({ configurable });
      const log: SessionLog | undefined = found.kind === 'ok' ? found.log : undefined;
      // 一次呼叫的所有重試共用一個，同 dsh 的 `retryId`。
      const retryId = randomUUID();
      for (let attempt = 0; ; attempt += 1) {
        const { scope, outcome, captured } = await runInAttempt(() =>
          Promise.resolve(handler(request)),
        );
        if (outcome.status === 'fulfilled') return outcome.value;
        const reported = scope.failure;
        const retriable = reported?.retryable === true && attempt < options.maxRetries;
        if (reported === undefined || !retriable) throw outcome.reason;
        const retry = attempt + 1;
        const delayMs = streamRetryDelayMs(options, attempt);
        // 失敗的是哪一次呼叫：起訖紀錄器在裡面，這裡只能從放的格子裡問（拋了也問得到）。
        const modelCall = log === undefined ? undefined : captured.of(log);
        const code = reported.code;
        if (log !== undefined) {
          tryAppend(() =>
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
          );
        }
        const callField = modelCall === undefined ? {} : { modelCall };
        signal({
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
        // 取消之後不寫 `llm/retry-started`，同 `llm-retry.ts` 的規矩。
        const waitStart = Date.now();
        const waited = await sleep(delayMs, signalAbort);
        if (!waited) throw outcome.reason;
        if (log !== undefined) {
          tryAppend(() =>
            log.append(
              'llm/retry-started',
              withModelCall(
                { retryId, retry, waitedMs: Math.max(0, Date.now() - waitStart) },
                modelCall,
              ),
            ),
          );
        }
        signal({ kind: STREAM_RETRY_SIGNAL, phase: 'started', retryId, retry, ...callField });
      }
    },
  }) as unknown as AgentMiddleware;
}
