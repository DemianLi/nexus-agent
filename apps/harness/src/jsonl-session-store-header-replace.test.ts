/**
 * 續接遷移時舊 header 換成墓碑（[#1594](https://github.com/DemianLi/nexus-agent/issues/1594) ③）、日誌本文走穩定快照讀
 * （[#1509](https://github.com/DemianLi/nexus-agent/issues/1509)）。
 *
 * 舊路徑的 header 從不就地覆寫：已經是墓碑就整步不碰；舊兩檔遷成世代檔時，新世代落定（`link`＋會話目錄 `fsync`）之後才把舊
 * header 換成墓碑，換法是暫存檔＋`fsync`＋`rename`＋目錄 `fsync`，然後才交把手、開世代檔續寫。換到一半失敗，舊 header 原樣，
 * 新世代留著（遷移當下當掉的中間狀態），下一次續接補上墓碑。讀日誌本文讀前讀後各 `stat`，變了重讀一次，不拼出垃圾行、也不讓
 * 續接照錯的位置截檔。
 *
 * 照 `jsonl-session-store-materialize.test.ts` 的做法包一層 `node:fs/promises`，記下呼叫順序、在指定處注入失敗。
 * B 條同時掛了暫存檔 `fsync` 失敗與「就地 `writeFile` 寫一半」：哪天墓碑改成就地覆寫，舊 header 會真的被寫壞，紅在位元組那個斷言上。
 */

import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_LOG_FORMAT_VERSION, sessionDirectoryName } from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

/** 失敗注入。每條測試開頭重設。 */
interface Injection {
  /** 暫存檔的 `sync` 拋 ENOSPC。 */
  tempSyncEnospc: boolean;
  /** 舊實作的路徑：就地 `writeFile(<header>)` 先寫一半再拋 ENOSPC。新實作不會走到，掛著是為了讓改回就地覆寫時 header 真的變壞。 */
  partialHeaderWrite: boolean;
  /** `rename` 拋這個碼（`times` 次後恢復）；`Infinity` 是永遠。 */
  renameFails: { code: string; times: number } | undefined;
  /** 第一次讀日誌本文（不帶 encoding 的 `readFile`）時：回傳這段位元組，並先執行副作用。 */
  firstLogRead: { garbage: Buffer; sideEffect: () => Promise<void> } | undefined;
}

const calls: string[] = [];
let tmpBase = '';
let dir = '';
let inject: Injection = noInjection();

function noInjection(): Injection {
  return {
    tempSyncEnospc: false,
    partialHeaderWrite: false,
    renameFails: undefined,
    firstLogRead: undefined,
  };
}

/** 路徑換成不隨每次執行變動的標籤。 */
function label(path: string): string {
  return (relative(tmpBase, path) || '.').replace(/\.[0-9a-f]{12}\.tmp$/u, '.tmp');
}

function isDirectoryOpen(path: string, flags: unknown): boolean {
  return flags === 'r' && !/\.(json|jsonl|lock|tmp)$/u.test(path);
}

