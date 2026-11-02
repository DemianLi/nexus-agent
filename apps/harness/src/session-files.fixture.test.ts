/**
 * `session-files.fixture.ts` 自己的規矩（#1868 驗收 C）：找得到、只讀那一份、讀不懂的不跳過、半行不算數、版號分兩個、
 * 改 header 不准動版號、寫壞了還原得回來。會話一律用真的後端寫出來，檔名經 `sessionPathsIn`。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import {
  legacyTwoFilePathsIn,
  openJsonlSessionStore,
  sessionPathsIn,
} from './jsonl-session-store.js';
import {
  closedSessionEvents,
  LEGACY_TWO_FILE_FORMAT_VERSION,
  findSession,
  rewriteSessionHeader,
  sessionEvents,
  sessionEventsOf,
  sessionHeaderOf,
  sessionOf,
  sessionsUnder,
} from './session-files.fixture.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-session-files-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function header(id: string): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/tmp' };
}

function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

/** 世代檔的第一行（header 行）。 */
async function firstLine(path: string): Promise<string> {
  return (await readFile(path, 'utf8')).split('\n')[0] ?? '';
}

/** 世代檔第一行以後的部分（含第一個換行）。 */
async function afterFirstLine(path: string): Promise<string> {
  const text = await readFile(path, 'utf8');
  return text.slice(text.indexOf('\n'));
}

/** 用真的後端在 `directory` 寫一份 `count` 筆的會話。 */
async function written(directory: string, id: string, count = 1): Promise<void> {
  await mkdir(directory, { recursive: true });
  const stored = openJsonlSessionStore({ directory }).create(header(id));
  await stored.append(Array.from({ length: count }, (_, seq) => event(seq)));
  await stored.close();
}

describe('找一份', () => {
  it('遞迴照 id 找到那一份；還沒有就是 undefined，sessionOf 則拋', async () => {
    await written(join(root, 'project'), 'alpha/bg-0123456789ab', 2);
    const found = await findSession(root, 'alpha/bg-0123456789ab');
    expect(found).toMatchObject({ id: 'alpha/bg-0123456789ab', directory: join(root, 'project') });
    expect(found!.logPath).toBe(sessionPathsIn(join(root, 'project'), 'alpha/bg-0123456789ab').log);
    expect(await findSession(root, 'beta')).toBeUndefined();
    await expect(sessionOf(root, 'beta')).rejects.toThrow('找不到會話 beta');
  });

  it('只讀那一份：旁邊那份的 header 壞了也找得到', async () => {
    await written(root, 'good');
    await written(root, 'bad');
    await rewriteSessionHeader(root, 'bad', () => '{壞掉');
    expect(await sessionEventsOf(root, 'good')).toHaveLength(1);
  });

  it('兩個目錄有同 id 的：拋，不挑一份', async () => {
    await written(join(root, 'run-1'), 'cli');
    await written(join(root, 'run-2'), 'cli');
    await expect(findSession(root, 'cli')).rejects.toThrow('不只一份會話 cli');
    expect((await sessionOf(join(root, 'run-2'), 'cli')).directory).toBe(join(root, 'run-2'));
  });
});

describe('列舉', () => {
  it('遞迴列出每一份；header 讀不懂的照拋，不跳過', async () => {
    await written(join(root, 'a'), 'one');
    await written(join(root, 'b'), 'two');
    expect((await sessionsUnder(root)).map((session) => session.id).sort()).toEqual(['one', 'two']);

    await rewriteSessionHeader(join(root, 'b'), 'two', () => '{壞掉');
    await expect(sessionsUnder(root)).rejects.toThrow();
  });
});

describe('事件', () => {
  it('完整的行才算；最後一行是半行時旗標是「不完整」', async () => {
    await written(root, 'cli', 2);
    const session = await sessionOf(root, 'cli');
    expect(await sessionEvents(session)).toEqual({ events: [event(0), event(1)], complete: true });

    await appendFile(session.logPath, '{"type":"model/usage","seq":2');
    expect(await sessionEvents(session)).toEqual({ events: [event(0), event(1)], complete: false });
  });

  it('關檔之後才讀的：尾巴是半行就拋，不靜靜丟掉', async () => {
    await written(root, 'cli', 2);
    const session = await sessionOf(root, 'cli');
    expect(await closedSessionEvents(session)).toEqual([event(0), event(1)]);
    expect(await sessionEventsOf(root, 'cli')).toEqual([event(0), event(1)]);

    await appendFile(session.logPath, '{"type":"model/usage","seq":2');
    await expect(closedSessionEvents(session)).rejects.toThrow('最後一行只寫了一半');
    await expect(sessionEventsOf(root, 'cli')).rejects.toThrow('最後一行只寫了一半');
  });

  it('舊兩檔只有 header、日誌還不在：沒有事件，算完整', async () => {
    await mkdir(join(root, 'p'));
    await writeFile(
      legacyTwoFilePathsIn(join(root, 'p'), 'fresh').header,
      JSON.stringify({ ...header('fresh'), version: LEGACY_TWO_FILE_FORMAT_VERSION }),
    );
    expect(await sessionEvents(await sessionOf(root, 'fresh'))).toEqual({
      events: [],
      complete: true,
    });
  });

  it('世代檔只有 header 行：沒有事件，算完整', async () => {
    const stored = openJsonlSessionStore({ directory: root }).create(header('empty'));
    await stored.flush();
    await stored.close();
    expect(await sessionEvents(await sessionOf(root, 'empty'))).toEqual({
      events: [],
      complete: true,
    });
  });
});

