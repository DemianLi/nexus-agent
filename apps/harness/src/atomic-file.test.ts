/**
 * home 底下狀態檔的原子寫入（[#1527](https://github.com/DemianLi/nexus-agent/issues/1527)）：`atomic-file.ts` 的三支，
 * 與四個呼叫點（釘選與封存、插件快照、變更紀錄初建、home 密鑰）都經過它們。
 *
 * 照 `jsonl-session-store-materialize.test.ts` 的做法：包一層 `node:fs/promises`，把手也包起來，記下檔案系統呼叫的順序、
 * 在指定的地方注入失敗。斷電本身測不了，這裡只驗呼叫順序與失敗注入。
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 記下的呼叫：`open <路徑> <flags>[ <mode>]`、`write`／`sync`／`close <路徑>`、`rename`／`link <目標>`、`rm <路徑>`。 */
const calls: string[] = [];
/** 原樣的暫存檔路徑（`open … wx` 的那些），驗命名用。 */
const tempPaths: string[] = [];
/** 要拋 EIO 的呼叫（以記下的那一行比對），與實際拋過幾次。 */
const failOn = new Set<string>();
let injected = 0;
let base = '';

/** 路徑換成不隨每次執行變動的標籤：去掉 `base`，暫存檔的隨機段換成 `<tmp>`。 */
function label(path: string): string {
  const rel = relative(base, path) || '.';
  return rel
    .replace(/(^|\/)\.[0-9a-f-]{36}\.tmp$/u, '$1<tmp>')
    .replace(/\.[0-9a-f]{12}\.tmp$/u, '.<tmp>');
}

function eio(call: string): void {
  if (!failOn.has(call)) return;
  injected += 1;
  throw Object.assign(new Error(`EIO: i/o error（注入：${call}）`), { code: 'EIO' });
}

function record(call: string): void {
  calls.push(call);
  eio(call);
}

/** 包住一個把手：記下寫、sync、close，在指定處注入失敗。 */
function wrapHandle(target: FileHandle, path: string): FileHandle {
  const name = label(path);
  return new Proxy(target, {
    get(real, property) {
      if (property === 'writeFile' || property === 'sync' || property === 'close') {
        const verb = property === 'writeFile' ? 'write' : property;
        return async (...args: unknown[]) => {
          if (verb === 'close') {
            calls.push(`close ${name}`);
            return real.close();
          }
          record(`${verb} ${name}`);
          return (real[property] as (...a: unknown[]) => Promise<unknown>).apply(real, args);
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
      // 目錄可能以 'r' 或數字 O_RDONLY（0）開，兩種都要認，不然目錄 fsync 的注入打不到。
      const flagText = flags === 0 ? 'r' : String(flags);
      if (flagText === 'wx') tempPaths.push(p);
      record(
        `open ${label(p)} ${flagText}${typeof mode === 'number' ? ` ${mode.toString(8)}` : ''}`,
      );
      return wrapHandle(await actual.open(p, flags as never, mode as never), p);
    },
    link: async (from: string, to: string) => {
      record(`link ${label(String(to))}`);
      return actual.link(from, to);
    },
    rename: async (from: string, to: string) => {
      record(`rename ${label(String(to))}`);
      return actual.rename(from, to);
    },
    rm: async (path: string, options?: never) => {
      calls.push(`rm ${label(String(path))}`);
      return actual.rm(path, options);
    },
  };
});

const { publishNewFile, syncDirectory, writeAtomic } = await import('./atomic-file.js');
const { ThreadOrganization, THREAD_ORGANIZATION_FILE } = await import('./thread-organization.js');
const { createPluginSnapshotWriter, PLUGIN_SNAPSHOT_FILE_NAME } =
  await import('./plugin-snapshot.js');
const { appendJournalRecord, createJournalFile, PLUGIN_JOURNAL_FILE_NAME } =
  await import('./plugin-journal.js');
const { loadOrCreateBrowserSessionSecret, BROWSER_SESSION_SECRET_FILE } =
  await import('./browser-session-secret.js');

const POSIX = process.platform !== 'win32';

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-atomic-'));
  calls.length = 0;
  tempPaths.length = 0;
  failOn.clear();
  injected = 0;
});

afterEach(async () => {
  failOn.clear();
  await rm(base, { recursive: true, force: true });
});

/** 目錄裡剩下的 `*.tmp`。 */
async function leftovers(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
}

/** `calls` 裡從 `from` 開始的那一段（含），只留檔案系統的動詞。 */
function sliceFrom(from: string): string[] {
  const at = calls.indexOf(from);
  expect(at, `沒有記到 ${from}：\n${calls.join('\n')}`).toBeGreaterThanOrEqual(0);
  return calls.slice(at);
}

