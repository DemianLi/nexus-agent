/**
 * 按內容搜尋以前的 thread（[#631](https://github.com/DemianLi/nexus-agent/issues/631)）。行為與偏離見 `thread-search.ts` 的檔頭。
 *
 * 日誌由 `SessionLog` 產生、照 JSONL 後端的檔名寫下去，不經 serve，讀經過後端的 `list`／`open(id, 'read')`（#665）：
 * 這一檔問的是「讀出來搜不搜得到、排得對不對」。
 * 線上的形狀與產品路徑在 `serve-thread-search.test.ts`。
 */

import { writeFileSync } from 'node:fs';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  mentionHintText,
  SESSION_LOG_FORMAT_VERSION,
  SessionLog,
  toLoggedMessage,
  userContent,
} from '@nexus/core';
import type { SessionEvent, SessionStore, StoredSessionHeader } from '@nexus/core';
import {
  THREAD_SEARCH_QUERY_MAX_LENGTH,
  THREAD_SEARCH_RESULT_LIMIT,
  THREAD_SEARCH_SNIPPET_MAX_CODE_POINTS,
} from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { openJsonlSessionStore } from './jsonl-session-store.js';
import { LEGACY_TWO_FILE_FORMAT_VERSION } from './session-files.fixture.js';
import {
  makeSnippet,
  searchDocuments,
  THREAD_SEARCH_DISABLED_MESSAGE,
  ThreadSearch,
  ThreadSearchError,
} from './thread-search.js';
import type { LiveThread, ThreadSearchOptions } from './thread-search.js';

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

