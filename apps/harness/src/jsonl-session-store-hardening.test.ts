/**
 * 會話持久層的幾件補強（[#1559](https://github.com/DemianLi/nexus-agent/issues/1559)），每一段對到卡上一項：
 *
 * - N0622 建立驗證：`create` 當下驗 header、當下報撞名（pending、磁碟上的 header 或日誌），實體化撞上的 `EEXIST` 換型別。
 * - N0644 關閉之後再用，拋 `SessionHandleClosedError`，訊息原文不變。
 * - N0646 這一版讀不懂的日誌，錯誤帶 `location`（日誌的絕對路徑），訊息不帶。
 * - N0633 建構時就檢查根能不能讀。
 * - N0625 冷讀解析快取：看過立刻續接只解析一次。
 * - N0627 同一個後端的列舉共用一個上限，加起來最多同時讀 3 份；依輸入順序報第一個失敗。
 *
 * 讀檔次數與同時在跑的數目，用 `JsonlSessionStoreOptions.fs`（只給測試換）量。
 */

import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionAlreadyExistsError,
  SessionCorruptionError,
  SessionEventUnsupportedError,
  SessionFormatUnsupportedError,
  SessionHandleClosedError,
  generationLogFilename,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  sessionPathsIn,
} from './jsonl-session-store.js';
import type { JsonlSessionStore, StableReadFileSystem } from './jsonl-session-store.js';
import { LEGACY_TWO_FILE_FORMAT_VERSION } from './session-files.fixture.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tmp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-1559-'));
  roots.push(root);
  return root;
}

function headerOf(id: string, extra: Partial<StoredSessionHeader> = {}): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, ...extra };
}

function turnStart(seq: number): SessionEvent {
  return { type: 'turn/start', seq, time: seq + 1, data: { kind: 'resume' } } as SessionEvent;
}

/** 建一份落了盤的會話：`count` 顆 `turn/start`，關掉。 */
async function seed(store: JsonlSessionStore, id: string, count = 1): Promise<void> {
  const stored = store.create(headerOf(id));
  await stored.append(Array.from({ length: count }, (_, seq) => turnStart(seq)));
  await stored.close();
}

/** 真的檔案系統，加上每個路徑被 `readFile` 幾次的計數。 */
function countingFs(): StableReadFileSystem & { readonly reads: Map<string, number> } {
  const reads = new Map<string, number>();
  return {
    reads,
    stat: (path) => stat(path, { bigint: true }),
    readFile: async (path) => {
      reads.set(path, (reads.get(path) ?? 0) + 1);
      return readFile(path);
    },
  };
}

