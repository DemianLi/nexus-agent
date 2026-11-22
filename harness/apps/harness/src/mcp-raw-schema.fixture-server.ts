/**
 * 回原始 JSON Schema 的假 MCP server（stdio）：`inputSchema` 帶 `$ref`／`$defs`、`anyOf`、`format`、`enum`、巢狀物件，也有完全沒有
 * `properties` 的。`McpServer.registerTool` 只收 zod，寫不出這些形狀，所以直接接 `tools/list`、`tools/call`。
 *
 * 給 `mcp-migration.test.ts` 錄工具定義與參數驗證的位元組（#2353）。`tools/call` 把收到的參數原樣回成文字，
 * 驗證是誰做的、送上線的參數長什麼樣，都看得到。
 *
 * 由測試以 `node --import tsx <這個檔>` 啟動。
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** `tools/list` 回的工具，原樣。 */
export const RAW_SCHEMA_TOOLS = [
  {
    name: 'book_meeting',
    description: '預約會議室。',
    inputSchema: {
      type: 'object',
      $defs: {
        attendee: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' },
            role: { enum: ['host', 'guest'] },
          },
          required: ['email'],
        },
      },
      properties: {
        room: {
          anyOf: [
            { type: 'string', minLength: 1 },
            { type: 'integer', minimum: 1 },
          ],
        },
        start: { type: 'string', format: 'date-time', description: '開始時間' },
        attendees: { type: 'array', items: { $ref: '#/$defs/attendee' }, maxItems: 3 },
      },
      required: ['room', 'start'],
      additionalProperties: false,
    },
  },
  {
    name: 'ping_raw',
    description: '沒有參數。',
    inputSchema: { type: 'object' },
  },
  {
    name: 'stats',
    description: '回結構化的統計。',
    inputSchema: { type: 'object', properties: { team: { type: 'string' } } },
    outputSchema: {
      type: 'object',
      properties: { open: { type: 'integer' }, closed: { type: 'integer' } },
      required: ['open', 'closed'],
    },
  },
] as const;

const server = new Server(
  { name: 'nexus-raw-schema-fixture', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...RAW_SCHEMA_TOOLS] }));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === 'stats') {
    const value = { open: 3, closed: 5 };
    return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
  }
  return {
    content: [{ type: 'text', text: `${request.params.name} 收到 ${JSON.stringify(args)}` }],
  };
});

await server.connect(new StdioServerTransport());
