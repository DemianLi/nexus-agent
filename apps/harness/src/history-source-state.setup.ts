/**
 * vitest 的 setupFile：測試裡的組裝，沒明講 `historySource` 就當成 `state`（[#2362](https://github.com/DemianLi/nexus-agent/issues/2362)）。
 *
 * 產品入口的預設是 `log`（`settings/history-source.ts` 的 {@link HISTORY_SOURCE_ROW_DEFAULT}），而 `log` 要有接著的會話日誌：
 * 絕大多數測試只想量工具、提示或權限，不接日誌，第一次 `invoke` 就會拋「找不到日誌」。這裡把它們留在 `state`：
 *
 * - `createCliAgent`：沒給 `historySource` 就補 `state`；清單上那一列是 `state`、`log` 以外的值（影子比對 `shadow`）時不補，照那一列。
 *   **清單上寫 `log` 的列一律被補成 `state`**：mock 只看得到值，出貨那一列的 `log` 與測試自己用 `--patch` 明寫的 `log` 合併後逐字相同
 *   （`applyEntryPatches` 先 `structuredClone` 整份清單，連物件身分都分不出），日誌又是 `createCliAgent` 回傳後才由呼叫端接，也無從判斷。
 * - 裸 `createNexusAgent`（呼叫端沒給 `defaultHistorySource`，也就是不是 `createCliAgent` 轉來的）：同樣補 `state`。這一份補的是**明著傳**
 *   的那一層，所以掛了出廠清單（那一列是 `log`）的裸組裝也不會拋；要量那一列的效果，明給 `historySource: 'log'`，或不要掛這個 mock。
 *
 * **要跑 `log` 的測試檔必須自己 `vi.unmock('./assembly-root.js')` 與 `vi.unmock('./agent-factory.js')`**
 * （`log-derived-history.log.test.ts`、`log-derived-history.agents.log.test.ts`、`history-source-log-default.test.ts` 這樣做）；
 * 忘了的話那一份會無聲地改跑 `state` 而且照綠。`history-source-state.guard.*.test.ts` 兩份把這件事釘住。
 * 撤除條件：測試的組裝都接上會話日誌（或有不需日誌的替身）之後，整份 mock 與兩份守門一起撤。
 *
 * `native-loop.setup.ts` 換同樣兩個模組時自己也帶這一格。
 */

import { vi } from 'vitest';

import { listedHistorySource } from './history-source-state.listed.js';

vi.mock('./assembly-root.js', async (importActual) => {
  const actual = await importActual<typeof import('./assembly-root.js')>();
  return {
    ...actual,
    createCliAgent: (
      invocation: Parameters<typeof actual.createCliAgent>[0],
      plugins: Parameters<typeof actual.createCliAgent>[1],
      ...rest: Parameters<typeof actual.createCliAgent> extends [unknown, unknown, ...infer R]
        ? R
        : never
    ) => {
      const listed = listedHistorySource(plugins);
      const keepRow = listed !== undefined && listed !== 'log';
      return actual.createCliAgent(
        { ...(!keepRow && { historySource: 'state' as const }), ...invocation },
        plugins,
        ...rest,
      );
    },
  };
});

vi.mock('./agent-factory.js', async (importActual) => {
  const actual = await importActual<typeof import('./agent-factory.js')>();
  return {
    ...actual,
    createNexusAgent: (options: Parameters<typeof actual.createNexusAgent>[0]) =>
      actual.createNexusAgent({
        ...(options.defaultHistorySource === undefined && { historySource: 'state' as const }),
        ...options,
      }),
  };
});
