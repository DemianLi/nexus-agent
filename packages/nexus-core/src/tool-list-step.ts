/**
 * 決定這一次模型呼叫看到哪些工具的一步（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）：不帶 LangChain 型別的形狀，由佔著
 * middleware 洋蔥那一格的 middleware 經 {@link wrapModelCallWith} 呼叫。
 *
 * 一步拿到這次請求（{@link ToolListRequest}），回換過的工具清單；回 `undefined` 是不換，往內交原本那個請求物件。
 *
 * **同步的一步就同步往內交**：一步同步回清單或 `undefined` 時，{@link wrapModelCallWith} 在同一個 tick 往內交，中間沒有 `await`；
 * 回 `Promise` 的一步（例如要解析 backend 的檔案工具那一格）不論換不換，都等它解開才往內交。
 *
 * **登記了這一步的格**（{@link withToolListStep}；{@link createToolListStepMiddleware} 造的自動登記）由 native 的 root 的模型那一串
 * 直接呼叫（`native-loop/agent.ts` 的 `#modelCells`）；沒登記的格照洋蔥驅動 `wrapModelCall`。
 *
 * @module
 */

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';

/** 一次模型呼叫：`wrapModelCall` 的請求上，一步用得到的那幾格。 */
export interface ToolListRequest {
  /** 外層交下來的工具清單。 */
  readonly tools: readonly unknown[];
  /** 這次呼叫的 agent state，原樣讀穿；目前只有要解析 backend 的那一步交給 `resolveBackend`，自己不讀。 */
  readonly state?: unknown;
  /** 這次呼叫的 runtime，原樣讀穿。 */
  readonly runtime?: object;
}

/** 換過的工具清單；`undefined` 是不換。 */
export type ToolListResult = readonly unknown[] | undefined;

/** 決定這一次模型呼叫看到哪些工具的一步。 */
export type ToolListStep = (request: ToolListRequest) => ToolListResult | Promise<ToolListResult>;

/**
 * 登記的那一份：一步，以及有的話，這一格往內交之前還要經過的那一支 `wrapModelCall`（基座的檔案工具、子代理那兩顆原本的那一支）。
 */
export interface ToolListCell {
  readonly step: ToolListStep;
  readonly inner?: ModelCallWrap;
}

/** `wrapModelCall` 的形狀，請求與結果不看型別。 */
type ModelCallWrap = (request: never, handler: never) => unknown;

/**
 * 把一步轉成 `wrapModelCall`：一步回清單就換掉請求上的 `tools` 再往內交，回 `undefined` 就交原本那個請求；有 `inner` 時交給它，
 * 由它再交給 `handler`。
 *
 * @param step - 這一步。
 * @param inner - 往內交之前還要經過的那一支；不給就直接交給 `handler`。
 * @returns 可以放進 `createMiddleware({ wrapModelCall })` 的函式。
 */
export function wrapModelCallWith<Request extends ToolListRequest, Handler, Result>(
  step: ToolListStep,
  inner?: (request: Request, handler: Handler) => Result,
): (request: Request, handler: Handler) => Result | Promise<Awaited<Result>> {
  return (request, handler) => {
    const pass = (tools: ToolListResult): Result => {
      const next = tools === undefined ? request : { ...request, tools };
      return inner === undefined
        ? (handler as unknown as (request: Request) => Result)(next)
        : inner(next, handler);
    };
    const tools = step(request);
    return tools instanceof Promise ? (tools.then(pass) as Promise<Awaited<Result>>) : pass(tools);
  };
}

/**
 * 只決定工具清單的一顆 middleware，並登記這一步（{@link withToolListStep}）。
 *
 * @param name - middleware 的名字。
 * @param step - 這一步。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createToolListStepMiddleware(name: string, step: ToolListStep): AgentMiddleware {
  return withToolListStep(
    createMiddleware({
      name,
      wrapModelCall: wrapModelCallWith(step) as never,
    }) as unknown as AgentMiddleware,
    step,
  );
}

const registeredCells = new WeakMap<object, ToolListCell>();

/**
 * 登記這顆 middleware 的模型那一格就是 `step`（再經 `inner`）：native 的 root 在這一格直接呼叫它，不經這顆的 `wrapModelCall`
 * （{@link toolListCellOf}）；`langgraph` 與子代理（native 下仍是 LangGraph 子圖，TODO(#2359)）照舊經 `wrapModelCall`。
 * 所以 `wrapModelCall` 必須就是 `wrapModelCallWith(step, inner)`，兩個 loop 才跑同一份實作。要在 `createNativeAgent` 之前登記：
 * 模型那一串在建構時就算好。`wrapModelCall` 標成由洋蔥外面做的格（`handledOutsideOnion`），在那一串裡讀到 `undefined`，native 的 root
 * 不跑這一步。
 * TODO([#2416](https://github.com/DemianLi/nexus-agent/issues/2416))：改成監聽者時收掉。
 *
 * @param middleware - 那一顆；不複製，回同一個物件。
 * @param step - 它的工具清單那一步。
 * @param inner - 往內交之前還要經過的那一支，同 {@link wrapModelCallWith}。
 * @returns `middleware` 本身。
 */
export function withToolListStep<M extends object>(
  middleware: M,
  step: ToolListStep,
  inner?: ModelCallWrap,
): M {
  registeredCells.set(middleware, inner === undefined ? { step } : { step, inner });
  return middleware;
}

/**
 * 這顆 middleware 登記的工具清單那一格（{@link withToolListStep}）；沒登記是 `undefined`。
 * TODO([#2416](https://github.com/DemianLi/nexus-agent/issues/2416))：改成監聽者時收掉。
 *
 * @param middleware - 那一顆，照身分查：複製出來的物件查不到。
 * @returns 那一步與 `inner`。
 */
export function toolListCellOf(middleware: object): ToolListCell | undefined {
  return registeredCells.get(middleware);
}
