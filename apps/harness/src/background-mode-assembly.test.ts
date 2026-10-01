/**
 * 背景續行的兩種模式，走 `createCliAgent` 的真組裝（[#841](https://github.com/DemianLi/nexus-agent/issues/841)）：
 * 模型綁到的工具是什麼。續行：`subagent`（預設背景）＋ `list_agents`／`interrupt_agent`／`send_message`，沒有基座的 `task`；
 * 一次性（不傳）：基座的 `task`，沒有那四顆——與今天逐字相同。
 */

import { HumanMessage } from '@langchain/core/messages';
import { describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins } from './fixtures.js';
import type { ScriptedChatModel } from './scripted-model.js';

const shipped = await shippedPlugins();

async function boundTools(
  invocation: Parameters<typeof createCliAgent>[0],
): Promise<readonly string[]> {
  const { agent, model, dispose } = await createCliAgent(invocation, shipped);
  try {
    await agent.invoke(
      { messages: [new HumanMessage('嗨')] },
      { configurable: { thread_id: 'bg-mode' } },
    );
    return (model as ScriptedChatModel).boundToolNames;
  } finally {
    await dispose();
  }
}

describe('背景續行的兩種模式（真組裝）', () => {
  it('續行：模型看到 subagent 與三顆控制工具，沒有 task', async () => {
    const tools = await boundTools({ live: false, backgroundSubagents: { maxActive: 8 } });
    expect(tools).toEqual(
      expect.arrayContaining(['subagent', 'list_agents', 'interrupt_agent', 'send_message']),
    );
    expect(tools).not.toContain('task');
  });

  it('一次性（不傳）：模型看到基座的 task，沒有 subagent 與控制工具', async () => {
    const tools = await boundTools({ live: false });
    expect(tools).toContain('task');
    for (const name of ['subagent', 'list_agents', 'interrupt_agent', 'send_message']) {
      expect(tools).not.toContain(name);
    }
  });
});