/** 照 JSONL 後端的舊兩檔檔名寫一份（讀方照讀，續接時遷成世代檔）。 */
async function writeThread(
  directory: string,
  id: string,
  events: readonly SessionEvent[],
  header: { readonly cwd?: string | null; readonly parentSession?: string } = {},
): Promise<void> {
  await writeFile(
    join(directory, `${id}.header.json`),
    JSON.stringify({
      version: LEGACY_TWO_FILE_FORMAT_VERSION,
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
    ...(directory !== undefined && { store: openJsonlSessionStore({ directory }) }),
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

  it('點名子代理：提示區塊不收，只收使用者自己打的字（開場與輪中插話兩條路）', () => {
    const mention = { kind: 'subagent', name: 'reviewer' } as const;
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '請看這份差異', mention });
    log.append('assistant/message', { message: reply('好') });
    log.append('user/message', {
      message: toLoggedMessage(
        new HumanMessage({ content: userContent('順便看測試', [], mention) as never }),
      ),
      source: { kind: 'user' },
    });
    log.append('assistant/message', { message: reply('也看了') });
    log.append('turn/end', {});

    expect(searchDocuments(log.events).map((document) => document.text)).toEqual([
      '請看這份差異',
      '好',
      '順便看測試',
      '也看了',
    ]);
    expect(JSON.stringify(searchDocuments(log.events))).not.toContain(mentionHintText(mention));
    expect(JSON.stringify(searchDocuments(log.events))).not.toContain('system-reminder');
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

describe('中間壞掉的日誌（後端的撿回模式）', () => {
  it('壞的那幾行略過，其餘照一般規則：壓縮換掉的照樣不收', async () => {
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
    const directory = await dir();
    await writeThread(directory, 'clean', log.events);
    await writeThread(directory, 'torn', []);
    await writeFile(join(directory, 'torn.jsonl'), torn);
    const texts = async (id: string) =>
      searchDocuments(
        await (await openJsonlSessionStore({ directory }).open(id, 'read')).read({ salvage: true }),
      ).map((document) => document.text);
    expect(await texts('clean')).toEqual(['A', '摘要', '二', 'B']);
    expect(await texts('torn')).toEqual(['A', '摘要', '二', 'B']);
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
    expect(await ids(engine, 'thread \n\t list')).toEqual(['en']);
    expect(await ids(engine, 'THREAD')).toEqual(['en']);
    expect(await ids(engine, '100%')).toEqual(['pct']);
    expect(await ids(engine, 'snake_case')).toEqual(['under']);
    expect(await ids(engine, '找不到的字')).toEqual([]);
    await engine.close();
  });

  it('點名過的話：搜提示裡的字不命中，搜使用者自己打的字仍然命中', async () => {
    const directory = await dir();
    const mention = { kind: 'subagent', name: 'reviewer' } as const;
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '請看這份差異有沒有問題', mention });
    log.append('assistant/message', { message: reply('看完了') });
    log.append('turn/end', {});
    await writeThread(directory, 'mentioned', log.events);
    const engine = search(directory);

    expect(await ids(engine, '差異有沒有問題')).toEqual(['mentioned']);
    for (const hint of ['委派工具', '子代理', 'subagent_type', 'system-reminder', 'reviewer']) {
      expect(await ids(engine, hint), hint).toEqual([]);
    }
    await engine.close();
  });

  it('一條 thread 一筆；命中多的在前，一樣多時那一則短的在前；片段是那一則', async () => {
    const directory = await dir();
    const once = new SessionLog('t');
    chat(once, '索引只講一次', '好');
    // 同一條裡挑命中多的那則，即使它比較長。
    const twice = new SessionLog('t');
    chat(twice, '索引、索引，這一則比較長', '好');
    chat(twice, '提到索引', '好');
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
        { threadId: 'twice', snippet: '索引、索引，這一則比較長' },
        { threadId: 'short', snippet: '索引短' },
        { threadId: 'once', snippet: '索引只講一次' },
      ],
    });
    await engine.close();
  });

  it(`最多 ${THREAD_SEARCH_RESULT_LIMIT} 筆，多的由 hasMore 講`, async () => {
    const directory = await dir();
    // 同一份事件（連時間都一樣），排序只剩 id 分得開。
    const same = said('同一句話').events;
    for (let index = THREAD_SEARCH_RESULT_LIMIT; index >= 1; index -= 1) {
      await writeThread(directory, `t${String(index).padStart(2, '0')}`, same);
    }
    const engine = search(directory);
    // 剛好 20 筆：沒有更多。
    expect(await engine.search('同一句')).toMatchObject({ hasMore: false });
    await writeThread(directory, 't00', same);
    const result = await engine.search('同一句');
    expect(result.items).toHaveLength(THREAD_SEARCH_RESULT_LIMIT);
    expect(result.hasMore).toBe(true);
    // 什麼都一樣時照 id，同 dsh 的 `session_id ASC`。
    expect(result.items[0]?.threadId).toBe('t00');
    await engine.close();
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
    await engine.close();
  });

  it('每次搜尋前對帳：寫進去的新一輪、新開的 thread 搜得到，刪掉的、壓縮換掉的搜不到', async () => {
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

    // 同一條之後被壓縮：換掉的那幾則要從索引裡拿掉，不是只把新的加上去。
    const compactedFrom = log.events.length;
    log.append('turn/start', { kind: 'message', text: '第三句' });
    log.append('assistant/message', { message: reply('好') });
    log.append('compaction/summary', {
      cutoffIndex: 4,
      messagesBefore: 5,
      filePath: null,
      summary: toLoggedMessage(
        new HumanMessage({
          content: '前情摘要',
          additional_kwargs: { lc_source: 'summarization' },
        }),
      ),
    });
    log.append('turn/end', {});
    await appendFile(join(directory, 'a.jsonl'), jsonl(log.events.slice(compactedFrom)));
    expect(await ids(engine, '第二句')).toEqual([]);
    expect(await ids(engine, '前情摘要')).toEqual(['a']);
    await engine.close();
  });

  it('壓縮過、又死在模型呼叫中間、整份還沒有回覆的那一份：冷讀在記憶體補平（#1598），照常推歷史，換掉的照樣搜不到；檔一個位元組都不動', async () => {
    const directory = await dir();
    const log = new SessionLog('t');
    // 第一輪模型失敗收工：沒有回覆。
    log.append('turn/start', { kind: 'message', text: '第一句' });
    log.append('model/start', {});
    log.append('model/end', { modelCall: 1, outcome: 'error' });
    log.append('turn/failed', { message: '模型掛了' });
    // 第二輪叫模型之前先壓縮，換掉「第一句」；接著死在那次呼叫中間（`model/start` 沒有 `model/end`）。
    // 沒補平的話，重播把開著的呼叫算成跑過、整份又沒有回覆，推不出歷史，退回整份都收。
    log.append('turn/start', { kind: 'message', text: '第二句' });
    log.append('compaction/summary', {
      cutoffIndex: 1,
      messagesBefore: 2,
      beforeCall: true,
      filePath: null,
      summary: toLoggedMessage(
        new HumanMessage({
          content: '前情摘要',
          additional_kwargs: { lc_source: 'summarization' },
        }),
      ),
    });
    log.append('model/start', {});
    await writeThread(directory, 'a', log.events);
    const before = await readFile(join(directory, 'a.jsonl'));
    const engine = search(directory);
    expect(await ids(engine, '第一句')).toEqual([]);
    expect(await ids(engine, '前情摘要')).toEqual(['a']);
    expect(await ids(engine, '第二句')).toEqual(['a']);
    await engine.close();
    expect(await readFile(join(directory, 'a.jsonl'))).toEqual(before);
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
    await engine.close();
  });

  it('列到一半被中止：是 aborted（帶訊號的 reason），不包成「列不出來」；後端真的壞了才是 persistence-failed', async () => {
    const controller = new AbortController();
    const reason = new Error('不搜了');
    const listing = (fail: () => never): SessionStore => ({
      create: () => {
        throw new Error('搜尋不該開新的');
      },
      resume: () => Promise.reject(new Error('搜尋不該續接')),
      open: () => Promise.reject(new Error('還沒列完')),
      list: () => Promise.resolve().then(fail),
    });
    const aborted = search(undefined, {
      store: listing(() => {
        controller.abort(reason);
        throw reason;
      }),
    });
    const stopped = aborted.search('什麼', controller.signal);
    await expect(stopped).rejects.toBeInstanceOf(ThreadSearchError);
    await expect(stopped).rejects.toMatchObject({ kind: 'aborted', cause: reason });
    const broken = search(undefined, {
      store: listing(() => {
        throw new Error('讀不到目錄');
      }),
    });
    await expect(broken.search('什麼')).rejects.toMatchObject({ kind: 'persistence-failed' });
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
      await on.close();
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
      await startup.close();

      const lazy = vi.fn(() => import('node:sqlite'));
      const firstSearch = search(directory, { loadSqlite: lazy });
      await firstSearch.open();
      expect(await firstSearch.search('什麼')).toEqual({ items: [], hasMore: false });
      expect(lazy).not.toHaveBeenCalled();
      await writeThread(directory, 'a', said('什麼').events);
      expect(await ids(firstSearch, '什麼')).toEqual(['a']);
      expect(lazy).toHaveBeenCalledOnce();
      await firstSearch.close();
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
        kind: 'index-failed',
        message: expect.stringContaining('Node 22.13 以上'),
      });
      expect(await ids(engine, '什麼')).toEqual(['a']);
      await engine.close();
    });
  });
});

