/**
 * 分叉子 thread 的 seed（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580) 刀 2）：`buildForkSeed` 的前綴，加上清空繼承佇列的
 * `inbox/spliced`。
 *
 * **偏離 dsh（Q2 (a)，理由 2：使用者要的是「從這一輪分出去」）**：dsh 讓前綴裡還排著的件跟著過去（`core/agent-loop/src/inbox.ts:27-55` 的折法
 * 不看切點，`687f282e`）。只有使用者在那一輪跑著時又送了一句、排進佇列，切點上才會有排隊件，那一句本來是來源的下一輪；繼承的話，子 thread
 * 第一輪回答的會是原對話的下一句。所以在 inherited 標記之後替每一條非空的清單補一顆取消掉全部的 `inbox/spliced`，這幾顆算子 thread 自己的
 * 事件（切點仍是那顆標記）。佇列是空的就什麼都不補，seed 以標記結尾，同 dsh。
 *
 * @module
 */

import { buildForkSeed, EMPTY_INBOX, foldInbox } from '@nexus/core';
import type { InboxSplice, InboxTarget, SessionEvent } from '@nexus/core';

/**
 * 子 thread 的 seed。
 *
 * @param events - 來源日誌，照 `seq` 排、從 0 連續。
 * @param boundary - 切點（含），一顆 `turn/end`，見 `forkBoundaryOf`。
 * @returns 新的陣列：前綴、inherited 標記，與（佇列非空時）清空佇列的幾顆。
 * @throws {RangeError} `boundary` 不是一顆存在的 `turn/end`（`buildForkSeed`）。
 */
export function childForkSeed(events: readonly SessionEvent[], boundary: number): SessionEvent[] {
  const seed = buildForkSeed(events, boundary);
  const marker = seed[seed.length - 1];
  /* v8 ignore next -- buildForkSeed 一定以標記結尾 */
  if (marker === undefined) throw new Error('分叉的 seed 沒有 inherited 標記');
  const inbox = foldInbox(seed);
  for (const target of Object.keys(EMPTY_INBOX) as InboxTarget[]) {
    const queued = inbox[target];
    if (queued.length === 0) continue;
    const splice: InboxSplice = {
      target,
      start: 0,
      removedCount: queued.length,
      inserted: [],
      outcome: 'canceled',
    };
    seed.push({
      type: 'inbox/spliced',
      seq: seed.length,
      time: marker.time,
      data: splice,
    } as SessionEvent);
  }
  return seed;
}
