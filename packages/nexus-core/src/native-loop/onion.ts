/**
 * native loop 的相容層：照 langchain `createAgent` 的語意跑現有的 middleware 洋蔥（[#2356](https://github.com/DemianLi/nexus-agent/issues/2356)）。
 * TODO(#2357)：middleware 搬成事件與服務後拿掉這個檔。
 *
 * 照的是 `langchain@1.5.10` 的這幾處：
 *
 * - hook 節點：`dist/agents/nodes/middleware.js`（state、runtime、`jumpTo` 檢查）；
 * - 模型洋蔥：`dist/agents/nodes/AgentNode.js` 的 `#invokeModel`（第一顆在最外層、系統訊息兩種改法互斥、回 `Command` 時用最內層記下的 AI 訊息補寫）；
 * - 工具洋蔥：`dist/agents/utils.js` 的 `wrapToolCall`／`chainToolCallHandlers` 與 `nodes/ToolNode.js` 的 `runTool`（工具錯重拋給圍堵；參數解析失敗、找不到工具回錯誤訊息）。
 *
 * 每一層都跑在 `AsyncLocalStorageProviderSingleton.runWithConfig` 裡，`getConfig()`、`getCurrentTaskInput()` 與 deepagents 的
 * 零參數 `StateBackend`（`__pregel_read`／`__pregel_send`）讀到的是 native loop 合成的 config。
 *
 * @module
 */

import type { BaseMessage, ToolCall } from '@langchain/core/messages';
import { AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { RunnableBinding } from '@langchain/core/runnables';
import type { RunnableConfig } from '@langchain/core/runnables';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { isCommand, isGraphInterrupt } from '@langchain/langgraph';
import type { Command } from '@langchain/langgraph';
import { ToolInputParsingException } from '@langchain/core/tools';
import { MiddlewareError, ToolInvocationError } from 'langchain';

import type { LoopState, StateChannels } from './state.js';

/** 洋蔥裡用得到的 middleware 欄位；`createMiddleware` 的產物都符合。 */
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

type HookFunction = (state: LoopState, runtime: Runtime) => unknown;
type Hook = HookFunction | { readonly hook: HookFunction; readonly canJumpTo?: readonly string[] };

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
type ModelHandler = (request: ModelRequest) => Promise<unknown>;

/** `wrapToolCall` 的請求。 */
export interface ToolRequest {
  readonly toolCall: ToolCall;
  readonly tool: unknown;
  readonly state: LoopState;
  readonly runtime: Runtime;
}
type ToolHandler = (request: ToolRequest) => Promise<unknown>;

/** 有 `invoke` 的工具。 */
export interface InvokableTool {
  readonly name: string;
  readonly returnDirect?: boolean;
  invoke(input: unknown, config?: unknown): Promise<unknown>;
}

/**
 * 一個節點（一顆 hook、一次模型呼叫、一顆工具）的執行環境：合成的 config，加上這個節點經 `__pregel_send` 送出、
 * 還沒套進 state 的寫入（同 LangGraph：節點結束才套；`__pregel_read(…, true)` 看得到自己的）。
 */
export class NodeTask {
  readonly writes: [string, unknown][] = [];
  readonly config: RunnableConfig;

  /**
   * @param base - 這次 run 的 config（configurable、callbacks、signal、writer）。
   * @param checkpointNs - 這個節點的命名空間（`model_request:<id>`、`tools:<id>`）。
   * @param node - 節點名。
   * @param state - 節點開始時的 state。
   * @param channels - 合併規則。
   * @param taskInput - `getCurrentTaskInput()` 讀到的值。
   * @param onFlush - 節點寫回之後（{@link NodeTask.flush}）。
   * @param stepSignal - 同一批工具共用、一顆拋了就舉起來的訊號；工具進 `invoke` 前看它。
   */
  constructor(
    base: RunnableConfig,
    checkpointNs: string,
    node: string,
    readonly state: LoopState,
    private readonly channels: StateChannels,
    taskInput: unknown,
    private readonly onFlush?: () => void,
    readonly stepSignal?: AbortSignal,
  ) {
    this.config = {
      ...base,
      metadata: { ...base.metadata, langgraph_node: node, langgraph_checkpoint_ns: checkpointNs },
      configurable: {
        ...base.configurable,
        checkpoint_ns: checkpointNs,
        __pregel_send: (writes: [string, unknown][]) => {
          this.writes.push(...writes);
        },
        __pregel_read: (channel: string, fresh?: boolean) => this.#read(channel, fresh === true),
        __pregel_scratchpad: { currentTaskInput: taskInput },
      },
    };
  }

  #read(channel: string, fresh: boolean): unknown {
    if (!fresh) return this.state[channel];
    const view: LoopState = { messages: this.state.messages, [channel]: this.state[channel] };
    for (const [key, value] of this.writes) {
      if (key === channel) this.channels.apply(view, { [key]: value });
    }
    return view[channel];
  }

  /**
   * 在這個節點的 config 裡跑。
   * @param body - 要跑的東西。
   * @returns 它的結果。
   */
  run<T>(body: () => Promise<T>): Promise<T> {
    return AsyncLocalStorageProviderSingleton.runWithConfig(this.config, body) as Promise<T>;
  }

  /** hook 與 wrap* 拿到的 runtime。 */
  runtime(context: unknown): Runtime {
    return Object.freeze({
      context,
      store: (this.config as { store?: unknown }).store,
      configurable: this.config.configurable,
      writer: (this.config as { writer?: unknown }).writer,
      interrupt: undefined,
      signal: this.config.signal,
    });
  }

  /** 節點結束：把經 `__pregel_send` 送出的寫入套進 state。 */
  flush(): void {
    this.keepWrites();
    this.onFlush?.();
  }

  /**
   * 把經 `__pregel_send` 送出的寫入套進 state 並清空，不叫 `onFlush`（節點不算完成）；`flush` 與失敗、沒收完的路徑共用。
   * LangGraph 把失敗 task 的寫入連同 `ERROR` 存成 pending writes，`getState` 與之後的 `updateState` 會套上（例如摘要器先寫的
   * 歷史檔）；native 當場套進 state。
   */
  keepWrites(): void {
    for (const [key, value] of this.writes) this.channels.apply(this.state, { [key]: value });
    this.writes.length = 0;
  }
}

