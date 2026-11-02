/**
 * `copy_file` 的工具本體與註冊（[#2289](https://github.com/DemianLi/nexus-agent/issues/2289)）：模型看到的結果句、已存在時的指引，
 * 以及 `tool-fs` 的 `write: false` 連它一起關。backend 層的行為（照位元組、核對、圍堵）在 `contained-backend-copy.test.ts`。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COPY_INTO, COPY_SOURCE, createFsService, loadPlugins } from '@nexus/core';
import type { CopyRequest } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ContainedFilesystemBackend } from './contained-backend.js';
import { COPY_FILE_TOOL_NAME, copyFileEntry, createCopyFileTool } from './copy-file-tool.js';
import { toolFsPlugin } from './settings/tool-fs.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-copy-tool-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function copyTool() {
  const backend = new ContainedFilesystemBackend({ rootDir: root });
  return createCopyFileTool(() => backend);
}

describe('copy_file 的結果句', () => {
  it('成功：說出目的地、位元組數與 sha256', async () => {
    await writeFile(join(root, 'a.txt'), '  縮排\n');
    const sha256 = createHash('sha256').update('  縮排\n').digest('hex');
    await expect(
      copyTool().invoke({ source_path: '/a.txt', destination_path: '/b.txt' }),
    ).resolves.toBe(`Copied /a.txt to /b.txt (9 bytes, sha256 ${sha256})`);
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('  縮排\n');
  });

  it('目的地已存在：拋錯，後面接換路徑或改用 edit_file 的指引', async () => {
    await writeFile(join(root, 'a.txt'), '新');
    await writeFile(join(root, 'b.txt'), '舊');
    await expect(
      copyTool().invoke({ source_path: '/a.txt', destination_path: '/b.txt' }),
    ).rejects.toThrow(
      'Cannot copy to /b.txt because it already exists. Choose a new path, or use edit_file to change the existing file.',
    );
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('舊');
  });

  it('其他失敗：原句拋出，不接指引', async () => {
    const failure = copyTool().invoke({ source_path: '/nope.txt', destination_path: '/b.txt' });
    await expect(failure).rejects.toThrow(/^Error copying '\/nope\.txt': ENOENT/u);
    await expect(failure).rejects.not.toThrow(/Choose a new path/u);
  });

  it('來源關不掉：複製照樣成功，伺服器日誌記一行', async () => {
    await writeFile(join(root, 'a.txt'), 'x');
    const real = new ContainedFilesystemBackend({ rootDir: root });
    const backend = {
      async [COPY_SOURCE](path: string, request: CopyRequest) {
        const opened = await real[COPY_SOURCE](path, request);
        if ('error' in opened) return opened;
        return {
          ...opened,
          close: async () => {
            await opened.close();
            throw new Error('EIO');
          },
        };
      },
      [COPY_INTO]: real[COPY_INTO].bind(real),
    };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        createCopyFileTool(() => backend as never).invoke({
          source_path: '/a.txt',
          destination_path: '/b.txt',
        }),
      ).resolves.toMatch(/^Copied \/a\.txt to \/b\.txt /u);
      expect(stderr).toHaveBeenCalledWith('copy_file：來源關不掉（/a.txt）：EIO\n');
    } finally {
      stderr.mockRestore();
    }
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('x');
  });

  it('還沒有 backend：拋錯', async () => {
    await expect(
      createCopyFileTool(() => undefined).invoke({ source_path: '/a', destination_path: '/b' }),
    ).rejects.toThrow('copy_file requires a filesystem');
  });
});

describe('copy_file 的註冊', () => {
  async function registered(write?: boolean): Promise<boolean> {
    const { registry, dispose } = await loadPlugins([
      ...(write === undefined ? [] : [{ plugin: toolFsPlugin, config: { write } }]),
      copyFileEntry(createFsService({ offWorkspacePrefixes: [] })),
    ]);
    try {
      return registry.tools.resolve(COPY_FILE_TOOL_NAME) !== undefined;
    } finally {
      await dispose();
    }
  }

  it('tool-fs 的 write: false 時不註冊，跟 write_file 一起關', async () => {
    expect(await registered(false)).toBe(false);
  });

  it('write: true 與沒有 tool-fs 那一列時都註冊', async () => {
    expect(await registered(true)).toBe(true);
    expect(await registered()).toBe(true);
  });
});