function wrapHandle(target: FileHandle, path: string, directory: boolean): FileHandle {
  return new Proxy(target, {
    get(real, property) {
      if (property === 'sync') {
        return async () => {
          if (directory) calls.push(`sync-dir ${label(path)}`);
          else if (path.endsWith('.tmp')) {
            calls.push(`sync ${label(path)}`);
            if (inject.tempSyncEnospc) {
              throw Object.assign(new Error('ENOSPC: no space left on device, fsync'), {
                code: 'ENOSPC',
              });
            }
          }
          return real.sync();
        };
      }
      const value: unknown = Reflect.get(real, property, real);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(real)
        : value;
    },
  });
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (path: string, flags?: unknown, mode?: unknown) => {
      const p = String(path);
      const directory = isDirectoryOpen(p, flags);
      if (!directory && !p.endsWith('.lock')) calls.push(`open ${label(p)} ${String(flags)}`);
      const handle = await actual.open(p, flags as never, mode as never);
      return wrapHandle(handle, p, directory);
    },
    rename: async (from: string, to: string) => {
      calls.push(`rename ${label(to)}`);
      if (inject.renameFails !== undefined && inject.renameFails.times > 0) {
        inject.renameFails.times -= 1;
        throw Object.assign(new Error(`${inject.renameFails.code}: rename failed`), {
          code: inject.renameFails.code,
        });
      }
      return actual.rename(from, to);
    },
    rm: async (path: string, options?: never) => {
      calls.push(`rm ${label(String(path))}`);
      return actual.rm(path, options);
    },
    truncate: async (path: string, length?: number) => {
      calls.push(`truncate ${label(String(path))}`);
      return actual.truncate(path, length);
    },
    writeFile: async (path: unknown, data: unknown, options?: unknown) => {
      if (typeof path === 'string' && path.startsWith(tmpBase))
        calls.push(`writeFile ${label(path)}`);
      if (inject.partialHeaderWrite && typeof path === 'string' && path.endsWith('.header.json')) {
        const text = String(data);
        await actual.writeFile(path, text.slice(0, Math.floor(text.length / 2)), options as never);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
          code: 'ENOSPC',
        });
      }
      return actual.writeFile(path as never, data as never, options as never);
    },
    readFile: async (path: unknown, options?: unknown) => {
      if (
        inject.firstLogRead !== undefined &&
        typeof path === 'string' &&
        path.endsWith('.jsonl') &&
        options === undefined
      ) {
        const { garbage, sideEffect } = inject.firstLogRead;
        inject.firstLogRead = undefined;
        const real = await actual.readFile(path);
        await sideEffect();
        return Buffer.concat([real, garbage]);
      }
      return actual.readFile(path as never, options as never);
    },
  };
});

const { legacyTwoFilePathsIn, openJsonlSessionStore, readStableSnapshot, sessionPathsIn } =
  await import('./jsonl-session-store.js');
import type { StableReadFileSystem } from './jsonl-session-store.js';

const ID = 'hdr';
const CURRENT = SESSION_LOG_FORMAT_VERSION;

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), 'nexus-header-replace-'));
  dir = join(tmpBase, 'p');
  calls.length = 0;
  inject = noInjection();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmpBase, { recursive: true, force: true });
});

function header(): StoredSessionHeader {
  return { version: CURRENT, id: ID, createdAt: 7, cwd: '/tmp' };
}

function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

function line(seq: number): string {
  return `${JSON.stringify({ type: 'model/usage', seq, time: 1, data: {} })}\n`;
}

/** 舊路徑：舊兩檔的 header，遷移之後是墓碑。 */
const headerPath = () => legacyTwoFilePathsIn(dir, ID).header;
/** 這一版的世代檔。 */
const logPath = () => sessionPathsIn(dir, ID).log;
/** 會話目錄在呼叫紀錄裡的標籤。 */
const SESSION_DIR = `p/${sessionDirectoryName(ID)}`;

function store() {
  return openJsonlSessionStore({ directory: dir, warn: () => undefined });
}

/** 寫方寫一份有 3 顆事件的會話（世代檔，舊路徑有墓碑）。 */
async function seedSession(): Promise<void> {
  const created = store().create(header());
  await created.append([event(0), event(1), event(2)]);
  await created.close();
  calls.length = 0;
}

/** 手寫一份 v0.5.19 以前寫的舊兩檔，有 3 顆事件，header 是 `version` 那一版寫的。 */
async function seedLegacy(version: number): Promise<void> {
  const paths = legacyTwoFilePathsIn(dir, ID);
  await mkdir(dir, { recursive: true });
  await writeFile(paths.header, `${JSON.stringify({ ...header(), version }, null, 2)}\n`);
  await writeFile(paths.log, line(0) + line(1) + line(2));
  calls.length = 0;
}

/** 墓碑：這一版的 header 行。 */
function tombstone(): Record<string, unknown> {
  return { type: 'session', ...header() };
}

/** 會話所在的目錄與會話目錄裡殘留的暫存檔。 */
async function leftoverTemps(): Promise<string[]> {
  const entries = [...(await readdir(dir))];
  const sessionDirectory = join(dir, sessionDirectoryName(ID));
  const inner = await readdir(sessionDirectory).catch(() => [] as string[]);
  return [...entries, ...inner].filter((entry) => entry.endsWith('.tmp'));
}

