import type { CompactionEntry } from '@nexus/wire';

/**
 * 壓縮標記要的幾個判斷（[#944](https://github.com/DemianLi/nexus-agent/issues/944)）。資料是 `ConversationEntry`
 * 的 `kind: 'compaction'`（#896）：前 N 則原始訊息已被換成摘要。
 *
 * @module
 */

/**
 * 展開區的高度上限，單位 rem。文字是 `text-tip`（行高 1rem），所以這是約 20 行。摘要只有位元組上限，位元組上限擋不住
 * 畫面凍住（見 `card-limit.ts`），所以展開區自己捲。
 */
export const COMPACTION_SUMMARY_MAX_REM = 20;

/**
 * 標題：前 N 則換成了摘要。`cutoff` 是累計值（第二次壓縮比第一次大），不是這一次壓了多少，也不等於畫面上看得到的列數
 * （原始串含工具結果與外掛注入的），所以寫「前 N 則」，不寫「N 則對話」。壓縮格落在觸發它的那則回覆**之後**，文字不暗示
 * 「這則回覆是壓縮前寫的」。
 */
export function compactionTitle(entry: CompactionEntry): string {
  return `對話已壓縮：前 ${entry.cutoff} 則換成了摘要`;
}

/** 原文沒有另存時多講的那一句。不是錯誤，是設定的結果，所以只是字，不用警示色。 */
export const COMPACTION_UNSAVED_TEXT = '原文未另存';

/** 摘要全文；沒有（舊日誌，格式 8 以前）或只有空白就是 `undefined`：那一列不能展開。 */
export function compactionSummary(entry: CompactionEntry): string | undefined {
  const { summary } = entry;
  return summary === undefined || summary.trim() === '' ? undefined : summary;
}
