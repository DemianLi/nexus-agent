/**
 * 續行的**決策**：什麼時候排得出一輪，什麼時候不排、為什麼。
 *
 * 這一份只驗純函式。接上去的兩條路（`thread-pump.ts` 與 `cli.ts`）各自有自己的驗收，
 * 而**那兩條才證得了「模型讀到的字」與「日誌上寫的字」是同一串**。
 */

import { describe, expect, it } from 'vitest';

import { goalId, SessionLog } from '@nexus/core';
import type { SessionEventMap } from '@nexus/core';
import { renderGoalRoundPrompt } from '@nexus/plugin-goal';
import type { GoalView } from '@nexus/plugin-goal';

import {
  decideGoalRound,
  driveGoalRound,
  ROUND_CAP_BLOCK_CODE,
  ROUND_LIMIT_BLOCK_CODE,
} from './goal-driver.js';
import type { GoalDriverPort } from './goal-driver.js';

const ID = goalId('goal-1');

function view(overrides: Partial<GoalView> = {}): GoalView {
  return {
    id: ID,
    revision: 1,
    objective: '把 CI 修綠',
    phase: 'active',
    maxGoalRounds: 8,
    roundsStarted: 0,
    createdAt: 10,
    updatedAt: 10,
    activation: 'armed',
    ...overrides,
  };
}

function logOf(script: readonly (readonly [string, unknown])[]): SessionLog {
  const log = new SessionLog('driver');
  for (const [type, data] of script) {
    log.append(type as 'turn/end', data as SessionEventMap['turn/end']);
  }
  return log;
}

const HUMAN: readonly [string, unknown] = ['turn/start', { kind: 'message', text: '動手' }];
const END: readonly [string, unknown] = ['turn/end', {}];
const RAISED: readonly [string, unknown] = ['interrupt/raised', { interruptId: 'i-1' }];

/** 一輪人打的話，好好收工了。 */
const SETTLED = [HUMAN, END] as const;

describe('排得出一輪', () => {
  it('人那一輪收工了、目標 active 且已授權——排第 1 輪', () => {
    const decision = decideGoalRound(logOf(SETTLED).events, view());
    expect(decision).toEqual({
      kind: 'run',
      round: { text: renderGoalRoundPrompt(view(), 1), goalId: ID, revision: 1, round: 1 },
    });
  });

  it('下一輪的號是 roundsStarted + 1', () => {
    const decision = decideGoalRound(logOf(SETTLED).events, view({ roundsStarted: 3 }));
    expect(decision.kind === 'run' && decision.round.round).toBe(4);
  });

  /**
   * **文字只 render 一次，而且就是這個值。** 入口點拿它同時寫日誌與構模型訊息，所以
   * 「日誌上寫的」與「模型讀到的」在結構上是同一串字。這一條釘的是決策交出去的那一份
   * 逐字等於套件自有的 renderer——伴生驗的也是它。
   */
  it('交出去的文字逐字等於套件自有的 renderer', () => {
    const goal = view({ objective: '把測試修綠', maxGoalRounds: 4, roundsStarted: 1 });
    const decision = decideGoalRound(logOf(SETTLED).events, goal);
    expect(decision.kind === 'run' && decision.round.text).toBe(renderGoalRoundPrompt(goal, 2));
  });
});

describe('上限耗盡', () => {
  it('記一顆 round-limit 的 blocker，不排', () => {
    const decision = decideGoalRound(
      logOf(SETTLED).events,
      view({ maxGoalRounds: 2, roundsStarted: 2 }),
    );
    expect(decision).toEqual({
      kind: 'block',
      ref: { id: ID, revision: 1 },
      reason: { code: ROUND_LIMIT_BLOCK_CODE, message: '目標用完了設定的 2 個續行輪次。' },
    });
  });

  it('剛好差一輪的時候還排得出來——邊界是 >=，不是 >', () => {
    const decision = decideGoalRound(
      logOf(SETTLED).events,
      view({ maxGoalRounds: 2, roundsStarted: 1 }),
    );
    expect(decision.kind === 'run' && decision.round.round).toBe(2);
  });
});

/**
 * 操作的人那一條上限。**它跟目標自己那一條是兩件事**：目標那個數字是模型在
 * `create_goal` 裡填的（`service.ts:269` 的 `??` 不是 `Math.min`），所以「上限」在沒有這
 * 一格之前完全由模型自己挑。
 */
