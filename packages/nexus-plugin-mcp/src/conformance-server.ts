/**
 * 宿主的 MCP 符合性測試（`native/sandbox-spawner/host/tests/mcp_conformance.rs`）用的對手：一台 HTTP MCP server，
 * 起在 `127.0.0.1`，由 Rust 測試以 `node --import tsx <這個檔> <種類>` 啟動。不進 `index.ts` 的匯出。
 *
 * 種類（第一個參數）：
 *
 * - `modern`：`@modelcontextprotocol/server` 2.x 的 `createMcpHandler`，新協議（`2026-07-28`）。
 * - `legacy-2x`：同一個 2.x 套件的 `legacyStatelessFallback`，**只講舊協議**；新協議的 `server/discover` 它回「方法不存在」。
 * - `legacy-1x`：單包 SDK 1.x 的 `StreamableHTTPServerTransport`，代表外面還在跑的 1.x server。
 * - `handwritten`：手寫的最小回應器，`initialize` 回 `2025-06-18`；`tools/list` 分兩頁。官方的 `McpServer` 兩代都不分頁，
 *   分頁只能在這一台量。
 *
 * 三台官方 server 掛同一組工具與資源：`echo`、`fail`（回 `isError`）、`hang`（等到請求被中止）；文字資源、二進位資源、一個模板。
 *
 * **stdout 是記錄通道**，一行一則 JSON：`{"event":"listening","url":…}`、每個請求 `{"event":"request",…}`（欄位同
 * {@link RecordedRequest}）、每個請求的回應連線關掉時 `{"event":"response-closed","rpcMethods":…,"finished":…}`（`finished` 為假＝client 在回應寫完之前中止了那一則請求的串流）、`hang` 被呼叫與被中止時 `{"event":"hang-started"}`／`{"event":"hang-aborted"}`。stdin 關閉就收線。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  McpServer as LegacyMcpServer,
  ResourceTemplate as LegacyResourceTemplate,
} from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  createMcpHandler,
  legacyStatelessFallback,
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { z } from 'zod';
import { startHttpFixture } from './http-fixtures.js';
import type { Dispatch } from './http-fixtures.js';
import {
  LOGO_BASE64,
  LOGO_URI,
  MEMO_TEXT,
  MEMO_URI,
  NOTE_TEMPLATE,
  noteText,
} from './resource-fixtures.js';

type Kind = 'modern' | 'legacy-2x' | 'legacy-1x' | 'handwritten';

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

/** `hang` 的實作：記下開始，等到請求被中止才結束，並記下中止。 */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  emit({ event: 'hang-started' });
  return new Promise<never>(() => {
    const aborted = (): void => emit({ event: 'hang-aborted' });
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}

const TOOL_ECHO = {
  description: '把收到的參數原樣回成文字。',
  inputSchema: { x: z.number().optional() },
};
const TOOL_FAIL = { description: '一定失敗，回 isError。', inputSchema: {} };
const TOOL_HANG = { description: '等到請求被中止才結束。', inputSchema: {} };

function echoResult(args: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: `echo:${JSON.stringify(args)}` }] };
}

const FAIL_RESULT = { isError: true, content: [{ type: 'text' as const, text: 'tool failed' }] };

