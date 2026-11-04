/**
 * 環繞一次工具呼叫的一步（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）：不帶 LangChain 型別的形狀，由佔著 middleware 洋蔥那一格的
 * middleware 經 {@link wrapToolCallWith} 呼叫（agent loop 脫離 LangChain，[#2336](https://github.com/DemianLi/nexus-agent/issues/2336)）。
 *
 * 一步拿到這次呼叫（{@link ToolCallSite}）與往內一層（{@link ToolCallNext}）：可以先做事再往內交、不往內交而回自己的結果、
 * 換掉工具本體或參數（{@link ToolCallSubstitute}）再往內交，或看往內交回來的結果再決定回什麼。
 *
 * **結果是不透明的**（{@link ToolCallResult}）：往內交回來的是 `ToolMessage` 或 `Command`；一步要回自己的結果時，造一則
 * `ToolMessage`（`tool-events.ts` 的 `toolRefusal`）。
 *
 * **轉接是同步的**：{@link wrapToolCallWith} 造好 {@link ToolCallSite} 就在同一個 tick 呼叫那一步，中間沒有 `await`。
 * 沙箱政策在委派的那一刻同步拍下快照（`@nexus/plugin-sandbox-policy`），靠的就是這一點。
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
   * `langgraph` 沒有。
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
  return 'args' in substitute
    ? { ...withTool, toolCall: { ...request.toolCall, args: substitute.args } }
    : withTool;
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

/**
 * 把一步轉成 `wrapToolCall`。
 *
 * @param step - 這一步。
 * @returns 交給 `createMiddleware({ wrapToolCall })` 的函式；沒有要換的時，內層拿到的是原本那個請求物件。
 */
export function wrapToolCallWith(
  step: ToolCallStep,
): <Request extends WrappedRequest, Result>(
  request: Request,
  handler: (request: Request) => Result | Promise<Result>,
) => Promise<Result> {
  return <Request extends WrappedRequest, Result>(
    request: Request,
    handler: (request: Request) => Result | Promise<Result>,
  ) =>
    Promise.resolve(
      step(toolCallSiteOf(request), (substitute) =>
        Promise.resolve(handler(substituted(request, substitute))),
      ),
    ) as Promise<Result>;
}

/**
 * 只環繞工具呼叫的一顆 middleware。
 *
 * @param name - middleware 的名字。
 * @param step - 這一步。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createToolCallStepMiddleware(name: string, step: ToolCallStep): AgentMiddleware {
  return createMiddleware({
    name,
    wrapToolCall: wrapToolCallWith(step),
  }) as unknown as AgentMiddleware;
}
