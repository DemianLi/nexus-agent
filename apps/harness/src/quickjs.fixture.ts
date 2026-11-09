/**
 * quickjs 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下、手搭 `PluginEntry` 清單的測試用（#2353）。
 *
 * quickjs 本身已經是樹上的函式插件（`packages/nexus-plugin-quickjs`，沒有一行 `@nexus/core`）。這個外殼**包的是同一個
 * `createRunJavascriptTool`**（經宿主的轉接器轉成 LangChain 工具），所以工具的定義只有一個出處。
 *
 * **不能出現在任何產品路徑上**，同 `echo.fixture.ts`。想驗「quickjs 經樹進來」的測試用 patch `insert` 一列
 * `@nexus/plugin-quickjs`（`quickjs-migration.test.ts`），不要用這個。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import {
  createModuleHolder,
  createRunJavascriptTool,
  quickJsConfigSchema,
} from '@nexus/plugin-quickjs';
import type { QuickJsConfig, QuickJsPluginOptions } from '@nexus/plugin-quickjs';

import { toLangChainTool } from '@nexus/tool-adapter';

/** quickjs 的 `NexusPlugin` 外殼：每次掛載建自己的 WASM 模組，載入期就拉起來（同樹上那一列的 `apply`）。 */
export const quickJsPlugin: NexusPlugin<QuickJsConfig> = {
  name: 'quickjs',
  Config: quickJsConfigSchema,
  async apply(registry: PluginRegistry, config: QuickJsConfig): Promise<void> {
    const modules = createModuleHolder();
    await modules.current();
    registry.tools.register(toLangChainTool(createRunJavascriptTool(config, modules)));
  },
};

/**
 * 建一個 quickjs 條目。薄薄一層：設定不在這裡驗，驗在載入的時候。
 *
 * @param options - 三條資源上限，形狀見 `quickJsConfigSchema`。
 * @returns 可以放進組裝點清單的條目。
 */
export function createQuickJsPlugin(options: QuickJsPluginOptions = {}): PluginEntry {
  return { plugin: quickJsPlugin, config: options };
}
