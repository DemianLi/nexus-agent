/**
 * 從日誌推模型歷史的增量快取（[#2349](https://github.com/DemianLi/nexus-agent/issues/2349)）。
 *
 * 每次模型呼叫都從日誌推一次歷史時，整份重算（{@link deriveConversation}）的成本跟日誌長度成正比。這裡把推過的留著：
 * 同一份日誌只往後長，新的事件接著餵進 {@link ReplayFold}，推出來的那一串只往後接。事件怎麼變成訊息只有 `ReplayFold` 一份；
 * 收尾那幾步（套摘要與切點、濾空的助手訊息、套剪法、縮短與圖片省略）借 `conversation-replay.ts` 與三份紀錄模組的同一支函式逐段做。
 * 這裡管的是上一次推出來的哪些還能用。
 *
 * ## 什麼時候整份重建
 *
 * 已經推出來的那一串是「摘要＋切點之後的原始訊息、套過剪法與縮短、濾掉空的助手訊息」。新事件只往後接的時候，它只需要在
 * 尾巴接上新推出的幾則。下面這幾種事件會改到**已經推出來的**那幾則，看到就整份重建：
 *
 * - `compaction/summary`：換了摘要與切點，切點之前的都要拿掉。
 * - `compaction/prune`：記了新的剪法，對到的工具結果可能早就在串裡。
 * - `compaction/truncate-args`：記了新的參數縮短，對到的助手訊息可能早就在串裡。
 * - `image/offload`：記了新的省略，對到的人話可能早就在串裡。
 * - `session/end-seed`：座標重設，`ReplayFold.raw` 整串換掉（套摘要、濾空的助手訊息）。
 *
 * 還在等結果的那一批（{@link ReplayFold.pendingMessages}）不進已推好的那一串：之後到的結果會換掉補上的那幾則，所以每次現算接在後面。
 *
 * ## 交出去的訊息可能共用
 *
 * 兩次推導交出的陣列各是新的；訊息物件可能跨次共用（已經推好、不在還沒配齊那一批裡的那幾則一定共用），整份重算則每次都是新物件。
 * 呼叫端不能就地改它們。
 */

import { ReplayFold, settledMessages } from './conversation-replay.js';
import { offloadLoggedMessage, recordImageOffloadInto } from './image-offload-log.js';
import type { DeriveOptions, DerivedConversation } from './conversation-replay.js';
import type { NexusMessage } from './nexus-message.js';
import type { SessionEvent, SessionEventType } from './session-log.js';
import { recordArgTruncationsInto, truncateLoggedMessage } from './tool-arg-truncation-log.js';
import type { RecordedArgTruncation } from './tool-arg-truncation-log.js';
import { pruneLoggedMessage, recordPruneInto } from './tool-result-prune-log.js';
import type { RecordedPrune } from './tool-result-prune-log.js';

/** 推模型歷史的選項：{@link DeriveOptions} 去掉 `origin`（增量時它只會對新事件叫，讀者拿到的不完整）。 */
export type ModelHistoryOptions = Omit<DeriveOptions, 'origin'>;

/** 看到就把已經推出來的那一串整份重建的事件：它們會改到已經推出來的訊息，理由見檔頭。 */
export const MODEL_HISTORY_REBUILD_EVENTS: ReadonlySet<SessionEventType> =
  new Set<SessionEventType>([
    'compaction/summary',
    'compaction/prune',
    'compaction/truncate-args',
    'image/offload',
    'session/end-seed',
  ]);

/**
 * 一份日誌的增量推導。結果與 `deriveConversation(events, options)` 逐則相同。
 *
 * 同一個實例只認一份日誌：每次傳進來的事件要是上一次的延伸（前面那幾顆是同一批物件）。只認得出兩種不是延伸：比上一次短，
 * 或上一次最後一顆那一格換了物件，認出來就從頭推一次；前面其他格換掉認不出來，推出來的會錯。
 */
