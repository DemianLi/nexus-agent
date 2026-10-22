/**
 * JSONL 後端的唯讀那兩條：`list` 與 `open(id, 'read')`（[#665](https://github.com/DemianLi/nexus-agent/issues/665)），
 * 以及給產品路徑外的讀方用的接縫（`readSessionEntry`、`sessionPathsIn`，#1857）、header 解析與會話根的格子列舉。
 * 契約見 `@nexus/core` 的 `session-store.ts`；檔名本身的單元測試在 `@nexus/core` 的 `session-filename.test.ts`。
 *
 * 會話都經後端寫；要壞掉、版本太新的才手寫。
 */

import { existsSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionEventUnsupportedError,
  SessionFormatUnsupportedError,
  SessionNotFoundError,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import {
  createJsonlSessionStore,
  listSessionStoreDirectories,
  openJsonlSessionStore,
  parseHeader,
  parseJsonlSessionBody,
  projectKey,
  readSessionEntry,
  sessionPathsIn,
} from './jsonl-session-store.js';
import type { SessionEntry, StableReadFileSystem } from './jsonl-session-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-store-read-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 寫在磁碟上的 header：`version` 可以是任何一版（舊的寫方、比這一版新的寫方）。讀回來才轉譯成這一版。 */
type OnDiskHeader = Omit<StoredSessionHeader, 'version'> & { readonly version: number };

function header(id: string, extra: Partial<OnDiskHeader> = {}): OnDiskHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/tmp', ...extra };
}

/** 這一版寫方給 `create` 的 header。 */
function current(id: string): StoredSessionHeader {
  return { ...header(id), version: SESSION_LOG_FORMAT_VERSION };
}

/** 一筆讀方收得下的事件。內容不重要，後端只驗 `type`／`time`／`seq`。 */
function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

/** 經後端寫一份 `count` 筆的會話然後關掉。 */
async function written(id: string, count = 1, extra: Partial<OnDiskHeader> = {}) {
  // 版號可能不是這一版：假裝是舊的寫方寫的（`create` 照給的 header 原樣落盤）。
  const stored = openJsonlSessionStore({ directory: dir }).create(
    header(id, extra) as unknown as StoredSessionHeader,
  );
  await stored.append(Array.from({ length: count }, (_, seq) => event(seq)));
  await stored.close();
}

/** 目錄裡每個檔的名字與內容：唯讀的兩條前後要一模一樣。 */
async function snapshot(): Promise<Record<string, string>> {
  const names = (await readdir(dir)).sort();
  return Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await readFile(join(dir, name), 'utf8')])),
  );
}

