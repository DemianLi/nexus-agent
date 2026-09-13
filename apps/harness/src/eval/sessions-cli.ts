/**
 * 離線讀會話日誌的進入點——`pnpm --filter @nexus/harness eval:sessions <scan|draft> <目錄...>`。
 * 地圖 [#263](https://github.com/DemianLi/nexus-agent/issues/263) 的那支「一支腳本兩個子命令」。
 *
 * - `scan`：規則與報表在 [`session-scan.ts`](./session-scan.ts)。
 * - `draft`：規則與草稿在 [`session-draft.ts`](./session-draft.ts)
 *   （[#280](https://github.com/DemianLi/nexus-agent/issues/280)）。
 *
 * 這裡只接線。**零憑證、不連線、不寫檔**——草稿也只印終端（#280 拍板）。
 */

import { DEFAULT_REPEAT_REMINDER } from '@nexus/core';
import { draftSessionLog, formatDraftReport } from './session-draft.js';
import {
  formatScanReport,
  loopingThreshold,
  readSessionLogs,
  scanSessionLog,
} from './session-scan.js';

const USAGE = `用法：eval:sessions <scan|draft> <目錄...>

  scan <目錄...>   往下找每一份會話日誌，逐份報出步數、最長的重複呼叫串、工具錯誤依種類各幾次，
                   並標出疑似打轉的那幾份。目錄可以是 --session-log 給的會話根、CLI 的一個
                   run 目錄，或 serve 底下 projectKey 那一格。只讀，不動任何檔。
  draft <目錄...>  從同樣的目錄撈出該補進題庫的那幾輪——被點踩、被取消、跑壞（turn/failed）、
                   疑似打轉——命中幾種多的排前面，逐輪印成 dataset.ts 的 BenchmarkCase 殼：
                   prompt 填好、expected 留給人填，底下附那一輪實際的工具呼叫當參考。只讀，不寫檔。

例（目錄是當初給 cli 或 serve 的 --session-log；pnpm --filter 會切進 apps/harness，
    所以相對路徑以那裡為準，同 cli 與 serve）：
  pnpm --filter @nexus/harness eval:sessions scan <會話根>
  pnpm --filter @nexus/harness eval:sessions draft <會話根>`;

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  if (command !== 'scan' && command !== 'draft') {
    throw new Error(`認不得的子命令：${command}\n\n${USAGE}`);
  }
  if (rest.length === 0) throw new Error(`${command} 要給至少一個目錄。\n\n${USAGE}`);

  const { logs, unreadable } = await readSessionLogs(rest);
  const options = { threshold: loopingThreshold(DEFAULT_REPEAT_REMINDER), base: process.cwd() };
  const report =
    command === 'scan'
      ? formatScanReport(
          logs.map((log) => scanSessionLog(log)),
          unreadable,
          options,
        )
      : formatDraftReport(
          logs.map((log) => draftSessionLog(log)),
          unreadable,
          options,
        );
  console.log(report.join('\n'));
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
