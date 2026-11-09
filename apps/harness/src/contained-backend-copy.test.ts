/**
 * `ContainedFilesystemBackend` 的複製兩半（`[COPY_SOURCE]`、`[COPY_INTO]`，經 `copyFileOf`，[#2289](https://github.com/DemianLi/nexus-agent/issues/2289)）：照位元組複製到還不存在的路徑。
 *
 * 驗內容逐位元組相同（非 UTF-8、二進位、CRLF 與結尾換行）、目的地已存在就拒且不動它（含符號連結、暫存期間才出現的）、
 * 來源與目的地各自過讀取面與寫入面的圍堵。每一條都看磁碟，不只看回傳值。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COPY_INTO, COPY_SOURCE, copyFileOf } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AtomicWriteInternals } from './atomic-workspace-write.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import type { SandboxMode } from './contained-backend.js';

let base: string;
let root: string;
let outside: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-copy-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  await mkdir(root);
  await mkdir(outside);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 結果攤平成一個物件，斷言好寫。 */
type Flat = { path?: string; bytes?: number; sha256?: string; error?: string; exists?: true };

/** 同一個 backend 裡從 `from` 複製到 `to`，走產品那一支 `copyFileOf`；關不掉來源就讓測試失敗。 */
async function copyWithin(
  backend: ContainedFilesystemBackend,
  from: string,
  to: string,
): Promise<Flat> {
  return copyFileOf(backend, from, to, (error) => {
    throw error;
  });
}

function contained(
  mode?: SandboxMode,
  atomicInternals?: AtomicWriteInternals,
): { copy(from: string, to: string): Promise<Flat> } {
  const backend = new ContainedFilesystemBackend({
    rootDir: root,
    ...(mode !== undefined && { mode }),
    ...(atomicInternals !== undefined && { atomicInternals }),
  });
  return { copy: (from, to) => copyWithin(backend, from, to) };
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 目錄裡有沒有暫存目錄殘留。 */
async function stagingLeft(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.endsWith('.tmpdir'));
}

describe('ContainedFilesystemBackend 複製：內容', () => {
  it.each([
    ['Big5（不是合法 UTF-8）', Buffer.from([0x61, 0xb4, 0xfa, 0x0a])],
    [
      'png 開頭（含 NUL）',
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    ],
    ['CRLF 與結尾換行', Buffer.from('甲\r\n  乙\t1\n丙\n', 'utf8')],
    ['空檔', Buffer.alloc(0)],
  ])('%s：逐位元組相同', async (_label, bytes) => {
    await writeFile(join(root, 'src.bin'), bytes);
    const result = await contained().copy('/src.bin', '/dst.bin');
    expect(result).toEqual({ path: '/dst.bin', bytes: bytes.length, sha256: sha256Of(bytes) });
    expect(await readFile(join(root, 'dst.bin'))).toEqual(bytes);
    expect(await readFile(join(root, 'src.bin'))).toEqual(bytes);
    expect(await stagingLeft(root)).toEqual([]);
  });

  it('目的地的父目錄不存在就建', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    expect((await contained().copy('/a.txt', '/deep/er/b.txt')).path).toBe('/deep/er/b.txt');
    expect(await readFile(join(root, 'deep', 'er', 'b.txt'), 'utf8')).toBe('x');
  });
});

describe('ContainedFilesystemBackend 複製：目的地已存在', () => {
  it('一般檔：拒絕，原檔不動', async () => {
    await writeFile(join(root, 'a.txt'), '新');
    await writeFile(join(root, 'b.txt'), '舊');
    const result = await contained().copy('/a.txt', '/b.txt');
    expect(result).toEqual({
      error: 'Cannot copy to /b.txt because it already exists',
      exists: true,
    });
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('舊');
    expect(await stagingLeft(root)).toEqual([]);
  });

  it('指到根外的符號連結：拒絕，連結與它指的檔都不動', async () => {
    await writeFile(join(root, 'a.txt'), '新');
    await writeFile(join(outside, 'secret.txt'), '舊');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const result = await contained('danger-full-access').copy('/a.txt', '/link.txt');
    expect(result.exists).toBe(true);
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('舊');
  });

  it('鎖外在暫存期間建出來的：發佈時拒絕，那一份保得住', async () => {
    await writeFile(join(root, 'a.txt'), '新');
    const result = await contained(undefined, {
      afterWrite: async () => {
        await writeFile(join(root, 'b.txt'), '同時建的');
      },
    }).copy('/a.txt', '/b.txt');
    expect(result.exists).toBe(true);
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('同時建的');
    expect(await stagingLeft(root)).toEqual([]);
  });
});

