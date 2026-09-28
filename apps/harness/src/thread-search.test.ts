/**
 * 按內容搜尋以前的 thread（[#631](https://github.com/DemianLi/nexus-agent/issues/631)）。行為與偏離見 `thread-search.ts` 的檔頭。
 *
 * 日誌由 `SessionLog` 產生、照 JSONL 後端的檔名寫下去，不經 serve：這一檔問的是「讀出來搜不搜得到、排得對不對」。
 * 線上的形狀與產品路徑在 `serve-thread-search.test.ts`。
 */

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { SESSION_LOG_FORMAT_VERSION, SessionLog, toLoggedMessage } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import {
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  THREAD_SEARCH_RESULT_LIMIT,
  THREAD_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import {
  documentsOf,
  makeSnippet,
  searchDocuments,
  THREAD_SEARCH_DISABLED_MESSAGE,
  ThreadSearch,
  ThreadSearchError,
} from './thread-search.js';
import type { ThreadSearchOptions } from './thread-search.js';

const CWD = '/專案/甲';

function reply(text: string) {
  return toLoggedMessage(new AIMessage(text));
}

/** 一輪只講話。 */
function chat(log: SessionLog, said: string, answered: string): void {
  log.append('turn/start', { kind: 'message', text: said });
  log.append('assistant/message', { message: reply(answered) });
  log.append('turn/end', {});
}

function said(text: string): SessionLog {
  const log = new SessionLog('t');
  chat(log, text, '好');
  return log;
}

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nexus-thread-search-'));
}

/** 照 JSONL 後端的檔名寫一份。 */
async function writeThread(
  directory: string,
  id: string,
  events: readonly SessionEvent[],
  header: { readonly cwd?: string | null; readonly parentSession?: string } = {},
): Promise<void> {
  await writeFile(
    join(directory, `${id}.header.json`),
    JSON.stringify({
      version: SESSION_LOG_FORMAT_VERSION,
      id,
      createdAt: 1_000,
      ...(header.cwd === null ? {} : { cwd: header.cwd ?? CWD }),
      ...(header.parentSession === undefined ? {} : { parentSession: header.parentSession }),
    }),
  );
  await writeFile(join(directory, `${id}.jsonl`), jsonl(events));
}

function jsonl(events: readonly SessionEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join('');
}

function search(directory: string | undefined, overrides: Partial<ThreadSearchOptions> = {}) {
  return new ThreadSearch({
    cwd: CWD,
    openAt: 'first-search',
    ...(directory !== undefined && { directory }),
    ...overrides,
  });
}

async function ids(engine: ThreadSearch, query: string): Promise<string[]> {
  return (await engine.search(query)).items.map((item) => item.threadId);
}

