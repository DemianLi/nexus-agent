/**
 * native loop 的工具節點，照 `langchain@1.5.10` 的 `dist/agents/utils.js` 的 `wrapToolCall`／`chainToolCallHandlers` 與
 * `nodes/ToolNode.js` 的 `runTool`：工具錯重拋給圍堵；參數解析失敗、找不到工具回錯誤訊息。
 *
 * @module
 */

import type { AIMessage, ToolCall } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';
import { isCommand, isGraphInterrupt } from '@langchain/langgraph';
import type { Command } from '@langchain/langgraph';
import { ToolInputParsingException } from '@langchain/core/tools';
import { MiddlewareError, ToolInvocationError } from 'langchain';

import { invalidToolMessage } from './invalid-tool.js';
import type { NodeTask } from './langgraph-compat.js';
import {
  runtimeOf,
  type InvokableTool,
  type LoopMiddleware,
  type ToolHandler,
} from './middleware.js';

/**
 * 跑一顆工具呼叫，經過整串 `wrapToolCall`。照 `ToolNode.js` 的 `runTool`：工具與 middleware 的錯往外拋（圍堵在最外層接），
 * 參數解析失敗翻成給模型的 `ToolMessage`；工具找不到回錯誤的 `ToolMessage`。
 * @param call - 這顆呼叫。
 * @param tools - 靜態註冊的工具。
 * @param middleware - 由外到內的那幾格，每一格直接呼叫它登記的那一步。見 `agent.ts` 的 `#toolCells`。
 * @param task - 這顆工具的環境（`tools:<id>`）。
 * @param owner - 這一批的助手訊息（`call` 在它的 `tool_calls` 裡），放進請求的 `owner`。
 * @returns `ToolMessage` 或 `Command`。
 */
export async function runTool(
  call: ToolCall,
  tools: readonly InvokableTool[],
  middleware: readonly LoopMiddleware[],
  task: NodeTask,
  owner: AIMessage,
): Promise<ToolMessage | Command> {
  const registered = tools.find((tool) => tool.name === call.name);
  const base: ToolHandler = async (request) => {
    const tool = (request.tool ?? tools.find((t) => t.name === request.toolCall.name)) as
      InvokableTool | undefined;
    if (tool === undefined) {
      return invalidToolMessage(
        request.toolCall,
        tools.map((t) => t.name),
      );
    }
    // LangChain 的 `tool()` 只掛 `abort` 監聽：拿到已經 abort 的 signal 不會拒絕，本體跑完也不 resolve，永遠懸著。兄弟失敗
    // 舉起來的這一格由 native 自己舉，所以先拋。呼叫端中止時 `stepSignal` 也會跟著舉（這顆被 {@link NodeTask.run} 拒絕，
    // `runBounded` 當成失敗），那時不拋：同 LangGraph，本體照跑、懸著也沒人等，這個節點已經由 `NodeTask.run` 收掉。
    if (task.callerSignal?.aborted !== true) task.stepSignal?.throwIfAborted();
    let output: unknown;
    try {
      output = await tool.invoke(
        { ...request.toolCall, type: 'tool_call' },
        {
          ...task.config,
          config: task.config,
          toolCallId: request.toolCall.id,
          state: task.state,
          signal: task.config.signal,
        },
      );
    } catch (error) {
      if (error instanceof ToolInputParsingException) {
        throw new ToolInvocationError(error, request.toolCall);
      }
      throw error;
    }
    if (ToolMessage.isInstance(output) || isCommand(output)) return output;
    return new ToolMessage({
      name: tool.name,
      content: typeof output === 'string' ? output : JSON.stringify(output),
      tool_call_id: request.toolCall.id ?? '',
    });
  };

  const wrappers = middleware.filter((m) => m.wrapToolCall !== undefined);
  let chained: ToolHandler = base;
  for (let i = wrappers.length - 1; i >= 0; i--) {
    const m = wrappers[i]!;
    const inner = chained;
    chained = async (request) => {
      const originalState = request.state;
      const downstream = new Set<unknown>();
      try {
        const result = await m.wrapToolCall!(
          { ...request, state: originalState },
          async (passed) => {
            try {
              return await inner({ ...passed, state: { ...originalState, ...passed.state } });
            } catch (error) {
              downstream.add(error);
              throw error;
            }
          },
        );
        if (!ToolMessage.isInstance(result) && !isCommand(result)) {
          throw new Error(
            `Invalid response from "wrapToolCall" in middleware "${m.name}": expected ToolMessage or Command, got ${typeof result}`,
          );
        }
        return result;
      } catch (error) {
        if (downstream.has(error)) throw error;
        throw MiddlewareError.wrap(error, m.name);
      }
    };
  }

  try {
    return (await task.run(() =>
      chained({
        toolCall: call,
        tool: registered,
        owner,
        state: task.state,
        runtime: runtimeOf(task, undefined),
      }),
    )) as ToolMessage | Command;
  } catch (error) {
    // 同 `ToolNode` 的 `#handleError`：中斷與中止往外拋；參數解析失敗（沿 `MiddlewareError.cause` 拆到底）翻成訊息給模型；
    // 其餘是 middleware 的錯，往外拋。
    if (isGraphInterrupt(error) || task.config.signal?.aborted === true) throw error;
    let root: unknown = error;
    while (MiddlewareError.isInstance(root)) root = (root as Error).cause;
    if (ToolInvocationError.isInstance(root)) {
      return new ToolMessage({
        content: (root as Error).message,
        tool_call_id: call.id ?? '',
        name: call.name,
      });
    }
    throw error;
  }
}
