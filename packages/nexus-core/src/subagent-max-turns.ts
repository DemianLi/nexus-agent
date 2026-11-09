/**
 * native 子代理的模型呼叫上限：跟 `modelCallLimitMiddleware({ runLimit, exitBehavior: 'end' })` 同一套算法，只是不用 native 不收的
 * `afterModel`。
 *
 * - **算的是什麼**：這一次 run 裡成功回來的模型呼叫。afterAgent 跳回模型的那一次也算。失敗之後重試成功只算一次，因為失敗那次往外拋，
 *   不會走到加一。
 * - **加一的時機**：原版在 afterModel 加，這裡在模型那一步（{@link withModelCallStep}）收到內層結果之後回一份 `Command` 加。
 * - **撞上限**：`beforeModel` 看到 `runLimit <= runModelCallCount` 就跳 `end`，並附上原版那句 `AIMessage`，逐字相同。
 * - **歸零**：`afterAgent` 把 run 的計數歸 0。
 *
 * 只實作 nexus 用到的 `runLimit` 與 `exitBehavior: 'end'`。原版的 `threadLimit`、`exitBehavior: 'error'`，以及從 `runtime.context`
 * 覆蓋上限，這裡都沒有；`threadModelCallCount` 照原版跟著加，讓 state 的鍵跟原版一樣。
 *
 * TODO([#2359](https://github.com/DemianLi/nexus-agent/issues/2359))：過渡用。子代理撞上限的寫入方改成
 * `turn/end{reason:{kind:'max-turns'}}` 時拿掉。
 *
 * @module
 */

import { AIMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';
import type { AgentMiddleware } from 'langchain';
import { z } from 'zod';

import { createHookStepMiddleware } from './hook-step.js';
import { withModelCallStep } from './model-call-step.js';

/** 跟原版同名：節點名（`ModelCallLimitMiddleware.before_model` 等）因此兩個 loop 一樣。 */
const NAME = 'ModelCallLimitMiddleware';

interface Counts {
  readonly runModelCallCount?: number;
  readonly threadModelCallCount?: number;
}

/**
 * 建那一顆。
 *
 * @param runLimit - 一次 run 最多幾次模型呼叫。
 * @returns 可以放進子代理 middleware 陣列的實例。
 */
export function createSubagentMaxTurnsMiddleware(runLimit: number): AgentMiddleware {
  return withModelCallStep(
    async (request, next) => {
      await next(request);
      const state = (request as { state?: Counts }).state;
      return new Command({
        update: {
          runModelCallCount: (state?.runModelCallCount ?? 0) + 1,
          threadModelCallCount: (state?.threadModelCallCount ?? 0) + 1,
        },
      });
    },
    (wrapModelCall) =>
      createHookStepMiddleware({
        name: NAME,
        stateSchema: z.object({
          threadModelCallCount: z.number().default(0),
          runModelCallCount: z.number().default(0),
        }),
        beforeModel: {
          canJumpTo: ['end'],
          step: (state) => {
            const runCount = (state as Counts).runModelCallCount ?? 0;
            if (runLimit > runCount) return undefined;
            return {
              jumpTo: 'end' as const,
              messages: [
                new AIMessage(
                  `Model call limits exceeded: run level call limit reached with ${runCount} model calls`,
                ),
              ],
            };
          },
        },
        afterAgent: () => ({ runModelCallCount: 0 }),
        wrapModelCall,
      }),
  ) as AgentMiddleware;
}