function hookFunction(hook: Hook): HookFunction {
  return typeof hook === 'function' ? hook : hook.hook;
}

/** 一顆 hook 宣告的 `canJumpTo`；函式形式的 hook 沒有宣告，回空陣列。 */
export function hookTargets(hook: Hook): readonly string[] {
  return typeof hook === 'function' ? [] : (hook.canJumpTo ?? []);
}

/** 一顆 hook 的結果：寫入已套進 state，只回跳轉目標。 */
export type JumpTarget = 'model' | 'tools' | 'end' | undefined;

/**
 * 跑一顆 hook（`beforeAgent`、`beforeModel`、`afterAgent`）。照 `nodes/middleware.js`：回傳值是 null／undefined 就不套回傳值
 * （`__pregel_send` 的寫入照樣套）；跳轉目標要在 `canJumpTo` 裡。
 * @param middleware - 那一顆。
 * @param kind - 哪一種 hook。
 * @param task - 這個節點的環境。
 * @param channels - 合併規則。
 * @returns 跳轉目標。
 */
export async function runHook(
  middleware: LoopMiddleware,
  kind: 'beforeAgent' | 'beforeModel' | 'afterAgent',
  task: NodeTask,
  channels: StateChannels,
): Promise<JumpTarget> {
  const hook = middleware[kind];
  if (hook === undefined) return undefined;
  const result = (await task.run(async () =>
    hookFunction(hook)({ ...task.state }, task.runtime(Object.freeze({}))),
  )) as Record<string, unknown> | undefined | null;
  task.flush();
  if (result === undefined || result === null) return undefined;
  const jumpTo = result['jumpTo'];
  if (typeof jumpTo === 'string' && !hookTargets(hook).includes(jumpTo)) {
    throw new Error(
      `Invalid jump target: ${jumpTo}, no ${kind}.canJumpTo defined in middleware ${middleware.name}.`,
    );
  }
  if ('type' in result && result['type'] === 'terminate') {
    if (result['error'] !== undefined) throw result['error'];
    channels.apply(task.state, (result['result'] ?? {}) as Record<string, unknown>);
  } else {
    channels.apply(task.state, result);
  }
  return jumpTo as JumpTarget;
}

/** 系統提示詞正規化成 `SystemMessage`，同 langchain 的 `normalizeSystemPrompt`。 */
export function systemMessageOf(systemPrompt: string | undefined): SystemMessage {
  if (systemPrompt === undefined || systemPrompt === '') return new SystemMessage('');
  return new SystemMessage({ content: [{ type: 'text', text: systemPrompt }] });
}

interface BindsTools {
  bindTools(tools: readonly unknown[], options: Record<string, unknown>): unknown;
}

function canBindTools(model: unknown): model is BindsTools {
  return typeof (model as Partial<BindsTools> | null)?.bindTools === 'function';
}

