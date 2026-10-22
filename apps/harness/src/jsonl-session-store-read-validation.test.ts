/**
 * 讀盤時的驗證（[#1549](https://github.com/DemianLi/nexus-agent/issues/1549)），每一段對到卡上一項：
 *
 * - header：各格的形狀與鍵白名單，與 `create` 共用 `assertStoredHeaderFields`；開了 `acceptNewer` 不檢白名單；
 *   排在版本判定之後。
 * - N0785：讀回來的每一筆跑 core 的單筆資料規則（dsh `validateStoredEvents`）。
 * - N0603：同一個子代理的 `subagent/catalog` 只能登記一次（dsh `assertReleasedV4Relationships`）。
 *
 * 事件信封照 dsh 在 core 的 seed 驗，測在 `@nexus/core` 的 `session-log-data-rules.test.ts`。
 * 出貨夾具照常讀回由 `session-format-fixtures.test.ts` 管（新規則跑在同一條讀取路徑上）。
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
} from '@nexus/core';

import { openJsonlSessionStore, parseHeader, sessionPathsIn } from './jsonl-session-store.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 手寫一份會話：header 與一行一筆的日誌。`header` 蓋掉預設的任何一格。 */
async function written(
  events: readonly Record<string, unknown>[],
  header: Record<string, unknown> = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-1549-'));
  roots.push(directory);
  const paths = sessionPathsIn(directory, 'a');
  await writeFile(
    paths.header,
    JSON.stringify({ version: SESSION_LOG_FORMAT_VERSION, id: 'a', createdAt: 1, ...header }),
  );
  await writeFile(
    paths.log,
    events.map((event, seq) => `${JSON.stringify({ seq, time: 1, ...event })}\n`).join(''),
  );
  return directory;
}

const usage = { type: 'model/usage', data: {} };

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

  it('D2：多一個鍵的 header，開了 acceptNewer 照常讀回；型別不對的照樣拒', () => {
    const text = JSON.stringify({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'a',
      createdAt: 1,
      foo: 1,
    });
    expect(() => parseHeader(text)).toThrow(SessionCorruptionError);
    expect(parseHeader(text, { acceptNewer: true }).header.id).toBe('a');
    const bad = JSON.stringify({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'a',
      createdAt: 1,
      cwd: 'x',
    });
    expect(() => parseHeader(bad, { acceptNewer: true })).toThrow(SessionCorruptionError);
  });

  it('順序：比這一版新、又帶這一版不認得的鍵，報的是版本太新，不是壞檔', async () => {
    const directory = await written([usage], { version: SESSION_LOG_FORMAT_VERSION + 1, foo: 1 });
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
