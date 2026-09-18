/**
 * `@nexus/plugin-agent-instructions` 的不變量配套入口。
 *
 * **No runtime invariant: 這個 package 在 subject 裡沒有任何屬於自己的東西可以檢。** 射程的理由與
 * `@nexus/plugin-memory` 那份逐字同一條：`InvariantSubject` 裡只有一份 `SessionLog`，而那份日誌歸
 * `@nexus/core`；dsh 的 `install(ctx, fail)` 收的是整個 Cordis 匯流排，每個 package 自己發的事件都在
 * 裡面，我們這側沒有對應物。見 [#101](https://github.com/DemianLi/nexus-agent/issues/101)。
 *
 * 這個 package 真正會壞的兩件事**都證得到，只是不在這裡**：
 *
 * - **基線到不到得了模型、會不會重複**：`apps/harness/src/agent-instructions.test.ts`，量的是**零
 *   `--plugins`** 的裸組裝——判準必須是產品路徑上的那一份，掛著 plugin 觀察是假綠。
 * - **渲染與預算**：`src/render.test.ts`，字串與位元組帳逐條對 dsh。
 *
 * 那一則基線是 `user/message`，而「日誌裡的訊息推得回模型歷史」已經有 `@nexus/core` 的不變量在管；
 * 這裡再註冊一條只會變成同一件事的第二個聲稱。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const AGENT_INSTRUCTIONS_INVARIANT_PACKAGE = '@nexus/plugin-agent-instructions';

/**
 * 空 installer。
 *
 * 沒有參數是刻意的——`noUnusedParameters` 開著，寫了 `(subject, fail)` 編不過，而且
 * 「一個都沒用到」正好是這個檔案要說的話。
 */
const install: InvariantInstaller = () => {};

/**
 * 把 `@nexus/plugin-agent-instructions` 的配套入口掛上去。
 *
 * 掛了它**不會裝上任何檢查**，唯一的作用是**保留包名歸屬**。
 *
 * @returns 註冊 `@nexus/plugin-agent-instructions` 配套入口的 plugin。
 */
export function createAgentInstructionsInvariantPlugin(): NexusPlugin {
  return {
    name: 'agent-instructions-invariant',
    apply(registry) {
      registry.invariants.register(AGENT_INSTRUCTIONS_INVARIANT_PACKAGE, install);
    },
  };
}
