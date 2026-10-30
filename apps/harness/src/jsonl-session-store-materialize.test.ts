/**
 * 新會話第一次落盤是原子的（[#1510](https://github.com/DemianLi/nexus-agent/issues/1510)、#1594 ③）：header 行加首批事件
 * 先寫暫存檔、`fsync`、用 `link` 發佈成世代檔、`fsync` 會話目錄，然後才在舊路徑寫墓碑、用 `a` 開世代檔。斷電或行程被殺
 * 只會有「整份在」或「整份不在」，不會留下半份的 header 讓這條 thread 之後每次打開都回「建不起來」。
 *
 * 照 `attachment-alias-atomic.test.ts` 的做法：包一層 `node:fs/promises`，記下檔案系統呼叫的順序、在指定的地方注入失敗。
 */

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  generationLogFilename,
  SESSION_LOCK_FILENAME,
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionNotFoundError,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

/** 失敗注入。每條測試開頭重設。 */
interface Injection {
  /** 暫存檔內容寫到一半拋錯：先寫進一半位元組，再拋。 */
  partialTempWrite: boolean;
  /** 第一次 `open(<世代檔>.tmp, 'wx')` 拋 EMFILE。 */
  tempOpenEmfile: boolean;
  /** 第 `nth` 次對會話目錄（`session`）或專案目錄（`project`）的 `fsync` 拋 EIO（只拋一次）。 */
  directorySyncEio: { readonly dir: 'session' | 'project'; readonly nth: number } | undefined;
  /** 刪暫存檔拋錯。 */
  rmTempFails: boolean;
}

const calls: string[] = [];
let tmpBase = '';
let projectDir = '';
let inject: Injection = {
  partialTempWrite: false,
  tempOpenEmfile: false,
  directorySyncEio: undefined,
  rmTempFails: false,
};
const directorySyncs = { session: 0, project: 0 };

/** 路徑換成不隨每次執行變動的標籤。 */
function label(path: string): string {
  const rel = relative(tmpBase, path) || '.';
  return rel.replace(relative(tmpBase, projectDir), '<p>').replace(/\.[0-9a-f]{12}\.tmp$/u, '.tmp');
}

function isDirectoryOpen(path: string, flags: unknown): boolean {
  return flags === 'r' && !/\.(json|jsonl|lock|tmp)$/u.test(path);
}

/** 包住一個把手：記下 sync、在指定處注入失敗。 */
function wrapHandle(target: FileHandle, path: string, directory: boolean): FileHandle {
  return new Proxy(target, {
    get(real, property) {
      if (property === 'sync') {
        return async () => {
          if (directory) {
            calls.push(`sync-dir ${label(path)}`);
            const dir =
              path === projectDir
                ? 'project'
                : dirname(path) === projectDir
                  ? 'session'
                  : undefined;
            if (dir !== undefined) {
              directorySyncs[dir] += 1;
              if (
                inject.directorySyncEio?.dir === dir &&
                inject.directorySyncEio.nth === directorySyncs[dir]
              ) {
                throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
              }
            }
          } else if (path.endsWith('.tmp')) {
            calls.push(`sync ${label(path)}`);
          }
          return real.sync();
        };
      }
      if (property === 'writeFile') {
        return async (data: string, encoding?: BufferEncoding) => {
          if (inject.partialTempWrite && path.endsWith('.tmp')) {
            await real.writeFile(
              String(data).slice(0, Math.floor(String(data).length / 2)),
              encoding,
            );
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
              code: 'ENOSPC',
            });
          }
          return real.writeFile(data, encoding);
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
      if (inject.tempOpenEmfile && flags === 'wx' && /\.jsonl\.[0-9a-f]{12}\.tmp$/u.test(p)) {
        inject.tempOpenEmfile = false;
        throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      }
      const handle = await actual.open(p, flags as never, mode as never);
      return wrapHandle(handle, p, directory);
    },
    link: async (from: string, to: string) => {
      calls.push(`link ${label(to)}`);
      return actual.link(from, to);
    },
    rm: async (path: string, options?: never) => {
      const p = String(path);
      calls.push(`rm ${label(p)}`);
      if (inject.rmTempFails && p.endsWith('.tmp')) {
        throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      }
      return actual.rm(p, options);
    },
    rename: async (from: string, to: string) => {
      calls.push(`rename ${label(to)}`);
      return actual.rename(from, to);
    },
  };
});

