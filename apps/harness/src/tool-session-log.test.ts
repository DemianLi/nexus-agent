/**
 * **模型工具寫得進會話日誌嗎** —— [#134](https://github.com/DemianLi/nexus-agent/issues/134)。
 *
 * dsh 的模型工具靠 `exec.agent.session.append(...)` 寫日誌
 * （`references/deepseek-harness/packages/todo/tool-todo/src/index.ts:210`），而那個
 * `agent` 是 **agent loop 派發工具時主動塞進去的**（`packages/core/agent-loop/src/tool-calls.ts:78`，
 * `ToolExecutionInput.agent` 的註解就寫著 “set by the agent loop”）。**那個派發點是
 * dsh 自己的**；我們的工具是 LangGraph 的 ToolNode 在跑，插不進去。
 *
 * 所以 `@nexus/plugin-goal` 的檔頭把 `tool-goal` 標成「被擋住的，不是取捨」。這個檔案
 * 要問的就是那句話今天還對不對，而答案是**一半**：
 *
 * 1. **「哪一份日誌」早就有答案了** —— per-apply 閉包。`load.ts` 一次組裝呼叫一次
 *    `apply`，而一份 registry 只接一份日誌（`wire-handler.ts` 的 `threadFor` 每個
 *    thread 各 `createAgent` 一次、各 `new ThreadPump` 一份；CLI 那條也是一對一）。
 *    `/goal` 靠的就是這一格，而**工具也在 `apply` 裡註冊**，所以工具也拿得到。
 *    這件事沒有人寫下來也沒有人驗過，第一條測試就是驗它。
 * 2. **「哪一個 agent」還沒有答案。** 見第二條測試 —— 那是絆索不是特性。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SessionLog } from '@nexus/core';
import type { NexusPlugin } from '@nexus/core';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const WRITER_TOOL_NAME = 'writer_tool';

/** 沒接線時工具回的話。**明確講出來，不要靜默 no-op** —— 照 dsh 那句註解的理由。 */
const NOT_ATTACHED = '這次組裝沒有接上會話日誌，所以沒有寫。';

/**
 * 一個會寫日誌的模型工具，走 per-apply 閉包拿那份日誌。
 *
 * @param withSubagent - 要不要順便註冊一個 subagent。
 * @returns 可以放進組裝清單的 plugin。
 */
function writerPlugin(withSubagent: boolean): NexusPlugin {
  return {
    name: 'writer',
    apply(registry) {
      // **這一格活在 `apply` 裡**，同 `@nexus/plugin-goal` 與 `@nexus/plugin-plan-mode`。
      // 放進工廠閉包的話，`serve.ts` 每個 thread 一次組裝會讓兩邊串台。
      let log: SessionLog | undefined;
      registry.sessions.join((subject) => {
        log = subject.log;
        return () => {
          log = undefined;
        };
      });
      registry.tools.register(
        tool(
          ({ note }: { note: string }) => {
            // 沒接線就走得到這裡：命令那一側有 `GOAL_NOT_ATTACHED_MESSAGE`，工具這一側
            // 要有同一句話的等價物。
            if (log === undefined) return NOT_ATTACHED;
            log.append('turn/failed', { message: note });
            return `記了一筆，現在 ${log.length} 筆。`;
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
    const log = new SessionLog('writes');
    const detach = attachSession?.(log);

    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'writes' } });
    } finally {
      detach?.();
      await dispose();
    }

    expect(log.events.map((event) => event.data)).toEqual([{ message: '根寫的' }]);
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
   * **這一條是絆索，不是特性。**
   *
   * dsh 的單一所有者規則是「列表屬於呼叫它的那一個 agent 會話——subagent 與其他 agent
   * 各自維護自己的列表」（`tool-todo/README.zh.md`）。我們今天做不到：per-apply 閉包
   * 給的是**這次組裝**的日誌，而 subagent 跑在同一次組裝裡，所以 root 與 subagent 寫進
   * 同一份。
   *
   * 實測也證實了那條路上沒有現成的分隔：`configurable.thread_id` 在 subagent 裡與 root
   * 相同（分不出），`ls_agent_type` 分得出但那是 LangSmith tracing 的元資料
   * （`ls_` 前綴，不是公開契約），`checkpoint_ns` 分得出但格式沒有承諾。**而就算分得
   * 出來，也沒有第二份日誌可以寫** —— 認得出來與有地方去是兩件事。
   *
   * 所以這一條釘的是現況：**兩筆都在同一份**。哪天真的補了 per-subagent 的日誌，
   * 這一條會紅，而那時它要翻面成「兩筆各在各的」。
   */
  it('root 與 subagent 寫進同一份日誌——那跟 dsh 的單一所有者規則相反', async () => {
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
    const log = new SessionLog('lineage');
    const detach = attachSession?.(log);

    try {
      await agent.invoke(toAgentInvocation('跑。'), { configurable: { thread_id: 'lineage' } });
    } finally {
      detach?.();
      await dispose();
    }

    expect(log.events.map((event) => event.data)).toEqual([
      { message: '根' },
      { message: '子代理' },
    ]);
  });
});
