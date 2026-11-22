/**
 * 寫方的世代檔、墓碑與遷移（[#2132](https://github.com/DemianLi/nexus-agent/issues/2132)，#1594 ③）。讀方認佈局見
 * `session-dir-layout-read.test.ts`；發佈順序與失敗注入見 `jsonl-session-store-materialize.test.ts`。
 *
 * 蓋的是：續接時遷移、唯讀不遷；墓碑在而會話目錄不見報讀不懂（含舊路徑 header 版本 ≥ 52 的）；墓碑加比這一版新的世代報不支援；
 * 遷移當下當掉（`pending`）與遷移之後舊兩檔又被寫過（並存）；來源不動、撕裂的尾巴不帶過去。
 */

import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  generationLogFilename,
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  sessionDirectoryName,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  sessionPathsIn,
} from './jsonl-session-store.js';
import type {
  JsonlSessionStoreOptions,
  OpenLogFile,
  StableReadFileSystem,
} from './jsonl-session-store.js';
import { LEGACY_TWO_FILE_FORMAT_VERSION } from './session-files.fixture.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-generation-writer-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const CURRENT = SESSION_LOG_FORMAT_VERSION;

function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: { tag: 'x' } } as unknown as SessionEvent;
}

function header(id: string, version: number): StoredSessionHeader {
  return { version, id, createdAt: 0 } as StoredSessionHeader;
}

function lines(events: readonly SessionEvent[]): string {
  return events.map((e) => `${JSON.stringify(e)}\n`).join('');
}

const EVENTS = [event(0), event(1), event(2)];

/** 手寫一份舊兩檔的會話（v0.5.19 寫的樣子）；`tail` 接在日誌最後（撕裂的半行）。 */
async function writeTwoFile(id: string, events: readonly SessionEvent[], tail = ''): Promise<void> {
  const paths = legacyTwoFilePathsIn(dir, id);
  await writeFile(paths.header, JSON.stringify(header(id, LEGACY_TWO_FILE_FORMAT_VERSION)));
  await writeFile(paths.log, `${lines(events)}${tail}`);
}

/** 手寫一個世代檔：第一行 header 行，之後一行一顆事件。 */
async function writeGeneration(id: string, version: number, events: readonly SessionEvent[]) {
  const sessionDirectory = join(dir, sessionDirectoryName(id));
  await mkdir(sessionDirectory, { recursive: true });
  const path = join(sessionDirectory, generationLogFilename(version));
  await writeFile(
    path,
    `${JSON.stringify({ type: 'session', ...header(id, version) })}\n${lines(events)}`,
  );
  return path;
}

function store(options: JsonlSessionStoreOptions = {}) {
  return openJsonlSessionStore({ directory: dir, warn: () => undefined, ...options });
}

async function resumeAndClose(id: string, options: JsonlSessionStoreOptions = {}) {
  const resumed = await store(options).resume(id);
  await resumed.stored.close();
  return resumed;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error('沒有拋');
}

/** 世代檔的 header 行，解析過。 */
async function headerLineOf(path: string): Promise<Record<string, unknown>> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text.slice(0, text.indexOf('\n'))) as Record<string, unknown>;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('新建的會話', () => {
  it('寫世代檔與墓碑；會話目錄是 0700', async () => {
    const stored = store().create(header('fresh', CURRENT));
    await stored.append([event(0)]);
    await stored.close();
    const paths = sessionPathsIn(dir, 'fresh');
    expect(await headerLineOf(paths.log)).toEqual({ type: 'session', ...header('fresh', CURRENT) });
    expect(JSON.parse(await readFile(paths.tombstone, 'utf8'))).toEqual({
      type: 'session',
      ...header('fresh', CURRENT),
    });
    expect((await stat(paths.sessionDirectory)).mode & 0o777).toBe(0o700);
    // 舊兩檔的日誌不建。
    expect(existsSync(legacyTwoFilePathsIn(dir, 'fresh').log)).toBe(false);
  });
});

