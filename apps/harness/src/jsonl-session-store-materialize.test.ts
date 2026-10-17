/**
 * 新會話第一次落盤是原子的（[#1510](https://github.com/DemianLi/nexus-agent/issues/1510)）：header 先寫暫存檔、`fsync`、
 * 用 `link` 發佈、`fsync` 目錄，然後才建日誌。斷電或行程被殺只會有「整份在」或「整份不在」，不會留下半份的
 * header 讓這條 thread 之後每次打開都回「建不起來」。
 *
 * 照 `attachment-alias-atomic.test.ts` 的做法：包一層 `node:fs/promises`，記下檔案系統呼叫的順序、在指定的地方注入失敗。
 * 失敗注入同時掛在舊實作會走的 `writeFile(headerPath)` 與新實作會走的暫存檔把手上，所以這些測試在改動前後都跑得起來——
 * 拿掉這次改動它們要紅，而不是跑不起來。
 */

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SESSION_LOG_FORMAT_VERSION,
  SessionCorruptionError,
  SessionNotFoundError,
} from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

/** 失敗注入。每條測試開頭重設。 */
interface Injection {
  /** header 內容寫到一半拋錯：先寫進一半位元組，再拋。 */
  partialHeaderWrite: boolean;
  /** 第一次 `open(<日誌>, 'wx')` 拋 EMFILE。 */
  logOpenEmfile: boolean;
  /** 第 `nth` 次對會話目錄的 `fsync` 拋 EIO（只拋一次）。 */
  directorySyncEio: { nth: number } | undefined;
  /** 刪暫存檔拋錯。 */
  rmTempFails: boolean;
}

