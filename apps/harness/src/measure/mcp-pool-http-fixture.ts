/**
 * MCP 連線池前後測（#2570）的 HTTP server：起在驅動行程裡（`127.0.0.1`），無狀態的舊協議（單包 SDK 1.x），
 * 工具同 {@link ./mcp-pool-stdio-server.ts} 的 `lookup`。做法照 `packages/nexus-plugin-mcp/src/http-fixtures.ts` 的 `startLegacyHttp`。
 *
 * 池的指標量在 server 這一側：每種 JSON-RPC 方法收到幾次、`initialize` 與 `tools/call` 的時間、開著的 TCP 連線數與峰值。
 * 這台代表部署方的外部服務，它的 CPU 不算進被量的行程樹。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/** server 這一側到目前為止看到的。 */
export interface HttpPoolCounters {
  /** JSON-RPC 方法 → 次數。 */
  readonly methods: Readonly<Record<string, number>>;
  /** 每次 `initialize` 到達的時間（`Date.now()`）。 */
  readonly initializeAt: readonly number[];
  /** 每次 `tools/call` 到達的時間。 */
  readonly callAt: readonly number[];
  /** 現在開著的 TCP 連線數（keep-alive 的閒置連線也算）。 */
  readonly openConnections: number;
  /** 起來以來同時開著的 TCP 連線數的峰值。 */
  readonly peakConnections: number;
  /** 起來以來接過幾條 TCP 連線。 */
  readonly acceptedConnections: number;
}

/** 一台跑著的 HTTP fixture。 */
export interface HttpPoolFixture {
  readonly url: string;
  counters(): HttpPoolCounters;
  /** 歸零計數（峰值從現在開著的連線數重新起算）；換一組量測時用。 */
  reset(): void;
  close(): Promise<void>;
}

export async function startHttpPoolFixture(name = 'http'): Promise<HttpPoolFixture> {
  let methods: Record<string, number> = {};
  let initializeAt: number[] = [];
  let callAt: number[] = [];
  const sockets = new Set<Socket>();
  let peak = 0;
  let accepted = 0;

  const server: Server = createServer((request, response) => {
    void serve(request, response).catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    accepted += 1;
    peak = Math.max(peak, sockets.size);
    socket.on('close', () => sockets.delete(socket));
  });

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const now = Date.now();
    for (const message of Array.isArray(body) ? body : [body]) {
      if (typeof message !== 'object' || message === null || !('method' in message)) continue;
      const method = String((message as { method: unknown }).method);
      methods[method] = (methods[method] ?? 0) + 1;
      if (method === 'initialize') initializeAt.push(now);
      if (method === 'tools/call') callAt.push(now);
    }
    const mcp = new McpServer({ name: `mcp-pool-${name}`, version: '0.0.0' });
    mcp.registerTool(
      'lookup',
      { description: '查一筆資料，回一小段文字。', inputSchema: { q: z.string() } },
      ({ q }) => ({
        content: [{ type: 'text', text: `${name} 查到 ${q}：狀態正常，最近一次更新在上週。` }],
      }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(request, response, body);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    counters: () => ({
      methods: { ...methods },
      initializeAt: [...initializeAt],
      callAt: [...callAt],
      openConnections: sockets.size,
      peakConnections: peak,
      acceptedConnections: accepted,
    }),
    reset: () => {
      methods = {};
      initializeAt = [];
      callAt = [];
      peak = sockets.size;
      accepted = 0;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? undefined : (JSON.parse(text) as unknown);
}
