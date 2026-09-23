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
 * | 413 | `'too-large'` —— 超過上限。**上限是拒絕不是截斷**，所以不能假裝畫出了全部 | 否 |
 * | 422 | `'not-text'` —— 不是文字：含 NUL、或不是 UTF-8。**可能讀到一半才出現**（server 串流分頁，只判它讀到的那一頁，#552） | 否 |
 * | 其他／斷線／形狀不對 | `'error'` | 是 |
 *
 * **只有 `'error'` 給重試。** 隔壁把非 404 的失敗全收進可重試的 `'error'`，那一套搬過來的話
 * 一顆重試鈕會對著一個永遠不會成功的 400 一直打。
 *
 * **`version` 是唯一有比較契約的欄位**：不解析它，只比它——同值即同一份內容。翻頁時用它擋掉
 * 「兩個版本的頁混在同一份畫面上」，那會畫出一份從來不存在的檔。
 *
 * **不送 `limit`。** 每頁幾行的上限是 `#settings/deliverable-files` 那一列的 `maxLines`，
 * 預設值 `DEFAULT_DELIVERABLE_MAX_LINES` 住在 `apps/harness/src/settings/deliverable-files.ts`、沒有從
 * `@nexus/wire` 匯出——而且部署可以改掉它，所以抄一份過來連「對」都說不上。路由不給 `limit` 時用的就是
 * 那一列的值，而翻頁只需要回應裡的 `lines`。
 *
 * **送一個我們自己的數字也不行**（[#543](https://github.com/DemianLi/nexus-agent/issues/543) 考慮過
 * `limit=1000`，收回了）：[#536](https://github.com/DemianLi/nexus-agent/issues/536) 之後 `maxLines`
 * 是設定條目、可以是任何正整數，而路由對 `limit > maxLines` 回 400 —— 有人把它設得比我們送的小，
 * **每一個預覽都會變成「座標不對」**，講錯原因而且全壞。省下的也不多：預覽畫面外不 layout 之後，
 * 一段多大已經不決定畫面成本（一次追加 5000 行 ASCII 總共 27–37ms，見 `deliverable-preview.tsx`）。
 *
 * @module
 */

import type { DeliverableFilePage } from '@nexus/wire';
import { deliverableFilePath } from '@nexus/wire';

/** 讀不到的幾種結局；每一個對應一個不同的畫面，見檔頭那張表。 */
export type DeliverableFileFailure = 'invalid' | 'missing' | 'too-large' | 'not-text' | 'error';

/** 一頁的狀態。`'loading'` ＝還在讀。 */
export type DeliverableFileState = DeliverableFilePage | DeliverableFileFailure | 'loading';

/** 讀到內容了（不是失敗、也不是還在讀）。 */
export function isPage(state: DeliverableFileState | undefined): state is DeliverableFilePage {
  return typeof state === 'object';
}

export interface DeliverableFileStore {
  /** 某一頁目前的狀態；還沒讀過是 `undefined`。 */
  read(seq: number, index: number, offset: number): DeliverableFileState | undefined;
  /** 讀一次：還沒讀過、或上次讀壞了才發。讀到了、正在讀、或是四種終局就不發。 */
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

/** 狀態碼 → 狀態。這張表就是契約，改它之前先讀 `deliverables.ts` 的檔頭。 */
function failureOf(status: number): DeliverableFileFailure {
  if (status === 400) return 'invalid';
  if (status === 404) return 'missing';
  if (status === 413) return 'too-large';
  if (status === 422) return 'not-text';
  return 'error';
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
  /** **頁是快取的單位**，所以鍵含 `offset`；隔壁只有 `(seq, index)` 是因為它一次讀完。 */
  const key = (seq: number, index: number, offset: number) => `${seq}:${index}:${offset}`;
  let revision = 0;
  const publish = (at: string, state: DeliverableFileState) => {
    states.set(at, state);
    revision += 1;
    for (const listener of listeners) listener();
  };
  const base = baseUrl.replace(/\/+$/, '');

  /**
   * 丟掉同一個檔其他 `version` 的頁。
   *
   * 檔在兩次翻頁之間被改掉時，舊頁講的是另一份內容——留著就會拼出一份從來不存在的檔。**比，
   * 不解析**：`version` 的契約只有「內容換了就換值」。
   */
  const evictStale = (seq: number, index: number, version: string) => {
    const prefix = `${seq}:${index}:`;
    for (const [at, state] of states) {
      if (at.startsWith(prefix) && isPage(state) && state.version !== version) states.delete(at);
    }
  };

  const request = async (
    seq: number,
    index: number,
    offset: number,
  ): Promise<DeliverableFileState> => {
    try {
      const response = await doFetch(
        `${base}${deliverableFilePath(threadId)}?seq=${seq}&index=${index}&offset=${offset}`,
        // content-type 是那條線上每一條 GET 的閘門（見 `THREADS_PATH`），不是禮貌。
        { method: 'GET', headers: { 'content-type': 'application/json' } },
      );
      if (!response.ok) return failureOf(response.status);
      const body: unknown = await response.json();
      return isFilePage(body) ? body : 'error';
    } catch {
      return 'error';
    }
  };

  return {
    read: (seq, index, offset) => states.get(key(seq, index, offset)),
    load(seq, index, offset) {
      const at = key(seq, index, offset);
      const state = states.get(at);
      if (state !== undefined && state !== 'error') return;
      publish(at, 'loading');
      void request(seq, index, offset).then((next) => {
        if (isPage(next)) evictStale(seq, index, next.version);
        publish(at, next);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    revision: () => revision,
  };
}
