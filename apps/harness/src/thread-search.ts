/**
 * 按內容搜尋以前的 thread（[#631](https://github.com/DemianLi/nexus-agent/issues/631)）。線上的契約見 `@nexus/wire` 的
 * `THREAD_SEARCH_PATH`，設定見 `settings/thread-search.ts`。
 *
 * 照 dsh 的兩層（`477b4f4`）：host 的 `ApiSessionList.search`（`packages/api/session-controller/src/list.ts:163-266`）與
 * `session-query-sqlite` 的提供方（`packages/session-query/session-query-sqlite/src/index.ts`）。我們沒有「提供方」這一層
 * 服務，兩層併在這一個類別裡，順序照 host 那一支。
 *
 * ## 冷讀，搜得到的一定列得出來
 *
 * 一條 thread 都不為它啟動。可見的集合就是列表的（`session-list.ts` 的 `listVisibleThreads`：root、`cwd` 對得上、
 * header 讀得懂），同 dsh 先拿列表過濾。列與讀都經過 `SessionStore`（`list` 與 `open(id, 'read')`，
 * [#665](https://github.com/DemianLi/nexus-agent/issues/665)），同 dsh 的查詢層不碰檔名與目錄。**多人共用主機時各搜各的**：
 * 存放處是這個 home 底下的，別人的日誌不在裡面。
 *
 * ## 索引：`node:sqlite` 的 FTS5，只放在記憶體裡
 *
 * 同 dsh 的載體（`schema.ts:52` 用 `await import('node:sqlite')`）。**每次搜尋前先對帳**（dsh `index.ts:268-293`）：列出可見的
 * 那幾條，`list` 給的 `revision` 跟上次不同的整條重讀（同 dsh `index.ts:510-514`），不見了的拿掉。對帳與查詢排成一條隊，同 dsh 的 `_serialized`。
 * 索引檔 dsh 可以落盤（`path`），我們只放記憶體，同 dsh 出廠的 `path: ':memory:'`：serve 重開之後第一次搜尋重建。
 *
 * **`node:sqlite` 在 `openAt: never` 時一次都不載入**：Node 22 載入它會在 stderr 印一行實驗功能的警告。載不起來
 * （Node 22.13 以前要加旗標）時，搜尋回失敗、說明要哪一版，其他功能照常——當時 `package.json` 的 `engines` 因此沒有收緊。
 * （[#746](https://github.com/DemianLi/nexus-agent/issues/746) 為了 undici 8 把下限收到 22.19，這條退路對受支援的版本已走不到，留著是給跳過 `engines` 的人。）
 *
 * ## 搜什麼：只搜模型現在看得到的那一串
 *
 * dsh 把日誌摺成 `current`／`shadowed`（`session-query/src/documents.ts:57-74` 的 `foldSurface`），host 只查 `current` 上的
 * `user/message` 與 `assistant/message`（`list.ts:203-206`）。**我們沒有 surface 那一軸**，拿推模型歷史那一支
 * （`@nexus/core` 的 `replayConversation`）代替：推出來的那一串就是模型現在看得到的，`origin` 交出每一則出自哪一顆事件。
 * 被壓縮換掉的那幾則不在串上，換上去的摘要在（demian 2026-09-27 拍板照 dsh）。
 *
 * 對到 dsh 的哪一種：
 *
 * | 我們的事件 | dsh | 收什麼 |
 * | --- | --- | --- |
 * | `turn/start`（人打的字，與目標排的那一輪，與背景子代理的結算通知） | `user/message`（dsh 不按來源過濾） | 那段字 |
 * | `user/message`（外掛塞的；人在輪中插的話；引用別的會話的快照，#713） | `user/message`（同樣不按來源過濾） | 文字區塊 |
 * | `compaction/summary` 的 `summary` | 緊接著的 `user/message {surfaceOp: replace}` | 文字區塊 |
 * | `assistant/message` | `assistant/message` | 文字區塊；要叫的工具的名字與參數（`extraction.ts:70-83`） |
 *
 * 推理不收（`extraction.ts` 的 `reasoning` 回 `[]`；`.text` 只取文字區塊）；工具結果、標題不收。
 *
 * **推不出來的日誌**（格式 9 以前、壓縮對不上）：沒辦法分哪幾則被換掉，**整份都算看得到**，上面那幾種事件全收。
 * dsh 摺不出 surface 時拋 `SESSION_QUERY_INVALID_SURFACE`，整次搜尋失敗；我們不讓一份舊日誌拖垮整次搜尋。日誌中間壞掉的
 * 略過壞的那幾行（讀的時候開 `salvage`，撿回的規則在後端），同列表不擋它。
 *
 * **整份解析、重播，不先篩行**：只解析帶訊息字樣的那幾行、沒壓縮過就不重播，量過只快 6%（合成的 1000 條、343 MB，
 * 第一次搜尋 2.7 秒對 2.85 秒），不值得多一條要跟重播保持一致的路。
 *
 * ## 怎麼比：偏離
 *
 * dsh 用 unicode61 斷詞、把整段查詢當一個片語（`schema.ts:127-136`、`query.ts:223-225`）。**連續的中文在 unicode61
 * 裡是一整個詞**，句子中間的「搜尋」「會話」都搜不到（2026-09-27 實測，`node:sqlite`）。demian 2026-09-27 拍板偏離：
 *
 * - 斷詞換成 **trigram**（每三個字切一段）。dsh 否決它的理由是索引約大 2.1 倍（`session-query-sqlite/README.zh.md`）。
 * - 比對是**子字串**：一律 `LIKE`。三個字以上的 `LIKE` 走 trigram 的索引；不到三個字（兩個字的中文詞、`AI`）整表掃。
 *   查詢含 `%`、`_`、`\` 時要 `ESCAPE`，那時也整表掃（SQLite 的 trigram 不拿 `ESCAPE` 的 `LIKE` 走索引，實測）。
 * - 英文不分大小寫（SQLite 的 `LIKE` 只折 ASCII），連續的空白算一個：寫進索引的文字與查詢都先把空白壓成一格。
 *
 * ## 排序與片段，同 dsh
 *
 * 一條 thread 取最相關的一則，再在 thread 之間排（`index.ts:670-680`）：命中次數多的在前、那一則短的在前、新的在前。
 * 命中次數 dsh 數 `highlight()` 的標記；我們數子字串出現幾次（不重疊，同樣只折 ASCII）。片段照 dsh 的 `makeSnippet`
 * （`query.ts:269-316`）逐行照抄。
 *
 * @module
 */

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

