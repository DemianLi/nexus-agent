/**
 * `@nexus/plugin-feedback` 的不變量配套入口。
 *
 * No runtime invariant: 照 dsh——`packages/feedback/message-feedback/README.md:67`（`c291e79`）寫的是
 * 「the service derives feedback directly from validated canonical events and owns no independently
 * mutable projection」。我們一樣：每一次評分都從日誌現折（`currentFeedbackItems`），沒有第二份會
 * 跟日誌分岔的狀態，所以沒有跨筆關係可以檢。
 *
 * **這個 package 的契約實際證在哪裡**：規則（樂觀鎖、內容一樣不記、收回不存在不記、備註的兩道
 * 檢查、目標只認記著那個 id 的 `assistant/message`、舊格式以輪記的怎麼讀）由 `index.test.ts` 直接驗；走真的線那一條在
 * `apps/harness/src/feedback-wire.test.ts`。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin, PluginEntry } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const FEEDBACK_INVARIANT_PACKAGE = '@nexus/plugin-feedback';

/** 空 installer。沒有參數是刻意的——`noUnusedParameters` 開著。 */
const install: InvariantInstaller = () => {};

/**
 * 把 `@nexus/plugin-feedback` 的配套入口掛上去。
 *
 * 掛了它**不會裝上任何檢查**，唯一的作用是保留包名歸屬。
 *
 * @returns 掛著它的條目，註冊 `@nexus/plugin-feedback` 配套入口的 plugin。
 */
export function createFeedbackInvariantPlugin(): PluginEntry {
  return { plugin: feedbackInvariantPlugin };
}

/**
 * 模組層級的那一顆。不收設定，所以沒有 `Config`；
 * [#454](https://github.com/DemianLi/nexus-agent/issues/454) 從設定檔 import 的就是它。
 */
export const feedbackInvariantPlugin: NexusPlugin = {
  name: 'feedback-invariant',
  apply(registry) {
    registry.invariants.register(FEEDBACK_INVARIANT_PACKAGE, install);
  },
};

export default feedbackInvariantPlugin;
