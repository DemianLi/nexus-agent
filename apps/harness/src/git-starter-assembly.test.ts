/**
 * 產品組裝有接上 git 的 starter 與 MCP 的沙箱包裝（#1946）：沒接的話 workspace-changes 當成沒有 git，宣告了 sandbox 的 MCP server 全部連不上。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { PluginEntry } from '@nexus/core';
import { MCP_SANDBOX_SERVICE } from '@nexus/plugin-mcp';
import { GIT_STARTER_SERVICE } from '@nexus/plugin-workspace-changes';

import { createCliAgent } from './assembly-root.js';
import { shippedPlugins } from './fixtures.js';

const shipped = await shippedPlugins();

/** 掛在清單最後，看 host 服務裡有沒有 starter。 */
function spyOn(seen: { value?: unknown; mcp?: unknown }): PluginEntry {
  return {
    plugin: {
      name: 'git-starter-spy',
      apply(registry) {
        seen.value = registry.services.get(GIT_STARTER_SERVICE);
        seen.mcp = registry.services.get(MCP_SANDBOX_SERVICE);
      },
    },
  };
}

describe('產品組裝的 git starter', () => {
  it('有工作區根就提供', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-git-assembly-'));
    const seen: { value?: unknown; mcp?: unknown } = {};
    const assembled = await createCliAgent(
      { live: false, workspace: root },
      [...shipped, spyOn(seen)],
      root,
    );
    try {
      expect(seen.value).toBeTypeOf('function');
      expect(seen.mcp).toBeTypeOf('function');
    } finally {
      await assembled.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
