import { emptyConversation, reduceAll } from '@nexus/wire';
import type { ConversationEntry, ThreadHistoryResult } from '@nexus/wire';

/**
 * 背景子代理自己那份對話（[#861](https://github.com/DemianLi/nexus-agent/issues/861)，歷史由 #871／#872 的
 * `subagentHistory` 給）。**折成獨立的對話**，不併進主對話：子代理的人話、回覆與工具卡都在它自己的日誌裡。
 *
 * @module
 */

/** 一次最多讀幾則（人說的與模型回的各算一則）。更早的沒有載入，卡上講一句，不做往前翻。 */
export const SUBAGENT_HISTORY_MAX_MESSAGES = 40;

/**
 * harness 派出去時，在第一句話（也就是派出的任務）後面接的一段指示，用來要子代理收尾前回報給母代理
 * （`apps/harness/src/background-subagents.ts` 的 `withReturnGuidance`，照 dsh）。那一段是寫給模型看的英文，人不必看
 * 到；認不得（措辭改了）就原樣畫，寧可多顯示，不要吃掉人的字。
 */
export const RETURN_GUIDANCE_MARKER = '\n\nYour parent agent id is ';

/** 去掉派出任務後面的回報指示。 */
export function taskText(text: string): string {
  const at = text.indexOf(RETURN_GUIDANCE_MARKER);
  return at < 0 ? text : text.slice(0, at);
}

export interface SubagentConversation {
  /** 人說的、模型回的、工具跑的；第一則人話已去掉回報指示。 */
  readonly entries: readonly ConversationEntry[];
  /** 這一頁之前還有更早的。 */
  readonly hasMore: boolean;
}

/** 把一頁歷史折成獨立的對話。只留畫面要的三種項目；折疊器為別的情境長出來的（通知、交付…）在這裡沒有意義。 */
export function foldSubagentHistory(result: ThreadHistoryResult): SubagentConversation {
  const state = reduceAll(emptyConversation(), result.events);
  let firstHuman = true;
  const entries: ConversationEntry[] = [];
  for (const entry of state.entries) {
    if (entry.kind === 'human') {
      entries.push(firstHuman ? { ...entry, text: taskText(entry.text) } : entry);
      firstHuman = false;
    } else if (entry.kind === 'ai' || entry.kind === 'tool') {
      entries.push(entry);
    }
  }
  return { entries, hasMore: result.hasMore };
}

/**
 * 本地回聲裡**歷史還沒有的**那幾句。歷史讀回來之後人話就在裡面了，再畫一次是重複；但送出到寫進子代理日誌之間有空檔，
 * 那段時間讀到的歷史還沒有它，所以按文字、依序一對一消掉：有就不畫回聲，還沒有的才畫。
 */
export function unmatchedEchoes(
  echoes: readonly string[],
  entries: readonly ConversationEntry[],
): readonly string[] {
  const spoken = entries.flatMap((entry) => (entry.kind === 'human' ? [entry.text.trim()] : []));
  return echoes.filter((echo) => {
    const at = spoken.indexOf(echo.trim());
    if (at < 0) return true;
    spoken.splice(at, 1);
    return false;
  });
}
