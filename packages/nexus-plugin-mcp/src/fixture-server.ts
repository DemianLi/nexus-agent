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
 *
 * 另有兩個開關給 `execution.taskSupport` 的拒絕（[#1572](https://github.com/DemianLi/nexus-agent/issues/1572) N0516）：
 *
 * - `FIXTURE_TASK_TOOLS=1`：多公告兩支工具，`tools/list` 上 `needs_task` 的 `execution.taskSupport` 是 `required`、`task_optional`
 *   是 `optional`。只改公告、不改實作（兩支都是一般工具），所以 `task_optional` 叫得動；`needs_task` 叫到的話 server 端會自己回錯，
 *   測試量的是**根本沒送到**。只在舊協議這一台有：新協議（`2026-07-28`）的編碼會把 `execution.taskSupport` 當已刪欄位剝掉。
 * - `FIXTURE_CALL_LOG`：每收到一個 `tools/call` 就附加一行工具名到這個檔，量在 transport 收訊息的那一刻——不管工具有沒有跑到。
 */

import { appendFileSync, existsSync } from 'node:fs';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerFixtureTools } from './fixture-tools.js';
import {
  LOGO_BASE64,
  LOGO_URI,
  memoText,
  MEMO_URI,
  NOTE_TEMPLATE,
  PAGED_FIRST_URI,
  PAGED_SECOND_URI,
  PAGE_2_CURSOR,
  instructionsRequested,
  pagedRequested,
  noteText,
  resourcesRequested,
} from './resource-fixtures.js';

// 重連測試用：這個檔案存在時一啟動就退出，模擬「server 起不來」（掛上之後才建檔，讓重連的每一次嘗試都失敗）。
const exitIfFile = process.env['FIXTURE_EXIT_IF_FILE'];
if (exitIfFile !== undefined && existsSync(exitIfFile)) process.exit(1);

const instructions = instructionsRequested();
const server = new McpServer(
  { name: 'nexus-fixture', version: '0.0.0' },
  {
    ...(instructions !== undefined && { instructions }),
    ...(pagedRequested() && { capabilities: { resources: {} } }),
  },
);
registerFixtureTools(server);
if (pagedRequested()) {
  server.server.setRequestHandler(ListResourcesRequestSchema, (request) =>
    request.params?.cursor === PAGE_2_CURSOR
      ? { resources: [{ uri: PAGED_SECOND_URI, name: 'two' }] }
      : { resources: [{ uri: PAGED_FIRST_URI, name: 'one' }], nextCursor: PAGE_2_CURSOR },
  );
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

if (process.env['FIXTURE_TASK_TOOLS'] === '1') advertiseTaskSupport();

const transport = new StdioServerTransport();
await server.connect(transport);
const callLog = process.env['FIXTURE_CALL_LOG'];
if (callLog !== undefined) {
  const inner = transport.onmessage;
  transport.onmessage = (message) => {
    if ('method' in message && message.method === 'tools/call') {
      const params = message.params as { name?: string } | undefined;
      appendFileSync(callLog, `${params?.name ?? ''}\n`);
    }
    inner?.(message);
  };
}

/** 掛兩支一般工具，並在 `tools/list` 的回應上替它們貼 `execution.taskSupport`（見檔頭）。 */
function advertiseTaskSupport(): void {
  const body = () => ({ content: [{ type: 'text' as const, text: 'ran' }] });
  server.registerTool('needs_task', { description: '公告必須用 task 執行。' }, body);
  server.registerTool('task_optional', { description: '公告可以用 task 執行。' }, body);
  const support: Record<string, 'required' | 'optional'> = {
    needs_task: 'required',
    task_optional: 'optional',
  };
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<
        string,
        (
          request: unknown,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => Promise<{ tools: { name: string }[] }>
      >;
    }
  )._requestHandlers;
  const list = handlers.get('tools/list');
  if (list === undefined) throw new Error('tools/list 的處理器還沒登記');
  server.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const result = await list(request, extra);
    return {
      ...result,
      tools: result.tools.map((tool) => {
        const taskSupport = support[tool.name];
        return taskSupport === undefined ? tool : { ...tool, execution: { taskSupport } };
      }),
    };
  });
}
