/**
 * `@nexus/plugin-sandbox-policy` 的不變量配套入口：**日誌上每一顆 `sandbox/mode` 帶的都是認得的模式**。
 *
 * 照 dsh 的 sandbox-policy 配套入口（`packages/sandbox/sandbox-policy/src/invariant.ts:17-21`，
 * `477b4f4`）：逐筆看 `sandbox/mode`，`mode` 不在 `SANDBOX_MODES` 就報。只有詞彙這一條，沒有
 * 跨筆關係——模式只有一格，住在 `SandboxModeController.current`，每一次真的變了都當場追加一顆
 * 整份值的 `sandbox/mode`，沒有投影、沒有快照可以跟日誌分岔。
 *
 * ## 為什麼這一條值得檢
 *
 * 日誌從磁碟讀回來不經過型別檢查：jsonl store 只驗 `type`／`time`／`seq`，`recordedSandboxMode`
 * 把最後一顆的 `event.data.mode` 原樣交出去。一顆認不得的模式名（手改過、不相容的版本寫的）
 * 會一路流進控制器——fence 只特判 `read-only` 與 `danger-full-access`，其餘走可寫根的判斷，
 * 提示句與升級工具也都不認得它。這正是 `@nexus/core` 的 `sandbox.ts` 檔頭描述的分岔。
 *
 * **讀取邊界不擋，照 dsh。** dsh 讀事件時同樣不驗 mode：投影的 `apply` 原樣收下
 * （`packages/sandbox/sandbox-policy/src/index.ts:138`），fence 同形地落進 workspace-write
 * （`packages/fs/fs-sandbox/src/index.ts:125-126`）。它對未知模式的回應就是這顆配套入口報違規。
 * runner 安裝時先重播已有的事件，所以續接讀回來的那一份也涵蓋在內（同 `@nexus/plugin-plan-mode`
 * 的配套入口檢 `plan/mode` 的形狀）。
 *
 * **其餘契約證在哪裡**：`/sandbox` 的四種結局、接線當下釘起始值、淨變化為零不追加、收掉接線
 * 之後不再寫、委派的邊界，都由本套件的 `sandbox-mode.test.ts` 直接驗；走得起一個 agent 的那些
 * （一次切換搬得動兩個消費者、升級的每一條出口）在 `@nexus/harness` 的 `sandbox-mode.test.ts`
 * 與 `sandbox-escalation.test.ts`。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin, PluginEntry } from '@nexus/core';
import { SANDBOX_MODES } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const SANDBOX_POLICY_INVARIANT_PACKAGE = '@nexus/plugin-sandbox-policy';

/** 一條：`sandbox/mode` 帶的 `mode` 必須是 `SANDBOX_MODES` 裡的一個。 */
export const sandboxPolicyInvariant: InvariantInstaller = (subject, fail) => {
  subject.observe((event) => {
    if (event.type !== 'sandbox/mode') return;
    // 型別說它是 `SandboxMode`，但從磁碟讀回來的純物件也會進這裡（續接的 seed），
    // 那一條路上型別什麼都沒保證。
    const { mode } = event.data as { mode?: unknown };
    if ((SANDBOX_MODES as readonly unknown[]).includes(mode)) return;
    fail(
      `sandbox/mode（seq ${String(event.seq)}）帶的 mode 是 ${String(JSON.stringify(mode))}` +
        `——只收 ${SANDBOX_MODES.join('／')}`,
    );
  });
};

/**
 * 把 `@nexus/plugin-sandbox-policy` 的配套入口掛上去。
 *
 * **掛了會真的裝上檢查**（`sandbox/mode` 的詞彙），與空的那些不同。違規的去處仍然是進入點的事
 * （CLI 走 `onInvariantViolation`，serve 走 runner 預設的 `console.error`），這個檔案只負責註冊。
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
    registry.invariants.register(SANDBOX_POLICY_INVARIANT_PACKAGE, sandboxPolicyInvariant);
  },
};

export default sandboxPolicyInvariantPlugin;
