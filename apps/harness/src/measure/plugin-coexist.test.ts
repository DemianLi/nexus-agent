/**
 * 「新舊並存」的功能面成立——[#1139](https://github.com/DemianLi/nexus-agent/issues/1139)。後台不停機更新的設計假設
 * 靠它：同一個 plugin 的兩個版本放在不同目錄，走出貨載入器 `resolveEntryModule` 與 `loadPlugins`，能各被一個 thread 使用。
 *
 * **在 `tsx` 的子行程裡跑，不在 vitest 裡跑。** 產品是 `tsx src/serve.ts` 起來的，模組載入歸 Node 加 tsx；vitest 有自己的
 * 模組執行器（查詢字串、`import.meta.url` 的行為都不同，實測 `query` 那一列在 vitest 裡連「各自的網址」都對不上），在它裡面量到的不是產品。
 *
 * 記憶體累積的數字不進測試（它量的是機器與版本，不是對錯），量法見 `plugin-coexist-cli.ts`。
 * `query` 那一列釘的是**壞消息**：同一個檔加 `?v=` 只重新求值入口檔，輔助檔共用，兩個版本會互相墊高計數、舊版的計時器也被新版的接手——
 * 有人想用它省掉版本目錄，這條會先紅。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { CoexistReport } from './plugin-coexist.js';

const run = promisify(execFile);

async function verifyUnderTsx(): Promise<CoexistReport[]> {
  const { stdout } = await run(
    process.execPath,
    ['--import', 'tsx', `${import.meta.dirname}/plugin-coexist-cli.ts`, 'verify'],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as CoexistReport);
}

describe('同一個 plugin 的兩個版本並存（tsx 子行程）', () => {
  it('版本目錄：各被各的 thread 使用，模組狀態不共用，A 結束後舊版靜下來；ts 與 mjs 一樣', async () => {
    const reports = (await verifyUnderTsx()).filter((report) => report.mode === 'dir');
    expect(reports.map((report) => report.ext).sort()).toEqual(['mjs', 'ts']);
    for (const report of reports) {
      expect(report).toMatchObject({
        distinctPluginObjects: true,
        eachThreadServedByOwnVersion: true,
        moduleStateIsolated: true,
        oldVersionQuietAfterDispose: true,
      });
    }
  }, 60_000);

  it('查詢字串：入口分開求值，但輔助檔共用——不能拿來當並存', async () => {
    const reports = (await verifyUnderTsx()).filter((report) => report.mode === 'query');
    expect(reports).toHaveLength(2);
    for (const report of reports) {
      expect(report.distinctPluginObjects).toBe(true);
      expect(report.eachThreadServedByOwnVersion).toBe(true);
      expect(report.moduleStateIsolated).toBe(false);
    }
  }, 60_000);
});
