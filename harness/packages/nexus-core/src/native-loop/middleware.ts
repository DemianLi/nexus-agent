/**
 * native loop 讀 middleware 用的形狀，照 `langchain@1.5.10` 的 `createMiddleware` 產物與 `dist/agents/nodes/middleware.js` 的 runtime。
 *
 * native 只呼叫登記了一步的格（`agent.ts` 的建構檢查），這些型別描述的是那幾格的簽名，以及節點交給它們的 runtime。
 * TODO(#2363)：`langgraph` 那條路徑拿掉、內建不再造成 middleware 時拿掉這些型別。
 *
 * @module
 */

import type { AIMessage, BaseMessage, SystemMessage, ToolCall } from '@langchain/core/messages';

import type { NodeTask } from './langgraph-compat.js';
import type { LoopState } from './state.js';

/** native 讀得到的 middleware 欄位；`createMiddleware` 的產物都符合。 */
export interface LoopMiddleware {
  readonly name: string;
  readonly stateSchema?: unknown;
  readonly beforeAgent?: Hook;
  readonly beforeModel?: Hook;
  readonly afterModel?: Hook;
  readonly afterAgent?: Hook;
  readonly wrapModelCall?: (request: ModelRequest, handler: ModelHandler) => Promise<unknown>;
  readonly wrapToolCall?: (request: ToolRequest, handler: ToolHandler) => Promise<unknown>;
}

export type HookFunction = (state: LoopState, runtime: Runtime) => unknown;
export type Hook =
  HookFunction | { readonly hook: HookFunction; readonly canJumpTo?: readonly string[] };

/** hook 與 wrap* 拿到的 runtime。 */
export interface Runtime {
  readonly context: unknown;
  readonly store: unknown;
  readonly configurable: Record<string, unknown> | undefined;
  readonly writer: unknown;
  readonly interrupt: unknown;
  readonly signal: AbortSignal | undefined;
}

/** `wrapModelCall` 的請求。 */
export interface ModelRequest {
  readonly model: unknown;
  readonly systemPrompt: string;
  readonly systemMessage: SystemMessage;
  readonly messages: BaseMessage[];
  readonly tools: readonly unknown[];
  readonly toolChoice?: unknown;
  readonly modelSettings?: Record<string, unknown>;
  readonly state: LoopState;
  readonly runtime: Runtime;
}
export type ModelHandler = (request: ModelRequest) => Promise<unknown>;

/** `wrapToolCall` 的請求。 */
export interface ToolRequest {
  readonly toolCall: ToolCall;
  readonly tool: unknown;
  /**
   * 這一批的助手訊息（`toolCall` 在它的 `tool_calls` 裡）。`toolCallOwner` 讀這一格，不倒著找 `state`；`history-source=log`
   * 的 root 例外，讀日誌（#2355）。
   */
  readonly owner: AIMessage;
  readonly state: LoopState;
  readonly runtime: Runtime;
}
export type ToolHandler = (request: ToolRequest) => Promise<unknown>;

/** 有 `invoke` 的工具。 */
export interface InvokableTool {
  readonly name: string;
  readonly returnDirect?: boolean;
  invoke(input: unknown, config?: unknown): Promise<unknown>;
}

/**
 * hook 與 wrap* 拿到的 runtime，取自這個節點的 config。
 * @param task - 這個節點的環境。
 * @param context - `runtime.context`：hook 是凍結的空物件，wrap* 是 `undefined`，同 langchain。
 * @returns 凍結的 runtime。
 */
export function runtimeOf(task: NodeTask, context: unknown): Runtime {
  return Object.freeze({
    context,
    store: (task.config as { store?: unknown }).store,
    configurable: task.config.configurable,
    writer: (task.config as { writer?: unknown }).writer,
    interrupt: undefined,
    signal: task.config.signal,
  });
}

/** 一顆 hook 宣告的 `canJumpTo`；函式形式的 hook 沒有宣告，回空陣列。 */
export function hookTargets(hook: Hook): readonly string[] {
  return typeof hook === 'function' ? [] : (hook.canJumpTo ?? []);
}
