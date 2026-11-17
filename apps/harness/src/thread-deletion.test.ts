import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { SESSION_LOG_FORMAT_VERSION, sessionDirectoryName } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendDeletionLog,
  runDeletionStartup,
  DEFAULT_GRACE_DAYS,
  graceMsOfDays,
  planItems,
  readThreadDeletionState,
  THREAD_DELETIONS_FILE,
  THREAD_DELETIONS_LOG_FILE,
  ThreadDeletionError,
  ThreadDeletions,
} from './thread-deletion.js';
import type { ThreadDeletionOptions } from './thread-deletion.js';
import { DEFAULT_THREAD_DELETION_GRACE_DAYS } from './settings/thread-deletion-store.js';
import { openJsonlSessionStore, projectKey, sessionPathsIn } from './jsonl-session-store.js';

const ROOT_ID = 'thread-root';
const CHILD_ID = `${ROOT_ID}/run-1`;
const GRACE_MS = graceMsOfDays(DEFAULT_GRACE_DAYS);

it('設定列的出廠寬限天數與核心的預設一致（兩處各抄一份，這條守住它們不分岔）', () => {
  expect(DEFAULT_THREAD_DELETION_GRACE_DAYS).toBe(DEFAULT_GRACE_DAYS);
});

const OWNER = { kind: 'owner' } as const;
const CWD = '/work/p';
const PROJECT = projectKey(CWD);

let root: string;
let home: string;
let sessionsRoot: string;
let deletedRoot: string;
let projectDir: string;
let clock: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'thread-deletion-'));
  home = join(root, 'home');
  sessionsRoot = join(home, 'sessions');
  deletedRoot = join(home, 'sessions-deleted');
  projectDir = join(sessionsRoot, PROJECT);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  clock = 1_000_000_000_000;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 落一份真的會話（一顆事件、關掉）。`parentSession` 有就是子代理。 */
async function seed(id: string, parentSession?: string): Promise<void> {
  const store = openJsonlSessionStore({ directory: projectDir });
  const stored = store.create({
    version: SESSION_LOG_FORMAT_VERSION,
    id,
    createdAt: 1,
    cwd: CWD,
    ...(parentSession !== undefined && { parentSession }),
  });
  await stored.append([{ type: 'model/usage', seq: 0, time: 1, data: {} } as SessionEvent]);
  await stored.close();
}

/** 一整條：主對話與一個子代理。 */
async function seedThread(): Promise<void> {
  await seed(ROOT_ID);
  await seed(CHILD_ID, ROOT_ID);
}

function options(extra: Partial<ThreadDeletionOptions> = {}): ThreadDeletionOptions {
  return {
    home,
    sessionsRoot,
    deletedRoot,
    graceMs: GRACE_MS,
    now: () => clock,
    ...extra,
  };
}

/** 一個會話在專案格裡的全部項目名：會話目錄與墓碑（每份都有，見 `sessionPathsIn`）。 */
function namesFor(id: string): string[] {
  return [sessionDirectoryName(id), basename(sessionPathsIn(projectDir, id).tombstone)];
}

function deletedDirOf(id: string): string {
  return join(deletedRoot, PROJECT, sessionDirectoryName(id));
}

function originalDirOf(id: string): string {
  return join(projectDir, sessionDirectoryName(id));
}

const logLines = (): string[] =>
  existsSync(join(home, THREAD_DELETIONS_LOG_FILE))
    ? readFileSync(join(home, THREAD_DELETIONS_LOG_FILE), 'utf8').split('\n').filter(Boolean)
    : [];

