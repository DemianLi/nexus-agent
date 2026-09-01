/**
 * **root-only 的工具在真的組裝裡擋不擋得住 subagent** ——
 * [#134](https://github.com/DemianLi/nexus-agent/issues/134)。
 *
 * dsh 的 `tool-goal` 對 subagent 的態度是**直接拒絕**：`hasDirectHumanInput` 的第一道
 * 就是 `ctx.agents.roots().includes(execution.agent)`，工具描述自己寫著 “Execution
 * rejects non-human and subagent authority.”（`references/deepseek-harness/packages/goal/
 * tool-goal/src/authority.ts`、`src/index.ts:48`，SHA
 * `0a53fb55bea101816fa226bb964ae2bed71c343b`）。**所以「拒絕」不是我們的偏離，它就是
 * dsh 對這一類工具的政策**——dsh 只有 `tool-todo` 那一類才給 subagent 各自一份。
 *
 * dsh 靠 `exec.agent` 在執行期問出「誰在叫」，那個欄位是它自己的 agent loop 派發時塞的
 * （`packages/core/agent-loop/src/tool-calls.ts:78`），而**我們的派發點是 LangGraph 的
 * ToolNode，插不進去**（見 [`tool-session-log.test.ts`](./tool-session-log.test.ts)）。
 *
 * 我們換的地方是**組裝期**：fold 給每個 subagent 的是一份自己的工具陣列，所以 root-only
 * 的那顆在那份裡被換成同名的拒絕樁。**整條路上一次都沒有讀 `configurable`**——不看
 * `thread_id`、不看 `ls_agent_type`（那是 LangSmith tracing 的元資料）、也不看
 * `checkpoint_ns`（格式沒有承諾）。判別發生在組裝期，升版動不到它。
 *
 * core 那側的規則測試在 [`fold.test.ts`](../../../packages/nexus-core/src/fold.test.ts)。
 * 這個檔案問的是**基座真的照那份陣列給工具嗎**——那是 fold 的輸入輸出斷言不到的。
 */

import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { NexusPlugin } from '@nexus/core';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const TOOL_NAME = 'root_only_probe';
const REAL_RESULT = '真的那一顆跑了。';

/**
 * 一個 root-only 的工具，加一個 subagent。
 *
 * @param calls - 真的那一顆每被叫到一次就推一筆。
 * @returns 可以放進組裝清單的 plugin。
 */
function rootOnlyPlugin(calls: string[]): NexusPlugin {
  return {
    name: 'root-only',
    apply(registry) {
      registry.tools.register(
        tool(
          () => {
            calls.push(TOOL_NAME);
            return REAL_RESULT;
          },
          {
            name: TOOL_NAME,
            description: '只有 root 叫得動的探針。',
            schema: z.object({}),
          },
        ),
        { rootOnly: true },
      );
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  };
}

describe('root-only 的工具', () => {
  it('root 叫得動真的那一顆', async () => {
    const calls: string[] = [];
    const model = new ScriptedChatModel({
      turns: [
        { content: '叫一下。', toolCalls: [{ name: TOOL_NAME, args: {} }] },
        { content: '好了。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [rootOnlyPlugin(calls)],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('跑。'), {
        configurable: { thread_id: 'root-call' },
      });
      const messages = result.messages as { getType(): string; text: string }[];
      const toolMessage = messages.filter((message) => message.getType() === 'tool').at(-1);

      expect(toolMessage?.text).toBe(REAL_RESULT);
    } finally {
      await dispose();
    }

    expect(calls).toEqual([TOOL_NAME]);
  });

  /**
   * **這一條是整張卡的驗收句。**
   *
   * subagent 叫同一個名字，真的那一顆**一次都不會被叫到**——它拿到的是 fold 換上去的
   * 拒絕樁。基座若哪天不再照 fold 算出來的 `tools` 陣列給 subagent 工具（`fold.ts` 對
   * `agentParams.tools ?? defaultTools` 的那段註解就是在講這個交互），`calls` 會多出
   * 第二筆，這一條會紅。
   */
  it('subagent 叫同一個名字時，真的那一顆一次都沒被叫到', async () => {
    const calls: string[] = [];
    const model = new ScriptedChatModel({
      turns: [
        { content: '根先叫一次。', toolCalls: [{ name: TOOL_NAME, args: {} }] },
        {
          content: '委派。',
          toolCalls: [{ name: 'task', args: { description: '幹活', subagent_type: 'worker' } }],
        },
        { content: '子代理也叫一次。', toolCalls: [{ name: TOOL_NAME, args: {} }] },
        { content: '子代理收工。' },
        { content: '根收工。' },
        { content: '根再收一次。' },
      ],
    });
    const { agent, dispose } = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [rootOnlyPlugin(calls)],
    });

    try {
      await agent.invoke(toAgentInvocation('跑。'), {
        configurable: { thread_id: 'subagent-call' },
      });
    } finally {
      await dispose();
    }

    // 兩次呼叫、一次真的執行：subagent 那次落在樁上。
    expect(calls).toEqual([TOOL_NAME]);
  });
});