describe('N0622 建立驗證', () => {
  it('A：磁碟上已經有這份，create 當場同步拋 SessionAlreadyExistsError', async () => {
    const store = openJsonlSessionStore({ directory: await tmp() });
    await seed(store, 'a');
    expect(() => store.create(headerOf('a'))).toThrow(SessionAlreadyExistsError);
    try {
      store.create(headerOf('a'));
    } catch (error: unknown) {
      expect((error as SessionAlreadyExistsError).id).toBe('a');
    }
  });

  it('B：同一個後端建過、還沒實體化的，再建一次就拋', async () => {
    const store = openJsonlSessionStore({ directory: await tmp() });
    const first = store.create(headerOf('b'));
    expect(() => store.create(headerOf('b'))).toThrow(SessionAlreadyExistsError);
    await first.close();
  });

  it('C：版本不是這一版就拋 TypeError', async () => {
    const store = openJsonlSessionStore({ directory: await tmp() });
    expect(() =>
      store.create({ ...headerOf('c'), version: 47 } as unknown as StoredSessionHeader),
    ).toThrow(TypeError);
  });

  it.each([Number.NaN, -1, 1.5])('D：createdAt 是 %s 就拋 TypeError', async (createdAt) => {
    const store = openJsonlSessionStore({ directory: await tmp() });
    expect(() => store.create(headerOf('d', { createdAt }))).toThrow(TypeError);
  });

  it('E：cwd 是相對路徑就拋 TypeError', async () => {
    const store = openJsonlSessionStore({ directory: await tmp() });
    expect(() => store.create(headerOf('e', { cwd: 'rel/dir' }))).toThrow(/cwd/);
  });

  it('E2：鍵白名單與各格形狀——多出這一版不寫的鍵、build／plugins 形狀不對，都拋 TypeError', async () => {
    const store = openJsonlSessionStore({ directory: await tmp() });
    expect(() =>
      store.create({ ...headerOf('e2'), surprise: 1 } as unknown as StoredSessionHeader),
    ).toThrow(/surprise/);
    expect(() =>
      store.create(
        headerOf('e2', { build: { commit: 1 } as unknown as StoredSessionHeader['build'] }),
      ),
    ).toThrow(/build/);
    expect(() =>
      store.create(
        headerOf('e2', {
          plugins: [{ name: 'x' }] as unknown as StoredSessionHeader['plugins'],
        }),
      ),
    ).toThrow(/plugins\[0\]/);
    // 出貨會寫的完整一份照收。
    const ok = store.create(
      headerOf('e2', {
        cwd: '/abs',
        workspaceRoot: '/abs/ws',
        parentSession: 'root',
        build: { commit: null, dirty: false },
        plugins: [{ name: '@nexus/x', id: 'one', disabled: false }],
        configHash: 'hmac-sha256:0123456789abcdef',
        modelEntryId: 'model',
      }),
    );
    await ok.close();
  });

  it('F：還沒實體化就關掉，同一個 id 可以再建', async () => {
    const store = openJsonlSessionStore({ directory: await tmp() });
    const first = store.create(headerOf('f'));
    await first.close();
    const again = store.create(headerOf('f'));
    await again.append([turnStart(0)]);
    await again.close();
  });

  it('G：create 之後 header 才出現在磁碟上（競態），第一次寫拋 SessionAlreadyExistsError，cause 是 EEXIST', async () => {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    const late = store.create(headerOf('g'));
    await seed(openJsonlSessionStore({ directory }), 'g');
    const failure = await late.append([turnStart(0)]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionAlreadyExistsError);
    expect(((failure as Error).cause as { code?: unknown }).code).toBe('EEXIST');
    await late.close();
  });

  it('H：header 不在、日誌在（舊兩檔的孤兒日誌）也算建過，create 當場拋', async () => {
    const directory = await tmp();
    await writeFile(legacyTwoFilePathsIn(directory, 'h').log, '');
    const store = openJsonlSessionStore({ directory });
    expect(() => store.create(headerOf('h'))).toThrow(SessionAlreadyExistsError);
  });

  it('I：create 之後才出現孤兒世代檔（競態），發佈世代檔的 link 撞上 EEXIST 也換成 SessionAlreadyExistsError', async () => {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    const late = store.create(headerOf('i'));
    const paths = sessionPathsIn(directory, 'i');
    await mkdir(paths.sessionDirectory);
    await writeFile(paths.log, '');
    const failure = await late.append([turnStart(0)]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionAlreadyExistsError);
    expect(((failure as Error).cause as { code?: unknown }).code).toBe('EEXIST');
    await late.close();
  });

  it('驗過的是拷貝：create 之後改呼叫方的物件，不會改到落盤的 header', async () => {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    const header = { ...headerOf('copy'), cwd: '/before' };
    const stored = store.create(header);
    header.cwd = '/after';
    await stored.append([turnStart(0)]);
    await stored.close();
    expect((await store.open('copy', 'read')).header.cwd).toBe('/before');
  });
});

describe('N0644 關閉之後再用', () => {
  it('A／B：append 與 flush 各自 reject SessionHandleClosedError，訊息原文不變', async () => {
    const store = openJsonlSessionStore({ directory: await tmp() });
    const stored = store.create(headerOf('closed'));
    await stored.close();
    for (const attempt of [() => stored.append([turnStart(0)]), () => stored.flush()]) {
      const failure = await attempt().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionHandleClosedError);
      expect((failure as Error).message).toBe('會話 "closed" 的把手已經關掉了。');
      expect((failure as SessionHandleClosedError).id).toBe('closed');
    }
  });
});

