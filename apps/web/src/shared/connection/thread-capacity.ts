/**
 * serve 的 thread 數到了管理者設的上限（`thread_at_capacity`，[#1476](https://github.com/DemianLi/nexus-agent/issues/1476)）時，
 * 給使用者看的那一句（[#1478](https://github.com/DemianLi/nexus-agent/issues/1478)）。
 *
 * **不顯示 server 的 message**：那句是給管理者看的，寫了上限（N／M）與「重啟 serve」；用的人不是管理者，也重啟不了 serve。
 * 原文留在 serve 的日誌。**只寫一份**：下行被拒（狀態列，使用者實際碰到的那一處）、讀歷史、`run.start` 三處共用。
 *
 * @module
 */

import { THREAD_AT_CAPACITY } from '@nexus/wire';

/** 這條會話因為 serve 的 thread 數滿了而打不開。提管理者，不提上限數字，也不提重啟。 */
export const THREAD_AT_CAPACITY_TEXT = '目前開著的會話太多，這條會話暫時打不開。請聯絡管理者。';

/** 錯誤碼是「thread 數滿了」就回 {@link THREAD_AT_CAPACITY_TEXT}，其他碼回 `undefined`（照各處原本的講法）。 */
export function threadCapacityText(code: string | undefined): string | undefined {
  return code === THREAD_AT_CAPACITY ? THREAD_AT_CAPACITY_TEXT : undefined;
}
