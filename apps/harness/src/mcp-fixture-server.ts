/**
 * 組裝點這一側的假 MCP server：一個真的走 stdio 的子行程。
 *
 * 與 `packages/nexus-plugin-mcp` 那一支分工不同，不是複製品。那一支驗的是 plugin 自己
 * （命名、註冊、關機）；這一支只提供**外部資料**，讓 [`mcp.test.ts`](./mcp.test.ts) 驗
 * Phase 2 的主路徑驗收——agent 經 MCP 讀到東西、再經基座內建的 `write_file` 寫進虛擬
 * 檔案系統。它刻意住在 `apps/harness`：plugin 套件不得 import harness，反向借用測試素材
 * 也會把那條界線弄糊。
 *
 * 由 `mcp.test.ts` 以 `node --import tsx <這個檔>` 啟動。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** 這台 server 手上的「外部資料」。測試斷言它一路到得了對話裡。 */
export const CHANGELOG = 'deepagents 1.13.1 沒有內建 MCP，接入走 @langchain/mcp-adapters。';

const server = new McpServer({ name: 'nexus-harness-fixture', version: '0.0.0' });

server.registerTool(
  'fetch_changelog',
  {
    description: '從外部取得一則變更紀錄。',
    inputSchema: { project: z.string().describe('專案名') },
  },
  ({ project }) => ({ content: [{ type: 'text', text: `${project}：${CHANGELOG}` }] }),
);

// MCP 的 `isError`：工具本身失敗（不是協定層的錯）。agent 看到的要帶 `Error: ` 前綴、`status: 'error'`，與其他失敗的工具一致
// （#1074：adapter 2.0.0 預設直接回沒有前綴的錯誤訊息，要在 plugin 裡補回）。
export const FAILURE_TEXT = 'upstream exploded: 503';
server.registerTool('fail', { description: '一定失敗，回 isError。', inputSchema: {} }, () => ({
  isError: true,
  content: [{ type: 'text', text: FAILURE_TEXT }],
}));

await server.connect(new StdioServerTransport());
