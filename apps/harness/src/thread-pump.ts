/**
 * 下行 pump：把 N 個 run 物件接成一條長期串流。
 *
 * **這是這一層存在的全部理由。** 一場對話不是一個 run 物件——停在核准點時 run 就收掉，
 * `streamEvents(new Command({ resume }), …)` 回的是**另一個** run 物件，而且只帶
 * resume 之後的訊息。把某一個 run 直接交給瀏覽器，核准一次就斷一次線。
 *
 * 量到而且會無聲壞掉的四件事（見開發計劃第 7 節決策 6）：
 *
 * 1. **`seq` 在每個 run 上從 0 重來**，所以接起來的時候一定要重新編號；照原樣轉出去
 *    的話瀏覽器那側的排序與去重會靜靜地壞掉——seq 不會變小到看得出來，它是一段一段重來。
 * 2. **`lifecycle` 的 `{ event:'completed', graph_name:'root' }` 在中斷時照樣會發**，
 *    所以它不是關線的訊號。拿它關線的話每按一次核准就斷一次。
 * 3. **中斷時 raw iteration 乾淨結束、不拋**，所以 pump 從頭到尾不必碰 `run.output`
 *    （那個「暫停時 `await run.output` 會炸」的陷阱屬於核准 UI 那一端）。
 * 4. **失敗會先上線再拋**：最後一顆 frame 是 `lifecycle { event:'failed', … , error }`，
 *    然後 iteration 才 throw。所以這裡的 try/catch 是用來收尾的，不是用來補錯誤 frame 的。
 */

import { HumanMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { Event, WireChannel } from '@nexus/wire';
import { channelOfMethod, eventId } from '@nexus/wire';

/** 基座 v3 run 抽出來的一顆原始封包（`GraphRunStream implements AsyncIterable<ProtocolEvent>`）。 */
interface RawProtocolEvent {
  readonly type: 'event';
  readonly seq: number;
  readonly method: string;
  readonly params: {
    readonly namespace: string[];
    readonly timestamp: number;
    readonly node?: string;
    readonly data: unknown;
  };
}

/** pump 對 agent 的全部要求：給我一個可抽的 v3 run。 */
export interface PumpAgent {
  streamEvents(
    input: never,
    config: { readonly version: 'v3'; readonly configurable: { readonly thread_id: string } },
  ): Promise<AsyncIterable<RawProtocolEvent>>;
}

/** 送進去的東西：一句話，或一組核准決定。 */
export type PumpInput =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'resume'; readonly response: unknown };

interface Subscriber {
  readonly channels: readonly WireChannel[];
  readonly queue: Event[];
  wake?: () => void;
  done: boolean;
}

/** 基座把中斷發在 `updates` 上的那一顆的 data 形狀。 */
interface InterruptEntry {
  readonly id: string;
  readonly value: unknown;
}

function asInterruptEntries(data: unknown): readonly InterruptEntry[] {
  // `updates` 的 data 是 `{ node, values }`，中斷那一顆的 values 才是中斷清單。
  const values = (data as { values?: unknown } | null)?.values;
  if (!Array.isArray(values)) {
    return [];
  }
  return values.filter(
    (entry): entry is InterruptEntry =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as InterruptEntry).id === 'string',
  );
}

export class ThreadPump {
  readonly #agent: PumpAgent;
  readonly #threadId: string;
  readonly #subscribers = new Set<Subscriber>();
  #seq = 0;
  /** 一個 thread 一次只跑一個 run；後到的 submit 排隊，不平行跑。 */
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(agent: PumpAgent, threadId: string) {
    this.#agent = agent;
    this.#threadId = threadId;
  }

  get threadId(): string {
    return this.#threadId;
  }