async function identity(path: string) {
  const { ino, mtimeNs, ctimeNs } = await stat(path, { bigint: true });
  return { ino, mtimeNs, ctimeNs };
}

/** 對 header 正式路徑（不含暫存檔）的呼叫。 */
function headerCalls(): string[] {
  return calls.filter((call) => /\.header\.json(?!\.)/u.test(call) && !call.includes('.tmp'));
}

describe('A. 舊路徑的 header 上不准就地截斷', () => {
  it('遷移舊兩檔並寫一筆：舊 header 唯一的變化是一次 rename 蓋上墓碑，沒有以 w 開、truncate、writeFile', async () => {
    await seedLegacy(2);
    const resumed = await store().resume(ID);
    await resumed.stored.append([event(resumed.events.length)]);
    await resumed.stored.close();

    expect(headerCalls()).toEqual([`rename p/${ID}.header.json`]);
    expect(calls.filter((call) => call.startsWith('writeFile'))).toEqual([]);
    expect(calls.filter((call) => call.startsWith('truncate'))).toEqual([]);
    expect(calls.some((call) => /open .*\.header\.json (w|w\+)$/u.test(call))).toBe(false);
  });

  it('新世代落定（暫存檔 fsync → 會話目錄 fsync）之後才換墓碑，墓碑落定（rename → 目錄 fsync）之後才開世代檔續寫', async () => {
    await seedLegacy(2);
    const resumed = await store().resume(ID);
    await resumed.stored.append([event(resumed.events.length)]);
    await resumed.stored.close();

    const at = (needle: string) => calls.indexOf(needle);
    const generationSync = at(`sync ${SESSION_DIR}/session.v${String(CURRENT)}.jsonl.tmp`);
    const sessionDirSync = calls.findIndex(
      (call, index) => index > generationSync && call === `sync-dir ${SESSION_DIR}`,
    );
    const rename = at(`rename p/${ID}.header.json`);
    const dirSync = calls.findIndex((call, index) => index > rename && call === 'sync-dir p');
    const logOpen = at(`open ${SESSION_DIR}/session.v${String(CURRENT)}.jsonl a`);
    expect(generationSync).toBeGreaterThanOrEqual(0);
    expect(sessionDirSync).toBeGreaterThan(generationSync);
    expect(rename).toBeGreaterThan(sessionDirSync);
    expect(dirSync).toBeGreaterThan(rename);
    expect(logOpen).toBeGreaterThan(dirSync);
  });
});

describe('B. 遷移中途失敗，舊 header 原樣', () => {
  it('暫存檔 fsync 拋 ENOSPC：續接拒絕、舊兩檔位元組不變、沒有殘留 .tmp、不留會話目錄；撤掉注入再續接成功', async () => {
    await seedLegacy(2);
    const before = [
      await readFile(headerPath()),
      await readFile(legacyTwoFilePathsIn(dir, ID).log),
    ];
    inject.tempSyncEnospc = true;
    inject.partialHeaderWrite = true;

    await expect(store().resume(ID)).rejects.toThrow(/ENOSPC/);

    expect([
      await readFile(headerPath()),
      await readFile(legacyTwoFilePathsIn(dir, ID).log),
    ]).toEqual(before);
    expect(await leftoverTemps()).toEqual([]);
    expect(await readdir(dir)).not.toContain(sessionDirectoryName(ID));

    inject = noInjection();
    const resumed = await store().resume(ID);
    await resumed.stored.append([event(resumed.events.length)]);
    await resumed.stored.close();
    expect(JSON.parse(await readFile(headerPath(), 'utf8'))).toEqual(tombstone());
    expect((await (await store().open(ID, 'read')).read()).length).toBe(4);
  });

  it('換墓碑的 rename 拋 ENOSPC：續接拒絕、舊 header 不變；新世代留著照讀，下一次續接補上墓碑', async () => {
    await seedLegacy(2);
    const before = await readFile(headerPath());
    inject.renameFails = { code: 'ENOSPC', times: Number.POSITIVE_INFINITY };
    inject.partialHeaderWrite = true;

    await expect(store().resume(ID)).rejects.toThrow(/ENOSPC/);

    expect(await readFile(headerPath())).toEqual(before);
    expect(JSON.parse(before.toString('utf8'))).toMatchObject({ version: 2, id: ID });
    expect(await leftoverTemps()).toEqual([]);
    // 遷移當下當掉的中間狀態：舊日誌對得上新世代記的來源，讀新世代、只列一份。
    expect((await (await store().open(ID, 'read')).read()).length).toBe(3);
    expect(await store().list()).toMatchObject({
      unreadable: 0,
      sessions: [{ header: { id: ID } }],
    });

    inject = noInjection();
    const resumed = await store().resume(ID);
    await resumed.stored.append([event(resumed.events.length)]);
    await resumed.stored.close();
    expect(JSON.parse(await readFile(headerPath(), 'utf8'))).toEqual(tombstone());
    expect((await (await store().open(ID, 'read')).read()).length).toBe(4);
  });
});