describe('list', () => {
  it('列落了盤的每一份，root 與 subagent 都列；還沒實體化的不列（偏離 dsh，見 session-store.ts）', async () => {
    await written('Alpha');
    await written('Alpha/sub-1', 1, { parentSession: 'Alpha' });
    // create 了、一筆都還沒寫：檔案系統上沒有足跡。
    const store = openJsonlSessionStore({ directory: dir });
    store.create(current('pending'));

    const { sessions, unreadable } = await store.list();
    expect(sessions.map(({ header: h }) => h.id).sort()).toEqual(['Alpha', 'Alpha/sub-1']);
    expect(sessions.find(({ header: h }) => h.id === 'Alpha/sub-1')?.header.parentSession).toBe(
      'Alpha',
    );
    expect(unreadable).toBe(0);
  });

  it('header 讀不懂、版本太新、檔名對不上 id 的不列，但數出來', async () => {
    await written('good');
    await writeFile(join(dir, 'broken.header.json'), '{壞的');
    await writeFile(
      join(dir, 'future.header.json'),
      JSON.stringify(header('future', { version: SESSION_LOG_FORMAT_VERSION + 1 })),
    );
    // `open('renamed')` 照 id 算檔名，找不到這一份：列了也打不開。
    await writeFile(join(dir, 'moved.header.json'), JSON.stringify(header('renamed')));

    const { sessions, unreadable } = await openJsonlSessionStore({ directory: dir }).list();
    expect(sessions.map(({ header: h }) => h.id)).toEqual(['good']);
    expect(unreadable).toBe(3);
  });

  it('存放處還不存在：空的，不拋；不動任何檔', async () => {
    const store = openJsonlSessionStore({ directory: join(dir, '還沒有') });
    await expect(store.list()).resolves.toEqual({ sessions: [], unreadable: 0 });
    expect(await readdir(dir)).toEqual([]);
  });

  it('中止了就拋它的 reason', async () => {
    await written('a');
    const controller = new AbortController();
    controller.abort(new Error('不要了'));
    await expect(
      openJsonlSessionStore({ directory: dir }).list({ signal: controller.signal }),
    ).rejects.toThrow('不要了');
  });

  it('revision：沒動就相等；本文多一筆、header 被改寫（續接會改 version）都會變', async () => {
    await written('a', 2);
    const store = openJsonlSessionStore({ directory: dir });
    const revision = async () => (await store.list()).sessions[0]!.revision;
    const first = await revision();
    expect(await revision()).toBe(first);

    await appendFile(join(dir, 'a.jsonl'), `${JSON.stringify(event(2))}\n`);
    const appended = await revision();
    expect(appended).not.toBe(first);

    // 同樣長度、只改內容：大小不變，靠的是修改時間。
    const text = await readFile(join(dir, 'a.header.json'), 'utf8');
    await writeFile(join(dir, 'a.header.json'), text.replace('"cwd": "/tmp"', '"cwd": "/tm2"'));
    expect(await revision()).not.toBe(appended);
  });

  it('不拿租約、不讀本文：別的把手握著照樣列，一個位元組都不改', async () => {
    await written('held', 2);
    await appendFile(join(dir, 'held.jsonl'), '{"半行');
    const holder = await openJsonlSessionStore({ directory: dir }).resume('held');
    try {
      const before = await snapshot();
      const { sessions } = await openJsonlSessionStore({ directory: dir }).list();
      expect(sessions.map(({ header: h }) => h.id)).toEqual(['held']);
      expect(await snapshot()).toEqual(before);
    } finally {
      await holder.stored.close();
    }
  });
});

