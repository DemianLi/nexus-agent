/**
 * 交付檔預覽的讀取與快取（[#452](https://github.com/DemianLi/nexus-agent/issues/452) web 第二刀）。
 *
 * 形狀照隔壁 `changes-diff.ts`（store ＋ `useSyncExternalStore`），**但狀態不是它那一組**。
 * 路由把「前端該做什麼」編碼在狀態碼上（`packages/nexus-wire/src/deliverables.ts`），所以這裡
 * **一個碼一個狀態**，不攤平：
 *
 * | 碼 | 狀態 | 可重試 |
 * | --- | --- | --- |
 * | 400 | `'invalid'` —— 座標或翻頁參數不對，**這是 bug 不是使用者狀態** | 否 |
 * | 404 | `'missing'` —— 錨不住、檔不在、不是一般檔 | 否 |
 * | 413 | 文字頁：先縮 `limit`，縮到 1 還是 413 就改走位元組窗口（見下）。只有窗口本身回 413 才是 `'too-large'` | 否 |
 * | 422 | `'not-text'` —— 不是文字：含 NUL、或不是 UTF-8。**可能讀到一半才出現**（server 串流分頁，只判它讀到的那一頁，#552） | 否 |
 * | 其他／斷線／形狀不對 | `'error'` | 是 |
 *
 * **只有 `'error'` 給重試。** 隔壁把非 404 的失敗全收進可重試的 `'error'`，那一套搬過來的話
 * 一顆重試鈕會對著一個永遠不會成功的 400 一直打。
 *
 * **`version` 是唯一有比較契約的欄位**：不解析它，只比它——同值即同一份內容。翻頁時用它擋掉
 * 「兩個版本的頁混在同一份畫面上」，那會畫出一份從來不存在的檔。位元組窗口讀到的長行也一樣。
 *
 * ## `limit`：平常不送，收到 413 才送
 *
 * 每頁幾行的上限是 `#settings/deliverable-files` 那一列的 `maxLines`，預設值
 * `DEFAULT_DELIVERABLE_MAX_LINES` 住在 `apps/harness/src/settings/deliverable-files.ts`、沒有從 `@nexus/wire`
 * 匯出——而且部署可以改掉它，所以抄一份過來連「對」都說不上。路由不給 `limit` 時用的就是那一列的值，
 * 翻頁只需要回應裡的 `lines`。
 *
 * **所以平常不送**（[#543](https://github.com/DemianLi/nexus-agent/issues/543) 考慮過送一個固定的
 * `limit=1000`，收回了：路由對 `limit > maxLines` 回 400，有人把 `maxLines` 設得比它小，每一個預覽都會變成
 * 「座標不對」）。**只有收到 413 才送**（[#555](https://github.com/DemianLi/nexus-agent/issues/555)）：一頁超過
 * 頁的位元組上限時，要縮小 `limit` 才分得出是「中長的行太多」還是「這一行本身太長」，而縮的規則保證不會把
 * 一個超過 `maxLines` 的數變成畫面上的 400。規則在 `page-limit.ts`。
 *
 * ## 超過頁上限的一行：位元組窗口
 *
 * `limit=1` 還是 413，代表這一行本身就超過頁的位元組上限，按行切永遠讀不到。那一行改用
 * `deliverableBytesPath`（照 dsh 的 `readBytes`）一個窗口一個窗口讀，web 自己解碼（見 `line-bytes.ts`）；讀到
 * 換行之後，從下一行起改回文字頁。**dsh 的文字預覽沒有這一段**，它停在「单页内容超过上限」；這是照 #544
 * 「不阻擋大檔案瀏覽，一部分一部分載入」的方向做的。
 *
 * 窗口要的是**位元組**位置，文字頁只給**行**。位置由已讀的每一頁換算：每頁的 UTF-8 位元組數加上它結尾的換行
 * （`\r` 留在頁的文字裡，所以 CRLF 不會算錯）。路由解碼時吃掉檔頭的 BOM，所以從文字頁起算的位置要先查一次
 * 檔頭是不是 BOM。算完還要**自我核對**：從「算出的位置減 1」開始讀，那個位元組必須是換行；對不上就是
 * `'invalid'`，不會悄悄畫錯一行。
 *
 * @module
 */