describe('C. 已經是墓碑就不碰', () => {
  it('寫方寫的：續接並寫一筆，墓碑的 ino／mtimeNs／ctimeNs 前後相同，沒有任何對舊路徑 header 的呼叫', async () => {
    await seedSession();
    const before = await identity(headerPath());
    const bytes = await readFile(headerPath());

    const resumed = await store().resume(ID);
    await resumed.stored.append([event(resumed.events.length)]);
    await resumed.stored.close();

    expect(await identity(headerPath())).toEqual(before);
    expect(await readFile(headerPath())).toEqual(bytes);
    expect(headerCalls()).toEqual([]);
    expect((await (await store().open(ID, 'read')).read()).length).toBe(4);
  });

  it('舊兩檔：遷移之後 ino 換了，內容是這一版的 header 行', async () => {
    await seedLegacy(2);
    const before = await identity(headerPath());

    const resumed = await store().resume(ID);
    await resumed.stored.append([event(resumed.events.length)]);
    await resumed.stored.close();

    expect((await identity(headerPath())).ino).not.toBe(before.ino);
    expect(JSON.parse(await readFile(headerPath(), 'utf8'))).toEqual(tombstone());
  });
});

describe('Windows：rename 暫時性錯誤有界重試', () => {
  async function onWin32<T>(run: () => Promise<T>): Promise<T> {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      return await run();
    } finally {
      Object.defineProperty(process, 'platform', real);
    }
  }

  it('EBUSY 兩次後恢復：換墓碑成功，rename 共三次', async () => {
    await seedLegacy(2);
    inject.renameFails = { code: 'EBUSY', times: 2 };
    const resumed = await onWin32(() => store().resume(ID));
    await resumed.stored.close();

    expect(calls.filter((call) => call === `rename p/${ID}.header.json`)).toHaveLength(3);
    expect(JSON.parse(await readFile(headerPath(), 'utf8'))).toMatchObject({ version: CURRENT });
  });

  it('一直 EPERM：試 1 + 8 次後拋原錯，舊 header 原樣、沒有殘留 .tmp', async () => {
    await seedLegacy(2);
    const before = await readFile(headerPath());
    inject.renameFails = { code: 'EPERM', times: Number.POSITIVE_INFINITY };

    await expect(onWin32(() => store().resume(ID))).rejects.toThrow(/EPERM/);

    expect(calls.filter((call) => call === `rename p/${ID}.header.json`)).toHaveLength(9);
    expect(await readFile(headerPath())).toEqual(before);
    expect(await leftoverTemps()).toEqual([]);
  });

  it('不是 win32：EBUSY 不重試，一次就拋', async () => {
    await seedLegacy(2);
    inject.renameFails = { code: 'EBUSY', times: Number.POSITIVE_INFINITY };

    await expect(store().resume(ID)).rejects.toThrow(/EBUSY/);
    expect(calls.filter((call) => call === `rename p/${ID}.header.json`)).toHaveLength(1);
  });
});

