import type { ToolEntry } from '@nexus/wire';

/**
 * 撞到輸出上限（[#608](https://github.com/DemianLi/nexus-agent/issues/608)，資料由 #433 送上線）。
 *
 * - **這一輪**：`AiEntry.maxTokens` 標在那一輪最後一則 root 回覆上，一輪一格。那則底下畫 {@link MAX_TOKENS_NOTICE}，
 *   位置、樣式同「（已停止）」：灰色小字，不是紅字——截斷不是失敗，一輪收完狀態照常回到就緒。沒字的那則也照畫
 *   （模型只在寫工具參數時被切斷，一個字都沒吐）。不給續寫或重試的鈕，同 dsh 延後
 *   （`.agents/notes/archived/bug-fix/2026-08-12-max-tokens-turn-end-notice.md`，`477b4f4`）。
 * - **子代理**：`task` 以失敗收尾，結果是給模型看的英文（逐字照 dsh `tool-subagent/src/index.ts:165`、`:194`）。
 *   網頁認出來就換成中文講，寫到一半的那段照樣畫；認不出來（harness 改了措辭）就退回原樣，不會壞。
 *   harness 那側的字不改：那是模型讀的。
 *
 * @module
 */

/** 這一輪撞到了輸出上限時，那則回覆底下的一行。 */
export const MAX_TOKENS_NOTICE = '（已達輸出上限，這一輪沒寫完）';

/**
 * 抄自 `@nexus/core` 的 `max-tokens.ts`（web 不相依 core；`max-tokens-view.test.ts` 讀原始檔比對，那邊改了這裡要紅）。
 * 卡上的第一行是 core 的錯誤前綴接這一句，寫到一半的那段另起一行接在 {@link PARTIAL_OUTPUT_HEADING} 後面；沒寫出字
 * 就只有第一行。**前綴只有一個主人**（`apps/harness/src/tool-error-prefix.test.ts`），所以這裡只抄理由、比第一行的
 * 結尾，同 `question-view.ts` 的 `WITHDRAWN_TOOL_REASON`。
 */
export const SUBAGENT_MAX_TOKENS_REASON = 'subagent run hit its token limit before finishing';

/** 同上，寫到一半的那段前面那一行。 */
export const PARTIAL_OUTPUT_HEADING = 'Partial output before the run ended:';

/** 認出來時卡上換成的那一句。 */
export const SUBAGENT_MAX_TOKENS_TEXT = '子代理寫到輸出上限，沒寫完。';

/** 有寫到一半的內容時，接在 {@link SUBAGENT_MAX_TOKENS_TEXT} 後面的那一句。 */
export const SUBAGENT_PARTIAL_TEXT = '以下是它寫到一半的內容：';

const TASK_TOOL = 'task';

/**
 * 這張卡是不是子代理撞到輸出上限而失敗的 `task`。
 *
 * @param entry - 工具卡的那一格。
 * @returns 是的話帶寫到一半的那段（沒寫出字是空字串）；不是、或措辭認不出來時沒有。
 */
export function subagentMaxTokensOf(entry: ToolEntry): { readonly partial: string } | undefined {
  if (entry.name !== TASK_TOOL || entry.status !== 'failed' || entry.error === undefined) {
    return undefined;
  }
  const newline = entry.error.indexOf('\n');
  const headline = newline < 0 ? entry.error : entry.error.slice(0, newline);
  if (!headline.endsWith(SUBAGENT_MAX_TOKENS_REASON)) return undefined;
  if (newline < 0) return { partial: '' };
  const rest = entry.error.slice(newline + 1);
  const lead = `${PARTIAL_OUTPUT_HEADING}\n`;
  return rest.startsWith(lead) ? { partial: rest.slice(lead.length) } : undefined;
}
