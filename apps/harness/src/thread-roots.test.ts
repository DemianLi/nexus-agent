/**
 * `thread-roots.ts` 的單元：續接分類（檔頭那張表的每一列）、私有根的建法與權限、啟動重疊檢查（四個路徑，兩個方向，各自點名）。
 * 從 `runServe` 起的整條路徑在 `thread-private-root.test.ts`。
 */

import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { StoredSessionHeader } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { ResumeWorkspaceConflictError } from './resume-guards.js';
import {
  assertThreadRootsBaseSeparate,
  createFixedThreadPlacer,
  createThreadPlacer,
  isThreadRootOf,
  resolveThreadRootsBase,
  threadRootDirName,
} from './thread-roots.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join('/var/tmp', prefix));
  temporary.push(dir);
  return dir;
}

const header = (workspaceRoot?: string): StoredSessionHeader =>
  ({ workspaceRoot }) as unknown as StoredSessionHeader;

describe('threadRootDirName / isThreadRootOf', () => {
  it('同一把鑰匙同一個名字，不同鑰匙不同名字；形狀是 thread- 加三十二位十六進位，不是 session-', () => {
    const a = threadRootDirName('dir\0a');
    expect(threadRootDirName('dir\0a')).toBe(a);
    expect(threadRootDirName('dir\0b')).not.toBe(a);
    expect(a).toMatch(/^thread-[0-9a-f]{32}$/u);
    expect(a.startsWith('session-')).toBe(false);
  });

  it('只認基底的直接子目錄，而且名字形狀要對（逐字比，不 realpath）', () => {
    const name = threadRootDirName('k');
    expect(isThreadRootOf('/b', `/b/${name}`)).toBe(true);
    expect(isThreadRootOf('/b', '/b')).toBe(false);
    expect(isThreadRootOf('/b', '/b/other')).toBe(false);
    expect(isThreadRootOf('/b', `/b/${name}/nested`)).toBe(false);
    expect(isThreadRootOf('/b', `/other/${name}`)).toBe(false);
  });

  it('基底寫死在 <home>/thread-roots，在 home 底下（不是 home 本身、不含 home）', () => {
    const base = resolveThreadRootsBase({ NEXUS_AGENT_HOME: '/h' });
    expect(base).toBe('/h/thread-roots');
  });
});

describe('createThreadPlacer：每一列', () => {
  async function setup(persisted = true) {
    const home = await scratch('nexus-roots-unit-home-');
    const shared = await scratch('nexus-roots-unit-ws-');
    const base = join(home, 'thread-roots');
    const place = createThreadPlacer({
      sharedRoot: shared,
      base,
      sessionKeyOf: persisted ? (id) => `k\0${id}` : undefined,
    });
    return { base, shared, place };
  }
  const request = (threadId: string, resumedHeader?: StoredSessionHeader) => ({
    entry: 'serve',
    threadId,
    resumedHeader,
  });

  it('新 thread：配基底底下以鑰匙雜湊命名的目錄，0700，共用區是 --workspace；同一條 thread 兩次拿到同一個', async () => {
    const { base, shared, place } = await setup();
    const first = await place(request('a'));
    expect(first.root).toBe(join(base, threadRootDirName('k\0a')));
    expect(first.sharedRoot).toBe(shared);
    expect((await stat(first.root!)).mode & 0o777).toBe(0o700);
    expect((await stat(base)).mode & 0o777).toBe(0o700);
    // 配完根、header 還沒寫就當掉：確定性命名，下一次落回同一個目錄。
    expect((await place(request('a'))).root).toBe(first.root);
    expect((await place(request('b'))).root).not.toBe(first.root);
  });

  it('沒給 --workspace：沒有根，也不建基底', async () => {
    const home = await scratch('nexus-roots-unit-home-');
    const base = join(home, 'thread-roots');
    const place = createThreadPlacer({ sharedRoot: undefined, base, sessionKeyOf: (id) => id });
    expect(await place(request('a'))).toEqual({ root: undefined });
    await expect(stat(base)).rejects.toThrow();
  });

  it('落盤關掉的新 thread（PM 裁決 (f)）：可寫根明著是 undefined（記憶體），--workspace 照樣唯讀共用，不建基底', async () => {
    const { base, shared, place } = await setup(false);
    expect(await place(request('a'))).toEqual({ root: undefined, sharedRoot: shared });
    await expect(stat(base)).rejects.toThrow();
  });

  it('續接，header 的根就是這一次的 --workspace：舊 thread，可寫根是共用區、沒有共用前綴', async () => {
    const { shared, place } = await setup();
    expect(await place(request('a', header(shared)))).toEqual({ root: shared });
  });

  it('續接，header 沒有那一格（格式 13 以前）：以共用區為可寫根', async () => {
    const { shared, place } = await setup();
    expect(await place(request('a', header(undefined)))).toEqual({ root: shared });
  });

  it('續接，header 的根是基底的直接子目錄：照用，不用 thread id 重算（分叉的子 thread）', async () => {
    const { base, shared, place } = await setup();
    const owner = await place(request('a'));
    const forked = await place(request('forked', header(owner.root)));
    expect(forked).toEqual({ root: owner.root, sharedRoot: shared });
    expect(forked.root).not.toBe(join(base, threadRootDirName('k\0forked')));
  });

  it('續接，其他：拋 ResumeWorkspaceConflictError，訊息指名兩個根', async () => {
    const { base, shared, place } = await setup();
    for (const recorded of [
      '/somewhere/else',
      base,
      join(base, 'someone-else'),
      42 as unknown as string,
    ]) {
      const error = await place(request('a', header(recorded))).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResumeWorkspaceConflictError);
      expect((error as Error).message).toContain(String(recorded));
      expect((error as Error).message).toContain(shared);
    }
  });

  it('續接，header 的根是別的 home 底下的私有根（名字是 thread-<32 hex>）：拒，出路是換回原來的 home，不叫人把它當 --workspace', async () => {
    const { shared, place } = await setup();
    const foreign = `/old-home/thread-roots/${threadRootDirName('k\0someone')}`;
    const error = await place(request('a', header(foreign))).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResumeWorkspaceConflictError);
    const message = (error as Error).message;
    expect(message).toContain(foreign);
    expect(message).toContain(shared);
    expect(message).toContain('換回原來的 home');
    // 反例：一般「換過 --workspace」的出路（用 --workspace <根> 再接）對私有根是洩漏，不能出現。
    expect(message).not.toContain(`用 --workspace ${foreign}`);
    // 對照：不是私有根形狀的，出路維持「用 --workspace <header 的根> 再接」。
    const plain = await place(request('a', header('/somewhere/else'))).catch((e: unknown) => e);
    expect((plain as Error).message).toContain('用 --workspace /somewhere/else 再接');
    expect((plain as Error).message).not.toContain('換回原來的 home');
  });

  it('根已經在但不是私有的（0755）：拒絕使用；是符號連結也拒', async () => {
    const { base, place } = await setup();
    const name = threadRootDirName('k\0loose');
    await mkdir(base, { recursive: true, mode: 0o700 });
    await mkdir(join(base, name), { mode: 0o755 });
    await expect(place(request('loose'))).rejects.toThrow(/群組或其他人有權限/u);

    const target = await scratch('nexus-roots-unit-target-');
    await symlink(target, join(base, threadRootDirName('k\0link')));
    await expect(place(request('link'))).rejects.toThrow(/不是目錄|符號連結/u);
  });
});

