/**
 * 測試用的 MCP server：**只講新協議**（`2026-07-28`）的 stdio 子行程（[#1095](https://github.com/DemianLi/nexus-agent/issues/1095)）。
 *
 * 與 [`fixture-server.ts`](./fixture-server.ts)（舊協議）成對：產品主要走 stdio，而 `toAdapterConnection` 的 stdio 與
 * http 兩個分支各寫了一行 `elicitation: false`，所以新協議的 elicitation 要在 stdio 上也有一台守著。
 * 由測試以 `node --import tsx <這個檔>` 啟動；不進 `index.ts` 的匯出。
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerModernTools } from './modern-tools.js';
import {
  LOGO_BASE64,
  LOGO_URI,
  MEMO_TEXT,
  MEMO_URI,
  NOTE_TEMPLATE,
  instructionsRequested,
  noteText,
  resourcesRequested,
} from './resource-fixtures.js';

serveStdio(() => {
  const instructions = instructionsRequested();
  const server = new McpServer(
    { name: 'nexus-modern-fixture', version: '0.0.0' },
    {
      capabilities: { tools: {}, ...(resourcesRequested() && { resources: {} }) },
      ...(instructions !== undefined && { instructions }),
    },
  );
  registerModernTools(server);
  if (resourcesRequested()) {
    server.registerResource('memo', MEMO_URI, { mimeType: 'text/plain' }, (uri) => ({
      contents: [{ uri: uri.href, text: MEMO_TEXT }],
    }));
    server.registerResource('logo', LOGO_URI, { mimeType: 'image/png' }, (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'image/png', blob: LOGO_BASE64 }],
    }));
    server.registerResource(
      'note',
      new ResourceTemplate(NOTE_TEMPLATE, { list: undefined }),
      { mimeType: 'text/plain' },
      (uri, variables) => ({
        contents: [{ uri: uri.href, text: noteText(String(variables['id'])) }],
      }),
    );
  }
  return server;
});
