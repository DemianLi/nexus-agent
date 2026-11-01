/**
 * 會話日誌的位元組額度（[#2115](https://github.com/DemianLi/nexus-agent/issues/2115)）：一本帳、兩種持有時間、出廠容量怎麼算，
 * 以及 JSONL 存放處怎麼用它（開著的日誌長過額度時講一行、續接佔到把手關掉、唯讀讀完就還、拒收的連 `readFile` 都不做）。
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

describe('續接：佔到 release 為止，開著的 thread 佔滿就當場拒收', () => {
  it('單份超過容量是 too-large，訊息寫出大小、上限與下一步', async () => {
    const budget = createSessionLogBudget(100 * MiB);
    const error = refusal(
      await budget.holdForSession('alpha', 101 * MiB).then(
        () => undefined,
        (caught: unknown) => caught,
      ),
    );
    expect(error.reason).toBe('too-large');
    expect(error.message).toContain('101.0 MiB');
    expect(error.message).toContain('100.0 MiB');
    expect(error.message).toContain('--max-old-space-size');
  });

  it('剛好等於容量收得下；別的 thread 佔著時放不下是 busy，還掉之後同一份收得下', async () => {
    const budget = createSessionLogBudget(100);
    const first = await budget.holdForSession('alpha', 60);
    await expect(budget.holdForSession('beta', 41)).rejects.toMatchObject({
      reason: 'busy',
      heldBytes: 60,
      limitBytes: 100,
    });
    (await budget.holdForSession('gamma', 40)).release();
    first.release();
    // release 叫兩次只算一次：不會把別人的額度也還掉。
    first.release();
    const whole = await budget.holdForSession('beta', 100);
    await expect(budget.holdForSession('delta', 1)).rejects.toBeInstanceOf(SessionLogTooLargeError);
    whole.release();
  });

  it('只是唯讀佔著：續接等它讀完，不拒收', async () => {
    const budget = createSessionLogBudget(100);
    const reading = await budget.reserveForRead('a', 60);
    let resumed = false;
    const held = budget.holdForSession('alpha', 60).then((r) => {
      resumed = true;
      return r;
    });
    await Promise.resolve();
    expect(resumed).toBe(false);
    reading.release();
    (await held).release();
    expect(resumed).toBe(true);
  });

  it('等著的續接排在已經排隊的唯讀前面，後來的唯讀也不插到它前面', async () => {
    const budget = createSessionLogBudget(100);
    // a（60）與 d（10）讀著：b（40）排隊；續接 60 等它們；c（10）放得下，但前面有人排，不插隊。
    const reading = await budget.reserveForRead('a', 60);
    const other = await budget.reserveForRead('d', 10);
    const order: string[] = [];
    const queuedRead = budget.reserveForRead('b', 40).then((r) => {
      order.push('b');
      return r;
    });
    const resumed = budget.holdForSession('alpha', 60).then((r) => {
      order.push('alpha');
      return r;
    });
    const laterRead = budget.reserveForRead('c', 10).then((r) => {
      order.push('c');
      return r;
    });
    // d 讀完：b 放得下了，但續接還在等 a，b 不能先走。
    other.release();
    await Promise.resolve();
    expect(order).toEqual([]);
    reading.release();
    const held = await resumed;
    (await queuedRead).release();
    (await laterRead).release();
    expect(order).toEqual(['alpha', 'b', 'c']);
    held.release();
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
    const held = await budget.holdForSession('alpha', 80);
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
    const held = await budget.holdForSession('alpha', 30);
    await expect(waiting).rejects.toMatchObject({ reason: 'busy' });
    reading.release();
    (await budget.reserveForRead('c', 70)).release();
    held.release();
  });
});

describe('出廠容量', () => {
  it('剩下的記憶體與剩下的 heap 各除以自己的倍率，取小的', () => {
    // 1g 容器：cgroup 1024 MiB、serve 起來後 RSS 約 260、heap 上限 717、已用約 105。
    const oneGig = defaultLogBudgetBytes({
      memoryLimitBytes: 1024 * MiB,
      rssBytes: 260 * MiB,
      heapLimitBytes: 717 * MiB,
      heapUsedBytes: 105 * MiB,
    });
    expect(oneGig).toBe(Math.floor((612 * MiB) / HEAP_BYTES_PER_LOG_BYTE));
    // 小行形狀（#2205）：1g 上 91 MiB 實測 heap 爆掉，額度還要壓在活得下來的 64.5 MiB 下面。
    expect(oneGig).toBeGreaterThan(50 * MiB);
    expect(oneGig).toBeLessThan(64.5 * MiB);

    const rssBound = defaultLogBudgetBytes({
      memoryLimitBytes: 1024 * MiB,
      rssBytes: 260 * MiB,
      heapLimitBytes: 8192 * MiB,
      heapUsedBytes: 105 * MiB,
    });
    expect(rssBound).toBe(Math.floor((764 * MiB) / RSS_BYTES_PER_LOG_BYTE));
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

  it('容量不是 0 以上的數就拋；惰性算的唯讀走 rejected Promise', () => {
    expect(() => createSessionLogBudget(-1)).toThrow(RangeError);
    expect(() => createSessionLogBudget(Number.NaN)).toThrow(RangeError);
    const lazy = createSessionLogBudget(() => -1);
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = lazy.reserveForRead('a', 1);
    }).not.toThrow();
    return expect(pending).rejects.toBeInstanceOf(RangeError);
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

  it('續接放不下：拋 too-large、日誌本文一個位元組都沒讀、租約放掉了（額度夠的後端接得起來）', async () => {
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
    // 經注入的 fs 讀過的只有舊路徑的墓碑（拿租約之前與之後各找一次這份會話，分辨墓碑與舊兩檔），世代檔沒有：本文是經它
    // 讀的。世代檔的 header 行在判額度之前讀，走真的檔案系統（第一行讀到換行為止），這個計數看不到。
    const { tombstone } = sessionPathsIn(directory, 'alpha');
    expect(fs.read).toEqual([tombstone, tombstone]);
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
    await expect(budget.holdForSession('other', 1)).rejects.toBeInstanceOf(SessionLogTooLargeError);
    await resumed.stored.close();
    (await budget.holdForSession('other', bytes)).release();
    // 同一份再接一次也還得起來。
    await (await store.resume('alpha')).stored.close();
  });

  it('唯讀讀完就還；放不下拋 too-large、沒讀', async () => {
    const { directory, bytes } = await seeded();
    const budget = createSessionLogBudget(bytes);
    const store = openJsonlSessionStore({ directory, logBudget: budget });
    expect(await (await store.open('alpha', 'read')).read({ salvage: true })).toHaveLength(5);
    (await budget.holdForSession('other', bytes)).release();

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

  describe('開著的日誌長過額度（#2215）', () => {
    const more = (seq: number): SessionEvent =>
      ({ type: 'turn/start', seq, time: seq + 1, data: { kind: 'resume' } }) as SessionEvent;

    /** 接回 `alpha`（5 顆事件），額度定在現在的大小加 `room`。 */
    async function reopened(room: number) {
      const { directory, bytes } = await seeded();
      const warnings: string[] = [];
      const budget = createSessionLogBudget(bytes + room);
      const store = openJsonlSessionStore({
        directory,
        logBudget: budget,
        warn: (message) => warnings.push(message),
      });
      const { stored } = await store.resume('alpha');
      return { directory, bytes, warnings, store, stored };
    }

    it('越過額度講一行，之後再寫不重複；說的是「以現在的額度」，而重開真的被拒收', async () => {
      const { warnings, store, stored } = await reopened(1);
      await stored.append([more(5)]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('"alpha"');
      expect(warnings[0]).toContain('以現在的額度');
      expect(warnings[0]).toContain('重開會被拒收');
      await stored.append([more(6)]);
      await stored.append([more(7)]);
      expect(warnings).toHaveLength(1);
      await stored.close();
      await expect(store.resume('alpha')).rejects.toMatchObject({ reason: 'too-large' });
    });

    it('剛好等於額度不講：這個大小重開還收得下', async () => {
      const line = `${JSON.stringify(more(5))}\n`;
      const { warnings, store, stored } = await reopened(Buffer.byteLength(line));
      await stored.append([more(5)]);
      await stored.close();
      expect(warnings).toEqual([]);
      await (await store.resume('alpha')).stored.close();
    });

    it('額度不限不講', async () => {
      const { directory } = await seeded();
      const warnings: string[] = [];
      const { stored } = await openJsonlSessionStore({
        directory,
        logBudget: createSessionLogBudget(Number.POSITIVE_INFINITY),
        warn: (message) => warnings.push(message),
      }).resume('alpha');
      await stored.append([more(5)]);
      await stored.close();
      expect(warnings).toEqual([]);
    });

    it('還沒算的出廠額度，寫入不替它算', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'nexus-2215-'));
      roots.push(directory);
      let computed = 0;
      const budget = createSessionLogBudget(() => {
        computed += 1;
        return 1;
      });
      const stored = openJsonlSessionStore({ directory, logBudget: budget }).create({
        version: SESSION_LOG_FORMAT_VERSION,
        id: 'alpha',
        createdAt: 1,
      });
      await stored.append([more(0)]);
      await stored.append([more(1)]);
      await stored.close();
      expect(computed).toBe(0);
      expect(budget.knownLimitBytes).toBeUndefined();
      expect(budget.limitBytes).toBe(1);
      expect(budget.knownLimitBytes).toBe(1);
    });
  });
});
