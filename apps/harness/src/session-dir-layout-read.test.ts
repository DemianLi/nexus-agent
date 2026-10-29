/**
 * 讀方認得每會話目錄的單檔佈局（[#2122](https://github.com/DemianLi/nexus-agent/issues/2122)）：
 * `<目錄>/<sessionDirectoryName(id)>/session.v<N>.jsonl`，header 在第一行，同一個目錄裡挑最高世代。新建的會話照舊寫兩檔，所以
 * 單檔佈局的會話在這裡一律手寫（{@link writeGeneration}）；檔名都經 `@nexus/core` 產生。
 *
 * 蓋的是卡上的驗收：等價、每種新狀態的歸類、挑最高世代、撞名、冷讀快取換世代、`.header.json` 結尾的目錄、位元組額度量的檔，
 * 以及：單檔撕裂尾巴從 header 行之後截、續接不建出舊兩檔、只有「不在」那幾種錯算不在。
 */

import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyStoredFormatVersion,
  generationLogFilename,
  SESSION_LOG_FORMAT_VERSION,
  SessionAlreadyExistsError,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  SessionNotFoundError,
  sessionDirectoryName,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import { readSessionLogs } from './eval/session-scan.js';
import { openJsonlSessionStore, sessionPathsIn } from './jsonl-session-store.js';
import type { JsonlSessionStoreOptions } from './jsonl-session-store.js';
import type { SessionLogBudget } from './session-log-budget.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-dir-layout-'));
});