const { openJsonlSessionStore } = await import('./jsonl-session-store.js');

let root: string;

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), 'nexus-materialize-'));
  root = join(tmpBase, 'root');
  projectDir = join(root, 'project');
  calls.length = 0;
  directorySyncs.session = 0;
  directorySyncs.project = 0;
  inject = {
    partialTempWrite: false,
    tempOpenEmfile: false,
    directorySyncEio: undefined,
    rmTempFails: false,
  };
});

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

function header(id: string): StoredSessionHeader {
  return { version: SESSION_LOG_FORMAT_VERSION, id, createdAt: 1, cwd: '/tmp' };
}

function event(seq: number): SessionEvent {
  return { type: 'model/usage', seq, time: 1, data: {} } as unknown as SessionEvent;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const LOG = generationLogFilename(SESSION_LOG_FORMAT_VERSION);

describe('暫存檔寫到一半，正式路徑上不留東西', () => {
  it('寫暫存檔途中拋錯：會話目錄連同鎖檔整個收回、舊路徑沒有墓碑；同一個把手撤掉注入後重試成功', async () => {
    inject.partialTempWrite = true;
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('alpha'));

    await expect(stored.append([event(0)])).rejects.toThrow(/ENOSPC/);

    expect(await readdir(projectDir)).toEqual([]);
    // 同一個把手還開著：resume 先認得有沒有這份，沒有就是 NotFound，不去撞自己的鎖。
    await expect(store.resume('alpha')).rejects.toThrow(SessionNotFoundError);

    inject.partialTempWrite = false;
    await stored.append([event(0)]);
    await stored.close();
    const resumed = await store.resume('alpha');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
  });

  it('先 close() 放掉租約再 resume（對應重啟後 serve 看到的）：是 NotFound，不是 SessionCorruptionError', async () => {
    inject.partialTempWrite = true;
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('beta'));
    await expect(stored.append([event(0)])).rejects.toThrow(/ENOSPC/);
    await stored.close();

    const outcome = store.resume('beta');
    await expect(outcome).rejects.toThrow(SessionNotFoundError);
    await expect(outcome).rejects.not.toThrow(SessionCorruptionError);
    // 側欄不會把它算成讀不出來的壞檔。
    expect((await store.list()).unreadable).toBe(0);
  });
});

describe('暫存檔開不成，重試過得去', () => {
  it('第一次 open(世代檔暫存檔, wx) 拋 EMFILE：第一次 append 拒絕、第二次成功，世代檔只 link 一次', async () => {
    inject.tempOpenEmfile = true;
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('gamma'));

    await expect(stored.append([event(0)])).rejects.toThrow(/EMFILE/);
    await stored.append([event(0)]);
    await stored.close();

    const resumed = await store.resume('gamma');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
    expect(calls.filter((call) => call.startsWith(`link <p>/gamma/`))).toHaveLength(1);
  });
});

