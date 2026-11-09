/**
 * 子代理 `maxTurns` 在 `loop: 'native'` 下的那一格：跟 `modelCallLimitMiddleware({ runLimit, exitBehavior: 'end' })` 同一套算法，
 * 不用 native 不收的 `afterModel`。native 下每個子代理都折進它（`fold.ts` 的 `subagentMaxTurns`）：前景子代理由 native loop 直接呼叫
 * 登記的那一步，背景子代理（仍是 LangGraph 的圖，TODO(#2359)）經 `wrapModelCall`、`beforeModel`、`afterAgent`。
 *
 * - **算的是什麼**：這一次 run 裡成功回來的模型呼叫。afterAgent 跳回模型的那一次也算。
 * - **重試只算一次**：串流重打（`streamRetry`）排在這一格內層（`fold.ts` 槽位表），整次重打在這一格的 `next()` 裡完成，`next()` 只回來
 *   一次；`agent/request-error` 要求重試時重跑整串模型格，失敗那次從 `next()` 拋出、不加一，重跑成功那次才加。全部失敗就照樣拋。
 * - **加一的時機**：原版在 afterModel 加，這裡在模型那一步（{@link withModelCallStep}）收到內層結果之後回一份 `Command` 加。
 * - **撞上限**：`beforeModel` 看到 `runLimit <= runModelCallCount` 就跳 `end`，並附上原版那句 `AIMessage`，逐字相同。afterAgent 跳回
 *   模型時不經 `beforeModel`，那一次不受上限擋，同原版。
 * - **歸零**：`afterAgent` 把 run 的計數歸 0。
 *
 * 只實作 nexus 用到的 `runLimit` 與 `exitBehavior: 'end'`。原版的 `threadLimit`、`exitBehavior: 'error'`（與已棄用的 `'throw'`），
 * 以及從 `runtime.context` 覆蓋上限與 `exitBehavior`，這裡都沒有；`threadModelCallCount` 照原版跟著加，讓 state 的鍵跟原版一樣。
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
 * 建 `loop: 'native'` 下子代理 `maxTurns` 的那一格（語意見檔頭）；`langgraph` 照用 `modelCallLimitMiddleware`（`fold.ts` 的
 * `subagentMaxTurns` 那一列）。計數在 agent 的 state 上（`runModelCallCount`、`threadModelCallCount`），不在閉包裡。
 *
 * @param runLimit - 一次 run 最多幾次模型呼叫；是不是正整數由註冊點驗（`registry.ts` 的 `subagents.register`）。
 * @returns 可以放進子代理 middleware 陣列的實例。
 */
export function createSubagentMaxTurnsMiddleware(runLimit: number): AgentMiddleware {
  return withModelCallStep(
    async (request, next) => {
      // 只回計數的 Command：兩個 loop 都用最內層記下的那一則 AI 訊息寫進 state，外層各格拿到的仍是 AI 訊息。
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