import {
  fromLoggedMessage,
  isMentionHintBlock,
  replayConversation,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  SessionNotFoundError,
} from '@nexus/core';
import type { SessionEvent, SessionStore, StoredSessionSnapshot } from '@nexus/core';
import {
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  THREAD_SEARCH_RESULT_LIMIT,
  THREAD_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '@nexus/wire';
import type { ThreadSearchResult } from '@nexus/wire';

import { listVisibleThreads } from './session-list.js';
import type { ThreadSearchConfig } from './settings/thread-search.js';

/**
 * 搜尋失敗的種類。線上怎麼講見 `wire-handler.ts`。
 *
 * - `invalid`：查詢空白、太長、含 NUL。
 * - `disabled`：那一列設成 `openAt: never`，而且有東西可搜。
 * - `failed`：`node:sqlite` 載不起來、或讀日誌／寫索引出錯。
 */
export type ThreadSearchErrorKind = 'invalid' | 'disabled' | 'failed';

export class ThreadSearchError extends Error {
  constructor(
    readonly kind: ThreadSearchErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ThreadSearchError';
  }
}

/** `openAt: never` 時的失敗，照 dsh 的 `SESSION_QUERY_SEARCH_DISABLED`（`index.ts:338-344`）。 */
export const THREAD_SEARCH_DISABLED_MESSAGE =
  '這個部署沒開會話內容搜尋（清單上 thread-search 那一列是 openAt: never），只能比標題';

/**
 * 去掉頭尾空白，檢查長度與 NUL。同 dsh host 的 `normalizeSearchQuery`（`list.ts:311-325`）：**在問任何會話之前**，
 * 所以一個不合法的查詢在沒有東西可搜時照樣是錯。
 *
 * @throws {@link ThreadSearchError} `invalid`。
 */
export function normalizeThreadSearchQuery(query: unknown): string {
  if (typeof query !== 'string') throw new ThreadSearchError('invalid', '搜尋的 query 要是字串');
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new ThreadSearchError('invalid', '搜尋的 query 不能是空的');
  if (trimmed.length > THREAD_SEARCH_QUERY_MAX_LENGTH) {
    throw new ThreadSearchError(
      'invalid',
      `搜尋的 query 最多 ${THREAD_SEARCH_QUERY_MAX_LENGTH} 個 UTF-16 code unit`,
    );
  }
  if (trimmed.includes('\0')) throw new ThreadSearchError('invalid', '搜尋的 query 不能含 NUL');
  return trimmed;
}

/** 連續的空白壓成一格、去頭尾，同 dsh `makeSnippet` 的 `normalizeMarkedText`（`query.ts:295-316`）用的 `\s`。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * 截出命中附近的一段，逐行照抄 dsh 的 `makeSnippet`（`query.ts:269-293`）。dsh 從 `highlight()` 的標記找命中；
 * 我們給的是已經壓過空白的全文與命中的位置（code point）。
 *
 * @param text - 壓過空白的那一則。
 * @param matchStart - 第一個命中在第幾個 code point。
 * @param maxChars - 最多幾個 code point。
 */
export function makeSnippet(text: string, matchStart: number, maxChars: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxChars) return text;
  if (maxChars === 1) return '…';
  const matchedIndex = Math.min(matchStart, characters.length - 1);
  let start = Math.max(0, matchedIndex - Math.floor(maxChars / 3));
  const prefix = start > 0 ? '…' : '';
  let suffix = '…';
  let contentLength = maxChars - prefix.length - suffix.length;
  if (contentLength < 1) {
    start = matchedIndex;
    suffix = '';
    contentLength = maxChars - prefix.length - suffix.length;
  } else if (matchedIndex >= start + contentLength) {
    start = matchedIndex - contentLength + 1;
  }
  let end = Math.min(characters.length, start + contentLength);
  if (end === characters.length) {
    suffix = '';
    contentLength = maxChars - prefix.length;
    start = Math.max(0, end - contentLength);
  }
  end = Math.min(characters.length, start + contentLength);
  return `${prefix}${characters.slice(start, end).join('')}${suffix}`;
}

