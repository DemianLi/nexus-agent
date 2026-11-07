/**
 * per-thread 前台的全域下行（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，設計 `.docs/supervisor-1947-design-2026-11-03.md` §4-3）：
 * 前台手上沒有 thread，`/threads/feed` 的每一件都來自對話行程。
 *
 * - **每個活著的對話行程接一條**：監督行程送 `up` 時，往那個 socket 開它自己的 `/threads/feed`，收到的照原樣接進前台的
 *   {@link ThreadFeed}（{@link FeedSource}），前台的線因此跟 `single` 收到的一樣。`down` 時拆掉。
 * - **還掛著的題由這裡記**：對話行程的線開線時補送一次，前台的線各自開開關關，所以補送要前台自己做。對話行程那條線斷了
 *   （對方收掉、積壓超過上限）就先把記著的題全部撤回，重連後由它再補送一次。
 * - **在跑／閒著**：列表的 `running` 由 {@link FrontFeed.running} 答。對話行程的線接上時不補送狀態，所以接上之後問一次它的
 *   `activity`；這段期間先收到狀態框就以框為準。狀態跟前台已經講過的不同時補一顆狀態框。
 * - 行程走了（`down`）：還掛著的題撤回，在跑的補一顆「閒著」。
 *
 * @module
 */

import type { Event } from '@nexus/wire';
import { decodeSseData, isThreadFeedFrame, THREAD_FEED_PATH } from '@nexus/wire';

import type { FrontForwarder } from './front-forward.js';
import type { PumpActivity } from './thread-pump.js';
import { ThreadFeed, type FeedSource } from './thread-feed.js';
import { internalThreadPath } from './wire-handler.js';

/** 對話行程那條線斷了之後，隔多久重連。 */
const RECONNECT_MS = 1_000;

export interface FrontFeedOptions {
  readonly forwarder: FrontForwarder;
  readonly warn?: (message: string) => void;
}

/** 一則 `input.requested` 的 `interrupt_id`；拿不到就是 `undefined`（照樣轉送，只是不記）。 */
function interruptIdOf(event: Event): string | undefined {
  const data = (event as { params?: { data?: { interrupt_id?: unknown } } }).params?.data;
  return typeof data?.interrupt_id === 'string' ? data.interrupt_id : undefined;
}

class RemoteThread implements FeedSource {
  readonly threadId: string;
  readonly socket: string;
  readonly #forwarder: FrontForwarder;
  readonly #warn: (message: string) => void;
  readonly #listeners = new Set<(activity: PumpActivity) => void>();
  readonly #pending = new Map<string, Event>();
  readonly #abort = new AbortController();
  /** 前台講過的最後一個狀態；`undefined` 是還不知道（當閒著）。 */
  #running: boolean | undefined;
  #closed = false;

  constructor(
    threadId: string,
    socket: string,
    forwarder: FrontForwarder,
    warn: (message: string) => void,
  ) {
    this.threadId = threadId;
    this.socket = socket;
    this.#forwarder = forwarder;
    this.#warn = warn;
  }

