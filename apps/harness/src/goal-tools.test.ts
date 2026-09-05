/**
 * 模型工具的**行為**驗收——掛進真的 agent、走真的 pump、真的核准點
 * （[#177](https://github.com/DemianLi/nexus-agent/issues/177)）。
 *
 * 判準本身的單元在 `@nexus/plugin-goal` 的 `authority.test.ts`，那一層餵的是手做的事件
 * 序列。**這一份存在是因為那個序列長不長那樣，只有進入點說了算**：`turn/start{resume}`
 * 的**唯一生產者是 `thread-pump.ts:255-261`**（CLI 那條的 `runTurn` 只 append
 * `kind: 'message'`，核准在同一輪的串流迴圈裡就地處理完，所以 CLI 走不到 resume 鏈）。
 * 手寫一段假的事件序列證不到「真的跑一次會長這樣」。
 *
 * **subagent 那半刻意不在這裡重做。** 它由兩條既有的線合起來釘住：
 * `@nexus/plugin-goal` 的 `index.test.ts` 釘「三顆都宣告 `rootOnly`」，`@nexus/core` 的
 * `fold.test.ts` 釘「宣告 `rootOnly` 的工具在每個 subagent 那一份裡被換成拒絕樁」——
 * 而且它用的例子名字就叫 `goal`。在這裡再搭一次 subagent 只會多一份會壞的裝置。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import type { NexusPlugin } from '@nexus/core';
import {
  createGoalPlugin,
  GOAL_CREATE_TOOL_NAME,
  GOAL_TOOL_AUTHORITY_MESSAGE,
  GOAL_TOOL_ERROR_PREFIX,
} from '@nexus/plugin-goal';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { ScriptedTurn } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/** 一顆要人核准的工具，用來把一輪停在核准點。 */
function noteTool() {
  return tool(({ text }: { text: string }) => `已記下：${text}`, {
    name: 'take_note',
    description: '把一段文字記下來。',
    schema: z.object({ text: z.string().describe('要記下的內容') }),
  });
}

/** 掛 goal 域與那顆要核准的工具，回一個接好會話的 pump。 */
async function buildPump(
  threadId: string,
  turns: readonly ScriptedTurn[],
): Promise<{ pump: ThreadPump; stop: () => Promise<void> }> {
  let serial = 0;
  const fixture: NexusPlugin = {
    name: 'goal-tools-fixture',
    apply(registration) {
      registration.tools.register(noteTool());
      registration.approvals.gate((execution, next) =>
        execution.name === 'take_note' ? { kind: 'ask', reason: '看一下' } : next(),
      );
    },
  };
  const { agent, dispose, attachSession } = await createNexusAgent({
    model: new ScriptedChatModel({ turns }) as never,
    plugins: [
      createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` }),
      fixture,
    ],
    checkpointer: new MemorySaver(),
  });
  const pump = new ThreadPump(agent as unknown as PumpAgent, threadId);
  const detach = attachSession(pump.sessions);
  return {
    pump,
    stop: async () => {
      detach();
      await dispose();
    },
  };
}

const CREATE_CALL = {
  name: GOAL_CREATE_TOOL_NAME,
  args: { objective: '把整條升級流程做完' },
};

describe('模型工具走真的 pump', () => {
  it('人打字那一輪，模型建得起目標', async () => {
    const { pump, stop } = await buildPump('goal-web-1', [
      { content: '', toolCalls: [CREATE_CALL] },
      { content: '建好了。' },
    ]);
    try {
      await pump.submit({ kind: 'message', text: '幫我把整條升級流程做完' });
      const changes = pump.sessionLog.events.filter((event) => event.type === 'goal/change');
      expect(changes).toHaveLength(1);
      expect(changes[0]?.data).toMatchObject({
        operation: 'create',
        goal: { objective: '把整條升級流程做完', phase: 'active' },
      });
    } finally {
      await stop();
    }
  }, 20000);

  /**
   * **這一條是這個檔的主角，也是卡片上的驗收句。**
   *
   * 人打字 → 停在核准點 → 人按批准 → 模型在**恢復那一輪**呼叫 `create_goal`。日誌長成
   * `message → interrupt/raised → turn/end → resume`，寫成「最後一顆 `turn/start` 是不是
   * `message`」的實作會在這裡拒絕一個人剛剛動了兩次手的請求。
   */
  it('停在核准點、人批准之後，恢復那一輪照樣建得起目標', async () => {
    const { pump, stop } = await buildPump('goal-web-2', [
      { content: '', toolCalls: [{ name: 'take_note', args: { text: '先記一筆' } }] },
      { content: '', toolCalls: [CREATE_CALL] },
      { content: '建好了。' },
    ]);
    try {
      await pump.submit({ kind: 'message', text: '幫我把整條升級流程做完' });
      // 先確認裝置真的停在核准點——不然下面那一輪證不到 resume 這件事。
      expect(pump.sessionLog.events.map((event) => event.type)).toEqual([
        'turn/start',
        'interrupt/raised',
        'turn/end',
      ]);

      await pump.submit({ kind: 'resume', response: { decisions: [{ type: 'approve' }] } });

      // 恢復那一輪的起點真的是 `resume`，不是又一顆 `message`。
      expect(pump.sessionLog.events[3]?.data).toEqual({ kind: 'resume' });
      const changes = pump.sessionLog.events.filter((event) => event.type === 'goal/change');
      expect(changes).toHaveLength(1);
      expect(changes[0]?.data).toMatchObject({
        goal: { objective: '把整條升級流程做完', phase: 'active' },
      });
    } finally {
      await stop();
    }
  }, 20000);

  /**
   * **對照組：沒有人打過字的那一輪一格都不准動。**
   *
   * 今天的產品路徑造不出這一格（每一輪都由人起頭），所以直接對 pump 的日誌以外的路
   * ——一個沒有任何 `turn/start` 的組裝——驗。它釘住的是「權限那一層真的接在工具上」，
   * 而不是「反正沒有人叫得動它」。
   */
  it('日誌上沒有任何輪次時，create_goal 拒絕而且什麼都沒寫', async () => {
    let serial = 0;
    const { agent, dispose, attachSession } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [{ content: '', toolCalls: [CREATE_CALL] }, { content: '收工。' }],
      }) as never,
      plugins: [createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` })],
    });
    const pump = new ThreadPump(agent as unknown as PumpAgent, 'goal-web-3');
    const detach = attachSession(pump.sessions);
    try {
      // **繞過 pump 的 `submit`**：那條路一定會先 append 一顆 `turn/start{message}`。
      const result = (await (
        agent as unknown as { invoke(input: unknown, config?: unknown): Promise<unknown> }
      ).invoke(
        { messages: [{ role: 'user', content: '偷偷來' }] },
        {
          configurable: { thread_id: 'goal-web-3' },
        },
      )) as { messages: readonly { getType(): string; content: unknown }[] };
      const toolText = result.messages
        .filter((message) => message.getType() === 'tool')
        .map((message) => String(message.content));
      expect(toolText).toContain(GOAL_TOOL_ERROR_PREFIX + GOAL_TOOL_AUTHORITY_MESSAGE);
      expect(pump.sessionLog.events.filter((event) => event.type === 'goal/change')).toEqual([]);
    } finally {
      detach();
      await dispose();
    }
  }, 20000);
});
