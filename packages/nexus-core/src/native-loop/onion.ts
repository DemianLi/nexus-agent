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
 * 每一層都經 `langgraph-compat.ts` 的 `NodeTask.run` 跑，`getConfig()` 等讀到的是那裡合成的 config。
 *
 * @module
 */

import type { BaseMessage, ToolCall } from '@langchain/core/messages';
import { AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { RunnableBinding } from '@langchain/core/runnables';
import { isCommand, isGraphInterrupt } from '@langchain/langgraph';
import type { Command } from '@langchain/langgraph';
import { ToolInputParsingException } from '@langchain/core/tools';
import { MiddlewareError, ToolInvocationError } from 'langchain';

import { invalidToolMessage } from './invalid-tool.js';
import type { NodeTask } from './langgraph-compat.js';
import { hookStateKeys, type LoopState, type StateChannels } from './state.js';

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
  /**
   * 這一批的助手訊息（`toolCall` 在它的 `tool_calls` 裡）。`toolCallOwner` 讀這一格，不倒著找 `state`；`history-source=log`
   * 的 root 例外，讀日誌（#2355）。
   */
  readonly owner: AIMessage;
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

/** native 可以改由事件或服務做、不再經洋蔥驅動的那幾格。 */
export type NativeHandledPart =
  'beforeAgent' | 'beforeModel' | 'wrapModelCall' | 'wrapToolCall' | 'afterAgent' | 'tools';

const nativeHandled = new WeakMap<object, ReadonlySet<NativeHandledPart>>();

/**
 * 標明這顆 middleware 的某幾格在 native 下已經由事件或服務做，洋蔥不再驅動它們；`langgraph` 照舊跑整顆。一顆 middleware
 * 分兩次搬時，搬出去的那一半在它自己的模組裡標，才不會跑兩次或一次都沒跑。要在 `createNativeAgent` 之前標：洋蔥驅動的那一份
 * 在建構時就算好，之後標的不生效。TODO(#2416)：洋蔥拿掉時一起走。
 * @param middleware - 那一顆；不複製，回同一個物件。
 * @param parts - 改由別處做的格；這顆沒有的格當場拋，標錯不會靜靜沒作用。
 * @returns `middleware` 本身。
 */
export function handledOutsideOnion<M extends LoopMiddleware>(
  middleware: M,
  parts: readonly NativeHandledPart[],
): M {
  const missing = parts.filter((part) => middleware[part as keyof LoopMiddleware] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `middleware "${middleware.name}" 沒有 ${missing.join('、')}，不能標成由洋蔥外面做`,
    );
  }
  nativeHandled.set(middleware, new Set([...(nativeHandled.get(middleware) ?? []), ...parts]));
  return middleware;
}

/**
 * 洋蔥實際驅動的那一份：沒標的原樣回；標了的回一層視圖，標了的格讀到 `undefined`，其餘（名字、`stateSchema`）照讀原物件。
 * @param middleware - 組裝好的那一顆。
 * @returns 洋蔥要驅動的那一份。
 */
export function drivenByOnion(middleware: LoopMiddleware): LoopMiddleware {
  const parts = nativeHandled.get(middleware);
  if (parts === undefined) return middleware;
  const view = Object.create(middleware) as Record<string, unknown>;
  for (const part of parts) {
    Object.defineProperty(view, part, { value: undefined, enumerable: true });
  }
  return view as unknown as LoopMiddleware;
}

/**
 * hook 與 wrap* 拿到的 runtime，取自這個節點的 config。
 * @param task - 這個節點的環境。
 * @param context - `runtime.context`：hook 是凍結的空物件，wrap* 是 `undefined`，同 langchain。
 * @returns 凍結的 runtime。
 */
function runtimeOf(task: NodeTask, context: unknown): Runtime {
  return Object.freeze({
    context,
    store: (task.config as { store?: unknown }).store,
    configurable: task.config.configurable,
    writer: (task.config as { writer?: unknown }).writer,
    interrupt: undefined,
    signal: task.config.signal,
  });
}

function hookFunction(hook: Hook): HookFunction {
  return typeof hook === 'function' ? hook : hook.hook;
}

/** 一顆 hook 宣告的 `canJumpTo`；函式形式的 hook 沒有宣告，回空陣列。 */
export function hookTargets(hook: Hook): readonly string[] {
  return typeof hook === 'function' ? [] : (hook.canJumpTo ?? []);
}