describe('刪除會話：整條軌跡搬到存放區', () => {
  it('主對話與子代理的日誌都搬走，清單上消失，存放區有、索引有、刪除記錄有一筆', async () => {
    await seedThread();
    const deletions = new ThreadDeletions(options());

    const view = await deletions.delete({
      threadId: ROOT_ID,
      projectKey: PROJECT,
      actor: OWNER,
      title: '測試',
    });

    expect(existsSync(originalDirOf(ROOT_ID))).toBe(false);
    expect(existsSync(originalDirOf(CHILD_ID))).toBe(false);
    expect(existsSync(deletedDirOf(ROOT_ID))).toBe(true);
    expect(existsSync(deletedDirOf(CHILD_ID))).toBe(true);
    expect(await deletions.hiddenReason(PROJECT, ROOT_ID)).toBe('deleted');
    expect(view).toMatchObject({
      threadId: ROOT_ID,
      title: '測試',
      deletedAt: clock,
      expiresAt: clock + GRACE_MS,
    });
    const state = await readThreadDeletionState(join(home, THREAD_DELETIONS_FILE));
    expect(state.intent).toBeNull();
    expect(state.deleted).toHaveLength(1);
    expect(state.deleted[0]?.items.slice().sort()).toEqual(
      [...namesFor(ROOT_ID), ...namesFor(CHILD_ID)].sort(),
    );
    expect(logLines()).toHaveLength(1);
    expect(JSON.parse(logLines()[0] ?? '')).toMatchObject({
      kind: 'delete',
      threadId: ROOT_ID,
      actor: OWNER,
    });
  });

  it('同一條不能刪兩次；沒有的會話說找不到，兩者都不動磁碟', async () => {
    await seedThread();
    const deletions = new ThreadDeletions(options());
    await deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER });
    await expect(
      deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER }),
    ).rejects.toMatchObject({ code: 'already_deleted' });
    const again = new ThreadDeletions(options());
    await expect(
      again.delete({ threadId: 'no-such', projectKey: PROJECT, actor: OWNER }),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(readdirSync(join(deletedRoot, PROJECT)).length).toBeGreaterThan(0);
  });

  it('還在跑的會話：寫入方放手之後才列檔，之後存放區裡的位元組不再變', async () => {
    await seedThread();
    const logFile = sessionPathsIn(projectDir, ROOT_ID).log;
    const deletions = new ThreadDeletions(
      options({
        releaseWriter: async () => {
          // 寫入方在放手之前最後寫的一筆；放手之後列檔，這筆要跟著搬過去。
          writeFileSync(logFile, readFileSync(logFile, 'utf8') + '{"late":true}\n');
        },
      }),
    );
    await deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER });
    const movedLog = sessionPathsIn(join(deletedRoot, PROJECT), ROOT_ID).log;
    const before = readFileSync(movedLog, 'utf8');
    expect(before).toContain('{"late":true}');
    // 搬完之後再碰一次存放區，位元組不變（沒有人在寫它）。
    await new ThreadDeletions(options()).deleted();
    expect(readFileSync(movedLog, 'utf8')).toBe(before);
  });

  it('寫入方放手失敗：什麼都不搬，意圖撤掉，原樣拋出', async () => {
    await seedThread();
    const failure = new Error('寫租約放不掉');
    const deletions = new ThreadDeletions(
      options({ releaseWriter: () => Promise.reject(failure) }),
    );
    await expect(
      deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER }),
    ).rejects.toBe(failure);
    expect(existsSync(originalDirOf(ROOT_ID))).toBe(true);
    expect((await readThreadDeletionState(join(home, THREAD_DELETIONS_FILE))).intent).toBeNull();
  });
});

describe('復原與寬限期', () => {
  it('寬限期內可以搬回原處，索引與清單還原，刪除記錄多一筆復原', async () => {
    await seedThread();
    const deletions = new ThreadDeletions(options());
    await deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER });
    clock += 2 * 86_400_000;
    await deletions.restore({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER });
    expect(existsSync(originalDirOf(ROOT_ID))).toBe(true);
    expect(existsSync(originalDirOf(CHILD_ID))).toBe(true);
    expect(existsSync(deletedDirOf(ROOT_ID))).toBe(false);
    expect(await deletions.hiddenReason(PROJECT, ROOT_ID)).toBeUndefined();
    expect(logLines()).toHaveLength(2);
    expect(JSON.parse(logLines()[1] ?? '')).toMatchObject({ kind: 'restore', threadId: ROOT_ID });
  });

  it('過了寬限期不能復原，檔案留在存放區', async () => {
    await seedThread();
    const deletions = new ThreadDeletions(options());
    await deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER });
    clock += GRACE_MS;
    await expect(
      deletions.restore({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER }),
    ).rejects.toMatchObject({ code: 'expired' });
    expect(existsSync(deletedDirOf(ROOT_ID))).toBe(true);
    expect(existsSync(originalDirOf(ROOT_ID))).toBe(false);
  });

  it('原處已有同名的會話就拒絕，不覆寫', async () => {
    await seedThread();
    const deletions = new ThreadDeletions(options());
    await deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER });
    await seed(ROOT_ID);
    await expect(
      deletions.restore({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(deletedDirOf(ROOT_ID))).toBe(true);
  });

  it('沒有這一筆就拒絕', async () => {
    const deletions = new ThreadDeletions(options());
    await expect(
      deletions.restore({ threadId: 'nope', projectKey: PROJECT, actor: OWNER }),
    ).rejects.toBeInstanceOf(ThreadDeletionError);
  });

  it('寬限天數必須是正數', () => {
    expect(() => graceMsOfDays(0)).toThrow(TypeError);
    expect(() => graceMsOfDays(Number.NaN)).toThrow(TypeError);
  });
});

