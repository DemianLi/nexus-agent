/**
 * 狀態列執行中那一列的 glyph 畫哪一種（#1684，地圖 #1497 第 ④ 步）：SG `StatusGlyph` 的 `Activity`。
 *
 * **只用來選 glyph**，狀態列的字固定是「執行中…」：字在 live region 裡，跟著換就每換一次唸一次（§8「代理的現況只由它唸」）。
 * 這一刻在做什麼，工具列上有字可看，所以 glyph 換樣子不算「只靠動效表達」。
 *
 * 只看本輪（`turnStart` 之後）**root** 的 entry：子代理與歸屬不明的都不看。前景子代理跑著時 root 的 `task` 是 running，
 * 所以顯示 `running`。判的順序：
 *
 * 1. 在等重打（`retry` 不是 `null`）→ `thinking`；
 * 2. 本輪還有 root 工具在跑：全部是搜尋類（`classifyTool` 判成 `search`）→ `searching`，有一顆不是 → `running`。看的是
 *    「還在跑的」而不是「最後一則」：平行工具最後一顆先完成、前面一顆還在跑時，最後一則是已完成的工具；
 * 3. root 的最後一則是串流中、正文不是空的回覆 → `writing`；
 * 4. 其餘（只有推理、還沒有輸出、工具剛完成）→ `thinking`。
 *
 * **`compacting` 走不到**：wire 只有摘要產出之後的 `CompactionEntry`，沒有「正在壓縮」的欄位。
 */

import type { ConversationState } from '@nexus/wire';

import type { Activity } from '@/components/ui/status-glyph';
import { classifyTool } from '@/lib/tool-view';

export function turnActivity(state: ConversationState): Activity {
  if (state.retry !== null) return 'thinking';
  const own = state.entries
    .slice(state.turnStart)
    .filter(
      (entry) =>
        (entry.kind === 'ai' || entry.kind === 'tool') && entry.attribution.kind === 'root',
    );
  const running = own.filter((entry) => entry.kind === 'tool' && entry.status === 'running');
  if (running.length > 0)
    return running.every((entry) => entry.kind === 'tool' && classifyTool(entry.name) === 'search')
      ? 'searching'
      : 'running';
  const last = own.at(-1);
  if (last?.kind === 'ai' && last.streaming && last.text.trim() !== '') return 'writing';
  return 'thinking';
}
