/**
 * 一對之間那條橋在葉子這一端的連線（[#2583](https://github.com/DemianLi/nexus-agent/issues/2583)）；協定的規則在
 * `native/sandbox-spawner/host/src/pair_protocol.rs` 檔頭，編解碼在 `./pair-protocol.ts`。
 *
 * {@link PairClient.connect} 連到組合行程 listen 的 socket、送 `hello`，驗過才回一個 {@link PairClient}；沒進去就丟
 * {@link PairConnectError}，`failure.kind` 分四種：
 *
 * - `absent`（對方不在）：到啟動時限，最後一次有結論的嘗試是連不上、connect 成功後沒收到任何框就斷、或等滿時限沒有回覆；
 *   沒有任何一次有結論（每一次都被啟動時限截斷）也算這一種。
 * - `rejected`（被拒）：收到 `retry_later` 以外的 `rejected`，含解不開的 `rejected`。不重試。
 * - `retry_later`（一直被要求稍後再試）：到啟動時限，最後一次有結論的嘗試收到的是 `retry_later`。
 * - `violation`：組合行程在驗過之前違反協定（壞框、不該送的種類、這邊還沒送 `hello` 它就送 `hello`、`hello` 的版本跟這邊不同）。不重試。
 *
 * 連不上、connect 成功後沒收到任何框就斷、等滿時限沒有回覆、收到 `retry_later`，都退避後重連，到啟動時限為止：第一次等 `backoffMs`，之後每次加倍到 `backoffMaxMs`。再等一次就會過啟動時限時不等，直接回報。
 * 每一條連線等回覆等 `helloTimeoutMs`（從 connect 成功起算）；剩下的啟動時間比它短時只等到啟動時限，到了還沒有結論的那一次算被時限截斷，不拿來判結局。
 * 每一種沒進去的結局都帶 {@link PairConnectReport}：起了幾次、連上幾次、各是怎麼結束的、經過多久。
 *
 * 結局以收到的 `rejected` 為準。Node 的 socket 寫入出錯就整條毀掉、不再讀，所以 `hello` 不在 connect 成功的當下寫，先讀一輪：
 * 組合行程收下連線就拒絕並關的，這時 `rejected` 已經讀到。讀完那一輪到寫下去之間對方才關的仍會讀不到，那一次算沒收到任何框就斷，由重連再拿一次。
 *
 * 驗過之後：
 *
 * - 兩個方向都能發呼叫。自己發的用 {@link PairClient.call}；組合行程發來的照 `methods` 找處理函式，找不到回 `unknown_method`。
 * - 組合行程違反協定就直接關連線，不回 `rejected`。
 * - 背壓：排著沒寫出去的位元組自己數。到了 {@link PAIR_OUTBOX_PAUSE_BYTES}，{@link PairClient.call} 與 {@link PairClient.register}
 *   丟 {@link PairSendError}（`paused`，什麼都沒送），處理函式的塊與結果留著、降回去再送；`cancel` 與這裡自動回的 `result` 照排，
 *   再排一框就超過 {@link PAIR_OUTBOX_LIMIT_BYTES} 的關連線。組合行程送來的任何時候都照讀。
 * - 有東西排著、連續 {@link PAIR_STALL_TIMEOUT_MS} 沒有任何一段寫出去，關連線。寫入一次交給 socket 最多 64 KiB、上一段寫完才交下一段，進度以段為單位看。
 * - 連線斷了不重連：自己發出去還沒回的呼叫以 {@link PairPeerGoneError} 結算，組合行程發來還在跑的全部中止（`signal`）。
 * - 閒著（沒有東西排著）時沒有任何計時器。時間與計時器都從 `clock` 來。
 *
 * @module
 */

import { createConnection, type Socket } from 'node:net';

import {
  PAIR_HELLO_TIMEOUT_MS,
  PAIR_MAX_CALLS,
  PAIR_MAX_CHUNK_BYTES,
  PAIR_OUTBOX_LIMIT_BYTES,
  PAIR_OUTBOX_PAUSE_BYTES,
  PAIR_PROTOCOL_VERSION,
  PAIR_RETRY_BACKOFF_MIN_MS,
  PAIR_STALL_TIMEOUT_MS,
  PairFrameReader,
  PairFrameTooLargeError,
  PairProtocolError,
  clipPairMethod,
  decodePairMessage,
  encodePairMessage,
  type PairCallRef,
  type PairMessage,
  type PairRejectCode,
} from './pair-protocol.js';
import { type HostErrorCode, type Json } from './protocol.js';

/** 重連等待的上限，預設值。 */
export const PAIR_BACKOFF_MAX_MS = 2_000;

