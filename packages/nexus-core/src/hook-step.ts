/**
 * `beforeAgent`、`beforeModel`、`afterAgent` 的一步（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）：不帶 LangChain 型別的形狀。
 * 一步照 LangChain hook 的位置收這一次的 state 與 runtime，回要寫回 state 的那幾格（可帶 `jumpTo`），或 `undefined` 不寫。
 * 第一個參數是 state：`apps/harness/src/state-readers.test.ts` 照它數讀 state 的地方；`{ step, canJumpTo }` 的 `step` 直接寫成函式時也數，
 * 寫成別處的函式名數不到。
 *
 * **hook 由一步造出來**：{@link createHookStepMiddleware} 收的是一步，那顆 middleware 上的 hook 是 {@link hookWith} 從這一步造的，
 * 同時把這一步登記在那顆上。登記的一步跟 hook 跑的是同一份，分不開。
 *
 * **登記了的 hook** 由 native 的 root 與前景子代理在原位直接呼叫那一步（`native-loop/agent.ts` 的 `#hookCells`），位置、次數與遞迴預算的扣法跟
 * LangGraph 的 hook 節點相同；`langgraph` 與背景子代理（native 下仍是 LangGraph 的圖，TODO(#2359)）照舊經 hook。
 *
 * **同步的一步就同步回**：{@link hookWith} 造的 hook 把一步的回傳原樣交出去，中間沒有 `await`。
 *
 * @module
 */

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';

/** 有一步的那三種 hook。 */
export type HookKind = 'beforeAgent' | 'beforeModel' | 'afterAgent';

/** 要寫回 state 的那幾格，可帶 `jumpTo`；`undefined` 或 `null` 是不寫。 */
export type HookStepResult = Record<string, unknown> | undefined | null;

/**
 * 一個 hook 的一步。`state` 是這一顆讀得到的那幾格（`messages` 加上它 `stateSchema` 宣告的鍵），`runtime` 原樣讀穿
 * （`configurable`、`signal` 等）。
 */
export type HookStep = (
  state: unknown,
  runtime: unknown,
) => HookStepResult | Promise<HookStepResult>;

/** 登記的那一份：一步，與它能跳到哪裡。 */
export interface HookStepCell {
  readonly step: HookStep;
  /** 同 LangChain hook 的 `canJumpTo`；不給就不能帶 `jumpTo`，帶了 native 當場拋。 */
  readonly canJumpTo?: readonly ('model' | 'tools' | 'end')[];
}

/** {@link createHookStepMiddleware} 收的一格：一步，或一步加上 `canJumpTo`。 */
export type HookStepSpec = HookStep | HookStepCell;

/** LangChain 的 hook 形狀：函式，或帶 `canJumpTo` 的物件。 */
type LangChainHook =
  | ((state: unknown, runtime: unknown) => unknown)
  | {
      readonly hook: (state: unknown, runtime: unknown) => unknown;
      readonly canJumpTo: readonly string[];
    };

/**
 * 從一步造 hook：拿 `(state, runtime)` 叫那一步，回傳原樣交出去。
 *
 * @param cell - 一步與 `canJumpTo`。
 * @returns 可以放進 `createMiddleware` 的 hook。
 */
export function hookWith(cell: HookStepCell): LangChainHook {
  const hook = (state: unknown, runtime: unknown): unknown => cell.step(state, runtime);
  return cell.canJumpTo === undefined ? hook : { hook, canJumpTo: cell.canJumpTo };
}

function cellOf(spec: HookStepSpec): HookStepCell {
  return typeof spec === 'function' ? { step: spec } : spec;
}

/** 有一步的那三種 hook。 */
export const HOOK_KINDS: readonly HookKind[] = ['beforeAgent', 'beforeModel', 'afterAgent'];

const registeredCells = new WeakMap<object, ReadonlyMap<HookKind, HookStepCell>>();

/**
 * 造一顆 middleware：`beforeAgent`、`beforeModel`、`afterAgent` 給的是一步，hook 由 {@link hookWith} 從它造，並登記在這一顆上；
 * 其餘欄位（`name`、`stateSchema`、`wrapModelCall`、`wrapToolCall` 等）原樣交給 `createMiddleware`。
 * TODO([#2363](https://github.com/DemianLi/nexus-agent/issues/2363))：`langgraph` 那條路徑拿掉、內建不再造成 middleware 時收掉。
 *
 * @param options - `createMiddleware` 的選項，三種 hook 換成一步。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createHookStepMiddleware(
  options: { readonly name: string } & { readonly [K in HookKind]?: HookStepSpec } & Record<
      string,
      unknown
    >,
): AgentMiddleware {
  const cells = new Map<HookKind, HookStepCell>();
  const init: Record<string, unknown> = { ...options };
  for (const kind of HOOK_KINDS) {
    const spec = options[kind];
    if (spec === undefined) continue;
    const cell = cellOf(spec);
    cells.set(kind, cell);
    init[kind] = hookWith(cell);
  }
  const middleware = createMiddleware(init as never) as unknown as AgentMiddleware;
  registeredCells.set(middleware, cells);
  return middleware;
}

/**
 * 這顆 middleware 的這一種 hook 登記的那一步（{@link createHookStepMiddleware}）；沒登記是 `undefined`。
 * TODO([#2363](https://github.com/DemianLi/nexus-agent/issues/2363))：`langgraph` 那條路徑拿掉、內建不再造成 middleware 時收掉。
 *
 * @param middleware - 那一顆，照身分查：複製出來的物件查不到。
 * @param kind - 哪一種 hook。
 * @returns 那一步與 `canJumpTo`。
 */
export function hookStepOf(middleware: object, kind: HookKind): HookStepCell | undefined {
  return registeredCells.get(middleware)?.get(kind);
}
