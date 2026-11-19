/**
 * `GET /threads` 一次只要一部分（[#725](https://github.com/DemianLi/nexus-agent/issues/725)）：查詢參數、游標，與 server 照它們切的那一刀。
 *
 * **全部選填**：一個參數都不帶就是整份，跟以前一樣，沒升級的呼叫端照舊。
 *
 * - **一頁**：`limit` 條，接在 `cursor` 之後；還有就回 `nextCursor`。游標記的是上一頁最後一列的 `(updatedAt, threadId)`，
 *   不是第幾條：翻頁之間有一條講了話跳到最前面，其餘的不重複也不漏；跳走的那一條若還沒翻到，這一趟就不會再出現。
 * - **只比標題**（`q`）：規則同側欄（{@link threadTitleMatches}），在 server 上比，翻到哪一頁都比得到整份。
 * - **封存**（`archived`）：`exclude` 不列封存的、`only` 只列封存的。不帶就不分。
 * - **指定幾條**（`id`，可重複）：只回這幾條裡列得出來的，順序照列表。跟上面幾個不能一起用。
 *
 * @module
 */

import type { ThreadSummary } from './protocol.js';

/** `limit` 的上限。 */
export const THREAD_LIST_PAGE_MAX = 200;

/** 一次最多指定幾條（`id`）。 */
export const THREAD_LIST_IDS_MAX = 200;

/** `GET /threads` 的查詢參數。每一格都選填，全部省略就是整份。 */
export interface ThreadListQuery {
  /** 這一頁最多幾條，1 到 {@link THREAD_LIST_PAGE_MAX}。省略就是到底。 */
  readonly limit?: number;
  /** 上一頁的 `nextCursor`。 */
  readonly cursor?: string;
  /** 只列標題含這段字的（{@link threadTitleMatches}）。去掉頭尾空白之後是空的就等於沒帶。 */
  readonly q?: string;
  readonly archived?: 'exclude' | 'only';
  /** 只回這幾條。帶了就不能帶別的參數。 */
  readonly ids?: readonly string[];
}

/** 側欄與 server 共用的標題比對：去頭尾空白、不分大小寫、子字串；沒有標題的不算對上。查詢是空的（含只有空白）就全部對上。 */
export function threadTitleMatches(title: string | undefined, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return true;
  return title?.toLocaleLowerCase().includes(needle) === true;
}

/** 照 {@link ThreadListQuery} 組查詢字串（含開頭的 `?`；沒有參數是空字串）。 */
export function threadListSearch(query: ThreadListQuery | undefined): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.cursor !== undefined) params.set('cursor', query.cursor);
  if (query.q !== undefined) params.set('q', query.q);
  if (query.archived !== undefined) params.set('archived', query.archived);
  for (const id of query.ids ?? []) params.append('id', id);
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/** 讀查詢字串。不合法回一句說明，server 拿它回 `invalid_argument`。 */
export function parseThreadListQuery(
  params: URLSearchParams,
):
  | { readonly ok: true; readonly query: ThreadListQuery }
  | { readonly ok: false; readonly message: string } {
  const ids = params.getAll('id');
  const limitText = params.get('limit');
  const cursor = params.get('cursor');
  const q = params.get('q');
  const archived = params.get('archived');
  if (ids.length > 0) {
    if (limitText !== null || cursor !== null || q !== null || archived !== null) {
      return { ok: false, message: 'id 不能跟 limit、cursor、q、archived 一起用' };
    }
    if (ids.length > THREAD_LIST_IDS_MAX) {
      return { ok: false, message: `id 最多 ${THREAD_LIST_IDS_MAX} 個` };
    }
    return { ok: true, query: { ids } };
  }
  let limit: number | undefined;
  if (limitText !== null) {
    limit = Number(limitText);
    if (!/^\d+$/u.test(limitText) || limit < 1 || limit > THREAD_LIST_PAGE_MAX) {
      return { ok: false, message: `limit 要是 1 到 ${THREAD_LIST_PAGE_MAX} 的整數` };
    }
  }
  if (cursor !== null && decodeCursor(cursor) === undefined) {
    return { ok: false, message: 'cursor 讀不懂：要原樣送回上一頁的 nextCursor' };
  }
  if (archived !== null && archived !== 'exclude' && archived !== 'only') {
    return { ok: false, message: 'archived 只能是 exclude 或 only' };
  }
  return {
    ok: true,
    query: {
      ...(limit !== undefined && { limit }),
      ...(cursor !== null && { cursor }),
      ...(q !== null && { q }),
      ...(archived !== null && { archived }),
    },
  };
}

interface CursorPosition {
  readonly updatedAt: number;
  readonly threadId: string;
}

function encodeCursor(item: CursorPosition): string {
  return `${String(item.updatedAt)}:${item.threadId}`;
}

function decodeCursor(cursor: string): CursorPosition | undefined {
  const colon = cursor.indexOf(':');
  if (colon <= 0) return undefined;
  const time = cursor.slice(0, colon);
  if (!/^-?\d+$/u.test(time)) return undefined;
  const threadId = cursor.slice(colon + 1);
  if (threadId === '') return undefined;
  return { updatedAt: Number(time), threadId };
}

/** 列表的順序（`updatedAt` 由新到舊，一樣時照 id）上，`item` 在 `position` 之後。 */
function after(item: CursorPosition, position: CursorPosition): boolean {
  return (
    item.updatedAt < position.updatedAt ||
    (item.updatedAt === position.updatedAt && item.threadId > position.threadId)
  );
}

/**
 * server 照查詢切一刀。`items` 已經照列表的順序排好。
 *
 * @param archivedIds - 封存的那幾條；這台 server 沒有封存時是空的。
 * @returns 這一頁，與還有下一頁時的游標。
 */
export function pageThreadList<T extends ThreadSummary | Omit<ThreadSummary, 'running'>>(
  items: readonly T[],
  query: ThreadListQuery,
  archivedIds: ReadonlySet<string>,
): { readonly items: readonly T[]; readonly nextCursor?: string } {
  if (query.ids !== undefined) {
    const wanted = new Set(query.ids);
    return { items: items.filter((item) => wanted.has(item.threadId)) };
  }
  const position = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
  const matching = items.filter(
    (item) =>
      (position === undefined || after(item, position)) &&
      (query.archived === undefined ||
        archivedIds.has(item.threadId) === (query.archived === 'only')) &&
      (query.q === undefined || threadTitleMatches(item.title, query.q)),
  );
  if (query.limit === undefined || matching.length <= query.limit) return { items: matching };
  const page = matching.slice(0, query.limit);
  return { items: page, nextCursor: encodeCursor(page[page.length - 1]!) };
}