/** 一道手動放行的閘門：`reached` 在被擋住的那一刻 resolve。 */
function hold() {
  let release!: () => void;
  let reach!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return {
    release,
    reached,
    async wait(): Promise<void> {
      reach();
      await released;
    },
  };
}

/** 包一層真的後端，換掉其中幾支。 */
function wrap(inner: SessionStore, overrides: Partial<SessionStore>): SessionStore {
  return {
    create: (header) => inner.create(header),
    resume: (id) => inner.resume(id),
    list: (options) => inner.list(options),
    open: (id, access) => inner.open(id, access),
    ...overrides,
  };
}

/** 讀到的 header 換成 `change` 改過的那一份，其餘照真的。 */
function rewriteOpenedHeader(
  inner: SessionStore,
  change: (header: StoredSessionHeader) => StoredSessionHeader,
): SessionStore {
  return wrap(inner, {
    open: async (id, access) => {
      const opened = await inner.open(id, access);
      return {
        header: change(opened.header),
        storedFormatVersion: opened.storedFormatVersion,
        read: (options) => opened.read(options),
      };
    },
  });
}

/** 等 `ms` 毫秒，拿來給「還沒 settle」一個期限。 */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/** 給一個 promise 一段期限：期限內 settle 了交出結果或錯誤，沒有就是 `'pending'`。 */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    promise.then(
      (value) => ({ value }),
      (error: unknown) => error,
    ),
    after(ms, 'pending' as const),
  ]);
}