describe('搜得到哪幾則（searchDocuments）', () => {
  it('人打的字、目標排的那一輪、外掛塞的、回覆與它要叫的工具；推理、工具結果、resume 不收', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '幫我  看\n一下' });
    log.append('assistant/message', {
      message: toLoggedMessage(
        new AIMessage({
          content: [
            { type: 'reasoning', reasoning: '私下的推理' },
            { type: 'text', text: '我來讀' },
          ],
          tool_calls: [
            { id: 'c1', name: 'read_file', args: { path: 'src/清單.ts' }, type: 'tool_call' },
          ],
        }),
      ),
    });
    log.append('tool/call', { callId: 'c1', name: 'read_file', arguments: '{}' });
    log.append('tool/result', {
      callId: 'c1',
      isError: false,
      message: toLoggedMessage(
        new ToolMessage({ content: '檔案內容不該搜到', tool_call_id: 'c1', name: 'read_file' }),
      ),
    });
    log.append('user/message', {
      message: toLoggedMessage(new HumanMessage('外掛的提醒')),
      source: { kind: 'plugin', plugin: 'repeat-reminder' },
    });
    log.append('assistant/message', { message: reply('讀完了') });
    log.append('turn/end', {});
    log.append('turn/start', {
      kind: 'goal',
      text: '目標續行',
      goalId: 'g1' as never,
      revision: 1,
      round: 1,
    });
    log.append('assistant/message', { message: reply('續') });
    log.append('turn/end', {});

    expect(searchDocuments(log.events).map((document) => document.text)).toEqual([
      '幫我 看 一下',
      '我來讀 read_file {"path":"src/清單.ts"}',
      '外掛的提醒',
      '讀完了',
      '目標續行',
      '續',
    ]);
    const all = JSON.stringify(searchDocuments(log.events));
    expect(all).not.toContain('私下的推理');
    expect(all).not.toContain('不該搜到');
  });

  it('壓縮：被換掉的那幾則不收，換上去的摘要收（同 dsh 只查 current）', () => {
    const log = new SessionLog('t');
    chat(log, '一', 'A');
    chat(log, '二', 'B');
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('assistant/message', { message: reply('C') });
    log.append('compaction/summary', {
      cutoffIndex: 3,
      messagesBefore: 5,
      filePath: null,
      summary: toLoggedMessage(
        new HumanMessage({ content: '摘要', additional_kwargs: { lc_source: 'summarization' } }),
      ),
    });
    log.append('turn/end', {});

    const documents = searchDocuments(log.events);
    expect(documents.map((document) => document.text)).toEqual(['B', '三', 'C', '摘要']);
    // 帶的是各自那一顆的 seq，不是推出來的串裡的位置。
    const seqOf = (type: string, nth = 0) =>
      log.events.filter((event) => event.type === type)[nth]!.seq;
    expect(documents.map((document) => document.seq)).toEqual([
      seqOf('assistant/message', 1),
      seqOf('turn/start', 2),
      seqOf('assistant/message', 2),
      seqOf('compaction/summary'),
    ]);
  });

  it('推不出歷史的舊日誌（壓縮對不上）：分不出哪幾則被換掉，整份都收', () => {
    const log = new SessionLog('t');
    chat(log, '一', 'A');
    log.append('compaction/summary', {
      cutoffIndex: 1,
      messagesBefore: 99,
      filePath: null,
      summary: toLoggedMessage(new HumanMessage('摘要')),
    });
    expect(searchDocuments(log.events).map((document) => document.text)).toEqual([
      '一',
      'A',
      '摘要',
    ]);
  });
});

describe('中間壞掉的日誌（documentsOf）', () => {
  it('壞的那幾行略過，其餘照一般規則：壓縮換掉的照樣不收', () => {
    const log = new SessionLog('t');
    chat(log, '一', 'A');
    // 回覆「A」之後壓縮：那一刻推出來兩則，`messagesBefore` 是 1，切掉「一」。
    log.append('compaction/summary', {
      cutoffIndex: 1,
      messagesBefore: 1,
      filePath: null,
      summary: toLoggedMessage(new HumanMessage('摘要')),
    });
    chat(log, '二', 'B');
    const lines = jsonl(log.events).split('\n');
    const torn = [...lines.slice(0, 3), '{壞掉', ...lines.slice(3)].join('\n');
    const texts = (body: string) => documentsOf('t', body).map((document) => document.text);
    expect(texts(jsonl(log.events))).toEqual(['A', '摘要', '二', 'B']);
    expect(texts(torn)).toEqual(['A', '摘要', '二', 'B']);
  });
});

describe('片段（同 dsh 的 makeSnippet）', () => {
  it('短的原樣；長的從命中往前三分之一起截，前後標 …，最多 240 個 code point', () => {
    expect(makeSnippet('短短一句', 2, 240)).toBe('短短一句');
    const text = `${'前'.repeat(300)}命中${'後'.repeat(300)}`;
    const snippet = makeSnippet(text, 300, THREAD_SEARCH_SNIPPET_MAX_CODE_POINTS);
    expect(Array.from(snippet)).toHaveLength(240);
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    // 命中前面留 240/3 = 80 個（含開頭的 …）。
    expect(snippet.indexOf('命中')).toBe(81);
  });

  it('命中在尾巴：後面不加 …，往前補滿', () => {
    const text = `${'前'.repeat(300)}命中`;
    const snippet = makeSnippet(text, 300, 240);
    expect(snippet.endsWith('命中')).toBe(true);
    expect(Array.from(snippet)).toHaveLength(240);
  });
});

