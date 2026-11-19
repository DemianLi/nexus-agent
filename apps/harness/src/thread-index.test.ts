/**
 * 會話列表索引（[#725](https://github.com/DemianLi/nexus-agent/issues/725)）：每一列的算法跟冷讀共用，這一檔驗的是**什麼時候重算**——
 * 這個行程寫過的下一次就看得到、別的行程寫的靠背景重掃、沒變的不重讀、放棄等待不拖垮建置。
 * 真的 JSONL 後端、真落盤；產品路徑上的接線在 `serve-thread-index.test.ts`。
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION, SessionSeq } from '@nexus/core';
import type { SessionStore } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openJsonlSessionStore } from './jsonl-session-store.js';
import { listStoredThreads } from './session-list.js';
import { createThreadIndex } from './thread-index.js';
import type { ThreadIndex } from './thread-index.js';

const CWD = '/專案/索引';
const TITLE = { maxWords: 5, maxBytes: 40 };

const temporary: string[] = [];
const indexes: ThreadIndex[] = [];

afterEach(async () => {
  for (const index of indexes.splice(0)) await index.close();
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-thread-index-'));
  temporary.push(dir);
  return dir;
}

/** 經後端寫一條：header、一句人話、收尾。 */
async function writeThread(
  store: SessionStore,
  id: string,
  text: string,
  time: number,
): Promise<void> {
  const session = store.create({
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: time,
    cwd: CWD,
  });
  await session.append([
    { type: 'turn/start', seq: SessionSeq(0), time, data: { kind: 'message', text } },
    { type: 'turn/end', seq: SessionSeq(1), time: time + 1, data: {} },
  ]);
  await session.close();
}

/** 數 `open` 與 `list` 各叫了幾次的那一層。 */
function counting(store: SessionStore) {
  const calls = { open: 0, list: 0 };
  const wrapped: SessionStore = {
    create: (header) => store.create(header),
    resume: (id) => store.resume(id),
    list: (options) => {
      calls.list += 1;
      return store.list(options);
    },
    open: (id, access) => {
      calls.open += 1;
      return store.open(id, access);
    },
  };
  return { store: wrapped, calls };
}

function indexOver(store: SessionStore, revalidateAfterMs: number, warned: unknown[] = []) {
  const index = createThreadIndex(store, {
    cwd: CWD,
    title: TITLE,
    revalidateAfterMs,
    warn: (_message, error) => warned.push(error),
  });
  indexes.push(index);
  return index;
}

describe('會話列表索引', () => {
  it('建好之後跟冷讀一樣；這個行程寫過的（touch）下一次就看得到，不用等重掃', async () => {
    const directory = await tempDir();
    const ref: { index?: ThreadIndex } = {};
    const store = openJsonlSessionStore({ directory, onWritten: (id) => ref.index?.touch(id) });
    await writeThread(store, 'a', '第一條', 1_000);
    await writeThread(store, 'b', '第二條', 2_000);
    const index = indexOver(store, Number.POSITIVE_INFINITY);
    ref.index = index;

    expect(await index.list()).toEqual(await listStoredThreads(store, { cwd: CWD, title: TITLE }));

    await writeThread(store, 'c', '第三條', 3_000);
    const after = await index.list();
    expect(after.items.map(({ threadId }) => threadId)).toEqual(['c', 'b', 'a']);
    expect(after).toEqual(await listStoredThreads(store, { cwd: CWD, title: TITLE }));
  });

  it('touch 一條被搬走的：下一次就不列', async () => {
    const directory = await tempDir();
    const store = openJsonlSessionStore({ directory });
    await writeThread(store, 'a', '留下', 1_000);
    await writeThread(store, 'gone', '要搬走', 2_000);
    const index = indexOver(store, Number.POSITIVE_INFINITY);
    expect((await index.list()).items).toHaveLength(2);

    const [entry] = (await readdir(directory)).filter((name) => name.includes('gone'));
    await rm(join(directory, entry!), { recursive: true });
    index.touch('gone');
    expect((await index.list()).items.map(({ threadId }) => threadId)).toEqual(['a']);
  });

  it('別的行程寫的（沒有 touch）：這一次回舊的、背景重掃，之後的請求看得到', async () => {
    const directory = await tempDir();
    const store = openJsonlSessionStore({ directory });
    const index = indexOver(store, 0);
    expect((await index.list()).items).toEqual([]);

    await writeThread(openJsonlSessionStore({ directory }), 'other', '別的行程', 1_000);
    await expect
      .poll(async () => (await index.list()).items.map(({ threadId }) => threadId))
      .toEqual(['other']);
  });

  it('重掃只重讀 revision 變了的那幾份', async () => {
    const directory = await tempDir();
    const backend = openJsonlSessionStore({ directory });
    for (const [id, time] of [
      ['a', 1_000],
      ['b', 2_000],
      ['c', 3_000],
    ] as const) {
      await writeThread(backend, id, `說 ${id}`, time);
    }
    const { store, calls } = counting(backend);
    const index = indexOver(store, 0);
    await index.list();
    expect(calls.open).toBe(3);

    // 每次請求都可能起一次背景重掃：等到它真的掃過一輪、而且沒有多開任何一份。
    const listsBefore = calls.list;
    await expect
      .poll(async () => {
        await index.list();
        return calls.list;
      })
      .toBeGreaterThan(listsBefore + 1);
    expect(calls.open).toBe(3);
  });

  it('放棄等待不中止建置：下一個請求接著用同一次建置的結果', async () => {
    const directory = await tempDir();
    const backend = openJsonlSessionStore({ directory });
    await writeThread(backend, 'a', '一條', 1_000);
    const { store, calls } = counting(backend);
    const index = indexOver(store, Number.POSITIVE_INFINITY);

    const abandoned = new AbortController();
    const first = index.list(abandoned.signal);
    abandoned.abort(new Error('放棄'));
    await expect(first).rejects.toThrow('放棄');
    expect((await index.list()).items.map(({ threadId }) => threadId)).toEqual(['a']);
    expect(calls.list).toBe(1);
  });

  it('建置失敗不留下來：下一個請求重建', async () => {
    const directory = await tempDir();
    const backend = openJsonlSessionStore({ directory });
    await writeThread(backend, 'a', '一條', 1_000);
    let failNext = true;
    const flaky: SessionStore = {
      ...backend,
      create: (header) => backend.create(header),
      resume: (id) => backend.resume(id),
      open: (id, access) => backend.open(id, access),
      list: (options) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error('讀不動'));
        }
        return backend.list(options);
      },
    };
    const index = indexOver(flaky, Number.POSITIVE_INFINITY);
    await expect(index.list()).rejects.toThrow('讀不動');
    expect((await index.list()).items.map(({ threadId }) => threadId)).toEqual(['a']);
  });
});