describe('隊伍、收尾與失敗的種類（#1552）', () => {
  /**
   * 第一次搜尋卡在讀日誌（手動放行），第二次的列表跑完、排進隊伍才交出來。
   * `listed` 數 `list` 回來幾次，第二次回來之後再讓微任務跑完，第二次就一定在隊伍裡等。
   */
  async function queued(directory: string) {
    const inner = openJsonlSessionStore({ directory });
    const gate = hold();
    let opens = 0;
    let listed = 0;
    let secondListed!: () => void;
    const secondInQueue = new Promise<void>((resolve) => {
      secondListed = resolve;
    });
    const store = wrap(inner, {
      list: async (options) => {
        const listing = await inner.list(options);
        listed += 1;
        if (listed === 2) secondListed();
        return listing;
      },
      open: async (id, access) => {
        opens += 1;
        if (opens === 1) await gate.wait();
        return inner.open(id, access);
      },
    });
    const engine = search(undefined, { store });
    const first = engine.search('排隊');
    await gate.reached;
    return {
      engine,
      gate,
      first,
      opens: () => opens,
      async enqueue(signal?: AbortSignal) {
        const second = engine.search('排隊', signal);
        second.catch(() => undefined);
        await secondInQueue;
        await after(20, undefined);
        // 包一層：async 函式直接交出 promise 會被攤開，變成等它跑完。
        return { second };
      },
    };
  }

  it('N0829：排在後面的那一次被中止就立刻離隊，不等前面跑完；後面的照常', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('排隊的句子').events);
    const run = await queued(directory);
    const controller = new AbortController();
    const reason = new Error('客戶端斷線');
    const { second } = await run.enqueue(controller.signal);
    controller.abort(reason);

    // 第一次還卡著，第二次已經回來了：是中止，帶著訊號的 reason。
    const outcome = await settledWithin(second, 500);
    expect(outcome).toBeInstanceOf(ThreadSearchError);
    expect(outcome).toMatchObject({ kind: 'aborted', cause: reason });
    expect(run.opens()).toBe(1);

    run.gate.release();
    expect((await run.first).items.map((item) => item.threadId)).toEqual(['a']);
    expect(await ids(run.engine, '排隊')).toEqual(['a']);
    await run.engine.close();
  });

  it('N0829：排在後面時收掉了，輪到它時是 index-failed，不碰索引', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('排隊的句子').events);
    const run = await queued(directory);
    const { second } = await run.enqueue();
    const closing = run.engine.close();

    run.gate.release();
    expect((await run.first).items.map((item) => item.threadId)).toEqual(['a']);
    await expect(second).rejects.toMatchObject({ kind: 'index-failed' });
    await closing;
    // 收掉之後才來的，也是 index-failed。
    await expect(run.engine.search('排隊')).rejects.toMatchObject({ kind: 'index-failed' });
  });

  it('N0829：開索引開到一半被中止，不等它開完就回 aborted；之後照常', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('開索引的句子').events);
    const gate = hold();
    const loadSqlite = async (): Promise<typeof import('node:sqlite')> => {
      await gate.wait();
      return import('node:sqlite');
    };
    const engine = search(directory, { loadSqlite });
    const controller = new AbortController();
    const reason = new Error('客戶端斷線');
    const stopped = engine.search('開索引', controller.signal);
    await gate.reached;
    controller.abort(reason);

    const outcome = await settledWithin(stopped, 500);
    expect(outcome).toBeInstanceOf(ThreadSearchError);
    expect(outcome).toMatchObject({ kind: 'aborted', cause: reason });

    gate.release();
    expect(await ids(engine, '開索引')).toEqual(['a']);
    await engine.close();
  });

  it('N0843：node:sqlite 載得起來、索引卻開不起來，也是 index-failed', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('開不起來的句子').events);
    const loadSqlite = async (): Promise<typeof import('node:sqlite')> => {
      const real = await import('node:sqlite');
      class Broken extends real.DatabaseSync {
        override exec(): void {
          throw new Error('no such module: fts5');
        }
        override close(): void {
          closed += 1;
          super.close();
        }
      }
      return { ...real, DatabaseSync: Broken };
    };
    let closed = 0;
    const engine = search(directory, { loadSqlite });
    await expect(engine.search('句子')).rejects.toMatchObject({
      kind: 'index-failed',
      message: expect.stringContaining('fts5'),
    });
    // 開到一半失敗的那個 db 當下就關掉，同 dsh `schema.ts:74-76`。
    expect(closed).toBe(1);
    await engine.close();
    expect(closed).toBe(1);
  });

  it('N0829／N0836：開索引開到一半時收掉，那一次已經在隊伍裡，照常回結果；收尾在它之後才完成', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('開索引的句子').events);
    const gate = hold();
    const loadSqlite = async (): Promise<typeof import('node:sqlite')> => {
      await gate.wait();
      return import('node:sqlite');
    };
    const engine = search(directory, { loadSqlite });
    const order: string[] = [];
    const searching = engine.search('開索引').then((result) => {
      order.push('搜尋回來');
      return result;
    });
    await gate.reached;
    const closing = engine.close().then(() => {
      order.push('收尾完成');
    });

    gate.release();
    expect((await searching).items.map((item) => item.threadId)).toEqual(['a']);
    await closing;
    expect(order).toEqual(['搜尋回來', '收尾完成']);
  });

  it('讀最後一條時中止：這一次不寫進索引，下一次照樣重讀', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('中止的句子').events);
    const inner = openJsonlSessionStore({ directory });
    const controller = new AbortController();
    let opens = 0;
    const engine = search(undefined, {
      store: wrap(inner, {
        open: async (id, access) => {
          opens += 1;
          const opened = await inner.open(id, access);
          if (opens === 1) controller.abort(new Error('客戶端斷線'));
          return opened;
        },
      }),
    });
    await expect(engine.search('中止', controller.signal)).rejects.toMatchObject({
      kind: 'aborted',
    });
    expect(await ids(engine, '中止')).toEqual(['a']);
    expect(opens).toBe(2);
    await engine.close();
  });

  it('N0836：收尾等已排進來的跑完才關 db；再叫拿到同一個 promise', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('收尾的句子').events);
    const inner = openJsonlSessionStore({ directory });
    const gate = hold();
    const order: string[] = [];
    const store = wrap(inner, {
      open: async (id, access) => {
        await gate.wait();
        const opened = await inner.open(id, access);
        order.push('讀完日誌');
        return opened;
      },
    });
    const loadSqlite = async (): Promise<typeof import('node:sqlite')> => {
      const real = await import('node:sqlite');
      class Recorded extends real.DatabaseSync {
        override close(): void {
          order.push('關 db');
          super.close();
        }
      }
      return { ...real, DatabaseSync: Recorded };
    };
    const engine = search(undefined, { store, loadSqlite });
    const first = engine.search('收尾');
    await gate.reached;

    const closing = engine.close();
    expect(engine.close()).toBe(closing);
    expect(await settledWithin(closing, 100)).toBe('pending');
    expect(order).toEqual([]);

    gate.release();
    expect((await first).items.map((item) => item.threadId)).toEqual(['a']);
    await closing;
    expect(order).toEqual(['讀完日誌', '關 db']);
  });

  it('N0843：讀某一條的日誌出錯是 persistence-failed，不是索引壞了', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('讀不到的句子').events);
    const inner = openJsonlSessionStore({ directory });
    const engine = search(undefined, {
      store: wrap(inner, { open: () => Promise.reject(new Error('磁碟讀錯')) }),
    });
    await expect(engine.search('句子')).rejects.toMatchObject({
      kind: 'persistence-failed',
      message: expect.stringContaining('"a"'),
    });
    await engine.close();
  });

  it('N0858：列表給的與讀到的不是同一條會話（工作目錄不同）是 source-conflict', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('換掉的句子').events);
    const engine = search(undefined, {
      store: rewriteOpenedHeader(openJsonlSessionStore({ directory }), (header) => ({
        ...header,
        cwd: '/專案/乙',
      })),
    });
    await expect(engine.search('句子')).rejects.toMatchObject({ kind: 'source-conflict' });
    await engine.close();
  });

  it('N0858：只差 isSeeded 也是 source-conflict', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('換掉的句子').events);
    const engine = search(undefined, {
      store: rewriteOpenedHeader(openJsonlSessionStore({ directory }), (header) => ({
        ...header,
        isSeeded: true,
      })),
    });
    await expect(engine.search('句子')).rejects.toMatchObject({ kind: 'source-conflict' });
    await engine.close();
  });

  it.each([
    ['id', (header: StoredSessionHeader) => ({ ...header, id: 'b' })],
    ['createdAt', (header: StoredSessionHeader) => ({ ...header, createdAt: 2_000 })],
    ['parentSession', (header: StoredSessionHeader) => ({ ...header, parentSession: 'x' })],
  ])('N0858：只差 %s 也是 source-conflict', async (_field, change) => {
    const directory = await dir();
    await writeThread(directory, 'a', said('換掉的句子').events);
    const engine = search(undefined, {
      store: rewriteOpenedHeader(openJsonlSessionStore({ directory }), change),
    });
    await expect(engine.search('句子')).rejects.toMatchObject({ kind: 'source-conflict' });
    await engine.close();
  });

  it('N0858 的對照：真的後端上新開、續接過、分叉來的 thread 都不誤判', async () => {
    const directory = await dir();
    const store = openJsonlSessionStore({ directory });
    const header = (id: string, extra: Partial<StoredSessionHeader> = {}): StoredSessionHeader => ({
      version: SESSION_LOG_FORMAT_VERSION,
      id,
      createdAt: 1_000,
      cwd: CWD,
      ...extra,
    });

    const fresh = said('新開的暗號');
    const freshStored = store.create(header('fresh'));
    await freshStored.append(fresh.events);
    await freshStored.close();

    const resumedLog = said('續接前的話');
    const before = store.create(header('resumed'));
    await before.append(resumedLog.events);
    await before.close();
    const resumed = await store.resume('resumed');
    const from = resumedLog.events.length;
    chat(resumedLog, '續接後的暗號', '好');
    await resumed.stored.append(resumedLog.events.slice(from));
    await resumed.stored.close();

    const forked = store.create(header('forked', { parentSession: 'fresh', isSeeded: true }));
    await forked.append(said('分叉的暗號').events);
    await forked.close();

    const engine = search(directory);
    expect((await ids(engine, '暗號')).sort()).toEqual(['forked', 'fresh', 'resumed']);
    await engine.close();
  });

  it('日誌裡的 NUL 換成 U+FFFD 才進索引：NUL 後面的字搜得到', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('前面\u0000後面的暗號').events);
    const engine = search(directory);
    expect(await ids(engine, '後面的暗號')).toEqual(['a']);
    await engine.close();
  });
});