describe('呼叫順序', () => {
  it('每層目錄 sync → 世代檔暫存檔 open → sync → link → 會話目錄 sync → 刪暫存檔；墓碑同樣的順序、sync 專案目錄；最後才用 a 開世代檔；一次 rename 都沒有', async () => {
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('delta'));
    await stored.flush();
    await stored.close();

    expect(calls).toEqual([
      'sync-dir .',
      'sync-dir root',
      'sync-dir <p>',
      `open <p>/delta/${LOG}.tmp wx`,
      `sync <p>/delta/${LOG}.tmp`,
      `link <p>/delta/${LOG}`,
      'sync-dir <p>/delta',
      `rm <p>/delta/${LOG}.tmp`,
      'open <p>/delta.header.json.tmp wx',
      'sync <p>/delta.header.json.tmp',
      'link <p>/delta.header.json',
      'sync-dir <p>',
      'rm <p>/delta.header.json.tmp',
      `open <p>/delta/${LOG} a`,
    ]);
    expect(calls.some((call) => call.startsWith('rename '))).toBe(false);
  });

  it('成功物化之後，目錄裡沒有 *.tmp；世代檔第一行是 header 行，舊路徑是同一行的墓碑', async () => {
    const stored = openJsonlSessionStore({ directory: projectDir }).create(header('epsilon'));
    await stored.append([event(0)]);
    await stored.close();
    const session = join(projectDir, 'epsilon');
    expect((await readdir(projectDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await readdir(session)).sort()).toEqual([LOG, SESSION_LOCK_FILENAME].sort());
    const [first] = (await readFile(join(session, LOG), 'utf8')).split('\n');
    expect(JSON.parse(first ?? '')).toMatchObject({ type: 'session', id: 'epsilon' });
    expect(await readFile(join(projectDir, 'epsilon.header.json'), 'utf8')).toBe(
      `${first ?? ''}\n`,
    );
  });
});

describe('目錄 fsync 的錯不吞，也不卡死', () => {
  it('世代檔 link 之後那次會話目錄 sync 拋一次 EIO：第一次 flush 拒絕，第二次成功（不是 EEXIST），resume 讀得回', async () => {
    inject.directorySyncEio = { dir: 'session', nth: 1 };
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('zeta'));

    await expect(stored.flush()).rejects.toThrow(/EIO/);
    await stored.flush();
    await stored.append([event(0)]);
    await stored.close();

    expect(calls.filter((call) => call.startsWith('link <p>/zeta/'))).toHaveLength(1);
    expect(
      (await readdir(join(projectDir, 'zeta'))).filter((name) => name.endsWith('.tmp')),
    ).toEqual([]);
    const resumed = await store.resume('zeta');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
  });

  it('墓碑 link 之後那次專案目錄 sync 拋一次 EIO：重試不再發佈世代檔，也不撞上自己的墓碑', async () => {
    // 專案目錄第一次 sync 是建會話目錄那一層，第二次是墓碑之後。
    inject.directorySyncEio = { dir: 'project', nth: 2 };
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('eta'));

    await expect(stored.append([event(0)])).rejects.toThrow(/EIO/);
    await stored.append([event(0)]);
    await stored.close();

    expect(calls.filter((call) => call.startsWith('link <p>/eta/'))).toHaveLength(1);
    expect((await readdir(projectDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    const resumed = await store.resume('eta');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
  });

  it('世代檔發佈之後目錄 sync 失敗、直接 close()：不拋；世代檔留著不撤，下一次續接補上墓碑', async () => {
    inject.directorySyncEio = { dir: 'session', nth: 1 };
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('theta'));
    await expect(stored.flush()).rejects.toThrow(/EIO/);
    await expect(stored.close()).resolves.toBeUndefined();

    expect(await exists(join(projectDir, 'theta', LOG))).toBe(true);
    expect(await exists(join(projectDir, 'theta.header.json'))).toBe(false);
    const resumed = await store.resume('theta');
    expect(resumed.events).toEqual([]);
    await resumed.stored.close();
    expect(await exists(join(projectDir, 'theta.header.json'))).toBe(true);
  });
});

describe('暫存檔清理失敗不讓寫入失敗', () => {
  it('發佈後 rm(暫存檔) 拋錯：append 照樣成功，resume 讀得回', async () => {
    inject.rmTempFails = true;
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('iota'));

    await stored.append([event(0)]);
    await stored.close();

    const resumed = await store.resume('iota');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
  });
});