describe('跨磁碟搬移（EXDEV 退路）', () => {
  it('同磁碟改名失敗回 EXDEV 時，複製、核對、刪來源，結果與原檔逐位元組一致，不留 .partial', async () => {
    await seedThread();
    const before = readFileSync(sessionPathsIn(projectDir, ROOT_ID).log);
    const exdev = (from: string, to: string): Promise<void> => {
      void from;
      void to;
      return Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
    };
    const deletions = new ThreadDeletions(options({ fs: { moveTree: exdev } }));
    await deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER });
    expect(existsSync(originalDirOf(ROOT_ID))).toBe(false);
    expect(readFileSync(sessionPathsIn(join(deletedRoot, PROJECT), ROOT_ID).log)).toEqual(before);
    expect(readdirSync(join(deletedRoot, PROJECT)).some((name) => name.endsWith('.partial'))).toBe(
      false,
    );
  });
});

describe('複製後核對', () => {
  it('副本跟來源大小一樣、內容不同：核對擋下來，來源不刪，不寫索引', async () => {
    await seedThread();
    const sourceFile = sessionPathsIn(projectDir, ROOT_ID).log;
    const before = readFileSync(sourceFile);
    const exdev = (): Promise<void> =>
      Promise.reject(Object.assign(new Error('EXDEV'), { code: 'EXDEV' }));
    const flip = (copied: string): void => {
      if (!copied.endsWith('.jsonl')) return;
      const bytes = readFileSync(copied);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      writeFileSync(copied, bytes);
    };
    const deletions = new ThreadDeletions(
      options({ fs: { moveTree: exdev }, hooks: { afterFileCopy: flip } }),
    );
    await expect(
      deletions.delete({ threadId: ROOT_ID, projectKey: PROJECT, actor: OWNER }),
    ).rejects.toThrow(/複製後核對不符/);
    expect(readFileSync(sourceFile)).toEqual(before);
    expect((await readThreadDeletionState(join(home, THREAD_DELETIONS_FILE))).deleted).toEqual([]);
  });
});

describe('恢復（當機重啟之後）', () => {
  it('意圖停在 releasing：啟動恢復會照當下的檔列出來、搬完、寫索引', async () => {
    await seedThread();
    writeFileSync(
      join(home, THREAD_DELETIONS_FILE),
      JSON.stringify({
        version: 1,
        deleted: [],
        intent: {
          opId: 'op-1',
          kind: 'delete',
          threadId: ROOT_ID,
          projectKey: PROJECT,
          actor: OWNER,
          at: clock,
          stage: 'releasing',
        },
      }),
    );
    const recovered = await new ThreadDeletions(options()).recover();
    expect(recovered?.opId).toBe('op-1');
    expect(existsSync(deletedDirOf(ROOT_ID))).toBe(true);
    expect(existsSync(deletedDirOf(CHILD_ID))).toBe(true);
    const state = await readThreadDeletionState(join(home, THREAD_DELETIONS_FILE));
    expect(state.intent).toBeNull();
    expect(state.deleted.map((r) => r.threadId)).toEqual([ROOT_ID]);
    expect(logLines()).toHaveLength(1);
  });

  it('搬到一半（主對話已到存放區、子代理還在原處）：恢復往前做完，記錄與索引各一筆', async () => {
    await seedThread();
    const items = [...namesFor(ROOT_ID), ...namesFor(CHILD_ID)].sort();
    // 模擬：主對話已經搬過去（目的地完整），子代理還在原處。
    mkdirSync(join(deletedRoot, PROJECT), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, THREAD_DELETIONS_FILE),
      JSON.stringify({
        version: 1,
        deleted: [],
        intent: {
          opId: 'op-2',
          kind: 'delete',
          threadId: ROOT_ID,
          projectKey: PROJECT,
          actor: OWNER,
          at: clock,
          stage: 'moving',
          items,
        },
      }),
    );
    const { renameSync } = await import('node:fs');
    renameSync(originalDirOf(ROOT_ID), deletedDirOf(ROOT_ID));

    await new ThreadDeletions(options()).recover();
    await new ThreadDeletions(options()).recover(); // 第二次什麼都不做
    expect(existsSync(originalDirOf(ROOT_ID))).toBe(false);
    expect(existsSync(originalDirOf(CHILD_ID))).toBe(false);
    expect(existsSync(deletedDirOf(CHILD_ID))).toBe(true);
    const state = await readThreadDeletionState(join(home, THREAD_DELETIONS_FILE));
    expect(state.intent).toBeNull();
    expect(state.deleted).toHaveLength(1);
    expect(logLines()).toHaveLength(1);
  });

  it('刪除記錄：同一個 opId 已經在，就不再附加（含斷電留下的半行）', async () => {
    const path = join(home, THREAD_DELETIONS_LOG_FILE);
    const entry = {
      v: 1 as const,
      opId: 'dup',
      kind: 'delete' as const,
      threadId: 't',
      projectKey: PROJECT,
      at: 1,
      actor: OWNER,
    };
    await appendDeletionLog(path, entry);
    await appendDeletionLog(path, entry);
    expect(logLines()).toHaveLength(1);
    writeFileSync(path, readFileSync(path, 'utf8') + '{"v":1,"opId":"tor');
    await appendDeletionLog(path, { ...entry, opId: 'after-torn' });
    const ids = logLines().flatMap((line) => {
      try {
        return [(JSON.parse(line) as { opId: string }).opId];
      } catch {
        return [];
      }
    });
    expect(ids).toEqual(['dup', 'after-torn']);
  });

  it('狀態檔壞了：拋 state_unreadable，不覆寫', async () => {
    const path = join(home, THREAD_DELETIONS_FILE);
    writeFileSync(path, '{"version":2}');
    await expect(readThreadDeletionState(path)).rejects.toMatchObject({ code: 'state_unreadable' });
    expect(readFileSync(path, 'utf8')).toBe('{"version":2}');
  });
});

