/**
 * goal 的**舊外殼**：`NexusPlugin` 形狀，給還在相容層底下的測試用（[#1486](https://github.com/DemianLi/nexus-agent/issues/1486)）。
 *
 * goal 本身已經是樹上的函式插件（`packages/nexus-plugin-goal`，`src/` 除了從 lint 排除的 `invariant.ts` 都不 import `@nexus/core`）。
 * 手搭 `PluginEntry` 清單、直接 `createNexusAgent` 的測試要一顆「掛三顆工具、`/goal` 與 `goals` 服務」的 `NexusPlugin`，就走這個外殼——
 * **lazy 核心（`createGoalCore`）、三顆工具與命令 handler 取自同一份**（`mountGoal`），所以行為只有一個出處，**這裡沒有重建舊的
 * `sessions.join` 行為**。同 `todo.fixture.ts`、`feedback.fixture.ts` 的前例。
 *
 * **會話怎麼取**：照遷出之前的樣子，問這一次組裝自己的 `registry.sessions.forCall`——只看那一份註冊表。想驗「經樹進來」的測試用
 * `shippedPlugins()`，不要用這個。
 *
 * **不能出現在任何產品路徑上**：`resolveEntryModule`、出貨清單（`cordis.yml`）、`fixtures.ts` 的 `shippedPlugins` 都不引用它。
 *
 * @module
 */

import { GOALS_SERVICE } from '@nexus/goal';
import type { GoalServices } from '@nexus/goal';
import type { NexusPlugin, PluginEntry } from '@nexus/core';
import { createGoalCore, goalConfigSchema, mountGoal } from '@nexus/plugin-goal';
import type { GoalConfig, GoalCore, GoalSeams } from '@nexus/plugin-goal';
import type { z } from 'zod';

/**
 * {@link createGoalPlugin} 收的東西：設定的輸入面，加上測試縫（時鐘、id 工廠）。
 *
 * `core`：**多次組裝共用同一個核心**——樹上那一列的樣子（一個行程一份 `WeakMap`，每條 thread 的日誌各是一個鍵）。省略時每次 `apply`
 * 各建各的（舊外殼的行為）。要證「撤掉一條 thread 再重開，新日誌建新服務、舊的可回收」這類跨組裝的事才傳。
 */
export type GoalPluginOptions = z.input<typeof goalConfigSchema> &
  GoalSeams & { readonly core?: GoalCore };

/** 一次掛載：每次 `apply` 各建各的核心（狀態全在閉包裡），縫由呼叫端決定。 */
function applyWith(seams: GoalSeams, shared?: GoalCore): NexusPlugin<GoalConfig>['apply'] {
  return (registry, config) => {
    const core = shared ?? createGoalCore(config, seams);
    registry.services.provide(GOALS_SERVICE, core);
    mountGoal(
      {
        registerTool: (tool, options) =>
          void registry.tools.register(
            tool as Parameters<typeof registry.tools.register>[0],
            options,
          ),
        registerCommand: (definition) => void registry.commands.register(definition),
        forCall: (callConfig) => registry.sessions.forCall(callConfig),
      },
      core,
      config,
    );
  };
}

/** goal 的 `NexusPlugin` 外殼（不帶測試縫）。 */
export const goalPlugin: NexusPlugin<GoalConfig> = {
  name: 'goal',
  Config: goalConfigSchema,
  apply: applyWith({}),
};

/**
 * 建一個 goal 條目，可以放進組裝點清單。不帶測試縫時回的就是 {@link goalPlugin} 本身，帶了縫才另外包一顆。
 *
 * @param options - 設定與測試縫。
 */
export function createGoalPlugin(options: GoalPluginOptions = {}): PluginEntry {
  const { now, newGoalId, core, ...config } = options;
  if (now === undefined && newGoalId === undefined && core === undefined) {
    return { plugin: goalPlugin, config };
  }
  const seams: GoalSeams = {
    ...(now === undefined ? {} : { now }),
    ...(newGoalId === undefined ? {} : { newGoalId }),
  };
  return {
    plugin: { name: 'goal', Config: goalConfigSchema, apply: applyWith(seams, core) },
    config,
  };
}

/**
 * 把宿主面的 `goals` 服務（{@link GoalServices}，只交宿主要用的那幾格）還原成插件自己的完整核心。
 *
 * 測試要用 `create`／`edit`／`resume`／`clear` 這些宿主不碰的方法造出狀態，而宿主介面刻意不放它們（`@nexus/goal` 的 `GoalService`）。
 * 提供者是 {@link createGoalCore} 建的那一個，所以這個轉型說的是實話；**只給測試用**。
 *
 * @param goals - `services.use(GOALS_SERVICE)` 拿到的東西。
 */
export function goalCoreOf(goals: GoalServices): GoalCore {
  return goals as GoalCore;
}
