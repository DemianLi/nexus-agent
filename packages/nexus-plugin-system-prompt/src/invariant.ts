/**
 * `@nexus/plugin-system-prompt` 的不變量配套入口。
 *
 * No runtime invariant: 理由與 `@nexus/plugin-sandbox-policy` 同型——**這個 package 沒有會跟日誌分岔的狀態**。它只在
 * 掛載當下把設定與變數算成前後兩段，每次模型請求把它們接進 system prompt；不寫任何日誌事件、沒有投影、沒有快照，也就沒有
 * 跨筆關係可以檢。
 *
 * **這個 package 的契約實際證在哪裡**：插值的每一條出口（未知、沒有值、寫壞、單獨的 `{{`、值不被再掃）由本套件的
 * `index.test.ts` 直接驗；走得起一個 agent 的那些（CLI 與 serve 的產品組裝送出的文字、後綴排最後、子代理也帶）在
 * `@nexus/harness` 的 `system-prompt-persona.test.ts`。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin, PluginEntry } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const SYSTEM_PROMPT_INVARIANT_PACKAGE = '@nexus/plugin-system-prompt';

/** 空 installer。沒有參數是刻意的——`noUnusedParameters` 開著。 */
const install: InvariantInstaller = () => {};

/**
 * 把 `@nexus/plugin-system-prompt` 的配套入口掛上去。
 *
 * 掛了它**不會裝上任何檢查**，唯一的作用是保留包名歸屬。
 *
 * @returns 掛著它的條目，註冊 `@nexus/plugin-system-prompt` 配套入口的 plugin。
 */
export function createSystemPromptInvariantPlugin(): PluginEntry {
  return { plugin: systemPromptInvariantPlugin };
}

/**
 * 模組層級的那一顆。不收設定，所以沒有 `Config`；
 * [#454](https://github.com/DemianLi/nexus-agent/issues/454) 從設定檔 import 的就是它。
 */
export const systemPromptInvariantPlugin: NexusPlugin = {
  name: 'system-prompt-invariant',
  apply(registry) {
    registry.invariants.register(SYSTEM_PROMPT_INVARIANT_PACKAGE, install);
  },
};

export default systemPromptInvariantPlugin;