describe('N0646 拒讀時帶位置', () => {
  /** 寫方建一份，再把世代檔換成比這一版新的那一版：檔名與 header 行的版號一起改。 */
  async function newerHeader(): Promise<{ store: JsonlSessionStore; path: string }> {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    await seed(store, 'newer');
    const paths = sessionPathsIn(directory, 'newer');
    const newer = join(
      paths.sessionDirectory,
      generationLogFilename(SESSION_LOG_FORMAT_VERSION + 1),
    );
    await rename(paths.log, newer);
    const text = await readFile(newer, 'utf8');
    const newline = text.indexOf('\n');
    const header = JSON.parse(text.slice(0, newline)) as Record<string, unknown>;
    await writeFile(
      newer,
      `${JSON.stringify({ ...header, version: SESSION_LOG_FORMAT_VERSION + 1 })}${text.slice(newline)}`,
    );
    return { store, path: newer };
  }

  it('A／C：header 版本比這一版新，open(read) 與 resume 的錯誤帶日誌的絕對路徑，訊息不帶', async () => {
    const { store, path } = await newerHeader();
    for (const attempt of [() => store.open('newer', 'read'), () => store.resume('newer')]) {
      const failure = await attempt().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionFormatUnsupportedError);
      expect((failure as SessionFormatUnsupportedError).location).toEqual({ kind: 'jsonl', path });
      expect((failure as Error).message).not.toContain(path);
    }
  });

  it('B／C：本文裡有這一版不認得、沒標可忽略的事件，SessionEventUnsupportedError 同樣帶位置', async () => {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    await seed(store, 'unknown');
    const { log } = sessionPathsIn(directory, 'unknown');
    await appendFile(
      log,
      `${JSON.stringify({ type: 'future/thing', seq: 1, time: 2, data: {} })}\n`,
    );
    const reader = await store.open('unknown', 'read');
    for (const attempt of [
      () => reader.read(),
      () => reader.read({ salvage: true }),
      () => store.resume('unknown'),
    ]) {
      const failure = await attempt().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionEventUnsupportedError);
      expect((failure as SessionEventUnsupportedError).location).toEqual({
        kind: 'jsonl',
        path: log,
      });
      expect((failure as Error).message).not.toContain(log);
    }
  });
});

describe('N0633 建構時就檢查根', () => {
  it('A：目錄是一般檔案，建構當場拋 ENOTDIR', async () => {
    const file = join(await tmp(), 'not-a-directory');
    await writeFile(file, '');
    expect(() => openJsonlSessionStore({ directory: file })).toThrow(
      expect.objectContaining({ code: 'ENOTDIR' }),
    );
  });

  it('B：目錄還不在，照常建構，第一次寫才建出來', async () => {
    const directory = join(await tmp(), 'later', 'here');
    const store = openJsonlSessionStore({ directory });
    await expect(stat(directory)).rejects.toThrow(expect.objectContaining({ code: 'ENOENT' }));
    await seed(store, 'b');
    expect((await stat(directory)).isDirectory()).toBe(true);
  });
});

