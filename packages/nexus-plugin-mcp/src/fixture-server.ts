/**
 * 測試用的 MCP server：一個真的走 stdio 的子行程。
 *
 * **不是 mock。** 這個 plugin 唯一有價值的斷言是「MCP 那條線真的通」——連線、
 * `tools/list`、`tools/call`、關機時子行程真的收掉。把 `MultiServerMCPClient` 換成假物件
 * 之後那四件事一件都驗不到，剩下的只是在驗我們自己寫的那幾行搬運。
 *
 * 由 [`index.test.ts`](./index.test.ts) 以 `node --import tsx <這個檔>` 啟動；不進
 * `index.ts` 的匯出——它是測試素材，不是這個套件對外的東西。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

/** 一台假 server 回的「外部資料」。測試斷言這個字串一路到得了工具結果。 */
export const RELEASE_NOTE = 'nexus-agent 0.1.0：plugin 契約與 MCP 接入。';

const server = new McpServer({ name: 'nexus-fixture', version: '0.0.0' });

server.registerTool(
  'fetch_release_note',
  {
    description: '回一則發行說明，模擬 MCP server 從外部拿到的資料。',
    inputSchema: { topic: z.string().describe('要查的主題') },
  },
  ({ topic }) => ({ content: [{ type: 'text', text: `${topic}｜${RELEASE_NOTE}` }] }),
);

// 名字裡有句點，而供應商的 function name 契約不收它。這一支存在的唯一理由是讓
// `publicToolName` 的正規化在真的走過一趟 `tools/list` 之後仍然成立——純函式單測
// 證明不了 server 真的可以公告這種名字。
server.registerTool(
  'legacy.ping',
  { description: '回一聲，名字刻意帶了句點。', inputSchema: {} },
  () => ({ content: [{ type: 'text', text: 'pong' }] }),
);

await server.connect(new StdioServerTransport());
