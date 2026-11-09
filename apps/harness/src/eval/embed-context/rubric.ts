/**
 * 畫面情境量測的判準（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）：一次回答拿錯對象了沒有。純函式，只看回答的字與有沒有反問。
 *
 * 每一類只有三種結果：`ok`、`wrong`（拿錯對象，主指標）、`miss`（沒拿錯，但沒照規則做，例如指代不明時沒寫出是哪一台）。
 *
 * - `named`：只提選取的、沒提問句點名的 → `wrong`；提了點名的 → `ok`；兩個都沒提 → `miss`。
 * - `ambiguous`：反問 → `ok`；第一句有選取的編號 → `ok`；回答有別的設備編號、沒有選取的 → `wrong`；其餘 → `miss`。
 * - `unrelated`：提了選取的 → `wrong`；其餘 → `ok`。
 * - `unclear`：反問 → `ok`；沒反問而回答裡只挑了一群裡的某一台 → `wrong`；其餘 → `miss`。
 *
 * 「反問」是呼叫了 `ask_user_question`，或回答裡有一句在問使用者是哪一台（{@link askedWhich}）。
 *
 * 判準之外另數兩種外露（{@link leaksOf}）：照抄情境區塊的原文、對使用者講出規則。使用者看得到，但不算拿錯對象。
 */

import { PAGE_CONTEXT_WORDINGS } from '@nexus/core';

import type { Question } from './fixture.js';

export type Verdict = 'ok' | 'wrong' | 'miss';

export interface Observation {
  readonly answer: string;
  /** `ask_user_question` 問的字；沒問是空字串。 */
  readonly askText: string;
}

/** 設備編號：一到三個大寫字母、一個連字號、一到三位數字。 */
const DEVICE_ID = /\b[A-Z]{1,3}-\d{1,3}\b/gu;

/**
 * 編號裡的連字號換成別的連字號或破折號（U+2010–U+2015）、負號（U+2212）、小型或全形連字號（U+FE63、U+FF0D）的，比對前一律換回 `-`。
 * lightning 30B 實跑寫過 U+2011（#2367 試跑的 a2）。
 */
const DASHES = /[\u2010-\u2015\u2212\uFE63\uFF0D]/gu;

function idsIn(text: string): Set<string> {
  return new Set(text.replace(DASHES, '-').match(DEVICE_ID) ?? []);
}

/** 第一句：到第一個句號、問號、驚嘆號或換行為止。 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = trimmed.search(/[。？！?!\n]/u);
  return end === -1 ? trimmed : trimmed.slice(0, end + 1);
}

/** 一句：到句號、問號、驚嘆號、冒號或換行為止（含那個標點）。 */
function sentencesOf(text: string): string[] {
  return text.match(/[^。！？!?：:\n]+[。！？!?：:\n]?/gu) ?? [];
}

/** 一句是在問使用者、或請使用者講清楚：問號或冒號收尾，或帶「請問」「請您」「請確認」這類。 */
const ASKING = /[？?：:]\s*$|請(?:問|您|確認|明確|說明|指明|告訴)/u;

/** 問的是哪一台：「哪一台」這類、「其他設備」「特定機台」、「還是」「或者」緊接著一個編號、「是指 … 嗎」。 */
const WHICH =
  /哪一?[台座部組]|(?:其他|特定)的?(?:機台|設備|機器)|(?:還是|或者|或是)\s*(?:\*\*)?\s*[A-Z]{1,3}-\d|是指.{0,24}[嗎吗]/u;

/**
 * 反問了是哪一台：呼叫了 `ask_user_question`，或回答裡有一句同時合乎 {@link ASKING} 與 {@link WHICH}。問句後面還接著別的話也算：
 * #2378 的正式跑裡，模型會在中段反問、後面接著講通則（#2380）。「還是需要我查別的來源」這種不是在問是哪一台，不算。
 */
export function askedWhich(observation: Observation): boolean {
  if (observation.askText.trim() !== '') return true;
  return sentencesOf(observation.answer.replace(DASHES, '-')).some(
    (sentence) => ASKING.test(sentence.trim()) && WHICH.test(sentence),
  );
}

/** 回答讓使用者看到的情境區塊內容：`verbatim` 照抄了區塊的原文，`rules` 對使用者講出了規則或系統提示。 */
export type Leak = 'verbatim' | 'rules';

/** 照抄的門檻：回答裡出現區塊固定字（任一份，見 `PAGE_CONTEXT_WORDINGS`）連續這麼多字就算。 */
const VERBATIM_RUN = 12;

const FIXED_PIECES = PAGE_CONTEXT_WORDINGS.flatMap(({ open, tail }) => [open, tail]).map((piece) =>
  piece.replace(/<\/?system-reminder>/gu, ''),
);

/**
 * 講出規則：「依（照）規則」「根據系統提示」「系統訊息」這類。情境區塊要模型在第一句寫明拿的是哪一個（地圖 #2365 第 8 點），
 * 所以「根據畫面情境，目前選取的是 X」不算。
 */
const CITES_RULES = /依照?規則|按照?規則|根據系統|系統(?:提示|訊息|指示)/u;

/** 回答裡的外露，依 `verbatim`、`rules` 的順序列出，沒有就是空陣列。只看回答的字。 */
export function leaksOf(answer: string): Leak[] {
  const leaks: Leak[] = [];
  const verbatim = FIXED_PIECES.some((piece) => {
    for (let start = 0; start + VERBATIM_RUN <= piece.length; start += 1) {
      if (answer.includes(piece.slice(start, start + VERBATIM_RUN))) return true;
    }
    return false;
  });
  if (verbatim) leaks.push('verbatim');
  if (CITES_RULES.test(answer)) leaks.push('rules');
  return leaks;
}

export function judge(question: Question, observation: Observation): Verdict {
  const ids = idsIn(observation.answer);
  const mentionsSelected = question.selectedIds.some((id) => ids.has(id));
  switch (question.category) {
    case 'named': {
      const target = question.targetId ?? '';
      if (ids.has(target)) return 'ok';
      return mentionsSelected ? 'wrong' : 'miss';
    }
    case 'ambiguous': {
      if (askedWhich(observation)) return 'ok';
      const first = idsIn(firstSentence(observation.answer));
      if (question.selectedIds.some((id) => first.has(id))) return 'ok';
      return ids.size > 0 && !mentionsSelected ? 'wrong' : 'miss';
    }
    case 'unrelated':
      return mentionsSelected ? 'wrong' : 'ok';
    case 'unclear': {
      if (askedWhich(observation)) return 'ok';
      const picked = question.selectedIds.filter((id) => ids.has(id));
      return picked.length === 1 ? 'wrong' : 'miss';
    }
  }
}
