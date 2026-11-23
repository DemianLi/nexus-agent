/**
 * trajectory 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下的測試用（[#1435](https://github.com/DemianLi/nexus-agent/issues/1435)）。
 *
 * trajectory 本身已經是樹上的函式插件（`packages/nexus-plugin-trajectory`，沒有一行 `@nexus/core`）。手搭 `PluginEntry`
 * 清單、直接 `createNexusAgent` 的測試要一顆「登記軌跡與請求快照投影」的 `NexusPlugin`，就走這個外殼——**包的是同一組
 * `trajectoryUnit`、`requestSnapshotsUnit`**，所以單元只有一個出處。同 `token-meter.fixture.ts`、`echo.fixture.ts` 的前例。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 * 想驗「trajectory 經樹進來」的測試用 `shippedPlugins()`（出貨清單上的那一列是橋接列），不要用這個。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry, PluginRegistry } from '@nexus/core';
import { requestSnapshotsUnit, trajectoryUnit } from '@nexus/plugin-trajectory';

export { requestSnapshotsUnit, trajectoryUnit };

/** trajectory 的 `NexusPlugin` 外殼。沒有設定。 */
export const trajectoryPlugin: NexusPlugin = {
  name: 'trajectory',
  apply(registry: PluginRegistry): void {
    registry.projections.register(trajectoryUnit);
    registry.projections.register(requestSnapshotsUnit);
  },
};

/** 建一個 trajectory 條目，可以放進組裝點清單。 */
export function createTrajectoryPlugin(): PluginEntry {
  return { plugin: trajectoryPlugin };
}
