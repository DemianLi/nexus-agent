/**
 * 子代理的委派聲明：每次模型呼叫時接在子代理的系統訊息後面
 * （[#324](https://github.com/DemianLi/nexus-agent/issues/324)）。
 *
 * ## 照 dsh
 *
 * dsh 每個進程內子代理的執行期上下文裡固定放一段 `SUBAGENT_DELEGATION_CONTEXT`
 * （`references/deepseek-harness/packages/subagent/subagent/src/child-agent.ts:166-209`，SHA `c291e79`）：
 * 權限範圍在啟動時就固定、需要核准的操作會自動被拒、被拒了不要重試而是在回覆裡交代。它**刻意不放進
 * 系統提示詞**，讓父子的系統提示詞保持一致。字照翻成中文，見 {@link SUBAGENT_DELEGATION_CONTEXT}。
 *
 * 這句話在我們這裡字面為真，靠的是 fold 替子代理另建的那顆核准閘門（管道固定 `policy-never`，見
 * {@link ./fold.ts} 的 `foldSubAgents`）與問答工具的 `rootOnly`。三件是同一張卡的三面，拿掉任何一件，
 * 另外兩件講的就不是實話。
 *
 * ## 載體
 *
 * 我們沒有「執行期上下文」這個槽。最接近的是 `wrapModelCall`：每次呼叫都接上、不改 spec 的
 * `systemPrompt`，同 root 的沙箱政策句（`apps/harness/src/sandbox-policy.ts`）。**由 fold 自己建、
 * 放進每個子代理的清單**：plugin 的 middleware 到不了子代理（[#327](https://github.com/DemianLi/nexus-agent/issues/327)），
 * 而 fold 補的 general-purpose 也要有。
 *
 * **接上，不是取代**：`systemMessage` 在就接在它後面；不在而 `systemPrompt` 有字就接在字後面；兩個都沒有
 * 才只給這一句。子代理有自己的提示詞（general-purpose 那份就是），照抄沙箱政策那段「不在就給
 * `systemPrompt`」的話，在第二種情況會把子代理的提示詞整段換掉。
 *
 * @module
 */

import { createMiddleware } from 'langchain';
import type { AgentMiddleware } from './base-types.js';

/** middleware 的名字。名字不撞基座任何一個，所以它是 novel entry。 */
export const SUBAGENT_DELEGATION_MIDDLEWARE_NAME = 'nexusSubagentDelegation';

/**
 * 子代理每次模型呼叫都看得到的那一段。dsh `SUBAGENT_DELEGATION_CONTEXT` 的中文。
 */
export const SUBAGENT_DELEGATION_CONTEXT =
  '你是被委派的子代理：你的權限範圍在啟動時就固定了，無法在這個 session 裡擴大——' +
  '需要核准的操作會自動被拒絕。任務需要超出這個範圍時，不要重試被拒絕的操作；' +
  '在回覆裡說明這個限制，讓委派你的 agent 處理。';

/**
 * 建一顆把 {@link SUBAGENT_DELEGATION_CONTEXT} 接進系統訊息的 middleware。
 *
 * 無狀態，一份實例走遍每個子代理。
 *
 * @returns 只放進子代理清單的那一顆。
 */
export function createSubagentDelegationMiddleware(): AgentMiddleware {
  return createMiddleware({
    name: SUBAGENT_DELEGATION_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const { systemMessage, systemPrompt } = request;
      if (systemMessage !== undefined) {
        return handler({
          ...request,
          systemMessage: systemMessage.concat(`\n${SUBAGENT_DELEGATION_CONTEXT}`),
        });
      }
      return handler({
        ...request,
        systemPrompt:
          typeof systemPrompt === 'string' && systemPrompt !== ''
            ? `${systemPrompt}\n${SUBAGENT_DELEGATION_CONTEXT}`
            : SUBAGENT_DELEGATION_CONTEXT,
      });
    },
  });
}
