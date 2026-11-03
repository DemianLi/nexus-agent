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
 * 「反問」是呼叫了 `ask_user_question`，或回答以問號收尾而且在問是哪一台（「哪一台」「哪個」「還是」「是指」）。
 */

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

export function askedWhich(observation: Observation): boolean {
  if (observation.askText.trim() !== '') return true;
  const answer = observation.answer.trim();
  return /哪一?[台個座]|還是|是指/u.test(answer) && /[？?]\s*$/u.test(answer);
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
