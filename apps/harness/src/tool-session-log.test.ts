/**
 * **模型工具寫得進哪一份會話日誌** —— [#134](https://github.com/DemianLi/nexus-agent/issues/134)
 * 開的頭，[#137](https://github.com/DemianLi/nexus-agent/issues/137) 收的尾。
 *
 * dsh 的模型工具靠 `exec.agent.session.append(...)` 寫日誌
 * （`references/deepseek-harness/packages/todo/tool-todo/src/index.ts:210`），而那個
 * `agent` 是 **agent loop 派發工具時主動塞進去的**（`packages/core/agent-loop/src/tool-calls.ts:78`，
 * `ToolExecutionInput.agent` 的註解就寫著 “set by the agent loop”）。**那個派發點是
 * dsh 自己的**；我們的工具是 LangGraph 的 ToolNode 在跑，插不進去。
 *
 * 所以答案分兩半，而兩半現在都有了：
 *
 * 1. **「哪一份日誌」** —— 一次組裝一張會話註冊表（`SessionRegistry`），由
 *    `attachSession` 綁上來。第一條測試驗它。
 * 2. **「哪一個 agent」** —— 從執行期的 `checkpoint_ns` 認出來
 *    （`@nexus/core` 的 `toolCallSessionAddress`），root 與每一次 spawn 各一份。
 *    第三、四條驗它，而**第三條是從絆索翻過來的**：它以前釘的是「兩筆落在同一份」。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SessionRegistry } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const WRITER_TOOL_NAME = 'writer_tool';

/** 沒接線時工具回的話。**明確講出來，不要靜默 no-op** —— 照 dsh 那句註解的理由。 */
const NOT_ATTACHED = '這次組裝沒有接上會話日誌，所以沒有寫。';

/**
 * 認不出呼叫者時回的話。
 *
 * **與 {@link NOT_ATTACHED} 刻意不同一句。** 兩種都是「寫不進去」，但要修的東西不一樣：
 * 一個是組裝點漏了 `attachSession`，一個是這次呼叫根本不在圖裡。併成一句的話，第二種
 * 永遠會被讀成第一種。
 */
const UNKNOWN_CALLER = '認不出這次呼叫屬於哪一個會話，所以沒有寫。';

/** 一次組裝綁著多張註冊表時回的話。同 `@nexus/plugin-goal` 的 `goalAmbiguousMessage`。 */
const AMBIGUOUS = '這次組裝接了不只一份會話，挑不出該寫哪一份，所以沒有寫。';

/**
 * 一個會寫日誌的模型工具，走 `registry.sessions.forCall(config)` 拿自己這次該寫的那一份。
 *
 * **關鍵是它宣告了第二個參數。** 身分只在 `ToolRunnableConfig` 裡，不宣告就永遠拿不到
 * ——那不是機制的漏，是這顆工具沒有要。
 *
 * @param withSubagent - 要不要順便註冊一個 subagent。
 * @returns 可以放進組裝清單的 plugin。
 */
