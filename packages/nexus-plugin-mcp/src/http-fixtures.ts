/**
 * 測試用的 HTTP MCP server：起在 `127.0.0.1` 的真 server，**舊協議與新協議各一台**
 * （[#1095](https://github.com/DemianLi/nexus-agent/issues/1095)），不打外網。
 *
 * 照 dsh 的 `packages/mcp/mcp-client/tests/http-fixture.ts`（新協議，`createMcpHandler` ＋ `toNodeHandler`，無狀態）；
 * 舊協議那台用單包 SDK 1.x 的 `StreamableHTTPServerTransport`，同樣無狀態（每個請求一個 server 與 transport）。
 * 兩台掛的工具是同一組定義（[`fixture-tools.ts`](./fixture-tools.ts)／[`modern-tools.ts`](./modern-tools.ts)），所以
 * 「工具名與結果與 stdio 路徑一致」是同一組斷言跑出來的。
 *
 * **斷言都量在 server 這一側可觀察的東西**：每個請求的標頭與 JSON-RPC 方法、目前開著的連線數。client 那邊
 * 看到什麼不算證據。不進 `index.ts` 的匯出。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NodeIncomingMessageLike } from '@modelcontextprotocol/node';
import { registerFixtureTools } from './fixture-tools.js';
import { registerModernTools } from './modern-tools.js';

/** server 看到的一個請求。 */
export interface RecordedRequest {
  readonly httpMethod: string;
  /** 這個請求的 JSON-RPC 方法（`tools/list`、`tools/call`、`initialize`…）；批次請求有好幾個，沒有 body 的是空陣列。 */
  readonly rpcMethods: readonly string[];
  readonly authorization: string | undefined;
  /** `mcp-protocol-version` 標頭：握手之後協商到的版本（舊協議）或每個請求自帶的版本（新協議）。 */
  readonly protocolVersion: string | undefined;
}

/** 一台跑著的 HTTP MCP server。 */
export interface HttpFixture {
  /** MCP 端點的網址。 */
  readonly url: string;
  /** 到目前為止收到的請求，依到達順序。 */
  readonly requests: RecordedRequest[];
  /** 目前還開著的 TCP 連線數（server 那一側算的）。keep-alive 的閒置連線也算，所以收線的判準不是它。 */
  openConnections(): number;
  /**
   * 目前**還沒結束的請求**數（server 那一側算的）：回應還沒收完的。一般的 `tools/call` 很快就結束；常駐的那條
   * ——舊協議的 `GET` 串流、新協議的 `subscriptions/listen`——只有 client 真的掛斷才會結束，所以「收線」量它。
   */
  activeRequests(): number;
  /** 之後遇到這個 JSON-RPC 方法的請求一律回 500；`undefined` 取消。 */
  failRpcMethod(method: string | undefined): void;
  close(): Promise<void>;
}

/** 起一台新協議（`2026-07-28`）的 server。 */
export function startModernHttp(): Promise<HttpFixture> {
  const handler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'nexus-modern-http', version: '0.0.0' },
      { capabilities: { tools: {} } },
    );
    registerModernTools(server);
    return server;
  });
  const handle = toNodeHandler(handler);
  return start(
    async (request, response, body) => {
      await handle(request as NodeIncomingMessageLike, response, body);
    },
    () => handler.close(),
  );
}

/** 起一台舊協議（單包 SDK 1.x）的 server，無狀態。 */
export function startLegacyHttp(): Promise<HttpFixture> {
  return start(
    async (request, response, body) => {
      const server = new LegacyMcpServer({ name: 'nexus-legacy-http', version: '0.0.0' });
      registerFixtureTools(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    },
    () => Promise.resolve(),
  );
}

type Dispatch = (
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
) => Promise<void>;

async function start(dispatch: Dispatch, closeHandler: () => Promise<void>): Promise<HttpFixture> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let active = 0;
  let failing: string | undefined;

  const server: Server = createServer((request, response) => {
    void serve(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    active += 1;
    response.on('close', () => {
      active -= 1;
    });
    const body = await readJson(request);
    const rpcMethods = (Array.isArray(body) ? body : [body]).flatMap((message: unknown) =>
      typeof message === 'object' && message !== null && 'method' in message
        ? [String((message as { method: unknown }).method)]
        : [],
    );
    requests.push({
      httpMethod: request.method ?? '',
      rpcMethods,
      authorization: request.headers.authorization,
      protocolVersion: headerValue(request.headers['mcp-protocol-version']),
    });
    if (failing !== undefined && rpcMethods.includes(failing)) {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('injected failure');
      return;
    }
    await dispatch(request, response, body);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    requests,
    openConnections: () => sockets.size,
    activeRequests: () => active,
    failRpcMethod: (method) => {
      failing = method;
    },
    close: async () => {
      await closeHandler();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 讀完整個 body 並當 JSON 解；沒有 body（GET、DELETE）回 `undefined`。 */
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}
