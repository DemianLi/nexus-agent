/**
 * 子代理拿得到 MCP 的三支資源工具與 server 指引嗎——[#430](https://github.com/DemianLi/nexus-agent/issues/430)、
 * [#431](https://github.com/DemianLi/nexus-agent/issues/431) 的驗收，走產品路徑（`createNexusAgent`，出貨清單加一列 mcp）。
 *
 * **dsh 給**：MCP 的提示詞段落與工具都是掛在**全域**的，全域的 layer 併進每個 agent 的組裝，子代理也在其中
 * （`packages/core/system-prompt/README.md:96,110`、`packages/mcp/mcp-resources/README.md:34,57`、
 * `packages/core/scope/README.md:12`：子 scope 繼承祖先的貢獻）。nexus 的 mcp 列都是全域的，所以子代理照樣有。
 *
 * 判準都看**子代理自己那幾輪**的證據：它的 prompt 裡 system 訊息帶指引，它叫 `list_mcp_resources` 得到資源清單
 * （工具不在它的工具集裡的話，叫它得到的是「不是有效工具」的錯誤文字，不會有資源 URI）。
 */

import { fileURLToPath } from 'node:url';
import type { BaseMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { GENERAL_PURPOSE_SUBAGENT } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { shippedPlugins } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';

const FIXTURE_SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/fixture-server.ts', import.meta.url),
);
const INSTRUCTIONS = '先 list 再 read，不要猜 URI。';
const shipped = await shippedPlugins();

describe('子代理也拿得到 MCP 的資源工具與指引', () => {
  it('general-purpose 子代理：system 訊息接了指引，叫 list_mcp_resources 得到資源清單', async () => {
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'task',
              args: { description: '列資源', subagent_type: GENERAL_PURPOSE_SUBAGENT.name },
            },
          ],
        },
        {
          content: '列一下。',
          toolCalls: [{ name: 'list_mcp_resources', args: { server: 'srv' } }],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
    });
    const built = await createNexusAgent({
      model,
      checkpointer: new MemorySaver(),
      plugins: [
        ...shipped,
        createMcpPlugin({
          serverName: 'srv',
          connection: {
            transport: 'stdio',
            command: process.execPath,
            args: ['--import', 'tsx', FIXTURE_SERVER],
            env: { FIXTURE_INSTRUCTIONS: INSTRUCTIONS, FIXTURE_RESOURCES: '1' },
          },
        }),
      ],
    });
    try {
      await (
        built.agent as unknown as {
          invoke: (input: unknown, config: unknown) => Promise<unknown>;
        }
      ).invoke(
        { messages: [{ role: 'user', content: '開工' }] },
        { configurable: { thread_id: 'mcp-subagent' }, recursionLimit: 50 },
      );
      const text = (message: BaseMessage | undefined) => message?.text ?? '';
      const systemOf = (prompt: readonly BaseMessage[]) =>
        text(prompt.find((m) => m.getType() === 'system'));
      const subagentPrompts = model.prompts.filter((prompt) =>
        prompt.some((m) => m.getType() === 'human' && m.text === '列資源'),
      );
      expect(subagentPrompts.length).toBeGreaterThanOrEqual(2);
      for (const prompt of subagentPrompts) {
        expect(systemOf(prompt)).toContain('### MCP server: srv');
        expect(systemOf(prompt)).toContain(INSTRUCTIONS);
        expect(systemOf(prompt)).toContain('["srv"]');
      }
      // 子代理叫了 list_mcp_resources，下一次模型呼叫就看得到資源清單。
      const last = subagentPrompts[subagentPrompts.length - 1] ?? [];
      const toolMessage = last.find((m) => m.getType() === 'tool');
      expect(text(toolMessage)).toContain('MCP server: srv');
      expect(text(toolMessage)).toContain('memo://readme');
    } finally {
      await built.dispose();
    }
  }, 30000);
});
