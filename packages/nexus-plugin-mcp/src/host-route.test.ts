/**
 * 選路（#3000 E4b）：有宿主的 row 服務與門面，這條 thread 的 MCP 連線走宿主，不用連線池、也不自己連。
 * 宿主是假的：`open` 回清單與 `ready`，`call` 回固定結果；量的是外掛送了什麼、模型叫工具拿到什麼。
 */

import { CHANNEL_SERVICE, createHostServicesPlugin } from '@nexus/core';
import type { PluginRegistry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { MCP_HOST_BRIDGE_SERVICE, MCP_HOST_ROW_SERVICE, MCP_POOL_SERVICE } from './index.js';
import type { McpHostRowBuilder, McpPluginOptions } from './index.js';
import type { HostCaller, HostCallOptionsLike } from './host-pool.js';
import { loadPlugins, mcpEntry } from './load-with-adapter.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const options: McpPluginOptions = {
  serverName: 'srv',
  connection: { transport: 'http', url: 'https://mcp.example.test/mcp' },
  approval: { default: 'allow' },
};

function chunked(text: string): { chunks: string[]; summary: { chunks: number; bytes: number } } {
  const chunks = text.match(/[\s\S]{1,9}/gu) ?? [];
  return { chunks, summary: { chunks: chunks.length, bytes: Buffer.byteLength(text, 'utf8') } };
}

function fakeHost() {
  const seen: { method: string; payload: Record<string, unknown> }[] = [];
  const caller: HostCaller = {
    call(_service, method, payload, callOptions: HostCallOptionsLike = {}) {
      seen.push({ method, payload: payload as Record<string, unknown> });
      callOptions.onId?.(7);
      if (method === 'open') {
        const doc = {
          tools: [
            { name: 'echo', description: 'e', inputSchema: { type: 'object', properties: {} } },
          ],
          instructions: '',
          warning: null,
        };
        const { chunks, summary } = chunked(JSON.stringify(doc));
        for (const chunk of chunks) callOptions.onChunk?.(chunk);
        callOptions.onChunk?.({ ready: summary });
        return new Promise(() => undefined);
      }
      const { chunks, summary } = chunked(
        JSON.stringify({ content: [{ type: 'text', text: '來自宿主' }] }),
      );
      for (const chunk of chunks) callOptions.onChunk?.(chunk);
      return Promise.resolve(summary);
    },
    onReady: () => () => undefined,
  };
  return { caller, seen };
}

async function mounted(
  services: Record<string, unknown>,
  row: McpPluginOptions = options,
): Promise<{ registry: PluginRegistry; dispose: () => Promise<void> }> {
  const { registry, dispose } = await loadPlugins([
    createHostServicesPlugin({ [CHANNEL_SERVICE]: undefined, ...services }),
    mcpEntry(row),
  ]);
  cleanup.push(dispose);
  return { registry, dispose };
}

describe('MCP 連線走宿主', () => {
  it('有 row 服務與門面：open／call 走宿主，連線池不碰', async () => {
    const host = fakeHost();
    const built: unknown[] = [];
    const row: McpHostRowBuilder = (config, credentials) => {
      built.push([config.serverName, credentials.size]);
      return { serverName: config.serverName, connection: { transport: 'http', url: 'x' } };
    };
    const pool = {
      acquire: () => Promise.reject(new Error('不該走池')),
    };
    const { registry } = await mounted({
      [MCP_HOST_ROW_SERVICE]: row,
      [MCP_HOST_BRIDGE_SERVICE]: host.caller,
      [MCP_POOL_SERVICE]: pool,
    });
    const tool = registry.tools.resolve('mcp__srv__echo')?.value;
    expect(tool).toBeDefined();
    expect(String(await tool?.invoke({}))).toContain('來自宿主');
    expect(built).toEqual([['srv', 0]]);
    expect(host.seen.map((item) => item.method)).toEqual(['open', 'call']);
    expect(host.seen[0]?.payload).toEqual({
      server: { serverName: 'srv', connection: { transport: 'http', url: 'x' } },
      elicitation: false,
    });
    expect(host.seen[1]?.payload).toMatchObject({ open: 7, method: 'tools/call' });
  });

  it('只有門面、沒有 row 服務：不走宿主（沒有宿主的行程把門面掛成一律 host_absent）', async () => {
    const host = fakeHost();
    const { registry } = await mounted({ [MCP_HOST_BRIDGE_SERVICE]: host.caller });
    expect(registry.tools.resolve('mcp__srv__echo')).toBeUndefined();
    expect(host.seen).toEqual([]);
  });

  it('row 服務拋（例如 command 不是絕對路徑）：這一列連不上，不碰宿主', async () => {
    const host = fakeHost();
    const { registry } = await mounted({
      [MCP_HOST_ROW_SERVICE]: () => {
        throw new Error('stdio 的 command 要是絕對路徑');
      },
      [MCP_HOST_BRIDGE_SERVICE]: host.caller,
    });
    expect(registry.tools.resolve('mcp__srv__echo')).toBeUndefined();
    expect(host.seen).toEqual([]);
  });

  it('收掉這條 thread 只放掉綁定：不起新的一代、不向宿主再 open、不走掉線的通報', async () => {
    const host = fakeHost();
    const { registry, dispose } = await mounted(
      {
        [MCP_HOST_ROW_SERVICE]: (config: { serverName: string }) => ({
          serverName: config.serverName,
          connection: { transport: 'http', url: 'x' },
        }),
        [MCP_HOST_BRIDGE_SERVICE]: host.caller,
      },
      { ...options, reconnect: { initialDelayMs: 5, maxDelayMs: 5 } },
    );
    expect(registry.tools.resolve('mcp__srv__echo')).toBeDefined();
    await dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(host.seen.map((item) => item.method)).toEqual(['open']);
  });
});
