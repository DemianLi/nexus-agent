/**
 * `@nexus/harness`——組裝點。
 *
 * agent 工廠與訊息標準化入口。plugin 清單組出來的 agent 只從 `createNexusAgent` 出來
 * ——`createDeepAgent` 在整個 repo 的另一個呼叫點只有直接驗基座形狀的 `baseline.test.ts`。
 *
 * 另外它也是 web 那條線的 server 端：`ThreadPump` 把 N 個 run 接成一條長期下行，
 * `createWireHandler` 是不綁 port 的 `(Request) => Response`，`startWireServer` 才碰
 * socket。協定本身在 `@nexus/wire`，見開發計劃第 7 節決策 6。
 */

export type { CreateNexusAgentOptions } from './agent-factory.js';
export { createNexusAgent } from './agent-factory.js';

export type { AgentInput, AgentInvocation } from './messages.js';
export { toAgentInvocation } from './messages.js';

export { BASE_TOOL_NAMES, RESERVED_BASE_TOOL_NAMES } from './base-tools.js';

export type { PumpAgent, PumpInput } from './thread-pump.js';
export { ThreadPump } from './thread-pump.js';

export type { WireHandler, WireHandlerOptions } from './wire-handler.js';
export { createWireHandler } from './wire-handler.js';

export type { StartWireServerOptions, WireServer } from './wire-server.js';
export { startWireServer } from './wire-server.js';
