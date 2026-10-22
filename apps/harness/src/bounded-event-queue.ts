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
 * 200＋error 封包（#1481）。web 遇到下行結束本來就走重連並重抓歷史（`apps/web/src/hooks/use-conversation.ts` 的 `lose(undefined)`）。
 * 退到：serve 記一行 warn，斷線。**這一條擴及序列化失敗**（算位元組的 `JSON.stringify` 拋錯，見 {@link frameBytes}）：那顆事件對所有
 * 該收的訂閱者都送不出去，收線並記一行 warn，錯誤不回到產生事件的路徑。
 *
 * **更正（#1384，N1384）**：這裡原本寫「用戶端看到的結果跟 dsh 一樣是『連線中斷→重連』」，不對。dsh 的 gateway 對序列化失敗送的是
 * 那一條 logical stream 的終止 `error` frame（`gateway/internal`），實體連線不斷，客戶端把它當終止錯誤、**不重連**
 * （`gateway/src/client/remote-stream.ts:132` 的 `terminalStreamFailure`）；重連只發生在 socket 被關的 carrier 路徑。我們斷線之後
 * 的重連是我們這邊 SSE 協定的退讓，不是 dsh 的行為。偏離的理由（1）不變，等價宣稱收回。
 *
 * ## 偏離 D：下行副本的巢狀深度截斷（理由 2：產品需求超出 dsh，#1560 N1384）
 *
 * 下行的 `JSON.stringify` 是遞迴的：模型給出幾千層巢狀的工具參數時，那顆 `messages` 事件在 Linux 的預設 stack 上約 5000 層就
 * `Maximum call stack size exceeded`（macOS 不會；實測 Linux Node 22.23.3，5000 層斷線、2000 層無事）。上面偏離 C 的處理是斷線，
 * 於是客戶端只看到串流斷了、重連，而這一輪其實已經以 `NESTING_TOO_DEEP` 失敗（日誌那一關正確擋下）。{@link boundFrame} 在序列化之前
 * 把超過 {@link DOWNLINK_MAX_DEPTH} 層的子樹換成 {@link DEPTH_TRUNCATED}，下行不斷，之後 root 的 `lifecycle failed` 照常到。
 *
 * - **dsh 的對照**：gateway 沒有預檢（遞迴 `JSON.stringify`，失敗送終止 `error` frame，見上）；headless NDJSON 投影
 *   （`packages/bundle/headless/src/json-stream.ts:65-89`，`687f282e`）有 `MAX_DEPTH = 64`、超過換成 `'[truncated: depth]'`，註解點名的就是
 *   這個情境。我們採後者的做法（壓形狀）、前者的標記字串。dsh 的事件裡工具參數是模型吐的原始字串，不會以巢狀物件進事件流；
 *   我們的 `messages` 事件帶 parse 後的物件，這是結構差異。
 * - **為什麼不用 64**：64 是 headless 專用；套到 web 下行會截掉合法的深值。我們的門檻只截「連日誌都收不下」的那一類。
 * - **為什麼是 1200**：日誌的上限是 {@link SESSION_EVENT_MAX_DEPTH}（600）；`toLoggedMessage` 的預檢門檻是它的兩倍（
 *   `nexus-core/src/logged-message.ts` 的 `PRECHECK_DEPTH`，理由：超過兩倍的訊息包進事件後一定也超過上限）。這裡取同一個數，所以被截的
 *   一定是日誌也收不下、那一輪必以 `NESTING_TOO_DEEP` 失敗的訊息，**截斷不改變哪些訊息記得進去**。同時 1200 在實測可行的 2000 層之下。
 * - **深度量法，與 `logged-message.ts` 的 `nestingExceeds` 差在哪**：走法一樣（迭代、每個物件只走一次、根是容器算第 1 層、純量不算），
 *   差在「什麼算容器」。`nestingExceeds` 量的是 `BaseMessage`，那是 class 實例，欄位一路是 `lc_kwargs`、物件，所以**任何 `typeof` 是 `object`
 *   的都算一層**。這裡量的是**要被 `JSON.stringify` 的 frame**：`Date`、帶 `toJSON` 的物件序列化成純量，不增加遞迴深度，也不能被複製
 *   （複製會丟掉原型與 `toJSON`），所以只有陣列與純物件（原型是 `Object.prototype` 或 `null`）算容器、才下探，其餘原樣留著。兩邊的謂詞
 *   不同，共用 `exceedsDepth` 就得給 `nexus-core` 加一個帶謂詞的匯出，而 `logged-message.ts` 是日誌那一條線的檔案，不在這張動。
 *   門檻關係如上。
 * - **輸出深度的上界**：frame 是樹（模型回的 JSON 解析出來的東西沒有共用）時，副本深度 ≤ {@link DOWNLINK_MAX_DEPTH}。有共用的子物件
 *   （DAG；`BaseMessage` 的 `lc_kwargs` 與欄位指到同一份就是）時，{@link truncateDepth} 讓同一個來源物件只複製一份、各處共用，那一份是依
 *   **第一次遇到**的深度截的，從較淺處再指到它時副本會比 {@link DOWNLINK_MAX_DEPTH} 深；上界是**原物件的深度**（副本是原圖的子圖，
 *   指標要嘛照搬、要嘛換成佔位）。這時若 `JSON.stringify` 仍爆堆疊，照偏離 C 斷線，不比沒有這一層更糟。要嚴格的上界得放棄共用副本
 *   （`JSON.stringify` 本來就會把共用的子物件各寫一遍，輸出大小也就跟著指數成長），這張不做。
 * - **撤除條件**（只有這兩條，PR 內文同）：① 下行改成迭代序列化、不再遞迴（那時不必截斷，門檻也就不再需要）；② 事件裡的工具參數改成原始字串、
 *   不再以 parse 後的巢狀物件進事件流（同 dsh，見上）。日誌的深度上限動了**不算**：這裡的 1200 只是借用它來保證「截斷不改變哪些訊息記得進去」，
 *   上限拿掉、截斷仍然擋著下行那一顆的堆疊爆掉。
 *
 * @module
 */

