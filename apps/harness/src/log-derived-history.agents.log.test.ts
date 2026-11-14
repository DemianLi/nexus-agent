/**
 * `log-derived-history.agents.test.ts` 那一套場景與斷言，以 `history-source=log` 跑（[#2355](https://github.com/DemianLi/nexus-agent/issues/2355)）：
 * 送出去的是日誌推出來的那一串。切換點見夾具的 `HISTORY_SOURCE_UNDER_TEST`。
 *
 * 環境變數要在夾具載入之前設好，所以用動態 import。
 */

import { vi } from 'vitest';

export {};

// 這一份要量 `log`：`history-source-state.setup.ts`／`native-loop.setup.ts` 會把清單上 `log` 的列一律補成 `state`，
// 所以要跑 `log` 的測試檔自己 `vi.unmock`，這兩個模組不經過那兩份 mock；在 `vitest.native.config.ts` 底下這也讓它不換 loop，照跑 LangGraph。
vi.unmock('./assembly-root.js');
vi.unmock('./agent-factory.js');

process.env['NEXUS_LDH_HISTORY_SOURCE'] = 'log';
try {
  await import('./log-derived-history.agents.test.js');
} finally {
  // 夾具在載入時就讀完了。關掉隔離（`--no-isolate`）時同一個行程會跑下一個測試檔，不清掉的話那一份也會跑成 `log`。
  delete process.env['NEXUS_LDH_HISTORY_SOURCE'];
}
