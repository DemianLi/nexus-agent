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

import { declaredToolTimeoutMs } from '../containment.js';
import { waitClockOf, type WaitClock } from '../human-input.js';
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
    const budgetMs = declaredToolTimeoutMs({ tool });
    const deadline =
      budgetMs === undefined ? undefined : pausableDeadline(budgetMs, waitClockOf(task.config));
    const signal =
      deadline === undefined
        ? task.config.signal
        : task.config.signal === undefined
          ? deadline.signal
          : AbortSignal.any([task.config.signal, deadline.signal]);
    let output: unknown;
    try {
      output = await (deadline === undefined ? tool : withoutDeclaredTimeout(tool)).invoke(
        { ...request.toolCall, type: 'tool_call' },
        {
          ...task.config,
          config: task.config,
          toolCallId: request.toolCall.id,
          state: task.state,
          signal,
          // 同 LangChain 自己武裝時記的那一格（`@langchain/core@1.2.9` `dist/runnables/config.js` 的 `ensureConfig`）。
          ...(budgetMs !== undefined && {
            metadata: { ...task.config.metadata, timeoutMs: budgetMs },
          }),
        },
      );
    } catch (error) {
      if (error instanceof ToolInputParsingException) {
        throw new ToolInvocationError(error, request.toolCall);
      }
      throw error;
    } finally {
      deadline?.dispose();
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

/**
 * 工具自己宣告的時限（`defaultConfig.timeout`），等人時停表：這顆呼叫在 `ask`、`idle` 上等（含等完排隊取回名額）的期間不算，接回後只給
 * 剩下的預算，同 LangGraph 接回時從頭重跑、問之前那段要再跑一次之後剩下的。到點以 `TimeoutError` 舉起，同 `AbortSignal.timeout`，圍堵照
 * 同一個名字認逾時（`containment.ts` 的 `isToolTimeout`）。
 * @param budgetMs - 宣告的毫秒數。
 * @param clock - 這顆呼叫的等人時間；讀不到就不停表。
 * @returns 到點舉起的訊號，與收掉計時器的 `dispose`。
 */
function pausableDeadline(
  budgetMs: number,
  clock: WaitClock | undefined,
): { readonly signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  let remaining = budgetMs;
  let since = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = (): void => {
    timer = undefined;
    controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  };
  const run = (): void => {
    if (timer !== undefined || controller.signal.aborted) return;
    since = Date.now();
    timer = setTimeout(fire, Math.max(0, remaining));
    // `AbortSignal.timeout` 的計時器不讓行程撐著不退出，這裡照做。
    timer.unref?.();
  };
  const pause = (): void => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    remaining -= Date.now() - since;
  };
  const unlisten = clock?.onWaiting((waiting) => (waiting ? pause() : run()));
  run();
  return {
    signal: controller.signal,
    dispose: () => {
      unlisten?.();
      pause();
    },
  };
}

/**
 * 拿掉 `defaultConfig.timeout` 的同一顆工具：只覆寫 `defaultConfig`，其餘經原型讀到。`StructuredTool.invoke` 會把它併成
 * `AbortSignal.timeout`（`@langchain/core@1.2.9` `dist/tools/index.js:83`），等人時停不下來，所以改由 {@link pausableDeadline} 武裝。
 * @param tool - 宣告了時限的工具。
 * @returns 以 `tool` 為原型的新物件。
 */
function withoutDeclaredTimeout(tool: InvokableTool): InvokableTool {
  const { timeout: _timeout, ...rest } = (tool as { defaultConfig?: Record<string, unknown> })
    .defaultConfig ?? {};
  return Object.create(tool, { defaultConfig: { value: rest } }) as InvokableTool;
}
