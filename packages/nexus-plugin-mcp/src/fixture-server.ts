/**
 * 測試用的 MCP server：一個真的走 stdio 的子行程。
 *
 * **不是 mock。** 這個 plugin 唯一有價值的斷言是「MCP 那條線真的通」——連線、
 * `tools/list`、`tools/call`、關機時子行程真的收掉。把 `MultiServerMCPClient` 換成假物件
 * 之後那四件事一件都驗不到，剩下的只是在驗我們自己寫的那幾行搬運。
 *
 * 由 [`index.test.ts`](./index.test.ts) 以 `node --import tsx <這個檔>` 啟動；不進
 * `index.ts` 的匯出——它是測試素材，不是這個套件對外的東西。這一台講**舊協議**，工具定義在
 * [`fixture-tools.ts`](./fixture-tools.ts)；新協議的 stdio 那台是 [`modern-stdio-server.ts`](./modern-stdio-server.ts)。
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerFixtureTools } from './fixture-tools.js';
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

const instructions = instructionsRequested();
const server = new McpServer(
  { name: 'nexus-fixture', version: '0.0.0' },
  instructions === undefined ? undefined : { instructions },
);
registerFixtureTools(server);
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

await server.connect(new StdioServerTransport());
