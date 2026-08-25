/**
 * Phase 2 的主路徑驗收（[#34](https://github.com/DemianLi/nexus-agent/issues/34)）：
 * **agent 經 MCP 讀外部資料，再經基座內建的 `write_file` 寫進虛擬檔案系統。**
 *
 * 走的是真的那條路——真的 stdio 子行程、真的 `tools/list` 與 `tools/call`、真的
 * `createNexusAgent`，只有模型是假的（[#31](https://github.com/DemianLi/nexus-agent/issues/31)：
 * CI 不放模型 secret）。
 *
 * **假模型能證明什麼要說清楚。** 它照腳本呼叫工具，所以「模型把 MCP 的結果抄進
 * `write_file` 的參數」這一步這裡驗不到——那是模型的行為，不是我們的程式碼。這條測試
 * 驗的是它下面那層：經我們的 registry 註冊進去的 MCP 工具真的在 agent 迴圈裡執行、
 * 外部資料真的回到對話裡、而基座內建的檔案工具與它們並存無礙。三件事任何一件斷了，
 * 真模型那條路也不可能通。
 *
 * deny 規則擋得住 `.env` 類路徑那一條**不在這裡**：那要等 `feat/fs-backends` 有真的
 * Disk backend（[#34](https://github.com/DemianLi/nexus-agent/issues/34) 的定案——
 * `StateBackend` 的「檔案」只是 state 裡的一個 map，擋住它證明不了路徑圍堵）。
 */

import { fileURLToPath } from 'node:url';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { CHANGELOG } from './mcp-fixture-server.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));

/** 這台假 server 的工具在模型面的名字。 */
const FETCH_TOOL = 'mcp__docs__fetch_changelog';

const SCRIPT = [
  {
    content: '',
    toolCalls: [{ name: FETCH_TOOL, args: { project: 'nexus-agent' } }],
  },
  {
    content: '',
    toolCalls: [{ name: 'write_file', args: { file_path: '/changelog.md', content: CHANGELOG } }],
  },
  { content: '已經把變更紀錄寫進 /changelog.md。' },
] as const;

describe('MCP 工具在 agent 迴圈裡', () => {
  it('經 MCP 讀外部資料，再經內建 write_file 寫進虛擬檔案系統', async () => {
    const model = new ScriptedChatModel({ turns: [...SCRIPT] });
    const { agent, dispose } = await createNexusAgent({
      model,
      plugins: [
        createMcpPlugin({
          serverName: 'docs',
          connection: {
            transport: 'stdio',
            command: process.execPath,
            args: ['--import', 'tsx', FIXTURE_SERVER],
          },
        }),
      ],
    });

    try {
      const result = await agent.invoke(toAgentInvocation('把 nexus-agent 的變更紀錄存起來。'));

      // 基座真的把 MCP 工具與自己的檔案工具一起交給了模型。
      expect(model.boundToolNames).toContain(FETCH_TOOL);
      expect(model.boundToolNames).toContain('write_file');

      // 外部資料真的回到對話裡——這一段是 MCP server 那端產生的，不是腳本裡的字串。
      const toolMessages = result.messages.filter((message) => message.getType() === 'tool');
      expect(toolMessages.map((message) => message.name)).toEqual([FETCH_TOOL, 'write_file']);
      expect(toolMessages[0]?.text).toContain('nexus-agent：');
      expect(toolMessages[0]?.text).toContain(CHANGELOG);

      // 而它落進了虛擬檔案系統。
      expect(result.files?.['/changelog.md']?.content).toContain(CHANGELOG);
    } finally {
      await dispose();
    }
  });
});