import type { DeliverableFileBytes, DeliverableFilePage } from '@nexus/wire';
import { deliverableBytesPath, deliverableFilePath } from '@nexus/wire';

import type { LineDecoder } from '@/lib/line-bytes';
import { bytesOfBase64, createLineDecoder, startsWithBom, utf8Length } from '@/lib/line-bytes';
import type { PageLimit, PageOutcome } from '@/lib/page-limit';
import { INITIAL_PAGE_LIMIT, stepPageLimit } from '@/lib/page-limit';

/** 讀不到的幾種結局；每一個對應一個不同的畫面，見檔頭那張表。 */
export type DeliverableFileFailure = 'invalid' | 'missing' | 'too-large' | 'not-text' | 'error';

/**
 * 一條用位元組窗口讀的長行，讀到哪裡算哪裡。它在鏈上佔一行的位置，鍵同頁（`offset` 是行號，0 起算）。
 */
export interface DeliverableLongLine {
  readonly kind: 'long-line';
  /** 同頁的 `version`：讀這一行的每一個窗口都要是這個版本。 */
  readonly version: string;
  /** 這一行是第幾行，0 起算。 */
  readonly offset: number;
  /** 這一行從檔案的第幾個位元組開始。 */
  readonly start: number;
  /** 已經讀到的文字。 */
  readonly text: string;
  /** 已經用掉幾個位元組，不含結尾的換行。 */
  readonly bytes: number;
  /** 這一行讀完了（碰到換行或檔尾）。 */
  readonly done: boolean;
  /** 讀完時碰到的是檔尾：後面沒有下一行了。 */
  readonly eof: boolean;
  /** 下一個窗口：正在讀，或讀不到。沒有這個 key ＝還沒開始讀。 */
  readonly next?: 'loading' | DeliverableFileFailure;
}

/** 鏈上的一格：一頁，或一條長行。 */
export type DeliverableFileEntry = DeliverableFilePage | DeliverableLongLine;

/** 一格的狀態。`'loading'` ＝還在讀。 */
export type DeliverableFileState = DeliverableFileEntry | DeliverableFileFailure | 'loading';

/** 是一條長行。 */
export function isLongLine(state: DeliverableFileState | undefined): state is DeliverableLongLine {
  return typeof state === 'object' && 'kind' in state;
}

/** 讀到一頁了（不是長行、不是失敗、也不是還在讀）。 */
export function isPage(state: DeliverableFileState | undefined): state is DeliverableFilePage {
  return typeof state === 'object' && !('kind' in state);
}

export interface DeliverableFileStore {
  /** 某一格目前的狀態；還沒讀過是 `undefined`。 */
  read(seq: number, index: number, offset: number): DeliverableFileState | undefined;
  /**
   * 讀一次：還沒讀過、或上次讀壞了才發。讀到了、正在讀、或是四種終局就不發。
   *
   * 那一格是一條還沒讀完的長行時，讀的是它的下一個窗口（同樣只在還沒讀、或上次讀壞了時發）。
   */
  load(seq: number, index: number, offset: number): void;
  subscribe(listener: () => void): () => void;
  /**
   * 每發布一次就加一（[#543](https://github.com/DemianLi/nexus-agent/issues/543)）。
   *
   * 接續瀏覽要看的是**一整條鏈**（第 0 段、接著的那段、再接著的……），不是單一頁；讓元件拿它當
   * `useSyncExternalStore` 的快照，再從 {@link read} 把鏈走出來。**直接回一個陣列當快照不行**：
   * 每次呼叫都是新陣列，React 會判定快照一直在變而重畫到死。
   */
  revision(): number;
}