afterEach(async () => {
  await chmod(dir, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const CURRENT = SESSION_LOG_FORMAT_VERSION;
/** 比這一版舊、還讀得了的版本：上一版到這一版的邊是 additive（下面第一條測試斷言它）。 */
const OLDER = CURRENT - 1;

function event(seq: number, tag = 'x'): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: { tag } } as unknown as SessionEvent;
}

function header(id: string, version = CURRENT): StoredSessionHeader {
  return { version, id, createdAt: 0 } as StoredSessionHeader;
}

function lines(events: readonly SessionEvent[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join('');
}

function sessionDir(directory: string, id: string): string {
  return join(directory, sessionDirectoryName(id));
}

/**
 * 手寫一個世代檔：第一行是 header（單行 JSON），之後一行一顆事件。`raw` 給了就整份照寫。
 *
 * @returns 世代檔的路徑。
 */
async function writeGeneration(
  directory: string,
  id: string,
  version: number,
  events: readonly SessionEvent[],
  raw?: string,
): Promise<string> {
  await mkdir(sessionDir(directory, id), { recursive: true });
  const path = join(sessionDir(directory, id), generationLogFilename(version));
  await writeFile(path, raw ?? `${JSON.stringify(header(id, version))}\n${lines(events)}`);
  return path;
}

/** 經寫方寫一份舊兩檔的會話。 */
async function writeTwoFile(
  directory: string,
  id: string,
  events: readonly SessionEvent[],
): Promise<void> {
  const stored = openJsonlSessionStore({ directory }).create(header(id));
  await stored.append(events);
  await stored.close();
}

/** 記下額度收到的位元組數，永遠放行。 */
function recordingBudget(): { budget: SessionLogBudget; holds: number[]; reads: number[] } {
  const holds: number[] = [];
  const reads: number[] = [];
  const release = { release: () => undefined };
  return {
    holds,
    reads,
    budget: {
      limitBytes: Infinity,
      holdForSession: async (_id, bytes) => (holds.push(bytes), release),
      reserveForRead: async (_id, bytes) => (reads.push(bytes), release),
    },
  };
}

function store(options: JsonlSessionStoreOptions = {}) {
  return openJsonlSessionStore({ directory: dir, warn: () => undefined, ...options });
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('沒有拋');
}

const EVENTS = [event(0), event(1), event(2)];

it('OLDER 這一版讀得了（不然下面「挑最高世代」「舊世代拒絕續接」比的就不是讀得懂的兩份）', () => {
  expect(classifyStoredFormatVersion(OLDER)).toBe('readable');
});

describe('單檔佈局讀得到，跟同內容的兩檔等價', () => {
  it('列表、唯讀打開、續接、離線掃描都讀得到同樣的 header 與事件', async () => {
    const twoFileDir = join(dir, 'two-file');
    await writeTwoFile(twoFileDir, 't1', EVENTS);
    const generationDir = join(dir, 'generation');
    await writeGeneration(generationDir, 't1', CURRENT, EVENTS);

    const read = async (directory: string) => {
      const backend = openJsonlSessionStore({ directory, warn: () => undefined });
      const listing = await backend.list();
      const opened = await (await backend.open('t1', 'read')).read();
      const resumed = await backend.resume('t1');
      await resumed.stored.close();
      const scanned = await readSessionLogs([directory]);
      return {
        listed: listing.sessions.map(({ header: h, storedFormatVersion }) => ({
          h,
          storedFormatVersion,
        })),
        unreadable: listing.unreadable,
        opened,
        resumed: { header: resumed.header, events: resumed.events },
        scanned: scanned.logs.map(({ header: h, events }) => ({ h, events })),
        scanUnreadable: scanned.unreadable,
      };
    };
    const twoFile = await read(twoFileDir);
    expect(twoFile.listed).toHaveLength(1);
    expect(twoFile.opened).toHaveLength(3);
    expect(await read(generationDir)).toEqual(twoFile);
  });
});

describe('新出現的狀態各歸一類', () => {
  it('空的世代檔：列表略過、不算讀不懂；打開是找不到', async () => {
    await writeGeneration(dir, 'empty', CURRENT, [], '');
    expect(await store().list()).toEqual({ sessions: [], unreadable: 0 });
    expect(await errorOf(store().open('empty', 'read'))).toBeInstanceOf(SessionNotFoundError);
  });

  it('第一行沒有換行：列表略過、不算讀不懂', async () => {
    await writeGeneration(dir, 'half', CURRENT, [], JSON.stringify(header('half')));
    expect(await store().list()).toEqual({ sessions: [], unreadable: 0 });
  });

  it('世代檔名跟 header 版本對不上：算讀不懂，其餘照列；打開拋 SessionCorruptionError', async () => {
    await writeGeneration(
      dir,
      'mismatch',
      OLDER,
      [],
      `${JSON.stringify(header('mismatch', CURRENT))}\n`,
    );
    await writeGeneration(dir, 'good', CURRENT, EVENTS);
    const { sessions, unreadable } = await store().list();
    expect(sessions.map(({ header: h }) => h.id)).toEqual(['good']);
    expect(unreadable).toBe(1);
    expect(await errorOf(store().open('mismatch', 'read'))).toBeInstanceOf(SessionCorruptionError);
  });

  it('最高世代比這一版新：拒讀、算讀不懂，不退回次高的世代', async () => {
    await writeGeneration(dir, 'future', CURRENT, EVENTS);
    await writeGeneration(dir, 'future', CURRENT + 1, EVENTS);
    expect(await store().list()).toEqual({ sessions: [], unreadable: 1 });
    expect(await errorOf(store().open('future', 'read'))).toBeInstanceOf(
      SessionFormatUnsupportedError,
    );
    expect(await errorOf(store().resume('future'))).toBeInstanceOf(SessionFormatUnsupportedError);
  });

  it('同一個 id 新目錄與舊兩檔並存：兩份都不列、算一份讀不懂；打開與續接都拋，不默默挑一份', async () => {
    await writeTwoFile(dir, 'both', EVENTS);
    const generation = await writeGeneration(dir, 'both', CURRENT, EVENTS);
    await writeGeneration(dir, 'other', CURRENT, EVENTS);
    const { sessions, unreadable } = await store().list();
    expect(sessions.map(({ header: h }) => h.id)).toEqual(['other']);
    expect(unreadable).toBe(1);
    for (const error of [
      await errorOf(store().open('both', 'read')),
      await errorOf(store().resume('both')),
    ]) {
      expect(error).toBeInstanceOf(SessionCorruptionError);
      // 訊息會原樣送到瀏覽器：路徑只放 location（#1558 Q1 (a)）。
      expect((error as SessionCorruptionError).location).toEqual({
        kind: 'jsonl',
        path: generation,
      });
      expect((error as Error).message).not.toContain(dir);
    }
  });

  it('名字以 .header.json 結尾的目錄：列表與離線掃描都不失敗', async () => {
    await mkdir(join(dir, 'weird.header.json'));
    await writeGeneration(dir, 'good', CURRENT, EVENTS);
    const { sessions, unreadable } = await store().list();
    expect(sessions.map(({ header: h }) => h.id)).toEqual(['good']);
    expect(unreadable).toBe(0);
    const scanned = await readSessionLogs([dir]);
    expect(scanned.logs.map((log) => log.header.id)).toEqual(['good']);
    expect(scanned.unreadable).toEqual([]);
  });

  it('離線掃描：世代檔名跟 header 版本對不上的報在讀不懂裡（報挑中的世代檔），其餘照掃', async () => {
    await writeGeneration(dir, 'mismatch', OLDER, [], `${JSON.stringify(header('mismatch'))}\n`);
    await writeGeneration(dir, 'good', CURRENT, EVENTS);
    const scanned = await readSessionLogs([dir]);
    expect(scanned.logs.map((log) => log.header.id)).toEqual(['good']);
    expect(scanned.unreadable.map((entry) => entry.file)).toEqual([
      join(sessionDir(dir, 'mismatch'), generationLogFilename(OLDER)),
    ]);
  });
});

describe('舊兩檔照舊認得', () => {
  it('以符號連結放著的 header 與日誌：列表照列、照讀（目錄項不是一般檔也看名字）', async () => {
    const elsewhere = join(dir, 'elsewhere');
    await writeTwoFile(elsewhere, 't1', EVENTS);
    const linked = join(dir, 'linked');
    await mkdir(linked);
    for (const path of [
      sessionPathsIn(elsewhere, 't1').header,
      sessionPathsIn(elsewhere, 't1').log,
    ]) {
      await symlink(path, join(linked, path.slice(elsewhere.length + 1)));
    }
    const backend = openJsonlSessionStore({ directory: linked, warn: () => undefined });
    expect((await backend.list()).sessions.map(({ header: h }) => h.id)).toEqual(['t1']);
    expect(await (await backend.open('t1', 'read')).read()).toEqual(EVENTS);
  });
});

describe('同一個目錄裡有幾個世代就挑最高的', () => {
  it('列表、打開、離線掃描讀的都是最高世代', async () => {
    await writeGeneration(dir, 't1', OLDER, [event(0, 'old')]);
    await writeGeneration(dir, 't1', CURRENT, [event(0, 'new'), event(1, 'new')]);
    const { sessions } = await store().list();
    expect(sessions.map((s) => s.storedFormatVersion)).toEqual([CURRENT]);
    expect(await (await store().open('t1', 'read')).read()).toEqual([
      event(0, 'new'),
      event(1, 'new'),
    ]);
    const scanned = await readSessionLogs([dir]);
    expect(scanned.logs.map((log) => log.events.length)).toEqual([2]);
  });

  it('世代檔名的數字照數值比，不照字串比', async () => {
    await writeGeneration(dir, 't1', 9, [event(0, 'nine')], `${JSON.stringify(header('t1', 9))}\n`);
    await writeGeneration(dir, 't1', CURRENT, [event(0, 'current')]);
    expect(await (await store().open('t1', 'read')).read()).toEqual([event(0, 'current')]);
  });
});

describe('create 的撞名檢查兩種佈局都看', () => {
  it('只有單檔佈局的同 id：create 拒絕', async () => {
    await writeGeneration(dir, 't1', CURRENT, EVENTS);
    expect(() => store().create(header('t1'))).toThrow(SessionAlreadyExistsError);
  });

  it('只有一個空的會話目錄（沒有世代檔）：不算建過', async () => {
    await mkdir(sessionDir(dir, 't1'));
    const stored = store().create(header('t1'));
    await stored.close();
  });
});

describe('冷讀快取：先挑世代、再比那個世代檔', () => {
  it('別的行程發佈新世代之後，下一次打開讀到新世代，不命中舊的', async () => {
    await writeGeneration(dir, 't1', OLDER, [event(0, 'old')]);
    const backend = store();
    expect(await (await backend.open('t1', 'read')).read()).toEqual([event(0, 'old')]);
    // 舊世代檔一個位元組都沒動。
    await writeGeneration(dir, 't1', CURRENT, [event(0, 'new')]);
    expect(await (await backend.open('t1', 'read')).read()).toEqual([event(0, 'new')]);
  });

  it('續接也一樣：唯讀打開留下的那筆，在新世代發佈之後不被續接拿去用', async () => {
    await writeGeneration(dir, 't1', OLDER, [event(0, 'old')]);
    const backend = store();
    expect(await (await backend.open('t1', 'read')).read()).toEqual([event(0, 'old')]);
    await writeGeneration(dir, 't1', CURRENT, [event(0, 'new'), event(1, 'new')]);
    const resumed = await backend.resume('t1');
    expect(resumed.events).toEqual([event(0, 'new'), event(1, 'new')]);
    await resumed.stored.close();
  });
});

describe('位元組額度量的是實際要讀的那個世代檔（#2115）', () => {
  it('唯讀打開與續接收到的位元組數等於世代檔的大小（含 header 行）', async () => {
    await writeGeneration(dir, 't1', OLDER, [event(0, 'a-much-longer-older-generation')]);
    const path = await writeGeneration(dir, 't1', CURRENT, EVENTS);
    const { size } = await stat(path);
    const recorded = recordingBudget();
    const backend = store({ logBudget: recorded.budget });
    await (await backend.open('t1', 'read')).read();
    const resumed = await backend.resume('t1');
    await resumed.stored.close();
    expect(recorded.reads).toEqual([size]);
    expect(recorded.holds).toEqual([size]);
  });
});

describe('續接單檔佈局：往挑中的世代檔續寫', () => {
  it('撕裂的尾巴從 header 行之後截：第一行原樣、讀得懂，追加接在已接受的前綴後面', async () => {
    const headerLine = `${JSON.stringify(header('t1'))}\n`;
    const path = await writeGeneration(
      dir,
      't1',
      CURRENT,
      [],
      `${headerLine}${lines(EVENTS)}{"seq":3,"ti`,
    );
    const warnings: string[] = [];
    const backend = store({ warn: (message) => warnings.push(message) });
    const resumed = await backend.resume('t1');
    expect(resumed.events).toEqual(EVENTS);
    await resumed.stored.append([event(3)]);
    await resumed.stored.close();

    const bytes = await readFile(path, 'utf8');
    expect(bytes).toBe(`${headerLine}${lines([...EVENTS, event(3)])}`);
    expect(warnings.join('\n')).toContain(
      `已截到第 ${Buffer.byteLength(headerLine + lines(EVENTS))} 個位元組`,
    );
    expect(await (await store().open('t1', 'read')).read()).toEqual([...EVENTS, event(3)]);
  });

  it('續接追加之後不建出舊兩檔；再打開讀得到追加的那幾筆', async () => {
    await writeGeneration(dir, 't1', CURRENT, EVENTS);
    const resumed = await store().resume('t1');
    await resumed.stored.append([event(3), event(4)]);
    await resumed.stored.close();
    const legacy = sessionPathsIn(dir, 't1');
    expect(existsSync(legacy.header)).toBe(false);
    expect(existsSync(legacy.log)).toBe(false);
    expect(await (await store().open('t1', 'read')).read()).toEqual([
      ...EVENTS,
      event(3),
      event(4),
    ]);
    expect(await store().list()).toMatchObject({
      unreadable: 0,
      sessions: [{ header: { id: 't1' } }],
    });
  });

  it('世代比這一版舊：拒絕續接（換世代歸 #1594 ③），唯讀打開照樣讀得到', async () => {
    const path = await writeGeneration(dir, 't1', OLDER, EVENTS);
    const before = await readFile(path);
    const backend = store();
    expect(await errorOf(backend.resume('t1'))).toBeInstanceOf(SessionFormatUnsupportedError);
    expect(await readFile(path)).toEqual(before);
    // 拒絕時租約放掉了：同一個後端再續接一次，拿到的仍是同一個拒絕，不是「另一方還握著」。
    expect(await errorOf(backend.resume('t1'))).toBeInstanceOf(SessionFormatUnsupportedError);
    expect(await (await backend.open('t1', 'read')).read()).toEqual(EVENTS);
    expect(existsSync(sessionPathsIn(dir, 't1').header)).toBe(false);
  });
});

describe('探單檔佈局時只有「不在」那幾種錯算不在', () => {
  it('id 長到編出來的目錄名超過單段上限（ENAMETOOLONG）：舊兩檔照舊打開、續接，create 照樣撞名', async () => {
    const id = '中'.repeat(120);
    expect(Buffer.byteLength(sessionDirectoryName(id))).toBeGreaterThan(255);
    await writeTwoFile(dir, id, EVENTS);
    expect(await (await store().open(id, 'read')).read()).toEqual(EVENTS);
    const resumed = await store().resume(id);
    expect(resumed.events).toEqual(EVENTS);
    await resumed.stored.close();
    expect((await store().list()).sessions.map(({ header: h }) => h.id)).toEqual([id]);
    expect(() => store().create(header(id))).toThrow(SessionAlreadyExistsError);
  });

  it('會話目錄名的位置上是個一般檔（ENOTDIR）：舊兩檔照舊打開', async () => {
    await writeTwoFile(dir, 't1', EVENTS);
    await writeFile(join(dir, sessionDirectoryName('t1')), 'not a directory');
    expect(await (await store().open('t1', 'read')).read()).toEqual(EVENTS);
  });

  // root 不受目錄權限限制，擋不出 EACCES。
  it.skipIf(process.getuid?.() === 0)('會話目錄讀不了（EACCES）：照拋，不當成不在', async () => {
    await writeGeneration(dir, 't1', CURRENT, EVENTS);
    await chmod(sessionDir(dir, 't1'), 0o000);
    try {
      for (const attempt of [
        () => store().open('t1', 'read'),
        () => store().resume('t1'),
        () => store().list(),
      ]) {
        const error = await errorOf(attempt());
        expect((error as { code?: unknown }).code).toBe('EACCES');
      }
      expect(() => store().create(header('t1'))).toThrow(
        expect.objectContaining({ code: 'EACCES' }),
      );
    } finally {
      await chmod(sessionDir(dir, 't1'), 0o700);
    }
  });

  it('空 id：不探單檔佈局，舊兩檔照舊建、讀、撞名', async () => {
    await writeTwoFile(dir, '', EVENTS);
    expect(await (await store().open('', 'read')).read()).toEqual(EVENTS);
    expect(() => store().create(header(''))).toThrow(SessionAlreadyExistsError);
  });
});