describe('header 的兩個版號', () => {
  it('磁碟上是上一版：storedFormatVersion 是上一版，header.version 已經蓋成這一版', async () => {
    // 上一版是舊兩檔的最後一版：手寫一份（讀方認得、續接時遷移的那種）。
    expect(LEGACY_TWO_FILE_FORMAT_VERSION).toBe(SESSION_LOG_FORMAT_VERSION - 1);
    const paths = legacyTwoFilePathsIn(root, 'cli');
    await writeFile(
      paths.header,
      JSON.stringify({ ...header('cli'), version: LEGACY_TWO_FILE_FORMAT_VERSION }),
    );
    await writeFile(paths.log, '');

    const { header: read, storedFormatVersion } = await sessionHeaderOf(root, 'cli');
    expect(storedFormatVersion).toBe(SESSION_LOG_FORMAT_VERSION - 1);
    // 陷阱寫明：比 header.version 的「升版」斷言永遠綠。
    expect(read.version).toBe(SESSION_LOG_FORMAT_VERSION);
    expect(read['cwd']).toBe('/tmp');
  });
});

describe('改 header', () => {
  it('在原始 JSON 上改一格，其餘原樣', async () => {
    await written(root, 'cli');
    await rewriteSessionHeader(root, 'cli', (raw) => ({ ...raw, cwd: '/別的地方' }));
    expect((await sessionHeaderOf(root, 'cli')).header).toMatchObject({
      id: 'cli',
      cwd: '/別的地方',
    });
  });

  it('寫壞了：接縫讀不懂；restore 寫回原文；事件那幾行不動', async () => {
    await written(root, 'cli');
    const path = sessionPathsIn(root, 'cli').log;
    const original = await readFile(path, 'utf8');
    const events = await afterFirstLine(path);
    const restore = await rewriteSessionHeader(root, 'cli', () => '{壞掉');
    expect(await firstLine(path)).toBe('{壞掉');
    expect(await afterFirstLine(path)).toBe(events);
    await expect(sessionOf(root, 'cli')).rejects.toThrow();
    await restore();
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('舊兩檔也改得到：改的是 <base>.header.json', async () => {
    const paths = legacyTwoFilePathsIn(root, 'old');
    await writeFile(
      paths.header,
      JSON.stringify({ ...header('old'), version: LEGACY_TWO_FILE_FORMAT_VERSION }),
    );
    await writeFile(paths.log, '');
    const restore = await rewriteSessionHeader(root, 'old', () => 'null');
    expect(await readFile(paths.header, 'utf8')).toBe('null');
    await restore();
    expect((await sessionHeaderOf(root, 'old')).header.id).toBe('old');
  });

  it('回的字串不是 JSON 物件（null）：當成壞的 header 原樣寫入，restore 寫回原文', async () => {
    await written(root, 'cli');
    const path = sessionPathsIn(root, 'cli').log;
    const original = await readFile(path, 'utf8');
    const restore = await rewriteSessionHeader(root, 'cli', () => 'null');
    expect(await firstLine(path)).toBe('null');
    await restore();
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('原文本身就壞了：拋，edit 不會被呼叫，檔不動', async () => {
    await written(root, 'cli');
    const path = sessionPathsIn(root, 'cli').log;
    await writeFile(path, `{壞掉${await afterFirstLine(path)}`);
    const broken = await readFile(path, 'utf8');
    let called = false;
    await expect(
      rewriteSessionHeader(root, 'cli', (raw) => {
        called = true;
        return raw;
      }),
    ).rejects.toThrow('原本就不是 JSON 物件');
    expect(called).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(broken);
  });

  it('動到 version 就拋，檔不動：回物件、回解得開的字串都一樣', async () => {
    await written(root, 'cli');
    const path = sessionPathsIn(root, 'cli').log;
    const original = await readFile(path, 'utf8');
    const older = SESSION_LOG_FORMAT_VERSION - 1;
    await expect(
      rewriteSessionHeader(root, 'cli', (raw) => ({ ...raw, version: older })),
    ).rejects.toThrow('不改版號');
    await expect(
      rewriteSessionHeader(root, 'cli', (raw) => JSON.stringify({ ...raw, version: older })),
    ).rejects.toThrow('不改版號');
    expect(await readFile(path, 'utf8')).toBe(original);
  });
});
