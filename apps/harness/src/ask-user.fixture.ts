/**
 * ask-user 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下的測試用（[#1458](https://github.com/DemianLi/nexus-agent/issues/1458)）。
 *
 * ask-user 本身已經是樹上的函式插件（`packages/nexus-plugin-ask-user`，沒有一行 `@nexus/core`）。手搭 `PluginEntry` 清單、直接
 * `createNexusAgent` 的測試要一顆「登記 `ask_user_question`」的 `NexusPlugin`，就走這個外殼——**工具本體、註冊選項（`rootOnly`、
 * `outputSchema`）都取自同一份**（`createAskUserTool`、`ASK_USER_REGISTER_OPTIONS`），所以行為只有一個出處。同
 * `feedback.fixture.ts`、`skills.fixture.ts` 的前例。
 *
 * **答題者怎麼取**：照遷出之前的樣子，在**呼叫當下**依這次呼叫的 thread 取——組裝點提供 `channelForThread` 就依它，沒提供就用
 * `channel`。這是外殼自己的選擇：樹上那一列只消費行程級的預設答題管道（#1458 Q1 (c)），不再逐條 thread 查。想驗「經樹進來」的
 * 測試用 `shippedPlugins()`，不要用這個。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 *
 * @module
 */

import { CHANNEL_FOR_THREAD_SERVICE, CHANNEL_SERVICE, callThreadId } from '@nexus/core';
import type { ApprovalChannel, NexusPlugin, PluginEntry } from '@nexus/core';
import { ASK_USER_REGISTER_OPTIONS, createAskUserTool } from '@nexus/plugin-ask-user';

/** ask-user 的 `NexusPlugin` 外殼：登記 `ask_user_question`。 */
export const askUserPlugin: NexusPlugin = {
  name: 'ask-user',
  apply(registry) {
    // **沒人提供就是沒有答題者，不是「有人在」**（#669）：缺席時回 `undefined`，工具在呼叫當下拒絕，載入照常。
    const channelOf = (config: unknown): ApprovalChannel | undefined =>
      registry.services.get(CHANNEL_FOR_THREAD_SERVICE)?.(callThreadId(config)) ??
      registry.services.get(CHANNEL_SERVICE);
    registry.tools.register(
      createAskUserTool(channelOf) as Parameters<typeof registry.tools.register>[0],
      ASK_USER_REGISTER_OPTIONS as Parameters<typeof registry.tools.register>[1],
    );
  },
};

/** 建一個 ask-user 條目，可以放進組裝點清單。 */
export function createAskUserPlugin(): PluginEntry {
  return { plugin: askUserPlugin };
}