/** 只折 ASCII 的小寫，跟 SQLite 的 `LIKE` 與 `lower()` 同一把尺。 */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]/gu, (letter) => letter.toLowerCase());
}

/** 一則可以搜的。 */
export interface SearchDocument {
  readonly seq: number;
  readonly time: number;
  /** 壓過空白的。 */
  readonly text: string;
}

/**
 * 訊息的文字，扣掉點名子代理時接在後面的提示區塊（[#328](https://github.com/DemianLi/nexus-agent/issues/328)）。
 * 那段是給模型看的固定字，不是使用者打的；不扣掉，搜「子代理」「委派」會命中每一句被點名的話。
 * 與歷史的 `textOf` 同一個判準（`isMentionHintBlock`）。
 */
function textWithoutMentionHint(message: BaseMessage): string {
  const content = message.content;
  if (!Array.isArray(content) || !content.some((block) => isMentionHintBlock(block))) {
    return message.text;
  }
  return content
    .map((block: unknown) => {
      const typed = block as { type?: unknown; text?: unknown } | null;
      return typed?.type === 'text' && typeof typed.text === 'string' && !isMentionHintBlock(block)
        ? typed.text
        : '';
    })
    .join('');
}

/** 一則訊息裡搜得到的字：文字區塊，回覆再加上要叫的工具。各段去頭尾、空的丟掉，同 dsh `extraction.ts:85-87`。 */
function messageText(message: BaseMessage): string {
  const parts = [textWithoutMentionHint(message)];
  if (AIMessage.isInstance(message)) {
    for (const call of message.tool_calls ?? []) parts.push(call.name, JSON.stringify(call.args));
  }
  return collapseWhitespace(
    parts
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join('\n'),
  );
}

