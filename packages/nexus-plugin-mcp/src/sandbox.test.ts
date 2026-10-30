/**
 * 宣告了 `sandbox` 的 server 怎麼接上宿主的包裝（#1946）：真的 stdio 夾具，包裝換成測試的。
 */

import { fileURLToPath } from 'node:url';
import { loadPlugins } from '@nexus/core';
import type { PluginEntry, PluginRegistry } from '@nexus/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createMcpPlugin, MCP_SANDBOX_SERVICE, mcpConfigSchema } from './index.js';
import type { McpSandboxRequest, McpSandboxWrapper } from './index.js';
import { modelToolNames } from './tool-names.js';

const FIXTURE_SERVER = fileURLToPath(new URL('./fixture-server.ts', import.meta.url));
const stdio = {
  transport: 'stdio',
  command: process.execPath,
  args: ['--import', 'tsx', FIXTURE_SERVER],
};

const host = (wrap: McpSandboxWrapper): PluginEntry => ({
  plugin: {
    name: 'host',
    apply(registry) {
      registry.services.provide(MCP_SANDBOX_SERVICE, wrap);
    },
  },
});

describe('MCP 的 sandbox 宣告', () => {
  let dispose: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await dispose?.();
    dispose = undefined;
  });

  const load = async (connection: object, wrap?: McpSandboxWrapper): Promise<PluginRegistry> => {
    const entry = createMcpPlugin({ serverName: 'srv', connection } as never);
    const loaded = await loadPlugins([...(wrap === undefined ? [] : [host(wrap)]), entry]);
    dispose = loaded.dispose;
    return loaded.registry;
  };

  it('包裝收到路徑與 PATH', async () => {
    const seen: McpSandboxRequest[] = [];
    const registry = await load(
      {
        ...stdio,
        env: { PATH: '/p', OTHER: 'x' },
        sandbox: { readable: ['/r'], writable: ['/w'] },
      },
      (request) => {
        seen.push(request);
        return Promise.resolve({ command: request.command, args: request.args });
      },
    );
    expect(seen).toMatchObject([
      { command: process.execPath, readable: ['/r'], writable: ['/w'], path: '/p' },
    ]);
    expect(modelToolNames(registry).length).toBeGreaterThan(0);
  });

  it('連線用包裝回的 command，不用設定寫的', async () => {
    const registry = await load({ ...stdio, sandbox: {} }, () =>
      Promise.resolve({ command: '/no/such/spawner', args: [] }),
    );
    expect(modelToolNames(registry)).toEqual([]);
  });

  it('`{}` 也走包裝', async () => {
    let called = 0;
    await load({ ...stdio, sandbox: {} }, (request) => {
      called += 1;
      return Promise.resolve({ command: request.command, args: request.args });
    });
    expect(called).toBe(1);
  });

  it('沒宣告：不走包裝，照舊直接起', async () => {
    let called = 0;
    const registry = await load(stdio, () => {
      called += 1;
      throw new Error('不該到這裡');
    });
    expect(called).toBe(0);
    expect(modelToolNames(registry).length).toBeGreaterThan(0);
  });

  it('包裝拋錯：不連線、警告一句，不退回直接起', async () => {
    const registry = await load({ ...stdio, sandbox: {} }, () =>
      Promise.reject(new Error('沙箱不可用')),
    );
    expect(modelToolNames(registry)).toEqual([]);
    expect(
      registry.logger
        .warnings()
        .map(({ message }) => message)
        .join('\n'),
    ).toContain('沙箱不可用');
  });

  it('宿主沒給包裝：不連線', async () => {
    const registry = await load({ ...stdio, sandbox: {} });
    expect(modelToolNames(registry)).toEqual([]);
  });

  it('http 不收 sandbox', () => {
    const parsed = mcpConfigSchema.safeParse({
      serverName: 'srv',
      connection: { transport: 'http', url: 'http://x', sandbox: {} },
    });
    expect(parsed.success).toBe(false);
  });
});