const calls: string[] = [];
let tmpBase = '';
let projectDir = '';
let inject: Injection = {
  partialHeaderWrite: false,
  logOpenEmfile: false,
  directorySyncEio: undefined,
  rmTempFails: false,
};
let projectDirSyncs = 0;
/** 日誌把手被關掉幾次。 */
let logCloses = 0;

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
            if (path === projectDir) {
              projectDirSyncs += 1;
              if (inject.directorySyncEio?.nth === projectDirSyncs) {
                throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
              }
            }
          } else if (path.endsWith('.tmp')) {
            calls.push(`sync ${label(path)}`);
          }
          return real.sync();
        };
      }
      if (property === 'close') {
        return async () => {
          if (path.endsWith('.jsonl')) logCloses += 1;
          return real.close();
        };
      }
      if (property === 'writeFile') {
        return async (data: string, encoding?: BufferEncoding) => {
          if (inject.partialHeaderWrite && path.endsWith('.tmp')) {
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
      if (inject.logOpenEmfile && flags === 'wx' && p.endsWith('.jsonl')) {
        inject.logOpenEmfile = false;
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
    writeFile: async (path: unknown, data: unknown, options?: unknown) => {
      // 舊實作直接寫正式路徑的 header：同一個注入，先寫一半再拋。
      if (inject.partialHeaderWrite && typeof path === 'string' && path.endsWith('.header.json')) {
        const text = String(data);
        await actual.writeFile(path, text.slice(0, Math.floor(text.length / 2)), options as never);
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), {
          code: 'ENOSPC',
        });
      }
      return actual.writeFile(path as never, data as never, options as never);
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
  projectDirSyncs = 0;
  logCloses = 0;
  inject = {
    partialHeaderWrite: false,
    logOpenEmfile: false,
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

describe('header 寫到一半，正式路徑上不留東西', () => {
  it('寫 header 內容途中拋錯：<base>.header.json 不存在、目錄裡沒有殘留暫存檔；同一個把手撤掉注入後重試成功', async () => {
    inject.partialHeaderWrite = true;
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('alpha'));

    await expect(stored.append([event(0)])).rejects.toThrow(/ENOSPC/);

    expect(await exists(join(projectDir, 'alpha.header.json'))).toBe(false);
    expect((await readdir(projectDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // 同一個把手還開著、握著租約：resume 先認得有沒有這份，沒有就是 NotFound，不去撞自己的鎖。
    await expect(store.resume('alpha')).rejects.toThrow(SessionNotFoundError);

    inject.partialHeaderWrite = false;
    await stored.append([event(0)]);
    await stored.close();
    const resumed = await store.resume('alpha');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
  });

  it('先 close() 放掉租約再 resume（對應重啟後 serve 看到的）：是 NotFound，不是 SessionCorruptionError', async () => {
    inject.partialHeaderWrite = true;
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

describe('日誌開不成，重試過得去', () => {
  it('第一次 open(日誌, wx) 拋 EMFILE：第一次 append 拒絕、第二次成功（不撞上自己剛發佈的 header）', async () => {
    inject.logOpenEmfile = true;
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('gamma'));

    await expect(stored.append([event(0)])).rejects.toThrow(/EMFILE/);
    await stored.append([event(0)]);
    await stored.close();

    const resumed = await store.resume('gamma');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
    expect(calls.filter((call) => call.startsWith('link '))).toHaveLength(1);
  });
});

describe('呼叫順序', () => {
  it('父目錄 sync → 根目錄 sync；暫存檔 open → 暫存檔 sync → link → 會話目錄 sync → 刪暫存檔；日誌 open(wx) → 會話目錄 sync；一次 rename 都沒有', async () => {
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('delta'));
    await stored.flush();
    await stored.close();

    expect(calls).toEqual([
      'sync-dir .',
      'sync-dir root',
      'open <p>/delta.header.json.tmp wx',
      'sync <p>/delta.header.json.tmp',
      'link <p>/delta.header.json',
      'sync-dir <p>',
      'rm <p>/delta.header.json.tmp',
      'open <p>/delta.jsonl wx',
      'sync-dir <p>',
    ]);
    expect(calls.some((call) => call.startsWith('rename '))).toBe(false);
  });

  it('成功物化之後，目錄裡沒有 *.tmp', async () => {
    const stored = openJsonlSessionStore({ directory: projectDir }).create(header('epsilon'));
    await stored.append([event(0)]);
    await stored.close();
    expect((await readdir(projectDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await readFile(join(projectDir, 'epsilon.header.json'), 'utf8')).toContain('"epsilon"');
  });
});

describe('目錄 fsync 的錯不吞，也不卡死', () => {
  it('header link 之後那次目錄 sync 拋一次 EIO：第一次 flush 拒絕，第二次成功（不是 EEXIST），resume 讀得回', async () => {
    inject.directorySyncEio = { nth: 1 };
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('zeta'));

    await expect(stored.flush()).rejects.toThrow(/EIO/);
    await stored.flush();
    await stored.append([event(0)]);
    await stored.close();

    expect(calls.filter((call) => call.startsWith('link '))).toHaveLength(1);
    const resumed = await store.resume('zeta');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
  });

  it('日誌 open 之後那次目錄 sync 拋一次 EIO：重試沿用同一個日誌把手，不再 wx 一次；中途 close() 也不洩漏把手', async () => {
    inject.directorySyncEio = { nth: 2 };
    const store = openJsonlSessionStore({ directory: projectDir });
    const stored = store.create(header('eta'));

    await expect(stored.append([event(0)])).rejects.toThrow(/EIO/);
    await stored.append([event(0)]);
    await stored.close();

    expect(calls.filter((call) => call.endsWith('.jsonl wx'))).toHaveLength(1);
    const resumed = await store.resume('eta');
    expect(resumed.events).toHaveLength(1);
    await resumed.stored.close();
  });

  it('目錄 sync 失敗之後直接 close()：不拋', async () => {
    inject.directorySyncEio = { nth: 2 };
    const stored = openJsonlSessionStore({ directory: projectDir }).create(header('theta'));
    await expect(stored.flush()).rejects.toThrow(/EIO/);
    await expect(stored.close()).resolves.toBeUndefined();
    // 開成了、但還沒完成物化的那個日誌把手，close() 要關掉（剛好一次）：不然把手洩漏到行程結束。
    expect(logCloses).toBe(1);
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
