/**
 * 分叉的子 thread 讀繼承來的外溢檔（[#1580](https://github.com/DemianLi/nexus-agent/issues/1580) 第 6 點、Q1 (a)）。
 *
 * 子 thread 的 seed 是來源日誌的前綴，裡面的預覽指著 `/large_tool_results/<名字>`。那個檔寫在**來源**會話的暫存目錄
 * （`tool-result-stash.ts`，鑰匙是專案日誌目錄加 thread id），子 thread 的路由卻掛在自己的目錄。這裡算出兩樣交給
 * {@link ToolResultStashOptions.inherited}：前綴裡出現過哪些檔名、往上有哪幾代會話。讀繼承檔沿那幾代去找，新寫的照舊
 * 寫在自己的目錄。
 *
 * ## 偏離（理由 1）
 *
 * dsh 的定位是宿主上的絕對路徑：分叉繼承前綴裡的定位，不複製、不改歸屬，分叉之後的新外溢用子會話的 id
 * （`spill/spill/src/types.ts:30-36`、`spill/spill/README.md:62`）；保留期按每個檔各自算，就是為了續接或分叉的會話還讀得到
 * 舊定位（`spill/spill-local/src/index.ts:38-48`；皆 `687f282e`）。我們的定位是虛擬路徑（基座寫死 `/large_tool_results/…`，
 * 檔頭見 `tool-result-stash.ts` 的偏離 1），帶不出來源的目錄，所以退到**依名稱路由到祖先的目錄**：結果同樣是不多存一份、
 * 保留期照舊按檔算。轉過去的是讀（`read`、`readRaw`）與搜一個繼承來的檔（`grep` 的路徑就是那個檔，取回提示叫模型這樣搜）；
 * 寫與改留在自己的目錄，子 thread 不動祖先的檔。
 *
 * 讀的先後：子 thread 自己的目錄有這個檔就讀自己的（自己寫過的同名檔不被祖先那份蓋掉），沒有才沿祖先找，都沒有就是讀不到。
 *
 * ## 範圍取捨（不是偏離理由）
 *
 * - **列目錄、整個前綴的 `glob`／`grep` 列不出繼承來的檔**，只看自己的目錄。把幾代的目錄合起來列做得到，這張沒做：
 *   取回提示給的是單一檔的路徑，模型照著讀或搜那個檔都轉得過去。
 * - **名單收得比「工具結果的預覽」寬**：事件文字掃的是前綴裡所有事件（人說的話、助手的文字、工具參數都算）。前綴裡出現過、
 *   祖先目錄裡又有的名字都轉；來源在分叉之後改過那個檔（模型寫得進這個前綴），子 thread 讀到的是改過的那一份。
 *
 * ## 名單為什麼不能用「標記數」分段
 *
 * 從一條本身是分叉來的 thread 再分叉時，它的日誌裡**不一定**還留著它自己那顆繼承標記（前綴切在祖先那一段裡就只剩一顆），
 * 所以不能拿標記數當祖先代數、把前綴切成每一代各自的一段。改成整段前綴收一份名單，讀的時候沿祖先鏈逐代找，取第一個有的。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { fromLoggedMessage, inheritedEventCount } from '@nexus/core';
import type { SessionEvent, StoredSessionHeader } from '@nexus/core';

import { TOOL_RESULT_STASH_PREFIX } from './agent-factory.js';
import { toolResultEvictionPath } from './conversation-restore.js';

/**
 * 外溢層與跨會話引用寫進事件裡的定位（`spill-policy.ts`、`search-overflow.ts`、`session-reference.ts`）。檔名的字元集
 * 照存檔服務的清洗（`tool-result-stash.ts` 的 `spillStore`：`[A-Za-z0-9._-]`）。
 */
const LOCATOR_RE = new RegExp(`${TOOL_RESULT_STASH_PREFIX}/([A-Za-z0-9._-]+)`, 'gu');

/**
 * 分叉前綴裡出現過的暫存檔名（不帶開頭斜線）。
 *
 * 兩個來源：
 *
 * - **基座逐出的**：日誌記的是逐出前的全文，檔名照重播同一份規則算（{@link toolResultEvictionPath}）。
 * - **外溢層與跨會話引用的**：定位就寫在事件裡（工具結果的預覽、引用那則 `user/message`），從事件的文字抓。句尾多出來的
 *   `.` 去掉，只收 `.txt` 結尾的——三種生產者的檔名都是。
 *
 * 沒有繼承前綴（不是分叉來的）就是空的。
 *
 * @param events - 這條 thread 的日誌（seed 或讀回來的）。
 * @returns 檔名集合。
 */
export function inheritedStashNames(events: readonly SessionEvent[]): ReadonlySet<string> {
  const names = new Set<string>();
  const cut = inheritedEventCount(events);
  for (const event of events) {
    if (event.seq >= cut) continue;
    if (event.type === 'tool/result' && event.data.message !== undefined) {
      const message = fromLoggedMessage(event.data.message);
      const path = ToolMessage.isInstance(message) ? toolResultEvictionPath(message) : undefined;
      if (path !== undefined) names.add(path.slice(TOOL_RESULT_STASH_PREFIX.length + 1));
    }
    for (const match of JSON.stringify(event.data).matchAll(LOCATOR_RE)) {
      const name = (match[1] ?? '').replace(/\.+$/u, '');
      if (name.endsWith('.txt')) names.add(name);
    }
  }
  return names;
}

/**
 * 這條 thread 往上的分叉來源：父、祖父……，照 header 的 `parentSession` 一路問，到不是分叉來的（沒有 `isSeeded`）為止。
 *
 * 子代理的會話也帶 `parentSession`，但不帶 `isSeeded`，所以不會被當成分叉來源（core 的 `isSubagentSessionHeader`）。
 * 讀不到某一代的 header（找不到、讀不了）就停在那一代：那一代本身照樣列進來（它的暫存目錄可能還在），再往上不找，
 * 兩種都講一聲，不讓這條 thread 建不起來——讀不到的只是更早的外溢檔。繞回自己看過的 id 也停。
 *
 * @param header - 這條 thread 的 header。
 * @param readHeader - 冷讀一條會話的 header；找不到回 undefined。
 * @param warn - 停在半路時講一聲。
 * @returns thread id，近的在前。
 */
export async function forkAncestors(
  header: StoredSessionHeader,
  readHeader: (threadId: string) => Promise<StoredSessionHeader | undefined>,
  warn: (message: string) => void,
): Promise<readonly string[]> {
  const ancestors: string[] = [];
  const seen = new Set<string>([header.id]);
  let current: StoredSessionHeader | undefined = header;
  while (current?.isSeeded === true && current.parentSession !== undefined) {
    const parent: string = current.parentSession;
    if (seen.has(parent)) break;
    seen.add(parent);
    ancestors.push(parent);
    try {
      current = await readHeader(parent);
    } catch (error: unknown) {
      warn(
        `[暫存] thread ${header.id} 的分叉來源 ${parent} 讀不了 header，更早的外溢檔讀不到：${(error as Error).message}`,
      );
      break;
    }
    if (current === undefined) {
      warn(`[暫存] thread ${header.id} 的分叉來源 ${parent} 找不到 header，更早的外溢檔讀不到。`);
    }
  }
  return ancestors;
}