/** 同 langchain 的 `_simpleBindTools`：裸模型直接綁，`RunnableBinding` 綁裡面那顆再把外層的 config／kwargs 包回去。 */
function bindTools(
  model: unknown,
  tools: readonly unknown[],
  options: Record<string, unknown>,
): unknown {
  if (canBindTools(model)) return model.bindTools(tools, options);
  if (RunnableBinding.isRunnableBinding(model) && canBindTools(model.bound)) {
    const bound = model.bound.bindTools(tools, options);
    if (RunnableBinding.isRunnableBinding(bound)) {
      return new RunnableBinding({
        bound: bound.bound,
        config: { ...model.config, ...bound.config },
        kwargs: { ...model.kwargs, ...bound.kwargs },
        configFactories: bound.configFactories ?? model.configFactories,
      });
    }
    return new RunnableBinding({
      bound: bound as never,
      config: model.config,
      kwargs: model.kwargs,
      configFactories: model.configFactories,
    });
  }
  throw new Error(`llm ${String(model)} must define bindTools method.`);
}

/** 模型那一步的結果：要寫進 state 的 AI 訊息，加上 middleware 回的 `Command`。 */
export interface ModelStepResult {
  readonly message: AIMessage | undefined;
  readonly commands: readonly Command[];
}

/** 模型洋蔥的固定參數。 */
export interface ModelOnion {
  readonly model: unknown;
  readonly systemMessage: SystemMessage;
  readonly tools: readonly InvokableTool[];
  readonly middleware: readonly LoopMiddleware[];
  /** 環繞最內層那次打模型（`llm/stream`）；不給就直接打。 */
  readonly around?: (call: () => Promise<AIMessage>) => Promise<AIMessage>;
}

/**
 * 跑一次模型呼叫，經過整串 `wrapModelCall`。照 `AgentNode.js` 的 `#invokeModel`，拿掉結構化輸出（nexus 不用 `responseFormat`）。
 * @param onion - 模型、系統訊息、工具、middleware。
 * @param task - 這次呼叫的環境（`model_request:<id>`）。
 * @returns AI 訊息（蓋上 `name = 'model'`）與收集到的 `Command`。
 */
export async function callModel(onion: ModelOnion, task: NodeTask): Promise<ModelStepResult> {
  const state = task.state;
  const registered = new Map(onion.tools.map((tool) => [tool.name, tool]));
  const hasWrapToolCall = onion.middleware.some((m) => m.wrapToolCall !== undefined);
  let currentSystemMessage = onion.systemMessage;
  let lastAiMessage: AIMessage | undefined;
  const collected: Command[] = [];

  const base: ModelHandler = async (request) => {
    const bound = bindTools(request.model, request.tools, {
      ...request.modelSettings,
      tool_choice: request.toolChoice,
    }) as { invoke(messages: BaseMessage[], config: unknown): Promise<AIMessage> };
    const messages = [
      ...(currentSystemMessage.text === '' ? [] : [currentSystemMessage]),
      ...request.messages,
    ];
    const call = () => bound.invoke(messages, task.config);
    const response = await (onion.around === undefined ? call() : onion.around(call));
    lastAiMessage = response;
    return response;
  };

  let wrapped = base;
  for (let i = onion.middleware.length - 1; i >= 0; i--) {
    const middleware = onion.middleware[i]!;
    const wrapModelCall = middleware.wrapModelCall;
    if (wrapModelCall === undefined) continue;
    const inner = wrapped;
    wrapped = async (request) => {
      const baseline = currentSystemMessage;
      const withValidation: ModelHandler = async (req) => {
        currentSystemMessage = baseline;
        const tools = req.tools ?? [];
        const added = tools.filter(
          (tool) => isClientTool(tool) && !registered.has((tool as InvokableTool).name),
        );
        const replaced = tools.filter((tool) => {
          if (!isClientTool(tool)) return false;
          const original = registered.get((tool as InvokableTool).name);
          return original !== undefined && original !== tool;
        });
        if (added.length > 0 && !hasWrapToolCall) {
          throw new Error(
            `You have added a new tool in "wrapModelCall" hook of middleware "${middleware.name}": ${added.map((tool) => (tool as InvokableTool).name).join(', ')}. This is not supported unless a middleware provides a "wrapToolCall" handler to execute it.`,
          );
        }
        if (replaced.length > 0) {
          throw new Error(
            `You have modified a tool in "wrapModelCall" hook of middleware "${middleware.name}": ${replaced.map((tool) => (tool as InvokableTool).name).join(', ')}. This is not supported.`,
          );
        }
        let normalized = req;
        const promptChanged = req.systemPrompt !== currentSystemMessage.text;
        const messageChanged = req.systemMessage !== currentSystemMessage;
        if (promptChanged && messageChanged) {
          throw new Error('Cannot change both systemPrompt and systemMessage in the same request.');
        }
        if (promptChanged) {
          currentSystemMessage = new SystemMessage({
            content: [{ type: 'text', text: req.systemPrompt }],
          });
          normalized = {
            ...req,
            systemPrompt: currentSystemMessage.text,
            systemMessage: currentSystemMessage,
          };
        }
        if (messageChanged) {
          currentSystemMessage = new SystemMessage({ ...req.systemMessage });
          normalized = {
            ...req,
            systemPrompt: currentSystemMessage.text,
            systemMessage: currentSystemMessage,
          };
        }
        const result = await inner(normalized);
        if (isCommand(result) && lastAiMessage !== undefined) {
          if (!collected.includes(result)) collected.push(result);
          return lastAiMessage;
        }
        return result;
      };
      try {
        const response = await wrapModelCall(
          {
            ...request,
            state: { ...state, messages: state.messages },
            runtime: task.runtime(undefined),
          },
          withValidation,
        );
        if (AIMessage.isInstance(response)) lastAiMessage = response;
        else if (isCommand(response)) collected.push(response);
        else {
          throw new Error(
            `Invalid response from "wrapModelCall" in middleware "${middleware.name}": expected AIMessage or Command, got ${typeof response}`,
          );
        }
        return response;
      } catch (error) {
        throw MiddlewareError.wrap(error, middleware.name);
      }
    };
  }

  currentSystemMessage = onion.systemMessage;
  const response = await task.run(() =>
    wrapped({
      model: onion.model,
      systemPrompt: currentSystemMessage.text,
      systemMessage: currentSystemMessage,
      messages: state.messages,
      tools: onion.tools,
      state,
      runtime: task.runtime(undefined),
    }),
  );
  const message = AIMessage.isInstance(response) ? response : lastAiMessage;
  if (message !== undefined) {
    message.name = 'model';
    message.lc_kwargs.name = 'model';
  }
  const commands = [...collected];
  if (isCommand(response) && !commands.includes(response)) commands.unshift(response);
  return { message, commands };
}

