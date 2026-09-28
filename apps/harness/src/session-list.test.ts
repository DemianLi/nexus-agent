/**
 * 冷讀的 thread 列表——[#302](https://github.com/DemianLi/nexus-agent/issues/302)。
 *
 * 檔案都是手寫的，不經 serve：這一檔問的是「讀出來對不對」，產品路徑上的「列表不建 agent、不拿租約」
 * 在 `serve-session-list.test.ts`。讀都經過 JSONL 後端的 `list`／`open(id, 'read')`（#665）；最後一條換成不落檔的
 * 假 `SessionStore`，驗列表只靠介面。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_LOG_FORMAT_VERSION, SessionNotFoundError } from '@nexus/core';
import type { SessionEvent, SessionStore, StoredSessionHeader } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { listStoredThreads } from './session-list.js';

const CWD = '/專案/甲';
const LIMITS = { maxWords: 5, maxBytes: 40 };

interface Draft {
  readonly type: string;
  readonly time: number;
  readonly data: unknown;
}

function said(text: string, time: number): Draft {
  return { type: 'turn/start', time, data: { kind: 'message', text } };
}

function goalTurn(time: number): Draft {
  return {
    type: 'turn/start',
    time,
    data: { kind: 'goal', text: '繼續', goalId: 'g1', revision: 1, round: 1 },
  };
}

function ended(time: number): Draft {
  return { type: 'turn/end', time, data: {} };
}

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'nexus-session-list-'));
}

/** 讀 `directory` 的那個後端。 */
function store(directory: string): SessionStore {
  return openJsonlSessionStore({ directory });
}

/** 照 JSONL 後端的檔名寫一份（`base` 省略就是 id）。`events` 省略即只有 header。 */
async function writeThread(
  directory: string,
  id: string,
  options: {
    readonly cwd?: string | null;
    readonly createdAt?: number;
    readonly version?: number;
    readonly parentSession?: string;
    readonly events?: readonly Draft[];
    /** 接在最後、沒有換行的那一段。 */
    readonly tail?: string;
    readonly base?: string;
  } = {},
): Promise<void> {
  const base = options.base ?? id;
  const header = {
    version: options.version ?? SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: options.createdAt ?? 1_000,
    ...(options.cwd === null ? {} : { cwd: options.cwd ?? CWD }),
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
  };
  await writeFile(join(directory, `${base}.header.json`), JSON.stringify(header));
  if (options.events === undefined) return;
  const body = options.events
    .map(
      (event, seq) =>
        `${JSON.stringify({ type: event.type, seq, time: event.time, data: event.data })}\n`,
    )
    .join('');
  await writeFile(join(directory, `${base}.jsonl`), `${body}${options.tail ?? ''}`);
}

