/**
 * `@` 引用別的會話的候選（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）。
 *
 * 檔案手寫、不經 serve：這一檔問的是「列出來對不對、排得對不對、快取有沒有失效」；產品路徑上的路由與「不建 thread」在
 * `serve-session-references.test.ts`。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SESSION_LOG_FORMAT_VERSION } from '@nexus/core';
import type { SessionStore } from '@nexus/core';
import { decodeSessionReferenceUri, parseSessionReferenceText } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createJsonlSessionStore,
  openJsonlSessionStore,
  projectKey,
} from './jsonl-session-store.js';
import { SessionReferenceCandidates } from './session-reference-candidates.js';

const CWD = '/專案/甲';
const OTHER = '/專案/乙';
const LIMITS = { maxWords: 5, maxBytes: 40 };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-session-refs-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Draft {
  readonly type: string;
  readonly time: number;
  readonly data: unknown;
}

const said = (text: string, time: number): Draft => ({
  type: 'turn/start',
  time,
  data: { kind: 'message', text },
});

const titled = (title: string, time: number): Draft => ({
  type: 'session/title',
  time,
  data: { title, messageSeqs: [0], source: { kind: 'fallback' } },
});

/**
 * 經 JSONL 後端寫一份到 `<root>/<projectKey(projectCwd)>/`（檔名由後端算，含 `/` 或大寫的 id 也對得上）。
 * 讀不懂的與版本太新的另用 {@link putRaw}。
 */
async function put(
  projectCwd: string,
  id: string,
  options: {
    readonly cwd?: string | null;
    readonly createdAt?: number;
    readonly parentSession?: string;
    readonly events?: readonly Draft[];
    readonly tail?: string;
  } = {},
): Promise<string> {
  const directory = join(root, projectKey(projectCwd));
  const stored = openJsonlSessionStore({ directory }).create({
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: options.createdAt ?? 1_000,
    ...(options.cwd === null ? {} : { cwd: options.cwd ?? projectCwd }),
    ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
  });
  // 一筆都沒寫的會話在檔案系統上沒有足跡、後端不列（#665），所以空的給一筆與標題無關的事件墊底。
  const events = options.events?.length
    ? options.events
    : [{ type: 'model/usage', time: 1, data: {} }];
  await stored.append(
    events.map(
      (event, seq) => ({ type: event.type, seq, time: event.time, data: event.data }) as never,
    ),
  );
  await stored.close();
  if (options.tail !== undefined) {
    const log = (await readdir(directory)).find((name) => name === `${id}.jsonl`);
    if (log === undefined) throw new Error('夾具：撕裂的尾巴只給簡單的 id');
    await writeFile(
      join(directory, log),
      `${await readFile(join(directory, log), 'utf8')}${options.tail}`,
    );
  }
  return directory;
}

/** 手寫一份 header（檔名 = id，id 只給簡單小寫的）：後端寫不出來的壞檔與新版本。 */
async function putRaw(projectCwd: string, id: string, header: unknown): Promise<string> {
  const directory = join(root, projectKey(projectCwd));
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, `${id}.header.json`),
    typeof header === 'string' ? header : JSON.stringify(header),
  );
  return directory;
}

function service(
  extra: Partial<ConstructorParameters<typeof SessionReferenceCandidates>[0]> = {},
): SessionReferenceCandidates {
  return new SessionReferenceCandidates({ rootDir: root, cwd: CWD, title: LIMITS, ...extra });
}

const ids = (candidates: readonly { readonly sessionId: string }[]) =>
  candidates.map(({ sessionId }) => sessionId);

/** 目錄裡每個檔的名字與內容（含子目錄）：唯讀的列前後要一模一樣。 */
async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else out[path] = await readFile(path, 'utf8');
    }
  };
  await walk(root);
  return out;
}