/** 一顆 hook 的跳轉目標。 */
export type JumpTarget = 'model' | 'tools' | 'end' | undefined;

/** 一顆 hook 跑完：寫入已套進 state，回跳轉目標與 CLI `stream()` 的那一筆 updates。 */
export interface HookOutcome {
  readonly jump: JumpTarget;
  /** 同 `nodes/middleware.js` 的回傳值：hook 回 null／undefined 時是 `{}`；否則是讀到的鍵加上寫的鍵，`jumpTo` 與沒值的格不算。 */
  readonly update: Record<string, unknown>;
}

/** 去掉 `jumpTo` 與值是 `undefined` 的格，同 LangGraph 的 updates 不吐沒寫的 channel。 */
function writtenKeys(update: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(update).filter(([key, value]) => key !== 'jumpTo' && value !== undefined),
  );
}

/**
 * 跑一顆 hook（`beforeAgent`、`beforeModel`、`afterAgent`）。照 `nodes/middleware.js`：hook 讀到的 state 只有 `messages` 與
 * 這一顆 `stateSchema` 的鍵（{@link hookStateKeys}）；回傳值是 null／undefined 就不套回傳值（`__pregel_send` 的寫入照樣套）；
 * 跳轉目標要在 `canJumpTo` 裡。
 * @param middleware - 那一顆。
 * @param kind - 哪一種 hook。
 * @param task - 這個節點的環境。
 * @param channels - 合併規則。
 * @returns 跳轉目標與 updates。
 */
export async function runHook(
  middleware: LoopMiddleware,
  kind: 'beforeAgent' | 'beforeModel' | 'afterAgent',
  task: NodeTask,
  channels: StateChannels,
): Promise<HookOutcome> {
  const hook = middleware[kind];
  if (hook === undefined) return { jump: undefined, update: {} };
  const view: LoopState = Object.fromEntries(
    hookStateKeys(middleware.stateSchema).map((key) => [key, task.state[key]]),
  ) as LoopState;
  const result = (await task.run(async () =>
    hookFunction(hook)({ ...view }, runtimeOf(task, Object.freeze({}))),
  )) as Record<string, unknown> | undefined | null;
  task.flush();
  if (result === undefined || result === null) return { jump: undefined, update: {} };
  const jumpTo = result['jumpTo'];
  if (typeof jumpTo === 'string' && !hookTargets(hook).includes(jumpTo)) {
    throw new Error(
      `Invalid jump target: ${jumpTo}, no ${kind}.canJumpTo defined in middleware ${middleware.name}.`,
    );
  }
  const written =
    'type' in result && result['type'] === 'terminate'
      ? terminated(result)
      : (result as Record<string, unknown>);
  channels.apply(task.state, written);
  return { jump: jumpTo as JumpTarget, update: writtenKeys({ ...view, ...written }) };
}

/** `terminate` 動作：帶錯就拋，否則寫它的 `result`。 */
function terminated(result: Record<string, unknown>): Record<string, unknown> {
  if (result['error'] !== undefined) throw result['error'];
  return (result['result'] ?? {}) as Record<string, unknown>;
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
  /**
   * 有沒有誰執行 `wrapModelCall` 新加的工具：任一顆 middleware 的 `wrapToolCall`，含標成由洋蔥外面做的那一格
   * （{@link handledOutsideOnion}）。沒有就拒收新加的工具，同 langchain。
   */
  readonly executesAddedTools: boolean;
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
        if (added.length > 0 && !onion.executesAddedTools) {
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
            runtime: runtimeOf(task, undefined),
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
      runtime: runtimeOf(task, undefined),
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

/**
 * 跑一顆工具呼叫，經過整串 `wrapToolCall`。照 `ToolNode.js` 的 `runTool`：工具與 middleware 的錯往外拋（圍堵在最外層接），
 * 參數解析失敗翻成給模型的 `ToolMessage`；工具找不到回錯誤的 `ToolMessage`。
 * @param call - 這顆呼叫。
 * @param tools - 靜態註冊的工具。
 * @param middleware - 由外到內的那幾格：登記了工具步驟的那幾格，換成直接呼叫那一步的那一份；其餘是洋蔥驅動的那一份（{@link drivenByOnion}）。見 `agent.ts` 的 `#toolCells`。
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