describe('listStoredThreads', () => {
  it('由新到舊：最後一則人打的字與建立時間取大的；目標排的輪次不算；一樣時照 id', async () => {
    const directory = await dir();
    await writeThread(directory, 'old', {
      createdAt: 1_000,
      events: [said('早', 2_000), ended(2_100)],
    });
    await writeThread(directory, 'recent', {
      createdAt: 1_000,
      events: [said('先', 3_000), ended(3_100), said('後', 5_000), ended(5_100)],
    });
    // 目標那一輪在 9_000，比誰都晚——但它不是人講的話，不推 updatedAt。
    await writeThread(directory, 'goal', {
      createdAt: 1_500,
      events: [said('設目標', 1_600), ended(1_700), goalTurn(9_000), ended(9_100)],
    });
    // 沒有任何人講話：updatedAt 就是建立時間。
    await writeThread(directory, 'fresh', { createdAt: 4_000, events: [] });
    await writeThread(directory, 'tie-b', { createdAt: 2_000, events: [] });
    await writeThread(directory, 'tie-a', { createdAt: 2_000, events: [] });

    const { items } = await listStoredThreads(store(directory), { cwd: CWD, title: LIMITS });
    expect(items.map((item) => [item.threadId, item.updatedAt])).toEqual([
      ['recent', 5_000],
      ['fresh', 4_000],
      ['old', 2_000],
      ['tie-a', 2_000],
      ['tie-b', 2_000],
      ['goal', 1_600],
    ]);
  });

  it('標題是第一則人打的字；三種狀態分得開：有標題、只有目標的輪次、空白', async () => {
    const directory = await dir();
    await writeThread(directory, 'talked', {
      events: [goalTurn(1_100), said('第一句', 1_200), said('第二句', 1_300)],
    });
    await writeThread(directory, 'goal-only', { events: [goalTurn(1_100), ended(1_200)] });
    await writeThread(directory, 'no-turn', {
      events: [{ type: 'sandbox/mode', time: 1_100, data: { mode: 'read-only' } }],
    });
    // 只有 header：還沒寫第一筆就當了。
    await writeThread(directory, 'header-only');

    const { items } = await listStoredThreads(store(directory), { cwd: CWD, title: LIMITS });
    const byId = Object.fromEntries(items.map((item) => [item.threadId, item]));
    expect(byId['talked']).toMatchObject({ title: '第一句', blank: false });
    expect(byId['goal-only']).toEqual(expect.objectContaining({ blank: false }));
    expect(byId['goal-only']).not.toHaveProperty('title');
    expect(byId['no-turn']).toMatchObject({ blank: true });
    expect(byId['no-turn']).not.toHaveProperty('title');
    expect(byId['header-only']).toMatchObject({ blank: true });
  });

  it('記了標題就讀最後一顆；工具參數裡提到 session/title、形狀不對的都不算（#647）', async () => {
    const directory = await dir();
    const titled = (title: unknown, time: number): Draft => ({
      type: 'session/title',
      time,
      data: { title, messageSeqs: [0], source: { kind: 'fallback' } },
    });
    await writeThread(directory, 'logged', {
      events: [said('第一句', 1_100), titled('記下的標題', 1_101), titled('後來的標題', 1_300)],
    });
    // 記的標題跟第一句推出來的不一樣：讀到的是記的，不是當場推的。
    await writeThread(directory, 'noise', {
      events: [
        said('第一句', 1_100),
        {
          type: 'tool/call',
          time: 1_200,
          data: { callId: 'c', name: 'grep', arguments: '{"pattern":"session/title"}' },
        },
        titled(42, 1_300),
      ],
    });

    const { items } = await listStoredThreads(store(directory), { cwd: CWD, title: LIMITS });
    const byId = Object.fromEntries(items.map((item) => [item.threadId, item]));
    expect(byId['logged']).toMatchObject({ title: '後來的標題' });
    // 一顆像樣的 `session/title` 都沒有：照舊從第一句推。
    expect(byId['noise']).toMatchObject({ title: '第一句' });
  });

  it('只列切得過去的：subagent、別的目錄、沒記目錄的都不列，也不算讀不懂', async () => {
    const directory = await dir();
    await writeThread(directory, 'root', { events: [said('我的', 1_100)] });
    await writeThread(directory, 'root/task', {
      base: 'root%2ftask',
      parentSession: 'root',
      events: [],
    });
    // `projectKey` 有損：別的目錄可能落在同一格，header 的 cwd 才分得開。
    await writeThread(directory, 'elsewhere', { cwd: '/專案/乙', events: [said('別人的', 1_100)] });
    await writeThread(directory, 'nowhere', { cwd: null, events: [said('沒記的', 1_100)] });

    const listed = await listStoredThreads(store(directory), { cwd: CWD, title: LIMITS });
    expect(listed.items.map((item) => item.threadId)).toEqual(['root']);
    expect(listed.unreadable).toBe(0);
  });

  it('header 讀不懂、版本太新：不列，但數出來', async () => {
    const directory = await dir();
    await writeThread(directory, 'good', { events: [] });
    await writeFile(join(directory, 'broken.header.json'), '{壞的');
    await writeFile(
      join(directory, 'no-id.header.json'),
      JSON.stringify({ version: 1, createdAt: 1 }),
    );
    await writeThread(directory, 'future', { version: SESSION_LOG_FORMAT_VERSION + 1, events: [] });

    const listed = await listStoredThreads(store(directory), { cwd: CWD, title: LIMITS });
    expect(listed.items.map((item) => item.threadId)).toEqual(['good']);
    expect(listed.unreadable).toBe(3);
  });

  it('撕裂的尾巴不算；工具參數裡提到 turn/start 不會被當成一輪', async () => {
    const directory = await dir();
    await writeThread(directory, 'torn', {
      events: [said('完整的', 1_100)],
      // 寫到一半的那一行：當掉的常態，讀方不算它。
      tail: '{"type":"turn/start","seq":1,"time":9000,"data":{"kind":"message","te',
    });
    await writeThread(directory, 'mention', {
      events: [
        {
          type: 'tool/call',
          time: 1_100,
          data: { callId: 'c1', name: 'grep', arguments: '{"pattern":"turn/start"}' },
        },
      ],
    });

    const { items } = await listStoredThreads(store(directory), { cwd: CWD, title: LIMITS });
    const byId = Object.fromEntries(items.map((item) => [item.threadId, item]));
    expect(byId['torn']).toMatchObject({ title: '完整的', updatedAt: 1_100 });
    expect(byId['mention']).toMatchObject({ blank: true });
  });

  it('日誌中間壞掉：照樣列出來，讀得懂的照算，不算讀不懂（點下去由續接講原因）', async () => {
    const directory = await dir();
    await writeThread(directory, 'broken', { events: [] });
    await writeFile(
      join(directory, 'broken.jsonl'),
      [
        JSON.stringify({
          type: 'turn/start',
          seq: 0,
          time: 1_100,
          data: { kind: 'message', text: '壞之前' },
        }),
        '{壞掉',
        JSON.stringify({
          type: 'turn/start',
          seq: 2,
          time: 1_300,
          data: { kind: 'message', text: '壞之後' },
        }),
        '',
      ].join('\n'),
    );

    const listed = await listStoredThreads(store(directory), { cwd: CWD, title: LIMITS });
    expect(listed).toEqual({
      items: [{ threadId: 'broken', updatedAt: 1_300, blank: false, title: '壞之前' }],
      unreadable: 0,
    });
  });

  it('目錄還不存在：空的，不拋', async () => {
    const listed = await listStoredThreads(store(join(await dir(), '還沒有')), {
      cwd: CWD,
      title: LIMITS,
    });
    expect(listed).toEqual({ items: [], unreadable: 0 });
  });

  it.each([
    ['maxWords 是 0', { maxWords: 0, maxBytes: 40 }],
    ['maxBytes 不是整數', { maxWords: 5, maxBytes: 1.5 }],
  ])('上限不合法（%s）：空目錄也當場拋', async (_label, title) => {
    await expect(listStoredThreads(store(await dir()), { cwd: CWD, title })).rejects.toThrow(
      '正整數',
    );
  });

  /**
   * **冷讀的一半在這一層就量得到**：續接那條路會拿寫租約，別的把手握著時它拋；列表不拿，所以照樣列得出來，
   * 而且兩個檔一個位元組都沒動。產品路徑上的另一半（不建 agent）在 `serve-session-list.test.ts`。
   */
  it('別的把手握著那一份：照樣列得出來，header 與日誌都沒動', async () => {
    const directory = await dir();
    await writeThread(directory, 'held', { events: [said('握著的', 1_100)], tail: '{"半行' });
    const headerPath = join(directory, 'held.header.json');
    const logPath = join(directory, 'held.jsonl');
    const before = [await readFile(headerPath, 'utf8'), await readFile(logPath, 'utf8')];
    const holder = await openJsonlSessionStore({ directory }).resume('held');
    try {
      const { items } = await listStoredThreads(store(directory), { cwd: CWD, title: LIMITS });
      expect(items.map((item) => item.threadId)).toEqual(['held']);
    } finally {
      await holder.stored.close();
    }
    expect([await readFile(headerPath, 'utf8'), await readFile(logPath, 'utf8')]).toEqual(before);
  });

  /**
   * **列表只靠 `SessionStore`**（#665）：一個不落檔的假後端也列得出 id、標題與 `blank`，`unreadable` 照後端說的轉交。
   * 列與讀之間被刪掉的那一份（`open` 拋 not found）不列、不算讀不懂。
   */
  it('不落檔的假後端：照樣列得出 threadId、標題與 blank', async () => {
    const header = (id: string, extra: Partial<StoredSessionHeader> = {}): StoredSessionHeader => ({
      version: SESSION_LOG_FORMAT_VERSION,
      id,
      createdAt: 1_000,
      cwd: CWD,
      ...extra,
    });
    const event = (draft: Draft, seq: number) => ({ ...draft, seq }) as unknown as SessionEvent;
    const stored = new Map<string, { header: StoredSessionHeader; events: SessionEvent[] }>([
      ['talked', { header: header('talked'), events: [event(said('假後端的第一句', 2_000), 0)] }],
      ['empty', { header: header('empty', { createdAt: 1_500 }), events: [] }],
      ['child', { header: header('talked/sub', { parentSession: 'talked' }), events: [] }],
    ]);
    const fake: SessionStore = {
      create: () => {
        throw new Error('列表不該開新的');
      },
      resume: () => Promise.reject(new Error('列表不該續接')),
      list: () =>
        Promise.resolve({
          sessions: [
            ...[...stored.values()].map(({ header: h }) => ({ header: h, revision: 'r' })),
            { header: header('gone'), revision: 'r' },
          ],
          unreadable: 2,
        }),
      open: (id) => {
        const found = [...stored.values()].find(({ header: h }) => h.id === id);
        if (found === undefined) return Promise.reject(new SessionNotFoundError(id, '不在了'));
        return Promise.resolve({ header: found.header, read: () => Promise.resolve(found.events) });
      },
    };

    const listed = await listStoredThreads(fake, { cwd: CWD, title: LIMITS });
    expect(listed).toEqual({
      items: [
        { threadId: 'talked', updatedAt: 2_000, blank: false, title: '假後端的第一句' },
        { threadId: 'empty', updatedAt: 1_500, blank: true },
      ],
      unreadable: 2,
    });
  });
});