describe('續接舊兩檔：遷成這一版的世代', () => {
  it('來源日誌不動、舊 header 換成墓碑、新世代記著來源', async () => {
    await writeTwoFile('t1', EVENTS);
    const legacy = legacyTwoFilePathsIn(dir, 't1');
    const before = await readFile(legacy.log, 'utf8');

    const resumed = await resumeAndClose('t1');
    expect(resumed.events).toEqual(EVENTS);

    const paths = sessionPathsIn(dir, 't1');
    expect(await headerLineOf(paths.log)).toEqual({
      type: 'session',
      ...header('t1', CURRENT),
      migratedFrom: { bytes: before.length, acceptedBytes: before.length, sha256: sha256(before) },
    });
    expect(await readFile(legacy.log, 'utf8')).toBe(before);
    expect(JSON.parse(await readFile(legacy.header, 'utf8'))).toEqual({
      type: 'session',
      ...header('t1', CURRENT),
    });
    // 再接一次讀的是世代檔，不再遷移。
    expect((await resumeAndClose('t1')).events).toEqual(EVENTS);
  });

  it('撕裂的尾巴不帶過去，warn 一行；acceptedBytes 只算完整的行', async () => {
    const torn = '{"type":"model/usage","seq":3';
    await writeTwoFile('torn', EVENTS, torn);
    const warnings: string[] = [];
    const resumed = await resumeAndClose('torn', { warn: (message) => warnings.push(message) });
    expect(resumed.events).toEqual(EVENTS);
    expect(warnings).toHaveLength(1);

    const accepted = lines(EVENTS);
    const generation = await readFile(sessionPathsIn(dir, 'torn').log, 'utf8');
    expect(generation.slice(generation.indexOf('\n') + 1)).toBe(accepted);
    expect((await headerLineOf(sessionPathsIn(dir, 'torn').log))['migratedFrom']).toEqual({
      bytes: accepted.length + torn.length,
      acceptedBytes: accepted.length,
      sha256: sha256(accepted),
    });
  });

  it('唯讀打開與列表照讀舊的，不發佈', async () => {
    await writeTwoFile('ro', EVENTS);
    const legacy = legacyTwoFilePathsIn(dir, 'ro');
    const headerBefore = await readFile(legacy.header, 'utf8');
    expect((await store().list()).sessions.map((s) => s.header.id)).toEqual(['ro']);
    expect(await (await store().open('ro', 'read')).read()).toEqual(EVENTS);
    expect(existsSync(sessionPathsIn(dir, 'ro').sessionDirectory)).toBe(false);
    expect(await readFile(legacy.header, 'utf8')).toBe(headerBefore);
  });

  it('遷移寫暫存檔失敗：來源不動、不留會話目錄裡的檔，之後照樣接得起來', async () => {
    await writeTwoFile('fail', EVENTS);
    const legacy = legacyTwoFilePathsIn(dir, 'fail');
    const headerBefore = await readFile(legacy.header, 'utf8');
    const failing: OpenLogFile = async (path, flags, mode) => {
      if (flags === 'wx') throw Object.assign(new Error('注入的 EIO'), { code: 'EIO' });
      return (await open(path, flags, mode)) as unknown as Awaited<ReturnType<OpenLogFile>>;
    };
    await expect(store({ openLog: failing }).resume('fail')).rejects.toThrow();
    expect(await readFile(legacy.header, 'utf8')).toBe(headerBefore);
    const sessionDirectory = sessionPathsIn(dir, 'fail').sessionDirectory;
    const left = await readdir(sessionDirectory).catch(() => []);
    expect(left.filter((name) => name !== 'session.lock')).toEqual([]);
    expect((await resumeAndClose('fail')).events).toEqual(EVENTS);
  });
});

describe('遷移途中來源被改', () => {
  it('讀完之後舊日誌被追加：不發佈新世代、舊 header 不動', async () => {
    await writeTwoFile('race', EVENTS);
    const legacy = legacyTwoFilePathsIn(dir, 'race');
    const headerBefore = await readFile(legacy.header, 'utf8');
    const fs: StableReadFileSystem = {
      stat: (path: string) => stat(path, { bigint: true }),
      readFile: async (path: string) => {
        const content = await readFile(path);
        if (path === legacy.log) await appendFile(path, lines([event(3)]));
        return content;
      },
    };
    await expect(store({ fs }).resume('race')).rejects.toThrow(/遷移途中被改了/);
    expect(existsSync(sessionPathsIn(dir, 'race').log)).toBe(false);
    expect(await readFile(legacy.header, 'utf8')).toBe(headerBefore);
  });

  it('讀完之後只有舊 header 被改：不發佈新世代', async () => {
    await writeTwoFile('hdr', EVENTS);
    const legacy = legacyTwoFilePathsIn(dir, 'hdr');
    const changed = JSON.stringify({
      ...header('hdr', LEGACY_TWO_FILE_FORMAT_VERSION),
      createdAt: 1,
    });
    const fs: StableReadFileSystem = {
      stat: (path: string) => stat(path, { bigint: true }),
      readFile: async (path: string) => {
        const content = await readFile(path);
        if (path === legacy.log) await writeFile(legacy.header, changed);
        return content;
      },
    };
    await expect(store({ fs }).resume('hdr')).rejects.toThrow(/遷移途中被改了/);
    expect(existsSync(sessionPathsIn(dir, 'hdr').log)).toBe(false);
    expect(await readFile(legacy.header, 'utf8')).toBe(changed);
  });
});

