/**
 * 環繞一次工具呼叫的一步（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）：不帶 LangChain 型別的形狀，由佔著 middleware 洋蔥那一格的
 * middleware 經 {@link wrapToolCallWith} 呼叫（agent loop 脫離 LangChain，[#2336](https://github.com/DemianLi/nexus-agent/issues/2336)）。
 *
 * 一步拿到這次呼叫（{@link ToolCallSite}）與往內一層（{@link ToolCallNext}）：可以先做事再往內交、不往內交而回自己的結果、
 * 換掉名字、工具本體或參數（{@link ToolCallSubstitute}）再往內交，或看往內交回來的結果再決定回什麼。
 *
 * **結果是不透明的**（{@link ToolCallResult}）：往內交回來的是 `ToolMessage` 或 `Command`；一步要回自己的結果時，造一則
 * `ToolMessage`（`tool-events.ts` 的 `toolRefusal`）。
 *
 * **轉接是同步的**：{@link wrapToolCallWith} 造好 {@link ToolCallSite} 就在同一個 tick 呼叫那一步，中間沒有 `await`。
 * 沙箱政策在委派的那一刻同步拍下快照（`@nexus/plugin-sandbox-policy`），靠的就是這一點。
 *
 * **登記了這一步的格**（{@link withToolCallStep}；{@link createToolCallStepMiddleware} 造的自動登記）由 native 的 root 的工具鏈
 * 直接呼叫（`native-loop/agent.ts` 的 `#toolCells`）；沒登記的格照洋蔥驅動 `wrapToolCall`。
 *
 * @module
 */

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';
import type { ToolCallOwner } from './tool-call-owner.js';

/** 一次工具呼叫：`wrapToolCall` 的請求上，一步用得到的那幾格。 */
export interface ToolCallSite {
  /** 模型給的 `tool_call.id`，原值；沒給是 `undefined`。 */
  readonly callId: string | undefined;
  /** 模型叫的名字（`tool_call.name`）。 */
  readonly name: string;
  /** 解析後的參數：外層沒換過時**就是對話狀態裡那一份**，不是複本，不要改；外層經 `next({ args })` 換過時是換過的那一份。 */
  readonly args: unknown;
  /** 要跑的工具本體；`undefined` 是這個名字沒有工具。 */
  readonly tool: unknown;
  /**
   * loop 交下來的、這一批的助手訊息（`toolCallOwner` 讀它，見 `tool-call-owner.ts`）。native loop 才有這個鍵，
   * `langgraph` 沒有。有沒有這個鍵決定 `toolCallOwner` 讀它還是讀 `state`，所以沒有就不帶這個鍵（不是 `owner: undefined`）。
   */
  readonly owner?: ToolCallOwner | undefined;
  /** 這次呼叫看到的 agent state（`messages` 在裡面）。 */
  readonly state: unknown;
  /**
   * 這次呼叫的 `configurable`：`registry.sessions.forCall({ configurable })` 與這一輪的停止訊號（`turnCancelSignalOf`）都從
   * 這裡讀；這次呼叫自己的取消訊號見 {@link ToolCallSite.signal}。
   */
  readonly configurable: unknown;
  /**
   * 這次呼叫的取消訊號（`runtime.signal`），原樣讀穿，不合併、不替換。
   * TODO([#2416](https://github.com/DemianLi/nexus-agent/issues/2416))：轉接層的過渡，改由 `@nexus/tools` 的訊號合約取代。
   */
  readonly signal: AbortSignal | undefined;
}

/** 一次工具呼叫落定成什麼：`ToolMessage` 或 `Command`。 */
export type ToolCallResult = unknown;

/**
 * 往內交時換掉的格子。以有沒有這個鍵判：給了哪一格（值是 `undefined` 也算），內層看到的就是換過的那一格；`{}` 等於沒換，
 * 內層拿到原本那個請求物件。
 */
