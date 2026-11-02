/**
 * 讀盤時的驗證（[#1549](https://github.com/DemianLi/nexus-agent/issues/1549)），每一段對到卡上一項：
 *
 * - 信封：逐行驗，與 core 的 seed 共用 `assertSessionEventEnvelope`（dsh 讀檔器的 `decodeEvent`）；壞行照 recoverable：
 *   後面有收尾就整份拒，在尾巴就當撕裂的尾巴丟掉。離線掃描照 header 的版本分流：這一版的照驗，比這一版新的不驗。
 * - header：各格的形狀與鍵白名單，與 `create` 共用 `assertStoredHeaderFields`；排在版本判定之後；`acceptNewer`
 *   讀比這一版新的整支不跑。
 * - N0785：讀回來的每一筆跑 core 的單筆資料規則（dsh `validateStoredEvents`）。
 * - N0603：同一個子代理的 `subagent/catalog` 只能登記一次、`childId` 要是字串（dsh `assertReleasedV4Relationships`、
 *   `catalogFact`）。
 *
 * 出貨夾具照常讀回由 `session-format-fixtures.test.ts` 管（新規則跑在同一條讀取路徑上）。
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  SessionLog,
  generationLogFilename,
  sessionDirectoryName,
} from '@nexus/core';

import { readSessionLogs } from './eval/session-scan.js';
import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  parseHeader,
  parseJsonlSessionBody,
} from './jsonl-session-store.js';
import { LEGACY_TWO_FILE_FORMAT_VERSION } from './session-files.fixture.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 一行一筆的日誌本文：物件補上 `seq`（它的位置）與 `time: 1` 再序列化；字串原樣寫成一行（`JSON.stringify` 寫不出的東西，例如 `-0`）。 */
function body(events: readonly (Record<string, unknown> | string)[]): string {
  return events
    .map(
      (event, seq) =>
        `${typeof event === 'string' ? event : JSON.stringify({ seq, time: 1, ...event })}\n`,
    )
    .join('');
}

async function freshDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-1549-'));
  roots.push(directory);
  return directory;
}

/**
 * 手寫一份舊兩檔的會話（版本 {@link LEGACY_TWO_FILE_FORMAT_VERSION}）：header 與一行一筆的日誌（{@link body}）。
 * `header` 蓋掉預設的任何一格（版本除外：版本 52 起舊路徑上的 header 是墓碑，比這一版新的用 {@link writtenGeneration}）。
 */
async function written(
  events: readonly (Record<string, unknown> | string)[],
  header: Record<string, unknown> = {},
): Promise<string> {
  const directory = await freshDirectory();
  const paths = legacyTwoFilePathsIn(directory, 'a');
  await writeFile(
    paths.header,
    JSON.stringify({ version: LEGACY_TWO_FILE_FORMAT_VERSION, id: 'a', createdAt: 1, ...header }),
  );
  await writeFile(paths.log, body(events));
  return directory;
}

/** 手寫一份世代檔：會話目錄裡的 `session.v<version>.jsonl`，第一行是 header 行，之後同 {@link body}。 */
async function writtenGeneration(
  version: number,
  events: readonly (Record<string, unknown> | string)[],
  header: Record<string, unknown> = {},
): Promise<string> {
  const directory = await freshDirectory();
  const sessionDirectory = join(directory, sessionDirectoryName('a'));
  await mkdir(sessionDirectory);
  await writeFile(
    join(sessionDirectory, generationLogFilename(version)),
    `${JSON.stringify({ type: 'session', version, id: 'a', createdAt: 1, ...header })}\n${body(events)}`,
  );
  return directory;
}

const usage = { type: 'model/usage', data: {} };
const turnEnd = { type: 'turn/end', data: {} };

/** 兩條讀路徑各走一次（唯讀打開後讀本文、續接），依序交出各自拋出的錯，沒拋就是 `undefined`。 */
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

/** 兩條讀路徑各讀回幾筆。 */
async function lengths(directory: string): Promise<number[]> {
  const store = openJsonlSessionStore({ directory });
  const read = await (await store.open('a', 'read')).read();
  const resumed = await store.resume('a');
  await resumed.stored.close();
  return [read.length, resumed.events.length];
}