/** 新協議與 2.x 舊協議共用的 server：官方 2.x 的 `McpServer`。 */
function createModern(): McpServer {
  const server = new McpServer(
    { name: 'nexus-conformance', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.registerTool('echo', TOOL_ECHO, (args) => echoResult(args));
  server.registerTool('fail', TOOL_FAIL, () => FAIL_RESULT);
  server.registerTool('hang', TOOL_HANG, (_args, ctx) => hangUntilAborted(ctx.mcpReq.signal));
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
  return server;
}

/** 單包 SDK 1.x 的 server。 */
function createLegacy1x(): LegacyMcpServer {
  const server = new LegacyMcpServer(
    { name: 'nexus-conformance', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.registerTool('echo', TOOL_ECHO, (args) => echoResult(args));
  server.registerTool('fail', TOOL_FAIL, () => FAIL_RESULT);
  server.registerTool('hang', TOOL_HANG, (_args, extra) => hangUntilAborted(extra.signal));
  server.registerResource('memo', MEMO_URI, { mimeType: 'text/plain' }, (uri) => ({
    contents: [{ uri: uri.href, text: MEMO_TEXT }],
  }));
  server.registerResource('logo', LOGO_URI, { mimeType: 'image/png' }, (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'image/png', blob: LOGO_BASE64 }],
  }));
  server.registerResource(
    'note',
    new LegacyResourceTemplate(NOTE_TEMPLATE, { list: undefined }),
    { mimeType: 'text/plain' },
    (uri, variables) => ({
      contents: [{ uri: uri.href, text: noteText(String(variables['id'])) }],
    }),
  );
  return server;
}

/** 手寫回應器能回的工具，分兩頁。 */
const PAGES: Readonly<Record<string, { tools: string[]; next?: string }>> = {
  '': { tools: ['echo', 'fail'], next: 'p2' },
  p2: { tools: ['hang'] },
};

/** 手寫回應器：只答 `initialize`、`notifications/*`、`tools/list`、`tools/call`、三個 resources 方法。 */
function handwritten(body: unknown): { status: number; json?: unknown } {
  const message = (body ?? {}) as {
    id?: unknown;
    method?: string;
    params?: { cursor?: string; name?: string; uri?: string };
  };
  const ok = (result: unknown): { status: number; json: unknown } => ({
    status: 200,
    json: { jsonrpc: '2.0', id: message.id, result },
  });
  switch (message.method) {
    case 'initialize':
      return ok({
        protocolVersion: '2025-06-18',
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'nexus-handwritten', version: '0.0.0' },
      });
    case 'tools/list': {
      const page = PAGES[message.params?.cursor ?? ''] ?? { tools: [] };
      return ok({
        tools: page.tools.map((name) => ({ name, inputSchema: { type: 'object' } })),
        ...(page.next === undefined ? {} : { nextCursor: page.next }),
      });
    }
    case 'tools/call':
      return ok(echoResult({ name: message.params?.name }));
    case 'resources/list':
      return ok({ resources: [{ uri: MEMO_URI, name: 'memo' }] });
    case 'resources/templates/list':
      return ok({ resourceTemplates: [{ uriTemplate: NOTE_TEMPLATE, name: 'note' }] });
    case 'resources/read':
      return ok({ contents: [{ uri: message.params?.uri ?? MEMO_URI, text: MEMO_TEXT }] });
    default:
      if (message.method?.startsWith('notifications/') === true) return { status: 202 };
      return {
        status: 200,
        json: {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Method not found' },
        },
      };
  }
}

function dispatchFor(kind: Kind): { dispatch: Dispatch; close: () => Promise<void> } {
  switch (kind) {
    case 'modern': {
      const handler = createMcpHandler(() => createModern());
      const handle = toNodeHandler(handler);
      return {
        dispatch: async (request, response, body) => {
          await handle(request as NodeIncomingMessageLike, response, body);
        },
        close: () => handler.close(),
      };
    }
    case 'legacy-2x': {
      const handle = toNodeHandler({ fetch: legacyStatelessFallback(() => createModern()) });
      return {
        dispatch: async (request, response, body) => {
          await handle(request as NodeIncomingMessageLike, response, body);
        },
        close: () => Promise.resolve(),
      };
    }
    case 'legacy-1x':
      return {
        dispatch: async (request, response, body) => {
          const server = createLegacy1x();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          response.on('close', () => {
            void transport.close();
            void server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(request, response, body);
        },
        close: () => Promise.resolve(),
      };
    case 'handwritten':
      return {
        dispatch: (_request: IncomingMessage, response: ServerResponse, body: unknown) => {
          const reply = handwritten(body);
          if (reply.json === undefined) {
            response.writeHead(reply.status);
            response.end();
          } else {
            response.writeHead(reply.status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(reply.json));
          }
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      };
  }
}

const kind = process.argv[2] as Kind | undefined;
if (kind !== 'modern' && kind !== 'legacy-2x' && kind !== 'legacy-1x' && kind !== 'handwritten') {
  process.stderr.write('第一個參數要是 modern、legacy-2x、legacy-1x 或 handwritten\n');
  process.exit(2);
}
const { dispatch, close } = dispatchFor(kind);
const fixture = await startHttpFixture(dispatch, close, {
  onRequest: (request) => emit({ event: 'request', ...request }),
  onClose: (request, finished) =>
    emit({ event: 'response-closed', rpcMethods: request.rpcMethods, finished }),
});
emit({ event: 'listening', url: fixture.url });
process.stdin.resume();
process.stdin.on('end', () => {
  void fixture.close().then(() => process.exit(0));
});
