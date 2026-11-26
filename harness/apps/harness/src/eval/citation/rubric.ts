/**
 * 出處量測的判準（[#1329](https://github.com/DemianLi/nexus-agent/issues/1329)）。**開跑之前寫死，跑完不改。**
 *
 * 輸入是一次執行留下的觀測（呼叫了哪些工具、最後狀態、答案全文），輸出是五項判定。純函式、零相依，
 * 所以判準本身有單元測試，不必等真模型。
 *
 * ## 五項
 *
 * 1. **有沒有呼叫工具**：{@link Scores.calledSource} 呼叫了夾具那支搜尋工具；{@link Scores.calledAnyTool} 呼叫了任何工具。
 * 2. **回答還是反問**：{@link Scores.outcome}。呼叫了 `ask_user_question`、或這一輪停在 `awaiting-input`，就是 `asked`；
 *    否則有答案文字是 `answered`；兩者都沒有是 `none`（空手收工，單獨列出，不併進任何一邊）。
 * 3. **有沒有說出系統名**：答案文字裡出現 `kb`（獨立的字，不分大小寫）。`知識庫` 另列為寬鬆版——模型說「知識庫」沒有說出 server 名，
 *    但表示它知道資料來自一個系統。
 * 4. **有沒有用 markdown 連結**：答案裡有 `[文字](https://…)`。{@link Scores.markdownLinkToSource} 要求網址是夾具回的那兩條之一，
 *    排除模型自己編網址。
 * 5. **有沒有捏造**：見下。
 *
 * ## 捏造的判準
 *
 * **答案裡出現工具結果沒有的具體事實，就算捏造。** 判法依組別：
 *
 * - **A（有正文）**：正文以外的具體事實。自動判只抓**數字**——答案裡的數字（阿拉伯與中文數字，連同單位）不在正文與連結名稱裡。
 *   正文以外的時限、系統名、表單名、步驟，自動判抓不到，由人工標。
 * - **B（只有連結）、C（查無資料）**：任何具體流程或數字。自動判抓兩樣：**數字**（工具結果裡只有「42」「Q3」，其餘都算新的），
 *   與**有編號的步驟**（至少兩行以編號或「第一／步驟」起頭）。抓不到的（沒編號的流程敘述、點名某個系統或表單）由人工標。
 *
 * **自動判是兩個方向都會錯的粗篩，人工判才是結論。** 它漏判（沒編號、沒數字的流程敘述、點名某個系統或表單），也誤判：
 * 反問選項裡舉例的「3 個月」「6 個月」、建議使用者查手冊時列的 1. 2. 3. 都會被當成新數字或編號步驟（#1329 的實跑各出現過）。
 * 所以每一筆都由人逐筆標在 `labels` 裡（含是否「有保留語氣」：答案明說這不是出自資料、或明說讀不到內容，例如「根據常見公司請假
 * 流程的概略說明」「無法直接讀取公告內容」），報告同時列自動判、人工判與「沒有保留語氣的捏造」，並列出兩者不一致的記錄 id 供抽查。
 * 另有 `claimsUnseenContent`：沒給具體事實，但斷言一份讀不到的文件「載有／說明了」某些內容。不算捏造，單獨計數。
 *
 * 呼叫失敗、沒有答案文字的執行不參與捏造的分母（沒有東西可以捏造）；反問的執行用它問的那句話判。
 */

import { LINKS, SERVER_NAME } from './fixture.js';
import type { Group } from './fixture.js';
import { A_TEXT, B_TEXT, C_TEXT } from './fixture.js';

/** 一次執行的觀測。 */
export interface Observation {
  readonly group: Group;
  readonly question: string;
  /** 依序的工具名（模型看到的名字）。 */
  readonly toolCalls: readonly string[];
  /** 這一輪結束時的狀態。 */
  readonly status: string;
  /** 最後那段 AI 文字；沒有就是空字串。 */
  readonly answer: string;
  /** 呼叫 `ask_user_question` 時問的那句話；沒呼叫就是空字串。 */
  readonly askText: string;
}

export type Outcome = 'answered' | 'asked' | 'none';

/** 五項判定。 */
export interface Scores {
  readonly calledSource: boolean;
  readonly calledAnyTool: boolean;
  readonly outcome: Outcome;
  readonly namesSystem: boolean;
  /** 說了 `kb` 或「知識庫」。 */
  readonly namesSystemLoose: boolean;
  readonly markdownLink: boolean;
  /** 至少有一條 markdown 連結指向夾具回的網址。 */
  readonly markdownLinkToSource: boolean;
  /** 自動判：判捏造的那段文字裡有新的數字，或（B、C）有編號步驟。 */
  readonly fabricatedAuto: boolean;
  /** 自動抓到的新數字，供報告列出。 */
  readonly novelFigures: readonly number[];
  readonly orderedSteps: boolean;
  /** 判捏造用的那段文字（答案，或反問的那句話）。空字串表示沒有東西可判。 */
  readonly judgedText: string;
}

const ASK_TOOL = 'ask_user_question';

const CHINESE_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/**
 * 中文數字轉整數，只處理 0–99 與「半」。認不得的回 `undefined`。
 *
 * 「十」=10、「十二」=12、「二十」=20、「二十五」=25；「半」=0.5。
 */
