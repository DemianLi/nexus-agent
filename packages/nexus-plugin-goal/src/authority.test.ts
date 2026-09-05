/**
 * 權限判準：**往回追鏈**，以及**認不得的 `kind` 一律停住**。
 *
 * 第二組是這個檔存在的主因。它今天是絆索——`turn/start` 只有兩個成員，所以那條路走不到；
 * 補上 `source` 判別欄與續行驅動器的那天，它會變成驗收句（`authority.ts` 檔頭）。
 */

import { describe, expect, it } from 'vitest';

import { SessionLog } from '@nexus/core';
import type { SessionEvent, SessionEventMap } from '@nexus/core';

import { hasDirectHumanTurn } from './authority.js';

/**
 * **釘住 `turn/start` 的酬載聯集剛好是那兩個成員。**
 *
 * 互相指派：多一個成員時上面那行紅（放寬），少一格或改欄位時下面那行紅（收窄）。
 * 釘的是欄位不是介面名——把型別改名不會讓這一條變綠。
 */
type TurnStart = SessionEventMap['turn/start'];
type PinnedTurnStart =
  { readonly kind: 'message'; readonly text: string } | { readonly kind: 'resume' };
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

describe('認不得的 kind', () => {
  /**
   * 今天造不出這種事件（聯集只有兩個成員，上面那組型別釘住了），所以用 cast 造。
   * **`goal` 這個 kind 正是 dsh 的 `goal-round-driver` 會排入的那一種。**
   */
  const GOAL_ROUND = [
    'turn/start',
    { kind: 'goal', goalId: 'g-1', round: 1 },
  ] as unknown as readonly [keyof SessionEventMap, unknown];

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

describe('讀的是事件不是日誌', () => {
  it('收到什麼陣列就追什麼——序列來自呼叫端', () => {
    const crafted: readonly SessionEvent[] = [
      { seq: 0, at: 1, type: 'turn/start', data: { kind: 'message', text: '嗨' } },
    ] as unknown as readonly SessionEvent[];
    expect(hasDirectHumanTurn(crafted)).toBe(true);
  });
});
