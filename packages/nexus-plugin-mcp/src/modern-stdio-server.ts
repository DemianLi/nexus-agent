/**
 * 測試用的 MCP server：**只講新協議**（`2026-07-28`）的 stdio 子行程（[#1095](https://github.com/DemianLi/nexus-agent/issues/1095)）。
 *
 * 與 [`fixture-server.ts`](./fixture-server.ts)（舊協議）成對：產品主要走 stdio，而 `toAdapterConnection` 的 stdio 與
 * http 兩個分支各自把組裝期算好的 `elicitation` 傳下去（沒有人可以回答就是 `false`，#1241），所以新協議的
 * elicitation 要在 stdio 上也有一台守著。
 * 由測試以 `node --import tsx <這個檔>` 啟動；不進 `index.ts` 的匯出。
 *
 * 另有一個開關給收尾期限（[#1543](https://github.com/DemianLi/nexus-agent/issues/1543)）：`FIXTURE_HANG_IF_FILE` 指的檔案存在時，
 * 啟動後**讀著 stdin 卻永遠不回 initialize**——握手卡住的 server。掛上之後才建檔，讓重連卡住（同 `fixture-server.ts` 的
 * `FIXTURE_EXIT_IF_FILE`；不用啟動次數，因為初次組裝起幾次子行程是 adapter 的版本協商決定的）。
 */

import { existsSync } from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { registerModernTools } from './modern-tools.js';
import {
  LOGO_BASE64,
  LOGO_URI,
  memoText,
  MEMO_URI,
  NOTE_TEMPLATE,
  instructionsRequested,
  noteText,
  resourcesRequested,
} from './resource-fixtures.js';

/** 照常的那一台。 */
function createServer(): McpServer {
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
      contents: [{ uri: uri.href, text: memoText() }],
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
}

const hangIfFile = process.env['FIXTURE_HANG_IF_FILE'];
// 卡住的那一台：收下 client 送來的東西、什麼都不回；stdin 關了就自然結束。
if (hangIfFile !== undefined && existsSync(hangIfFile)) process.stdin.resume();
else serveStdio(createServer);
