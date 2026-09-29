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

  it('刪掉的會話從快取與清單裡消失', async () => {
    const directory = await put(CWD, 'gone', { events: [said('要被刪', 2_000)] });
    const s = service();
    expect(ids(await s.list('me', ''))).toEqual(['gone']);
    await rm(join(directory, 'gone.header.json'));
    await rm(join(directory, 'gone.jsonl'));
    expect(await s.list('me', '')).toEqual([]);
  });
});
