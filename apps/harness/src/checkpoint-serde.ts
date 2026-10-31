/**
 * 存檔點的序列化：寫得進去就一定讀得回來，寫不進去就大聲拋——[#1658](https://github.com/DemianLi/nexus-agent/issues/1658)。
 *
 * ## 問題
 *
 * `PrunedMemorySaver` 沿用 `MemorySaver` 預設的 `JsonPlusSerializer`（`@langchain/langgraph-checkpoint` 1.1.5），它在深巢狀上
 * 有兩個洞，都是在 `serve` 上實測到的（工具參數交錯巢狀，續接灌回 state 再跑一輪）：
 *
 * - **寫入吞錯**：`dist/serde/utils/fast-safe-stringify/index.js:16-20` 的 `stringify` 在原生 `JSON.stringify` 拋錯時
 *   `catch` 掉，回一句 `"[unable to serialize, circular reference is too complex to analyze]"`。`put` 照樣成功，整份存檔點
 *   變成那句字串，下一輪從空的 state 開始——**整段對話無聲丟掉**，不只深的那一則。實測約 1920～4700 層落在這一段；
 *   再深一點，它前面那段遞迴的 `decirc` 先爆 `Maximum call stack size exceeded`。邊界看呼叫當下剩多少堆疊，不是常數。
 * - **讀回有 50 層上限**：`dist/serde/jsonplus.js:78` 把 LangChain 物件交給 `@langchain/core/load` 的 `load` 時沒傳
 *   `maxDepth`，預設 50（`load/index.js:79`）。46 層的工具參數寫得進去、讀不回來，那條 thread 之後每一輪都失敗。
 *
 * ## 做法
 *
 * - **寫入先量層數**（迭代走訪，不遞迴），超過 {@link CHECKPOINT_MAX_DEPTH} 就拋 {@link CheckpointDepthError}，碼
 *   {@link CHECKPOINT_DEPTH_EXCEEDED}，**在交給 `stringify` 之前**——所以 `decirc` 那一段也不會先爆。`put` 拋錯時
 *   `MemorySaver` 不寫那一份，存檔點留在上一顆：那一輪失敗，下一輪照常跑，模型收到的是被拒之前的歷史。
 * - **量之前先預檢**（[#1761](https://github.com/DemianLi/nexus-agent/issues/1761)）：量層數的那一步會呼叫 LangChain 訊息的 `toJSON`，那是遞迴的，
  冷行程裡 2000 層就爆堆疊，回的是 `RangeError` 而不是 {@link CheckpointDepthError}。所以 {@link checkpointDepth} 先用不呼叫 `toJSON`
  的迭代走訪量原始結構，超過上限的兩倍（{@link CHECKPOINT_PRECHECK_DEPTH}）就不再往下做，細節見那支函式。
- **吞錯的那句字串當第二道**：量過了還是被換成那句（例如值裡有 `BigInt`），一樣拋，碼 {@link CHECKPOINT_UNSERIALIZABLE}。
 * - **讀回傳同一個上限給 `load`**：寫入的上限量的是整份存檔點，`load` 從每個 LangChain 物件自己那一層開始數，只會更淺，
 *   所以「寫得進去就讀得回來」。`jsonplus.js` 沒有開放這個參數，`_reviver` 那一段只好自己寫，見 {@link reviveJson}。
 *
 * ## 上限怎麼定
 *
 * 從 {@link SESSION_EVENT_MAX_DEPTH} 推：日誌收得下的事件，帶的訊息灌回 state 之後要寫得進存檔點。層數的算法跟日誌同一套
 * （根是容器的話算第 1 層，純量不算），量的是交給 `JSON.stringify` 之後的樣子（先 `toJSON`、再過 `_default`）。
 * 加上的 {@link CHECKPOINT_WRAPPER_DEPTH} 層是實測出來的，見那一格的註解。
 *
 * ## `messages` 不走這顆（[#2116](https://github.com/DemianLi/nexus-agent/issues/2116)）
 *
 * 訊息留在記憶體不序列化，寫入吞錯與讀回層數上限這兩件事碰不到它們。`pruned-memory-saver.ts` 的 `seal` 用同一個
 * {@link CHECKPOINT_MAX_DEPTH} 量新進的訊息，邊界跟量整份存檔點相同：日誌收得下的事件進得了 state，太深的拋
 * {@link CheckpointDepthError}。這顆管 `files` 等其他 channel、metadata 與 pending writes。
 *
 * ## 與 dsh 的偏離（理由 1）
 *
 * dsh 沒有存檔點這一層（一輪到下一輪的狀態是會話日誌加記憶體，見 `pruned-memory-saver.ts`），這一份是 LangGraph 基座才有的。
 * 預檢（#1761）同理：dsh 在 `packages/bundle/headless/src/json-stream.ts` 對病態的深參數也是「遞迴之前先卡深度」（`MAX_DEPTH`，
 * 註解寫的就是不卡會遞迴到爆堆疊），原則相同；差別是我們要擋的遞迴在 `@langchain/core` 的 `toJSON` 裡，改不了，只能在呼叫它之前先量。
 * 基座的序列化會吞錯、`load` 的上限從 serializer 調不到，退到最接近的做法：自己包一層 serializer，複製的部分取最小、標明出處，
 * 並用 `checkpoint-serde.test.ts` 釘住 `@langchain/langgraph-checkpoint` 的版本，升版時那一格會紅，逼人重新核對這段複製。
 *
 * @module
 */

