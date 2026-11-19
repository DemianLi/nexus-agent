/**
 * 組裝點一定以 `hostBridge` 交宿主服務的門面（#2569）：對話行程交進來的就交那一個，沒交（單行程 serve、CLI）就交一律回
 * `host_absent` 的那一個，插件在 `apply` 當下讀得到、不必分兩種情況。
 *
 * **零憑證、零外部連線**：假模型，不連任何宿主。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { PluginEntry } from '@nexus/core';
import {
  HOST_BRIDGE_SERVICE,
  HostCallError,
  createHostBridge,
  type HostBridge,
} from '@nexus/host-bridge';
import { MCP_HOST_ROW_SERVICE, MCP_POOL_SERVICE, McpConnectionPool } from '@nexus/plugin-mcp';
import { afterEach, describe, expect, it } from 'vitest';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins } from './fixtures.js';

const shipped = await shippedPlugins();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** `apply` 當下把門面抄下來（host 服務插件排在最前面）。 */
function probe(): { entry: PluginEntry; seen: { bridge?: HostBridge } } {
  const seen: { bridge?: HostBridge } = {};
  return {
    seen,
    entry: {
      plugin: {
        name: 'host-bridge-probe',
        apply(registry) {
          seen.bridge = registry.services.get(HOST_BRIDGE_SERVICE) as HostBridge | undefined;
        },
      },
    },
  };
}

async function assemble(hostBridge?: HostBridge) {
  const root = await mkdtemp(join('/var/tmp', 'nexus-host-bridge-assembly-'));
  roots.push(root);
  const { entry, seen } = probe();
  const built = await createCliAgent(
    { live: false, workspace: root },
    [...shipped, entry],
    root,
    hostBridge === undefined ? {} : { hostBridge },
  );
  await built.dispose();
  return seen.bridge;
}

describe('組裝點的 hostBridge', () => {
  it('對話行程交進來的就是插件讀到的那一個', async () => {
    const { bridge } = createHostBridge();
    expect(await assemble(bridge)).toBe(bridge);
  });

  it('沒交：照樣有這一格，呼叫回 host_absent', async () => {
    const bridge = await assemble();
    expect(bridge).toBeDefined();
    const failure = await bridge?.call('s', 'm', null).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HostCallError);
    expect((failure as HostCallError).code).toBe('host_absent');
  });
});

/** MCP 兩個連線服務在這一次組裝裡掛了哪幾個（`apply` 當下讀）。 */
async function mcpServices(session: { hostBridge?: HostBridge; mcpPool?: McpConnectionPool }) {
  const root = await mkdtemp(join('/var/tmp', 'nexus-host-bridge-assembly-'));
  roots.push(root);
  const seen: { row?: unknown; pool?: unknown } = {};
  const entry: PluginEntry = {
    plugin: {
      name: 'mcp-services-probe',
      apply(registry) {
        seen.row = registry.services.get(MCP_HOST_ROW_SERVICE);
        seen.pool = registry.services.get(MCP_POOL_SERVICE);
      },
    },
  };
  const built = await createCliAgent(
    { live: false, workspace: root },
    [...shipped, entry],
    root,
    session,
  );
  await built.dispose();
  return seen;
}

describe('MCP 連線服務隨有沒有宿主分岔（#3000）', () => {
  it('有宿主：掛 row 服務，連線池不掛（就算組裝點手上有一座）', async () => {
    const pool = new McpConnectionPool({ log: () => undefined });
    try {
      const seen = await mcpServices({ hostBridge: createHostBridge().bridge, mcpPool: pool });
      expect(typeof seen.row).toBe('function');
      expect(seen.pool).toBeUndefined();
    } finally {
      await pool.close();
    }
  });

  it('沒有宿主：連線池照舊，row 服務不掛', async () => {
    const pool = new McpConnectionPool({ log: () => undefined });
    try {
      const seen = await mcpServices({ mcpPool: pool });
      expect(seen.row).toBeUndefined();
      expect(seen.pool).toBe(pool);
    } finally {
      await pool.close();
    }
  });
});