/** 有 `invoke` 的物件（非 provider 內建工具），同 langchain 的 `isClientTool`。 */
function isClientTool(tool: unknown): boolean {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    typeof (tool as { invoke?: unknown }).invoke === 'function'
  );
}

/** 找不到工具時的訊息，同 langchain 的 `getInvalidToolError`。 */
function invalidToolError(name: string, available: readonly string[]): string {
  return `Error: ${name} is not a valid tool, try one of [${available.join(', ')}].`;
}

/**
 * 跑一顆工具呼叫，經過整串 `wrapToolCall`。照 `ToolNode.js` 的 `runTool`：工具與 middleware 的錯往外拋（圍堵在最外層接），
 * 參數解析失敗翻成給模型的 `ToolMessage`；工具找不到回錯誤的 `ToolMessage`。
 * @param call - 這顆呼叫。
 * @param tools - 靜態註冊的工具。
 * @param middleware - 整串 middleware。
 * @param task - 這顆工具的環境（`tools:<id>`）。
 * @returns `ToolMessage` 或 `Command`。
 */
export async function runTool(
  call: ToolCall,
  tools: readonly InvokableTool[],
  middleware: readonly LoopMiddleware[],
  task: NodeTask,
): Promise<ToolMessage | Command> {
  const registered = tools.find((tool) => tool.name === call.name);
  const base: ToolHandler = async (request) => {
    const tool = (request.tool ?? tools.find((t) => t.name === request.toolCall.name)) as
      InvokableTool | undefined;
    if (tool === undefined) {
      return new ToolMessage({
        content: invalidToolError(
          request.toolCall.name,
          tools.map((t) => t.name),
        ),
        tool_call_id: request.toolCall.id ?? '',
        name: request.toolCall.name,
        status: 'error',
      });
    }
    // LangChain 的 `tool()` 只掛 `abort` 監聽：拿到已經 abort 的 signal 不會拒絕，本體跑完也不 resolve，永遠懸著。兄弟失敗
    // 舉起來的這一格由 native 自己舉，所以先拋；呼叫端的 `config.signal` 不在這裡先看，跟 `stepSignal`
    // 合成 `task.config.signal` 交給工具，同 LangGraph；已中止時由 `#toolStep` 的競速收掉。
    task.stepSignal?.throwIfAborted();
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
        state: task.state,
        runtime: task.runtime(undefined),
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
