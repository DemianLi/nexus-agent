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
 * **擦除的時機是偏離**：dsh 在失敗當下、同一個迴圈裡就把那次記成 attempt 並撤掉，因為消費串流與決定重試是同一條控制流。我們的重試
 * 決定在圖裡的 middleware，畫面的字卻是 pump 從另一條佇列（`streamEvents`）讀到的，兩條之間沒有先後保證——middleware 這邊
 * 一說「失敗了」就擦，失敗那次排在佇列裡還沒被 pump 讀到的片段會在擦除之後才到，把剛擦掉的那則又畫回來。同一條佇列上唯一保證
 * 排在失敗那次的全部片段之後的，是下一次嘗試的第一則 `message-start`，所以 pump 在那一刻送 `assistant/attempt` 與
 * `message-discard`（`thread-pump.ts` 的 `#abandonSupersededReply`）；等退避時被停止的那一種，pump 在收尾時補送
 * （`#keepInterruptedReply`），結果上對得上 dsh。這個「沒有先後保證」是從兩條通道的結構推的，沒有構造出競態。
 *
 * - **次數與起點先保守**：預設最多 2 次、1 秒起（卡上 2026-10-06 拍板；dsh 預設 5 次、500 毫秒起，`retry-policy.ts:14-15`）。每次重試都重付
 *   整個回覆的費用，所以不照抄。**退避的形狀照 dsh**：倍增、單次封頂 10 秒、抖動 0.1（`:16-17`），欄位見
 *   `apps/harness/src/settings/live-model.ts`。
 * - **退避聽中止訊號**：等待中按停止就立刻收，不再打一次。
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import { turnCancelSignalOf } from './turn-cancel.js';

/** middleware 的名字。 */
export const STREAM_RETRY_MIDDLEWARE_NAME = 'nexusStreamRetry';

/** 一次串流失敗，由 adapter（fetch 那一層）在看到的當下回報。 */
export interface StreamFailure {
  /** 失敗的種類，照 dsh 的碼：`TIMEOUT`（停住）、`TRANSPORT`（斷線）、其餘取 HTTP 狀態或供應商碼。只給人讀。 */
  readonly code: string;
  /** 重打會不會有用。供應商說「請求本身有問題」（例如 400）的不重試。 */
  readonly retryable: boolean;
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
async function runInAttempt<T>(
  call: () => Promise<T>,
): Promise<{ readonly scope: AttemptScope; readonly outcome: PromiseSettledResult<T> }> {
  const scope: AttemptScope = { failure: undefined };
  const outcome = await scopes.run(scope, () =>
    call().then(
      (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
      (reason: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
    ),
  );
  return { scope, outcome };
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

/**
 * 建那顆 middleware。無狀態：每次呼叫的嘗試計數與範圍都在呼叫自己的閉包裡。
 *
 * @param options - 預算。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createStreamRetryMiddleware(options: StreamRetryOptions): AgentMiddleware {
  return createMiddleware({
    name: STREAM_RETRY_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const signal = turnCancelSignalOf({
        configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
      });
      for (let attempt = 0; ; attempt += 1) {
        const { scope, outcome } = await runInAttempt(() => Promise.resolve(handler(request)));
        if (outcome.status === 'fulfilled') return outcome.value;
        const retriable = scope.failure?.retryable === true && attempt < options.maxRetries;
        if (!retriable) throw outcome.reason;
        // 退避：1 倍、2 倍、4 倍……；這一輪已經中止、或等待中按了停止，原本的錯誤照樣往外拋，不再打（`sleep` 兩種都認）。
        const waited = await sleep(streamRetryDelayMs(options, attempt), signal);
        if (!waited) throw outcome.reason;
      }
    },
  }) as unknown as AgentMiddleware;
}