describe("open(id, 'read')", () => {
  it('不拿租約、不截尾巴、不動 header：別的把手握著照樣讀得到，一個位元組都不改', async () => {
    await written('held', 2, { version: SESSION_LOG_FORMAT_VERSION - 1 });
    await appendFile(join(dir, 'held.jsonl'), '{"type":"turn/end","seq":');
    const holder = await openJsonlSessionStore({ directory: dir }).resume('held');
    try {
      const before = await snapshot();
      const reader = await openJsonlSessionStore({ directory: dir }).open('held', 'read');
      // 磁碟上的 header 不動（下面的 snapshot 比對）；交出來的 header 轉譯成這一版，原版號在 storedFormatVersion（#1856）。
      expect(reader.header.version).toBe(SESSION_LOG_FORMAT_VERSION);
      expect(reader.storedFormatVersion).toBe(SESSION_LOG_FORMAT_VERSION - 1);
      expect((await reader.read()).map((e) => e.seq)).toEqual([0, 1]);
      expect(await snapshot()).toEqual(before);
    } finally {
      await holder.stored.close();
    }
  });

  it('只有 header 是零顆；每叫一次 read 讀一次當下的', async () => {
    await written('a', 1);
    const reader = await openJsonlSessionStore({ directory: dir }).open('a', 'read');
    expect(await reader.read()).toHaveLength(1);
    await appendFile(join(dir, 'a.jsonl'), `${JSON.stringify(event(1))}\n`);
    expect(await reader.read()).toHaveLength(2);
    await rm(join(dir, 'a.jsonl'));
    expect(await reader.read()).toEqual([]);
  });

  it('壞行之後沒有完整收尾：預設 read 丟掉壞尾；salvage 撿回讀得懂的，撕裂的尾巴兩邊都不算', async () => {
    await written('torn');
    await writeFile(
      join(dir, 'torn.jsonl'),
      [
        JSON.stringify(event(0)),
        '{壞掉',
        JSON.stringify({ type: 'x', seq: 'two', time: 1 }),
        JSON.stringify(event(3)),
        '{"type":"turn/end","seq":4',
      ].join('\n'),
    );
    const reader = await openJsonlSessionStore({ directory: dir }).open('torn', 'read');
    // #1508：壞行與它之後沒收尾的行是當機留下的尾巴，recoverable 丟掉（照 dsh）；撕裂的 turn/end 沒有換行，不算收尾。
    expect((await reader.read()).map((e) => e.seq)).toEqual([0]);
    expect((await reader.read({ salvage: true })).map((e) => e.seq)).toEqual([0, 3]);
  });

  it('壞行之後有完整的收尾（turn/end 或 turn/failed）：預設拋，訊息指向第一個壞行', async () => {
    await written('closed');
    for (const closer of ['turn/end', 'turn/failed']) {
      await writeFile(
        join(dir, 'closed.jsonl'),
        [
          JSON.stringify(event(0)),
          '{壞掉',
          JSON.stringify({ type: closer, seq: 2, time: 1 }),
          '',
        ].join('\n'),
      );
      const reader = await openJsonlSessionStore({ directory: dir }).open('closed', 'read');
      await expect(reader.read()).rejects.toThrow(/第 2 行不是 JSON/u);
      await expect(reader.read()).rejects.toBeInstanceOf(SessionCorruptionError);
      // salvage 的語意不動：撿回讀得懂的。
      expect((await reader.read({ salvage: true })).map((e) => e.seq)).toEqual([0, 2]);
    }
  });

  it('找不到、版本太新、header 記的 id 對不上：各拋各的', async () => {
    const store = openJsonlSessionStore({ directory: dir });
    await expect(store.open('nobody', 'read')).rejects.toBeInstanceOf(SessionNotFoundError);
    await writeFile(
      join(dir, 'future.header.json'),
      JSON.stringify(header('future', { version: SESSION_LOG_FORMAT_VERSION + 1 })),
    );
    await expect(store.open('future', 'read')).rejects.toBeInstanceOf(
      SessionFormatUnsupportedError,
    );
    await writeFile(join(dir, 'moved.header.json'), JSON.stringify(header('renamed')));
    await expect(store.open('moved', 'read')).rejects.toBeInstanceOf(SessionCorruptionError);
    // 找不到的那一次不留鎖檔。
    expect((await readdir(dir)).filter((name) => name.endsWith('.lock'))).toEqual([]);
  });
});

/** 做出只有穩定讀用得到的幾個欄位的 stat（同 `jsonl-session-store-header-replace.test.ts`）。 */
function stats(size: number, mtimeNs: number): BigIntStats {
  return {
    dev: 1n,
    ino: 2n,
    size: BigInt(size),
    mtimeNs: BigInt(mtimeNs),
    ctimeNs: BigInt(mtimeNs),
  } as unknown as BigIntStats;
}