/** 做出只有 `readStableSnapshot` 用得到的幾個欄位的 stat。 */
function stats(size: number, mtimeNs: number): BigIntStats {
  return {
    dev: 1n,
    ino: 2n,
    size: BigInt(size),
    mtimeNs: BigInt(mtimeNs),
    ctimeNs: BigInt(mtimeNs),
  } as unknown as BigIntStats;
}

/** 照順序吐出 stat 與 readFile 結果的檔案系統，並數呼叫次數。 */
function scriptedFs(statResults: BigIntStats[], reads: string[]) {
  const counts = { stat: 0, readFile: 0 };
  const fs: StableReadFileSystem = {
    stat: async () => statResults[counts.stat++]!,
    readFile: async () => Buffer.from(reads[counts.readFile++]!),
  };
  return { fs, counts };
}

describe('D. 穩定讀的機制', () => {
  it('讀前讀後身分一樣：讀一次，回那份位元組與身分', async () => {
    const s = stats(5, 100);
    const { fs, counts } = scriptedFs([s, s], ['hello']);
    const result = await readStableSnapshot('x', fs);
    expect(result.bytes.toString()).toBe('hello');
    expect(result.identity).toBe('1:2:5:100:100');
    expect(counts).toEqual({ stat: 2, readFile: 1 });
  });

  it('第一次讀前後不同：再讀一次，回第二次的內容', async () => {
    const { fs, counts } = scriptedFs(
      [stats(5, 100), stats(8, 200), stats(8, 200)],
      ['hello', 'hello!!!'],
    );
    const result = await readStableSnapshot('x', fs);
    expect(result.bytes.toString()).toBe('hello!!!');
    expect(result.identity).toBe('1:2:8:200:200');
    expect(counts).toEqual({ stat: 3, readFile: 2 });
  });

  it('兩次都不同：回第二次讀到的位元組截到讀前大小的前綴，與讀前身分；不讀第三次', async () => {
    const { fs, counts } = scriptedFs(
      [stats(5, 100), stats(8, 200), stats(12, 300)],
      ['hello', 'hello!!!++++'],
    );
    const result = await readStableSnapshot('x', fs);
    expect(result.bytes.toString()).toBe('hello!!!');
    expect(result.identity).toBe('1:2:8:200:200');
    expect(counts).toEqual({ stat: 3, readFile: 2 });
  });

  it('檔案不在：stat 的 ENOENT 往外拋（readBody 把它收成空）', async () => {
    const fs: StableReadFileSystem = {
      stat: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readFile: async () => Buffer.alloc(0),
    };
    await expect(readStableSnapshot('x', fs)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('E. 穩定讀的接線（經過真的 store）', () => {
  const GARBAGE = Buffer.from('{拼接出來的垃圾\n');

  async function armFirstRead(): Promise<{ appended: string }> {
    const appended = line(3);
    inject.firstLogRead = {
      garbage: GARBAGE,
      sideEffect: () => appendFile(logPath(), appended),
    };
    return { appended };
  }

  it('open(id, "read").read()：第一次讀被追加打斷，不拋、事件是完整的四顆', async () => {
    await seedSession();
    await armFirstRead();

    const events = await (await store().open(ID, 'read')).read();

    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  it('resume(id)：第一次讀被追加打斷，事件是完整的四顆，接著寫之後檔案沒被截短', async () => {
    await seedSession();
    // 先量、再上膛：注入掛在「第一次不帶 encoding 讀日誌」上，測試自己的 readFile 也算。
    const original = (await readFile(logPath())).byteLength;
    const { appended } = await armFirstRead();

    const resumed = await store().resume(ID);
    expect(resumed.events.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
    await resumed.stored.append([event(resumed.events.length)]);
    await resumed.stored.close();

    const after = await readFile(logPath());
    expect(after.byteLength).toBeGreaterThanOrEqual(original + Buffer.byteLength(appended));
    expect(after.toString('utf8')).toContain(appended);
    expect((await (await store().open(ID, 'read')).read()).map((e) => e.seq)).toEqual([
      0, 1, 2, 3, 4,
    ]);
  });
});