export class ModelHistoryCache {
  readonly #options: ModelHistoryOptions;
  #fold: ReplayFold;
  /** 上一次看到的事件數與最後一顆（認「是不是延伸」用）。 */
  #fed = 0;
  #last: SessionEvent | undefined;
  readonly #prunes = new Map<string, RecordedPrune>();
  readonly #truncations = new Map<string, Map<string, RecordedArgTruncation>>();
  readonly #offloads = new Map<number, Set<number>>();
  /** 推好、之後只會往後接的那一串；`undefined` 表示要整份重建。 */
  #stable: NexusMessage[] | undefined;
  /** `#stable` 用到 `ReplayFold.raw` 的第幾則為止。 */
  #stableRaw = 0;

  constructor(options: ModelHistoryOptions = {}) {
    this.#options = options;
    this.#fold = new ReplayFold(options);
  }

  /**
   * 推到 `events` 最後一顆為止的模型歷史。
   *
   * @param events - root 那一份日誌從頭到現在的事件，照 `seq` 排。要給一次模型呼叫用的歷史，傳它的 `model/start` 之前那一段：
   *   開著、還沒配到 `model/end` 的 `model/start` 算「模型跑過」，整份日誌還沒有任何回覆時推出來的是 `unreplayable`（`reply-missing`）。
   * @returns 同 {@link deriveConversation}；`replayed` 的 `messages` 每次是新陣列，訊息物件可能跨次共用（檔頭）。
   */
  derive(events: readonly SessionEvent[]): DerivedConversation {
    if (this.#fed > events.length || (this.#fed > 0 && events[this.#fed - 1] !== this.#last)) {
      this.#reset();
    }
    for (let index = this.#fed; index < events.length; index++) {
      const event = events[index]!;
      this.#fold.feed(event);
      if (this.#options.applyPrunes === true) recordPruneInto(this.#prunes, event);
      if (this.#options.applyArgTruncations === true) {
        recordArgTruncationsInto(this.#truncations, event);
      }
      if (this.#options.applyImageOffloads === true) recordImageOffloadInto(this.#offloads, event);
      if (MODEL_HISTORY_REBUILD_EVENTS.has(event.type)) this.#stable = undefined;
    }
    this.#fed = events.length;
    this.#last = events.at(-1);

    const failure = this.#fold.finalFailure();
    if (failure !== undefined) return { kind: 'unreplayable', ...failure };
    const stable = this.#extend();
    if (stable === undefined) {
      // 切點落在還沒配齊的那一批裡，建不起來：這一次整串現算，不留。
      return { kind: 'replayed', messages: this.#fold.settled().map((m) => this.#asSent(m)) };
    }
    const pending = settledMessages(this.#fold.pendingMessages(), undefined);
    return { kind: 'replayed', messages: [...stable, ...pending.map((m) => this.#asSent(m))] };
  }

  #reset(): void {
    this.#fold = new ReplayFold(this.#options);
    this.#fed = 0;
    this.#last = undefined;
    this.#prunes.clear();
    this.#truncations.clear();
    this.#offloads.clear();
    this.#stable = undefined;
    this.#stableRaw = 0;
  }

  /** 送出去的樣子：套剪法、縮短與圖片省略（三者各管工具結果、助手訊息與人話，互不相干）。 */
  #asSent(message: NexusMessage): NexusMessage {
    const pruned = this.#prunes.size === 0 ? message : pruneLoggedMessage(message, this.#prunes);
    const truncated =
      this.#truncations.size === 0 ? pruned : truncateLoggedMessage(pruned, this.#truncations);
    return this.#offloads.size === 0 ? truncated : offloadLoggedMessage(truncated, this.#offloads);
  }

  /** 把 `#stable` 接到 `ReplayFold.raw` 的尾巴；要重建就重建。切點還在那一批裡、建不起來時是 `undefined`。 */
  #extend(): NexusMessage[] | undefined {
    const { raw, summary } = this.#fold;
    if (this.#stable === undefined) {
      if (summary !== undefined && summary.cutoff > raw.length) return undefined;
      this.#stable = settledMessages(raw, summary).map((message) => this.#asSent(message));
      this.#stableRaw = raw.length;
      return this.#stable;
    }
    const added = settledMessages(raw.slice(this.#stableRaw), undefined);
    for (const message of added) this.#stable.push(this.#asSent(message));
    this.#stableRaw = raw.length;
    return this.#stable;
  }
}