describe('改了存放區路徑', () => {
  it('設定不是預設、而預設路徑底下還有檔：回一行警告並附搬移指令；預設底下清空後不再警告', async () => {
    const defaultRoot = join(home, 'sessions-deleted');
    mkdirSync(join(defaultRoot, PROJECT), { recursive: true });
    writeFileSync(join(defaultRoot, PROJECT, 'x'), 'x');
    const custom = join(root, 'custom-store');
    const deletions = new ThreadDeletions(options({ deletedRoot: custom }));
    const warning = await deletions.checkStoreMoved(defaultRoot);
    expect(warning).toContain(defaultRoot);
    expect(warning).toContain(custom);
    expect(warning).toContain('mv ');
    rmSync(join(defaultRoot, PROJECT, 'x'));
    expect(await deletions.checkStoreMoved(defaultRoot)).toBeUndefined();
  });

  it('設定就是預設：底下有檔也不警告', async () => {
    const deletions = new ThreadDeletions(options({ deletedRoot: join(home, 'sessions-deleted') }));
    mkdirSync(join(home, 'sessions-deleted', PROJECT), { recursive: true });
    writeFileSync(join(home, 'sessions-deleted', PROJECT, 'x'), 'x');
    expect(await deletions.checkStoreMoved(join(home, 'sessions-deleted'))).toBeUndefined();
  });
});

describe('啟動層', () => {
  it('啟動先恢復意圖，再看路徑：意圖被完成，警告照出', async () => {
    await seedThread();
    writeFileSync(
      join(home, THREAD_DELETIONS_FILE),
      JSON.stringify({
        version: 1,
        deleted: [],
        intent: {
          opId: 'startup-1',
          kind: 'delete',
          threadId: ROOT_ID,
          projectKey: PROJECT,
          actor: OWNER,
          at: clock,
          stage: 'releasing',
        },
      }),
    );
    const defaultRoot = join(home, 'sessions-deleted');
    mkdirSync(join(defaultRoot, 'other'), { recursive: true });
    writeFileSync(join(defaultRoot, 'other', 'y'), 'y');
    const result = await runDeletionStartup(
      new ThreadDeletions(options({ deletedRoot: join(root, 'custom-store') })),
      defaultRoot,
    );
    expect(result.recovered?.opId).toBe('startup-1');
    expect(existsSync(join(root, 'custom-store', PROJECT, sessionDirectoryName(ROOT_ID)))).toBe(
      true,
    );
    expect(result.warning).toContain('mv ');
  });
});

describe('列出要搬的項目', () => {
  it('子代理遞迴找，不靠目錄名前綴；不在的不列', async () => {
    await seedThread();
    await seed(`${CHILD_ID}/deeper`, CHILD_ID);
    await seed('unrelated');
    const items = await planItems(projectDir, ROOT_ID);
    expect(items.slice().sort()).toEqual(
      [ROOT_ID, CHILD_ID, `${CHILD_ID}/deeper`].flatMap(namesFor).sort(),
    );
  });
});