/** 推不出歷史的那種日誌：上面表裡那幾種事件全收。形狀不對的那一顆略過（壞掉的日誌逐行撿回來的會有）。 */
function everyMessage(events: readonly SessionEvent[]): [BaseMessage, SessionEvent][] {
  const found: [BaseMessage, SessionEvent][] = [];
  for (const event of events) {
    try {
      if (event.type === 'turn/start') {
        if (event.data.kind !== 'resume') found.push([new HumanMessage(event.data.text), event]);
      } else if (event.type === 'user/message' || event.type === 'assistant/message') {
        found.push([fromLoggedMessage(event.data.message), event]);
      } else if (event.type === 'compaction/summary' && event.data.summary !== undefined) {
        found.push([fromLoggedMessage(event.data.summary), event]);
      }
    } catch {
      continue;
    }
  }
  return found;
}

/**
 * 一份日誌裡搜得到的那幾則，見檔頭的表。照 `seq` 排。
 *
 * @param events - 整份 root 日誌。
 */
export function searchDocuments(events: readonly SessionEvent[]): SearchDocument[] {
  const origins = new Map<BaseMessage, SessionEvent>();
  const replay = replayConversation(events, {
    origin: (message, event) => origins.set(message, event),
  });
  const current: [BaseMessage, SessionEvent][] =
    replay.kind === 'replayed'
      ? replay.messages.flatMap((message): [BaseMessage, SessionEvent][] => {
          const event = origins.get(message);
          return event === undefined ? [] : [[message, event]];
        })
      : everyMessage(events);
  const documents: SearchDocument[] = [];
  for (const [message, event] of current) {
    if (ToolMessage.isInstance(message)) continue;
    const text = messageText(message);
    if (text !== '') documents.push({ seq: event.seq, time: event.time, text });
  }
  return documents.sort((left, right) => left.seq - right.seq);
}

type Sqlite = typeof import('node:sqlite');

export interface ThreadSearchOptions {
  /** serve 的那一個（`<會話根>/<projectKey(cwd)>` 那一格）。**缺席＝沒接落盤**：沒有東西可搜，一律回空。 */
  readonly store?: SessionStore;
  /** 這台 server 的工作目錄，同列表。 */
  readonly cwd: string;
  readonly openAt: ThreadSearchConfig['openAt'];
  /** 載入 `node:sqlite`。測試換掉它來驗「`never` 一次都不載入」與「載不起來」。 */
  readonly loadSqlite?: () => Promise<Sqlite>;
}

const EMPTY: ThreadSearchResult = { items: [], hasMore: false };

/** 一條 thread 在索引裡的樣子：`list` 給的 `revision`。變了就整條重讀。 */
type Stamp = string;

interface Prepared {
  readonly db: DatabaseSync;
  readonly insert: StatementSync;
  /** 按列號刪。**不按 `thread_id` 刪**：那一欄在 FTS5 裡沒有索引，每刪一條就整表掃一次，第一次建索引變成平方（實測 1000 條 17 秒）。 */
  readonly remove: StatementSync;
}

