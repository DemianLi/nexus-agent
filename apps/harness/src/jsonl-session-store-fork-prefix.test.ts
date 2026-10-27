/**
 * 讀盤時的分叉前綴（[#1579](https://github.com/DemianLi/nexus-agent/issues/1579)），照 dsh `session-format-v3-to-v4/src/validation.ts:19-79`
 * 與 `session-format-v1-to-v2/src/codec.ts:114-127`（`687f282e`）：
 *
 * - header 的 `origin` 只准 `'subagent'`、`isSeeded` 只准 `true`；
 * - 帶 `isSeeded` 的要有 inherited 標記，沒帶的不能有。切點從標記推、不另外落盤，所以 dsh 的「切點不等於最後一顆標記」
 *   「切點超過事件數」收成同一條「seeded 卻沒有標記」；
 * - 驗證跑在尾端復原之後：標記本身被當成壞尾巴丟掉時拋損壞，標記之後的壞尾巴照常丟；
 * - 子代理目錄的唯一性只看切點之後（撤掉 #1549 N0603 的過渡）。
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionLog,
  SessionSeq,
} from '@nexus/core';

import { openJsonlSessionStore, sessionPathsIn } from './jsonl-session-store.js';
import { isListedThread } from './session-list.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 同 `jsonl-session-store-read-validation.test.ts` 的 `written`：物件補 `seq` 與 `time: 1`，字串原樣寫成一行。 */
async function written(
  events: readonly (Record<string, unknown> | string)[],
  header: Record<string, unknown> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-1579-'));
  roots.push(directory);
  const paths = sessionPathsIn(directory, 'a');
  await writeFile(
    paths.header,
    JSON.stringify({ version: SESSION_LOG_FORMAT_VERSION, id: 'a', createdAt: 1, ...header }),
  );
  await writeFile(
    paths.log,
    events
      .map(
        (event, seq) =>
          `${typeof event === 'string' ? event : JSON.stringify({ seq, time: 1, ...event })}\n`,
      )
      .join(''),
  );
  return directory;
}

/** 唯讀打開後讀本文、續接，各自拋的錯；沒拋就是 `undefined`。 */
async function failures(directory: string): Promise<unknown[]> {
  const store = openJsonlSessionStore({ directory });
  const caught = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  return [
    await caught((async () => (await store.open('a', 'read')).read())()),
    await caught(store.resume('a').then((resumed) => resumed.stored.close())),
  ];
}

const turnStart = { type: 'turn/start', data: { kind: 'message', text: '一' } };
const turnEnd = { type: 'turn/end', data: {} };
const marker = { type: 'session/end-seed', data: { inherited: true } };
const seeded = { parentSession: 'source', isSeeded: true };
const catalog = (childId: string) => ({
  type: 'subagent/catalog',
  data: { childId, callId: `call-${childId}`, mode: 'continuable' },
});

describe('header 的 origin 與 isSeeded', () => {
  it.each([
    ['origin 不是 subagent', { origin: 'fork' }, 'origin'],
    ['isSeeded 是 false', { isSeeded: false }, 'isSeeded'],
  ])('%s：唯讀打開與續接都拒成 SessionCorruptionError', async (_name, header, cell) => {
    const directory = await written([turnStart, turnEnd], header);
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain(cell);
    }
  });

  it('新子代理 header（origin）與 50 以前的子代理 header（只有 parentSession）都照常讀回', async () => {
    for (const header of [
      { parentSession: 'root', origin: 'subagent' },
      { parentSession: 'root' },
    ]) {
      expect(await failures(await written([turnStart, turnEnd], header))).toEqual([
        undefined,
        undefined,
      ]);
    }
  });
});

