/**
 * 下行訂閱者的**位元組有界佇列**（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504)，Q2 (a)）。`ThreadPump`
 * （每條 thread 的下行）與 `ThreadFeed`（全域下行）共用這一份，不寫兩份。
 *
 * ## 照 dsh 的哪裡
 *
 * 形狀與語意照 `TerminalFollower`（`packages/api/terminal-controller/src/stream.ts:5-87`，`1517a4db`，與 `687f282e` 的 blob 相同）：
 * 每顆以 `Buffer.byteLength(JSON.stringify(frame), 'utf8')` 計，`已排位元組 + 這顆 > 上限` 就失敗並清空佇列，只斷這一個訂閱者；
 * 上限預設 `2 * 1024 * 1024`（`terminal-controller/src/index.ts:87`）。底下的容器用 {@link Deque}（`@nexus/deque`，原碼照抄
 * dsh `packages/util/deque`），和 dsh 的 `RemoteEventQueue`（`packages/api/gateway/src/index.ts:1172-1210`）、`TerminalFollower` 一樣，
 * 不用 `Array.shift()`（O(n)）。
 *
 * ## 偏離 B：事件下行加位元組上限（理由 2：產品需求超出 dsh）
 *
 * **dsh 的事件下行沒有這一層**：跟 `ThreadFeed` 對應的 `RemoteEventQueue` 是沒有上限的 `Deque`，dsh 對事件下行的保護只有寫入等完成與
 * 死線淘汰（`wire-server.ts` 檔頭）。我們是一台主機多人共用：一個分頁的積壓吃掉的是同機每個人的記憶體，而偏離 A 的死線判準又抓不到
 * 「慢慢 drain、但比生產慢」的線。補的是 `TerminalFollower` 的形狀，數字與語意照抄。
 *
 * ## 偏離 C：超限、死線或序列化失敗時只斷線，不送終止 frame（理由 1：基座表達不出來）
 *
 * dsh 斷之前會送一顆錯誤訊框（`stream-server.ts:279-288`）。我們的 SSE 協定沒有中途錯誤 frame 的位置，只有開線那一下的
 * 200＋error 封包（#1481）。web 遇到下行結束本來就走重連並重抓歷史（`apps/web/src/hooks/use-conversation.ts` 的 `lose(undefined)`），
 * 用戶端看到的結果跟 dsh 一樣是「連線中斷→重連」。退到：serve 記一行 warn，斷線。**這一條擴及序列化失敗**（算位元組的
 * `JSON.stringify` 拋錯，見 {@link frameBytes}）：那顆事件對所有該收的訂閱者都送不出去，收線並記一行 warn，錯誤不回到產生事件的路徑。
 *
 * @module
 */

import { Deque } from '@nexus/deque';

/** 每條下行線的位元組上限預設值：2 MiB，照 dsh `maxBufferedBytes` 的預設。 */
export const DEFAULT_DOWNLINK_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 一顆 frame 在佇列裡算多少位元組：`JSON.stringify` 後的 UTF-8 長度，照 `TerminalFollower`。
 *
 * **會拋**：`JSON.stringify` 遇到循環參照或 `BigInt` 就拋。呼叫端要接住——廣播一顆事件的路徑上拋出去，錯誤就回到產生事件的那條路徑了。
 *
 * @param frame - 要送的那顆（已蓋號、已加 `threadId` 的樣子）。
 */
export function frameBytes(frame: unknown): number {
  const json = JSON.stringify(frame);
  // `JSON.stringify(undefined)`／函式回 `undefined`：沒有東西可送，也就不算位元組。
  return json === undefined ? 0 : Buffer.byteLength(json, 'utf8');
}

/** 位元組有界的 FIFO。單一訂閱者一份。 */
export class BoundedQueue<T> {
  readonly #items = new Deque<{ readonly item: T; readonly bytes: number }>();
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  /** 排著幾顆。 */
  get length(): number {
    return this.#items.size;
  }

  /**
   * 即時推一顆。**只有這條路判上限**：`已排 + 這顆 > 上限` 就不收，回 `false`，由呼叫端清空並收掉這條線。
   *
   * @param bytes - {@link frameBytes} 算出來的；一次廣播算一次、每條線共用。
   * @returns 收下了沒有。
   */
  push(item: T, bytes: number): boolean {
    if (this.#bytes + bytes > this.#maxBytes) return false;
    this.#items.pushBack({ item, bytes });
    this.#bytes += bytes;
    return true;
  }

  /**
   * 開線時的補送：照算位元組，但**不判上限**。一則很長的補送（還沒落盤的回覆）不能一開線就把線斷了——斷了又重連、又補送、又斷。
   * 之後的即時 push 看得到這些位元組，所以補送占滿的線，下一顆即時事件就會超限。
   */
  seed(item: T, bytes: number): void {
    this.#items.pushBack({ item, bytes });
    this.#bytes += bytes;
  }

  /** 取走最前面那顆；空的回 `undefined`（用 {@link length} 分辨 `T` 本身可能是 `undefined` 的情形）。 */
  shift(): T | undefined {
    const next = this.#items.popFront();
    if (next === undefined) return undefined;
    this.#bytes -= next.bytes;
    return next.item;
  }

  /** 清空並放掉底層儲存。 */
  clear(): void {
    this.#items.clear();
    this.#bytes = 0;
  }
}
