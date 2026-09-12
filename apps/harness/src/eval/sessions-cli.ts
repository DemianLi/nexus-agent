/**
 * 離線讀會話日誌的進入點——`pnpm --filter @nexus/harness eval:sessions scan <目錄...>`。
 * 地圖 [#263](https://github.com/DemianLi/nexus-agent/issues/263) 的那支「一支腳本兩個子命令」。
 *
 * **只有 `scan`。** 另一個子命令「起草」要等取消與點踩兩張 grilling 答完才講得清用哪些信號，
 * 在地圖的 Not yet specified 裡；打它會拿到一句「還沒做」，不是一個空的報表。
 *
 * 規則與報表都在 [`session-scan.ts`](./session-scan.ts)，這裡只接線。**零憑證、不連線、不寫檔**。
 */

import { DEFAULT_REPEAT_REMINDER } from '@nexus/core';
import {
  formatScanReport,
  loopingThreshold,
  readSessionLogs,
  scanSessionLog,
} from './session-scan.js';

const USAGE = `用法：eval:sessions scan <目錄...>

  scan <目錄...>  往下找每一份會話日誌，逐份報出步數、最長的重複呼叫串、工具錯誤依種類各幾次，
                  並標出疑似打轉的那幾份。目錄可以是 --session-log 給的會話根、CLI 的一個
                  run 目錄，或 serve 底下 projectKey 那一格。只讀，不動任何檔。
  draft           還沒做：用哪些信號要等地圖 #263 的取消與點踩兩張答完。

例（目錄是當初給 cli 或 serve 的 --session-log；pnpm --filter 會切進 apps/harness，
    所以相對路徑以那裡為準，同 cli 與 serve）：
  pnpm --filter @nexus/harness eval:sessions scan <會話根>`;

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }
  if (command !== 'scan') {
    throw new Error(
      command === 'draft'
        ? `draft 還沒做，見地圖 #263 的 Not yet specified。\n\n${USAGE}`
        : `認不得的子命令：${command}\n\n${USAGE}`,
    );
  }
  if (rest.length === 0) throw new Error(`scan 要給至少一個目錄。\n\n${USAGE}`);

  const { logs, unreadable } = await readSessionLogs(rest);
  const scans = logs.map((log) => scanSessionLog(log));
  const report = formatScanReport(scans, unreadable, {
    threshold: loopingThreshold(DEFAULT_REPEAT_REMINDER),
    base: process.cwd(),
  });
  console.log(report.join('\n'));
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