describe('N0556 讀盤逐行的信封（照 dsh decodeEvent）', () => {
  const broken: [string, Record<string, unknown>, string][] = [
    ['A time 是小數', { type: 'turn/start', time: 1.5, data: {} }, 'time'],
    ['B 少了 data', { type: 'model/usage' }, 'data'],
    ['C ignorable 是 false', { type: 'model/usage', ignorable: false, data: {} }, 'ignorable'],
    ['多一個鍵 foo', { type: 'model/usage', data: {}, foo: 1 }, 'foo'],
  ];

  it.each(broken)(
    '%s，後面還有收尾：唯讀打開與續接都拒成 SessionCorruptionError，訊息帶第幾行與哪一格',
    async (_name, bad, cell) => {
      const directory = await written([usage, bad, turnEnd]);
      for (const error of await failures(directory)) {
        expect(error).toBeInstanceOf(SessionCorruptionError);
        expect((error as Error).message).toContain('第 2 行');
        expect((error as Error).message).toContain(cell);
      }
    },
  );

  it.each(broken)(
    '%s，在尾巴：當撕裂的尾巴丟掉，兩條路徑都只讀回前面那一筆',
    async (_name, bad) => {
      expect(await lengths(await written([usage, bad]))).toEqual([1, 1]);
    },
  );

  it('time 是 -0（JSON.parse 讀得出、JSON.stringify 寫不出）：後面還有收尾就拒，照 dsh sessionFormatSafeInteger', async () => {
    const directory = await written([
      '{"type":"model/usage","seq":0,"time":-0,"data":{}}',
      turnEnd,
    ]);
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain('第 1 行的 time');
    }
  });

  it('seq 的形狀讀盤不驗，交給連續性（同 dsh 讀檔器）：-0 等於 0 讀得出，要到建 seed 才拒', async () => {
    const directory = await written([
      '{"type":"model/usage","seq":-0,"time":1,"data":{}}',
      turnEnd,
    ]);
    expect(await lengths(directory)).toEqual([2, 2]);
    const { events, stored } = await openJsonlSessionStore({ directory }).resume('a');
    await stored.close();
    expect(() => new SessionLog('a', { seed: events })).toThrow(TypeError);
  });

  describe('E2 離線掃描照 header 的版本分流（PM 裁決 issuecomment-6354566852）', () => {
    const badTime = { type: 'model/usage', time: 1.5, data: {} };

    it('E2a 不是 newer 的檔信封壞了：記成讀不了，同 header 那一側', async () => {
      const directory = await written([usage, badTime]);
      const { logs, unreadable } = await readSessionLogs([directory]);
      expect(logs).toHaveLength(0);
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]?.reason).toContain('第 2 行的 time');
    });

    it('E2b newer 的檔：帶這一版不合格的信封也照讀', async () => {
      const directory = await writtenGeneration(SESSION_LOG_FORMAT_VERSION + 1, [usage, badTime]);
      const { logs, unreadable } = await readSessionLogs([directory]);
      expect(unreadable).toHaveLength(0);
      expect(logs[0]?.events).toHaveLength(2);
    });

    it('E2 parseJsonlSessionBody 本身：newerFormat 才不驗', () => {
      const body = Buffer.from(`${JSON.stringify({ seq: 0, ...badTime })}\n`);
      const options = { acceptUnknownEvents: true, recovery: 'strict' } as const;
      expect(
        parseJsonlSessionBody('a', body, { ...options, newerFormat: true }).events,
      ).toHaveLength(1);
      expect(() => parseJsonlSessionBody('a', body, { ...options, newerFormat: false })).toThrow(
        /time/,
      );
    });
  });
});

