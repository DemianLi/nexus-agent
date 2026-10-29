/**
 * 會話日誌的位元組額度（[#2115](https://github.com/DemianLi/nexus-agent/issues/2115)）：一本帳、兩種持有時間、出廠容量怎麼算，
 * 以及 JSONL 存放處怎麼用它（續接佔到把手關掉、唯讀讀完就還、拒收的連 `readFile` 都不做）。
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION, SessionLogTooLargeError } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { openJsonlSessionStore, sessionPathsIn } from './jsonl-session-store.js';
import type { StableReadFileSystem } from './jsonl-session-store.js';

import {
  createSessionLogBudget,
  defaultLogBudgetBytes,
  HEAP_BYTES_PER_LOG_BYTE,
  RSS_BYTES_PER_LOG_BYTE,
} from './session-log-budget.js';

const MiB = 1024 * 1024;

function refusal(error: unknown): SessionLogTooLargeError {
  expect(error).toBeInstanceOf(SessionLogTooLargeError);
  return error as SessionLogTooLargeError;
}

describe('續接：佔到 release 為止，放不下當場拒收', () => {
  it('單份超過容量是 too-large，訊息寫出大小、上限與下一步', () => {
    const budget = createSessionLogBudget(100 * MiB);
    const error = refusal(
      (() => {
        try {
          budget.holdForSession('alpha', 101 * MiB);
        } catch (caught: unknown) {
          return caught;
        }
        return undefined;
      })(),
    );
    expect(error.reason).toBe('too-large');
    expect(error.message).toContain('101.0 MiB');
    expect(error.message).toContain('100.0 MiB');
    expect(error.message).toContain('--max-old-space-size');
  });

  it('剛好等於容量收得下；別人佔著時放不下是 busy，還掉之後同一份收得下', () => {
    const budget = createSessionLogBudget(100);
    const first = budget.holdForSession('alpha', 60);
    expect(() => budget.holdForSession('beta', 41)).toThrow(SessionLogTooLargeError);
    try {
      budget.holdForSession('beta', 41);
    } catch (error: unknown) {
      expect(refusal(error)).toMatchObject({ reason: 'busy', heldBytes: 60, limitBytes: 100 });
    }
    expect(() => budget.holdForSession('gamma', 40).release()).not.toThrow();
    first.release();
    // release 叫兩次只算一次：不會把別人的額度也還掉。
    first.release();
    const whole = budget.holdForSession('beta', 100);
    expect(() => budget.holdForSession('delta', 1)).toThrow(SessionLogTooLargeError);
    whole.release();
  });
});

describe('唯讀：讀完就還，等得到的排隊、等不到的拒收', () => {
  it('放得下就馬上給；被別的唯讀擋住的排隊，先來先放', async () => {
    const budget = createSessionLogBudget(100);
    const a = await budget.reserveForRead('a', 70);
    const order: string[] = [];
    const b = budget.reserveForRead('b', 50).then((r) => {
      order.push('b');
      return r;
    });
    // 排在 b 後面的小的也不插隊。
    const c = budget.reserveForRead('c', 10).then((r) => {
      order.push('c');
      return r;
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    a.release();
    (await b).release();
    (await c).release();
    expect(order).toEqual(['b', 'c']);
  });

  it('續接佔掉的扣掉之後還放不下，不排隊、當場 busy；單份超過容量是 too-large', async () => {
    const budget = createSessionLogBudget(100);
    const held = budget.holdForSession('alpha', 80);
    await expect(budget.reserveForRead('beta', 30)).rejects.toMatchObject({ reason: 'busy' });
    await expect(budget.reserveForRead('gamma', 101)).rejects.toMatchObject({
      reason: 'too-large',
    });
    held.release();
    (await budget.reserveForRead('beta', 30)).release();
  });

  it('排隊中途續接佔進來、排著的再也等不到：拒掉它，不擋後面的', async () => {
    const budget = createSessionLogBudget(100);
    const reading = await budget.reserveForRead('a', 30);
    // 30＋80 放不下，排著等 a 讀完。
    const waiting = budget.reserveForRead('b', 80);
    // 續接佔 30 之後，就算 a 讀完，30＋80 也放不下：b 等的是 thread 撤掉，拒掉。
    const held = budget.holdForSession('alpha', 30);
    await expect(waiting).rejects.toMatchObject({ reason: 'busy' });
    reading.release();
    (await budget.reserveForRead('c', 70)).release();
    held.release();
  });
});

describe('出廠容量', () => {
  it('剩下的記憶體與剩下的 heap 各除以自己的倍率，取小的', () => {
    // #2115 的 1g 容器：cgroup 1024 MiB、serve 起來後 RSS 約 260、heap 上限 717、已用約 40。
    const oneGig = defaultLogBudgetBytes({
      memoryLimitBytes: 1024 * MiB,
      rssBytes: 260 * MiB,
      heapLimitBytes: 717 * MiB,
      heapUsedBytes: 40 * MiB,
    });
    expect(oneGig).toBe(Math.floor((764 * MiB) / RSS_BYTES_PER_LOG_BYTE));
    // 101 MiB（1g 上 serve 實測活得下來）收，506 MiB（實測被殺）拒。
    expect(oneGig).toBeGreaterThan(101 * MiB);
    expect(oneGig).toBeLessThan(506 * MiB);

    const heapBound = defaultLogBudgetBytes({
      memoryLimitBytes: 64 * 1024 * MiB,
      rssBytes: 300 * MiB,
      heapLimitBytes: 2048 * MiB,
      heapUsedBytes: 48 * MiB,
    });
    expect(heapBound).toBe(Math.floor((2000 * MiB) / HEAP_BYTES_PER_LOG_BYTE));
  });

  it('已經用超過上限算出 0，不是負數', () => {
    expect(
      defaultLogBudgetBytes({
        memoryLimitBytes: 100 * MiB,
        rssBytes: 200 * MiB,
        heapLimitBytes: 100 * MiB,
        heapUsedBytes: 10 * MiB,
      }),
    ).toBe(0);
  });

  it('容量不是 0 以上的有限數就拋', () => {
    expect(() => createSessionLogBudget(-1)).toThrow(RangeError);
    expect(() => createSessionLogBudget(Number.NaN)).toThrow(RangeError);
  });
});

describe('JSONL 存放處', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  /** 一個目錄裡落一份 `alpha`（幾顆 `turn/start`），回目錄與日誌的位元組數。 */
  async function seeded(): Promise<{ directory: string; bytes: number }> {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-2115-'));
    roots.push(directory);
    const stored = openJsonlSessionStore({ directory }).create({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'alpha',
      createdAt: 1,
    });
    await stored.append(
      Array.from(
        { length: 5 },
        (_, seq) =>
          ({ type: 'turn/start', seq, time: seq + 1, data: { kind: 'resume' } }) as SessionEvent,
      ),
    );
    await stored.close();
    return { directory, bytes: (await stat(sessionPathsIn(directory, 'alpha').log)).size };
  }

  /** 真的檔案系統，記下 `readFile` 讀過哪些路徑。 */
  function countingFs(): StableReadFileSystem & { readonly read: string[] } {
    const read: string[] = [];
    return {
      read,
      stat: (path: string) => stat(path, { bigint: true }),
      readFile: async (path: string) => {
        read.push(path);
        return readFile(path);
      },
    };
  }

  it('續接放不下：拋 too-large、一個位元組都沒讀、租約放掉了（額度夠的後端接得起來）', async () => {
    const { directory, bytes } = await seeded();
    const fs = countingFs();
    const small = openJsonlSessionStore({
      directory,
      fs,
      logBudget: createSessionLogBudget(bytes - 1),
    });
    await expect(small.resume('alpha')).rejects.toMatchObject({
      reason: 'too-large',
      logBytes: bytes,
    });
    expect(fs.read).toEqual([]);
    const resumed = await openJsonlSessionStore({
      directory,
      logBudget: createSessionLogBudget(bytes),
    }).resume('alpha');
    await resumed.stored.close();
  });

  it('續接佔到把手關掉：開著的時候別人放不下，關掉之後放得下', async () => {
    const { directory, bytes } = await seeded();
    const budget = createSessionLogBudget(bytes);
    const store = openJsonlSessionStore({ directory, logBudget: budget });
    const resumed = await store.resume('alpha');
    expect(() => budget.holdForSession('other', 1)).toThrow(SessionLogTooLargeError);
    await resumed.stored.close();
    budget.holdForSession('other', bytes).release();
    // 同一份再接一次也還得起來。
    await (await store.resume('alpha')).stored.close();
  });

  it('唯讀讀完就還；放不下拋 too-large、沒讀', async () => {
    const { directory, bytes } = await seeded();
    const budget = createSessionLogBudget(bytes);
    const store = openJsonlSessionStore({ directory, logBudget: budget });
    expect(await (await store.open('alpha', 'read')).read({ salvage: true })).toHaveLength(5);
    budget.holdForSession('other', bytes).release();

    const fs = countingFs();
    const small = openJsonlSessionStore({
      directory,
      fs,
      logBudget: createSessionLogBudget(bytes - 1),
    });
    const reader = await small.open('alpha', 'read');
    await expect(reader.read()).rejects.toMatchObject({ reason: 'too-large' });
    // 只讀了 header（`open` 本來就讀），日誌本文沒讀。
    expect(fs.read).not.toContain(sessionPathsIn(directory, 'alpha').log);
  });
});