export interface ToolCallSubstitute {
  /**
   * 換掉模型叫的名字（`tool_call.name`）：內層拿到的 `tool_call.name`／{@link ToolCallSite.name} 是新名字。工具本體不跟著換
   * （{@link toolNameOfCall} 與最內層的執行都先認 `tool`），要內層照新名字認工具就連 `tool` 一起換。回給模型的結果叫什麼名字，
   * 由換的那一步自己改回。
   */
  readonly name?: string;
  /** 換掉工具本體。 */
  readonly tool?: unknown;
  /** 換掉參數（`tool_call.args`）。 */
  readonly args?: unknown;
}

/** 往內交一層。沒有防重入：呼叫兩次，內層就跑兩次。 */
export type ToolCallNext = (substitute?: ToolCallSubstitute) => Promise<ToolCallResult>;

/** 環繞一次工具呼叫的一步。 */
export type ToolCallStep = (
  call: ToolCallSite,
  next: ToolCallNext,
) => ToolCallResult | Promise<ToolCallResult>;

/** `wrapToolCall` 拿到的請求，這裡用到的格子。 */
interface WrappedRequest {
  readonly toolCall: { readonly id?: string; readonly name: string; readonly args?: unknown };
  readonly tool?: unknown;
  readonly owner?: ToolCallOwner | undefined;
  readonly state?: unknown;
  readonly runtime?: { readonly configurable?: unknown; readonly signal?: AbortSignal };
}

/** 由 `wrapToolCall` 的請求造出 {@link ToolCallSite}。 */
export function toolCallSiteOf(request: WrappedRequest): ToolCallSite {
  return {
    callId: request.toolCall.id,
    name: request.toolCall.name,
    args: request.toolCall.args,
    tool: request.tool,
    ...('owner' in request && { owner: request.owner }),
    state: request.state,
    configurable: request.runtime?.configurable,
    signal: request.runtime?.signal,
  };
}

/** 內層拿到的請求：沒有要換的就是原本那個物件。 */
function substituted<Request extends WrappedRequest>(
  request: Request,
  substitute: ToolCallSubstitute | undefined,
): Request {
  if (substitute === undefined) return request;
  const withTool = 'tool' in substitute ? { ...request, tool: substitute.tool } : request;
  if (!('name' in substitute) && !('args' in substitute)) return withTool;
  return {
    ...withTool,
    toolCall: {
      ...request.toolCall,
      ...('name' in substitute && { name: substitute.name }),
      ...('args' in substitute && { args: substitute.args }),
    },
  };
}

/**
 * 工具名：工具本體的 `name` 是字串就用它，否則用模型叫的名字（`tool_call.name`）。
 *
 * 基座寫的是 `request.tool?.name ?? request.toolCall.name`，但那個 `tool` 是 `ClientTool | ServerTool` 的聯集，`name` 在型別上
 * 收斂成 `{}`——JS 那邊沒事，TS 這邊接不住。所以先確定它真的是字串。
 *
 * @param call - 這次工具呼叫。
 * @returns 工具名。
 */
export function toolNameOfCall(call: Pick<ToolCallSite, 'tool' | 'name'>): string {
  const fromTool: unknown = (call.tool as { readonly name?: unknown } | null | undefined)?.name;
  return typeof fromTool === 'string' ? fromTool : call.name;
}

/** {@link wrapToolCallWith} 造的那一支。 */
export type ToolCallWrap = <Request extends WrappedRequest, Result>(
  request: Request,
  handler: (request: Request) => Result | Promise<Result>,
) => Promise<Result>;

const wrapsOf = new WeakMap<ToolCallStep, ToolCallWrap>();

/**
 * 把一步轉成 `wrapToolCall`。
 *
 * 同一步每次拿到的是同一支函式，{@link withToolCallStep} 靠這一點核對登記的就是這顆在跑的那一支。
 *
 * @param step - 這一步。
 * @returns 交給 `createMiddleware({ wrapToolCall })` 的函式；沒有要換的時，內層拿到的是原本那個請求物件。
 */
export function wrapToolCallWith(step: ToolCallStep): ToolCallWrap {
  const known = wrapsOf.get(step);
  if (known !== undefined) return known;
  const wrap: ToolCallWrap = <Request extends WrappedRequest, Result>(
    request: Request,
    handler: (request: Request) => Result | Promise<Result>,
  ) =>
    Promise.resolve(
      step(toolCallSiteOf(request), (substitute) =>
        Promise.resolve(handler(substituted(request, substitute))),
      ),
    ) as Promise<Result>;
  wrapsOf.set(step, wrap);
  return wrap;
}

