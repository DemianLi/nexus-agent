/**
 * `@nexus/plugin-ask-user` 的不變量配套入口。
 *
 * No runtime invariant: 理由與其他空 installer 完全相同，見
 * `packages/nexus-plugin-echo/src/invariant.ts` 的檔頭：nexus 的 `InvariantSubject` 裡
 * 只有一份 `SessionLog`，而那份日誌歸 `@nexus/core`；這個 package 在 subject 裡沒有任何
 * 屬於自己的跨筆關係可以檢。
 *
 * **這個 package 的契約實際證在哪裡**：問答中斷的酬載形狀由 `index.test.ts` 直接驗
 * （送出去的 `kind` 與五個欄位、fail-closed 的兩條路、空清單）；判別式的另一半在
 * `@nexus/wire` 的 `conversation.test.ts`；端到端走真的線那一條在
 * `apps/harness/src/ask-user-wire.test.ts`。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const ASK_USER_INVARIANT_PACKAGE = '@nexus/plugin-ask-user';

/** 空 installer。沒有參數是刻意的——`noUnusedParameters` 開著。 */
const install: InvariantInstaller = () => {};

/**
 * 把 `@nexus/plugin-ask-user` 的配套入口掛上去。
 *
 * 掛了它**不會裝上任何檢查**，唯一的作用是保留包名歸屬。
 *
 * @returns 註冊 `@nexus/plugin-ask-user` 配套入口的 plugin。
 */
export function createAskUserInvariantPlugin(): NexusPlugin {
  return {
    name: 'ask-user-invariant',
    apply(registry) {
      registry.invariants.register(ASK_USER_INVARIANT_PACKAGE, install);
    },
  };
}