describe.runIf(POSIX)('writeAtomic（dsh storage-json atomic.ts:24-40）', () => {
  it('A 順序：暫存檔 wx 0600 → 寫 → sync → close → rename → 開目錄 → sync 目錄 → close', async () => {
    const path = join(base, 'state.json');
    await writeAtomic(path, 'new\n');

    expect(calls).toEqual([
      'open <tmp> wx 600',
      'write <tmp>',
      'sync <tmp>',
      'close <tmp>',
      'rename state.json',
      'open . r',
      'sync .',
      'close .',
    ]);
    expect(await readFile(path, 'utf8')).toBe('new\n');
    expect(await leftovers(base)).toEqual([]);
  });

  it('A 暫存檔與目標同目錄，名字以 . 開頭、.tmp 結尾', async () => {
    const path = join(base, 'state.json');
    await writeAtomic(path, 'x');
    expect(tempPaths).toHaveLength(1);
    const tmp = tempPaths[0] ?? '';
    expect(dirname(tmp)).toBe(dirname(path));
    expect(basename(tmp)).toMatch(/^\.[0-9a-f-]{36}\.tmp$/u);
  });

  it.each([
    ['暫存檔 sync', 'sync <tmp>', 'old\n'],
    ['rename', 'rename state.json', 'old\n'],
    ['目錄 sync', 'sync .', 'new\n'],
  ] as const)('B %s 拋 EIO：拒絕、錯誤原樣、不留暫存檔', async (_name, call, after) => {
    const path = join(base, 'state.json');
    await writeFile(path, 'old\n');
    failOn.add(call);

    const error = await writeAtomic(path, 'new\n').catch((e: unknown) => e);

    expect(injected).toBe(1);
    expect(error).toMatchObject({ code: 'EIO', message: expect.stringContaining(call) });
    expect(await leftovers(base)).toEqual([]);
    // 前兩格還沒 rename，目標逐位元組不變；目錄 sync 失敗時 rename 已經做了。
    expect(await readFile(path, 'utf8')).toBe(after);
  });
});

describe('syncDirectory', () => {
  it('C Windows 直接回：不開目錄', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await syncDirectory(base);
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
    expect(calls).toEqual([]);
  });

  it.runIf(POSIX)('C Windows 上 writeAtomic 照樣成功，只是不開目錄', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const path = join(base, 'state.json');
    try {
      await writeAtomic(path, 'x');
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
    expect(await readFile(path, 'utf8')).toBe('x');
    expect(calls.filter((call) => call.startsWith('open . '))).toEqual([]);
  });

  it.runIf(POSIX)('POSIX 上錯往外拋，不吞', async () => {
    failOn.add('sync .');
    await expect(syncDirectory(base)).rejects.toMatchObject({ code: 'EIO' });
    expect(injected).toBe(1);
  });
});

describe.runIf(POSIX)('publishNewFile（dsh 會話物化 index.ts:1296-1321、:1359-1369）', () => {
  it('D 順序：暫存檔 wx 0600 → 寫 → sync → close → link → sync 目錄 → 刪暫存檔', async () => {
    const path = join(base, 'secret.json');
    await publishNewFile(path, 'k\n');

    expect(calls).toEqual([
      'open secret.json.<tmp> wx 600',
      'write secret.json.<tmp>',
      'sync secret.json.<tmp>',
      'close secret.json.<tmp>',
      'link secret.json',
      'open . r',
      'sync .',
      'close .',
      'rm secret.json.<tmp>',
    ]);
    expect(await readFile(path, 'utf8')).toBe('k\n');
    expect(await leftovers(base)).toEqual([]);
  });

  it('D 目標已在：EEXIST、目標不變、不留暫存檔、不 fsync 目錄', async () => {
    const path = join(base, 'secret.json');
    await writeFile(path, 'first\n');

    const error = await publishNewFile(path, 'second\n').catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path, 'utf8')).toBe('first\n');
    expect(await leftovers(base)).toEqual([]);
    expect(calls).not.toContain('sync .');
  });

  it('D 暫存檔 sync 失敗：拒絕、沒有 link、正式檔不在', async () => {
    const path = join(base, 'secret.json');
    failOn.add('sync secret.json.<tmp>');

    await expect(publishNewFile(path, 'k\n')).rejects.toMatchObject({ code: 'EIO' });

    expect(injected).toBe(1);
    expect(calls.some((call) => call.startsWith('link '))).toBe(false);
    // 暫存檔照 dsh `writeSyncedTempFile` 不刪（隨機名 `.tmp`，讀方不認），所以只斷言正式檔不在。
    expect(await readdir(base)).not.toContain('secret.json');
  });
});

/**
 * 接線紅燈：經過出貨的函式，斷言它真的走到了原子寫入。任何一個呼叫點換回原本的寫法，它那一條要紅。
 */
