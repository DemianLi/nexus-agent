/**
 * 狀態列「執行中」旁的經過時間（#1308）從哪裡起算、怎麼寫成字。
 *
 * **起點是 server 記下的這一輪開始時刻**：軌跡投影（#1027，出廠就開）上最後一個邏輯輪的 `turn/start` 時刻。不用瀏覽器第一次
 * 看到「執行中」的那一刻——那樣重新整理就歸零，顯示錯的時間比不顯示更糟。投影跟著歷史回來，所以重新整理後接得上。
 *
 * **口徑同觀測分頁的牆鐘**（`trace-view.ts` 的 `TurnHead.durationMs`）：核准後續接的 `resume` 不另起一輪，從第一段起算，
 * **含停在核准點等人的時間**。
 *
 * 答不出就是 `undefined`，呼叫端不顯示：沒有投影（插件關了、版本不認得）、最後一輪已經收尾（新一輪的投影最多晚 100ms 到）、
 * 或看得到的最後一段是續接、它接著的那一輪已經滑出窗口（拿續接自己的時刻會在核准後歸零）。
 */

import type { ConversationState } from '@nexus/wire';

import { trajectoryOf } from '@/lib/trajectory-view';

/** 還沒收尾的那一個邏輯輪從 server 時鐘的哪一刻開始；答不出是 `undefined`。 */
export function runningTurnStart(state: ConversationState): number | undefined {
  const view = trajectoryOf(state);
  if (view === undefined) return undefined;
  const items = [...view.digests, ...view.turns];
  const last = items.at(-1);
  if (last === undefined || last.end !== undefined) return undefined;
  for (let at = items.length - 1; at >= 0; at -= 1) {
    const item = items[at]!;
    if (item.logical) return item.time;
  }
  return undefined;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 經過時間寫成字，整秒：`8 秒`、`3 分 05 秒`、`1 小時 02 分`。負的（兩邊時鐘還沒對準的那一點誤差）當 0。 */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${pad(seconds % 60)} 秒`;
  return `${Math.floor(minutes / 60)} 小時 ${pad(minutes % 60)} 分`;
}
