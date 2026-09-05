/**
 * 權限判準：**往回追鏈**，以及**不是 `message` 的一律停住**。
 *
 * 第二組是這個檔存在的主因，而且它在
 * [#180](https://github.com/DemianLi/nexus-agent/issues/180) **從絆索翻成了驗收句**：
 * `turn/start` 現在真的有第三個成員，`kind: 'goal'` 那一組不再需要 cast 就造得出來。
 * 第三組（`kind: 'unknown'`）接手當絆索——它擋的是**第四個**生產者。
 */

import { describe, expect, it } from 'vitest';

import { SessionLog } from '@nexus/core';
import { goalId } from '@nexus/core';
import type { GoalId, SessionEvent, SessionEventMap } from '@nexus/core';

import { hasDirectHumanTurn } from './authority.js';

/**
 * **釘住 `turn/start` 的酬載聯集剛好是那三個成員。**
 *
 * 互相指派：多一個成員時上面那行紅（放寬），少一格或改欄位時下面那行紅（收窄）。
 * 釘的是欄位不是介面名——把型別改名不會讓這一條變綠。
 *
 * **這一條為什麼特別重要**：這個聯集是授權的判別欄（`session-log.ts`）。放寬它就是開一
 * 條新的授權路徑，而 `hasDirectHumanTurn` 對認不得的成員是 fail-closed——**加一個成員不
 * 會讓任何一條現有測試變紅**，只會讓那條路悄悄多一個生產者。所以放寬必須在這裡先紅。
 */
type TurnStart = SessionEventMap['turn/start'];
type PinnedTurnStart =
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'resume' }
  | {
      readonly kind: 'goal';
      readonly text: string;
      readonly goalId: GoalId;
      readonly revision: number;
      readonly round: number;
    };
const _widened: PinnedTurnStart = undefined as unknown as TurnStart;
const _narrowed: TurnStart = undefined as unknown as PinnedTurnStart;
void _widened;
void _narrowed;

/** 一份真的日誌，照給的劇本 append。 */
function logOf(script: readonly (readonly [keyof SessionEventMap, unknown])[]): SessionLog {
  const log = new SessionLog('authority');
  for (const [type, data] of script) {
    log.append(type as 'turn/end', data as SessionEventMap['turn/end']);
  }
  return log;
}

const HUMAN: readonly [keyof SessionEventMap, unknown] = [
  'turn/start',
  { kind: 'message', text: '動手' },
];
const RESUME: readonly [keyof SessionEventMap, unknown] = ['turn/start', { kind: 'resume' }];
const END: readonly [keyof SessionEventMap, unknown] = ['turn/end', {}];

describe('往回追鏈', () => {
  it('一則人類訊息就是根', () => {
    expect(hasDirectHumanTurn(logOf([HUMAN]).events)).toBe(true);
  });

  it('一顆事件都沒有時是假', () => {
    expect(hasDirectHumanTurn([])).toBe(false);
  });

  it('有事件但一顆 turn/start 都沒有時是假', () => {
    expect(hasDirectHumanTurn(logOf([['todo/write', { todos: [] }]]).events)).toBe(false);
  });

  /**
   * **這一條是這個檔的主角。** 停在核准點也算 `turn/end`，恢復 append 的是一顆新的
   * `turn/start{resume}`——人剛剛動了兩次手，寫成「最後一顆是不是 message」卻會拒絕。
   */
  it('人打字 → 停核准 → 恢復，恢復那一段照樣有人類授權', () => {
    const events = logOf([HUMAN, ['interrupt/raised', { interruptId: 'i-1' }], END, RESUME]).events;
    expect(hasDirectHumanTurn(events)).toBe(true);
  });

  it('連著兩次核准恢復也追得回去', () => {
    const events = logOf([HUMAN, END, RESUME, END, RESUME]).events;
    expect(hasDirectHumanTurn(events)).toBe(true);
  });

  it('只有 resume、追到頭都沒有人類訊息時是假', () => {
    expect(hasDirectHumanTurn(logOf([RESUME, END, RESUME]).events)).toBe(false);
  });
});

describe('goal 來源的輪次', () => {
  /**
   * **不再需要 cast**——這正是這張卡把絆索翻成驗收句的那一格。
   * 排程器排的那一輪在日誌上就長這樣，而它**不帶人類授權**。
   */
  const GOAL_ROUND: readonly [keyof SessionEventMap, unknown] = [
    'turn/start',
    { kind: 'goal', text: '<goal_round>…', goalId: goalId('g-1'), revision: 1, round: 1 },
  ];

  it('它自己不算人類授權', () => {
    expect(hasDirectHumanTurn(logOf([GOAL_ROUND]).events)).toBe(false);
  });

  /**
   * **不往回穿。** 一則更早的人類輪次不該替一個未知的生產者背書——這正是「先做驅動器
   * 會安靜地把權限送給模型」那條的機械版本。
   */
  it('它擋在前面時，更早的人類輪次也撿不到', () => {
    expect(hasDirectHumanTurn(logOf([HUMAN, END, GOAL_ROUND]).events)).toBe(false);
  });

  /** 同上，只是中間隔了一次核准恢復——鏈往回追的路上撞到它一樣停住。 */
  it('它後面接一次核准恢復也一樣停住', () => {
    const events = logOf([HUMAN, END, GOAL_ROUND, END, RESUME]).events;
    expect(hasDirectHumanTurn(events)).toBe(false);
  });
});

describe('認不得的第四種 kind', () => {
  /**
   * **絆索在這裡接手。** 聯集現在有三個成員，所以這一種一樣造不出來，一樣用 cast。
   *
   * 它擋的是**下一個**生產者：`authority.ts` 那條 fail-closed 的理由跟 `goal` 是不是
   * 已知無關——一個沒人審過的來源既不該自己拿到人類授權，也不該讓我們越過它去撿一則更
   * 早的人類輪次。加第四個成員的人要先讓上面那組型別釘紅，然後回來讀這一段。
   */
  const UNKNOWN = [
    'turn/start',
    { kind: 'scheduled', text: '每天早上跑一次' },
  ] as unknown as readonly [keyof SessionEventMap, unknown];

  it('它自己不算人類授權', () => {
    expect(hasDirectHumanTurn(logOf([UNKNOWN]).events)).toBe(false);
  });

  it('它擋在前面時，更早的人類輪次也撿不到', () => {
    expect(hasDirectHumanTurn(logOf([HUMAN, END, UNKNOWN]).events)).toBe(false);
  });
});

describe('讀的是事件不是日誌', () => {
  it('收到什麼陣列就追什麼——序列來自呼叫端', () => {
    const crafted: readonly SessionEvent[] = [
      { seq: 0, at: 1, type: 'turn/start', data: { kind: 'message', text: '嗨' } },
    ] as unknown as readonly SessionEvent[];
    expect(hasDirectHumanTurn(crafted)).toBe(true);
  });
});
