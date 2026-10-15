/**
 * skills 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下的測試用（[#1446](https://github.com/DemianLi/nexus-agent/issues/1446)）。
 *
 * skills 本身已經是樹上的函式插件（`packages/nexus-plugin-skills`，沒有一行 `@nexus/core`）。手搭 `PluginEntry` 清單、直接
 * `createNexusAgent` 的測試要一顆「登記技能來源」的 `NexusPlugin`，就走這個外殼——**用的是同一份 `Config`**，所以設定的形狀
 * 與預設值只有一個出處。同 `echo.fixture.ts`、`token-meter.fixture.ts` 的前例。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 * 想驗「skills 經樹進來」的測試用 `shippedPlugins()`（出貨清單上的那一列是橋接列），不要用這個。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { Config } from '@nexus/plugin-skills';
import type { SkillsConfig, SkillsPluginOptions } from '@nexus/plugin-skills';

/** skills 的 `NexusPlugin` 外殼：依序把設定的來源登記進 registry（路徑格式與重名由 registry 那一側擋）。 */
export const skillsPlugin: NexusPlugin<SkillsConfig> = {
  name: 'skills',
  Config,
  apply(registry: PluginRegistry, config: SkillsConfig): void {
    for (const source of config.sources) registry.skills.addSource(source);
  },
};

/** 建一個 skills 條目，可以放進組裝點清單。 */
export function createSkillsPlugin(options: SkillsPluginOptions = {}): PluginEntry {
  return { plugin: skillsPlugin, config: options };
}
