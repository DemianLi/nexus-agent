/**
 * `@nexus/plugin-submit-record` 的不變量配套入口。
 *
 * No runtime invariant: 理由與其他空 installer 完全相同，見
 * `packages/nexus-plugin-echo/src/invariant.ts` 的檔頭：nexus 的 `InvariantSubject` 裡
 * 只有一份 `SessionLog`，而那份日誌歸 `@nexus/core`；這個 package 在 subject 裡沒有任何
 * 屬於自己的跨筆關係可以檢。
 *
 * **這個 package 的契約實際證在哪裡**：CSV 的切與組由 `csv.test.ts` 直接驗；對欄名、
 * 未知欄名要拒絕、`filesUpdate` 那一支要回 `Command` 由 `index.test.ts` 驗；
 * 「閘門只認 `submit_record`」與端到端「核准 → 真的寫出檔案／拒絕 → 檔案不存在」在
 * `apps/harness/src/submit-record-wire.test.ts`；「注入的 backend 與折出來的是同一個」
 * 那條絆索在 `apps/harness/src/submit-record-mounts.test.ts`。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const SUBMIT_RECORD_INVARIANT_PACKAGE = '@nexus/plugin-submit-record';

/** 空 installer。沒有參數是刻意的——`noUnusedParameters` 開著。 */
const install: InvariantInstaller = () => {};

/**
 * 把 `@nexus/plugin-submit-record` 的配套入口掛上去。
 *
 * 掛了它**不會裝上任何檢查**，唯一的作用是保留包名歸屬。
 *
 * @returns 註冊 `@nexus/plugin-submit-record` 配套入口的 plugin。
 */
export function createSubmitRecordInvariantPlugin(): NexusPlugin {
  return {
    name: 'submit-record-invariant',
    apply(registry) {
      registry.invariants.register(SUBMIT_RECORD_INVARIANT_PACKAGE, install);
    },
  };
}