describe('命令列給的那條上限', () => {
  it('目標自己那條還很寬，人設的那條照樣夾得住', () => {
    const decision = decideGoalRound(
      logOf(SETTLED).events,
      view({ maxGoalRounds: 99, roundsStarted: 3 }),
      3,
    );
    expect(decision).toEqual({
      kind: 'block',
      ref: { id: ID, revision: 1 },
      reason: {
        code: ROUND_CAP_BLOCK_CODE,
        message: '這一次呼叫用完了 --max-goal-rounds 給的 3 個續行輪次。',
      },
    });
  });

  it('還沒到就照排——邊界同樣是 >=，不是 >', () => {
    const decision = decideGoalRound(
      logOf(SETTLED).events,
      view({ maxGoalRounds: 99, roundsStarted: 2 }),
      3,
    );
    expect(decision.kind === 'run' && decision.round.round).toBe(3);
  });

  /**
   * **兩條同時到頂時，說出來的名字是目標自己那一條。** 那一刻人設的閘沒有夾到任何東西，
   * 算成 `round-cap` 會把功勞記錯——而「模型自己收斂到上限」與「人先夾住它」分不分得開，
   * 正是開著旗標跑真模型時要看的那件事。
   */
  it('兩條同時到頂，記的是 round-limit 不是 round-cap', () => {
    const decision = decideGoalRound(
      logOf(SETTLED).events,
      view({ maxGoalRounds: 2, roundsStarted: 2 }),
      2,
    );
    expect(decision.kind === 'block' && decision.reason.code).toBe(ROUND_LIMIT_BLOCK_CODE);
  });

  it('沒給就只剩目標自己那一條，寬到哪裡都排得出來', () => {
    const decision = decideGoalRound(
      logOf(SETTLED).events,
      view({ maxGoalRounds: 256, roundsStarted: 99 }),
    );
    expect(decision.kind === 'run' && decision.round.round).toBe(100);
  });
});

/**
 * 到頂那一刻**真的記得下 blocker**——`decideGoalRound` 只回一個意圖，執行是
 * `driveGoalRound` 的事，而那兩件事之間是這條路上唯一有 side effect 的一步。
 */
describe('到頂之後記的那顆 blocker', () => {
  function portOf(goal: GoalView): GoalDriverPort & { readonly blocked: string[] } {
    const blocked: string[] = [];
    return {
      blocked,
      goal: () => goal,
      block: (_ref, reason) => void blocked.push(reason.code),
      disarm: () => {},
      flush: () => Promise.resolve(),
      warn: () => {},
    };
  }

  it('人設的那條到頂，記 round-cap 而且不排', async () => {
    const port = portOf(view({ maxGoalRounds: 99, roundsStarted: 3 }));
    const round = await driveGoalRound(() => logOf(SETTLED).events, port, 3);
    expect(round).toBeUndefined();
    expect(port.blocked).toEqual([ROUND_CAP_BLOCK_CODE]);
  });

  /**
   * **同一份目標、同一份日誌，只拿掉 `roundCap` 這一個變數。** 少了這一格對照，上面那條
   * 綠只證得了「這個狀態會 block」，證不了 block 是那條上限造成的——`roundsStarted: 3`
   * 在別的判準底下也可能自己停下來。
   */
  it('同一個狀態沒給上限就照排——對照組', async () => {
    const port = portOf(view({ maxGoalRounds: 99, roundsStarted: 3 }));
    const round = await driveGoalRound(() => logOf(SETTLED).events, port);
    expect(round?.round).toBe(4);
    expect(port.blocked).toEqual([]);
  });
});

describe('排不出來的每一種，理由各自有名字', () => {
  it('一輪都還沒開始', () => {
    expect(decideGoalRound([], view())).toEqual({ kind: 'idle', reason: 'no-turn' });
  });

  /**
   * **這兩條要分得開。**
   *
   * 「還在跑」與「拋錯結束」都不排，但成因不同：前者等它跑完，後者**永遠不再排**——
   * 異常自動重試明著在範圍外，不然一次供應商錯誤會變成 256 次重試。合成一句「最後一顆
   * 不是 `turn/end`」的話，一次「拋錯之後照樣續行」的重構會通過每一條測試。
   */
  it('上一輪還在跑', () => {
    expect(decideGoalRound(logOf([HUMAN]).events, view())).toEqual({
      kind: 'idle',
      reason: 'turn-open',
    });
  });

  it('上一輪拋錯結束——**理由與「還在跑」不同**', () => {
    const failed = logOf([HUMAN, ['turn/failed', { message: '供應商掛了' }]]).events;
    expect(decideGoalRound(failed, view())).toEqual({ kind: 'idle', reason: 'turn-failed' });
  });

  /** 停在核准點也算 `turn/end`——少了這一句，排程器會把一顆掛著的中斷靜靜吃掉。 */
  it('停在核准點', () => {
    expect(decideGoalRound(logOf([HUMAN, RAISED, END]).events, view())).toEqual({
      kind: 'idle',
      reason: 'interrupt-pending',
    });
  });

  it('沒有目標', () => {
    expect(decideGoalRound(logOf(SETTLED).events, undefined)).toEqual({
      kind: 'idle',
      reason: 'no-goal',
    });
  });

  it('相位不是 active——完成、暫停、被擋住都不排', () => {
    for (const phase of ['complete', 'paused', 'blocked'] as const) {
      expect(decideGoalRound(logOf(SETTLED).events, view({ phase }))).toEqual({
        kind: 'idle',
        reason: 'not-active',
      });
    }
  });

  /**
   * **掛載、resume、fork 之後絕不自行復活。** 授權從 `disarmed` 開始，要一次有人授權的
   * `create` 或 `resume` 才 armed。這一條擋的是「接上一份既有日誌就自己動起來」。
   */
  it('相位 active 但沒有授權', () => {
    expect(decideGoalRound(logOf(SETTLED).events, view({ activation: 'disarmed' }))).toEqual({
      kind: 'idle',
      reason: 'disarmed',
    });
  });
});