/**
 * 只環繞工具呼叫的一顆 middleware，並登記這一步（{@link withToolCallStep}）。
 *
 * @param name - middleware 的名字。
 * @param step - 這一步。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createToolCallStepMiddleware(name: string, step: ToolCallStep): AgentMiddleware {
  return withToolCallStep(
    createMiddleware({ name, wrapToolCall: wrapToolCallWith(step) }) as unknown as AgentMiddleware,
    step,
  );
}

/**
 * {@link wrappedRequestOf} 造的請求形狀，兩個 loop 都只有這幾格：外層請求上的其他鍵不帶過來，吃它的函式照這個型別讀。
 */
export interface WrappedToolRequest {
  readonly toolCall: { readonly id?: string; readonly name: string; readonly args?: unknown };
  readonly tool: unknown;
  readonly owner?: ToolCallOwner | undefined;
  readonly state: unknown;
  readonly runtime: { readonly configurable: unknown; readonly signal: AbortSignal | undefined };
}

/**
 * 由一步拿到的呼叫造回 `wrapToolCall` 請求的形狀，給吃請求形狀的 core 函式用（圍堵、屏障、工具事件的生產者）。
 * `toolCall` 只帶 id、名字與參數；`owner` 這個鍵有才帶（同 {@link toolCallSiteOf}）。
 *
 * @param call - 這次工具呼叫。
 * @returns 請求的形狀；每次造新的，不是外層那個物件。
 */
export function wrappedRequestOf(call: ToolCallSite): WrappedToolRequest {
  return {
    toolCall: {
      ...(call.callId !== undefined && { id: call.callId }),
      name: call.name,
      args: call.args,
    },
    tool: call.tool,
    ...('owner' in call && { owner: call.owner }),
    state: call.state,
    runtime: { configurable: call.configurable, signal: call.signal },
  };
}

const registeredSteps = new WeakMap<object, ToolCallStep>();

/**
 * 登記這顆 middleware 的工具那一格就是 `step`：native 的 root 在這一格直接呼叫它，不經這顆的 `wrapToolCall`
 * （{@link toolCallStepOf}）；`langgraph` 與子代理（native 下仍是 LangGraph 子圖，TODO(#2359)）照舊經 `wrapToolCall`。
 * 所以 `wrapToolCall` 必須就是 `wrapToolCallWith(step)`，兩個 loop 才跑同一份實作；不是就拋。要在 `createNativeAgent` 之前登記：
 * 工具鏈在建構時就算好。`wrapToolCall` 標成由洋蔥外面做的格（`handledOutsideOnion`）不在工具鏈裡。
 * TODO([#2416](https://github.com/DemianLi/nexus-agent/issues/2416))：改成監聽者時收掉。
 *
 * @param middleware - 那一顆；不複製，回同一個物件。
 * @param step - 它的工具那一步。
 * @returns `middleware` 本身。
 * @throws {Error} `middleware.wrapToolCall` 不是 `wrapToolCallWith(step)`。
 */
export function withToolCallStep<M extends object>(middleware: M, step: ToolCallStep): M {
  if ((middleware as { wrapToolCall?: unknown }).wrapToolCall !== wrapToolCallWith(step)) {
    const name = (middleware as { name?: unknown }).name;
    throw new Error(
      `middleware "${String(name)}" 的 wrapToolCall 不是 wrapToolCallWith(step)：native 直接呼叫的那一步會跟它不一樣`,
    );
  }
  registeredSteps.set(middleware, step);
  return middleware;
}

/**
 * 這顆 middleware 登記的工具那一步（{@link withToolCallStep}）；沒登記是 `undefined`。
 * TODO([#2416](https://github.com/DemianLi/nexus-agent/issues/2416))：改成監聽者時收掉。
 *
 * @param middleware - 那一顆，照身分查：複製出來的物件查不到。
 * @returns 那一步。
 */
export function toolCallStepOf(middleware: object): ToolCallStep | undefined {
  return registeredSteps.get(middleware);
}