describe('readSessionEntry：讀一份會話的接縫（#1857 C）', () => {
  it('日誌本文走穩定快照讀：讀的當下被寫了，重讀一次，交出第二次讀到的', async () => {
    await written('a', 1);
    const paths: string[] = [];
    const statResults = [stats(5, 100), stats(8, 200), stats(8, 200)];
    const reads = ['hello', 'hello!!!'];
    const fs: StableReadFileSystem = {
      stat: async (path) => {
        paths.push(path);
        return statResults.shift()!;
      },
      readFile: async () => Buffer.from(reads.shift()!),
    };
    const entry = await readSessionEntry(dir, 'a.header.json', { fs });
    expect((await entry!.readBody()).toString()).toBe('hello!!!');
    expect(reads).toEqual([]);
    expect(new Set(paths)).toEqual(new Set([entry!.logPath]));
    expect(entry!.logPath).toBe(join(dir, 'a.jsonl'));
  });

  it('分類跟 list 一致：只有 header 是零顆、讀不懂與版本太新照拋、不是 header 檔或讀之前不見了是 undefined', async () => {
    await written('good', 2);
    await writeFile(join(dir, 'lonely.header.json'), JSON.stringify(header('lonely')));
    await writeFile(join(dir, 'broken.header.json'), '{壞的');
    await writeFile(
      join(dir, 'future.header.json'),
      JSON.stringify(header('future', { version: SESSION_LOG_FORMAT_VERSION + 1 })),
    );
    await writeFile(join(dir, 'moved.header.json'), JSON.stringify(header('renamed')));
    await writeFile(join(dir, 'good.header.json.0123456789ab.tmp'), '{殘留');

    const outcome = async (name: string): Promise<SessionEntry | string | undefined> => {
      try {
        return await readSessionEntry(dir, name);
      } catch (error: unknown) {
        return (error as Error).constructor.name;
      }
    };
    const good = (await outcome('good.header.json')) as SessionEntry;
    expect(good.header.id).toBe('good');
    expect(
      parseJsonlSessionBody('good', await good.readBody(), {
        version: good.storedFormatVersion,
        recovery: 'strict',
      }).events,
    ).toHaveLength(2);
    const lonely = (await outcome('lonely.header.json')) as SessionEntry;
    expect((await lonely.readBody()).byteLength).toBe(0);
    expect(await outcome('broken.header.json')).toBe(SessionCorruptionError.name);
    expect(await outcome('future.header.json')).toBe(SessionFormatUnsupportedError.name);
    // 檔名基底對不上 id 不歸接縫判：交出來，列表自己算讀不懂。
    const moved = (await outcome('moved.header.json')) as SessionEntry;
    expect([moved.base, moved.header.id]).toEqual(['moved', 'renamed']);
    for (const name of ['good.jsonl', 'good.lock', 'good.header.json.0123456789ab.tmp']) {
      expect(await outcome(name)).toBeUndefined();
    }
    expect(await outcome('gone.header.json')).toBeUndefined();

    // 同一個目錄，list 的分類：讀得到的兩份，讀不懂的三份（壞的、太新、檔名對不上）。
    const { sessions, unreadable } = await openJsonlSessionStore({ directory: dir }).list();
    expect(sessions.map(({ header: h }) => h.id).sort()).toEqual(['good', 'lonely']);
    expect(unreadable).toBe(3);
  });

  it('acceptNewer 照傳給 header 的讀法：比這一版新的照讀，原版號另交', async () => {
    await writeFile(
      join(dir, 'future.header.json'),
      JSON.stringify(header('future', { version: SESSION_LOG_FORMAT_VERSION + 1 })),
    );
    const entry = await readSessionEntry(dir, 'future.header.json', { acceptNewer: true });
    expect(entry?.header.version).toBe(SESSION_LOG_FORMAT_VERSION);
    expect(entry?.storedFormatVersion).toBe(SESSION_LOG_FORMAT_VERSION + 1);
  });
});

describe('sessionPathsIn', () => {
  it('對到後端真的寫出來的檔：基底照 safeBaseName（subagent 的斜線編碼掉）', async () => {
    await written('Alpha/sub-1', 1, { parentSession: 'Alpha' });
    const paths = sessionPathsIn(dir, 'Alpha/sub-1');
    expect(existsSync(paths.header)).toBe(true);
    expect(existsSync(paths.log)).toBe(true);
    expect(paths.lock.startsWith(dir)).toBe(true);
    expect(paths.header).not.toContain('Alpha/sub-1');
  });
});