describe('發佈之後開世代檔失敗', () => {
  /** 第一次 `open(世代檔, 'a')` 拋 EMFILE：`link`、目錄 fsync、墓碑都做完了。 */
  function firstAppendOpenFails(): OpenLogFile {
    let left = 1;
    return async (path, flags, mode) => {
      if (flags === 'a' && left > 0) {
        left -= 1;
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
      return (await open(path, flags, mode)) as unknown as Awaited<ReturnType<OpenLogFile>>;
    };
  }

  it('第一批拒絕；同一批重送成功，不撞自己的世代檔、事件不重複', async () => {
    const stored = store({ openLog: firstAppendOpenFails() }).create(header('a1', CURRENT));
    await expect(stored.append([event(0), event(1)])).rejects.toThrow(/EMFILE/);
    await stored.append([event(0), event(1)]);
    await stored.close();
    expect((await resumeAndClose('a1')).events).toEqual([event(0), event(1)]);
  });

  it('重送的批比發佈時長：只寫多出來的', async () => {
    const stored = store({ openLog: firstAppendOpenFails() }).create(header('a2', CURRENT));
    await expect(stored.append([event(0), event(1)])).rejects.toThrow(/EMFILE/);
    await stored.append([event(0), event(1), event(2)]);
    await stored.close();
    expect((await resumeAndClose('a2')).events).toEqual(EVENTS);
  });
});

describe('header 行的形狀', () => {
  async function plantHeaderLine(id: string, fields: Record<string, unknown>): Promise<void> {
    const path = await writeGeneration(id, CURRENT, EVENTS);
    const text = await readFile(path, 'utf8');
    const line = { type: 'session', ...header(id, CURRENT), ...fields };
    await writeFile(path, `${JSON.stringify(line)}${text.slice(text.indexOf('\n'))}`);
  }

  it('type 不是 session：報讀不懂', async () => {
    await plantHeaderLine('t', { type: 'other' });
    expect(await errorOf(store().resume('t'))).toBeInstanceOf(SessionCorruptionError);
  });

  it.each([
    ['鍵不對', { bytes: 1, acceptedBytes: 1 }, /migratedFrom 的鍵/],
    ['不是物件', 1, /migratedFrom 不是一個物件/],
    [
      'acceptedBytes 比 bytes 大',
      { bytes: 1, acceptedBytes: 2, sha256: 'a'.repeat(64) },
      /acceptedBytes/,
    ],
    ['sha256 不對', { bytes: 1, acceptedBytes: 1, sha256: 'xyz' }, /sha256/],
  ])('migratedFrom %s：報讀不懂', async (_name, migratedFrom, message) => {
    await plantHeaderLine('s', { migratedFrom });
    const error = await errorOf(store().resume('s'));
    expect(error).toBeInstanceOf(SessionCorruptionError);
    expect((error as Error).message).toMatch(message);
  });
});

describe('空 id', () => {
  it('新建：目錄名是 ~，續接讀得回來', async () => {
    const stored = store().create(header('', CURRENT));
    await stored.append([event(0)]);
    await stored.close();
    expect(existsSync(join(dir, '~', generationLogFilename(CURRENT)))).toBe(true);
    expect((await resumeAndClose('')).events).toEqual([event(0)]);
  });

  it('既有的舊兩檔：遷進 ~ 之後再續接', async () => {
    await writeTwoFile('', EVENTS);
    const resumed = await store().resume('');
    await resumed.stored.append([event(3)]);
    await resumed.stored.close();
    expect(existsSync(join(dir, '~', generationLogFilename(CURRENT)))).toBe(true);
    expect((await resumeAndClose('')).events).toEqual([...EVENTS, event(3)]);
  });
});

describe('續接比這一版舊的世代', () => {
  it('產生這一版的世代，舊世代檔不動', async () => {
    const older = await writeGeneration('g', LEGACY_TWO_FILE_FORMAT_VERSION, EVENTS);
    const before = await readFile(older, 'utf8');
    expect((await resumeAndClose('g')).events).toEqual(EVENTS);
    expect(await readFile(older, 'utf8')).toBe(before);
    expect((await headerLineOf(sessionPathsIn(dir, 'g').log))['version']).toBe(CURRENT);
  });

  it('舊路徑什麼都沒有：續接補上墓碑（當掉或手寫才有這個樣子），退版時看到的是墓碑', async () => {
    await writeGeneration('m', LEGACY_TWO_FILE_FORMAT_VERSION, EVENTS);
    const { tombstone } = sessionPathsIn(dir, 'm');
    expect(existsSync(tombstone)).toBe(false);
    await resumeAndClose('m');
    expect(JSON.parse(await readFile(tombstone, 'utf8'))).toMatchObject({
      type: 'session',
      id: 'm',
      version: CURRENT,
    });
  });

  it('只讀打開：讀得到，不發佈新世代、不寫墓碑', async () => {
    const older = await writeGeneration('r', LEGACY_TWO_FILE_FORMAT_VERSION, EVENTS);
    const before = await readFile(older, 'utf8');
    expect(await (await store().open('r', 'read')).read()).toEqual(EVENTS);
    const paths = sessionPathsIn(dir, 'r');
    expect(existsSync(paths.log)).toBe(false);
    expect(existsSync(paths.tombstone)).toBe(false);
    expect(await readFile(older, 'utf8')).toBe(before);
  });
});

describe('遷移當下當掉與並存', () => {
  /** 遷完之後把舊 header 寫回去：新世代發佈了、墓碑還沒寫的樣子。 */
  async function crashedBeforeTombstone(id: string): Promise<void> {
    await writeTwoFile(id, EVENTS);
    const legacy = legacyTwoFilePathsIn(dir, id);
    const headerBefore = await readFile(legacy.header, 'utf8');
    await resumeAndClose(id);
    await writeFile(legacy.header, headerBefore);
  }

  it('舊日誌對得上 migratedFrom：讀新世代，下一次寫打開補墓碑', async () => {
    await crashedBeforeTombstone('p');
    expect(await (await store().open('p', 'read')).read()).toEqual(EVENTS);
    expect((await resumeAndClose('p')).events).toEqual(EVENTS);
    expect(JSON.parse(await readFile(legacyTwoFilePathsIn(dir, 'p').header, 'utf8'))).toMatchObject(
      {
        version: CURRENT,
      },
    );
  });

  it('遷移之後舊日誌又被寫過：兩份並存，報讀不懂', async () => {
    await crashedBeforeTombstone('both');
    await writeFile(legacyTwoFilePathsIn(dir, 'both').log, lines([...EVENTS, event(3)]));
    expect(await errorOf(store().open('both', 'read'))).toBeInstanceOf(SessionCorruptionError);
    expect(await errorOf(store().resume('both'))).toBeInstanceOf(SessionCorruptionError);
  });

  it('舊日誌大小沒變、內容被改過：雜湊對不上，同樣是並存', async () => {
    await crashedBeforeTombstone('same-size');
    const log = legacyTwoFilePathsIn(dir, 'same-size').log;
    const text = await readFile(log, 'utf8');
    await writeFile(log, text.replace('"seq":0', '"seq":9'));
    expect(await errorOf(store().open('same-size', 'read'))).toBeInstanceOf(SessionCorruptionError);
  });
});

describe('墓碑', () => {
  it('墓碑在、會話目錄不見了：唯讀與續接都報讀不懂，不當成沒有', async () => {
    const stored = store().create(header('gone', CURRENT));
    await stored.append([event(0)]);
    await stored.close();
    await rm(sessionPathsIn(dir, 'gone').sessionDirectory, { recursive: true });
    // 列表從目錄項認到的是舊路徑那一項：算讀不懂，不是靜靜少一份。
    expect(await store().list()).toEqual({ sessions: [], unreadable: 1 });
    expect(await errorOf(store().open('gone', 'read'))).toBeInstanceOf(SessionCorruptionError);
    expect(await errorOf(store().resume('gone'))).toBeInstanceOf(SessionCorruptionError);
  });

  it('舊路徑的 header 版本 ≥ 52、旁邊沒有會話目錄：報讀不懂', async () => {
    await writeTwoFile('q2', EVENTS);
    await writeFile(legacyTwoFilePathsIn(dir, 'q2').header, JSON.stringify(header('q2', CURRENT)));
    expect(await errorOf(store().open('q2', 'read'))).toBeInstanceOf(SessionCorruptionError);
  });

  it('墓碑加上比這一版新的世代：報不支援', async () => {
    const stored = store().create(header('newer', CURRENT));
    await stored.append([event(0)]);
    await stored.close();
    await rm(sessionPathsIn(dir, 'newer').log);
    await writeGeneration('newer', CURRENT + 1, EVENTS);
    expect(await errorOf(store().open('newer', 'read'))).toBeInstanceOf(
      SessionFormatUnsupportedError,
    );
    expect(await errorOf(store().resume('newer'))).toBeInstanceOf(SessionFormatUnsupportedError);
  });
});