describe('分叉前綴與 header 對得上（驗收 3）', () => {
  it('合法的分叉形狀：前綴、inherited 標記、自己的事件，兩條讀路徑都照常讀回', async () => {
    const directory = await written([turnStart, turnEnd, marker, turnStart, turnEnd], seeded);
    expect(await failures(directory)).toEqual([undefined, undefined]);
    const read = await (await openJsonlSessionStore({ directory }).open('a', 'read')).read();
    expect(new SessionLog('a', { seed: read }).inheritedEventCount).toBe(2);
  });

  it('seeded 卻沒有 inherited 標記：拒（dsh 的「標記位置不等於繼承長度」「長度超過事件數」在這裡都是這一種）', async () => {
    const directory = await written([turnStart, turnEnd, turnStart, turnEnd], seeded);
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain('isSeeded');
    }
  });

  it('沒有 seeded 卻有 inherited 標記：拒，訊息帶第幾行', async () => {
    const directory = await written([turnStart, turnEnd, marker, turnStart, turnEnd], {
      parentSession: 'source',
    });
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain('第 3 行');
    }
  });

  it('跑在尾端復原之後：標記本身是撕裂的尾巴而被丟掉時拒；標記之後的壞尾巴照常丟、照常讀回', async () => {
    const tornMarker = await written(
      [turnStart, turnEnd, '{"seq":2,"time":1,"type":"session/end-seed","data":{"inh'],
      seeded,
    );
    for (const error of await failures(tornMarker)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain('isSeeded');
    }
    const tornAfter = await written(
      [turnStart, turnEnd, marker, turnStart, '{"seq":4,"time":1,"type":"turn/e'],
      seeded,
    );
    expect(await failures(tornAfter)).toEqual([undefined, undefined]);
  });
});

describe('子代理目錄的唯一性只看切點之後（撤掉 #1549 N0603 的過渡）', () => {
  it('前綴與自己的區段各有一筆同 childId：照常讀回', async () => {
    const directory = await written(
      [catalog('kid'), turnEnd, marker, catalog('kid'), turnEnd],
      seeded,
    );
    expect(await failures(directory)).toEqual([undefined, undefined]);
  });

  it('自己的區段裡重複：照舊拒，訊息帶第幾行', async () => {
    const directory = await written(
      [catalog('kid'), turnEnd, marker, catalog('kid'), catalog('kid')],
      seeded,
    );
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain('第 5 行');
    }
  });
});

describe('相容（驗收 6）', () => {
  it('50 的檔續接、續寫一筆之後 header 是這一版、沒有 isSeeded 也沒有 origin', async () => {
    const directory = await written([turnStart, turnEnd], { version: 50, parentSession: 'root' });
    const resumed = await openJsonlSessionStore({ directory }).resume('a');
    // 換版是續寫時的原子取代（#1509），同 `jsonl-session-store-header-replace.test.ts`。
    await resumed.stored.append([
      { type: 'session/end-seed', seq: SessionSeq(resumed.events.length), time: 2, data: {} },
    ]);
    await resumed.stored.close();
    expect(SESSION_LOG_FORMAT_VERSION).toBe(51);
    const header = JSON.parse(
      await readFile(sessionPathsIn(directory, 'a').header, 'utf8'),
    ) as Record<string, unknown>;
    expect(header['version']).toBe(51);
    expect(header).not.toHaveProperty('isSeeded');
    expect(header).not.toHaveProperty('origin');
  });

  it('分叉形狀的 header 列得出來，舊子代理 header 照舊不列（驗收 2 的列表那一半）', () => {
    const base = { version: SESSION_LOG_FORMAT_VERSION, id: 'f', createdAt: 1, cwd: '/w' } as const;
    expect(isListedThread({ ...base, parentSession: 'source', isSeeded: true }, '/w')).toBe(true);
    expect(isListedThread({ ...base, id: 'root/r1', parentSession: 'root' }, '/w')).toBe(false);
    expect(
      isListedThread({ ...base, id: 'root/r1', parentSession: 'root', origin: 'subagent' }, '/w'),
    ).toBe(false);
  });
});
