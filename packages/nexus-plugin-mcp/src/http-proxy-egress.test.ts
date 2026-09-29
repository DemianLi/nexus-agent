/**
 * 網路上的 MCP server（`transport: 'http'`）的連線走代理（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
 * 照 dsh 的 `packages/mcp/mcp-client/tests/egress.spec.ts`：底下的轉接套件用全域 `fetch`，代理裝在全域派送器上，
 * 所以載入時往 `.invalid` 主機的連線會到假代理。
 *
 * 零外部連線：假代理在 loopback；目標主機永遠解析不到，只有假代理答得出來。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { installProxyFromEnvironment, loadPlugins } from '@nexus/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createMcpPlugin } from './index.js';

let seen: string[] = [];
let proxy: Server;
let proxyUrl: string;

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`${request.method ?? ''} ${request.url ?? ''}`);
    request.resume();
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('not an mcp server');
  });
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`);
    socket.end();
  });
  const address = await new Promise<AddressInfo>((resolve) => {
    proxy.listen(0, '127.0.0.1', () => {
      resolve(proxy.address() as AddressInfo);
    });
  });
  proxyUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    proxy.close(() => {
      resolve();
    });
  });
});

afterEach(() => {
  seen = [];
  vi.unstubAllEnvs();
});

/** 載入一個 http MCP，連不連得上不重要——假代理答的不是 MCP。要看的是請求到了哪裡。 */
async function loadRemote(): Promise<void> {
  const plugin = createMcpPlugin({
    serverName: 'remote',
    connection: { transport: 'http', url: 'http://mcp-remote.invalid/mcp' },
  });
  try {
    const { dispose } = await loadPlugins([plugin]);
    await dispose();
  } catch {
    // 假代理回的不是 MCP，載入失敗是預期的。
  }
}

describe('http MCP 的連線', () => {
  it('裝了代理：載入時的連線被假代理收到', async () => {
    for (const name of ['HTTP_PROXY', 'http_proxy']) vi.stubEnv(name, proxyUrl);
    const dispose = await installProxyFromEnvironment(
      { get: (name) => (name === 'HTTP_PROXY' ? { value: proxyUrl } : undefined) },
      () => undefined,
    );
    try {
      await loadRemote();
      expect(seen.some((line) => line.includes('mcp-remote.invalid'))).toBe(true);
    } finally {
      await dispose();
    }
  });

  it('對照組：沒裝代理，假代理什麼都沒收到', async () => {
    await loadRemote();
    expect(seen).toEqual([]);
  });
});
