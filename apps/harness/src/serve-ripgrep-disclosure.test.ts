/**
 * serve 啟動時講出 grep 用哪一支 ripgrep（[#1502](https://github.com/DemianLi/nexus-agent/issues/1502) 刀 4，驗收 6）。
 *
 * `rg-path.test.ts` 釘狀態判斷與那一行字；這一檔從 `runServe` 起，釘「那一行真的印在啟動日誌裡」——
 * 拿掉 `serve.ts` 的那一行，`rg-path.test.ts` 照樣綠，這一檔會紅。
 *
 * **零憑證、零外部連線**：模型是腳本。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startScriptedServe } from './scripted-serve.js';
import type { ScriptedServe } from './scripted-serve.js';
import { bodyLog } from './fixtures.js';

// 讓「內附的不見了」那一條能換掉解析：`ripgrepStatus` 綁的是模組內部的 `resolveRgPath`，所以換的是它並餵一個會失敗的解析函式。
vi.mock('./rg-path.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rg-path.js')>();
  return { ...actual, ripgrepStatus: vi.fn(actual.ripgrepStatus) };
});
const { ripgrepStatus } = await import('./rg-path.js');
const actualModule = await vi.importActual<typeof import('./rg-path.js')>('./rg-path.js');
const realResolveRgPath = actualModule.resolveRgPath;

let serve: ScriptedServe | undefined;
const temporary: string[] = [];
const originalPath = process.env['PATH'];

afterEach(async () => {
  process.env['PATH'] = originalPath;
  vi.mocked(ripgrepStatus).mockImplementation(actualModule.ripgrepStatus);
  await serve?.close();
  serve = undefined;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

const TURNS = [{ content: '好' }] as const;
const grepLines = (lines: readonly string[]): string[] =>
  lines.filter((line) => line.startsWith('搜尋（grep）：'));

describe('啟動日誌講出 grep 的 ripgrep', () => {
  it('內附的在：印出它的絕對路徑，而且跟 grep 實際用的是同一支', async () => {
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, { log: bodyLog(lines) });

    expect(grepLines(lines)).toEqual([`搜尋（grep）：內附 ripgrep ${await realResolveRgPath()}`]);
  });

  it('PATH 上沒有 rg 也一樣：講的是內附那一支，不是「找不到」', async () => {
    process.env['PATH'] = await mkdtemp(join(tmpdir(), 'nexus-no-rg-'));
    temporary.push(process.env['PATH']);
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, { log: bodyLog(lines) });

    expect(grepLines(lines)).toEqual([`搜尋（grep）：內附 ripgrep ${await realResolveRgPath()}`]);
  });

  it('內附的解析不到：照樣啟動（不讓組裝失敗），印「不可用」並講明每次 grep 都失敗、沒有退路', async () => {
    vi.mocked(ripgrepStatus).mockImplementation(() =>
      actualModule.ripgrepStatus(() =>
        Promise.reject(new Error('Cannot find module @vscode/ripgrep-x')),
      ),
    );
    const lines: string[] = [];
    serve = await startScriptedServe(TURNS, { log: bodyLog(lines) });

    const [line] = grepLines(lines);
    expect(grepLines(lines)).toHaveLength(1);
    expect(line).toContain('不可用');
    expect(line).toContain('Cannot find module @vscode/ripgrep-x');
    expect(line).toContain('SEARCH_FAILED');
    expect(line).toContain('沒有退路');
    expect(serve.running.url).toMatch(/^http/);
  });
});
