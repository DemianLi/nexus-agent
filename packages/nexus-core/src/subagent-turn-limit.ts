/**
 * native 下前景子代理撞到 `maxTurns` 時，`task` 交回 root 的結果。
 *
 * 子代理自己不合成訊息、子日誌不記這一輪（前景的子日誌沒有輪）：撞上限只經 `task` 的結果讓 root 知道。結果是子代理最後一則有字的回覆
 * 接一句上限說明；一則有字的都沒有就只有說明。基座的 `task` 取回傳 `messages` 裡最後一則有字的 AI 訊息當工具結果，所以這裡在
 * **回傳值**後面多接一則 AI 訊息；native agent 的 state 與子日誌都不經過它。
 *
 * @module
 */

import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';

import { RUN_STOP_CONFIG_KEY, type RunStopReason } from './native-loop/agent.js';

/** 上限說明，給 root 的模型看。 */
export function subagentTurnLimitNote(limit: number): string {
  return `The subagent stopped after reaching its model call limit (${limit} model calls); its work may be unfinished.`;
}

/** 基座 `task` 取工具結果的同一個判準：AI 訊息去頭尾空白之後的文字。 */
function textOf(message: BaseMessage): string {
  return typeof message.content === 'string' ? message.content.trim() : message.text.trim();
}

/** 交回 root 的那一則：最後一則有字的 AI 回覆接上限說明，沒有就只有說明。 */
export function subagentTurnLimitReply(messages: readonly BaseMessage[], limit: number): string {
  const note = subagentTurnLimitNote(limit);
  const last = messages.findLast((m) => AIMessage.isInstance(m) && textOf(m) !== '');
  return last === undefined ? note : `${textOf(last)}\n\n${note}`;
}

interface Invokable {
  invoke(
    input: unknown,
    config?: RunnableConfig,
  ): Promise<{ readonly messages?: readonly BaseMessage[] }>;
}

/**
 * 包住交給基座的前景子代理：撞上限的那一次，回傳值的 `messages` 後面多一則 {@link subagentTurnLimitReply}。沒撞就原樣交回。
 * @param agent - `subagent: true`、給了 `maxTurns` 的 native agent。
 * @returns 只有 `invoke` 的 runnable（基座的 `task` 只叫它）。
 */
export function withSubagentTurnLimitReply(agent: Invokable): Invokable {
  return {
    async invoke(input, config = {}) {
      let stop: RunStopReason | undefined;
      const output = await agent.invoke(input, {
        ...config,
        configurable: {
          ...config.configurable,
          [RUN_STOP_CONFIG_KEY]: (reason: RunStopReason) => {
            stop = reason;
          },
        },
      });
      if (stop === undefined) return output;
      const messages = output.messages ?? [];
      return {
        ...output,
        messages: [...messages, new AIMessage(subagentTurnLimitReply(messages, stop.limit))],
      };
    },
  };
}
