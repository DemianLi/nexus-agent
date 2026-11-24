/**
 * `langgraph` 下派 `agent/turn-stopping` 的轉接格：native 由迴圈自己派（`native-loop/agent.ts`），`langgraph` 沒有那個迴圈，
 * 由這一顆在 `afterAgent` 派同一個事件，監聽者只寫一份。
 *
 * **排在 stepInbox 前面**（槽位表）：`afterAgent` 反序跑，某一顆跳回模型時，排在它前面的那幾顆不跑。stepInbox 接到插話跳回模型
 * 那一次，這一顆因此不跑；真的要停時它最後跑、只跑一次，同 native「`afterAgent` 跑完、沒有跳回模型才派」。`beforeModel` 跳
 * `end`、這一輪拋錯時 `afterAgent` 整串不跑，這一顆也不派，同 native。
 *
 * **只折進 root**，而且只在 `langgraph` 下、有監聽者時掛：native 掛了會派兩次；沒有監聽者時不多一顆節點。
 *
 * `afterAgent` 依序 await 每一位監聽者才交回、不改 state；監聽者拋錯時 `afterAgent` 照拋。
 *
 * 載荷的 `step` 在這裡一律是 `0`：`langgraph` 沒有 `agent/pre-step` 可數，見事件的 JSDoc。
 *
 * @module
 */

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from 'langchain';

import type { EventDispatcher } from './events.js';
import { callThreadId } from './session-address.js';
import { turnCancelSignalOf } from './turn-cancel.js';

/** 這一顆的名字。 */
export const TURN_STOPPING_MIDDLEWARE_NAME = 'nexusTurnStopping';

/** 沒有這一輪的中止訊號時給的那一個：永遠不會中止。 */
const NEVER_ABORTED = new AbortController().signal;

/**
 * 建那一顆。**無狀態**：thread 與中止訊號每次從那一次呼叫的 `configurable` 現讀。
 *
 * @param events - 派發面。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createTurnStoppingMiddleware(events: EventDispatcher): AgentMiddleware {
  return createMiddleware({
    name: TURN_STOPPING_MIDDLEWARE_NAME,
    afterAgent: async (_state, runtime) => {
      const configurable = (runtime as { configurable?: unknown } | null | undefined)?.configurable;
      await events.serial('agent/turn-stopping', {
        threadId: callThreadId({ configurable }),
        step: 0,
        signal: turnCancelSignalOf({ configurable }) ?? NEVER_ABORTED,
      });
      return undefined;
    },
  }) as unknown as AgentMiddleware;
}