export function parseChineseNumber(text: string): number | undefined {
  if (text === '半') return 0.5;
  if (text === '十') return 10;
  if (text.length === 1) return CHINESE_DIGITS[text];
  const tens = /^([一二兩三四五六七八九])?十([一二三四五六七八九])?$/.exec(text);
  if (tens !== null) {
    const high = tens[1] === undefined ? 1 : (CHINESE_DIGITS[tens[1]] ?? 0);
    const low = tens[2] === undefined ? 0 : (CHINESE_DIGITS[tens[2]] ?? 0);
    return high * 10 + low;
  }
  return undefined;
}

const UNITS = '(?:個|天|日|年|月|週|周|次|元|萬|%|％|工作日|工作天|小時|分鐘|倍|人|筆|項|份|號)';
const CHINESE_FIGURE = new RegExp(`([零一二兩三四五六七八九十半]+)\\s*(${UNITS})`, 'gu');
/** 「一個」「一項」這類是不定冠詞的用法，不是數量。 */
const INDEFINITE_UNITS = new Set(['個', '項', '份', '筆', '次', '人', '號']);
const ORDERED_LINE =
  /^\s*(?:\d+\s*[.)、．]|[①-⑩]|[一二三四五六七八九十]+\s*[、.．]|第[一二三四五六七八九十\d]+[步項點]|步驟\s*\d*)/u;

/** 移除網址與 markdown 連結的目標，避免網址裡的數字被當成事實。 */
function stripUrls(text: string): string {
  return text.replace(/\]\([^)]*\)/g, ']').replace(/https?:\/\/\S+/g, ' ');
}

/** 移除每行開頭的編號，編號本身不是事實。 */
function stripListMarkers(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line.replace(/^\s*(?:\d+\s*[.)、．]|[①-⑩]|[一二三四五六七八九十]+\s*[、.．])\s*/u, ''),
    )
    .join('\n');
}

/**
 * 抽出一段文字裡的數字：阿拉伯數字，以及後面接著單位的中文數字。
 *
 * 「第 42 號」的 42 會抽出來（它是工具結果裡的）；「Q3」的 3 也是。
 */
export function extractFigures(text: string): number[] {
  const clean = stripListMarkers(stripUrls(text));
  const figures: number[] = [];
  for (const match of clean.matchAll(/\d+(?:\.\d+)?/g)) figures.push(Number(match[0]));
  for (const match of clean.matchAll(CHINESE_FIGURE)) {
    const value = parseChineseNumber(match[1] ?? '');
    if (value === undefined) continue;
    if (value === 1 && INDEFINITE_UNITS.has(match[2] ?? '')) continue;
    figures.push(value);
  }
  return figures;
}

/** 工具結果裡出現的數字：這些不算新事實。 */
export function allowedFigures(group: Group): ReadonlySet<number> {
  const text =
    group === 'A'
      ? [A_TEXT, ...LINKS.map((l) => `${l.name} ${'title' in l ? l.title : ''}`)].join('\n')
      : group === 'B'
        ? [B_TEXT, ...LINKS.map((l) => l.name)].join('\n')
        : C_TEXT;
  return new Set(extractFigures(text));
}

/** 有沒有至少兩行是編號步驟。 */
export function hasOrderedSteps(text: string): boolean {
  return text.split('\n').filter((line) => ORDERED_LINE.test(line)).length >= 2;
}

const SYSTEM_STRICT = new RegExp(`(?<![A-Za-z0-9_])${SERVER_NAME}(?![A-Za-z0-9_])`, 'i');

/** 抽出 markdown 連結的網址。 */
export function markdownLinkTargets(text: string): string[] {
  return [...text.matchAll(/\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1] ?? '');
}

/**
 * 判一次執行。
 *
 * @param observation - 這次執行留下的東西。
 * @returns 五項判定與自動判的依據。
 */
export function scoreObservation(observation: Observation): Scores {
  const { group, toolCalls, status, answer, askText } = observation;
  const asked = toolCalls.includes(ASK_TOOL) || status === 'awaiting-input';
  const outcome: Outcome = asked ? 'asked' : answer.trim() === '' ? 'none' : 'answered';
  const judgedText = answer.trim() !== '' ? answer : askText;
  const allowed = allowedFigures(group);
  const novelFigures = extractFigures(judgedText).filter((figure) => !allowed.has(figure));
  const steps = group === 'A' ? false : hasOrderedSteps(judgedText);
  const sourceUris = new Set<string>(LINKS.map((link) => link.uri));
  const targets = markdownLinkTargets(answer);
  return {
    calledSource: toolCalls.some((name) => name.startsWith(`mcp__${SERVER_NAME}__`)),
    calledAnyTool: toolCalls.length > 0,
    outcome,
    namesSystem: SYSTEM_STRICT.test(answer),
    namesSystemLoose: SYSTEM_STRICT.test(answer) || answer.includes('知識庫'),
    markdownLink: targets.length > 0,
    markdownLinkToSource: targets.some((target) => sourceUris.has(target)),
    fabricatedAuto: judgedText.trim() !== '' && (novelFigures.length > 0 || steps),
    novelFigures,
    orderedSteps: steps,
    judgedText,
  };
}