import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';
import { load } from '@langchain/core/load';
import { SESSION_EVENT_MAX_DEPTH } from '@nexus/core';

/** 存檔點太深的穩定碼。 */
export const CHECKPOINT_DEPTH_EXCEEDED = 'checkpoint_depth_exceeded';

/** 量過了還是被基座換成那句「unable to serialize」的穩定碼。 */
export const CHECKPOINT_UNSERIALIZABLE = 'checkpoint_unserializable';

/**
 * 一則日誌事件裡的訊息，寫進存檔點之後比在日誌裡深幾層。
 *
 * 日誌裡訊息的欄位在第 3 層（`data` → `message` → `data`），存檔點裡在第 5 層（存檔點 → `channel_values` →
 * `messages` → 那一則的 `{lc, type, id, kwargs}` → `kwargs`），所以是 2。實測見 `checkpoint-serde.test.ts` 的
 * 「剛好 600 層」那幾格：真的組裝、真的 `serve`，一則日誌事件剛好 {@link SESSION_EVENT_MAX_DEPTH} 層，量存檔點每一次寫入。
 */
export const CHECKPOINT_WRAPPER_DEPTH = 2;

/** 一次寫入（存檔點、metadata、每一筆 write）最多巢狀幾層。讀回時同一個數字傳給 `load`。 */
export const CHECKPOINT_MAX_DEPTH = SESSION_EVENT_MAX_DEPTH + CHECKPOINT_WRAPPER_DEPTH;

/**
 * {@link checkpointDepth} 在呼叫任何 `toJSON` 之前先量的門檻：上限的兩倍（理由見那裡，與 `@nexus/core` `logged-message.ts` 的
 * `PRECHECK_DEPTH` 同一套做法）。
 */
export const CHECKPOINT_PRECHECK_DEPTH = CHECKPOINT_MAX_DEPTH * 2;

/** 存檔點太深，寫入被拒。認 `code`，不認訊息。 */
export class CheckpointDepthError extends Error {
  /** 失敗分類碼，見 {@link CHECKPOINT_DEPTH_EXCEEDED}。 */
  readonly code = CHECKPOINT_DEPTH_EXCEEDED;

  /**
   * @param depth - 量到的層數。
   * @param limit - 上限。
   * @param seq - 續接時是日誌哪一顆事件帶進來的；同台那條路沒有。
   */
  constructor(
    readonly depth: number,
    readonly limit: number,
    readonly seq?: number,
  ) {
    super(
      `${seq === undefined ? '' : `日誌第 ${seq} 顆事件的訊息`}寫進存檔點有 ${depth} 層，超過上限 ${limit} 層（${CHECKPOINT_DEPTH_EXCEEDED}）`,
    );
    this.name = 'CheckpointDepthError';
  }
}

/** 基座把整份換成那句字串。認 `code`，不認訊息。 */
export class CheckpointUnserializableError extends Error {
  /** 失敗分類碼，見 {@link CHECKPOINT_UNSERIALIZABLE}。 */
  readonly code = CHECKPOINT_UNSERIALIZABLE;

  constructor() {
    super(
      `存檔點序列化失敗，基座回的是「unable to serialize」那一句（${CHECKPOINT_UNSERIALIZABLE}）`,
    );
    this.name = 'CheckpointUnserializableError';
  }
}

/** `fast-safe-stringify` 吞錯時回的那一句，`JSON.stringify` 過的樣子（`index.js:19`，1.1.5）。 */
const SWALLOWED = new TextEncoder().encode(
  JSON.stringify('[unable to serialize, circular reference is too complex to analyze]'),
);

