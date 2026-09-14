/**
 * 冷讀的 thread 列表——[#302](https://github.com/DemianLi/nexus-agent/issues/302)。
 *
 * 檔案都是手寫的，不經 serve：這一檔問的是「讀出來對不對」，產品路徑上的「列表不建 agent、不拿租約」
 * 在 `serve-session-list.test.ts`。
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import { describe, expect, it } from 'vitest';
import { openJsonlSessionStore } from './jsonl-session-store.js';
import { fallbackThreadTitle, listStoredThreads } from './session-list.js';

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

/** 照 JSONL 後端的檔名寫一份。`events` 省略即只有 header。 */
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
  } = {},
): Promise<void> {
  const header = {
    version: options.version ?? SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: options.createdAt ?? 1_000,
    ...(options.cwd === null ? {} : { cwd: options.cwd ?? CWD }),
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
  };
  await writeFile(join(directory, `${id}.header.json`), JSON.stringify(header));
  if (options.events === undefined) return;
  const body = options.events
    .map(
      (event, seq) =>
        `${JSON.stringify({ type: event.type, seq, time: event.time, data: event.data })}\n`,
    )
    .join('');
  await writeFile(join(directory, `${id}.jsonl`), `${body}${options.tail ?? ''}`);
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

    const { items } = await listStoredThreads(directory, { cwd: CWD, title: LIMITS });
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

    const { items } = await listStoredThreads(directory, { cwd: CWD, title: LIMITS });
    const byId = Object.fromEntries(items.map((item) => [item.threadId, item]));
    expect(byId['talked']).toMatchObject({ title: '第一句', blank: false });
    expect(byId['goal-only']).toEqual(expect.objectContaining({ blank: false }));
    expect(byId['goal-only']).not.toHaveProperty('title');
    expect(byId['no-turn']).toMatchObject({ blank: true });
    expect(byId['no-turn']).not.toHaveProperty('title');
    expect(byId['header-only']).toMatchObject({ blank: true });
  });

  it('只列切得過去的：subagent、別的目錄、沒記目錄的都不列，也不算讀不懂', async () => {
    const directory = await dir();
    await writeThread(directory, 'root', { events: [said('我的', 1_100)] });
    await writeThread(directory, 'root%2ftask', { parentSession: 'root', events: [] });
    // `projectKey` 有損：別的目錄可能落在同一格，header 的 cwd 才分得開。
    await writeThread(directory, 'elsewhere', { cwd: '/專案/乙', events: [said('別人的', 1_100)] });
    await writeThread(directory, 'nowhere', { cwd: null, events: [said('沒記的', 1_100)] });

    const listed = await listStoredThreads(directory, { cwd: CWD, title: LIMITS });
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

    const listed = await listStoredThreads(directory, { cwd: CWD, title: LIMITS });
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

    const { items } = await listStoredThreads(directory, { cwd: CWD, title: LIMITS });
    const byId = Object.fromEntries(items.map((item) => [item.threadId, item]));
    expect(byId['torn']).toMatchObject({ title: '完整的', updatedAt: 1_100 });
    expect(byId['mention']).toMatchObject({ blank: true });
  });

  it('目錄還不存在：空的，不拋', async () => {
    const listed = await listStoredThreads(join(await dir(), '還沒有'), {
      cwd: CWD,
      title: LIMITS,
    });
    expect(listed).toEqual({ items: [], unreadable: 0 });
  });

  it.each([
    ['maxWords 是 0', { maxWords: 0, maxBytes: 40 }],
    ['maxBytes 不是整數', { maxWords: 5, maxBytes: 1.5 }],
  ])('上限不合法（%s）：空目錄也當場拋', async (_label, title) => {
    await expect(listStoredThreads(await dir(), { cwd: CWD, title })).rejects.toThrow('正整數');
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
      const { items } = await listStoredThreads(directory, { cwd: CWD, title: LIMITS });
      expect(items.map((item) => item.threadId)).toEqual(['held']);
    } finally {
      await holder.stored.close();
    }
    expect([await readFile(headerPath, 'utf8'), await readFile(logPath, 'utf8')]).toEqual(before);
  });
});

describe('fallbackThreadTitle', () => {
  it('中文吃位元組上限：40 個位元組是 13 個字，不切在一個字的中間', () => {
    const title = fallbackThreadTitle('請幫我把登入頁面的錯誤訊息改成中文並補上測試', LIMITS);
    expect(title).toBe('請幫我把登入頁面的錯誤訊息');
    expect(Buffer.byteLength(title, 'utf8')).toBeLessThanOrEqual(40);
  });

  it('英文吃詞數上限', () => {
    expect(fallbackThreadTitle('fix the login bug on safari please', LIMITS)).toBe(
      'fix the login bug on',
    );
  });

  it('控制字元、跳脫序列與方向控制字元都拿掉，空白收成一格', () => {
    const esc = String.fromCharCode(0x1b);
    const rlo = String.fromCharCode(0x202e);
    const bell = String.fromCharCode(0x07);
    expect(fallbackThreadTitle(`  ${esc}[31m紅字${esc}[0m\n\t${rlo}反過來${bell}  `, LIMITS)).toBe(
      '紅字 反過來',
    );
  });

  it('清完是空的就是空字串', () => {
    expect(fallbackThreadTitle(`  ${String.fromCharCode(0x200b)}  `, LIMITS)).toBe('');
  });
});
