/**
 * 背景子代理的編號長什麼樣（[#832](https://github.com/DemianLi/nexus-agent/issues/832)）。
 *
 * 單獨一個檔，是因為認編號的兩頭互相引用：產生編號的 `background-subagents.ts` 已經引用 pump 的
 * 投影型別，pump 再引回去就成環。
 *
 * @module
 */

import type { SessionAddress } from '@nexus/core';

/** 編號的前綴：`bg-` 加隨機，不是計數器（root 續接之後不能撞上舊日誌）。 */
export const BACKGROUND_RUN_PREFIX = 'bg-';

/** 這個地址是不是背景子代理的：它的串流由 host 自己排空，線上不會有基座的 frame，卡只能由日誌開、日誌收。 */
export function isBackgroundAddress(address: SessionAddress): boolean {
  return address.kind === 'subagent' && address.runId.startsWith(BACKGROUND_RUN_PREFIX);
}
