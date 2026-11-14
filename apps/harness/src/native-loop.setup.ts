/**
 * `vitest.native.config.ts` 的 setupFile：沒指定 loop 的組裝一律跑 native（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）。
 *
 * 換三個地方：
 *
 * - `createNexusAgent`：直接組 agent 的測試。
 * - `createCliAgent`：產品組裝根，它把 `invocation.agentLoop` 交給 `createNexusAgent`。
 * - `createWireHandler`：serve 收人話時照 loop 決定太大的拒不拒收。
 *
 * 產品上 `--agent-loop native` 另外還交給 CLI 的 `runTurn`／`runRepl`；那兩個沒換，要 native 的測試明給 loop（`cli.test.ts`）。
 *
 * 這一份也代 `history-source-state.setup.ts` 的班：同一個模組只留最後一個 mock，所以 `createNexusAgent` 與 `createCliAgent` 在這裡一併帶 `historySource: 'state'`；規則同它：清單上寫 `log` 的列一律被補成 `state`，從清單拿 `log` 的測試檔自己 `vi.unmock`（細節與撤除條件見該檔檔頭）。unmock `assembly-root.js` 的檔仍是 native：loop 由 `agent-factory.js` 這一格帶，那一格不要 unmock。
 *
 * 明著給了 loop 的照給的跑，所以 `native-loop-parity.test.ts` 的 LangGraph 那一半照樣是 LangGraph。
 */

import { vi } from 'vitest';

import { listedHistorySource } from './history-source-state.listed.js';

vi.mock('./agent-factory.js', async (importActual) => {
  const actual = await importActual<typeof import('./agent-factory.js')>();
  return {
    ...actual,
    createNexusAgent: (options: Parameters<typeof actual.createNexusAgent>[0]) =>
      actual.createNexusAgent({
        agentLoop: 'native',
        ...(options.defaultHistorySource === undefined && { historySource: 'state' as const }),
        ...options,
      }),
  };
});

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
        {
          agentLoop: 'native',
          ...(!keepRow && { historySource: 'state' as const }),
          ...invocation,
        },
        plugins,
        ...rest,
      );
    },
  };
});

vi.mock('./wire-handler.js', async (importActual) => {
  const actual = await importActual<typeof import('./wire-handler.js')>();
  return {
    ...actual,
    createWireHandler: (options: Parameters<typeof actual.createWireHandler>[0]) =>
      actual.createWireHandler({ agentLoop: 'native', ...options }),
  };
});