/** 一次交給 socket 最多多少位元組，上一段寫完才交下一段；送端的進度以段為單位看。 */
const WRITE_SLICE = 64 * 1024;

/** 自動回的錯誤訊息最長幾個 UTF-16 單位：處理函式丟的錯可以任意長，回的框要是小框。 */
const ERROR_MESSAGE_UNITS = 1024;

const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** 時間與計時器的來源；測試換成手動推進的。 */
export interface PairClock {
  /** 單調的毫秒數。 */
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_CLOCK: PairClock = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** 組合行程發來的一次呼叫，交給處理函式的東西。 */
export interface PairCallContext {
  readonly ref: PairCallRef;
  readonly parent: PairCallRef | null;
  /** 組合行程取消了、這一次已經以 `too_large` 收尾、或連線斷了，就中止。 */
  readonly signal: AbortSignal;
  /**
   * 串流一塊；送端暫停時等到降回去才送。那一次已經不在跑丟 {@link PairSendError}（`not_running`）；
   * 一塊超過 {@link PAIR_MAX_CHUNK_BYTES} 不送，那一次以 `too_large` 收尾，丟 {@link PairSendError}（`too_large`）；
   * `payload` 有落單的代理對丟 {@link PairProtocolError}，不送，那一次照常繼續。
   */
  chunk(payload: string): Promise<void>;
}

/**
 * 替組合行程做的一個 method。回傳值是 `result` 的 `ok`；丟 {@link PairCallError} 就回它的 `code`，丟別的回 `service_error`。
 * 結果編出來超過一框回 `too_large`，過不了橋（非有限的數字之類）回 `service_error`。
 */
export type PairMethod = (payload: Json, context: PairCallContext) => Json | Promise<Json>;

export interface PairConnectOptions {
  readonly socketPath: string;
  /** 從開始連起算，最晚到這時還沒進去就回報；不得短於 `helloTimeoutMs`。 */
  readonly startupDeadlineMs: number;
  /** 一條連線 connect 成功後等回覆多久，預設也是下限 {@link PAIR_HELLO_TIMEOUT_MS}。 */
  readonly helloTimeoutMs?: number;
  /** 第一次重連前等多久，預設也是下限 {@link PAIR_RETRY_BACKOFF_MIN_MS}。 */
  readonly backoffMs?: number;
  /** 重連等待的上限，預設 {@link PAIR_BACKOFF_MAX_MS}（`backoffMs` 比它長時是 `backoffMs`）；不得短於 `backoffMs`。 */
  readonly backoffMaxMs?: number;
  /** 替組合行程做的 method。 */
  readonly methods?: Readonly<Record<string, PairMethod>>;
  /** 驗過之後馬上送的 `register`；不給就不送。 */
  readonly register?: { readonly tools: readonly string[]; readonly hooks: readonly string[] };
  /** 一次嘗試沒進去、接著要退避重連時叫一次（還沒開始等）；丟出的錯會讓 {@link PairClient.connect} 以那個錯結束。 */
  readonly onRetry?: (retry: PairRetry) => void;
  readonly clock?: PairClock;
}

/** 一次沒進去、接著要重連的嘗試。 */
export interface PairRetry {
  /** 第幾次嘗試，從 1 起。 */
  readonly attempt: number;
  /** `unreachable` 是連不上，`dropped` 是 connect 成功後沒收到任何框就斷，`unanswered` 是等滿時限沒有回覆。 */
  readonly outcome: 'unreachable' | 'dropped' | 'unanswered' | 'retry_later';
  /** 連線的錯誤訊息、`retry_later` 的 `reason`，或 `unanswered` 時固定的一句說明。 */
  readonly detail: string;
  /** 接著等多久再連。 */
  readonly waitMs: number;
}

/** 連線的過程：每一種沒進去的結局都帶。 */
export interface PairConnectReport {
  /** 起了幾次連線。 */
  readonly attempts: number;
  /** 其中幾次 connect 成功。 */
  readonly connects: number;
  /** 幾次收到 `retry_later`。 */
  readonly retryLater: number;
  /** 幾次 connect 成功、沒收到任何框就斷。 */
  readonly closedBeforeFrame: number;
  /** 幾次 connect 成功、等滿 `helloTimeoutMs` 沒收到任何框。 */
  readonly unanswered: number;
  /** 幾次還沒有結論就到了啟動時限。 */
  readonly cutShort: number;
  /** 從開始連到回報經過多久。 */
  readonly elapsedMs: number;
}

export type PairConnectFailure = PairConnectReport &
  (
    | {
        readonly kind: 'absent';
        /** 最後一次有結論的嘗試怎麼失敗的；沒有任何一次有結論時是說明這件事的一句話。 */
        readonly lastError: string;
      }
    | {
        readonly kind: 'rejected';
        /** 解不開的 `rejected` 是 `undefined`。 */
        readonly code: PairRejectCode | undefined;
        readonly reason: string;
      }
    | {
        readonly kind: 'retry_later';
        /** 最後一次 `retry_later` 的 `reason`。 */ readonly lastReason: string;
      }
    | { readonly kind: 'violation'; readonly detail: string }
  );

function explain(failure: PairConnectFailure): string {
  const span = `試了 ${String(failure.attempts)} 次、經過 ${String(Math.round(failure.elapsedMs))} ms`;
  switch (failure.kind) {
    case 'absent':
      return failure.connects === 0
        ? `對方不在：從頭到尾沒連上（${span}；最後一次：${failure.lastError}）`
        : `對方不在：連上過 ${String(failure.connects)} 次，${String(failure.closedBeforeFrame)} 次在收到任何框之前被關、` +
            `${String(failure.unanswered)} 次等滿時限沒有回覆、${String(failure.cutShort)} 次還在等就到了啟動時限` +
            `（${span}；最後一次：${failure.lastError}）`;
    case 'rejected':
      return `被拒（${failure.code ?? '解不開的拒絕碼'}）：${failure.reason}`;
    case 'retry_later':
      return `一直被要求稍後再試：收到 ${String(failure.retryLater)} 次（${span}；最後一次的理由：${failure.lastReason}）`;
    case 'violation':
      return `組合行程違反協定：${failure.detail}`;
  }
}

/** 沒進去。 */
export class PairConnectError extends Error {
  override readonly name = 'PairConnectError';