/**
 * 形狀檢查，同隔壁 `isFileDiff`：對不上就當成讀壞了。
 *
 * **`version` 只檢查「是非空字串」**——它的契約只有「內容換了就換值」，長相不歸我們管。
 */
export function isFilePage(value: unknown): value is DeliverableFilePage {
  const page = value as Record<string, unknown> | null;
  return (
    typeof page?.path === 'string' &&
    typeof page.version === 'string' &&
    page.version !== '' &&
    typeof page.text === 'string' &&
    typeof page.eof === 'boolean' &&
    [page.bytes, page.offset, page.lines].every(
      (field) => Number.isSafeInteger(field) && (field as number) >= 0,
    )
  );
}

/** 位元組窗口的形狀檢查，同 {@link isFilePage}。 */
export function isFileBytes(value: unknown): value is DeliverableFileBytes {
  const window = value as Record<string, unknown> | null;
  return (
    typeof window?.path === 'string' &&
    typeof window.version === 'string' &&
    window.version !== '' &&
    typeof window.data === 'string' &&
    typeof window.eof === 'boolean' &&
    [window.bytes, window.offset].every(
      (field) => Number.isSafeInteger(field) && (field as number) >= 0,
    )
  );
}

/** 狀態碼 → 狀態。這張表就是契約，改它之前先讀 `deliverables.ts` 的檔頭。 */
function failureOf(status: number): DeliverableFileFailure {
  if (status === 400) return 'invalid';
  if (status === 404) return 'missing';
  if (status === 413) return 'too-large';
  if (status === 422) return 'not-text';
  return 'error';
}

/** 一頁在檔案裡佔幾個位元組（含結尾的換行）。同一頁物件只算一次。 */
const pageBytes = new WeakMap<DeliverableFilePage, number>();
function bytesOfPage(page: DeliverableFilePage): number {
  let bytes = pageBytes.get(page);
  if (bytes === undefined) {
    bytes = utf8Length(page.text) + 1;
    pageBytes.set(page, bytes);
  }
  return bytes;
}

/** 長行去掉 `next`：下一個窗口的狀態只屬於「讀之前」。 */
function settled(line: DeliverableLongLine): DeliverableLongLine {
  return {
    kind: line.kind,
    version: line.version,
    offset: line.offset,
    start: line.start,
    text: line.text,
    bytes: line.bytes,
    done: line.done,
    eof: line.eof,
  };
}