describe('SessionReferenceCandidates.list', () => {
  it('列全部專案的會話含子代理，排除自己；同工作區在前、沒記目錄次之、其餘在後，同等級內新的在前', async () => {
    await put(CWD, 'mine', { events: [said('我自己', 5_000)] });
    await put(CWD, 'same-old', { events: [said('甲舊', 2_000)] });
    await put(CWD, 'same-new', { events: [said('甲新', 4_000)] });
    await put(CWD, 'nocwd', { cwd: null, events: [said('無目錄', 9_000)] });
    await put(OTHER, 'other', { events: [said('乙的', 8_000)] });

    const candidates = await service().list('mine', '');
    expect(ids(candidates)).toEqual(['same-new', 'same-old', 'nocwd', 'other']);
    expect(candidates.map(({ sameWorkspace }) => sameWorkspace)).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(candidates[0]).toMatchObject({
      label: '甲新',
      cwd: CWD,
      createdAt: 1_000,
      updatedAt: 4_000,
    });
    expect(candidates[2]).not.toHaveProperty('cwd');
  });

  it('mention 是伺服器編好的：解得回 id 與標題，標題裡的 ] 與 \\ 有跳脫', async () => {
    await put(CWD, 'x/子代理-1', { events: [titled('查 [a]\\b', 2_000)] });
    const [candidate] = await service().list('me', '');
    expect(candidate?.label).toBe('查 [a]\\b');
    const parsed = parseSessionReferenceText(candidate?.mention ?? '');
    expect(parsed.references).toEqual([{ sessionId: 'x/子代理-1', label: '查 [a]\\b' }]);
    expect(
      decodeSessionReferenceUri(/\((nexus-session:[^)]*)\)/u.exec(candidate?.mention ?? '')![1]!),
    ).toBe('x/子代理-1');
  });

  it('沒有標題就用 id 當標題', async () => {
    await put(CWD, 'bare', { events: [] });
    expect((await service().list('me', ''))[0]).toMatchObject({ sessionId: 'bare', label: 'bare' });
  });

  it('子代理帶它屬於哪條會話：父的標題，父在別格或沒有標題時退回 id；自己的子代理也列', async () => {
    await put(CWD, 'me', { events: [titled('主會話', 1_500)] });
    await put(CWD, 'me/sub', { parentSession: 'me', events: [said('子任務', 2_000)] });
    await put(CWD, 'me/orphan', { parentSession: 'gone', events: [said('孤兒', 1_900)] });
    const candidates = await service().list('me', '');
    expect(candidates.find(({ sessionId }) => sessionId === 'me/sub')).toMatchObject({
      parentSessionId: 'me',
      parentLabel: '主會話',
    });
    expect(candidates.find(({ sessionId }) => sessionId === 'me/orphan')).toMatchObject({
      parentSessionId: 'gone',
      parentLabel: 'gone',
    });
    expect(candidates.find(({ sessionId }) => sessionId === 'me')).toBeUndefined();
  });

  it('比對 id、目錄、標題，不分大小寫；不搜內文', async () => {
    await put(CWD, 'Alpha-1', { events: [said('修 Bug', 2_000)] });
    await put(OTHER, 'beta', { events: [said('別的事', 2_000), said('內文裡有 秘密', 3_000)] });
    const s = service();
    expect(ids(await s.list('me', 'alpha'))).toEqual(['Alpha-1']);
    expect(ids(await s.list('me', 'BUG'))).toEqual(['Alpha-1']);
    expect(ids(await s.list('me', '乙'))).toEqual(['beta']);
    expect(ids(await s.list('me', '秘密'))).toEqual([]);
  });

  it('最多回 limit 筆，預設 50', async () => {
    for (let i = 0; i < 55; i += 1) {
      await put(CWD, `s${String(i).padStart(2, '0')}`, { createdAt: 1_000 + i, events: [] });
    }
    expect(await service().list('me', '')).toHaveLength(50);
    expect(await service({ limit: 3 }).list('me', '')).toHaveLength(3);
  });

  it('CLI 的 run 目錄不列（root id 一律是 cli，指不到唯一的一份）', async () => {
    const cli = createJsonlSessionStore({ rootDir: root });
    const stored = cli.create({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'cli',
      createdAt: 1,
      cwd: CWD,
    });
    await stored.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as never]);
    await stored.close();
    await put(CWD, 'real', { events: [] });
    expect(ids(await service().list('me', ''))).toEqual(['real']);
  });

  it('同一個 id 出現在兩格：專案自己的那一格優先', async () => {
    await put(OTHER, 'dup', { events: [said('乙格的', 2_000)] });
    await put(CWD, 'dup', { events: [said('甲格的', 2_000)] });
    const candidates = await service().list('me', '');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ label: '甲格的', sameWorkspace: true });
  });

  it('header 讀不懂、版本太新的不列；日誌中段壞掉的照列（撿回讀得懂的）', async () => {
    await put(CWD, 'good', { events: [said('好的', 2_000)] });
    await putRaw(CWD, 'broken', '{壞的');
    await putRaw(CWD, 'future', {
      version: SESSION_LOG_FORMAT_VERSION + 1,
      id: 'future',
      createdAt: 1,
      cwd: CWD,
    });
    await put(CWD, 'torn', { events: [said('壞在中間', 2_000)], tail: '{壞掉\n' });
    expect(ids(await service().list('me', '')).sort()).toEqual(['good', 'torn']);
  });

  it('會話根還不存在：空的', async () => {
    expect(await service({ rootDir: join(root, '還沒有') }).list('me', '')).toEqual([]);
  });

  it('中止了就拋它的 reason', async () => {
    await put(CWD, 'a', { events: [] });
    const controller = new AbortController();
    controller.abort(new Error('不要了'));
    await expect(service().list('me', '', controller.signal)).rejects.toThrow('不要了');
  });

  it('唯讀：列一次不改任何一個位元組，別的把手握著寫租約照樣列得出來', async () => {
    await put(CWD, 'held', { events: [said('被握著', 2_000)] });
    const holder = await openJsonlSessionStore({
      directory: join(root, projectKey(CWD)),
    }).resume('held');
    try {
      const before = await snapshot();
      expect(ids(await service().list('me', ''))).toEqual(['held']);
      expect(await snapshot()).toEqual(before);
    } finally {
      await holder.stored.close();
    }
  });
});

