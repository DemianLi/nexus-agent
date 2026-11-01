/**
 * 指向根內的符號連結（[#2193](https://github.com/DemianLi/nexus-agent/issues/2193)）：`read` 讀得到，`grep`／`glob` 不跟，寫入類維持落在本尊。
 *
 * `canonicalize` 包一層，讓測試在「比完根之後、開檔之前」換掉目標，量得到開的是比過根的那個位置，也量得到 `O_NOFOLLOW` 還在。
 * 目錄都在真的檔案系統上。
 */

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hook = vi.hoisted(() => ({
  afterCanonicalize: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('./canonical-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./canonical-path.js')>();
  return {
    ...actual,
    canonicalize: async (target: string): Promise<string> => {
      const result = await actual.canonicalize(target);
      await hook.afterCanonicalize?.();
      return result;
    },
  };
});

const { ContainedFilesystemBackend } = await import('./contained-backend.js');

const SECRET = '根外的內容';
let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-read-link-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  await mkdir(join(root, 'sub'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), SECRET);
  await writeFile(join(root, 'plain.txt'), 'PLAIN-CONTENT\n');
  await symlink('plain.txt', join(root, 'inner.txt'));
});

afterEach(async () => {
  hook.afterCanonicalize = undefined;
  await rm(base, { recursive: true, force: true });
});

const backend = (mode?: 'read-only' | 'workspace-write' | 'danger-full-access') =>
  new ContainedFilesystemBackend({ rootDir: root, ...(mode === undefined ? {} : { mode }) });

describe('read', () => {
  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)(
    '%s：相對連結讀得到目標的內容',
    async (mode) => {
      const result = await backend(mode).read('/inner.txt');
      expect(result.error).toBeUndefined();
      expect(result.content).toContain('PLAIN-CONTENT');
    },
  );

  it('子目錄裡的 ../ 連結與連到連結的連結都讀得到', async () => {
    await symlink('../plain.txt', join(root, 'sub', 'up.txt'));
    await symlink('sub/up.txt', join(root, 'chain.txt'));
    expect((await backend().read('/sub/up.txt')).content).toContain('PLAIN-CONTENT');
    expect((await backend().read('/chain.txt')).content).toContain('PLAIN-CONTENT');
  });

  it('連到根內目錄：回不存在，不是 ELOOP', async () => {
    await symlink('sub', join(root, 'dir-link'));
    expect(await backend().read('/dir-link')).toEqual({ error: "File '/dir-link' not found" });
  });

  it('往外指的連結照舊拒絕', async () => {
    await symlink(join(outside, 'secret.txt'), join(root, 'away.txt'));
    const result = await backend().read('/away.txt');
    expect(result.error).toContain('經符號連結解析之後落在根之外');
    expect(result.content).toBeUndefined();
  });

  it('懸空連結與連結迴圈都回錯，不讀到東西', async () => {
    await symlink('gone.txt', join(root, 'dangling.txt'));
    await symlink('loop-b', join(root, 'loop-a'));
    await symlink('loop-a', join(root, 'loop-b'));
    expect((await backend().read('/dangling.txt')).error).toContain('ENOENT');
    expect((await backend().read('/loop-a')).error).toContain('ELOOP');
  });

  it('比完根之後目標被換成往外的連結：ELOOP，內容沒出去', async () => {
    hook.afterCanonicalize = async () => {
      hook.afterCanonicalize = undefined;
      await rm(join(root, 'plain.txt'));
      await symlink(join(outside, 'secret.txt'), join(root, 'plain.txt'));
    };
    const result = await backend().read('/inner.txt');
    expect(result.content).toBeUndefined();
    expect(result.error).toContain('ELOOP');
  });

  it('比完根之後連結本身被改指根外：開的仍是比過根的位置', async () => {
    hook.afterCanonicalize = async () => {
      hook.afterCanonicalize = undefined;
      await rm(join(root, 'inner.txt'));
      await symlink(join(outside, 'secret.txt'), join(root, 'inner.txt'));
    };
    const result = await backend().read('/inner.txt');
    expect(result.content).toContain('PLAIN-CONTENT');
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});

describe('其他工具維持原樣', () => {
  it('grep、glob 掃目錄時不跟連結，只有本尊', async () => {
    const found = await backend().grep('PLAIN-CONTENT', '/');
    expect(JSON.stringify(found)).toContain('plain.txt');
    expect(JSON.stringify(found)).not.toContain('inner.txt');
    const listed = await backend().glob('*', '/');
    expect(JSON.stringify(listed)).toContain('plain.txt');
    expect(JSON.stringify(listed)).not.toContain('inner.txt');
  });

  it('write 落在連結的本尊，連結還在', async () => {
    expect(await backend().write('/inner.txt', 'CHANGED')).toMatchObject({ path: '/plain.txt' });
    expect(await readFile(join(root, 'plain.txt'), 'utf8')).toBe('CHANGED');
    expect((await lstat(join(root, 'inner.txt'))).isSymbolicLink()).toBe(true);
  });

  it('edit 落在連結的本尊，連結還在', async () => {
    expect((await backend().edit('/inner.txt', 'PLAIN', 'CHANGED')).error).toBeUndefined();
    expect(await readFile(join(root, 'plain.txt'), 'utf8')).toBe('CHANGED-CONTENT\n');
    expect((await lstat(join(root, 'inner.txt'))).isSymbolicLink()).toBe(true);
  });
});