  /**
   * 開一條下行。它**跨 run 存活**：核准前後是同一條線。
   *
   * 沒有重播——訂閱之前發生的事這條線上看不到，接回來的方式是重開 ＋ 重抓歷史
   * （照 dsh 的 `reconnection = reopen the stream + refetch history`）。
   */
  subscribe(
    channels: readonly WireChannel[],
    signal?: AbortSignal,
  ): AsyncGenerator<Event, void, undefined> {
    // **註冊是同步的**，抽是之後的事。這樣「線開好了」與「開始抽」才是兩件事——
    // 開好之後才發生的 frame 一顆都不會掉在中間，即使消費端還沒開始抽。
    const subscriber: Subscriber = { channels, queue: [], done: this.#closed };
    this.#subscribers.add(subscriber);
    return this.#drain(subscriber, signal);
  }

  async *#drain(
    subscriber: Subscriber,
    signal?: AbortSignal,
  ): AsyncGenerator<Event, void, undefined> {
    const onAbort = () => {
      // **中止的是這條線，不是 run。** 瀏覽器關掉分頁不該讓 agent 停下來。
      subscriber.done = true;
      subscriber.wake?.();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        while (subscriber.queue.length > 0) {
          yield subscriber.queue.shift() as Event;
        }
        if (subscriber.done) {
          return;
        }
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

  /** 目前有幾條下行掛著。給 handler 與測試看的。 */
  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  /**
   * 送一件事進去，排在目前那一輪後面跑。
   *
   * 回傳的 promise 在**這一段** run 抽完時 resolve（跑完或停在核准點都算）。
   * 上行的 handler 不等它——那是收件回條，不是「跑完了」。
   */
  submit(input: PumpInput): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('這條 thread 已經收掉了'));
    }
    const next = this.#tail.then(() => this.#runOnce(input));
    // 排隊用的鏈不能因為某一輪炸掉就整條斷掉。
    this.#tail = next.catch(() => undefined);
    return next;
  }

  /** 等目前排隊的都跑完。測試用。 */
  async whenIdle(): Promise<void> {
    await this.#tail;
  }

  /** 收線。掛著的下行會正常結束，不是拋錯。 */
  close(): void {
    this.#closed = true;
    for (const subscriber of this.#subscribers) {
      subscriber.done = true;
      subscriber.wake?.();
    }
  }

  async #runOnce(input: PumpInput): Promise<void> {
    const payload =
      input.kind === 'message'
        ? { messages: [new HumanMessage(input.text)] }
        : new Command({ resume: input.response });
    const run = await this.#agent.streamEvents(payload as never, {
      version: 'v3',
      configurable: { thread_id: this.#threadId },
    });

    try {
      for await (const raw of run) {
        for (const event of this.#translate(raw)) {
          this.#broadcast(event);
        }
      }
    } catch (error) {
      // 失敗的原因已經以 `lifecycle failed` 上了線（實測：失敗 frame 先發、然後才拋），
      // 所以這裡不再合成一顆。下行**不關**——這條線是長期的，下一次 submit 還要用。
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 一顆原始封包 → 零到多顆線上的封包。 */
  *#translate(raw: RawProtocolEvent): Generator<Event> {
    if (raw.method === 'updates' && raw.params.node === '__interrupt__') {
      // 基座把中斷發在 `updates` 上（`node: "__interrupt__"`），不發協定裡的
      // `input.requested`。這裡補上那一顆——順帶讓 `updates` 整條留在白名單外，
      // 它每一顆都夾著完整序列化的訊息。
      for (const entry of asInterruptEntries(raw.params.data)) {
        yield this.#seal({
          method: 'input.requested',
          params: {
            namespace: raw.params.namespace,
            timestamp: raw.params.timestamp,
            data: { interrupt_id: entry.id, payload: entry.value },
          },
        } as Event);
      }
      return;
    }

    if (channelOfMethod(raw.method) === undefined) {
      return;
    }
    yield this.#seal({
      method: raw.method,
      params: {
        namespace: raw.params.namespace,
        timestamp: raw.params.timestamp,
        ...(raw.params.node === undefined ? {} : { node: raw.params.node }),
        data: raw.params.data,
      },
    } as Event);
  }

  /** 蓋上這條 thread 自己的編號——**不是 run 的 `seq`**，那個每個 run 都從 0 重來。 */
  #seal(event: Event): Event {
    const seq = this.#seq++;
    return { ...event, type: 'event', seq, event_id: eventId(this.#threadId, seq) };
  }

  #broadcast(event: Event): void {
    const channel = channelOfMethod(event.method);
    for (const subscriber of this.#subscribers) {
      if (subscriber.done || channel === undefined || !subscriber.channels.includes(channel)) {
        continue;
      }
      subscriber.queue.push(event);
      subscriber.wake?.();
    }
  }
}
