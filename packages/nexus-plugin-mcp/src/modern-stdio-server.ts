/**
 * 測試用的 MCP server：**只講新協議**（`2026-07-28`）的 stdio 子行程（[#1095](https://github.com/DemianLi/nexus-agent/issues/1095)）。
 *
 * 與 [`fixture-server.ts`](./fixture-server.ts)（舊協議）成對：產品主要走 stdio，而 `toAdapterConnection` 的 stdio 與
 * http 兩個分支各寫了一行 `elicitation: false`，所以新協議的 elicitation 要在 stdio 上也有一台守著。
 * 由測試以 `node --import tsx <這個檔>` 啟動；不進 `index.ts` 的匯出。
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerModernTools } from './modern-tools.js';

serveStdio(() => {
  const server = new McpServer(
    { name: 'nexus-modern-fixture', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );
  registerModernTools(server);
  return server;
});
