/**
 * `@nexus/harness`——組裝點。
 *
 * agent 工廠與訊息標準化入口。plugin 清單組出來的 agent 只從 `createNexusAgent` 出來
 * ——`createDeepAgent` 在整個 repo 的另一個呼叫點只有直接驗基座形狀的 `baseline.test.ts`。
 */

export type { CreateNexusAgentOptions } from './agent-factory.js';
export { createNexusAgent } from './agent-factory.js';

export type { AgentInput, AgentInvocation } from './messages.js';
export { toAgentInvocation } from './messages.js';

export { BASE_TOOL_NAMES, RESERVED_BASE_TOOL_NAMES } from './base-tools.js';