/** 盤上那份 header 經讀方讀出來的樣子：同 {@link writeThread} 寫的那幾格，`version` 是這一版（讀方蓋過）。 */
function headerOf(id: string, extra: Partial<StoredSessionHeader> = {}): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1_000, cwd: CWD, ...extra };
}

function live(threadId: string, log: SessionLog, header = headerOf(threadId)): LiveThread {
  return { threadId, log, header };
}

describe('活的 thread 讀記憶體（#1599）', () => {
  it('A：活的那一條讀記憶體，批次窗口還沒寫出去的那一句搜得到', async () => {
    const directory = await dir();
    const log = said('落盤的話');
    await writeThread(directory, 'a', log.events);
    chat(log, '還沒落盤的暗號', '好');
    const engine = search(directory, { liveThreads: () => [live('a', log)] });
    expect(await ids(engine, '還沒落盤的暗號')).toEqual(['a']);
    await engine.close();
  });

  it('B：不在記憶體的照舊冷讀', async () => {
    const directory = await dir();
    const log = said('活的那條');
    await writeThread(directory, 'a', log.events);
    await writeThread(directory, 'b', said('冷的那條的暗號').events);
    const engine = search(directory, { liveThreads: () => [live('a', log)] });
    expect(await ids(engine, '冷的那條的暗號')).toEqual(['b']);
    await engine.close();
  });

  it('C：對帳途中有一條變活，整段重來一次，索引裡是記憶體那一份', async () => {
    const directory = await dir();
    const log = said('落盤的話');
    await writeThread(directory, 'a', log.events);
    chat(log, '記憶體的暗號', '好');
    let calls = 0;
    const engine = search(directory, {
      liveThreads: () => {
        calls += 1;
        return calls === 1 ? [] : [live('a', log)];
      },
    });
    expect(await ids(engine, '記憶體的暗號')).toEqual(['a']);
    // 第一次對帳的開頭與提交前、重來那一次的開頭與提交前。
    expect(calls).toBe(4);
    await engine.close();
  });

  it('C 的變體：重來那一次重新列，途中新寫下的那一條也進索引', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('先有的').events);
    let calls = 0;
    const engine = search(directory, {
      liveThreads: () => {
        calls += 1;
        // 第一次對帳提交之前：`b` 剛寫下、而且活著。用同步寫：這一支是同步的。
        if (calls === 2) {
          writeFileSync(
            join(directory, 'b.header.json'),
            JSON.stringify({ ...headerOf('b'), version: LEGACY_TWO_FILE_FORMAT_VERSION }),
          );
          writeFileSync(join(directory, 'b.jsonl'), jsonl(said('途中寫下的暗號').events));
        }
        return calls === 1 ? [] : [live('b', said('途中寫下的暗號'))];
      },
    });
    expect(await ids(engine, '途中寫下的暗號')).toEqual(['b']);
    await engine.close();
  });

  it('冷讀之後、提交之前日誌被寫了（revision 變了）：同一次搜尋裡重來，索引是新版', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('舊版的話').events);
    const inner = openJsonlSessionStore({ directory });
    let lists = 0;
    const engine = search(undefined, {
      store: wrap(inner, {
        list: async (options) => {
          lists += 1;
          // 第 1 次是搜尋前的列表、冷讀在它之後；第 2 次是提交之前那一次：在它之前把檔換成新版。
          if (lists === 2) await writeThread(directory, 'a', said('新版的暗號，長一點').events);
          return inner.list(options);
        },
      }),
    });
    expect(await ids(engine, '新版的暗號')).toEqual(['a']);
    expect(await ids(engine, '舊版的話')).toEqual([]);
    // 第一次對帳的兩次、重來那一次的兩次；之後那一次搜尋再兩次。
    expect(lists).toBe(6);
    await engine.close();
  });

  it('日誌每次列都在變：重來一次仍不穩定就 persistence-failed', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('句子').events);
    const inner = openJsonlSessionStore({ directory });
    let lists = 0;
    const engine = search(undefined, {
      store: wrap(inner, {
        list: async (options) => {
          lists += 1;
          if (lists > 20) throw new Error('停不下來');
          if (lists > 1) {
            await writeThread(directory, 'a', said(`句子${'又'.repeat(lists)}`).events);
          }
          return inner.list(options);
        },
      }),
    });
    await expect(engine.search('句子')).rejects.toMatchObject({
      kind: 'persistence-failed',
      message: expect.stringContaining('不穩定'),
    });
    expect(lists).toBe(4);
    await engine.close();
  });

  it('兩次列表之間只換了 header（revision 沒變）也算不穩定', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('句子').events);
    const inner = openJsonlSessionStore({ directory });
    let lists = 0;
    const engine = search(undefined, {
      store: wrap(inner, {
        list: async (options) => {
          lists += 1;
          const page = await inner.list(options);
          // 每一輪提交之前那一次（第 2、4 次）換一個建立時間，revision 照真的。每一輪讀之前那一次不換：換了的話冷讀先撞上
          // source-conflict（同 dsh 讀完先比 header）。
          if (lists % 2 === 1) return page;
          return {
            ...page,
            sessions: page.sessions.map((snapshot) => ({
              ...snapshot,
              header: { ...snapshot.header, createdAt: snapshot.header.createdAt + lists },
            })),
          };
        },
      }),
    });
    await expect(engine.search('句子')).rejects.toMatchObject({
      kind: 'persistence-failed',
      message: expect.stringContaining('不穩定'),
    });
    await engine.close();
  });

  it('D：活的集合每次看都不一樣，重來一次仍不穩定就 persistence-failed', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('句子').events);
    let calls = 0;
    const engine = search(directory, {
      liveThreads: () => {
        calls += 1;
        // 拿掉次數上限的話不會停：多看幾次就拋別的錯，讓那一條紅得快。
        if (calls > 20) throw new Error('停不下來');
        return [live(`變來變去-${String(calls)}`, said('別的'))];
      },
    });
    await expect(engine.search('句子')).rejects.toMatchObject({
      kind: 'persistence-failed',
      message: expect.stringContaining('不穩定'),
    });
    expect(calls).toBe(4);
    await engine.close();
  });

  it('D 的對照：不穩定的那一次整段不算，之後穩定了照常搜得到', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('之後的暗號').events);
    let calls = 0;
    let unstable = true;
    const engine = search(directory, {
      liveThreads: () => {
        calls += 1;
        return unstable ? [live(`變來變去-${String(calls)}`, said('別的'))] : [];
      },
    });
    await expect(engine.search('暗號')).rejects.toMatchObject({ kind: 'persistence-failed' });
    unstable = false;
    expect(await ids(engine, '之後的暗號')).toEqual(['a']);
    await engine.close();
  });

  it('E：記憶體那份 header 的工作目錄跟盤上那份不同是 source-conflict', async () => {
    const directory = await dir();
    const log = said('句子');
    await writeThread(directory, 'a', log.events);
    const engine = search(directory, {
      liveThreads: () => [live('a', log, headerOf('a', { cwd: '/專案/乙' }))],
    });
    await expect(engine.search('句子')).rejects.toMatchObject({ kind: 'source-conflict' });
    await engine.close();
  });

  it('E 的對照：記憶體那份跟盤上那份一樣、或拿不到 header 都不誤判', async () => {
    const directory = await dir();
    const log = said('一樣的暗號');
    await writeThread(directory, 'a', log.events);
    const same = search(directory, { liveThreads: () => [live('a', log)] });
    expect(await ids(same, '一樣的暗號')).toEqual(['a']);
    await same.close();
    const none = search(directory, {
      liveThreads: () => [{ threadId: 'a', log, header: undefined }],
    });
    expect(await ids(none, '一樣的暗號')).toEqual(['a']);
    await none.close();
  });

  it('F：同一條活 thread 多講一句（還沒寫出去），下一次搜尋就搜得到', async () => {
    const directory = await dir();
    const log = said('第一句');
    await writeThread(directory, 'a', log.events);
    const engine = search(directory, { liveThreads: () => [live('a', log)] });
    expect(await ids(engine, '第一句')).toEqual(['a']);
    chat(log, '第二句的暗號', '好');
    expect(await ids(engine, '第二句的暗號')).toEqual(['a']);
    await engine.close();
  });

  it('收掉之後換回冷讀：盤上那份後來多寫的照樣讀進來', async () => {
    const directory = await dir();
    const log = said('第一句');
    await writeThread(directory, 'a', log.events);
    let alive = true;
    const engine = search(directory, { liveThreads: () => (alive ? [live('a', log)] : []) });
    expect(await ids(engine, '第一句')).toEqual(['a']);
    chat(log, '收掉前寫出去的暗號', '好');
    await writeThread(directory, 'a', log.events);
    alive = false;
    expect(await ids(engine, '收掉前寫出去的暗號')).toEqual(['a']);
    await engine.close();
  });

  it('還沒落盤的活 thread 不進索引：可見的集合照舊是列表的', async () => {
    const directory = await dir();
    await writeThread(directory, 'a', said('盤上的').events);
    const engine = search(directory, {
      liveThreads: () => [live('沒落盤', said('只在記憶體的暗號'))],
    });
    expect(await ids(engine, '只在記憶體的暗號')).toEqual([]);
    await engine.close();
  });
});
