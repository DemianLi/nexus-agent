/**
 * per-thread 的回合失敗計數（[#2341](https://github.com/DemianLi/nexus-agent/issues/2341)，`/metrics` 的 `nexus_turn_failures_total`）：
 * 一輪在對話行程裡失敗，計數在前台。
 *
 * - **推，不拉**：對話行程失敗的當下推給前台（`internalThreadPath(id, 'turn-failures')`，一條 SSE），前台照收到的累加。抓取時才去各行程
 *   拉回來加總的話，行程一走（閒置收掉、逐出、死掉）總數就往下掉，counter 不單調，`rate()` 會算錯。
 * - **還沒送出去的留著**：沒有前台接著時（`up` 之前、前台重起的空檔）失敗的，留到下一條線接上時一起送。
 * - **漏的**：已經寫進線、前台還沒讀到時線斷了的那幾筆；行程在推之前就死掉的那一筆。
 *
 * @module
 */

import { decodeSseData } from '@nexus/wire';

import type { FrontForwarder } from './front-forward.js';
import { internalThreadPath } from './wire-handler.js';

/** 線斷了之後，隔多久重連。 */
const RECONNECT_MS = 1_000;

/** 線上的一框：這個失敗碼又失敗了幾次。 */
interface FailureFrame {
  readonly code: string;
  readonly count: number;
}

function isFailureFrame(value: unknown): value is FailureFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    Number.isSafeInteger((value as { count?: unknown }).count) &&
    (value as { count: number }).count > 0
  );
}

const encoder = new TextEncoder();

function frameOf(code: string, count: number): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify({ code, count } satisfies FailureFrame)}\n\n`);
}

/** 對話行程這一側：記失敗、交給接著的那一條線。同時只有一條（前台只有一個；新的接上就收掉舊的）。 */
export class TurnFailureOutbox {
  readonly #pending = new Map<string, number>();
  #subscriber: ReadableStreamDefaultController<Uint8Array> | undefined;

  /** 一輪失敗了。 */
  record(code: string): void {
    if (this.#subscriber !== undefined) {
      try {
        this.#subscriber.enqueue(frameOf(code, 1));
        return;
      } catch {
        this.#subscriber = undefined;
      }
    }
    this.#pending.set(code, (this.#pending.get(code) ?? 0) + 1);
  }

  /** 前台來接：先送留著的，之後每失敗一次送一框。 */
  stream(): Response {
    const previous = this.#subscriber;
    this.#subscriber = undefined;
    try {
      previous?.close();
    } catch {
      // 已經關了。
    }
    let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        mine = controller;
        this.#subscriber = controller;
        for (const [code, count] of this.#pending) controller.enqueue(frameOf(code, count));
        this.#pending.clear();
      },
      cancel: () => {
        if (this.#subscriber === mine) this.#subscriber = undefined;
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' },
    });
  }
}

export interface FrontTurnFailuresOptions {
  readonly forwarder: FrontForwarder;
  readonly warn?: (message: string) => void;
}

/**
 * 前台這一側：跟著監督行程的 `up`／`down`，每個對話行程接一條線，收到的交給 {@link FrontTurnFailures.countWith} 給的那一支。
 * 沒接之前（指標關著就一直不接）不開線。
 */
export class FrontTurnFailures {
  readonly #forwarder: FrontForwarder;
  readonly #warn: (message: string) => void;
  readonly #sockets = new Map<string, string>();
  readonly #lines = new Map<string, AbortController>();
  #count: ((code: string, count: number) => void) | undefined;
  #closed = false;

  constructor(options: FrontTurnFailuresOptions) {
    this.#forwarder = options.forwarder;
    this.#warn = options.warn ?? (() => {});
  }

  /** 接上計數的那一支；之前講過的 `up` 這時才開線。 */
  countWith(count: (code: string, count: number) => void): void {
    this.#count = count;
    for (const [threadId, socket] of this.#sockets) this.#open(threadId, socket);
  }

  up(threadId: string, socket: string): void {
    if (this.#closed || this.#sockets.get(threadId) === socket) return;
    this.down(threadId);
    this.#sockets.set(threadId, socket);
    if (this.#count !== undefined) this.#open(threadId, socket);
  }

  down(threadId: string): void {
    this.#sockets.delete(threadId);
    this.#lines.get(threadId)?.abort();
    this.#lines.delete(threadId);
  }

  close(): void {
    this.#closed = true;
    for (const threadId of [...this.#sockets.keys()]) this.down(threadId);
  }

  #open(threadId: string, socket: string): void {
    const abort = new AbortController();
    this.#lines.set(threadId, abort);
    void this.#loop(threadId, socket, abort.signal);
  }

  async #loop(threadId: string, socket: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const response = await this.#forwarder.forward(
          new Request(`http://localhost${internalThreadPath(threadId, 'turn-failures')}`, {
            signal,
          }),
          socket,
        );
        if (!response.ok || response.body === null) {
          await response.body?.cancel();
          throw new Error(`對話行程回 ${String(response.status)}`);
        }
        for await (const frame of decodeSseData(response.body)) {
          if (isFailureFrame(frame)) this.#count?.(frame.code, frame.count);
        }
      } catch (error) {
        if (signal.aborted) return;
        this.#warn(
          `[指標] thread "${threadId}" 的回合失敗那條線斷了，${String(RECONNECT_MS)} 毫秒後重連：${String(error)}`,
        );
      }
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_MS).unref());
    }
  }
}