describe('ThreadSearch', () => {
  it('中文句子中間的兩個字、四個字都搜得到；英文不分大小寫；空白算一個；% 與 _ 照字面', async () => {
    const directory = await dir();
    await writeThread(directory, 'zh', said('請幫我修正會話清單的搜尋功能').events);
    await writeThread(directory, 'en', said('Refactor the Thread  List component').events);
    await writeThread(directory, 'pct', said('覆蓋率到 100% 了').events);
    await writeThread(directory, 'under', said('改 snake_case 的名字').events);
    await writeThread(directory, 'decoy', said('1000 個 snakeXcase 項目').events);
    const engine = search(directory);

    expect(await ids(engine, '會話')).toEqual(['zh']);
    expect(await ids(engine, '會話清單')).toEqual(['zh']);
    expect(await ids(engine, '  搜尋  ')).toEqual(['zh']);
    expect(await ids(engine, 'thread list')).toEqual(['en']);
    expect(await ids(engine, 'THREAD')).toEqual(['en']);
    expect(await ids(engine, '100%')).toEqual(['pct']);
    expect(await ids(engine, 'snake_case')).toEqual(['under']);
    expect(await ids(engine, '找不到的字')).toEqual([]);
    engine.close();
  });

  it('一條 thread 一筆；命中多的在前，一樣多時那一則短的在前；片段是那一則', async () => {
    const directory = await dir();
    const once = new SessionLog('t');
    chat(once, '索引只講一次', '好');
    const twice = new SessionLog('t');
    chat(twice, '索引、索引', '好');
    chat(twice, '又提到索引一次，這一則比較長', '好');
    const shortOne = new SessionLog('t');
    chat(shortOne, '索引短', '好');
    await writeThread(directory, 'once', once.events);
    await writeThread(directory, 'twice', twice.events);
    await writeThread(directory, 'short', shortOne.events);
    const engine = search(directory);

    const result = await engine.search('索引');
    expect(result).toEqual({
      hasMore: false,
      items: [
        { threadId: 'twice', snippet: '索引、索引' },
        { threadId: 'short', snippet: '索引短' },
        { threadId: 'once', snippet: '索引只講一次' },
      ],
    });
    engine.close();
  });

  it(`最多 ${THREAD_SEARCH_RESULT_LIMIT} 筆，多的由 hasMore 講`, async () => {
    const directory = await dir();
    // 同一份事件（連時間都一樣），排序只剩 id 分得開。
    const same = said('同一句話').events;
    for (let index = THREAD_SEARCH_RESULT_LIMIT; index >= 0; index -= 1) {
      await writeThread(directory, `t${String(index).padStart(2, '0')}`, same);
    }
    const engine = search(directory);
    const result = await engine.search('同一句');
    expect(result.items).toHaveLength(THREAD_SEARCH_RESULT_LIMIT);
    expect(result.hasMore).toBe(true);
    // 什麼都一樣時照 id，同 dsh 的 `session_id ASC`。
    expect(result.items[0]?.threadId).toBe('t00');
    engine.close();
  });

  it('只搜列得出來的：別的目錄、subagent、header 讀不懂的都不收', async () => {
    const directory = await dir();
    await writeThread(directory, 'mine', said('暗號甲乙丙').events);
    await writeThread(directory, 'other', said('暗號甲乙丙').events, { cwd: '/專案/乙' });
    await writeThread(directory, 'nocwd', said('暗號甲乙丙').events, { cwd: null });
    await writeThread(directory, 'child', said('暗號甲乙丙').events, { parentSession: 'mine' });
    await writeFile(join(directory, 'broken.header.json'), '{壞掉');
    await writeFile(join(directory, 'broken.jsonl'), jsonl(said('暗號甲乙丙').events));
    const engine = search(directory);
    expect(await ids(engine, '暗號')).toEqual(['mine']);
    engine.close();
  });

  it('每次搜尋前對帳：寫進去的新一輪、新開的 thread 搜得到，刪掉的搜不到', async () => {
    const directory = await dir();
    const log = said('第一句');
    await writeThread(directory, 'a', log.events);
    const engine = search(directory);
    expect(await ids(engine, '第二句')).toEqual([]);

    const before = log.events.length;
    chat(log, '第二句', '好');
    await appendFile(join(directory, 'a.jsonl'), jsonl(log.events.slice(before)));
    await writeThread(directory, 'b', said('第二句也在這').events);
    expect(await ids(engine, '第二句')).toEqual(['a', 'b']);

    await rm(join(directory, 'b.header.json'));
    expect(await ids(engine, '第二句')).toEqual(['a']);
    engine.close();
  });

  it('只有 header 的沒東西；日誌中間壞掉的：壞的那行略過、其餘照收（同列表），不拖垮其他條', async () => {
    const directory = await dir();
    await writeThread(directory, 'good', said('好好的一句').events);
    await writeThread(directory, 'blank', []);
    await rm(join(directory, 'blank.jsonl'));
    await writeThread(directory, 'torn', []);
    await writeFile(join(directory, 'torn.jsonl'), `{壞掉\n${jsonl(said('好好的一句').events)}`);
    const engine = search(directory);
    expect((await ids(engine, '好好的')).sort()).toEqual(['good', 'torn']);
    engine.close();
  });

  describe('先後：查詢 → 沒東西可搜 → 不開（同 dsh `list.ts:163-266`）', () => {
    it('查詢不合法：有沒有東西可搜都是 invalid', async () => {
      const engine = search(undefined, { openAt: 'never' });
      for (const query of ['', '   ', 'a\0b', 'x'.repeat(THREAD_SEARCH_QUERY_MAX_LENGTH + 1), 42]) {
        await expect(engine.search(query)).rejects.toMatchObject({ kind: 'invalid' });
      }
      // 上限算的是去掉頭尾空白之後的。
      await expect(
        engine.search(` ${'x'.repeat(THREAD_SEARCH_QUERY_MAX_LENGTH)} `),
      ).resolves.toEqual({ items: [], hasMore: false });
    });

    it('`never`：沒有東西可搜時回空，有的話回失敗；node:sqlite 一次都不載入', async () => {
      const loadSqlite = vi.fn(() => import('node:sqlite'));
      const directory = await dir();
      const off = search(directory, { openAt: 'never', loadSqlite });
      expect(await off.search('什麼')).toEqual({ items: [], hasMore: false });
      await off.open();
      await writeThread(directory, 'a', said('什麼都有').events);
      const refused = off.search('什麼');
      await expect(refused).rejects.toBeInstanceOf(ThreadSearchError);
      await expect(refused).rejects.toMatchObject({
        kind: 'disabled',
        message: THREAD_SEARCH_DISABLED_MESSAGE,
      });
      expect(loadSqlite).not.toHaveBeenCalled();

      // 對照：同一份目錄，設成開的就搜得到——上面的失敗是設定造成的，不是目錄。
      const on = search(directory, { loadSqlite });
      expect(await ids(on, '什麼')).toEqual(['a']);
      expect(loadSqlite).toHaveBeenCalledOnce();
      on.close();
    });

    it('沒接落盤（沒有目錄）：回空，設定開或關都一樣', async () => {
      const loadSqlite = vi.fn(() => import('node:sqlite'));
      for (const openAt of ['never', 'first-search', 'startup'] as const) {
        const engine = search(undefined, { openAt, loadSqlite });
        expect(await engine.search('什麼')).toEqual({ items: [], hasMore: false });
      }
      expect(loadSqlite).not.toHaveBeenCalled();
    });

    it('`startup` 在 open 就載入；`first-search` 到第一次有東西可搜才載入', async () => {
      const directory = await dir();
      const eager = vi.fn(() => import('node:sqlite'));
      const startup = search(directory, { openAt: 'startup', loadSqlite: eager });
      await startup.open();
      expect(eager).toHaveBeenCalledOnce();
      startup.close();

      const lazy = vi.fn(() => import('node:sqlite'));
      const firstSearch = search(directory, { loadSqlite: lazy });
      await firstSearch.open();
      expect(await firstSearch.search('什麼')).toEqual({ items: [], hasMore: false });
      expect(lazy).not.toHaveBeenCalled();
      await writeThread(directory, 'a', said('什麼').events);
      expect(await ids(firstSearch, '什麼')).toEqual(['a']);
      expect(lazy).toHaveBeenCalledOnce();
      firstSearch.close();
    });

    it('node:sqlite 載不起來（Node 太舊）：回失敗、講要哪一版；下一次再試', async () => {
      const directory = await dir();
      await writeThread(directory, 'a', said('什麼').events);
      const tooOld = Object.assign(new Error('No such built-in module: node:sqlite'), {
        code: 'ERR_UNKNOWN_BUILTIN_MODULE',
      });
      const loadSqlite = vi
        .fn<() => Promise<typeof import('node:sqlite')>>()
        .mockRejectedValueOnce(tooOld)
        .mockImplementation(() => import('node:sqlite'));
      const engine = search(directory, { loadSqlite });
      await expect(engine.search('什麼')).rejects.toMatchObject({
        kind: 'failed',
        message: expect.stringContaining('Node 22.13 以上'),
      });
      expect(await ids(engine, '什麼')).toEqual(['a']);
      engine.close();
    });
  });
});