describe('給產品路徑外的讀方：header 解析', () => {
  it('parseHeader：不給 id 就不比；acceptNewer 照讀比這一版新的；少了 id 或 createdAt 是壞的', () => {
    const text = (value: unknown) => JSON.stringify(value);
    expect(parseHeader(text(header('a'))).header.id).toBe('a');
    expect(() => parseHeader(text(header('a')), { id: 'b' })).toThrow(SessionCorruptionError);
    const future = text(header('f', { version: SESSION_LOG_FORMAT_VERSION + 1 }));
    expect(() => parseHeader(future)).toThrow(SessionFormatUnsupportedError);
    const newer = parseHeader(future, { acceptNewer: true });
    expect(newer.storedFormatVersion).toBe(SESSION_LOG_FORMAT_VERSION + 1);
    expect(newer.header.version).toBe(SESSION_LOG_FORMAT_VERSION);
    expect(() => parseHeader(text({ version: 1, createdAt: 1 }))).toThrow('header 記的 id');
    expect(() => parseHeader(text({ version: 1, id: 'a' }))).toThrow('沒有 createdAt');
  });
});

describe('listSessionStoreDirectories', () => {
  it('認得 serve 的專案格與 CLI 的 run 目錄，照名字排；其餘略過', async () => {
    const cli = createJsonlSessionStore({ rootDir: dir });
    const stored = cli.create(current('cli'));
    await stored.append([event(0)]);
    await stored.close();
    const project = join(dir, projectKey('/專案/甲'));
    await mkdir(project);
    await mkdir(join(dir, 'notes'));
    await writeFile(join(dir, '--a-file--'), '');

    expect(await listSessionStoreDirectories(dir)).toEqual([
      { kind: 'project', directory: project },
      { kind: 'cli-run', directory: cli.directory },
    ]);
  });

  it('會話根還不存在：空的', async () => {
    await expect(listSessionStoreDirectories(join(dir, '還沒有'))).resolves.toEqual([]);
  });
});

/** 一筆這一版不認得的事件：更新的版本寫的，或別的東西寫的。 */
function futureEvent(seq: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'future/thing', seq, time: 1, data: { n: 1 }, ...extra });
}

/**
 * 不認得的種類：沒標可忽略就整份拒絕，標了就原樣放行（[#507](https://github.com/DemianLi/nexus-agent/issues/507)）。
 * 守衛在**讀方**（解析本文那一步），所以唯讀打開、續接、離線掃描三條各有一個斷言。
 */