describe('header', () => {
  it.each([
    ['createdAt 是 -1', { createdAt: -1 }, 'createdAt'],
    ['cwd 是相對路徑', { cwd: 'relative/dir' }, 'cwd'],
    ['多一個沒人寫過的鍵 foo', { foo: 1 }, 'foo'],
  ])('D：%s，唯讀打開與續接都拒成 SessionCorruptionError', async (_name, header, cell) => {
    const directory = await written([usage], header);
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain(cell);
    }
    expect((await openJsonlSessionStore({ directory }).list()).unreadable).toBe(1);
  });

  it('D2：acceptNewer 只放過比這一版新的，整支欄位檢查不跑；這一版的照驗', () => {
    const current = JSON.stringify({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'a',
      createdAt: 1,
      foo: 1,
    });
    expect(() => parseHeader(current)).toThrow(SessionCorruptionError);
    expect(() => parseHeader(current, { acceptNewer: true })).toThrow(SessionCorruptionError);
    // 新版的 header 不必過這一版的結構檢查（dsh `format.ts:333-337`）：多的鍵、形狀不同的 build 都照讀。
    const newer = JSON.stringify({
      version: SESSION_LOG_FORMAT_VERSION + 1,
      id: 'a',
      createdAt: 1,
      foo: 1,
      build: 'x',
    });
    expect(parseHeader(newer, { acceptNewer: true }).storedFormatVersion).toBe(
      SESSION_LOG_FORMAT_VERSION + 1,
    );
  });

  it('順序：比這一版新、又帶這一版不認得的鍵，報的是版本太新，不是壞檔', async () => {
    const directory = await writtenGeneration(SESSION_LOG_FORMAT_VERSION + 1, [usage], { foo: 1 });
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionFormatUnsupportedError);
    }
  });
});

describe('N0785 讀回來的單筆資料規則', () => {
  it.each([
    [
      'tool/result 帶 error、isError 是 false',
      { type: 'tool/result', data: { callId: 'c', isError: false, error: { name: 'X' } } },
    ],
    [
      'request/header 帶空的 tools',
      {
        type: 'request/header',
        ignorable: true,
        data: { header: { config: {}, tools: [] }, reason: 'initial' },
      },
    ],
  ])('%s：唯讀打開與續接都拒成 SessionCorruptionError，訊息帶第幾行', async (_name, bad) => {
    const directory = await written([usage, bad]);
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain('第 2 行');
    }
  });

  it('撿回（salvage）不跑：照常交出讀得懂的', async () => {
    const bad = {
      type: 'tool/result',
      data: { callId: 'c', isError: false, error: { name: 'X' } },
    };
    const directory = await written([usage, bad]);
    const events = await (
      await openJsonlSessionStore({ directory }).open('a', 'read')
    ).read({
      salvage: true,
    });
    expect(events).toHaveLength(2);
  });

  it('壞的不進冷讀快取：同一個把手讀兩次，兩次都拒', async () => {
    const bad = {
      type: 'tool/result',
      data: { callId: 'c', isError: false, error: { name: 'X' } },
    };
    const directory = await written([usage, bad]);
    const reader = await openJsonlSessionStore({ directory }).open('a', 'read');
    await expect(reader.read()).rejects.toThrow(SessionCorruptionError);
    await expect(reader.read()).rejects.toThrow(SessionCorruptionError);
  });
});

describe('N0603 子代理目錄唯一', () => {
  const catalog = (childId: string) => ({
    type: 'subagent/catalog',
    data: { childId, callId: `call-${childId}`, mode: 'continuable' },
  });

  it('A：兩筆 childId 相同的 subagent/catalog，唯讀打開與續接都拒成 SessionCorruptionError', async () => {
    const directory = await written([usage, catalog('kid'), catalog('other'), catalog('kid')]);
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain('第 4 行');
      expect((error as Error).message).toContain('kid');
    }
  });

  it('childId 不是字串也拒（dsh catalogFact）', async () => {
    const directory = await written([
      usage,
      { type: 'subagent/catalog', data: { callId: 'c', mode: 'continuable' } },
    ]);
    for (const error of await failures(directory)) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      expect((error as Error).message).toContain('第 2 行');
      expect((error as Error).message).toContain('childId');
    }
  });

  it('不同的 childId 照常讀回；撿回不跑這一條', async () => {
    const ok = await written([catalog('one'), catalog('two')]);
    expect(await failures(ok)).toEqual([undefined, undefined]);
    const duplicated = await written([catalog('kid'), catalog('kid')]);
    const salvaged = await (
      await openJsonlSessionStore({ directory: duplicated }).open('a', 'read')
    ).read({
      salvage: true,
    });
    expect(salvaged).toHaveLength(2);
  });
});