  constructor(readonly failure: PairConnectFailure) {
    super(explain(failure));
  }
}

/** 組合行程回的錯，或呼叫端自己取消（`cancelled`）。 */
export class PairCallError extends Error {
  override readonly name = 'PairCallError';

  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 呼叫送出去之後、結果回來之前連線斷了：組合行程那邊做了沒做不知道。 */
export class PairPeerGoneError extends Error {
  override readonly name = 'PairPeerGoneError';
}

/**
 * 現在送不了，這一框沒送，連線不動：
 *
 * - `not_connected`：連線已經斷了。
 * - `paused`：排著的到了 {@link PAIR_OUTBOX_PAUSE_BYTES}；等 {@link PairClient.writable} 再試。
 * - `busy`：自己發的呼叫已經 {@link PAIR_MAX_CALLS} 個。
 * - `too_large`：`call` 編出來超過一框，或一塊超過 {@link PAIR_MAX_CHUNK_BYTES}（這時那一次呼叫已經以 `too_large` 收尾，
 *   見 {@link PairCallContext.chunk}）。
 * - `bad_parent`：`parent` 不在跑。
 * - `not_running`：那一次呼叫不在跑。
 */
export type PairSendErrorReason =
  'not_connected' | 'paused' | 'busy' | 'too_large' | 'bad_parent' | 'not_running';

export class PairSendError extends Error {
  override readonly name = 'PairSendError';

  constructor(
    readonly reason: PairSendErrorReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 驗過的連線為什麼斷：`closed` 是組合行程關了或讀寫出錯，`violation` 是它違反協定，`overflow` 是照排的框再排就超過
 * {@link PAIR_OUTBOX_LIMIT_BYTES}，`stalled` 是送端停滯，`local` 是這一端叫了 {@link PairClient.close}。
 */
export interface PairDisconnect {
  readonly kind: 'closed' | 'violation' | 'overflow' | 'stalled' | 'local';
  readonly detail: string;
}

export interface PairCallOptions {
  /** 外層那一次呼叫；要還在跑。 */
  readonly parent?: PairCallRef;
  /** 中止就以 {@link PairCallError}（`cancelled`）結算；已經送出的才送 `cancel`。 */
  readonly signal?: AbortSignal;
  /** 每收到一塊叫一次，照 `seq` 的順序。丟出的錯會取消這個呼叫，呼叫以那個錯結算。 */
  readonly onChunk?: (payload: string) => void;
}

interface Mine {
  seq: number;
  /** 已經結算給呼叫端了（取消或 `onChunk` 丟錯）：還在等組合行程回的 `result`，收到就丟掉。 */
  settled: boolean;
  readonly onChunk: ((payload: string) => void) | undefined;
  settle(outcome: { readonly ok: Json } | { readonly error: Error }): void;
}

interface Theirs {
  readonly controller: AbortController;
  seq: number;
}

type Attempt = { readonly connected: boolean } & (
  | { readonly kind: 'verified'; readonly client: PairClient }
  | {
      readonly kind: 'rejected';
      readonly code: PairRejectCode | undefined;
      readonly reason: string;
    }
  | { readonly kind: 'retry_later'; readonly reason: string }
  | { readonly kind: 'violation'; readonly detail: string }
  | { readonly kind: 'unreachable'; readonly error: string }
  | { readonly kind: 'dropped'; readonly error: string }
  | { readonly kind: 'unanswered' }
  | { readonly kind: 'cut' }
);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 第一框解不開時，看它是不是一份 `type` 是 `rejected` 的物件：`code` 不認得或別的欄位不合都算。 */
function undecodableRejection(payload: Buffer): { readonly reason: string } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (fields.type !== 'rejected') return undefined;
  return { reason: typeof fields.reason === 'string' ? fields.reason : '' };
}

/** 葉子這一端一條驗過的連線；用 {@link PairClient.connect} 拿。 */
export class PairClient {
  /** 連線斷了就完成，帶斷的原因；不會被拒絕。 */
  readonly closed: Promise<PairDisconnect>;