export function createDeliverableFileStore({
  threadId,
  baseUrl,
  fetch: doFetch = globalThis.fetch.bind(globalThis),
}: {
  readonly threadId: string;
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
}): DeliverableFileStore {
  const states = new Map<string, DeliverableFileState>();
  const listeners = new Set<() => void>();
  /** **格是快取的單位**，所以鍵含 `offset`；隔壁只有 `(seq, index)` 是因為它一次讀完。 */
  const key = (seq: number, index: number, offset: number) => `${seq}:${index}:${offset}`;
  const fileKey = (seq: number, index: number) => `${seq}:${index}`;
  /** 每個檔的翻頁狀態，見 `page-limit.ts`。 */
  const limits = new Map<string, PageLimit>();
  /** 每個檔的檔頭是不是 BOM；查過才有值。 */
  const boms = new Map<string, boolean>();
  /** 每條還沒讀完的長行的解碼器，鍵同 {@link states}。跨窗口接字元要靠它。 */
  const decoders = new Map<string, LineDecoder>();
  let revision = 0;
  const notify = () => {
    revision += 1;
    for (const listener of listeners) listener();
  };
  const publish = (at: string, state: DeliverableFileState) => {
    states.set(at, state);
    notify();
  };
  const base = baseUrl.replace(/\/+$/, '');

  /**
   * 丟掉同一個檔其他 `version` 的格（頁與長行都是）。
   *
   * 檔在兩次讀之間被改掉時，舊格講的是另一份內容——留著就會拼出一份從來不存在的檔。**比，
   * 不解析**：`version` 的契約只有「內容換了就換值」。
   */
  const evictStale = (seq: number, index: number, version: string) => {
    const prefix = `${fileKey(seq, index)}:`;
    for (const [at, state] of states) {
      if (at.startsWith(prefix) && typeof state === 'object' && state.version !== version) {
        states.delete(at);
        decoders.delete(at);
      }
    }
  };

  /** GET 一條路由，帶 content-type 閘門（見 `THREADS_PATH`）。`undefined` 的參數不送。 */
  const get = (path: string, query: Record<string, number | undefined>) => {
    const params = Object.entries(query)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}=${String(value)}`)
      .join('&');
    return doFetch(`${base}${path}?${params}`, {
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    });
  };

  /** 讀一頁文字，送 `limit`（`undefined` ＝不送）。 */
  const requestPage = async (
    seq: number,
    index: number,
    offset: number,
    limit: number | undefined,
  ): Promise<DeliverableFilePage | DeliverableFileFailure> => {
    try {
      const response = await get(deliverableFilePath(threadId), { seq, index, offset, limit });
      if (!response.ok) return failureOf(response.status);
      const body: unknown = await response.json();
      return isFilePage(body) ? body : 'error';
    } catch {
      return 'error';
    }
  };

  /** 讀一個位元組窗口。不送 `length` 就是頁的位元組上限，理由同不送 `limit`。 */
  const requestBytes = async (
    seq: number,
    index: number,
    offset: number,
    length?: number,
  ): Promise<DeliverableFileBytes | DeliverableFileFailure> => {
    try {
      const response = await get(deliverableBytesPath(threadId), { seq, index, offset, length });
      if (!response.ok) return failureOf(response.status);
      const body: unknown = await response.json();
      return isFileBytes(body) ? body : 'error';
    } catch {
      return 'error';
    }
  };

  /**
   * 把一個窗口接進一條長行並發布。版本換了就丟掉整個檔的舊格，鏈在斷掉的地方重讀。
   *
   * @param skip - 窗口開頭有幾個位元組不屬於這一行（核對位置用的那一個換行）。
   */
  const accept = (
    seq: number,
    index: number,
    line: DeliverableLongLine,
    window: DeliverableFileBytes,
    skip: number,
  ) => {
    const at = key(seq, index, line.offset);
    if (window.version !== line.version) {
      evictStale(seq, index, window.version);
      states.delete(at);
      decoders.delete(at);
      notify();
      return;
    }
    const decoder = decoders.get(at);
    if (decoder === undefined) {
      publish(at, { ...line, next: 'error' });
      return;
    }
    const bytes = bytesOfBase64(window.data).subarray(skip);
    const chunk = decoder.push(bytes, window.eof);
    if (chunk.kind === 'not-text') {
      decoders.delete(at);
      publish(at, { ...line, next: 'not-text' });
      return;
    }
    if (chunk.done) decoders.delete(at);
    publish(at, {
      ...settled(line),
      text: line.text + chunk.text,
      bytes: line.bytes + chunk.consumed,
      done: chunk.done,
      // 換行在窗口裡就還有下一行；用完整個窗口又碰到檔尾，這一行就是最後一行。
      eof: chunk.done && chunk.consumed === bytes.length && window.eof,
    });
  };

  /** 讀一條長行的下一個窗口。 */
  const continueLine = async (seq: number, index: number, line: DeliverableLongLine) => {
    const at = key(seq, index, line.offset);
    const current = settled(line);
    publish(at, { ...current, next: 'loading' });
    const window = await requestBytes(seq, index, line.start + line.bytes);
    if (typeof window !== 'object') {
      publish(at, { ...current, next: window });
      return;
    }
    accept(seq, index, current, window, 0);
  };

  /**
   * 第 `offset` 行從第幾個位元組開始：把前面每一格的位元組數加起來。前面有長行的話，從它的真實位置接著算；
   * 全是文字頁的話，要補上路由吃掉的 BOM。
   */
  const startOf = async (
    seq: number,
    index: number,
    offset: number,
  ): Promise<{ start: number; version: string | undefined } | DeliverableFileFailure> => {
    let position = 0;
    let fromPages = true;
    let version: string | undefined;
    for (let at = 0; at < offset;) {
      const entry = states.get(key(seq, index, at));
      if (isPage(entry) && entry.lines > 0) {
        position += bytesOfPage(entry);
        at += entry.lines;
        version = entry.version;
      } else if (isLongLine(entry) && entry.done) {
        position = entry.start + entry.bytes + 1;
        fromPages = false;
        at += 1;
        version = entry.version;
      } else {
        // 鏈只會在尾巴讀下一格，走到這裡代表前面某一格不見了（例如剛被換版本丟掉）。
        return 'error';
      }
    }
    if (offset > 0 && fromPages) {
      const file = fileKey(seq, index);
      let bom = boms.get(file);
      if (bom === undefined) {
        const head = await requestBytes(seq, index, 0, 3);
        if (typeof head !== 'object') return head;
        bom = startsWithBom(bytesOfBase64(head.data));
        boms.set(file, bom);
      }
      if (bom) position += 3;
    }
    return { start: position, version };
  };

  /** `limit=1` 還是 413：這一行改走位元組窗口。第一個窗口順便核對位置。 */
  const startLine = async (seq: number, index: number, offset: number) => {
    const at = key(seq, index, offset);
    const located = await startOf(seq, index, offset);
    if (typeof located !== 'object') {
      publish(at, located);
      return;
    }
    const { start } = located;
    // 從前一個位元組開始讀：它必須是上一行結尾的換行。從第 0 個位元組開始的不用核對。
    const from = start === 0 ? 0 : start - 1;
    const window = await requestBytes(seq, index, from);
    if (typeof window !== 'object') {
      publish(at, window);
      return;
    }
    if (from !== start && bytesOfBase64(window.data.slice(0, 4))[0] !== 0x0a) {
      publish(at, 'invalid');
      return;
    }
    const line: DeliverableLongLine = {
      kind: 'long-line',
      version: located.version ?? window.version,
      offset,
      start,
      text: '',
      bytes: 0,
      done: false,
      eof: false,
    };
    decoders.set(at, createLineDecoder(start === 0));
    accept(seq, index, line, window, start - from);
  };

  /** 讀一頁；413 照 `page-limit.ts` 縮 `limit`，縮到底改走位元組窗口。 */
  const readPage = async (seq: number, index: number, offset: number) => {
    const at = key(seq, index, offset);
    const file = fileKey(seq, index);
    for (;;) {
      const state = limits.get(file) ?? INITIAL_PAGE_LIMIT;
      const result = await requestPage(seq, index, offset, state.limit);
      let outcome: PageOutcome;
      if (typeof result === 'object')
        outcome = { kind: 'page', lines: result.lines, eof: result.eof };
      else if (result === 'too-large' || result === 'invalid') outcome = { kind: result };
      else {
        publish(at, result);
        return;
      }
      const step = stepPageLimit(state, outcome);
      limits.set(file, step.state);
      if (step.next === 'retry') continue;
      if (step.next === 'invalid') publish(at, 'invalid');
      else if (step.next === 'long-line') await startLine(seq, index, offset);
      else {
        const page = result as DeliverableFilePage;
        evictStale(seq, index, page.version);
        publish(at, page);
      }
      return;
    }
  };

  return {
    read: (seq, index, offset) => states.get(key(seq, index, offset)),
    load(seq, index, offset) {
      const state = states.get(key(seq, index, offset));
      if (isLongLine(state)) {
        if (!state.done && (state.next === undefined || state.next === 'error')) {
          void continueLine(seq, index, state);
        }
        return;
      }
      if (state !== undefined && state !== 'error') return;
      publish(key(seq, index, offset), 'loading');
      void readPage(seq, index, offset);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
  };
}
