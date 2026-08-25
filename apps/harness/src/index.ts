/**
 * `@nexus/harness`——組裝點。
 *
 * agent 工廠、訊息標準化入口，以及整個 repo 裡唯一那次 `createDeepAgent` 呼叫。
 */

export type { CreateNexusAgentOptions } from './agent-factory.js';
export { createNexusAgent } from './agent-factory.js';

export type { AgentInput, AgentInvocation } from './messages.js';
export { toAgentInvocation } from './messages.js';

export { BASE_TOOL_NAMES, RESERVED_BASE_TOOL_NAMES } from './base-tools.js';
