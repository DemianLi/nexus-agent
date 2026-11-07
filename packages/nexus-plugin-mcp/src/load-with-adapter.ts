/**
 * 測試用的組裝：`loadPlugins` 的註冊表帶轉接器的 `adaptTool`（MCP 的工具是 `NexusTool`，註冊時要轉成 LangChain 工具，同組裝點），
 * 與 {@link mcpEntry}：把 mcp 那一列經樹上的 `apply(ctx)` 與宿主的 `runThreadSources` 掛進那一份註冊表。
 *
 * @module
 */

import { Context } from '@nexus/cordis';
// eslint-disable-next-line no-restricted-imports -- 測試輔助檔，只給測試用
import { createRegistry, loadPlugins as load } from '@nexus/core';
// eslint-disable-next-line no-restricted-imports -- 測試輔助檔，只給測試用
import type { NexusPlugin, PluginEntry } from '@nexus/core';
// eslint-disable-next-line no-restricted-imports -- 測試輔助檔，只給測試用
import { runThreadSources, toLangChainTool } from '@nexus/tool-adapter';
import { createToolsProvider } from '@nexus/tools/provider';
import * as mcp from './index.js';
import type { McpConfig } from './index.js';

/** 同 `@nexus/core` 的 `loadPlugins`，沒給註冊表時建一個帶 `adaptTool` 的。 */
export function loadPlugins(
  plugins: readonly PluginEntry[],
  registry: Parameters<typeof load>[1] = createRegistry({ adaptTool: toLangChainTool }),
  options?: Parameters<typeof load>[2],
): ReturnType<typeof load> {
  return load(plugins, registry, options);
}

/**
 * mcp 的一列，形狀同宿主清單上的橋接列：`Config` 是樹上的 `Config`，`apply` 在一棵自己的 Cordis 根上掛
 * `createToolsProvider` 與樹上的 `apply(ctx)`，再把它登記的來源交給宿主那一份 `runThreadSources`，掛進這一條 thread 的註冊表。
 *
 * 跟宿主（harness 的 `plugin-tree.ts` 的 `mountDetached`）不同的地方：授權表全給，來源宣告的服務都讀得到；
 * 根上只有 `tools` 一個提供者。
 *
 * @param config - 那一列的 `config`，照宿主清單的寫法（交給 `Config` 解析之前）。
 * @param id - 列 id；省略就由 `loadPlugins` 補號。
 * @returns 放得進 `loadPlugins` 清單的條目。
 */
export function mcpEntry(config: unknown, id?: string): PluginEntry {
  return { plugin: mcpRow(id ?? mcp.name), config, ...(id === undefined ? {} : { id }) };
}

/** @param owner - 交給 `runThreadSources` 的列 id：只出現在誤用的錯誤訊息裡（`admit` 的名字 mcp 自己給）。 */
function mcpRow(owner: string): NexusPlugin<McpConfig> {
  return {
    name: mcp.name,
    Config: mcp.Config,
    async apply(registry, config) {
      // 授權表全給：回傳的是沒授權的服務名，空陣列就是全部授權。
      const provider = createToolsProvider({ authorizeThreadServices: () => [] });
      const root = new Context();
      try {
        await root.plugin(provider.Provider);
        await root.plugin({ name: mcp.name, inject: mcp.inject, apply: mcp.apply }, config);
        const sources = provider
          .threadSources()
          .map(({ threadSource, services }) => ({ threadSource, services }));
        registry.lifecycle.onDispose(() => root.fiber.dispose());
        await runThreadSources(registry, sources, { id: owner, module: mcp });
      } catch (error) {
        await root.fiber.dispose();
        throw error;
      }
    },
  };
}
