/**
 * `ContainedFilesystemBackend.usePermissions`：經符號連結解開之後的位置，拿 `permissions` 規則再比一次
 * （[#2260](https://github.com/DemianLi/nexus-agent/issues/2260)）。
 *
 * 根裡有被擋的 `/secret/`，另有指向它的檔案連結與目錄連結。被擋的寫入都看磁碟：本尊的內容與連結都不動。
 */

import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilesystemPermission } from 'deepagents';
import { FILE_VERSION } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';

const SECRET = 'SECRET-CONTENT';

/** fold 折出來的形狀：`/secret/**` 擋讀寫，`/secret/public/**` 是它的例外。 */
const RULES: FilesystemPermission[] = [
  { operations: ['read', 'write'], paths: ['/secret/public/**'], mode: 'allow' },
  { operations: ['read', 'write'], paths: ['/secret/**'], mode: 'deny' },
];

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-perm-link-'));
  await mkdir(join(root, 'secret', 'public'), { recursive: true });
  await writeFile(join(root, 'secret', 'key.txt'), SECRET);
  await writeFile(join(root, 'secret', 'public', 'open.txt'), 'OPEN');
  await symlink('secret/key.txt', join(root, 'link.txt'));
  await symlink('secret', join(root, 'door'));
  await symlink('secret/public/open.txt', join(root, 'open-link.txt'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function backend(
  options: { mode?: SandboxMode; rules?: FilesystemPermission[]; routePrefix?: string } = {},
): ContainedFilesystemBackend {
  const contained = new ContainedFilesystemBackend({
    rootDir: root,
    ...(options.mode !== undefined && { mode: options.mode }),
    ...(options.routePrefix !== undefined && { routePrefix: options.routePrefix }),
  });
  contained.usePermissions(options.rules ?? RULES);
  return contained;
}

async function secretUntouched(): Promise<void> {
  expect(await readFile(join(root, 'secret', 'key.txt'), 'utf8')).toBe(SECRET);
  expect((await lstat(join(root, 'link.txt'))).isSymbolicLink()).toBe(true);
}

describe('檔案連結指到被擋的檔', () => {
  it.each<SandboxMode>(['read-only', 'workspace-write', 'danger-full-access'])(
    '%s：read、readRaw 拒絕，版本回不存在',
    async (mode) => {
      const contained = backend({ mode });
      const read = await contained.read('/link.txt');
      expect(read.error).toBe('permission denied for read on /secret/key.txt');
      expect(JSON.stringify(await contained.readRaw('/link.txt'))).not.toContain(SECRET);
      expect((await contained.readRaw('/link.txt')).error).toBe(read.error);
      expect(await contained[FILE_VERSION]('/link.txt')).toEqual({ kind: 'absent' });
    },
  );

  it.each<SandboxMode>(['workspace-write', 'danger-full-access'])(
    '%s：write、edit、delete 拒絕，本尊與連結都不動',
    async (mode) => {
      const contained = backend({ mode });
      expect((await contained.write('/link.txt', '蓋掉')).error).toBe(
        'permission denied for write on /secret/key.txt',
      );
      expect((await contained.edit('/link.txt', SECRET, '改掉')).error).toBe(
        'permission denied for write on /secret/key.txt',
      );
      expect((await contained.delete('/link.txt')).error).toBe(
        'permission denied for write on /secret/key.txt (matches deny rule(s): /secret/**)',
      );
      await secretUntouched();
    },
  );

  it('指到例外裡的檔：讀得到', async () => {
    expect(JSON.stringify((await backend().read('/open-link.txt')).content)).toContain('OPEN');
  });

  it('指到例外裡的一般檔：刪得掉（確定是一般檔才照先命中者決定）', async () => {
    expect((await backend().delete('/open-link.txt')).error).toBeUndefined();
    await expect(readFile(join(root, 'secret', 'public', 'open.txt'))).rejects.toThrow();
  });
});

describe('目錄連結指到被擋的目錄', () => {
  it('底下的檔讀不到、列不出、搜不到', async () => {
    const contained = backend();
    expect((await contained.read('/door/key.txt')).error).toBe(
      'permission denied for read on /secret/key.txt',
    );
    expect((await contained.ls('/door')).error).toBe('permission denied for read on /secret');
    const grep = await contained.grep('SECRET', '/door');
    expect(grep.error).toBe('permission denied for read on /secret');
    expect(JSON.stringify(grep)).not.toContain('key.txt');
  });

  it('經它新建的檔：拒絕，磁碟上沒有多出檔', async () => {
    expect((await backend().write('/door/new.txt', 'x')).error).toBe(
      'permission denied for write on /secret/new.txt',
    );
    await expect(readFile(join(root, 'secret', 'new.txt'))).rejects.toThrow();
  });

  it('例外那一格經目錄連結照樣讀得到', async () => {
    expect(JSON.stringify((await backend().read('/door/public/open.txt')).content)).toContain(
      'OPEN',
    );
  });
});

describe('不比的情況', () => {
  it('沒經連結的路徑不重比：基座的工具已經比過', async () => {
    expect(JSON.stringify((await backend().read('/secret/key.txt')).content)).toContain(SECRET);
  });

  it('沒交規則：經連結照常讀寫', async () => {
    const contained = backend({ rules: [] });
    expect(JSON.stringify((await contained.read('/link.txt')).content)).toContain(SECRET);
    expect((await contained.write('/door/new.txt', 'x')).error).toBeUndefined();
  });
});

describe('掛在路由底下（routePrefix）', () => {
  it('規則比的是接回前綴的路徑', async () => {
    const shared = backend({
      mode: 'read-only',
      routePrefix: '/shared',
      rules: [{ operations: ['read', 'write'], paths: ['/shared/secret/**'], mode: 'deny' }],
    });
    expect((await shared.read('/link.txt')).error).toBe(
      'permission denied for read on /shared/secret/key.txt',
    );
  });

  it('沒有前綴的規則不會誤中路由底下的檔', async () => {
    const shared = backend({ mode: 'read-only', routePrefix: '/shared' });
    expect(JSON.stringify((await shared.read('/link.txt')).content)).toContain(SECRET);
  });
});