  readonly #socket: Socket;
  readonly #reader: PairFrameReader;
  readonly #clock: PairClock;
  readonly #methods: ReadonlyMap<string, PairMethod>;
  readonly #mine = new Map<number, Mine>();
  readonly #theirs = new Map<number, Theirs>();
  readonly #waiters = new Set<() => void>();
  readonly #outbox: Buffer[] = [];
  #resolveClosed: (reason: PairDisconnect) => void = () => undefined;
  #open = true;
  #queued = 0;
  #writing = false;
  #stall: unknown;
  #nextId = 0;
  #lastError = '連線關了';

  /**
   * 連到組合行程並驗過。
   *
   * @throws {@link PairConnectError}：沒進去，見檔頭的四種。
   * @throws `RangeError`：`helloTimeoutMs` 短於 {@link PAIR_HELLO_TIMEOUT_MS}、`startupDeadlineMs` 短於 `helloTimeoutMs`、
   *   `backoffMs` 短於 {@link PAIR_RETRY_BACKOFF_MIN_MS}、`backoffMaxMs` 短於 `backoffMs`，或其中有不是數字的。沒有連。
   * @throws {@link PairProtocolError}：`register` 的名稱過不了橋或整框超過上限。沒有連。
   * @throws `onRetry` 丟的錯，原樣拋出。
   */
  static async connect(options: PairConnectOptions): Promise<PairClient> {
    const helloTimeoutMs = options.helloTimeoutMs ?? PAIR_HELLO_TIMEOUT_MS;
    const backoffMs = options.backoffMs ?? PAIR_RETRY_BACKOFF_MIN_MS;
    const backoffMaxMs = options.backoffMaxMs ?? Math.max(PAIR_BACKOFF_MAX_MS, backoffMs);
    if (!(helloTimeoutMs >= PAIR_HELLO_TIMEOUT_MS)) {
      throw new RangeError(`helloTimeoutMs 不得短於 ${String(PAIR_HELLO_TIMEOUT_MS)}`);
    }
    if (!(options.startupDeadlineMs >= helloTimeoutMs)) {
      throw new RangeError('startupDeadlineMs 不得短於 helloTimeoutMs');
    }
    if (!(backoffMs >= PAIR_RETRY_BACKOFF_MIN_MS)) {
      throw new RangeError(`backoffMs 不得短於 ${String(PAIR_RETRY_BACKOFF_MIN_MS)}`);
    }
    if (!(backoffMaxMs >= backoffMs)) throw new RangeError('backoffMaxMs 不得短於 backoffMs');
    const register =
      options.register &&
      encodePairMessage({
        type: 'register',
        tools: options.register.tools,
        hooks: options.register.hooks,
      });

    const clock = options.clock ?? REAL_CLOCK;
    const started = clock.now();
    const deadlineAt = started + options.startupDeadlineMs;
    const tally = {
      attempts: 0,
      connects: 0,
      retryLater: 0,
      closedBeforeFrame: 0,
      unanswered: 0,
      cutShort: 0,
    };
    const report = (): PairConnectReport => ({ ...tally, elapsedMs: clock.now() - started });
    let last: { readonly retryLater: boolean; readonly text: string } = {
      retryLater: false,
      text: '還沒有任何一次嘗試有結論',
    };
    let delay = backoffMs;
    for (;;) {
      tally.attempts += 1;
      const attempt = await PairClient.#attempt(
        options,
        register,
        clock,
        helloTimeoutMs,
        deadlineAt,
      );
      if (attempt.connected) tally.connects += 1;
      switch (attempt.kind) {
        case 'verified':
          return attempt.client;
        case 'rejected':
          throw new PairConnectError({
            kind: 'rejected',
            code: attempt.code,
            reason: attempt.reason,
            ...report(),
          });
        case 'violation':
          throw new PairConnectError({ kind: 'violation', detail: attempt.detail, ...report() });
        case 'retry_later':
          tally.retryLater += 1;
          last = { retryLater: true, text: attempt.reason };
          break;
        case 'unreachable':
          last = { retryLater: false, text: attempt.error };
          break;
        case 'dropped':
          tally.closedBeforeFrame += 1;
          last = { retryLater: false, text: attempt.error };
          break;
        case 'unanswered':
          tally.unanswered += 1;
          last = { retryLater: false, text: '等滿時限沒有回覆' };
          break;
        case 'cut':
          tally.cutShort += 1;
          break;
      }
      if (attempt.kind === 'cut' || clock.now() + delay >= deadlineAt) {
        throw new PairConnectError(
          last.retryLater
            ? { kind: 'retry_later', lastReason: last.text, ...report() }
            : { kind: 'absent', lastError: last.text, ...report() },
        );
      }
      const wait = delay;
      options.onRetry?.({
        attempt: tally.attempts,
        outcome: attempt.kind,
        detail: last.text,
        waitMs: wait,
      });
      await new Promise<void>((resolve) => {
        clock.setTimeout(resolve, wait);
      });
      delay = Math.min(delay * 2, backoffMaxMs);
    }
  }