describe('N0625 冷讀解析快取', () => {
  it('A：open(read).read() 之後立刻 resume，日誌只讀一次', async () => {
    const directory = await tmp();
    const fs = countingFs();
    const store = openJsonlSessionStore({ directory, fs });
    await seed(store, 'cold', 3);
    const { log, tombstone } = sessionPathsIn(directory, 'cold');
    const inspected = await (await store.open('cold', 'read')).read();
    const headerReads = fs.reads.get(tombstone);
    const resumed = await store.resume('cold');
    expect(fs.reads.get(log)).toBe(1);
    // 墓碑不是日誌：續接拿租約前後各定位一次，每次讀它分辨是墓碑還是舊兩檔的 header（幾百個位元組），本文不重讀。
    expect(fs.reads.get(tombstone)).toBe((headerReads ?? 0) + 2);
    expect(resumed.events).toBe(inspected);
    await resumed.stored.close();
  });

  it('B：中間另一個後端寫進去，revision 變了，resume 讀到新的那一筆', async () => {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    await seed(store, 'other');
    await (await store.open('other', 'read')).read();
    const elsewhere = await openJsonlSessionStore({ directory }).resume('other');
    await elsewhere.stored.append([turnStart(1)]);
    await elsewhere.stored.close();
    const resumed = await store.resume('other');
    expect(resumed.events.map((event) => event.seq)).toEqual([0, 1]);
    await resumed.stored.close();
  });

  it('C：本後端自己寫了之後再讀，讀到新的那一筆', async () => {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    await seed(store, 'own');
    await (await store.open('own', 'read')).read();
    const resumed = await store.resume('own');
    await resumed.stored.append([turnStart(1)]);
    expect((await (await store.open('own', 'read')).read()).map((event) => event.seq)).toEqual([
      0, 1,
    ]);
    await resumed.stored.close();
  });

  it('C′：stat 給不出新的 revision（時間戳粒度粗、大小剛好一樣）時，靠寫入時刪快取讀到新的那一筆', async () => {
    const directory = await tmp();
    // 每個路徑第一次 stat 的結果之後一直回同一份：revision 守衛看不出變化，只剩寫入時刪快取那一道。
    const seen = new Map<string, Promise<BigIntStats>>();
    const fs: StableReadFileSystem = {
      stat: (path) => {
        let stats = seen.get(path);
        if (stats === undefined) {
          stats = stat(path, { bigint: true }) as Promise<BigIntStats>;
          seen.set(path, stats);
        }
        return stats;
      },
      readFile: (path) => readFile(path),
    };
    const store = openJsonlSessionStore({ directory, fs });
    await seed(store, 'still');
    await (await store.open('still', 'read')).read();
    const resumed = await store.resume('still');
    await resumed.stored.append([turnStart(1)]);
    expect((await (await store.open('still', 'read')).read()).map((event) => event.seq)).toEqual([
      0, 1,
    ]);
    await resumed.stored.close();
  });

  it('D：撕裂的尾巴先進了快取，續接寫入前照樣截在最後一個完整行之後', async () => {
    const directory = await tmp();
    const warnings: string[] = [];
    const store = openJsonlSessionStore({ directory, warn: (line) => warnings.push(line) });
    await seed(store, 'torn', 2);
    const { log } = sessionPathsIn(directory, 'torn');
    await appendFile(log, '{"type":"turn/st');
    expect((await (await store.open('torn', 'read')).read()).length).toBe(2);
    const resumed = await store.resume('torn');
    await resumed.stored.append([turnStart(2)]);
    await resumed.stored.close();
    // 第一行是 header 行，事件從第二行起。
    const lines = (await readFile(log, 'utf8'))
      .split('\n')
      .slice(1)
      .filter((line) => line.length > 0);
    expect(lines.map((line) => (JSON.parse(line) as SessionEvent).seq)).toEqual([0, 1, 2]);
    expect(warnings.some((line) => line.includes('已截到'))).toBe(true);
  });

  it('E：salvage 撿回的結果不進快取，resume 照樣拒絕那份壞檔', async () => {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    await seed(store, 'broken');
    const { log } = sessionPathsIn(directory, 'broken');
    // 壞行之後還有收尾事件：已收尾的輪中間壞了，是壞檔（#1508）。
    await appendFile(
      log,
      `not json\n${JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: {} })}\n`,
    );
    const salvaged = await (await store.open('broken', 'read')).read({ salvage: true });
    expect(salvaged.length).toBeGreaterThan(0);
    await expect(store.resume('broken')).rejects.toThrow(SessionCorruptionError);
  });

  it('F：最多留兩份，第三份把最舊的擠掉', async () => {
    const directory = await tmp();
    const fs = countingFs();
    const store = openJsonlSessionStore({ directory, fs });
    for (const id of ['one', 'two', 'three']) await seed(store, id);
    for (const id of ['one', 'two', 'three']) await (await store.open(id, 'read')).read();
    for (const id of ['two', 'three']) await (await store.resume(id)).stored.close();
    const { log } = sessionPathsIn(directory, 'one');
    expect(fs.reads.get(log)).toBe(1);
    const resumed = await store.resume('one');
    expect(fs.reads.get(log)).toBe(2);
    await resumed.stored.close();
  });

  it('共用的事件是深凍結的：讀方改它會拋', async () => {
    const directory = await tmp();
    const store = openJsonlSessionStore({ directory });
    await seed(store, 'frozen');
    const events = await (await store.open('frozen', 'read')).read();
    expect(() => {
      (events[0] as { data: { kind: string } }).data.kind = 'changed';
    }).toThrow(TypeError);
    expect(() => (events as SessionEvent[]).push(turnStart(1))).toThrow(TypeError);
  });
});

