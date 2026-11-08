/**
 * native loop 的 hook 節點（`beforeAgent`、`beforeModel`、`afterAgent`），照 `langchain@1.5.10` 的 `dist/agents/nodes/middleware.js`：
 * state 的視圖、runtime、`jumpTo` 檢查、updates 的形狀。
 *
 * @module
 */

import { hookStateKeys, type LoopState, type StateChannels } from './state.js';
import type { NodeTask } from './langgraph-compat.js';
import {
  hookTargets,
  runtimeOf,
  type Hook,
  type HookFunction,
  type LoopMiddleware,
} from './middleware.js';

function hookFunction(hook: Hook): HookFunction {
  return typeof hook === 'function' ? hook : hook.hook;
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
