/**
 * `read`、`edit`、`readRaw` 用路徑判完一般檔之後、開檔之前，路徑被換成 FIFO（[#2312](https://github.com/DemianLi/nexus-agent/issues/2312)、
 * [#2322](https://github.com/DemianLi/nexus-agent/issues/2322)）：開檔不卡住，用開好的把手判出不是一般檔，回跟路徑判斷同一句錯誤。
 * 換檔用 `beforeReadOpen` 接縫。`downloadFiles` 不先用路徑判一般檔，所以直接拿一個本來就是 FIFO 的檔來讀。卡住時這幾條會逾時。
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FilesystemBackend } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NON_TEXT_EXTENSIONS } from './binary-read.js';
import { ContainedFilesystemBackend } from './contained-backend.js';

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'nexus-fifo-'));
  root = join(base, 'root');
  await mkdir(root);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

/** 開檔之前把 `path` 換成 FIFO 的 backend。 */
function swapsToFifo(): ContainedFilesystemBackend {
  return new ContainedFilesystemBackend({
    rootDir: root,
    mode: 'workspace-write',
    atomicInternals: {
      beforeReadOpen: async (path) => {
        await rm(path);
        execFileSync('mkfifo', [path]);
      },
    },
  });
}

describe('ContainedFilesystemBackend：判完一般檔、開檔之前被換成 FIFO', () => {
  it('read：不卡住，回 not found', async () => {
    await writeFile(join(root, 'a.txt'), 'x\n');
    expect(await swapsToFifo().read('/a.txt')).toEqual({ error: "File '/a.txt' not found" });
    expect((await stat(join(root, 'a.txt'))).isFIFO()).toBe(true);
  });

  it('edit：不卡住，回 not found，不寫回', async () => {
    await writeFile(join(root, 'a.txt'), 'old\n');
    expect(await swapsToFifo().edit('/a.txt', 'old', 'new')).toEqual({
      error: "Error: File '/a.txt' not found",
    });
    expect((await stat(join(root, 'a.txt'))).isFIFO()).toBe(true);
  });

  it('readRaw：不卡住，回 not found', async () => {
    await writeFile(join(root, 'a.txt'), 'x\n');
    expect(await swapsToFifo().readRaw('/a.txt')).toEqual({ error: "File '/a.txt' not found" });
    expect((await stat(join(root, 'a.txt'))).isFIFO()).toBe(true);
  });
});

describe('ContainedFilesystemBackend.downloadFiles：不是一般檔', () => {
  const backend = (): ContainedFilesystemBackend =>
    new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });

  it('FIFO：不卡住，回 file_not_found；同一批的其他檔照讀', async () => {
    execFileSync('mkfifo', [join(root, 'pipe')]);
    await writeFile(join(root, 'a.txt'), 'x\n');
    const results = await backend().downloadFiles(['/pipe', '/a.txt']);
    expect(results[0]).toEqual({ path: '/pipe', content: null, error: 'file_not_found' });
    expect(results[1]?.error).toBeNull();
    expect(Buffer.from(results[1]?.content ?? []).toString()).toBe('x\n');
  });

  it('目錄回 is_directory、不存在回 file_not_found，同基座', async () => {
    await mkdir(join(root, 'dir'));
    const base = new FilesystemBackend({ rootDir: root, virtualMode: true });
    const paths = ['/dir', '/missing.txt'];
    expect(await backend().downloadFiles(paths)).toEqual(await base.downloadFiles(paths));
    expect((await backend().downloadFiles(paths)).map((result) => result.error)).toEqual([
      'is_directory',
      'file_not_found',
    ]);
  });
});

describe('ContainedFilesystemBackend.readRaw：一般檔的結果同基座', () => {
  const names = [
    ...[...NON_TEXT_EXTENSIONS].map((extension) => `f${extension}`),
    'F.PNG',
    'f.txt',
    'f.md',
    'f.json',
    'f.svg',
    'noext',
  ];

  it.each(names)('%s', async (name) => {
    await writeFile(join(root, name), Buffer.from([0x68, 0x69, 0x0a, 0xe4, 0xb8, 0xad]));
    const ours = await new ContainedFilesystemBackend({
      rootDir: root,
      mode: 'workspace-write',
    }).readRaw(`/${name}`);
    const base = await new FilesystemBackend({ rootDir: root, virtualMode: true }).readRaw(
      `/${name}`,
    );
    expect(ours).toEqual(base);
    expect(ours).toHaveProperty('data.mimeType');
  });

  it('不存在：拋的錯同基座', async () => {
    const ours = new ContainedFilesystemBackend({ rootDir: root, mode: 'workspace-write' });
    const base = new FilesystemBackend({ rootDir: root, virtualMode: true });
    const error = await base.readRaw('/missing.txt').catch((caught: unknown) => caught);
    await expect(ours.readRaw('/missing.txt')).rejects.toThrow((error as Error).message);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOENT');
  });
});