describe('createFixedThreadPlacer（測試接縫）：續接守衛逐字比', () => {
  it('header 記的跟函式回的相同放行；不同拋；沒記放行', async () => {
    const place = createFixedThreadPlacer(() => '/x');
    await expect(
      place({ entry: 'serve', threadId: 'a', resumedHeader: header('/x') }),
    ).resolves.toEqual({ root: '/x' });
    await expect(
      place({ entry: 'serve', threadId: 'a', resumedHeader: header() }),
    ).resolves.toEqual({ root: '/x' });
    await expect(
      place({ entry: 'serve', threadId: 'a', resumedHeader: header('/y') }),
    ).rejects.toBeInstanceOf(ResumeWorkspaceConflictError);
  });
});

describe('assertThreadRootsBaseSeparate：四個路徑，兩個方向，各自點名', () => {
  const OTHERS = ['--workspace', '工具結果暫存根', '附件根', '會話日誌目錄'] as const;

  it('互不重疊：照常', async () => {
    const root = await scratch('nexus-roots-overlap-');
    await expect(
      assertThreadRootsBaseSeparate({
        base: join(root, 'base'),
        others: OTHERS.map((label, index) => ({ label, path: join(root, `other-${index}`) })),
      }),
    ).resolves.toBeUndefined();
  });

  it.each(
    OTHERS.flatMap(
      (label) =>
        [
          [label, 'inside'],
          [label, 'same'],
          [label, 'contains'],
        ] as const,
    ),
  )('%s（%s）：重疊就拋，訊息點名是哪一個', async (label, relation) => {
    const root = await scratch('nexus-roots-overlap-');
    const base = join(root, 'a', 'base');
    const path =
      relation === 'inside' ? join(base, 'x') : relation === 'same' ? base : join(root, 'a');
    // 其餘三個放在遠處，確認被點名的是這一個。
    const others = OTHERS.map((name, index) => ({
      label: name,
      path: name === label ? path : join(root, `far-${index}`),
    }));
    await expect(assertThreadRootsBaseSeparate({ base, others })).rejects.toThrow(
      new RegExp(`- ${label}：`, 'u'),
    );
  });

  it('經符號連結指進基底的路徑也算重疊（各自 canonicalize 之後比）', async () => {
    const root = await scratch('nexus-roots-overlap-');
    const base = join(root, 'base');
    await mkdir(base);
    const link = join(root, 'link');
    await symlink(base, link);
    await writeFile(join(root, 'noise'), '', 'utf8');
    await expect(
      assertThreadRootsBaseSeparate({
        base,
        others: [{ label: '會話日誌目錄', path: join(link, 'sessions') }],
      }),
    ).rejects.toThrow(/會話日誌目錄/u);
  });
});