import { SESSION_EVENT_MAX_DEPTH } from '@nexus/core';
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

/** 下行副本巢狀深度的上限：日誌上限的兩倍，理由見檔頭偏離 D。 */
export const DOWNLINK_MAX_DEPTH = SESSION_EVENT_MAX_DEPTH * 2;

/** 超過 {@link DOWNLINK_MAX_DEPTH} 的子樹換成這個字串，字串同 dsh headless 的 `json-stream.ts`。 */
export const DEPTH_TRUNCATED = '[truncated: depth]';

/** {@link boundFrame} 的結果。 */
export interface BoundedFrame<T> {
  /** 要排進佇列、要送出去的那一顆：沒超過深度就是原物件，超過就是截斷過的副本。 */
  readonly frame: T;
  /** {@link frameBytes} 對 {@link BoundedFrame.frame} 算出來的。 */
  readonly bytes: number;
  /** 有沒有截過。 */
  readonly truncated: boolean;
}

/** 只下探陣列與純物件：其他物件（`Date`、有 `toJSON` 的）原樣留著，不算層數。 */
function isContainer(value: unknown): value is object {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return true;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * `frame` 的陣列與純物件巢狀有沒有超過 `limit` 層。迭代走訪，每個物件只走一次（循環不會走不完，只會少報）。
 *
 * **共用的子物件會少報**：同一個物件第一次是從淺處走到的，之後從深處再指到它就跳過，所以靠共用才超過門檻的 frame 量不出來、不會截。
 * 要量準得放棄「只走一次」（最長路徑，最壞指數成長），`nestingExceeds` 同樣少報。少報的後果是那一顆沒截就進 {@link frameBytes}，
 * 真的深到 `JSON.stringify` 爆堆疊時照偏離 C 斷線，不比沒有這一層更糟。
 */
function exceedsDepth(frame: unknown, limit: number): boolean {
  const seen = new Set<object>();
  const stack: [unknown, number][] = [[frame, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [current, depth] = item;
    if (!isContainer(current) || seen.has(current)) continue;
    if (depth > limit) return true;
    seen.add(current);
    for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
  return false;
}

/** 深度截斷過的副本：同一個來源物件只複製一份（保留共用與循環），迭代走訪。 */
function truncateDepth<T>(frame: T, limit: number): T {
  if (!isContainer(frame)) return frame;
  const copies = new Map<object, object>();
  const make = (source: object): object => {
    // 物件的副本用空原型：`{}` 上設一個自有的 `__proto__` 鍵會改到原型、鍵就被吃掉（同 dsh `json-stream.ts:90-94` 的做法）。
    const copy: object = Array.isArray(source) ? [] : Object.create(null);
    copies.set(source, copy);
    return copy;
  };
  const root = make(frame);
  const stack: [object, number][] = [[frame, 1]];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const [source, depth] = item;
    const copy = copies.get(source) as Record<string, unknown>;
    for (const [key, child] of Object.entries(source)) {
      if (!isContainer(child)) {
        copy[key] = child;
      } else if (copies.has(child)) {
        copy[key] = copies.get(child);
      } else if (depth + 1 > limit) {
        copy[key] = DEPTH_TRUNCATED;
      } else {
        copy[key] = make(child);
        stack.push([child, depth + 1]);
      }
    }
  }
  return root as T;
}

/**
 * 一顆要下行的 frame 在排進佇列之前走的最後一關：**深度截斷＋算位元組**（偏離 D）。廣播與開線補送共用這一支，兩條路的形狀才不會分岔。
 *
 * 沒超過 {@link DOWNLINK_MAX_DEPTH} 的原樣回傳（不複製）。**仍會拋**：`BigInt`、循環參照這類 JSON 表達不出來的東西，由 {@link frameBytes}
 * 拋，呼叫端照偏離 C 處理。
 *
 * @param frame - 要送的那顆（已蓋號、已加 `threadId` 的樣子）。
 */
export function boundFrame<T>(frame: T): BoundedFrame<T> {
  if (!exceedsDepth(frame, DOWNLINK_MAX_DEPTH)) {
    return { frame, bytes: frameBytes(frame), truncated: false };
  }
  const bounded = truncateDepth(frame, DOWNLINK_MAX_DEPTH);
  return { frame: bounded, bytes: frameBytes(bounded), truncated: true };
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
