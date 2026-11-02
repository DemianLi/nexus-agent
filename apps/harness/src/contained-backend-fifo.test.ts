/**
 * `read`、`edit` 用路徑判完一般檔之後、開檔之前，路徑被換成 FIFO（[#2312](https://github.com/DemianLi/nexus-agent/issues/2312)）：
 * 開檔不卡住，用開好的把手判出不是一般檔，回跟路徑判斷同一句錯誤。換檔用 `beforeReadOpen` 接縫，卡住時這兩條會逾時。
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
