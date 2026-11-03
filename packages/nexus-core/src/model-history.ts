/**
 * 從日誌推模型歷史的增量快取（[#2349](https://github.com/DemianLi/nexus-agent/issues/2349)）。
 *
 * 每次模型呼叫都從日誌推一次歷史時，整份重算（{@link replayConversation}）的成本跟日誌長度成正比。這裡把推過的留著：
 * 同一份日誌只往後長，新的事件接著餵進 {@link ReplayFold}，推出來的那一串只往後接。推導規則只有 `ReplayFold` 一份，
 * 這裡只管「上一次推出來的哪些還能用」。
 *
 * ## 什麼時候整份重建
 *
 * 推出來的那一串（{@link ModelHistoryCache} 裡的 `#stable`）是「摘要＋切點之後的原始訊息、套過剪法與縮短、濾掉空的助手訊息」。
 * 新事件只往後接的時候，它只需要在尾巴接上新推出的幾則。下面這幾種事件會改到**已經推出來的**那幾則，看到就整份重建：
 *
 * - `compaction/summary`：換了摘要與切點，切點之前的都要拿掉。
 * - `compaction/prune`：記了新的剪法，對到的工具結果可能早就在串裡。
 * - `compaction/truncate-args`：記了新的參數縮短，對到的助手訊息可能早就在串裡。
 * - `session/end-seed`：座標重設，`ReplayFold.raw` 整串換掉（套摘要、濾空的助手訊息）。
 *
 * 還在等結果的那一批（{@link ReplayFold.pendingMessages}）不進 `#stable`：之後到的結果會換掉補上的那幾則，所以每次現算接在後面。
 *
 * ## 交出去的訊息是共用的
 *
 * 兩次推導交出的陣列各是新的，裡面的訊息物件卻是同一批（整份重算每次都是新物件）。呼叫端不能就地改它們。
 */

import type { BaseMessage } from '@langchain/core/messages';

import { ReplayFold, isEmptyAssistant } from './conversation-replay.js';
import type { ConversationReplay, ReplayOptions, ReplaySummary } from './conversation-replay.js';
import type { SessionEvent, SessionEventType } from './session-log.js';
import { applyRecordedArgTruncation, recordedArgTruncationsOf } from './tool-arg-truncation-log.js';
import type { RecordedArgTruncation } from './tool-arg-truncation-log.js';
import { applyRecordedPrune, recordedPrunesOf } from './tool-result-prune-log.js';
import type { RecordedPrune } from './tool-result-prune-log.js';

/** 推模型歷史的選項：{@link ReplayOptions} 去掉 `origin`（增量時它只會對新事件叫，讀者拿到的不完整）。 */
export type ModelHistoryOptions = Omit<ReplayOptions, 'origin'>;

/** 看到就整份重建 `#stable` 的事件，理由見檔頭。 */
export const MODEL_HISTORY_REBUILD_EVENTS: ReadonlySet<SessionEventType> =
  new Set<SessionEventType>([
    'compaction/summary',
    'compaction/prune',
    'compaction/truncate-args',
    'session/end-seed',
  ]);

/**
 * 一份日誌的增量推導。結果與 `replayConversation(events, options)` 逐則相同。
 *
 * 同一個實例只認一份日誌：每次傳進來的事件要是上一次的延伸（前面那幾顆是同一批物件）。不是延伸就從頭推一次。
 */
export class ModelHistoryCache {
  readonly #options: ModelHistoryOptions;
  #fold: ReplayFold;
  /** 已經餵進 `#fold` 的事件數，與最後一顆（認「是不是延伸」用）。 */
  #fed = 0;
  #last: SessionEvent | undefined;
  readonly #prunes = new Map<string, RecordedPrune>();
  readonly #truncations = new Map<string, Map<string, RecordedArgTruncation>>();
  /** 推好、之後只會往後接的那一串；`undefined` 表示要整份重建。 */
  #stable: BaseMessage[] | undefined;
  /** `#stable` 用到 `ReplayFold.raw` 的第幾則為止。 */
  #stableRaw = 0;