describe.runIf(POSIX)('E 四個呼叫點都經過原子寫入', () => {
  it('ThreadOrganization：rename 進 thread-organization.json 之後 fsync home 目錄', async () => {
    const home = join(base, 'home');
    const organization = await ThreadOrganization.open(home);
    calls.length = 0;

    await organization.pin('a', async () => true);

    expect(sliceFrom(`rename home/${THREAD_ORGANIZATION_FILE}`)).toEqual([
      `rename home/${THREAD_ORGANIZATION_FILE}`,
      'open home r',
      'sync home',
      'close home',
    ]);
    expect(calls).toContain('open home/<tmp> wx 600');
  });

  it('ThreadOrganization：home 目錄 fsync 失敗時這一次釘選失敗，記憶體不換', async () => {
    const home = join(base, 'home');
    const organization = await ThreadOrganization.open(home);
    failOn.add('sync home');

    await expect(organization.pin('a', async () => true)).rejects.toMatchObject({ code: 'EIO' });

    expect(injected).toBe(1);
    expect(organization.pinnedThreadIds).toEqual([]);
    expect(await leftovers(home)).toEqual([]);
  });

  it('插件快照：rename 進快照檔之後 fsync 它的目錄；暫存檔 wx', async () => {
    const dir = join(base, 'home');
    const path = join(dir, PLUGIN_SNAPSHOT_FILE_NAME);
    const lines: string[] = [];
    const writer = createPluginSnapshotWriter({ path, log: (line) => lines.push(line) });

    await expect(
      writer.publish({
        version: 1,
        generatedAt: '2026-10-18T00:00:00.000Z',
        summary: { same: 0, 'next-thread': 0, restart: 0 },
        rows: [],
      }),
    ).resolves.toBe(true);

    expect(sliceFrom(`rename home/${PLUGIN_SNAPSHOT_FILE_NAME}`)).toEqual([
      `rename home/${PLUGIN_SNAPSHOT_FILE_NAME}`,
      'open home r',
      'sync home',
      'close home',
    ]);
    expect(calls).toContain('open home/<tmp> wx 600');
  });

  it('插件快照：目錄 fsync 失敗回 false、記一行「寫不進或沒落盤」，不拋', async () => {
    const dir = join(base, 'home');
    const path = join(dir, PLUGIN_SNAPSHOT_FILE_NAME);
    const lines: string[] = [];
    const writer = createPluginSnapshotWriter({ path, log: (line) => lines.push(line) });
    failOn.add('sync home');

    await expect(
      writer.publish({
        version: 1,
        generatedAt: '2026-10-18T00:00:00.000Z',
        summary: { same: 0, 'next-thread': 0, restart: 0 },
        rows: [],
      }),
    ).resolves.toBe(false);

    expect(injected).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('寫不進或沒落盤');
    expect(await leftovers(dir)).toEqual([]);
  });

  it('變更紀錄初建：目錄 fsync 拋 EIO 時拒絕，不再靜默成功；不留暫存檔', async () => {
    const dir = join(base, 'home');
    await mkdir(dir, { recursive: true });
    const path = join(dir, PLUGIN_JOURNAL_FILE_NAME);
    failOn.add('sync home');

    await expect(createJournalFile(path, [])).rejects.toMatchObject({ code: 'EIO' });

    expect(injected).toBe(1);
    expect(calls).toContain('open home/<tmp> wx 600');
    expect(await leftovers(dir)).toEqual([]);
  });

  it('變更紀錄初建：rename 失敗不留暫存檔（原本會留）', async () => {
    const dir = join(base, 'home');
    await mkdir(dir, { recursive: true });
    const path = join(dir, PLUGIN_JOURNAL_FILE_NAME);
    failOn.add(`rename home/${PLUGIN_JOURNAL_FILE_NAME}`);

    await expect(createJournalFile(path, [])).rejects.toMatchObject({ code: 'EIO' });

    expect(injected).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });

  it('home 密鑰：暫存檔 sync 在 link 之前，link 之後 fsync home 目錄', async () => {
    const home = join(base, 'home');

    const secret = await loadOrCreateBrowserSessionSecret(home);

    expect(secret.byteLength).toBe(32);
    const tmp = `home/${BROWSER_SESSION_SECRET_FILE}.<tmp>`;
    expect(sliceFrom(`open ${tmp} wx 600`).slice(0, 9)).toEqual([
      `open ${tmp} wx 600`,
      `write ${tmp}`,
      `sync ${tmp}`,
      `close ${tmp}`,
      `link home/${BROWSER_SESSION_SECRET_FILE}`,
      'open home r',
      'sync home',
      'close home',
      `rm ${tmp}`,
    ]);
    expect(await leftovers(home)).toEqual([]);
  });
});

describe.runIf(POSIX)('G 追加路徑刻意不改：目錄 fsync 失敗照舊回報成功', () => {
  it('appendJournalRecord 新建檔時目錄 sync 拋 EIO：回成功，紀錄在檔上', async () => {
    const dir = join(base, 'home');
    const path = join(dir, PLUGIN_JOURNAL_FILE_NAME);
    failOn.add('sync home');

    const written = await appendJournalRecord(
      path,
      {
        actor: { kind: 'serve', effective: 'svc' },
        now: () => new Date('2026-10-18T00:00:00.000Z'),
      },
      () => ({
        op: 'disable',
        id: 'todo',
        name: '@nexus/plugin-todo',
        before: false,
        after: true,
      }),
    );

    expect(injected).toBe(1);
    expect(written?.seq).toBe(1);
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});
