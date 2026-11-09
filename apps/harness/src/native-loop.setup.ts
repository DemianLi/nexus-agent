/**
 * `vitest.native.config.ts` 的 setupFile：沒指定 loop 的組裝一律跑 native（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）。
 *
 * 換四個地方：
 *
 * - `createNexusAgent`：直接組 agent 的測試。
 * - `createCliAgent`：產品組裝根，它照 `invocation.agentLoop` 算答題管道再交給 `createNexusAgent`。
 * - `entryApprovalChannel`：入口給樹上那一列的預設答題管道。
 * - `createWireHandler`：serve 收人話時照 loop 決定太大的拒不拒收。
 *
 * 產品上 `--agent-loop native` 另外還交給 CLI 的 `runTurn`／`runRepl`；那兩個沒換，要 native 的測試明給 loop（`cli.test.ts`）。
 *
 * 明著給了 loop 的照給的跑，所以 `native-loop-parity.test.ts` 的 LangGraph 那一半照樣是 LangGraph。
 */

import { vi } from 'vitest';

vi.mock('./agent-factory.js', async (importActual) => {
  const actual = await importActual<typeof import('./agent-factory.js')>();
  return {
    ...actual,
    createNexusAgent: (options: Parameters<typeof actual.createNexusAgent>[0]) =>
      actual.createNexusAgent({ agentLoop: 'native', ...options }),
  };
});

vi.mock('./assembly-root.js', async (importActual) => {
  const actual = await importActual<typeof import('./assembly-root.js')>();
  return {
    ...actual,
    createCliAgent: (
      invocation: Parameters<typeof actual.createCliAgent>[0],
      ...rest: Parameters<typeof actual.createCliAgent> extends [unknown, ...infer R] ? R : never
    ) => actual.createCliAgent({ agentLoop: 'native', ...invocation }, ...rest),
  };
});

vi.mock('./cordis-root.js', async (importActual) => {
  const actual = await importActual<typeof import('./cordis-root.js')>();
  return {
    ...actual,
    entryApprovalChannel: (...args: Parameters<typeof actual.entryApprovalChannel>) =>
      actual.entryApprovalChannel(args[0], args[1] ?? 'native'),
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
