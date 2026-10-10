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
import { MemorySaver } from '@langchain/langgraph';
import { createMcpPlugin } from '@nexus/plugin-mcp';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { virtualFilesOf } from './fixtures.js';
import { CHANGELOG, FAILURE_TEXT } from './mcp-fixture-server.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));

/** 只講新協議（`2026-07-28`）的 stdio 假 server，住在 plugin 套件裡（#1095）。 */
const MODERN_SERVER = fileURLToPath(
  new URL('../../../packages/nexus-plugin-mcp/src/modern-stdio-server.ts', import.meta.url),
);

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
      expect(virtualFilesOf(result)['/changelog.md']?.content).toContain(CHANGELOG);
    } finally {
      await dispose();
    }
  });

  // #1074：MCP 回 `isError` 時，agent 看到的跟其他失敗的工具一樣——`status: 'error'`、文字帶 `Error: ` 前綴。
  // 照 dsh：MCP 的 `isError` 在 dsh 是拋錯（`packages/mcp/mcp-client/src/tools.ts:296-297`），由註冊表渲染成帶前綴的結果。
  // Chat Completions 的轉換器只送 `content`，`status` 到不了模型，所以前綴要在文字裡。
  it('MCP 回 isError：agent 看到 status: error，文字帶 Error: 前綴，原因逐字', async () => {
    const model = new ScriptedChatModel({
      turns: [
        { content: '', toolCalls: [{ name: 'mcp__docs__fail', args: {} }] },
        { content: '失敗了。' },
      ],
    });
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
      const result = await agent.invoke(toAgentInvocation('呼叫會失敗的工具。'));
      const failed = result.messages.find((message) => message.getType() === 'tool');
      expect(failed).toMatchObject({ name: 'mcp__docs__fail', status: 'error' });
      expect(failed?.text).toMatch(/^Error: 工具 mcp__docs__fail 執行失敗：/u);
      expect(failed?.text).toContain(FAILURE_TEXT);
    } finally {
      await dispose();
    }
  });

  // #1095：新協議的 server 要問使用者時，沒有人可以回答的組裝不宣告 elicitation（#1241 之後設定預設是 `true`，但要
  // `channel.kind === 'human'` 才真的開；這裡的組裝沒給 channel）。這條走真的組裝與真的 agent 迴圈：那一次呼叫落成
  // **普通的工具失敗**——`status: 'error'`、`Error: ` 前綴——模型看得到、這一輪照常收尾，不停在一個沒人接的 interrupt 上。
  // 拿掉 `index.ts` 的 `channel?.kind === 'human'` 那一格，下面兩條都紅（2026-10-11 實測），紅法各不同，見下一段。
  // 兩種組裝都要：沒有存檔點時，打開 elicitation 會得到 MISSING_CHECKPOINTER 的失敗；有存檔點（serve 的組裝）時，
  // 打開它會讓那一輪停在 interrupt 上等一次沒人會送的 resume——後者才是卡上要防的事，所以不能只測前者。
  it.each([
    { label: '沒有存檔點', checkpointer: false },
    { label: '有存檔點', checkpointer: true },
  ])(
    '新協議 server 要問使用者（$label）：落成帶 Error: 前綴的工具失敗，這一輪照常收尾，不產生 interrupt',
    async ({ checkpointer }) => {
      const model = new ScriptedChatModel({
        turns: [
          { content: '', toolCalls: [{ name: 'mcp__modern__ask', args: {} }] },
          { content: '它問不了人。' },
        ],
      });
      const { agent, dispose } = await createNexusAgent({
        model,
        ...(checkpointer && { checkpointer: new MemorySaver() }),
        plugins: [
          createMcpPlugin({
            serverName: 'modern',
            connection: {
              transport: 'stdio',
              command: process.execPath,
              args: ['--import', 'tsx', MODERN_SERVER],
            },
          }),
        ],
      });
      try {
        const result = await agent.invoke(
          toAgentInvocation('呼叫會問使用者的工具。'),
          checkpointer ? { configurable: { thread_id: 'modern-ask' } } : undefined,
        );
        const asked = result.messages.find((message) => message.getType() === 'tool');
        expect(asked).toMatchObject({ name: 'mcp__modern__ask', status: 'error' });
        expect(asked?.text).toMatch(/^Error: 工具 mcp__modern__ask 執行失敗：/u);
        expect(asked?.text).toMatch(/elicitation\/create/u);
        // 這一輪走完了：模型收到失敗之後還說了話，沒有停在 interrupt。
        expect(result.messages.at(-1)?.text).toBe('它問不了人。');
        expect(result).not.toHaveProperty('__interrupt__');
      } finally {
        await dispose();
      }
    },
  );
});
