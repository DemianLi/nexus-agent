/**
 * 網路上的 MCP server（`transport: 'http'`）的連線走代理（[#746](https://github.com/DemianLi/nexus-agent/issues/746)）。
 * 照 dsh 的 `packages/mcp/mcp-client/tests/egress.spec.ts`：底下的轉接套件用全域 `fetch`，代理裝在全域派送器上，
 * 所以載入時往 `.invalid` 主機的連線會到假代理。
 *
 * 零外部連線：假代理在 loopback；目標主機永遠解析不到，只有假代理答得出來。
 */

import { fileURLToPath } from 'node:url';
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
    // 子行程裡的 Node 經 `NODE_USE_ENV_PROXY` 連 http 目標時也走 CONNECT 隧道：答了隧道，再答隧道裡的那一個請求。
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      socket.end('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok');
    });
    socket.on('error', () => undefined);
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

/**
 * stdio 的 MCP server 是子行程，它裡面的 Node 不看代理變數，除非環境帶著 `NODE_USE_ENV_PROXY`（#746）。
 * 走真的子行程：先照 harness 的做法裝代理，再讓假 server 自己連一次，看請求到了哪裡。
 * 旗標只有 Node 22.21 以上與 24 以上有用，更舊的執行環境這一組跳過。
 */
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const childHonorsFlag = major >= 24 || (major === 22 && minor >= 21);

describe.skipIf(!childHonorsFlag)('stdio MCP server 子行程的連線', () => {
  const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));

  /** 起假 server，叫它連 `.invalid` 主機一次，回它報的結果。 */
  async function childFetch(): Promise<string> {
    const plugin = createMcpPlugin({
      serverName: 'fixture',
      connection: {
        transport: 'stdio',
        command: process.execPath,
        args: ['--import', 'tsx', FIXTURE_SERVER],
      },
    });
    const { registry, dispose } = await loadPlugins([plugin]);
    try {
      return String(
        await registry.tools
          .resolve('mcp__fixture__fetch_url')
          ?.value.invoke({ url: 'http://child-target.invalid/' }),
      );
    } finally {
      await dispose();
    }
  }

  it('裝了代理：子行程的請求到了假代理', async () => {
    for (const name of ['HTTP_PROXY', 'http_proxy', 'NODE_USE_ENV_PROXY']) {
      vi.stubEnv(name, undefined);
      Reflect.deleteProperty(process.env, name);
    }
    vi.stubEnv('HTTP_PROXY', proxyUrl);
    const dispose = await installProxyFromEnvironment(
      { get: (name) => (name === 'HTTP_PROXY' ? { value: proxyUrl } : undefined) },
      () => undefined,
    );
    try {
      expect(await childFetch()).toBe('status 200');
      expect(seen).toContain('CONNECT child-target.invalid:80');
    } finally {
      await dispose();
    }
  });

  it('對照組：沒裝代理，子行程連不出去，假代理什麼都沒收到', async () => {
    for (const name of ['HTTP_PROXY', 'http_proxy', 'NODE_USE_ENV_PROXY']) {
      vi.stubEnv(name, undefined);
      Reflect.deleteProperty(process.env, name);
    }
    expect(await childFetch()).toMatch(/^error /);
    expect(seen).toEqual([]);
  });
});