  constructor(options: ModelHistoryOptions = {}) {
    this.#options = options;
    this.#fold = new ReplayFold(options);
  }

  /**
   * 推到 `events` 最後一顆為止的模型歷史。
   *
   * @param events - root 那一份日誌從頭到現在的事件，照 `seq` 排。
   * @returns 同 {@link replayConversation}；`replayed` 的 `messages` 每次是新陣列，訊息物件跨次共用（檔頭）。
   */
  derive(events: readonly SessionEvent[]): ConversationReplay {
    if (this.#fed > events.length || (this.#fed > 0 && events[this.#fed - 1] !== this.#last)) {
      this.#reset();
    }
    for (let index = this.#fed; index < events.length; index++) {
      const event = events[index]!;
      if (this.#fold.failure === undefined) this.#fold.feed(event);
      this.#record(event);
      if (MODEL_HISTORY_REBUILD_EVENTS.has(event.type)) this.#stable = undefined;
    }
    this.#fed = events.length;
    this.#last = events.at(-1);

    const failure = this.#fold.finalFailure();
    if (failure !== undefined) return { kind: 'unreplayable', ...failure };
    const stable = this.#extend();
    const pending = this.#fold
      .pendingMessages()
      .filter((message) => !isEmptyAssistant(message))
      .map((message) => this.#asSent(message));
    if (stable === undefined) {
      // 切點落在還沒配齊的那一批裡：先補齊再切，跟 `ReplayFold.settled` 一樣現算，這一次不留。
      return { kind: 'replayed', messages: this.#fold.settled().map((m) => this.#asSent(m)) };
    }
    return { kind: 'replayed', messages: [...stable, ...pending] };
  }

  #reset(): void {
    this.#fold = new ReplayFold(this.#options);
    this.#fed = 0;
    this.#last = undefined;
    this.#prunes.clear();
    this.#truncations.clear();
    this.#stable = undefined;
    this.#stableRaw = 0;
  }

  /** 剪法與縮短逐顆累積，規則同 `recordedPrunesOf`／`recordedArgTruncationsOf`：同一個 callId（與參數）後記的蓋前記的。 */
  #record(event: SessionEvent): void {
    if (this.#options.applyPrunes === true && event.type === 'compaction/prune') {
      for (const [callId, prune] of recordedPrunesOf([event])) this.#prunes.set(callId, prune);
    }
    if (this.#options.applyArgTruncations === true && event.type === 'compaction/truncate-args') {
      for (const [callId, args] of recordedArgTruncationsOf([event])) {
        let merged = this.#truncations.get(callId);
        if (merged === undefined) this.#truncations.set(callId, (merged = new Map()));
        for (const [key, truncation] of args) merged.set(key, truncation);
      }
    }
  }

  /** 送出去的樣子：套剪法與縮短（兩者各管工具結果與助手訊息，互不相干）。 */
  #asSent(message: BaseMessage): BaseMessage {
    const pruned = this.#prunes.size === 0 ? message : applyRecordedPrune(message, this.#prunes);
    return this.#truncations.size === 0
      ? pruned
      : applyRecordedArgTruncation(pruned, this.#truncations);
  }

  /** 把 `#stable` 接到 `ReplayFold.raw` 的尾巴；要重建就重建。切點還在那一批裡、建不起來時是 `undefined`。 */
  #extend(): BaseMessage[] | undefined {
    const { raw, summary } = this.#fold;
    if (this.#stable === undefined) {
      if (summary !== undefined && summary.cutoff > raw.length) return undefined;
      this.#stable = head(summary).map((message) => this.#asSent(message));
      this.#stableRaw = summary?.cutoff ?? 0;
    }
    for (; this.#stableRaw < raw.length; this.#stableRaw++) {
      const message = raw[this.#stableRaw]!;
      if (!isEmptyAssistant(message)) this.#stable.push(this.#asSent(message));
    }
    return this.#stable;
  }
}

/** 摘要那一則（有的話），濾法同 `ReplayFold.settled`。 */
function head(summary: ReplaySummary | undefined): BaseMessage[] {
  return summary === undefined || isEmptyAssistant(summary.message) ? [] : [summary.message];
}