describe('標題快取', () => {
  /** 數 `open(id, 'read')` 被叫了幾次。 */
  function counting() {
    const opened: string[] = [];
    const openStore = (directory: string): SessionStore => {
      const inner = openJsonlSessionStore({ directory });
      return {
        ...inner,
        list: inner.list.bind(inner),
        open: (async (id: string, access: 'read') => {
          opened.push(id);
          return inner.open(id, access);
        }) as SessionStore['open'],
      } as SessionStore;
    };
    return { opened, openStore };
  }

  it('revision 沒變就不重讀；本文多了一筆就只重讀那一份', async () => {
    const directory = await put(CWD, 'a', { events: [said('甲', 2_000)] });
    await put(CWD, 'b', { events: [said('乙', 2_000)] });
    const { opened, openStore } = counting();
    const s = service({ openStore });
    await s.list('me', '');
    expect(opened.sort()).toEqual(['a', 'b']);
    opened.length = 0;
    await s.list('me', '甲');
    await s.list('me', '');
    expect(opened).toEqual([]);

    const line = `${JSON.stringify({ type: 'session/title', seq: 1, time: 3_000, data: { title: '改名了', messageSeqs: [0], source: { kind: 'fallback' } } })}\n`;
    const path = join(directory, 'a.jsonl');
    await writeFile(path, `${await readFile(path, 'utf8')}${line}`);
    const candidates = await s.list('me', '改名');
    expect(opened).toEqual(['a']);
    expect(ids(candidates)).toEqual(['a']);
  });

  it('被取消的一趟讀過的不作廢：下一趟接著讀，每一份總共只開一次', async () => {
    for (let i = 0; i < 20; i += 1) {
      await put(CWD, `s${String(i).padStart(2, '0')}`, { events: [said(`第${i}句`, 2_000 + i)] });
    }
    const { opened, openStore } = counting();
    const controller = new AbortController();
    const counted = (directory: string): SessionStore => {
      const store = openStore(directory);
      return {
        ...store,
        list: store.list.bind(store),
        open: (async (id: string, access: 'read') => {
          // 第一份開始讀就取消：一趟只讀到一半。
          if (opened.length === 0) controller.abort(new Error('打了下一個字'));
          return store.open(id, access);
        }) as SessionStore['open'],
      } as SessionStore;
    };
    const s = service({ openStore: counted });
    await expect(s.list('me', '', controller.signal)).rejects.toThrow('打了下一個字');
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.length).toBeLessThan(20);
    const candidates = await s.list('me', '');
    expect(candidates).toHaveLength(20);
    expect(opened.sort()).toEqual([...new Set(opened)].sort());
    expect(opened).toHaveLength(20);
  });

  it('上一趟還在讀的那幾份，下一趟接著等，不重開', async () => {
    for (let i = 0; i < 12; i += 1) {
      await put(CWD, `s${String(i).padStart(2, '0')}`, { events: [said(`第${i}句`, 2_000 + i)] });
    }
    const opened: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const openStore = (directory: string): SessionStore => {
      const inner = openJsonlSessionStore({ directory });
      return {
        ...inner,
        list: inner.list.bind(inner),
        open: (async (id: string, access: 'read') => {
          opened.push(id);
          await gate;
          return inner.open(id, access);
        }) as SessionStore['open'],
      } as SessionStore;
    };
    const s = service({ openStore });
    const first = new AbortController();
    const one = s.list('me', '', first.signal).catch((error: unknown) => error);
    while (opened.length < 8) await new Promise((resolve) => setTimeout(resolve, 1));
    first.abort(new Error('打了下一個字'));
    const two = s.list('me', '');
    // 第二趟起跑、把同樣的幾份也排進去之後才放行。
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    expect(await one).toBeInstanceOf(Error);
    expect(await two).toHaveLength(12);
    expect(opened.sort()).toEqual([...new Set(opened)].sort());
    expect(opened).toHaveLength(12);
  });

  it('日誌壞到撿回來是空的，也照 revision 記下、沒變就不再讀', async () => {
    const directory = await put(CWD, 'torn', { events: [said('好', 2_000)] });
    await writeFile(join(directory, 'torn.jsonl'), '{壞掉\n');
    const { opened, openStore } = counting();
    const s = service({ openStore });
    await s.list('me', '');
    await s.list('me', '');
    expect(opened).toEqual(['torn']);
  });

  it('刪掉的會話從快取與清單裡消失', async () => {
    const directory = await put(CWD, 'gone', { events: [said('要被刪', 2_000)] });
    const s = service();
    expect(ids(await s.list('me', ''))).toEqual(['gone']);
    await rm(join(directory, 'gone.header.json'));
    await rm(join(directory, 'gone.jsonl'));
    expect(await s.list('me', '')).toEqual([]);
  });
});