function writerPlugin(withSubagent: boolean): NexusPlugin {
  return {
    name: 'writer',
    apply(registry) {
      registry.tools.register(
        tool(
          ({ note }: { note: string }, config?: unknown) => {
            const found = registry.sessions.forCall(config);
            if (found.kind === 'not-attached') return NOT_ATTACHED;
            if (found.kind === 'unknown-caller') return UNKNOWN_CALLER;
            if (found.kind === 'ambiguous') return AMBIGUOUS;
            found.log.append('turn/failed', { message: note });
            return `記了一筆，現在 ${found.log.length} 筆。`;
          },
          {
            name: WRITER_TOOL_NAME,
            description: '把一句話記進會話日誌。',
            schema: z.object({ note: z.string() }),
          },
        ),
      );
      if (withSubagent) registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  };
}

describe('模型工具與會話日誌', () => {
  it('工具寫得進這次組裝接上的那份日誌', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '記一筆。', toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '根寫的' } }] },
        { content: '好了。' },
      ],
    });
    const { agent, attachSession, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [writerPlugin(false)],
    });
    const sessions = new SessionRegistry('writes');
    const detach = attachSession(sessions);

    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'writes' } });
    } finally {
      detach();
      await dispose();
    }

    expect(sessions.root.events.map((event) => event.data)).toEqual([{ message: '根寫的' }]);
    // 沒有 subagent 就不該有第二份 —— 日誌是懶建的，沒有人問就不該生出來。
    expect(sessions.list()).toHaveLength(1);
  });

  it('沒接線時工具說得出原因，不是靜默 no-op', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '記一筆。', toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '沒人接' } }] },
        { content: '好了。' },
      ],
    });
    // **刻意不呼叫 `attachSession`。** 接線是組裝點的一步，沒有東西攔得住它被略過，
    // 而略過的下場必須說得出口——同 `/goal` 的 `GOAL_NOT_ATTACHED_MESSAGE`。
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [writerPlugin(false)],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('跑。'), {
        configurable: { thread_id: 'unattached' },
      });
      const messages = result.messages as { getType(): string; text: string }[];
      const toolMessage = messages.filter((message) => message.getType() === 'tool').at(-1);

      expect(toolMessage?.text).toBe(NOT_ATTACHED);
    } finally {
      await dispose();
    }
  });

  /**
   * **這一條是翻過面的絆索。**
   *
   * 它以前釘的是現況：root 與 subagent 寫進**同一份**日誌，而那跟 dsh 的單一所有者規則
   * 相反（`tool-todo/README.zh.md`：「subagent 与其他 agent 各自维护自己的列表」）。當時
   * 缺的不只是判斷依據，還缺**第二份日誌可以寫**——認得出來與有地方去是兩件事。
   *
   * 兩件都補上了，所以它反過來寫。**留著這條而不是刪掉**：哪天有人把身分那一層拆掉，
   * 兩筆會重新落回同一份，而紅的就是這裡。
   */
  it('root 與 subagent 各寫各的一份——照 dsh 的單一所有者規則', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '根記一筆。', toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '根' } }] },
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        {
          content: '子代理記一筆。',
          toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '子代理' } }],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
    });
    const { agent, attachSession, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [writerPlugin(true)],
    });
    const sessions = new SessionRegistry('lineage');
    const detach = attachSession(sessions);

    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'lineage' } });
    } finally {
      detach();
      await dispose();
    }

    const entries = sessions.list();
    expect(entries.map((entry) => entry.address.kind)).toEqual(['root', 'subagent']);
    expect(entries[0]?.log.events.map((event) => event.data)).toEqual([{ message: '根' }]);
    expect(entries[1]?.log.events.map((event) => event.data)).toEqual([{ message: '子代理' }]);
    // **血緣讀得出來**：遙測的每一筆帶的是 `session.id`，那是外面唯一分得出誰寫的東西。
    expect(entries[1]?.log.sessionId.startsWith('lineage/')).toBe(true);
  });

  /**
   * **這一條是這張卡最重要的測試**（#137 自己這樣寫的）。
   *
   * 組裝期的路（`registry.tools.register(tool, { scope })`）給得出的最細粒度是
   * **subagent 的名字**，所以同一個 subagent 併發兩次會被併成一格——而那正是這類卡最怕
   * 的靜默合流：兩份狀態變成一份，看起來像正常運作。執行期的身分（`checkpoint_ns` 去掉
   * 最後一段）分得開，這一條釘住它。
   *
   * **斷言刻意不看哪一份是甲哪一份是乙。** 兩個 subagent 併發跑，共用同一份腳本游標，
   * 誰先拿到哪一輪沒有保證；有保證的是**兩份、各一筆**。
   */
  it('同一個 subagent 併發兩次，兩次各自一份', async () => {
    const subagentTurn = {
      content: '子代理記一筆。',
      toolCalls: [{ name: WRITER_TOOL_NAME, args: { note: '子代理' } }],
    };
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '一口氣委派兩次。',
          toolCalls: [
            { name: 'task', args: { description: '幹活甲', subagent_type: 'worker' } },
            { name: 'task', args: { description: '幹活乙', subagent_type: 'worker' } },
          ],
        },
        subagentTurn,
        subagentTurn,
        { content: '子代理收工。' },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
    });
    const { agent, attachSession, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [writerPlugin(true)],
    });
    const sessions = new SessionRegistry('concurrent');
    const detach = attachSession(sessions);

    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'concurrent' } });
    } finally {
      detach();
      await dispose();
    }

    const subagents = sessions.list().filter((entry) => entry.address.kind === 'subagent');
    expect(subagents).toHaveLength(2);
    // 各一筆。合成一份的話這裡會是 `[2, 0]` 或少一個項目。
    expect(subagents.map((entry) => entry.log.length)).toEqual([1, 1]);
    // 兩份的 id 不同——同一個 subagent 名字，不同的執行。
    expect(new Set(subagents.map((entry) => entry.log.sessionId)).size).toBe(2);
  });
});