  /** 連一次、送 `hello`、等第一框。 */
  static #attempt(
    options: PairConnectOptions,
    register: Buffer | undefined,
    clock: PairClock,
    helloTimeoutMs: number,
    deadlineAt: number,
  ): Promise<Attempt> {
    return new Promise((resolve) => {
      const reader = new PairFrameReader();
      const socket = createConnection(options.socketPath);
      let connected = false;
      let done = false;
      let greeted = false;
      let lastError = '連線關了';
      let timer = clock.setTimeout(
        () => {
          finish({ connected, kind: 'cut' });
        },
        Math.max(0, deadlineAt - clock.now()),
      );
      const finish = (attempt: Attempt) => {
        if (done) return;
        done = true;
        clock.clearTimeout(timer);
        if (attempt.kind !== 'verified') socket.destroy();
        resolve(attempt);
      };
      const onData = (chunk: Buffer) => {
        if (done) return;
        let frames: Buffer[];
        try {
          frames = reader.push(chunk);
        } catch (error: unknown) {
          finish({ connected, kind: 'violation', detail: messageOf(error) });
          return;
        }
        const first = frames[0];
        if (first === undefined) return;
        let message: PairMessage;
        try {
          message = decodePairMessage(first);
        } catch (error: unknown) {
          const rejection = undecodableRejection(first);
          finish(
            rejection === undefined
              ? { connected, kind: 'violation', detail: messageOf(error) }
              : { connected, kind: 'rejected', code: undefined, reason: rejection.reason },
          );
          return;
        }
        if (message.type === 'rejected') {
          finish(
            message.code === 'retry_later'
              ? { connected, kind: 'retry_later', reason: message.reason }
              : { connected, kind: 'rejected', code: message.code, reason: message.reason },
          );
        } else if (message.type !== 'hello') {
          finish({ connected, kind: 'violation', detail: `hello 之前收到 ${message.type}` });
        } else if (!greeted) {
          finish({ connected, kind: 'violation', detail: '這邊還沒送 hello 就收到 hello' });
        } else if (message.version !== PAIR_PROTOCOL_VERSION) {
          finish({
            connected,
            kind: 'violation',
            detail: `組合行程的版本是 ${String(message.version)}，這邊是 ${String(PAIR_PROTOCOL_VERSION)}`,
          });
        } else {
          socket.off('data', onData);
          socket.off('error', onError);
          socket.off('close', onClose);
          const client = new PairClient(
            socket,
            reader,
            clock,
            options.methods,
            register,
            frames.slice(1),
          );
          finish({ connected, kind: 'verified', client });
        }
      };
      const onError = (error: Error) => {
        lastError = error.message;
      };
      const onClose = () => {
        finish(
          connected
            ? { connected, kind: 'dropped', error: lastError }
            : { connected, kind: 'unreachable', error: lastError },
        );
      };
      socket.on('connect', () => {
        if (done) return;
        connected = true;
        const remaining = deadlineAt - clock.now();
        const full = remaining >= helloTimeoutMs;
        clock.clearTimeout(timer);
        timer = clock.setTimeout(
          () => {
            finish(full ? { connected, kind: 'unanswered' } : { connected, kind: 'cut' });
          },
          full ? helloTimeoutMs : Math.max(0, remaining),
        );
        // 先讀一輪才寫（理由在檔頭）：第二個 setImmediate 排在下一輪的讀之後，這時已經判出結局就不寫。
        setImmediate(() => {
          setImmediate(() => {
            if (done) return;
            greeted = true;
            const hello = encodePairMessage({ type: 'hello', version: PAIR_PROTOCOL_VERSION });
            const head = Buffer.alloc(4);
            head.writeUInt32LE(hello.length);
            socket.write(Buffer.concat([head, hello]));
          });
        });
      });
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    });
  }