describe('ContainedFilesystemBackend 複製：來源', () => {
  it('不存在：回錯誤，不建目的地', async () => {
    const result = await contained().copy('/nope.txt', '/b.txt');
    expect(result.error).toMatch(/^Error copying '\/nope\.txt': ENOENT/u);
    expect(result.error).not.toContain(root);
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow();
  });

  it('是目錄：拒絕', async () => {
    await mkdir(join(root, 'dir'));
    expect(await contained().copy('/dir', '/b.txt')).toEqual({
      error: "Error copying '/dir': not a regular file",
    });
  });

  it('過了圍堵、開檔之前被換成 FIFO：開檔不卡住、判出不是一般檔，不建目的地', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    const result = await contained(undefined, {
      beforeCopyOpen: async (path) => {
        await rm(path);
        execFileSync('mkfifo', [path]);
      },
    }).copy('/a.txt', '/b.txt');
    expect(result).toEqual({ error: "Error copying '/a.txt': not a regular file" });
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow();
  });

  it('經符號連結落在根外：讀取面的圍堵拒絕，不建目的地', async () => {
    await writeFile(join(outside, 'secret.txt'), 'key');
    await symlink(join(outside, 'secret.txt'), join(root, 'leak.txt'));
    const result = await contained().copy('/leak.txt', '/b.txt');
    expect(result.error).toMatch(/^\[containment\] 拒絕 copy "\/leak\.txt"/u);
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow();
  });
});

describe('ContainedFilesystemBackend 複製：目的地的 fence', () => {
  it('read-only：拒絕，訊息同 write 的形狀', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    const result = await contained('read-only').copy('/a.txt', '/b.txt');
    expect(result.error).toBe(
      '[containment] 拒絕 copy "/b.txt"：這個 backend 是唯讀的（mode: read-only）',
    );
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow();
  });

  it('經符號連結的父目錄落在根外：拒絕', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    await symlink(outside, join(root, 'out'));
    const result = await contained().copy('/a.txt', '/out/b.txt');
    expect(result.error).toMatch(/經符號連結解析之後落在可寫根之外/u);
    await expect(readFile(join(outside, 'b.txt'))).rejects.toThrow();
  });
});

describe('ContainedFilesystemBackend 複製：發佈前核對', () => {
  it.each([
    ['位元組數不同', (temp: string) => appendFile(temp, 'extra')],
    ['位元組數相同、內容不同', (temp: string) => writeFile(temp, 'abcX')],
  ])('暫存檔跟讀到的來源對不上（%s）：不發佈，目的地沒出現過', async (_label, corrupt) => {
    await writeFile(join(root, 'a.txt'), 'abcd');
    const result = await contained(undefined, {
      afterWrite: ({ tempPath }) => corrupt(tempPath),
    }).copy('/a.txt', '/b.txt');
    expect(result.error).toMatch(/^Error copying to '\/b\.txt': copy does not match the source/u);
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow();
    expect(await stagingLeft(root)).toEqual([]);
  });

  it('來源在開檔之後變長：不發佈，目的地沒出現過', async () => {
    await writeFile(join(root, 'a.txt'), '開檔時的內容');
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    const request = { from: '/a.txt', to: '/b.txt' };
    const source = await backend[COPY_SOURCE]('/a.txt', request);
    if ('error' in source) throw new Error(source.error);
    try {
      await appendFile(join(root, 'a.txt'), '之後才寫進來的');
      const result: Flat = await backend[COPY_INTO]('/b.txt', source, request);
      expect(result.error).toMatch(/^Error copying to '\/b\.txt': source changed while copying/u);
    } finally {
      await source.close();
    }
    await expect(readFile(join(root, 'b.txt'))).rejects.toThrow();
    expect(await stagingLeft(root)).toEqual([]);
  });
});

describe('ContainedFilesystemBackend 複製：permissions 規則比模型給的路徑', () => {
  function ruled(): ContainedFilesystemBackend {
    const backend = new ContainedFilesystemBackend({ rootDir: root });
    backend.usePermissions([
      { operations: ['read', 'write'], paths: ['/secret/**'], mode: 'deny' },
    ]);
    return backend;
  }

  it('來源被擋：不開檔、不建目的地', async () => {
    await mkdir(join(root, 'secret'));
    await writeFile(join(root, 'secret', 'key.txt'), 'KEY');
    const result = await copyWithin(ruled(), '/secret/key.txt', '/out.txt');
    expect(result).toEqual({ error: 'permission denied for read on /secret/key.txt' });
    await expect(readFile(join(root, 'out.txt'))).rejects.toThrow();
  });

  it('來源經檔案連結指到被擋的檔（#2260 那道重比）：拒絕，不建目的地', async () => {
    await mkdir(join(root, 'secret'));
    await writeFile(join(root, 'secret', 'key.txt'), 'KEY');
    await symlink('secret/key.txt', join(root, 'link.txt'));
    const result = await copyWithin(ruled(), '/link.txt', '/out.txt');
    expect(result.error).toBe('permission denied for read on /secret/key.txt');
    await expect(readFile(join(root, 'out.txt'))).rejects.toThrow();
  });

  it('目的地經目錄連結落在被擋的地方（#2260 那道重比）：拒絕，磁碟上沒有多出檔', async () => {
    await mkdir(join(root, 'secret'));
    await symlink('secret', join(root, 'door'));
    await writeFile(join(root, 'a.txt'), 'x');
    const result = await copyWithin(ruled(), '/a.txt', '/door/new.txt');
    expect(result.error).toBe('permission denied for write on /secret/new.txt');
    await expect(readFile(join(root, 'secret', 'new.txt'))).rejects.toThrow();
  });

  it('目的地被擋：不建檔', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    const result = await copyWithin(ruled(), '/a.txt', '/secret/new.txt');
    expect(result).toEqual({ error: 'permission denied for write on /secret/new.txt' });
    await expect(readFile(join(root, 'secret', 'new.txt'))).rejects.toThrow();
  });
});
