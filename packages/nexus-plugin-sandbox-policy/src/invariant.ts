/**
 * `@nexus/plugin-sandbox-policy` 的不變量配套入口。
 *
 * No runtime invariant: 理由與 `@nexus/plugin-feedback` 同型——**這個 package 沒有第二份
 * 會跟日誌分岔的狀態**。模式只有一格，住在 `SandboxModeController.current`；fence 與提示句
 * 都經 `source()` 跟那一顆讀（見 `sandbox-mode.ts` 的 class 註解），而每一次真的變了都當場
 * 追加一顆 `sandbox/mode`。沒有投影、沒有快照，也就沒有跨筆關係可以檢。
 *
 * **這個 package 的契約實際證在哪裡**：`/sandbox` 的四種結局、接線當下釘起始值、淨變化為零
 * 不追加、收掉接線之後不再寫、委派的邊界，都由本套件的 `sandbox-mode.test.ts` 直接驗；
 * 走得起一個 agent 的那些（一次切換搬得動兩個消費者、升級的每一條出口）在
 * `@nexus/harness` 的 `sandbox-mode.test.ts` 與 `sandbox-escalation.test.ts`。
 *
 * ## 一個**沒有**被這裡涵蓋的缺口，明著記下來
 *
 * `recordedSandboxMode` 讀回一份日誌時**不驗詞彙**，直接把 `event.data.mode` 交出去
 * （它信的是 `SessionEventMap` 的型別）。從磁碟讀回來的日誌不經過型別檢查，所以一顆
 * 認不得的模式名會一路流進控制器——那正是 `@nexus/core` 的 `sandbox.ts` 檔頭描述的分岔。
 *
 * **那不是跨筆關係，是讀取邊界上的輸入驗證**，家在 `recordedSandboxMode` 自己（配
 * `isSandboxMode`），不在這裡。這張卡是抽套件的重構，補一條會報新違規的檢查等於改行為，
 * 所以只記不做。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin, PluginEntry } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const SANDBOX_POLICY_INVARIANT_PACKAGE = '@nexus/plugin-sandbox-policy';

/** 空 installer。沒有參數是刻意的——`noUnusedParameters` 開著。 */
const install: InvariantInstaller = () => {};

/**
 * 把 `@nexus/plugin-sandbox-policy` 的配套入口掛上去。
 *
 * 掛了它**不會裝上任何檢查**，唯一的作用是保留包名歸屬。
 *
 * @returns 掛著它的條目，註冊 `@nexus/plugin-sandbox-policy` 配套入口的 plugin。
 */
export function createSandboxPolicyInvariantPlugin(): PluginEntry {
  return { plugin: sandboxPolicyInvariantPlugin };
}

/**
 * 模組層級的那一顆。不收設定，所以沒有 `Config`；
 * [#454](https://github.com/DemianLi/nexus-agent/issues/454) 從設定檔 import 的就是它。
 */
export const sandboxPolicyInvariantPlugin: NexusPlugin = {
  name: 'sandbox-policy-invariant',
  apply(registry) {
    registry.invariants.register(SANDBOX_POLICY_INVARIANT_PACKAGE, install);
  },
};

export default sandboxPolicyInvariantPlugin;