  private constructor(
    socket: Socket,
    reader: PairFrameReader,
    clock: PairClock,
    methods: Readonly<Record<string, PairMethod>> | undefined,
    register: Buffer | undefined,
    rest: readonly Buffer[],
  ) {
    this.#socket = socket;
    this.#reader = reader;
    this.#clock = clock;
    this.#methods = new Map(Object.entries(methods ?? {}));
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    socket.on('data', (chunk: Buffer) => {
      try {
        this.#onFrames(this.#reader.push(chunk));
      } catch (error: unknown) {
        this.#drop({ kind: 'violation', detail: messageOf(error) });
      }
    });
    socket.on('error', (error) => {
      this.#lastError = error.message;
    });
    socket.on('close', () => {
      this.#drop({ kind: 'closed', detail: this.#lastError });
    });
    if (register !== undefined) this.#enqueue(register);
    try {
      this.#onFrames(rest);
    } catch (error: unknown) {
      this.#drop({ kind: 'violation', detail: messageOf(error) });
    }
  }

  /** 排著沒寫出去的到了 {@link PAIR_OUTBOX_PAUSE_BYTES}。 */
  get paused(): boolean {
    return this.#queued >= PAIR_OUTBOX_PAUSE_BYTES;
  }

  /** 排著沒寫出去的位元組數。 */
  get queuedBytes(): number {
    return this.#queued;
  }

  /** 送端沒有暫停、或連線斷了就完成。 */
  writable(): Promise<void> {
    if (!this.#open || !this.paused) return Promise.resolve();
    return new Promise((resolve) => {
      this.#waiters.add(resolve);
    });
  }

  /**
   * 登記名稱，整份取代上一次的。
   *
   * @throws {@link PairSendError}：`not_connected` 或 `paused`。
   * @throws {@link PairProtocolError}：名稱過不了橋或整框超過上限，沒送出去。
   */
  register(tools: readonly string[], hooks: readonly string[]): void {
    this.#admitNow();
    this.#enqueue(encodePairMessage({ type: 'register', tools, hooks }));
  }

  /**
   * 叫組合行程的一個 method。
   *
   * @returns 組合行程回的 `ok`。
   * @throws {@link PairCallError}：組合行程回的錯誤碼，或呼叫端取消（`cancelled`）。
   * @throws {@link PairPeerGoneError}：送出去之後連線斷了。
   * @throws {@link PairSendError}：沒送出去，見它的 `reason`。
   * @throws {@link PairProtocolError}：`method` 或 `payload` 過不了橋，沒送出去。
   * @throws `onChunk` 丟的錯：呼叫以那個錯結算，並送 `cancel`。
   */
  call(method: string, payload: Json, options: PairCallOptions = {}): Promise<Json> {
    const { signal, onChunk, parent } = options;
    let bytes: Buffer;
    const id = this.#nextId;
    try {
      this.#admitNow();
      if (this.#mine.size >= PAIR_MAX_CALLS) {
        throw new PairSendError('busy', `自己發的呼叫已經 ${String(PAIR_MAX_CALLS)} 個`);
      }
      if (parent !== undefined && !this.#running(parent)) {
        throw new PairSendError('bad_parent', 'parent 不在跑');
      }
      if (signal?.aborted === true) throw new PairCallError('cancelled', '送出之前就取消了');
      try {
        bytes = encodePairMessage({
          type: 'call',
          side: 'l',
          id,
          parent: parent ?? null,
          method,
          payload,
        });
      } catch (error: unknown) {
        if (error instanceof PairFrameTooLargeError) {
          throw new PairSendError('too_large', error.message);
        }
        throw error;
      }
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.#nextId += 1;
    return new Promise<Json>((resolve, reject) => {
      const cancel = (error: Error) => {
        if (call.settled) return;
        call.settle({ error });
        if (this.#mine.get(id) === call) {
          this.#enqueue(encodePairMessage({ type: 'cancel', side: 'l', id }));
        }
      };
      const onAbort = () => {
        cancel(new PairCallError('cancelled', '呼叫端取消了'));
      };
      const call: Mine = {
        seq: 0,
        settled: false,
        onChunk:
          onChunk &&
          ((text) => {
            try {
              onChunk(text);
            } catch (error: unknown) {
              cancel(error instanceof Error ? error : new Error(String(error)));
            }
          }),
        settle: (outcome) => {
          if (call.settled) return;
          call.settled = true;
          signal?.removeEventListener('abort', onAbort);
          if ('ok' in outcome) resolve(outcome.ok);
          else reject(outcome.error);
        },
      };
      this.#mine.set(id, call);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#enqueue(bytes);
    });
  }

  /** 關掉連線；還開著的話 {@link PairClient.closed} 以 `local` 完成。叫幾次都一樣。 */
  close(): void {
    this.#drop({ kind: 'local', detail: '這一端關了' });
  }

  #running(ref: PairCallRef): boolean {
    return ref.side === 'l' ? this.#mine.has(ref.id) : this.#theirs.has(ref.id);
  }

  /** 自己要發的框現在能不能送；不能就丟。 */
  #admitNow(): void {
    if (!this.#open) throw new PairSendError('not_connected', '連線已經斷了');
    if (this.paused) throw new PairSendError('paused', '排著沒寫出去的太多，現在送不了');
  }

  /** 等到送端沒有暫停；那一次呼叫已經不在跑就丟。 */
  async #admitServed(id: number, their: Theirs): Promise<void> {
    for (;;) {
      if (this.#theirs.get(id) !== their) {
        throw new PairSendError('not_running', '那一次呼叫已經不在跑');
      }
      if (!this.paused) return;
      await this.writable();
    }
  }

