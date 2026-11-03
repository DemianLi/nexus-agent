/**
 * 宿主頁工具量測的判準（[#2398](https://github.com/DemianLi/nexus-agent/issues/2398)）：一題一次叫對工具了沒有。純函式，只看宿主頁收到的呼叫與回答的字。
 *
 * 三種結果：
 *
 * - `wrong`（主指標）：叫了期望之外的宿主頁工具，或對象不對（工具名對、`id` 不對也算）。跟畫面無關的題，叫了任何一支都算。
 * - `miss`：沒叫錯，但期望的呼叫沒叫齊，或「先…再…」的題先後顛倒。
 * - `ok`：期望的都叫到，沒有多叫別的。同一個呼叫叫了不只一次不算錯。
 *
 * 判準之外另數兩種外露（{@link leaksOf}）：回答照抄了包住說明、結果、錯誤的固定的字或逾時那一句（`HOST_TOOL_WORDINGS`），或把 `page__` 開頭的工具名講給使用者。使用者看得到，但不算叫錯。
 */

import { HOST_TOOL_PREFIX } from '@nexus/wire';

import { HOST_TOOL_WORDINGS } from '../../host-tools.js';
import type { ExpectedCall, Question } from './fixture.js';

export type Verdict = 'ok' | 'wrong' | 'miss';

/** 宿主頁收到的一次呼叫：宣告時的名字（不帶 `page__`）與模型給的參數。 */
export interface HostCall {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface Observation {
  /** 宿主頁收到的呼叫，依收到的順序。 */
  readonly calls: readonly HostCall[];
  readonly answer: string;
}

/** 連字號換成別的連字號或破折號、負號、小型或全形連字號的，比對前一律換回 `-`（同畫面情境量測）。 */
const DASHES = /[‐-―−﹣－]/gu;

function normalizedId(value: unknown): string | undefined {
  return typeof value === 'string' ? value.replace(DASHES, '-').trim().toUpperCase() : undefined;
}

function sameCall(call: HostCall, expected: ExpectedCall): boolean {
  return call.name === expected.name && normalizedId(call.args['id']) === expected.id;
}

export function judge(question: Question, observation: Observation): Verdict {
  const { calls } = observation;
  if (calls.some((call) => !question.expected.some((expected) => sameCall(call, expected)))) {
    return 'wrong';
  }
  const firstIndex = question.expected.map((expected) =>
    calls.findIndex((call) => sameCall(call, expected)),
  );
  if (firstIndex.some((index) => index === -1)) return 'miss';
  if (
    question.ordered === true &&
    firstIndex.some((index, at) => at > 0 && index < firstIndex[at - 1]!)
  ) {
    return 'miss';
  }
  return 'ok';
}

/** 回答讓使用者看到的工具內部：`wording` 照抄了固定的字，`tool-name` 講出了 `page__` 開頭的工具名。 */
export type Leak = 'wording' | 'tool-name';

/** 照抄的門檻：回答裡出現固定的字連續這麼多字就算（同畫面情境量測）。 */
const VERBATIM_RUN = 12;

/** 回答裡的外露，依 `wording`、`tool-name` 的順序列出，沒有就是空陣列。 */
export function leaksOf(answer: string): Leak[] {
  const leaks: Leak[] = [];
  const verbatim = HOST_TOOL_WORDINGS.some((piece) => {
    for (let start = 0; start + VERBATIM_RUN <= piece.length; start += 1) {
      if (answer.includes(piece.slice(start, start + VERBATIM_RUN))) return true;
    }
    return false;
  });
  if (verbatim) leaks.push('wording');
  if (answer.includes(HOST_TOOL_PREFIX)) leaks.push('tool-name');
  return leaks;
}