/**
 * 交給 `JSON.stringify(value, _default)` 之後巢狀幾層（根是容器的話算第 1 層，純量不算）。
 *
 * 照 `JSON.stringify` 的順序：先 `toJSON(key)`，再過基座的 replacer `_default`（`jsonplus.js:91-107`，1.1.5）。`_default`
 * 會把幾種值換成 `{lc: 2, ...}` 的紀錄，這裡照它多算的層數：`undefined` 1 層；`RegExp`、`Error` 2 層；`Uint8Array` 3 層；
 * `Set` 的元素、`Map` 的鍵值對多 3 層。其餘（`Send`、`DeltaSnapshot`）換出來的層數跟走自有屬性一樣。
 * 迴圈參照照 `decirc` 換成字串，不往下走。
 *
 * **走訪本身是迭代的，但 `toJSON` 不是**（[#1761](https://github.com/DemianLi/nexus-agent/issues/1761)）：LangChain 訊息的
 * `toJSON` 是 `@langchain/core` 的遞迴實作（`Serializable.toJSON` → `escapeIfNeeded`，`load/validation.js`，1.2.9），交錯巢狀
 * 幾千層就 `Maximum call stack size exceeded`。實測（macOS、Node 25.9.0）新行程第一個續接冷著跑，參數 2000 層就爆，暖過之後
 * 才撐到幾千層，邊界看冷熱與剩餘堆疊，所以 vitest 這種暖行程裡永遠看不到。#1668 的「先量再拒」因此在量的那一步先爆，
 * 回的是 `RangeError`，`threadOrError` 認不得，網頁收到暫時性的 `unknown_error`。
 *
 * **所以先預檢**：呼叫任何 `toJSON` 之前，先用不呼叫 `toJSON` 的同一支迭代走訪量原始結構；超過 `precheck` 層就直接回那個層數，
 * 不再往下做會遞迴的那一步。門檻取上限的兩倍，不取上限本身：原始結構與寫進存檔點的形狀層數對不齊（`toJSON` 會多包幾層），
 * 取上限本身的話，寫得進去的訊息可能被這裡誤拒，也讓報出來的層數與下面那條路不同。比兩倍淺的照舊走 `toJSON` 取得精確的層數
 * （幾百到一千多層，遠低於冷著爆的那一格）；超過兩倍的，包進存檔點後一定也超過上限，所以這一步**不改變哪些訊息寫得進去**。
 * 預檢回的是原始結構的層數，比寫進存檔點的少幾層，只用在「超過上限」的訊息裡。
 *
 * @param precheck - 預檢門檻，預設 {@link CHECKPOINT_PRECHECK_DEPTH}。
 */
export function checkpointDepth(
  value: unknown,
  precheck: number = CHECKPOINT_PRECHECK_DEPTH,
): number {
  const raw = walkDepth(value, false);
  return raw > precheck ? raw : walkDepth(value, true);
}

/**
 * {@link checkpointDepth} 的迭代走訪。`callToJSON` 為 `false` 時**一個 `toJSON` 都不呼叫**，走的是自有、可列舉的值
 * （`BaseMessage` 的 `lc_kwargs` 跟欄位指到同一份，兩邊都會走，層數相同）。
 */
function walkDepth(value: unknown, callToJSON: boolean): number {
  type Frame =
    | {
        readonly kind: 'enter';
        readonly key: string;
        readonly value: unknown;
        readonly depth: number;
      }
    | { readonly kind: 'leave'; readonly value: object };
  const stack: Frame[] = [{ kind: 'enter', key: '', value, depth: 1 }];
  const onPath = new Set<object>();
  let max = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'leave') {
      onPath.delete(frame.value);
      continue;
    }
    const { depth } = frame;
    let current = frame.value;
    if (current === undefined) {
      max = Math.max(max, depth);
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    const toJSON = callToJSON ? (current as { toJSON?: unknown }).toJSON : undefined;
    if (typeof toJSON === 'function') {
      current = (toJSON as (key: string) => unknown).call(current, frame.key);
      if (current === undefined) {
        max = Math.max(max, depth);
        continue;
      }
      if (current === null || typeof current !== 'object') continue;
    }
    if (onPath.has(current)) continue;
    if (current instanceof RegExp || current instanceof Error) {
      max = Math.max(max, depth + 1);
      continue;
    }
    if (ArrayBuffer.isView(current)) {
      max = Math.max(max, depth + 2);
      continue;
    }
    let children: [string, unknown, number][];
    if (current instanceof Set) {
      max = Math.max(max, depth + 2);
      children = [...current].map((item, index) => [String(index), item, depth + 3]);
    } else if (current instanceof Map) {
      max = Math.max(max, depth + 3);
      children = [...current].flatMap(([key, item]) => [
        ['0', key, depth + 4] as [string, unknown, number],
        ['1', item, depth + 4] as [string, unknown, number],
      ]);
    } else {
      max = Math.max(max, depth);
      children = Array.isArray(current)
        ? current.map((item, index) => [String(index), item, depth + 1])
        : Object.keys(current).map((key) => [
            key,
            (current as Record<string, unknown>)[key],
            depth + 1,
          ]);
    }
    onPath.add(current);
    stack.push({ kind: 'leave', value: current });
    for (let index = children.length - 1; index >= 0; index--) {
      const [key, item, childDepth] = children[index]!;
      stack.push({ kind: 'enter', key, value: item, depth: childDepth });
    }
  }
  return max;
}