  get pendings(): readonly { readonly request: Event }[] {
    return [...this.#pending.values()].map((request) => ({ request }));
  }

  get running(): boolean | undefined {
    return this.#running;
  }

  watch(listener: (activity: PumpActivity) => void): () => void {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  /** 開始接；斷了就隔 {@link RECONNECT_MS} 重連，直到 {@link close}。 */
  start(): void {
    void this.#loop();
  }

  /** 拆掉：中止往對話行程的那條，還掛著的題撤回，在跑的補一顆「閒著」。 */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#withdrawAll();
    this.#setRunning(false);
  }

  async #loop(): Promise<void> {
    while (!this.#closed) {
      try {
        await this.#follow();
      } catch (error) {
        if (this.#closed) return;
        this.#warn(
          `[下行] thread "${this.threadId}" 的對話行程那條全域下行斷了，${String(RECONNECT_MS)} 毫秒後重連：${String(error)}`,
        );
      }
      if (this.#closed) return;
      // 斷線期間答掉或收回的題聽不到：先全部撤回，重連後對方會再補送還掛著的。
      this.#withdrawAll();
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS).unref());
    }
  }

  async #follow(): Promise<void> {
    const response = await this.#forwarder.forward(
      new Request(`http://localhost${THREAD_FEED_PATH}`, {
        headers: { 'content-type': 'application/json' },
        signal: this.#abort.signal,
      }),
      this.socket,
    );
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error(`對話行程回 ${String(response.status)}`);
    }
    let statusSeen = false;
    void this.#snapshot(() => statusSeen);
    for await (const frame of decodeSseData(response.body)) {
      if (!isThreadFeedFrame(frame) || frame.threadId !== this.threadId) continue;
      if (frame.type === 'status') {
        statusSeen = true;
        this.#setRunning(frame.running);
        continue;
      }
      if (frame.type === 'input-requested') {
        const interruptId = interruptIdOf(frame.event);
        if (interruptId !== undefined) this.#pending.set(interruptId, frame.event);
        this.#tell({ type: 'input-requested', event: frame.event });
        continue;
      }
      this.#pending.delete(frame.interruptId);
      this.#tell({ type: 'input-withdrawn', interruptId: frame.interruptId });
    }
  }

  /** 線接上之後問一次在跑沒；期間先收到狀態框（`statusSeen`）就不採用。 */
  async #snapshot(statusSeen: () => boolean): Promise<void> {
    try {
      const response = await this.#forwarder.forward(
        new Request(`http://localhost${internalThreadPath(this.threadId, 'activity')}`, {
          signal: this.#abort.signal,
        }),
        this.socket,
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`對話行程回 ${String(response.status)}`);
      }
      const body = (await response.json()) as { activity?: unknown };
      if (!statusSeen() && !this.#closed && Array.isArray(body.activity)) {
        this.#setRunning(body.activity.includes('turn'));
      }
    } catch (error) {
      if (this.#closed) return;
      this.#warn(
        `[下行] 問 thread "${this.threadId}" 在跑沒失敗，等它下一顆狀態框：${String(error)}`,
      );
    }
  }

  #setRunning(running: boolean): void {
    if ((this.#running ?? false) === running) {
      this.#running = running;
      return;
    }
    this.#running = running;
    this.#tell({ type: 'status', running });
  }

  #withdrawAll(): void {
    const ids = [...this.#pending.keys()];
    this.#pending.clear();
    for (const interruptId of ids) this.#tell({ type: 'input-withdrawn', interruptId });
  }

  #tell(activity: PumpActivity): void {
    for (const listener of this.#listeners) listener(activity);
  }
}

/**
 * 前台的全域下行：跟著監督行程的 `up`／`down`，把每個對話行程那條線接進 {@link FrontFeed.connect} 給的 {@link ThreadFeed}
 * （前台本地那一支 handler 的 `WireHandlerOptions.threadFeed`）。`connect` 之前的 `up` 先記著，接上時一起接。
 */
export class FrontFeed {
  readonly #forwarder: FrontForwarder;
  readonly #warn: (message: string) => void;
  /** 監督行程講過、還在的每一條 thread 在哪個 socket 上。 */
  readonly #sockets = new Map<string, string>();
  readonly #threads = new Map<
    string,
    { readonly remote: RemoteThread; readonly detach: () => void }
  >();
  #feed: ThreadFeed | undefined;
  #closed = false;

  constructor(options: FrontFeedOptions) {
    this.#forwarder = options.forwarder;
    this.#warn = options.warn ?? (() => {});
  }

  /** 接上前台的全域下行（serve 照下行那一列的上限建好之後）。只接一次。 */
  connect(feed: ThreadFeed): void {
    if (this.#closed || this.#feed !== undefined) return;
    this.#feed = feed;
    for (const [threadId, socket] of this.#sockets) this.#attach(threadId, socket);
  }

  /** 監督行程說這條 thread 在 `socket` 上。同一個 socket 重複講不重接；換了 socket 就拆掉舊的再接。 */
  up(threadId: string, socket: string): void {
    if (this.#closed) return;
    const current = this.#sockets.get(threadId);
    if (current === socket) return;
    if (current !== undefined) this.down(threadId);
    this.#sockets.set(threadId, socket);
    if (this.#feed !== undefined) this.#attach(threadId, socket);
  }

  #attach(threadId: string, socket: string): void {
    const remote = new RemoteThread(threadId, socket, this.#forwarder, this.#warn);
    const detach = this.#feed!.attach(remote);
    this.#threads.set(threadId, { remote, detach });
    remote.start();
  }

  /** 這條的行程走了。 */
  down(threadId: string): void {
    this.#sockets.delete(threadId);
    const current = this.#threads.get(threadId);
    if (current === undefined) return;
    this.#threads.delete(threadId);
    current.remote.close();
    current.detach();
  }

  /** 列表的 `running`：這條有活著的行程就照它講的，沒有（或還不知道）是 `undefined`。 */
  running(threadId: string): boolean | undefined {
    return this.#threads.get(threadId)?.remote.running;
  }

  /** 收掉：拆掉每一條。前台的線由持有它的 handler 關。 */
  close(): void {
    this.#closed = true;
    for (const threadId of [...this.#sockets.keys()]) this.down(threadId);
  }
}