describe('read：精確讀一條被引用的會話（準備那一半用）', () => {
  it('整份日誌與 header 原樣交回；專案自己的那一格優先，同 id 在兩格時取自己的', async () => {
    await put(OTHER, 'dup', { events: [said('別格的', 2_000)] });
    await put(CWD, 'dup', { events: [said('自己格的', 2_000)] });
    const { header, events } = await service().read('dup');
    expect(header.id).toBe('dup');
    expect(header.cwd).toBe(CWD);
    expect(events.map((event) => (event.data as { text?: string }).text)).toEqual(['自己格的']);
  });

  it('別的專案的也讀得到；子代理那種含 / 的 id 也行', async () => {
    await put(OTHER, 'elsewhere', { events: [said('別處', 2_000)] });
    await put(CWD, 'delegated/tools:abc', { parentSession: 'me' });
    const s = service();
    expect((await s.read('elsewhere')).events).toHaveLength(1);
    expect((await s.read('delegated/tools:abc')).header.parentSession).toBe('me');
  });

  it('沒有這一份：SessionNotFoundError；CLI 的 run 目錄不算', async () => {
    const stored = createJsonlSessionStore({ rootDir: root }).create({
      version: SESSION_LOG_FORMAT_VERSION,
      id: 'cli',
      createdAt: 1,
      cwd: CWD,
    });
    await stored.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as never]);
    await stored.close();
    const s = service();
    await expect(s.read('nobody')).rejects.toMatchObject({ name: 'SessionNotFoundError' });
    await expect(s.read('cli')).rejects.toMatchObject({ name: 'SessionNotFoundError' });
  });

  it('壞的日誌不撿回：拋 SessionCorruptionError（撿回來的殘缺版本不能當成那條會話的樣子）', async () => {
    const directory = await put(CWD, 'torn', { events: [said('好', 2_000), said('二', 3_000)] });
    const lines = (await readFile(join(directory, 'torn.jsonl'), 'utf8')).split('\n');
    await writeFile(
      join(directory, 'torn.jsonl'),
      [lines[0], '{壞掉', ...lines.slice(1)].join('\n'),
    );
    await expect(service().read('torn')).rejects.toMatchObject({ name: 'SessionCorruptionError' });
  });

  it('唯讀：不改任何位元組；已經中止就不開始讀', async () => {
    const directory = await put(CWD, 'held', { events: [said('好', 2_000)] });
    const before = await Promise.all(
      (await readdir(directory))
        .sort()
        .map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
    );
    const controller = new AbortController();
    await service().read('held');
    controller.abort(new Error('不要了'));
    await expect(service().read('held', controller.signal)).rejects.toThrow('不要了');
    const after = await Promise.all(
      (await readdir(directory))
        .sort()
        .map(async (name) => [name, await readFile(join(directory, name), 'utf8')]),
    );
    expect(after).toEqual(before);
  });
});
