/**
 * 測試用的 `loadPlugins`：註冊表帶轉接器的 `adaptTool`，MCP 的工具是 `NexusTool`，註冊時要轉成 LangChain 工具（同組裝點）。
 *
 * @module
 */

import { createRegistry, loadPlugins as load } from '@nexus/core';
import type { PluginEntry } from '@nexus/core';
import { toLangChainTool } from '@nexus/tool-adapter';

/** 同 `@nexus/core` 的 `loadPlugins`，沒給註冊表時建一個帶 `adaptTool` 的。 */
export function loadPlugins(
  plugins: readonly PluginEntry[],
  registry: Parameters<typeof load>[1] = createRegistry({ adaptTool: toLangChainTool }),
  options?: Parameters<typeof load>[2],
): ReturnType<typeof load> {
  return load(plugins, registry, options);
}
