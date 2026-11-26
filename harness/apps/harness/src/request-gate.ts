/**
 * 全機的**模型請求並行閘**（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)）。
 *
 * 一台主機多人共用一把供應商 key：一條失控的 thread 同時開出十幾條模型串流，供應商回 429，所有人的請求一起退避、一起回來再撞。
 * 這一道閘數「整台 serve 同時有幾個模型請求在跑」，超過的排隊，不再一起撞牆。
 *
 * ## 語意
 *
 * - **FIFO**。釋放時名額直接交給隊首（不經過「先減再搶」的空窗），一條失控 thread 後來的請求排在別人已經在排的後面。
 * - **取得時聽中止訊號**：等待中被中止，立刻離開隊伍、不佔名額；訊號的原因原樣拋出（同 `ChatOpenAI` 自己的 `throwIfAborted`）。
 * - **等太久**（`maxWaitMs`）：拋 {@link LocalCapacityError}（碼 `LOCAL_CAPACITY`），**沒有送請求**。這個碼不在預設的 `retryableCodes`
 *   裡，而且這個錯誤不是供應商回的、不經 `noteStreamFailure`，重試那一層看不到它，所以排隊逾時不會再排一次隊。
 * - **釋放只有一條路**：呼叫端拿到的 `release` 函式，冪等。
 *
 * @module
 */

/** 排隊逾時的穩定碼。不在預設可重試集裡（`@nexus/core` 的 `DEFAULT_STREAM_RETRYABLE_CODES`）。 */
export const LOCAL_CAPACITY_CODE = 'LOCAL_CAPACITY';

/** 排隊等不到名額。認 `name`（跨多層 `cause` 的辨識沿用 `classifyTurnFailure` 的寫法），不認訊息。 */
export class LocalCapacityError extends Error {
  /** 失敗分類碼，見 {@link LOCAL_CAPACITY_CODE}。 */
  readonly code = LOCAL_CAPACITY_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'LocalCapacityError';
  }
}

/** {@link RequestGate} 的建構選項。 */
export interface RequestGateOptions {
  /** 同時最多幾個模型請求在跑。正整數。 */
  readonly maxConcurrent: number;
  /** 排隊最多等幾毫秒，超過就丟 {@link LocalCapacityError}。正整數。 */
  readonly maxWaitMs: number;
  /**
   * 排隊逾時時寫一行去哪裡（serve 日誌）。**獨立的選項，不借別處的 `warn`**（#1504 的教訓：既有的 `warn` 的呼叫端會把訊息包成
   * 別的語意）。只在逾時時寫，不是每次排隊都寫。
   */
  readonly warn?: (line: string) => void;
}

interface Waiter {
  readonly grant: () => void;
  readonly enqueuedAt: number;
}

/** 取到名額之後要還的那個函式；冪等。 */
export type ReleaseSlot = () => void;

/** 行程內的計數號誌，見檔頭。 */
export class RequestGate {
  readonly #maxConcurrent: number;
  readonly #maxWaitMs: number;
  readonly #warn: ((line: string) => void) | undefined;
  readonly #queue: Waiter[] = [];
  #active = 0;

  constructor(options: RequestGateOptions) {
    this.#maxConcurrent = options.maxConcurrent;
    this.#maxWaitMs = options.maxWaitMs;
    this.#warn = options.warn;
  }

  /** 現在有幾個在跑。 */
  get active(): number {
    return this.#active;
  }

  /** 現在有幾個在排隊。 */
  get waiting(): number {
    return this.#queue.length;
  }

  /** 上限。 */
  get maxConcurrent(): number {
    return this.#maxConcurrent;
  }

  /**
   * 取一個名額。
   *
   * @param signal - 等待中被中止就立刻離開（不佔名額），拋 `signal.reason`。
   * @returns 還名額的函式（冪等）。
   * @throws {@link LocalCapacityError} 等超過 `maxWaitMs`；或訊號的原因（已中止、或等待中被中止）。
   */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot> {
    if (signal?.aborted === true) return Promise.reject(abortReason(signal));
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return Promise.resolve(this.#slot());
    }
    return new Promise<ReleaseSlot>((resolve, reject) => {
      let settled = false;
      const leave = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const at = this.#queue.indexOf(waiter);
        if (at >= 0) this.#queue.splice(at, 1);
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        leave();
        reject(abortReason(signal));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        // 先組訊息再離隊：排隊的數字要把自己算進去。
        const message = this.#timeoutMessage(Date.now() - waiter.enqueuedAt);
        leave();
        this.#warn?.(`[模型請求] ${message}`);
        reject(new LocalCapacityError(message));
      }, this.#maxWaitMs);
      const waiter: Waiter = {
        enqueuedAt: Date.now(),
        // 名額是交接過來的：`#active` 不減不加，直接換手。
        grant: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(this.#slot());
        },
      };
      this.#queue.push(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 一個名額的把手：還一次有效，再還什麼都不做。 */
  #slot(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#handOff();
    };
  }

  /** 名額空出來：交給隊首；沒有人在等就真的減一。 */
  #handOff(): void {
    const next = this.#queue.shift();
    if (next === undefined) {
      this.#active -= 1;
      return;
    }
    next.grant();
  }

  #timeoutMessage(waitedMs: number): string {
    return (
      `模型請求排隊 ${String(waitedMs)} 毫秒仍沒有名額，沒有送出（上限 ${String(this.#maxConcurrent)}，` +
      `現在在跑 ${String(this.#active)}、排隊 ${String(this.#queue.length)}）。` +
      '下一步：調高 live-model 的 maxConcurrentRequests 或 maxWaitMs；或查是哪條 thread 開了大量子代理（同一步的 task／subagent 可重疊，背景子代理也各占一個）。'
    );
  }
}

/** 訊號的原因；沒有原因（理論上不會）就拋標準的 AbortError。 */
function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * 依 `live-model` 那一列建全機的那一份閘；**沒設 `maxConcurrentRequests` 就是不建**（`undefined`，行為與沒有這張卡一樣）。
 * 只有 serve 呼叫，起動期一次，交給每一個建模型的地方（見 `createLiveModel` 的 `requestGate`）。
 *
 * @param config - `live-model` 那一列驗過的設定（只讀這兩格）。
 * @param warn - 排隊逾時時寫一行去哪裡，serve 接 `serverLog`。
 */
export function createRequestGate(
  config: { readonly maxConcurrentRequests?: number | undefined; readonly maxWaitMs: number },
  warn?: (line: string) => void,
): RequestGate | undefined {
  if (config.maxConcurrentRequests === undefined) return undefined;
  return new RequestGate({
    maxConcurrent: config.maxConcurrentRequests,
    maxWaitMs: config.maxWaitMs,
    ...(warn !== undefined && { warn }),
  });
}
