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
 * @module
 */

import type { ThreadFeedFrame } from '@nexus/wire';

import type { PumpActivity, ThreadPump } from './thread-pump.js';

interface FeedSubscriber {
  readonly queue: ThreadFeedFrame[];
  done: boolean;
  wake?: () => void;
}

export class ThreadFeed {
  readonly #pumps = new Map<string, ThreadPump>();
  readonly #subscribers = new Set<FeedSubscriber>();
  #closed = false;

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
    const subscriber: FeedSubscriber = { queue: [], done: this.#closed };
    if (!subscriber.done) {
      for (const [threadId, pump] of this.#pumps) {
        // 每條 thread 裡照號排，理由同 `ThreadPump.subscribe`：同 id 再中斷時 Map 的順序不是發出的順序。
        const requests = pump.pendings
          .map((pending) => pending.request)
          .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        for (const event of requests) {
          subscriber.queue.push({ type: 'input-requested', threadId, event });
        }
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
    for (const subscriber of this.#subscribers) {
      if (subscriber.done) continue;
      subscriber.queue.push(frame);
      subscriber.wake?.();
    }
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
