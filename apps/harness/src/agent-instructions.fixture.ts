/**
 * agent-instructions 的**舊外殼**：「給一個 backend 就得到 middleware」的建構式，給 `pre-step-middleware.test.ts` 的「摘要之後」那一組用
 * （[#1474](https://github.com/DemianLi/nexus-agent/issues/1474)）。
 *
 * agent-instructions 本身已經是樹上的函式插件（`packages/nexus-plugin-agent-instructions`，`src/index.ts` 沒有一行 `@nexus/core`）：
 * 它只登記一位 `preStep` listener，宿主（`pre-step-middleware.ts`）建 middleware。單元測試要一顆「掛上同一個 middleware」、
 * 不經圖也不經樹的建構式，就走這個外殼——**listener 取自同一份**（`createAgentInstructionsListener`）、**middleware 由同一支建**
 * （`createPreStepMiddleware`），所以行為只有一個出處。同 `submit-record.fixture.ts`、`todo.fixture.ts` 的前例。
 *
 * **fs 怎麼取**：查找一律成功（單元測試不經圖，沒有 `checkpoint_ns`），位址隨便給 root。想驗「經樹進來」的測試用 `shippedPlugins()`，
 * 不要用這個。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 * 這個檔不含 `agent/pre-step` 以外的攔截：位置與頻率的對照看 `interception-index.test.ts` 第 2 列（`agent/pre-step`）。
 *
 * @module
 */

import {
  AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
  createAgentInstructionsListener,
} from '@nexus/plugin-agent-instructions';
import type { AnyBackendProtocol } from 'deepagents';
import type { AgentMiddleware } from 'langchain';

import { createPreStepMiddleware } from './pre-step-middleware.js';

/** 沒接會話：寫不進日誌（`not-attached`），訊息照送。 */
const NO_SESSIONS = { forCall: () => ({ kind: 'not-attached' as const }) };

/**
 * 給一個 backend 就得到 middleware（遷移之前 `createAgentInstructionsMiddleware` 的簽名）。
 *
 * @param backend - 讀候選檔的 backend。
 * @param maxBytes - 一則基線的位元組上限。
 * @param sessions - 這條 thread 的會話註冊表的 `forCall`；**省略就不記日誌**。
 * @returns 可以直接呼叫 `beforeAgent` 的 middleware。
 */
export function createAgentInstructionsMiddleware(
  backend: AnyBackendProtocol,
  maxBytes: number,
  sessions?: Parameters<typeof createPreStepMiddleware>[2],
): AgentMiddleware {
  const handle = {
    backend: () => backend,
    offWorkspacePrefixes: () => [] as readonly string[],
    hasWorkspace: () => true,
    workspaceRoot: () => undefined,
    sharedWorkspacePrefix: () => undefined,
  };
  return createPreStepMiddleware(
    AGENT_INSTRUCTIONS_MIDDLEWARE_NAME,
    createAgentInstructionsListener(maxBytes, {
      // 單元測試不經圖，沒有 `checkpoint_ns`：查找一律成功，位址隨便給 root。
      fs: () => ({ kind: 'ok', fs: handle, address: { kind: 'root' } }),
    }),
    sessions ?? NO_SESSIONS,
  );
}
