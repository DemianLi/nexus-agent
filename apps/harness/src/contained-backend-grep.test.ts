/**
 * `grep` 的 glob 錨點（見 `ContainedFilesystemBackend.grep` 的註解）。
 *
 * 缺陷只在「harness 的工作目錄不是工作區根」時出現，所以每一組先釘死這個前提。基座有兩條
 * 搜尋路（有 rg 走 `ripgrepSearch()`，沒有就走 `literalSearch()`），兩條的錯法不同，這裡各跑
 * 一遍：rg 那組要求 rg 在 PATH 上（CI 在 `ci.yml` 裝了它），沒有就紅，不跳過；退路那組把
 * PATH 換成找不到 rg 的目錄。
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolMessage } from '@langchain/core/messages';
import { createFilesystemMiddleware, FilesystemBackend } from 'deepagents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContainedFilesystemBackend } from './contained-backend.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nexus-grep-'));
  await mkdir(join(root, 'logs'));
  await mkdir(join(root, 'nested', 'logs'), { recursive: true });
  await mkdir(join(root, 'src', 'util'), { recursive: true });
  await writeFile(join(root, 'logs', 'app.log'), 'ERROR 一\nINFO\nERROR 二\nERROR 三\n');
  await writeFile(join(root, 'nested', 'logs', 'app.log'), 'ERROR 巢狀\n');
  await writeFile(join(root, 'src', 'a.ts'), 'export const hit = 1; // ERROR 留在原始碼裡\n');
  await writeFile(join(root, 'src', 'util', 'b.ts'), 'export const hit = 2;\n');
  // 前提：rg 的錨點是行程的工作目錄，它等於根的話缺陷不會出現，這些斷言也就什麼都沒驗到。
  expect(process.cwd()).not.toBe(root);
});

const paths = (result: { matches?: Array<{ path: string }> }): string[] =>
  [...new Set((result.matches ?? []).map((match) => match.path))].sort();

/** rg 在不在 PATH 上。`spawnSync` 找不到執行檔時 `error` 是 ENOENT。 */
const rgAvailable = (): boolean => spawnSync('rg', ['--version']).error === undefined;

const originalPath = process.env['PATH'];
afterEach(() => {
  process.env['PATH'] = originalPath;
});

for (const route of ['rg', 'literal'] as const) {
  describe(`帶目錄的 glob 對工作區根錨定（基座走 ${route === 'rg' ? 'ripgrep' : '沒有 rg 的退路'}）`, () => {
    beforeEach(async () => {
      if (route === 'literal') {
        // 只留一個空目錄：spawn('rg') 拿到 ENOENT，基座退到 literalSearch()。
        process.env['PATH'] = await mkdtemp(join(tmpdir(), 'nexus-no-rg-'));
        expect(rgAvailable()).toBe(false);
      } else if (!rgAvailable()) {
        throw new Error('這一組要 rg 在 PATH 上；CI 由 ci.yml 的「安裝 ripgrep」提供');
      }
    });

    it('相對寫法與開頭帶 `/` 的寫法都只對上根底下那一個', async () => {
      const backend = new ContainedFilesystemBackend({ rootDir: root });
      for (const glob of ['logs/app.log', '/logs/app.log']) {
        const result = await backend.grep('ERROR', '/', glob);
        expect(result.error).toBeUndefined();
        expect(paths(result)).toEqual(['/logs/app.log']);
        expect(result.matches).toHaveLength(3);
      }
    });

    it('不帶 `/` 的 glob 照舊比檔名，任何深度都對得上', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).grep(
        'ERROR',
        '/',
        '*.log',
      );
      expect(paths(result)).toEqual(['/logs/app.log', '/nested/logs/app.log']);
    });

    it('`**` 與最後一段是萬用字元的 glob', async () => {
      const backend = new ContainedFilesystemBackend({ rootDir: root });
      expect(paths(await backend.grep('hit', '/', 'src/**/*.ts'))).toEqual([
        '/src/a.ts',
        '/src/util/b.ts',
      ]);
      expect(paths(await backend.grep('hit', '/', 'src/*.ts'))).toEqual(['/src/a.ts']);
      expect(paths(await backend.grep('ERROR', '/', '**/logs/**'))).toEqual([
        '/logs/app.log',
        '/nested/logs/app.log',
      ]);
    });

    it('大括號的選項跨了 `/` 時，每個選項都對得上', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).grep(
        'ERROR',
        '/',
        '{logs/app.log,src/a.ts}',
      );
      expect(paths(result)).toEqual(['/logs/app.log', '/src/a.ts']);
    });

    it('從子目錄搜尋時，glob 仍對工作區根錨定（同 rg 在根上執行）', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).grep(
        'hit',
        '/src',
        'src/util/*.ts',
      );
      expect(paths(result)).toEqual(['/src/util/b.ts']);
    });

    it('maxCount 在過濾之後才套用，截斷時帶 truncated', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).grep(
        'ERROR',
        '/',
        'logs/app.log',
        2,
      );
      expect(result.matches).toHaveLength(2);
      expect(paths(result)).toEqual(['/logs/app.log']);
      expect(result.truncated).toBe(true);
    });

    /** 過濾前就截斷的話，巢狀那一筆會讓總數超過上限而被標成截斷，與回傳順序無關。 */
    it('maxCount 剛好等於根底下的筆數時不算截斷', async () => {
      const result = await new ContainedFilesystemBackend({ rootDir: root }).grep(
        'ERROR',
        '/',
        'logs/app.log',
        3,
      );
      expect(result.matches).toHaveLength(3);
      expect(result.truncated).not.toBe(true);
    });

    /**
     * **升版絆索**：裸的 `FilesystemBackend` 今天對帶目錄的 glob 回 0 筆。基座修好那天這條會紅，
     * 那就是拿掉 `ContainedFilesystemBackend.grep` 覆寫的時刻。
     */
    it('沒有我們那一層時，帶目錄的 glob 回 0 筆', async () => {
      const bare = new FilesystemBackend({ rootDir: root, virtualMode: true });
      for (const glob of ['logs/app.log', '/logs/app.log']) {
        expect((await bare.grep('ERROR', '/', glob)).matches).toEqual([]);
      }
    });
  });
}

describe('模型看到的 grep 結果', () => {
  /** 照 live 日誌裡模型實際送出的參數，走基座的 grep 工具。 */
  it('`glob: "/logs/app.log"` 加 `output_mode: "count"` 數得到根底下那一個檔', async () => {
    const middleware = createFilesystemMiddleware({
      backend: new ContainedFilesystemBackend({ rootDir: root }),
    });
    const grep = (middleware.tools ?? []).find((tool) => tool.name === 'grep');
    if (grep === undefined) throw new Error('基座的 filesystem middleware 沒有 grep');
    const result: unknown = await grep.invoke({
      id: 'call-grep',
      name: 'grep',
      args: { pattern: 'ERROR', path: '/', glob: '/logs/app.log', output_mode: 'count' },
      type: 'tool_call',
    });
    expect(ToolMessage.isInstance(result)).toBe(true);
    const content = String((result as ToolMessage).content);
    expect(content).not.toContain('No matches found');
    expect(content).toContain('/logs/app.log');
    expect(content).toContain('3');
    expect(content).not.toContain('nested');
  });
});