describe('不認得的事件種類', () => {
  async function plant(id: string, lines: readonly string[]): Promise<void> {
    await written(id, 2);
    await appendFile(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
  }

  it("open(id, 'read')：沒標可忽略的拒絕整份，是「讀不懂」不是「壞了」，點得出哪一筆", async () => {
    await plant('future', [futureEvent(2)]);
    const reader = await openJsonlSessionStore({ directory: dir }).open('future', 'read');
    const failure = await reader.read().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(SessionEventUnsupportedError);
    // 對讀者是同一件事：列表、搜尋、引用候選那幾處擋 `SessionFormatUnsupportedError` 的地方不用改。
    expect(failure).toBeInstanceOf(SessionFormatUnsupportedError);
    expect(failure).not.toBeInstanceOf(SessionCorruptionError);
    expect(failure).toMatchObject({ id: 'future', seq: 2, eventType: 'future/thing' });
    expect((failure as Error).message).toContain('"future/thing"');
  });

  it('撿回模式救不了它：壞行排在不認得的種類前面或後面，結果都一樣（撿回的是壞行，不是「更新的版本寫的」）', async () => {
    for (const order of ['壞行在前', '壞行在後'] as const) {
      const id = order === '壞行在前' ? 'salvage-bad-first' : 'salvage-bad-last';
      await written(id, 1);
      const lines = order === '壞行在前' ? ['{壞掉', futureEvent(2)] : [futureEvent(1), '{壞掉'];
      await appendFile(join(dir, `${id}.jsonl`), `${lines.join('\n')}\n`);
      const reader = await openJsonlSessionStore({ directory: dir }).open(id, 'read');
      await expect(reader.read({ salvage: true }), order).rejects.toBeInstanceOf(
        SessionEventUnsupportedError,
      );
    }
  });

  it('撿回模式：標了可忽略的照撿，壞行照略過', async () => {
    await written('salvage-ok', 1);
    await appendFile(
      join(dir, 'salvage-ok.jsonl'),
      `{壞掉\n${futureEvent(2, { ignorable: true })}\n`,
    );
    const reader = await openJsonlSessionStore({ directory: dir }).open('salvage-ok', 'read');
    expect((await reader.read({ salvage: true })).map((e) => e.type)).toEqual([
      'model/usage',
      'future/thing',
    ]);
  });

  it('標了 ignorable: true 的原樣放行，旗標與酬載都在', async () => {
    await plant('future', [futureEvent(2, { ignorable: true })]);
    const reader = await openJsonlSessionStore({ directory: dir }).open('future', 'read');
    const events = (await reader.read()) as readonly unknown[];
    expect(events).toHaveLength(3);
    expect(events[2]).toEqual({
      type: 'future/thing',
      seq: 2,
      time: 1,
      data: { n: 1 },
      ignorable: true,
    });
  });

  it('只認字面的 true：false、字串、1 都不算標了', async () => {
    for (const loose of [false, 'true', 1]) {
      const id = `loose-${String(loose)}`;
      await plant(id, [futureEvent(2, { ignorable: loose })]);
      const reader = await openJsonlSessionStore({ directory: dir }).open(id, 'read');
      await expect(reader.read(), String(loose)).rejects.toBeInstanceOf(
        SessionEventUnsupportedError,
      );
    }
  });

  it('同一行既不認得又 seq 對不上：strict 先報壞檔（那一種更需要人看）；預設讀取（recoverable）照 dsh 准入先於復原，先報不認得', async () => {
    await plant('both', [futureEvent(7)]);
    const body = Buffer.from(`${futureEvent(7)}\n`);
    expect(() =>
      parseJsonlSessionBody('both', body, {
        version: SESSION_LOG_FORMAT_VERSION,
        recovery: 'strict',
      }),
    ).toThrow(SessionCorruptionError);
    // 不先報不認得的話，recoverable 會把新版行程寫的事件當成壞尾，靜靜丟掉（#1508）。
    const reader = await openJsonlSessionStore({ directory: dir }).open('both', 'read');
    await expect(reader.read()).rejects.toBeInstanceOf(SessionEventUnsupportedError);
  });

  it('續接：沒標的當場拒絕，檔一個位元組都沒動、租約放掉了；標了的接得回來，旗標那一行原樣留著', async () => {
    await plant('required', [futureEvent(2)]);
    const store = openJsonlSessionStore({ directory: dir });
    const before = await snapshot();
    await expect(store.resume('required')).rejects.toBeInstanceOf(SessionEventUnsupportedError);
    expect(await snapshot()).toEqual(before);
    // 租約放掉了（鎖檔本來就留著）：再接一次拿到的還是同一個失敗，不是「別人握著」。
    await expect(store.resume('required')).rejects.toBeInstanceOf(SessionEventUnsupportedError);

    await plant('skippable', [futureEvent(2, { ignorable: true })]);
    const { events, stored } = await store.resume('skippable');
    expect(events.map((e) => e.type)).toEqual(['model/usage', 'model/usage', 'future/thing']);
    await stored.append([{ ...event(3) }]);
    await stored.close();
    const lines = (await readFile(join(dir, 'skippable.jsonl'), 'utf8')).trimEnd().split('\n');
    expect(lines[2]).toBe(futureEvent(2, { ignorable: true }));
    expect(lines).toHaveLength(4);
  });

  it('離線掃描用的 acceptUnknownEvents：不守，什麼都收', () => {
    const body = Buffer.from(`${futureEvent(0)}\n`);
    for (const recovery of ['strict', 'recoverable'] as const) {
      expect(
        parseJsonlSessionBody('s', body, { acceptUnknownEvents: true, recovery }).events,
      ).toHaveLength(1);
      expect(() =>
        parseJsonlSessionBody('s', body, { version: SESSION_LOG_FORMAT_VERSION, recovery }),
      ).toThrow(SessionEventUnsupportedError);
    }
  });
});
