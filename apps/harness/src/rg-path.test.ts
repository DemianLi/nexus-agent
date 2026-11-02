/**
 * 內附 ripgrep 的路徑與啟動那一行（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 4）。
 *
 * 內附的 rg 缺了壞了不讓組裝失敗，只在啟動時講出來（`formatRipgrepDisclosure`）；搜尋時才以 `SEARCH_FAILED` 失敗。
 * 這一份釘狀態判斷與那一行字，`contained-backend-ripgrep.test.ts` 釘搜尋端的失敗。
 */

import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatRipgrepDisclosure, resolveRgPath, ripgrepStatus } from './rg-path.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nexus-rg-path-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveRgPath', () => {
  it('解出內附 rg 的絕對路徑，而且真的是一支能跑的 ripgrep', async () => {
    const path = await resolveRgPath();

    expect(isAbsolute(path)).toBe(true);
    const run = spawnSync(path, ['--version'], { encoding: 'utf8' });
    expect(run.error).toBeUndefined();
    expect(run.stdout).toMatch(/^ripgrep \d+\.\d+\.\d+/);
  });

  it('每個行程只解析一次（同一個 promise）', () => {
    expect(resolveRgPath()).toBe(resolveRgPath());
  });

  it('不是 PATH 上的那一支：路徑在 node_modules 的平台套件底下', async () => {
    expect(await resolveRgPath()).toMatch(/@vscode[\\/]ripgrep-/);
  });
});

describe('ripgrepStatus', () => {
  it('內附的在：bundled，帶路徑', async () => {
    const status = await ripgrepStatus();

    expect(status).toEqual({ kind: 'bundled', path: await resolveRgPath() });
  });

  it('解析丟例外（平台套件不見了）：missing，帶原因，不丟', async () => {
    const status = await ripgrepStatus(() => Promise.reject(new Error('Cannot find module x')));

    expect(status).toEqual({ kind: 'missing', reason: 'Cannot find module x' });
  });

  it('路徑指向不存在的檔（內附的被刪掉）：missing，原因帶路徑與 ENOENT', async () => {
    const gone = join(dir, 'rg');

    const status = await ripgrepStatus(() => Promise.resolve(gone));

    expect(status.kind).toBe('missing');
    expect((status as { reason: string }).reason).toContain(gone);
    expect((status as { reason: string }).reason).toContain('ENOENT');
  });

  it('檔在但沒有執行權限：missing', async () => {
    const file = join(dir, 'rg');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o644);

    const status = await ripgrepStatus(() => Promise.resolve(file));

    expect(status).toMatchObject({ kind: 'missing' });
    expect((status as { reason: string }).reason).toContain('EACCES');
  });

  it('反例：有執行權限的檔是 bundled', async () => {
    const file = join(dir, 'rg');
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o755);

    expect(await ripgrepStatus(() => Promise.resolve(file))).toEqual({
      kind: 'bundled',
      path: file,
    });
  });
});

describe('formatRipgrepDisclosure', () => {
  it('bundled：印出路徑', () => {
    expect(formatRipgrepDisclosure({ kind: 'bundled', path: '/x/bin/rg' })).toBe(
      '搜尋（grep）：內附 ripgrep /x/bin/rg',
    );
  });

  it('missing：講出原因與後果——每一次 grep 都失敗、沒有退路', () => {
    const line = formatRipgrepDisclosure({ kind: 'missing', reason: '路徑不存在' });

    expect(line).toContain('不可用');
    expect(line).toContain('路徑不存在');
    expect(line).toContain('SEARCH_FAILED');
    expect(line).toContain('沒有退路');
  });
});
