/**
 * `langgraph` 下派 `agent/pre-step` 的轉接格：native 由迴圈自己派（`native-loop/agent.ts`），`langgraph` 沒有那個迴圈，
 * 由這一顆在 `wrapModelCall` 的頭上派同一個事件，監聽者只寫一份。
 *
 * **時機是每一次模型呼叫**，跟 native 的「每一步一次」不同：重試與 `afterAgent` 跳回模型那一次也派，監聽者要是冪等的。
 * 不改用 `beforeModel`：那會讓每一步多一個 super-step，改到步數上限。
 *
 * **排在 `plugins.prepended` 正前面**（槽位表）：插件 middleware 的 `wrapModelCall` 與它們登記的提示詞段都在這一顆裡面，
 * 所以監聽者在這裡改的狀態，同一次呼叫的提示詞段照改過的判。
 *
 * **只折進 root**，而且只在 `langgraph` 下、有監聽者時掛：native 掛了會派兩次；沒有監聽者時不多一顆。
 *
 * 監聽者回 `{ kind: 'reject' }` 時這一輪收成被擋下（拋 {@link TurnBlockedError}），同 native。載荷的 `step` 在這裡一律是 `0`：
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
import { turnCancelSignalOf } from './turn-cancel.js';

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
      const decision = await events.waterfall(
        'agent/pre-step',
        {
          threadId: callThreadId({ configurable }),
          step: 0,
          signal: turnCancelSignalOf({ configurable }) ?? NEVER_ABORTED,
        },
        async () => ({ kind: 'continue' as const }),
      );
      if (decision.kind === 'reject') throw new TurnBlockedError();
      return handler(request);
    },
  }) as unknown as AgentMiddleware;
}