describe('N0627 列舉並行', () => {
  /** 直接寫舊兩檔的 header 檔（列舉只讀 header），版本 {@link LEGACY_TWO_FILE_FORMAT_VERSION}。 */
  async function headers(directory: string, count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, (_, index) => `s${String(index).padStart(3, '0')}`);
    await Promise.all(
      ids.map((id) =>
        writeFile(
          legacyTwoFilePathsIn(directory, id).header,
          JSON.stringify({ ...headerOf(id), version: LEGACY_TWO_FILE_FORMAT_VERSION }),
        ),
      ),
    );
    return ids;
  }

  it('A：100 份，同時在跑的最多 3 個', async () => {
    const directory = await tmp();
    await headers(directory, 100);
    let running = 0;
    let most = 0;
    const tracked = async <T>(work: () => Promise<T>): Promise<T> => {
      running += 1;
      most = Math.max(most, running);
      try {
        await new Promise((done) => setTimeout(done, 1));
        return await work();
      } finally {
        running -= 1;
      }
    };
    const fs: StableReadFileSystem = {
      stat: (path) => tracked(() => stat(path, { bigint: true }) as Promise<BigIntStats>),
      readFile: (path) => tracked(() => readFile(path)),
    };
    const listing = await openJsonlSessionStore({ directory, fs }).list();
    expect(listing.sessions).toHaveLength(100);
    expect(most).toBe(3);
  });

  it('A′：同一個後端兩個 list 同時跑，加起來同時在跑的最多 3 個', async () => {
    const directory = await tmp();
    await headers(directory, 30);
    let running = 0;
    let most = 0;
    const tracked = async <T>(work: () => Promise<T>): Promise<T> => {
      running += 1;
      most = Math.max(most, running);
      try {
        await new Promise((done) => setTimeout(done, 1));
        return await work();
      } finally {
        running -= 1;
      }
    };
    const fs: StableReadFileSystem = {
      stat: (path) => tracked(() => stat(path, { bigint: true }) as Promise<BigIntStats>),
      readFile: (path) => tracked(() => readFile(path)),
    };
    const store = openJsonlSessionStore({ directory, fs });
    const [first, second] = await Promise.all([store.list(), store.list()]);
    expect(first.sessions).toHaveLength(30);
    expect(second.sessions).toHaveLength(30);
    expect(most).toBe(3);
  });

  it('B：兩份讀失敗，拋的是輸入順序上的第一個（不是先失敗的那個），成功時順序同目錄', async () => {
    const directory = await tmp();
    await headers(directory, 8);
    const order = (await readdir(directory)).map((name) => name.split('.')[0]);
    const [earlier, later] = [order[1], order[4]] as [string, string];
    const fs: StableReadFileSystem = {
      stat: (path) => stat(path, { bigint: true }),
      readFile: async (path) => {
        if (path.includes(`${earlier}.`)) {
          // 順序上在前的那個晚一點才失敗：先失敗先回的寫法會拋 later 的。
          await new Promise((done) => setTimeout(done, 30));
          throw Object.assign(new Error(`EIO ${earlier}`), { code: 'EIO' });
        }
        if (path.includes(`${later}.`))
          throw Object.assign(new Error(`EIO ${later}`), { code: 'EIO' });
        return readFile(path);
      },
    };
    await expect(openJsonlSessionStore({ directory, fs }).list()).rejects.toThrow(`EIO ${earlier}`);
    const listing = await openJsonlSessionStore({ directory }).list();
    expect(listing.sessions.map((session) => session.header.id)).toEqual(order);
  });

  it.each([0, 1.5, -1])(
    'C：listConcurrency 是 %s 就在建構時拋 TypeError',
    async (listConcurrency) => {
      const directory = await tmp();
      expect(() => openJsonlSessionStore({ directory, listConcurrency })).toThrow(TypeError);
    },
  );
});
