/**
 * JSONL 後端的唯讀那兩條：`list` 與 `open(id, 'read')`（[#665](https://github.com/DemianLi/nexus-agent/issues/665)），
 * 以及給產品路徑外的讀方用的檔名配對、header 解析與會話根的格子列舉。契約見 `@nexus/core` 的 `session-store.ts`。
 *
 * 會話都經後端寫；要壞掉、版本太新的才手寫。
 */

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionFormatUnsupportedError,
  SessionNotFoundError,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import {
  createJsonlSessionStore,
  listSessionStoreDirectories,
  openJsonlSessionStore,
  parseHeader,
  projectKey,
  sessionLogPathOf,
} from './jsonl-session-store.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-store-read-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function header(id: string, extra: Partial<StoredSessionHeader> = {}): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/tmp', ...extra };
}

/** 一筆讀方收得下的事件。內容不重要，後端只驗 `type`／`time`／`seq`。 */
function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

/** 經後端寫一份 `count` 筆的會話然後關掉。 */
async function written(id: string, count = 1, extra: Partial<StoredSessionHeader> = {}) {
  const stored = openJsonlSessionStore({ directory: dir }).create(header(id, extra));
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
    store.create(header('pending'));

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
      // header 原樣：續接那條會把 version 改成這一版，這裡不會。
      expect(reader.header.version).toBe(SESSION_LOG_FORMAT_VERSION - 1);
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

  it('中段壞掉：預設拋；salvage 撿回讀得懂的，撕裂的尾巴兩邊都不算', async () => {
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
    await expect(reader.read()).rejects.toBeInstanceOf(SessionCorruptionError);
    expect((await reader.read({ salvage: true })).map((e) => e.seq)).toEqual([0, 3]);
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

describe('給產品路徑外的讀方：檔名配對與 header 解析', () => {
  it('sessionLogPathOf：header 檔對到本文，其餘是 undefined', () => {
    expect(sessionLogPathOf('/r/cli.header.json')).toBe('/r/cli.jsonl');
    expect(sessionLogPathOf('/r/cli.jsonl')).toBeUndefined();
    expect(sessionLogPathOf('/r/cli.lock')).toBeUndefined();
  });

  it('parseHeader：不給 id 就不比；acceptNewer 照讀比這一版新的；少了 id 或 createdAt 是壞的', () => {
    const text = (value: unknown) => JSON.stringify(value);
    expect(parseHeader(text(header('a'))).id).toBe('a');
    expect(() => parseHeader(text(header('a')), { id: 'b' })).toThrow(SessionCorruptionError);
    const future = text(header('f', { version: SESSION_LOG_FORMAT_VERSION + 1 }));
    expect(() => parseHeader(future)).toThrow(SessionFormatUnsupportedError);
    expect(parseHeader(future, { acceptNewer: true }).version).toBe(SESSION_LOG_FORMAT_VERSION + 1);
    expect(() => parseHeader(text({ version: 1, createdAt: 1 }))).toThrow('header 記的 id');
    expect(() => parseHeader(text({ version: 1, id: 'a' }))).toThrow('沒有 createdAt');
  });
});

describe('listSessionStoreDirectories', () => {
  it('認得 serve 的專案格與 CLI 的 run 目錄，照名字排；其餘略過', async () => {
    const cli = createJsonlSessionStore({ rootDir: dir });
    const stored = cli.create(header('cli'));
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
