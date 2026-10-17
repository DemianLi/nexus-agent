/**
 * 全部 thread 共用的那條下行的集線器（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）。契約見
 * `@nexus/wire` 的 `THREAD_FEED_PATH`。
 *
 * 照 dsh gateway 的 remote event 串流（`packages/api/gateway/src/index.ts:490-600`，`477b4f4`）：
 *
 * - 每條 thread 的 pump 一建好就接上來（{@link ThreadFeed.attach}），它講的 {@link PumpActivity} 補上 `threadId`
 *   廣播給每一條線。
 * - **一條線接上的當下補送所有 thread 還掛著的 `input.requested`**，同 dsh 的 `pendingRemoteEvents`（`:500`）。
 *   快照與註冊在同一段同步程式裡，中間沒有空檔讓一題兩邊都沒有或兩邊都有。
 * - 狀態不補送：起點是列表，同 dsh 的 `reconcileStatus`。
 *
 * **每條線的佇列有位元組上限**（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504)）：對方不收的線積壓超過上限就收掉這一條，
 * 其他線不受影響。dsh 對應的 `RemoteEventQueue` 沒有這一層，偏離 B／C 的登記與理由見 `bounded-event-queue.ts`。
 *
 * @module
 */

import type { ThreadFeedFrame } from '@nexus/wire';

import { BoundedQueue, DEFAULT_DOWNLINK_MAX_BYTES, frameBytes } from './bounded-event-queue.js';
import type { PumpActivity, ThreadPump } from './thread-pump.js';

interface FeedSubscriber {
  readonly queue: BoundedQueue<ThreadFeedFrame>;
  done: boolean;
  wake?: () => void;
}

export interface ThreadFeedOptions {
  /** 每條線排著的位元組上限；預設 {@link DEFAULT_DOWNLINK_MAX_BYTES}。 */
  readonly maxQueuedBytes?: number;
  /** 收掉一條線時往哪裡講（一行，不含 thread 內容）。省略就不講。 */
  readonly warn?: (message: string) => void;
}

export class ThreadFeed {
  readonly #maxQueuedBytes: number;
  readonly #warn: ((message: string) => void) | undefined;
  readonly #pumps = new Map<string, ThreadPump>();
  readonly #subscribers = new Set<FeedSubscriber>();
  #closed = false;

  constructor(options: ThreadFeedOptions = {}) {
    this.#maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_DOWNLINK_MAX_BYTES;
    this.#warn = options.warn;
  }

  /**
   * 接上一條 thread。**要在那條 pump 收下任何一件之前接**：之前講的狀態與中斷這裡聽不到。
   *
   * @returns 拆掉。
   */
  attach(pump: ThreadPump): () => void {
    const threadId = pump.threadId;
    this.#pumps.set(threadId, pump);
    const unwatch = pump.watch((activity: PumpActivity) => {
      this.#broadcast({ ...activity, threadId } as ThreadFeedFrame);
    });
    return () => {
      unwatch();
      if (this.#pumps.get(threadId) === pump) this.#pumps.delete(threadId);
    };
  }

  /**
   * 開一條線。**註冊是同步的**，同 `ThreadPump.subscribe`：回傳之後才發生的一顆都不會掉。
   *
   * @param signal - 中止這條線。
   */
  subscribe(signal?: AbortSignal): AsyncGenerator<ThreadFeedFrame, void, undefined> {
    const subscriber: FeedSubscriber = {
      queue: new BoundedQueue(this.#maxQueuedBytes),
      done: this.#closed,
    };
    if (!subscriber.done) {
      try {
        for (const [threadId, pump] of this.#pumps) {
          // 每條 thread 裡照號排，理由同 `ThreadPump.subscribe`：同 id 再中斷時 Map 的順序不是發出的順序。
          const requests = pump.pendings
            .map((pending) => pending.request)
            .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
          for (const event of requests) {
            // 補送照算位元組、不判上限：一開線就斷了又重連，只會再補送一次（見 `BoundedQueue.seed`）。
            const frame: ThreadFeedFrame = { type: 'input-requested', threadId, event };
            subscriber.queue.seed(frame, frameBytes(frame));
          }
        }
      } catch (error: unknown) {
        // 補送的某一顆序列化不了：這條線送不出完整的「現在」，收掉它（會重連），記一行。
        subscriber.done = true;
        subscriber.queue.clear();
        this.#warn?.(
          `[下行] 全域下行開線時補送的事件無法序列化，已斷開這一條：${errorText(error)}`,
        );
      }
    }
    this.#subscribers.add(subscriber);
    return this.#drain(subscriber, signal);
  }

  /** 目前有幾條線掛著。給測試看的。 */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /** 收掉：掛著的線正常結束，之後接上的直接結束。 */
  close(): void {
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.done = true;
      subscriber.wake?.();
    }
  }

  #broadcast(frame: ThreadFeedFrame): void {
    // 位元組數**廣播時算一次**，每條線共用；沒有線在收就不算。
    let bytes: number | undefined;
    for (const subscriber of this.#subscribers) {
      if (subscriber.done) continue;
      if (bytes === undefined) {
        try {
          bytes = frameBytes(frame);
        } catch (error: unknown) {
          // 這一顆對每條線都送不出去：收掉所有在收的線、記一行，函式正常返回——
          // 錯誤不能打回產生事件的那條路徑（`pump.watch` 的回呼跑在 pump 的廣播上）。
          this.#failAll(error);
          return;
        }
      }
      if (subscriber.queue.push(frame, bytes)) {
        subscriber.wake?.();
      } else {
        this.#evict(subscriber);
      }
    }
  }

  /** 積壓超過上限：同步從名單拿掉（不再收、不再算進 `subscriberCount`），清空，叫醒 drain 讓它結束這條線。 */
  #evict(subscriber: FeedSubscriber): void {
    subscriber.done = true;
    subscriber.queue.clear();
    this.#subscribers.delete(subscriber);
    subscriber.wake?.();
    this.#warn?.(
      `[下行] 全域下行有一條線積壓超過 ${String(this.#maxQueuedBytes)} 位元組，已斷開（它會自己重連）`,
    );
  }

  #failAll(error: unknown): void {
    let closed = 0;
    for (const subscriber of this.#subscribers) {
      if (subscriber.done) continue;
      subscriber.done = true;
      subscriber.queue.clear();
      this.#subscribers.delete(subscriber);
      subscriber.wake?.();
      closed += 1;
    }
    this.#warn?.(
      `[下行] 全域下行有一顆事件無法序列化，已斷開 ${String(closed)} 條線：${errorText(error)}`,
    );
  }

  async *#drain(
    subscriber: FeedSubscriber,
    signal?: AbortSignal,
  ): AsyncGenerator<ThreadFeedFrame, void, undefined> {
    const onAbort = () => {
      subscriber.done = true;
      subscriber.wake?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    // 已經中止的訊號不會再觸發 `abort`。
    if (signal?.aborted === true) onAbort();
    try {
      for (;;) {
        while (subscriber.queue.length > 0) {
          yield subscriber.queue.shift() as ThreadFeedFrame;
        }
        if (subscriber.done) return;
        await new Promise<void>((resolve) => {
          subscriber.wake = resolve;
        });
        subscriber.wake = undefined;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.#subscribers.delete(subscriber);
    }
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