/** `jsonplus.js:5-7` 的 `isLangChainSerializedObject`（1.1.5）。 */
function isLangChainSerializedObject(value: Record<string, unknown>): boolean {
  return value.lc === 1 && value.type === 'constructor' && Array.isArray(value.id);
}

/**
 * 量過層數的 serializer。寫入與讀回見檔頭；`bytes` 型別與 `{lc: 2}` 的紀錄原樣交給基座那一顆。
 */
export class DepthCheckedSerializer implements SerializerProtocol {
  readonly #inner: SerializerProtocol;
  readonly #maxDepth: number;

  /**
   * @param inner - 基座的 `JsonPlusSerializer`。它沒有匯出，由 saver 交出它建構時預設掛的那一顆（`pruned-memory-saver.ts`）。
   * @param maxDepth - 一次寫入最多幾層，同一個數字傳給 `load`。預設 {@link CHECKPOINT_MAX_DEPTH}。
   */
  constructor(inner: SerializerProtocol, maxDepth: number = CHECKPOINT_MAX_DEPTH) {
    this.#inner = inner;
    this.#maxDepth = maxDepth;
  }

  /** @inheritdoc 先量層數，再交給基座；被換成那句字串就拋。 */
  async dumpsTyped(data: unknown): Promise<[string, Uint8Array]> {
    if (data instanceof Uint8Array) return this.#inner.dumpsTyped(data);
    const depth = checkpointDepth(data, this.#maxDepth * 2);
    if (depth > this.#maxDepth) throw new CheckpointDepthError(depth, this.#maxDepth);
    const dumped = await this.#inner.dumpsTyped(data);
    if (sameBytes(dumped[1], SWALLOWED)) throw new CheckpointUnserializableError();
    return dumped;
  }

  /** @inheritdoc `json` 型別自己還原，好把上限傳給 `load`。 */
  async loadsTyped(type: string, data: Uint8Array | string): Promise<unknown> {
    if (type !== 'json') return this.#inner.loadsTyped(type, data);
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    return this.#revive(JSON.parse(text) as unknown);
  }

  /**
   * `jsonplus.js:70-81` 的 `_reviver`（1.1.5），只改一處：LangChain 物件交給 `load` 時傳 `maxDepth`。
   *
   * 由內往外還原（基座的註解：replacer 先呼叫了 `toJSON`，所以要從最裡面往上解）。`{lc: 2}` 的紀錄（`undefined`、
   * `DeltaSnapshot`、`Set`、`Map` 這一類，`_default` 寫的那幾種）**還沒往下解之前**整顆原樣交給基座：那一顆是純 JSON，
   * 交過去跟基座自己解到這裡的結果相同，就不必複製 `reviveConstructorRecord` 那一整段。
   *
   * **已知殘餘**：那幾種紀錄裡面如果包著 LangChain 物件（例如 `Set` 裡放訊息），那一顆仍由基座的 `load` 解，上限還是 50 層，
   * 「寫得進去就讀得回來」在這種形狀上不成立。今天 state 裡沒有這種形狀（`DeltaChannel` 見 `pruned-memory-saver.ts`）。
   */
  async #revive(value: unknown): Promise<unknown> {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.#revive(item)));
    const record = value as Record<string, unknown>;
    if (record.lc === 2) return this.#inner.loadsTyped('json', JSON.stringify(record));
    const revived: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) revived[key] = await this.#revive(item);
    if (isLangChainSerializedObject(revived)) {
      return load(JSON.stringify(revived), { maxDepth: this.#maxDepth });
    }
    return revived;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