/** 見檔頭。一台 serve 一份。 */
export class ThreadSearch {
  readonly #options: ThreadSearchOptions;
  #prepared: Promise<Prepared> | undefined;
  readonly #stamps = new Map<string, Stamp>();
  /** 每條 thread 佔了哪幾列，刪的時候用。跟 `#stamps` 同進同出。 */
  readonly #rows = new Map<string, readonly (number | bigint)[]>();
  /** 對帳與查詢排成一條隊，同 dsh 的 `_serialized`。 */
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: ThreadSearchOptions) {
    this.#options = options;
  }

  /** `openAt: startup` 時由 serve 起動叫：載入 `node:sqlite`、開好空的索引。其他兩個值什麼都不做。 */
  async open(): Promise<void> {
    if (this.#options.openAt === 'startup') await this.#ready();
  }

  /**
   * 搜一次。順序見 `@nexus/wire` 的 `THREAD_SEARCH_PATH`。
   *
   * @throws {@link ThreadSearchError}；`signal` 中止時拋它的 `reason`。
   */
  async search(query: unknown, signal?: AbortSignal): Promise<ThreadSearchResult> {
    const normalized = collapseWhitespace(normalizeThreadSearchQuery(query));
    signal?.throwIfAborted();
    const { store } = this.#options;
    if (store === undefined) return EMPTY;
    let visible;
    try {
      visible = await listVisibleThreads(store, this.#options.cwd, signal);
    } catch (error: unknown) {
      // 列到一半被中止：拋的是訊號的 reason，不是「列不出來」，同對帳那一段。
      if (signal?.aborted === true) throw error;
      throw new ThreadSearchError('failed', `以前的 thread 列不出來：${String(error)}`, {
        cause: error,
      });
    }
    signal?.throwIfAborted();
    if (visible.items.length === 0) return EMPTY;
    if (this.#options.openAt === 'never') {
      throw new ThreadSearchError('disabled', THREAD_SEARCH_DISABLED_MESSAGE);
    }
    const prepared = await this.#ready();
    return this.#serialized(async () => {
      try {
        await this.#reconcile(prepared, store, visible.items, signal);
        signal?.throwIfAborted();
        return this.#query(prepared.db, normalized);
      } catch (error: unknown) {
        if (signal?.aborted === true || error instanceof ThreadSearchError) throw error;
        throw new ThreadSearchError('failed', `搜尋失敗：${String(error)}`, { cause: error });
      }
    });
  }

  /** 收掉索引。之後的搜尋回失敗。 */
  close(): void {
    this.#closed = true;
    void this.#prepared?.then(({ db }) => db.close()).catch(() => undefined);
  }

  #serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #ready(): Promise<Prepared> {
    if (this.#closed) return Promise.reject(new ThreadSearchError('failed', '搜尋已經收掉了'));
    this.#prepared ??= this.#prepare();
    return this.#prepared;
  }

  async #prepare(): Promise<Prepared> {
    let sqlite: Sqlite;
    try {
      sqlite = await (this.#options.loadSqlite ?? (() => import('node:sqlite')))();
    } catch (error: unknown) {
      this.#prepared = undefined;
      throw new ThreadSearchError(
        'failed',
        `會話內容搜尋要 Node 內建的 node:sqlite（Node 22.13 以上不必加旗標），這台的 ${process.version} 載不起來：${String(error)}`,
        { cause: error },
      );
    }
    const db = new sqlite.DatabaseSync(':memory:');
    db.exec(
      "CREATE VIRTUAL TABLE docs USING fts5(thread_id UNINDEXED, seq UNINDEXED, time UNINDEXED, text, tokenize = 'trigram')",
    );
    return {
      db,
      insert: db.prepare('INSERT INTO docs (thread_id, seq, time, text) VALUES (?, ?, ?, ?)'),
      remove: db.prepare('DELETE FROM docs WHERE rowid = ?'),
    };
  }

  /** 見檔頭的「每次搜尋前先對帳」。 */
  async #reconcile(
    prepared: Prepared,
    store: SessionStore,
    visible: readonly StoredSessionSnapshot[],
    signal?: AbortSignal,
  ): Promise<void> {
    const { db, insert, remove } = prepared;
    const seen = new Set(visible.map(({ header }) => header.id));
    const gone = [...this.#stamps.keys()].filter((threadId) => !seen.has(threadId));
    /** 這一次寫進去的。交易成功之後才併進 `#stamps`／`#rows`。 */
    const written = new Map<string, { stamp: Stamp; rows: (number | bigint)[] }>();
    // **邊讀邊寫**：讀一條、寫一條，不把全部的內容先收在手上。一條一條讀進來的本文用完就丟，第一次建索引時的記憶體
    // 高點只多一條的份。整段包在一個交易裡，同 dsh 的 `BEGIN IMMEDIATE`：中途失敗或中止就整段不算。
    let open = false;
    const begin = (): void => {
      if (open) return;
      db.exec('BEGIN');
      open = true;
    };
    try {
      for (const threadId of gone) {
        begin();
        for (const rowid of this.#rows.get(threadId) ?? []) remove.run(rowid);
      }
      for (const { header, revision } of visible) {
        signal?.throwIfAborted();
        const threadId = header.id;
        if (this.#stamps.get(threadId) === revision) continue;
        const events = await readForSearch(store, threadId);
        // 列與讀之間變了：這一次不動它，下一次對帳再看（被刪掉的那時就在「不見了的」那一邊）。
        if (events === undefined) continue;
        const documents = searchDocuments(events);
        begin();
        for (const rowid of this.#rows.get(threadId) ?? []) remove.run(rowid);
        const rows: (number | bigint)[] = [];
        for (const document of documents) {
          rows.push(
            insert.run(threadId, document.seq, document.time, document.text).lastInsertRowid,
          );
        }
        written.set(threadId, { stamp: revision, rows });
      }
      if (open) db.exec('COMMIT');
    } catch (error: unknown) {
      if (open) db.exec('ROLLBACK');
      if (signal?.aborted === true || error instanceof ThreadSearchError) throw error;
      throw new ThreadSearchError('failed', `寫不進搜尋索引：${String(error)}`, { cause: error });
    }
    // 交易成功之後才記，失敗的那幾條下一次搜尋再讀一次，同 dsh 失敗時 ROLLBACK、下一次再試。
    for (const threadId of gone) {
      this.#stamps.delete(threadId);
      this.#rows.delete(threadId);
    }
    for (const [threadId, { stamp, rows }] of written) {
      this.#stamps.set(threadId, stamp);
      this.#rows.set(threadId, rows);
    }
  }

  #query(db: DatabaseSync, query: string): ThreadSearchResult {
    // `%`、`_` 是 LIKE 的萬用字元，`\` 是我們選的跳脫字元：三個都要跳脫。見檔頭：帶 ESCAPE 就不走索引，所以只在需要時帶。
    const needsEscape = /[%_\\]/u.test(query);
    const pattern = `%${needsEscape ? query.replace(/[%_\\]/gu, (char) => `\\${char}`) : query}%`;
    const lowered = asciiLower(query);
    const rows = db
      .prepare(
        `SELECT thread_id, text FROM (
           SELECT *, row_number() OVER (
             PARTITION BY thread_id ORDER BY hits DESC, length(text) ASC, time DESC, seq DESC
           ) AS rank
           FROM (
             SELECT thread_id, seq, time, text,
               (length(text) - length(replace(lower(text), ?, ''))) / length(?) AS hits
             FROM docs WHERE text LIKE ?${needsEscape ? " ESCAPE '\\'" : ''}
           )
         )
         WHERE rank = 1
         ORDER BY hits DESC, length(text) ASC, time DESC, thread_id ASC, seq DESC
         LIMIT ?`,
      )
      .all(lowered, lowered, pattern, THREAD_SEARCH_RESULT_LIMIT + 1) as {
      thread_id: string;
      text: string;
    }[];
    return {
      hasMore: rows.length > THREAD_SEARCH_RESULT_LIMIT,
      items: rows.slice(0, THREAD_SEARCH_RESULT_LIMIT).map((row) => ({
        threadId: row.thread_id,
        snippet: makeSnippet(
          row.text,
          Array.from(row.text.slice(0, Math.max(0, asciiLower(row.text).indexOf(lowered)))).length,
          THREAD_SEARCH_SNIPPET_MAX_CODE_POINTS,
        ),
      })),
    };
  }
}

/**
 * 讀一條的整份本文。**中間壞掉的撿回讀得懂的**（`salvage`），同列表不擋它。
 *
 * 列與讀之間那一份變了——被刪掉、或 header 讀不懂了（別的行程以更新的版本續接過）——是 `undefined`：
 * 不讓一條拖垮整次搜尋。
 */
async function readForSearch(
  store: SessionStore,
  threadId: string,
): Promise<readonly SessionEvent[] | undefined> {
  try {
    return await (await store.open(threadId, 'read')).read({ salvage: true });
  } catch (error: unknown) {
    if (
      error instanceof SessionNotFoundError ||
      error instanceof SessionCorruptionError ||
      error instanceof SessionFormatUnsupportedError
    ) {
      return undefined;
    }
    throw error;
  }
}
