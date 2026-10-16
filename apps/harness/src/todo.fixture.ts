/**
 * todo 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下的測試用（[#1463](https://github.com/DemianLi/nexus-agent/issues/1463)）。
 *
 * todo 本身已經是樹上的函式插件（`packages/nexus-plugin-todo`，`src/index.ts` 沒有一行 `@nexus/core`）。手搭 `PluginEntry`
 * 清單、直接 `createNexusAgent` 的測試要一顆「登記 `todo_write`」的 `NexusPlugin`，就走這個外殼——**工具本體取自同一份**
 * （`createTodoTool`、`todoConfigSchema`），所以行為只有一個出處。同 `feedback.fixture.ts`、`ask-user.fixture.ts` 的前例。
 *
 * **會話怎麼取**：照遷出之前的樣子，問這一次組裝自己的 `registry.sessions.forCall`——只看那一份註冊表。這與沒有樹的路徑
 * （`bindDetached`）給樹上那一列的查找是同一個來源，也與樹上的行程級查找共用同一支挑法（`pickSessionForCall`）。想驗「經樹
 * 進來」的測試用 `shippedPlugins()`，不要用這個。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 *
 * @module
 */

import type { NexusPlugin, PluginEntry } from '@nexus/core';
import { createTodoTool, todoConfigSchema } from '@nexus/plugin-todo';
import type { TodoConfig, TodoPluginOptions } from '@nexus/plugin-todo';

/** todo 的 `NexusPlugin` 外殼：登記 `todo_write`。 */
export const todoPlugin: NexusPlugin<TodoConfig> = {
  name: 'todo',
  Config: todoConfigSchema,
  apply(registry, config: TodoConfig) {
    registry.tools.register(
      createTodoTool(config.allowParallelInProgress, (invocation) =>
        registry.sessions.forCall(invocation),
      ) as Parameters<typeof registry.tools.register>[0],
    );
  },
};

/** 建一個 todo 條目，可以放進組裝點清單。 */
export function createTodoPlugin(options: TodoPluginOptions): PluginEntry {
  return { plugin: todoPlugin, config: options };
}
