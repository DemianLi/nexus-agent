/**
 * `langgraph` 下派 `agent/pre-step` 的轉接格：native 由迴圈自己派（`native-loop/agent.ts`），`langgraph` 沒有那個迴圈，
 * 由這一顆在 `wrapModelCall` 的頭上派同一個事件，監聽者只寫一份。
 *
 * **時機是每一次模型呼叫**，跟 native 的「每一步一次」不同：重試與 `afterAgent` 跳回模型那一次也派，監聽者要是冪等的。
 * 不用 `beforeModel`：那會讓每一步多一個 super-step，改到步數上限。
 *
 * **排在 `plugins.prepended` 之前**（槽位表；有補回 `name` 那一顆時隔著它）：插件 middleware 的 `wrapModelCall` 與它們登記的提示詞段都在這一顆裡面，
 * 所以監聽者在這裡改的狀態，同一次呼叫的提示詞段照改過的判。
 *
 * **只折進 root**，而且只在 `langgraph` 下、有監聽者時掛：native 掛了會派兩次；沒有監聽者時不多一顆。
 *
 * 監聽者回 `{ kind: 'reject' }` 時這一輪收成被擋下（拋 {@link TurnBlockedError}）；沒擋下、而這一輪在監聽者跑的期間中止了，
 * 就不往內交（{@link stopHere}，拋 `TurnCancelledError`）：那一步的請求快照與起訖都不寫，模型不被叫。reject 先判。
 * 兩條都同 native：native 在整串 middleware 之前派，中止由外層 `turn-cancel.ts` 的 guard 擋下。載荷的 `step` 在這裡一律是 `0`：
 * `langgraph` 沒有步數可數，同 `turn-stopping.ts`。
 *
 * TODO([#2363](https://github.com/DemianLi/nexus-agent/issues/2363))：`langgraph` 那條路徑拿掉時，跟 `turn-stopping.ts` 一起收掉。
 *
 * @module
 */

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import { TurnBlockedError } from './archive-gate.js';
import type { EventDispatcher } from './events.js';
import { callThreadId } from './session-address.js';
import { stopHere, turnCancelSignalOf } from './turn-cancel.js';

/** 這一顆的名字。 */
export const PRE_STEP_ADAPTER_MIDDLEWARE_NAME = 'nexusPreStep';

/** 沒有這一輪的中止訊號時給的那一個：永遠不會中止。 */
const NEVER_ABORTED = new AbortController().signal;

/**
 * 建那一顆。**無狀態**：thread 與中止訊號每次從那一次呼叫的 `configurable` 現讀。
 *
 * @param events - 派發面。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createPreStepAdapterMiddleware(events: EventDispatcher): AgentMiddleware {
  return createMiddleware({
    name: PRE_STEP_ADAPTER_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      const configurable = (request as { runtime?: { configurable?: unknown } }).runtime
        ?.configurable;
      const signal = turnCancelSignalOf({ configurable }) ?? NEVER_ABORTED;
      const decision = await events.waterfall(
        'agent/pre-step',
        { threadId: callThreadId({ configurable }), step: 0, signal },
        async () => ({ kind: 'continue' as const }),
      );
      if (decision.kind === 'reject') throw new TurnBlockedError();
      // 監聽者跑的期間按了停止：外層的 guard 已經放行過，這裡不看就會往內寫起訖、叫模型。
      if (signal.aborted) return stopHere(request);
      return handler(request);
    },
  }) as unknown as AgentMiddleware;
}
