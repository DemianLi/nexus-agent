/**
 * **模型拿到的拒絕，會話日誌上記成錯誤**——[#273](https://github.com/DemianLi/nexus-agent/issues/273)
 * 的驗收，量的是真的組裝跑完之後日誌記下什麼。
 *
 * 每一種拒絕的文字與碼在各自套件的單元測試；這一份量的是掛進真的組裝之後圍堵讀不讀得到。
 * 碼掛在一張以訊息為鍵的 `WeakMap` 上（`@nexus/core` 的 `tool-events.ts`），從 plugin 套件
 * 標、在 core 讀、中間隔一整條 middleware 鏈——那張表跨不跨得過去只有這一層驗得到。
 *
 * 另外三列就地加在各自原本的組裝測試裡：todo 驗證失敗在 `todo-tool.test.ts`，goal 權限不足在
 * `goal-tools.test.ts`，計劃模式外在 `plan-mode.test.ts`。
 *
 * **組裝沒接好的那幾條沒有日誌可記**：圍堵找日誌走的是同一個 `forCall`，工具找不到，它也
 * 找不到。那幾條看得到的只有回給模型那則訊息的狀態，最後一條量的就是這件事。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { SessionRegistry } from '@nexus/core';
import type { NexusPlugin, SessionEvent } from '@nexus/core';
import {
  createGoalPlugin,
  GOAL_CREATE_TOOL_NAME,
  GOAL_GET_TOOL_NAME,
  GOAL_UPDATE_TOOL_NAME,
} from '@nexus/plugin-goal';
import { createTodoPlugin, TODO_TOOL_NAME, todoAmbiguousMessage } from '@nexus/plugin-todo';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';

/** 一份日誌上每一顆 `tool/result` 的內容，依序。 */
function resultsOf(events: readonly SessionEvent[]): unknown[] {
  return events.flatMap((event) => (event.type === 'tool/result' ? [event.data] : []));
}

describe('拒絕在日誌上記成錯誤', () => {
  /**
   * 三次呼叫在同一輪人打的字裡：第一次建得起來，第二次撞上域的拒絕，第三次參數不成形。
   * 走 pump 是因為 goal 的權限要一顆人打的 `turn/start`，那顆只有進入點寫。
   */
  it('goal：域的拒絕帶域的碼，參數不成形帶工具層的碼', async () => {
    let serial = 0;
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '',
            toolCalls: [{ name: GOAL_CREATE_TOOL_NAME, args: { objective: '第一個' } }],
          },
          {
            content: '',
            toolCalls: [{ name: GOAL_CREATE_TOOL_NAME, args: { objective: '第二個' } }],
          },
          {
            content: '',
            toolCalls: [
              { name: GOAL_UPDATE_TOOL_NAME, args: { goal_id: '', revision: 1, action: 'pause' } },
            ],
          },
          { content: '收工。' },
        ],
      }) as never,
      plugins: [createGoalPlugin({ now: () => 100, newGoalId: () => `goal-${(serial += 1)}` })],
      checkpointer: new MemorySaver(),
    });
    const pump = new ThreadPump(agent as unknown as PumpAgent, 'refusals-goal');
    const detach = attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '幫我把事情做完' });
    } finally {
      detach();
      await dispose();
    }

    expect(resultsOf(pump.sessionLog.events)).toEqual([
      { callId: expect.any(String), isError: false },
      {
        callId: expect.any(String),
        isError: true,
        error: { name: 'GoalError', code: 'GOAL_ALREADY_EXISTS' },
      },
      {
        callId: expect.any(String),
        isError: true,
        error: { name: 'HarnessError', code: 'GOAL_TOOL_INVALID_UPDATE' },
      },
    ]);
  }, 20000);

  /** goal 工具宣告 `rootOnly`，subagent 那一份拿到的是 fold 換上的樁。 */
  it('root-only 樁：subagent 那一份日誌上記成錯誤、不帶碼', async () => {
    const worker: NexusPlugin = {
      name: 'worker-host',
      apply(registry) {
        registry.subagents.register({ name: 'worker', description: '幹活的。' });
      },
    };
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '委派。',
            toolCalls: [{ name: 'task', args: { description: '看目標', subagent_type: 'worker' } }],
          },
          { content: '', toolCalls: [{ name: GOAL_GET_TOOL_NAME, args: {} }] },
          { content: '子代理收工。' },
          { content: '根收工。' },
          { content: '根再收一次。' },
        ],
      }),
      checkpointer: new MemorySaver(),
      plugins: [createGoalPlugin(), worker],
    });
    const sessions = new SessionRegistry('refusals-stub');
    const detach = attachSession(sessions);
    try {
      await agent.invoke(toAgentInvocation('跑。'), {
        configurable: { thread_id: 'refusals-stub' },
      });
    } finally {
      detach();
      await dispose();
    }

    const subagents = sessions
      .list()
      .filter((entry) => entry.address.kind === 'subagent')
      .map((entry) => entry.log.events);
    expect(subagents).toHaveLength(1);
    expect(resultsOf(subagents[0] ?? [])).toEqual([{ callId: expect.any(String), isError: true }]);
  }, 20000);

  /**
   * **組裝沒接好的那一類：錯誤只看得到在訊息上，日誌一顆事件都沒有。** 綁兩份會話是真的
   * 組裝裡造得出「挑不出哪一份」的唯一辦法；圍堵同樣挑不出來，所以兩份都是空的。
   */
  it('挑不出哪一份：回給模型的是錯誤，兩份日誌上什麼都沒有', async () => {
    const { agent, attachSession, dispose } = await createNexusAgent({
      model: new ScriptedChatModel({
        turns: [
          {
            content: '',
            toolCalls: [
              { name: TODO_TOOL_NAME, args: { todos: [{ content: '甲', status: 'pending' }] } },
            ],
          },
          { content: '收工。' },
          { content: '再收一次。' },
        ],
      }),
      checkpointer: new MemorySaver(),
      plugins: [createTodoPlugin({ allowParallelInProgress: true })],
    });
    const first = new SessionRegistry('refusals-a');
    const second = new SessionRegistry('refusals-b');
    const detachFirst = attachSession(first);
    const detachSecond = attachSession(second);
    let result;
    try {
      result = await agent.invoke(toAgentInvocation('跑。'), {
        configurable: { thread_id: 'refusals-a' },
      });
    } finally {
      detachSecond();
      detachFirst();
      await dispose();
    }

    const answers = (result.messages as BaseMessage[]).flatMap((message) =>
      ToolMessage.isInstance(message) ? [{ text: message.text, status: message.status }] : [],
    );
    expect(answers).toEqual([{ text: todoAmbiguousMessage(2), status: 'error' }]);
    expect([...first.root.events, ...second.root.events]).toEqual([]);
  }, 20000);
});
