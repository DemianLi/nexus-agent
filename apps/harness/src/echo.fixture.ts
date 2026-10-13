/**
 * echo 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下的測試與基準任務用（[#1416](https://github.com/DemianLi/nexus-agent/issues/1416) PR 2）。
 *
 * echo 本身已經是樹上的函式插件（`packages/nexus-plugin-echo`，沒有一行 `@nexus/core`）。大量測試手搭 `PluginEntry`
 * 清單、直接呼叫 `createCliAgent` 或 `loadPlugins`，不經過 Cordis 樹；它們要一顆「註冊 `echo` 工具」的 `NexusPlugin`，
 * 就走這個外殼——**包的是同一個 `createEchoTool`**，所以工具的定義只有一個出處。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 * 它在產品路徑上出現的話，「相容層折進樹上的工具」那一半就被它蓋掉了，驗收 D 的突變（折疊忽略樹）會被它救活。
 * `echo-on-tree.test.ts` 有一條釘住這件事。
 *
 * 想驗「echo 經樹進來」的測試用 `shippedPlugins()`（出貨清單上的 echo 那一列是橋接列），不要用這個。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import {
  createEchoTool,
  DEFAULT_ECHO_PREFIX,
  ECHO_TOOL_NAME,
  echoConfigSchema,
} from '@nexus/plugin-echo';
import type { EchoConfig, EchoPluginOptions } from '@nexus/plugin-echo';

export { DEFAULT_ECHO_PREFIX, ECHO_TOOL_NAME, echoConfigSchema };
export type { EchoConfig, EchoPluginOptions };

/** echo 的 `NexusPlugin` 外殼：模組層級常數，每次掛載才有的狀態都在 `apply` 裡。 */
export const echoPlugin: NexusPlugin<EchoConfig> = {
  name: 'echo',
  Config: echoConfigSchema,
  apply(registry: PluginRegistry, config: EchoConfig): void {
    registry.tools.register(createEchoTool(config.prefix));
  },
};

/**
 * 建一個 echo 條目。薄薄一層：設定不在這裡驗，驗在載入的時候（那時候才有 id 可以指名）。
 *
 * @param options - 回聲的前綴。
 * @returns 可以放進組裝點清單的條目。
 */
export function createEchoPlugin(options: EchoPluginOptions = {}): PluginEntry {
  return { plugin: echoPlugin, config: options };
}