  #enqueue(payload: Buffer): void {
    if (!this.#open) return;
    const size = payload.length + 4;
    if (this.#queued + size > PAIR_OUTBOX_LIMIT_BYTES) {
      this.#drop({ kind: 'overflow', detail: '組合行程不讀，排著的超過上限' });
      return;
    }
    const head = Buffer.alloc(4);
    head.writeUInt32LE(payload.length);
    const idle = this.#queued === 0;
    this.#queued += size;
    if (idle) this.#armStall();
    this.#outbox.push(head, payload);
    this.#pump();
  }

  /** 交下一段給 socket；上一段還沒寫完就不交。 */
  #pump(): void {
    if (this.#writing || !this.#open) return;
    const parts: Buffer[] = [];
    let length = 0;
    while (length < WRITE_SLICE) {
      const next = this.#outbox.shift();
      if (next === undefined) break;
      const room = WRITE_SLICE - length;
      if (next.length > room) {
        parts.push(next.subarray(0, room));
        this.#outbox.unshift(next.subarray(room));
        length += room;
      } else {
        parts.push(next);
        length += next.length;
      }
    }
    if (length === 0) return;
    this.#writing = true;
    this.#socket.write(Buffer.concat(parts), (error) => {
      this.#writing = false;
      if (error !== null && error !== undefined) return;
      this.#wrote(length);
      this.#pump();
    });
  }

  #armStall(): void {
    this.#clock.clearTimeout(this.#stall);
    this.#stall = this.#clock.setTimeout(() => {
      this.#drop({
        kind: 'stalled',
        detail: `有東西排著，${String(PAIR_STALL_TIMEOUT_MS)} ms 沒有寫出去`,
      });
    }, PAIR_STALL_TIMEOUT_MS);
  }

  #wrote(length: number): void {
    if (!this.#open) return;
    this.#queued -= length;
    if (this.#queued === 0) {
      this.#clock.clearTimeout(this.#stall);
      this.#stall = undefined;
    } else {
      this.#armStall();
    }
    if (!this.paused) this.#wake();
  }

  #wake(): void {
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter();
  }

  #drop(reason: PairDisconnect): void {
    if (!this.#open) return;
    this.#open = false;
    this.#clock.clearTimeout(this.#stall);
    this.#stall = undefined;
    this.#socket.destroy();
    this.#outbox.length = 0;
    const mine = [...this.#mine.values()];
    this.#mine.clear();
    const theirs = [...this.#theirs.values()];
    this.#theirs.clear();
    for (const call of mine) {
      call.settle({
        error: new PairPeerGoneError(`呼叫送出之後連線斷了（${reason.detail}），結果不明`),
      });
    }
    for (const their of theirs) their.controller.abort();
    this.#wake();
    this.#resolveClosed(reason);
  }

  #onFrames(frames: readonly Buffer[]): void {
    for (const payload of frames) {
      if (!this.#open) return;
      this.#onMessage(decodePairMessage(payload));
    }
  }

  #replyError(id: number, code: HostErrorCode, text: string): void {
    const message = text.slice(0, ERROR_MESSAGE_UNITS).replace(LONE_SURROGATES, '\uFFFD');
    this.#enqueue(encodePairMessage({ type: 'result', side: 'm', id, error: { code, message } }));
  }

  #onMessage(message: PairMessage): void {
    switch (message.type) {
      case 'hello':
      case 'rejected':
      case 'register':
        throw new PairProtocolError(`驗過之後收到 ${message.type}`);
      case 'call': {
        if (message.side !== 'm') throw new PairProtocolError('方向不對');
        if (this.#theirs.has(message.id)) throw new PairProtocolError('重複的呼叫編號');
        const handler = this.#methods.get(message.method);
        if (this.#theirs.size >= PAIR_MAX_CALLS) {
          this.#replyError(message.id, 'busy', '同時在跑的呼叫已經到上限');
        } else if (message.parent !== null && !this.#running(message.parent)) {
          this.#replyError(message.id, 'bad_payload', 'parent 不在跑');
        } else if (handler === undefined) {
          this.#replyError(message.id, 'unknown_method', clipPairMethod(message.method));
        } else {
          this.#serve(message.id, message.parent, handler, message.payload);
        }
        return;
      }
      case 'chunk': {
        if (message.side !== 'l') throw new PairProtocolError('方向不對');
        const call = this.#mine.get(message.id);
        if (call === undefined) throw new PairProtocolError('不在跑的呼叫');
        if (message.seq !== call.seq) throw new PairProtocolError('seq 沒接上');
        call.seq += 1;
        if (!call.settled) call.onChunk?.(message.payload);
        return;
      }
      case 'result': {
        if (message.side !== 'l') throw new PairProtocolError('方向不對');
        const call = this.#mine.get(message.id);
        if (call === undefined) throw new PairProtocolError('不在跑的呼叫');
        this.#mine.delete(message.id);
        call.settle(
          'ok' in message
            ? { ok: message.ok }
            : { error: new PairCallError(message.error.code, message.error.message) },
        );
        return;
      }
      case 'cancel': {
        if (message.side !== 'm') throw new PairProtocolError('方向不對');
        const their = this.#theirs.get(message.id);
        if (their === undefined) return;
        this.#theirs.delete(message.id);
        their.controller.abort();
        this.#replyError(message.id, 'cancelled', '');
        return;
      }
    }
  }

  #serve(id: number, parent: PairCallRef | null, handler: PairMethod, payload: Json): void {
    const their: Theirs = { controller: new AbortController(), seq: 0 };
    this.#theirs.set(id, their);
    const context: PairCallContext = {
      ref: { id, side: 'm' },
      parent,
      signal: their.controller.signal,
      chunk: async (text) => {
        await this.#admitServed(id, their);
        if (Buffer.byteLength(text, 'utf8') > PAIR_MAX_CHUNK_BYTES) {
          this.#theirs.delete(id);
          their.controller.abort();
          this.#replyError(id, 'too_large', '一塊超過上限');
          throw new PairSendError('too_large', '一塊超過上限');
        }
        const bytes = encodePairMessage({
          type: 'chunk',
          side: 'm',
          id,
          seq: their.seq,
          payload: text,
        });
        their.seq += 1;
        this.#enqueue(bytes);
      },
    };
    void (async () => {
      let outcome:
        { readonly ok: Json } | { readonly code: HostErrorCode; readonly message: string };
      try {
        outcome = { ok: await handler(payload, context) };
      } catch (error: unknown) {
        outcome =
          error instanceof PairCallError
            ? { code: error.code, message: error.message }
            : { code: 'service_error', message: messageOf(error) };
      }
      try {
        await this.#admitServed(id, their);
      } catch {
        return;
      }
      this.#theirs.delete(id);
      if ('code' in outcome) {
        this.#replyError(id, outcome.code, outcome.message);
        return;
      }
      let bytes: Buffer;
      try {
        bytes = encodePairMessage({ type: 'result', side: 'm', id, ok: outcome.ok });
      } catch (error: unknown) {
        if (error instanceof PairFrameTooLargeError) {
          this.#replyError(id, 'too_large', '結果超過一框');
        } else {
          this.#replyError(id, 'service_error', `結果過不了橋：${messageOf(error)}`);
        }
        return;
      }
      this.#enqueue(bytes);
    })();
  }
}
