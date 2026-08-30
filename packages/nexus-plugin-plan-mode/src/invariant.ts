/**
 * `@nexus/plugin-plan-mode` 的不變量配套入口。
 *
 * **No runtime invariant: 這個 package 想檢的那個關係不在 subject 裡，而那是射程決定的。**
 * 它真正擁有的跨筆關係是「模式狀態的每一次轉換」——而那份狀態活在 agent 的 graph state
 * 裡（見 `index.ts` 的偏離說明），不在 `InvariantSubject` 的那份 `SessionLog` 裡。
 * subject 只有日誌，日誌歸 `@nexus/core`，而
 * [#101](https://github.com/DemianLi/nexus-agent/issues/101) 已經明文把「加會話事件種類」
 * 排除在外。**這正是那個偏離的第二筆代價**：走 dsh 的事件形狀時，
 * 「批准後模式必定關閉」「模式外不會有批准」這類關係本來是配套入口檢得到的。
 *
 * 所以這一側的契約證在別處，三樣都是 dsh 明說的「型別、載入或單元測試關注點」：
 *
 * - **模式狀態的讀寫**由 `index.test.ts` 與 `apps/harness/src/plan-mode.test.ts` 驗，
 *   後者跑的是真的 agent 迴圈——state 讀得到、`Command` 寫得動、壓縮之後還在。
 * - **工具撞名**歸 `PluginRegistry` 的註冊期擋（同一個 `exit_plan_mode` 註冊兩次當場拋）。
 * - **middleware 的順序**（`prepend` 要排在核准閘門之前）歸 `fold.ts` 與它的測試。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const PLAN_MODE_INVARIANT_PACKAGE = '@nexus/plugin-plan-mode';

/**
 * 空 installer。
 *
 * 沒有參數是刻意的——`noUnusedParameters` 開著，寫了 `(subject, fail)` 編不過，而且
 * 「一個都沒用到」正好是這個檔案要說的話。
 */
const install: InvariantInstaller = () => {};

/**
 * 把 `@nexus/plugin-plan-mode` 的配套入口掛上去。
 *
 * 掛了它**不會裝上任何檢查**，唯一的作用是**保留包名歸屬**：`register()` 就算在
 * installer 是空的時候也把名字佔住，兩個 plugin 不會靜默認領同一個包名。
 *
 * @returns 註冊 `@nexus/plugin-plan-mode` 配套入口的 plugin。
 */
export function createPlanModeInvariantPlugin(): NexusPlugin {
  return {
    name: 'plan-mode-invariant',
    apply(registry) {
      registry.invariants.register(PLAN_MODE_INVARIANT_PACKAGE, install);
    },
  };
}
