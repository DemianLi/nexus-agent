/**
 * submit-record 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下的測試用（[#1466](https://github.com/DemianLi/nexus-agent/issues/1466)）。
 *
 * submit-record 本身已經是樹上的函式插件（`packages/nexus-plugin-submit-record`，`src/index.ts` 沒有一行 `@nexus/core`）。手搭
 * `PluginEntry` 清單、直接 `createNexusAgent` 的測試要一顆「登記 `submit_record` 與它的核准閘門」的 `NexusPlugin`，就走這個外殼
 * ——**工具本體與閘門 listener 取自同一份**（`createSubmitRecordTool`、`submitRecordGate`），所以行為只有一個出處。同
 * `todo.fixture.ts`、`feedback.fixture.ts`、`ask-user.fixture.ts` 的前例。
 *
 * **fs 怎麼取**：照遷出之前的樣子，問這一次組裝自己的 `registry.services` 的 `fs` 服務（`registryFsLookup`）——只看那一份。
 * 這與沒有樹的路徑（`bindDetached`）給樹上那一列的查找是同一個來源。想驗「經樹進來」的測試用 `shippedPlugins()`，不要用這個。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry } from '@nexus/core';
import { createSubmitRecordTool, submitRecordGate } from '@nexus/plugin-submit-record';

import { registryFsLookup } from './registry-fs-lookup.js';

/** submit-record 的 `NexusPlugin` 外殼：登記 `submit_record` 與只認它的核准閘門。 */
export const submitRecordPlugin: NexusPlugin = {
  name: 'submit-record',
  apply(registry) {
    registry.tools.register(
      createSubmitRecordTool(registryFsLookup(registry)) as Parameters<
        typeof registry.tools.register
      >[0],
    );
    registry.approvals.gate(submitRecordGate);
  },
};

/** 建一個 submit-record 條目，可以放進組裝點清單。 */
export function createSubmitRecordPlugin(): PluginEntry {
  return { plugin: submitRecordPlugin };
}
