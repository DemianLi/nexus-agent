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
 *
 * 重連前的關閉屏障（#1543）另用兩個開關，重現「`close()` 回來了，子行程卻還沒關掉」：
 *
 * - `FIXTURE_GRANDCHILD_PID_FILE`：啟動時起一個**繼承 stdout 的孫行程**（30 秒後自己結束），pid 逐行附加到這個檔，測試收尾要
 *   殺掉。它握著 pipe，所以 server 自己退出之後，client 那一側的 close 事件要等它放手才來。
 * - `FIXTURE_DROP_TOOL`：多掛一支 `drop_connection`，丟一個文字是 `Connection closed` 的錯誤（server 把它回成工具錯誤結果），
 *   外掛的 `isConnectionLost` 認這句、把這一代判成斷線走 `down()`，而 transport 這時還開著。
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
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
  if (process.env['FIXTURE_DROP_TOOL'] === '1') {
    server.registerTool('drop_connection', { description: '回一個看起來像斷線的錯誤。' }, () => {
      throw new Error('Connection closed');
    });
  }
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

const grandchildPidFile = process.env['FIXTURE_GRANDCHILD_PID_FILE'];
if (grandchildPidFile !== undefined) {
  const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: ['ignore', 'inherit', 'ignore'],
  });
  appendFileSync(grandchildPidFile, `${String(grandchild.pid)}\n`);
  grandchild.unref();
}

const hangIfFile = process.env['FIXTURE_HANG_IF_FILE'];
// 卡住的那一台：收下 client 送來的東西、什麼都不回；stdin 關了就自然結束。
if (hangIfFile !== undefined && existsSync(hangIfFile)) process.stdin.resume();
else serveStdio(createServer);
