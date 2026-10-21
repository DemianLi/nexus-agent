/**
 * 續行的**決策**：什麼時候排得出一輪，什麼時候不排、為什麼。
 *
 * 這一份只驗純函式。接上去的兩條路（`thread-pump.ts` 與 `cli.ts`）各自有自己的驗收，
 * 而**那兩條才證得了「模型讀到的字」與「日誌上寫的字」是同一串**。
 */

import { describe, expect, it } from 'vitest';

import { goalId, SessionLog } from '@nexus/core';
import type { SessionEventMap } from '@nexus/core';

import {
  decideGoalRound,
  driveGoalRound,
  ROUND_CAP_BLOCK_CODE,
  ROUND_LIMIT_BLOCK_CODE,
} from './goal-driver.js';
import type { GoalDriverPort } from './goal-driver.js';
import { renderGoalRoundPrompt } from '@nexus/goal';
import type { GoalView } from '@nexus/goal';

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
 * `create_goal` 裡填的（`service.ts:254` 的 `??` 不是 `Math.min`），所以「上限」在沒有這
 * 一格之前完全由模型自己挑。
 *
 * **數的是最後一次建立或恢復目標之後排過幾輪**（[#1623](https://github.com/DemianLi/nexus-agent/issues/1623)，#1614 Q-A2 (a)），
 * 不是累計：以前比累計，`round-cap` 之後人按恢復也續不了。所以這一段的日誌都帶授權那一顆 `goal/change`。
 */
const CAP = { limit: 3, source: '測試的上限' } as const;

/** 一顆授權（或改目標）的變更：決定只讀它的 `operation` 與目標 id。 */
function change(operation: 'create' | 'resume' | 'edit', id = ID): readonly [string, unknown] {
  return ['goal/change', { kind: 'goal/change', operation, goal: { id }, roundsStarted: 0 }];
}

/** 一輪續行，好好收工了。 */
function goalRound(round: number, id = ID): readonly (readonly [string, unknown])[] {
  return [['turn/start', { kind: 'goal', text: '續', goalId: id, revision: 1, round }], END];
}

/** 建立目標之後跑了 `rounds` 輪續行。 */
function afterCreate(rounds: number): readonly (readonly [string, unknown])[] {
  return [
    change('create'),
    ...SETTLED,
    ...Array.from({ length: rounds }, (_, at) => goalRound(at + 1)).flat(),
  ];
}

describe('操作的人給的那條上限', () => {
  it('目標自己那條還很寬，人設的那條照樣夾得住', () => {
    const decision = decideGoalRound(
      logOf(afterCreate(3)).events,
      view({ maxGoalRounds: 99, roundsStarted: 3 }),
      CAP,
    );
    expect(decision).toEqual({
      kind: 'block',
      ref: { id: ID, revision: 1 },
      reason: {
        code: ROUND_CAP_BLOCK_CODE,
        message:
          '上一次建立或恢復目標之後已經續行了 3 輪，到了測試的上限給的上限；要繼續就恢復目標，會重新起算。',
      },
    });
  });

  it('還沒到就照排——邊界同樣是 >=，不是 >', () => {
    const decision = decideGoalRound(
      logOf(afterCreate(2)).events,
      view({ maxGoalRounds: 99, roundsStarted: 2 }),
      CAP,
    );
    expect(decision.kind === 'run' && decision.round.round).toBe(3);
  });

  /**
   * **恢復之後重新起算**：累計已經 3 輪、到了上限；人按恢復之後，同一個累計數照樣排，第 4 輪的號碼照舊往上數（模型讀到的
   * `Round: N/M` 是目標自己的累計，不動）。比累計的寫法在這裡會再記一次 `round-cap`，人怎麼按都續不了。
   */
  it('恢復之後重新起算：累計到了上限，恢復後照排', () => {
    const decision = decideGoalRound(
      logOf([...afterCreate(3), change('resume'), ...SETTLED]).events,
      view({ maxGoalRounds: 99, roundsStarted: 3 }),
      CAP,
    );
    expect(decision.kind === 'run' && decision.round.round).toBe(4);
  });

  it('恢復之後再跑滿上限，又夾住', () => {
    const decision = decideGoalRound(
      logOf([
        ...afterCreate(3),
        change('resume'),
        ...goalRound(4),
        ...goalRound(5),
        ...goalRound(6),
      ]).events,
      view({ maxGoalRounds: 99, roundsStarted: 6 }),
      CAP,
    );
    expect(decision.kind === 'block' && decision.reason.code).toBe(ROUND_CAP_BLOCK_CODE);
  });

  /** `update_goal` 記的是 `edit`：模型改自己的上限不是人授權，不能讓這個數歸零。 */
  it('edit 不重新起算', () => {
    const decision = decideGoalRound(
      logOf([...afterCreate(3), change('edit')]).events,
      view({ maxGoalRounds: 1000, roundsStarted: 3 }),
      CAP,
    );
    expect(decision.kind === 'block' && decision.reason.code).toBe(ROUND_CAP_BLOCK_CODE);
  });

  /**
   * 清掉再建：新目標從它自己的 `create` 起算。這一條分不出「只看同一個 id」——舊目標的輪都在新 `create` 之前，不看 id 也數不到；
   * 分得出來的是下面兩條。
   */
  it('清掉再建：新目標從自己的 create 起算，舊目標排過的輪不算', () => {
    const OTHER = goalId('goal-0');
    const decision = decideGoalRound(
      logOf([
        change('create', OTHER),
        ...goalRound(1, OTHER),
        ...goalRound(2, OTHER),
        ...goalRound(3, OTHER),
        change('create'),
        ...SETTLED,
      ]).events,
      view({ maxGoalRounds: 99, roundsStarted: 0 }),
      CAP,
    );
    expect(decision.kind === 'run' && decision.round.round).toBe(1);
  });

  /** 起算點只認同一個目標的授權：別的目標的 `resume` 夾在中間，不讓這個目標的數歸零（手搭的日誌，產品上一條 thread 一個目標）。 */
  it('別的目標的授權不重新起算這一個', () => {
    const OTHER = goalId('goal-0');
    const decision = decideGoalRound(
      logOf([...afterCreate(3), change('resume', OTHER), ...goalRound(1, OTHER)]).events,
      view({ maxGoalRounds: 99, roundsStarted: 3 }),
      CAP,
    );
    expect(decision.kind === 'block' && decision.reason.code).toBe(ROUND_CAP_BLOCK_CODE);
  });

  /** 授權之後只數同一個目標的輪：別的目標的續行輪不算進這一個的帳（手搭的日誌）。 */
  it('授權之後別的目標的輪不算', () => {
    const OTHER = goalId('goal-0');
    const decision = decideGoalRound(
      logOf([
        change('create'),
        ...SETTLED,
        ...goalRound(1, OTHER),
        ...goalRound(2, OTHER),
        ...goalRound(3, OTHER),
      ]).events,
      view({ maxGoalRounds: 99, roundsStarted: 0 }),
      CAP,
    );
    expect(decision.kind === 'run' && decision.round.round).toBe(1);
  });

  /** 找不到授權那一顆（只有手搭的日誌會這樣）就退回累計，寧可早停。 */
  it('日誌上沒有授權就比累計', () => {
    const decision = decideGoalRound(
      logOf(SETTLED).events,
      view({ maxGoalRounds: 99, roundsStarted: 3 }),
      CAP,
    );
    expect(decision.kind === 'block' && decision.reason.code).toBe(ROUND_CAP_BLOCK_CODE);
  });

  /**
   * **兩條同時到頂時，說出來的名字是目標自己那一條。** 那一刻人設的閘沒有夾到任何東西，
   * 算成 `round-cap` 會把功勞記錯——而「模型自己收斂到上限」與「人先夾住它」分不分得開，
   * 正是開著旗標跑真模型時要看的那件事。
   */
  it('兩條同時到頂，記的是 round-limit 不是 round-cap', () => {
    const decision = decideGoalRound(
      logOf(afterCreate(2)).events,
      view({ maxGoalRounds: 2, roundsStarted: 2 }),
      { limit: 2, source: '測試的上限' },
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
      pause: () => {},
      flush: () => Promise.resolve(),
      warn: () => {},
    };
  }

  it('人設的那條到頂，記 round-cap 而且不排', async () => {
    const port = portOf(view({ maxGoalRounds: 99, roundsStarted: 3 }));
    const round = await driveGoalRound(() => logOf(afterCreate(3)).events, port, CAP);
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
    const round = await driveGoalRound(() => logOf(afterCreate(3)).events, port);
    expect(round?.round).toBe(4);
    expect(port.blocked).toEqual([]);
  });
});

describe('排不出來的每一種，理由各自有名字', () => {
  /**
   * **一輪都還沒開始不是排不出的理由**（[#661](https://github.com/DemianLi/nexus-agent/issues/661)）：新開的行程第一件事就打
   * `/goal <目標>`，之後該排第 1 輪。擋住自行復活的是授權，不是「跑過沒有」。
   */
  it('一輪都還沒開始：已授權就排', () => {
    const decision = decideGoalRound([], view());
    expect(decision.kind === 'run' && decision.round.round).toBe(1);
  });

  it('一輪都還沒開始，但沒有授權：不排——續接回來的會話不會自己動起來', () => {
    expect(decideGoalRound([], view({ activation: 'disarmed' }))).toEqual({
      kind: 'idle',
      reason: 'disarmed',
    });
  });

  /**
   * **續接回來：上一個行程的輪不算這一個行程的**（[#251](https://github.com/DemianLi/nexus-agent/issues/251)）。
   * seed 裡那一輪是拋錯結束的；越過 `session/end-seed` 去看它的話，這裡會誤判成 `turn-failed` 而收回授權，
   * 把剛下的 `/goal resume` 吃掉。
   */
  it('續接回來還沒說過話：seed 裡那些輪不算，已授權就排', () => {
    const seeded = [
      HUMAN,
      ['turn/failed', { message: '上個行程掛了' }],
      ['session/end-seed', {}],
    ] as const;
    const decision = decideGoalRound(logOf(seeded).events, view());
    expect(decision.kind === 'run' && decision.round.round).toBe(1);
    expect(decideGoalRound(logOf(seeded).events, view({ activation: 'disarmed' }))).toEqual({
      kind: 'idle',
      reason: 'disarmed',
    });
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
  it('上一輪被人中止——`turn/end` 帶 aborted 也是收工，但不續行', () => {
    const aborted = logOf([
      HUMAN,
      ['turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } }],
    ]).events;
    expect(decideGoalRound(aborted, view())).toEqual({ kind: 'idle', reason: 'turn-aborted' });
    // 對照：同一個形狀不帶 reason 就照排——擋住的是 aborted，不是 `turn/end` 本身。
    expect(decideGoalRound(logOf([...SETTLED]).events, view()).kind).toBe('run');
  });

  it('上一輪撞到輸出上限——`turn/end` 帶 max-tokens，不續行（#433）', () => {
    const cut = logOf([HUMAN, ['turn/end', { reason: { kind: 'max-tokens' } }]]).events;
    expect(decideGoalRound(cut, view())).toEqual({ kind: 'idle', reason: 'turn-max-tokens' });
  });

  /**
   * **收尾在授權之前才算數**（#1516）：人下的暫停一定中止在跑的那一輪，所以「暫停 → 恢復」每次都是
   * 「最後一顆 `turn/end` 是 aborted，後面接一次 `resume`」。dsh 在 `turn/end` 抵達的當下收回，事後的 resume 不受影響；
   * 我們的決定讀日誌算，要靠先後。
   */
  describe('收尾之後又有人授權（create／resume）', () => {
    const ABORTED: readonly [string, unknown] = [
      'turn/end',
      { reason: { kind: 'aborted', cause: { kind: 'user' } } },
    ];
    const RESUME: readonly [string, unknown] = ['goal/change', { operation: 'resume' }];

    it('aborted 之後 resume：不再算 turn-aborted，照排', () => {
      const log = logOf([HUMAN, ['goal/change', { operation: 'pause' }], ABORTED, RESUME]).events;
      expect(decideGoalRound(log, view())?.kind).toBe('run');
    });

    it('拋錯與撞輸出上限之後 resume 同理', () => {
      for (const tail of [
        ['turn/failed', { message: '供應商掛了' }],
        ['turn/end', { reason: { kind: 'max-tokens' } }],
      ] as const) {
        const log = logOf([HUMAN, tail, RESUME]).events;
        expect(decideGoalRound(log, view())?.kind).toBe('run');
      }
    });

    it('create 也算授權', () => {
      const log = logOf([HUMAN, ABORTED, ['goal/change', { operation: 'create' }]]).events;
      expect(decideGoalRound(log, view())?.kind).toBe('run');
    });

    it('對照：授權在收尾之前（同一份授權跑的那一輪被中止），照舊 turn-aborted', () => {
      const log = logOf([RESUME, HUMAN, ABORTED]).events;
      expect(decideGoalRound(log, view())).toEqual({ kind: 'idle', reason: 'turn-aborted' });
    });

    it('對照：收尾之後的是別的變更（pause、edit、complete），不算授權', () => {
      for (const operation of ['pause', 'edit', 'block', 'complete']) {
        const log = logOf([HUMAN, ABORTED, ['goal/change', { operation }]]).events;
        expect(decideGoalRound(log, view())).toEqual({ kind: 'idle', reason: 'turn-aborted' });
      }
    });

    it('driveGoalRound：resume 之後不收回剛武裝的授權', async () => {
      const disarmed: number[] = [];
      const port: GoalDriverPort = {
        goal: () => view(),
        block: () => undefined,
        pause: () => undefined,
        disarm: () => void disarmed.push(1),
        flush: () => Promise.resolve(),
        warn: () => undefined,
      };
      const log = logOf([HUMAN, ABORTED, RESUME]);
      expect((await driveGoalRound(() => log.events, port))?.round).toBe(1);
      expect(disarmed).toHaveLength(0);
    });
  });

  it('停在核准點時按停止（收回）：resume 那一輪以 aborted 收尾，同樣不續行', () => {
    const withdrawn = logOf([
      HUMAN,
      RAISED,
      END,
      ['turn/start', { kind: 'resume' }],
      ['turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } }],
    ]).events;
    expect(decideGoalRound(withdrawn, view())).toEqual({ kind: 'idle', reason: 'turn-aborted' });
  });

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

/**
 * **撞到輸出上限、被人中止、拋錯：不只這一次不排，還收回授權**（#433、#660），同 dsh 的
 * `goal-round-driver` 看到 max-tokens 與 aborted 就 `disarm`、收到 `agent/error` 也是。對照組是同一份日誌、
 * 授權已經不在：不再收一次。
 */
describe('上一輪撞到輸出上限、被中止或拋錯', () => {
  const CUT = [HUMAN, ['turn/end', { reason: { kind: 'max-tokens' } }]] as const;

  function portOf(goal: GoalView): GoalDriverPort & { readonly disarmed: number[] } {
    const disarmed: number[] = [];
    return {
      disarmed,
      goal: () => goal,
      block: () => {},
      disarm: () => void disarmed.push(1),
      pause: () => {},
      flush: () => Promise.resolve(),
      warn: () => {},
    };
  }

  it('授權還在：收回，不排', async () => {
    const port = portOf(view());
    expect(await driveGoalRound(() => logOf(CUT).events, port)).toBeUndefined();
    expect(port.disarmed).toHaveLength(1);
  });

  it('授權已經不在：不再收一次', async () => {
    const port = portOf(view({ activation: 'disarmed' }));
    expect(await driveGoalRound(() => logOf(CUT).events, port)).toBeUndefined();
    expect(port.disarmed).toHaveLength(0);
  });

  it('被人中止的那一輪也收回——人再說一句話不會把續行接回來（#660）', async () => {
    const port = portOf(view());
    const aborted = [HUMAN, ['turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } }]];
    expect(await driveGoalRound(() => logOf(aborted as never).events, port)).toBeUndefined();
    expect(port.disarmed).toHaveLength(1);
  });

  it('拋錯的那一輪也收回', async () => {
    const port = portOf(view());
    const failed = [HUMAN, ['turn/failed', { message: '供應商掛了' }]];
    expect(await driveGoalRound(() => logOf(failed as never).events, port)).toBeUndefined();
    expect(port.disarmed).toHaveLength(1);
  });

  it('中止或拋錯時授權已經不在：不再收一次', async () => {
    for (const tail of [
      ['turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } }],
      ['turn/failed', { message: '供應商掛了' }],
    ]) {
      const port = portOf(view({ activation: 'disarmed' }));
      await driveGoalRound(() => logOf([HUMAN, tail] as never).events, port);
      expect(port.disarmed).toHaveLength(0);
    }
  });

  it('對照：人說完話、這一輪正常收工，照排而且不收回', async () => {
    const port = portOf(view());
    expect((await driveGoalRound(() => logOf(SETTLED).events, port))?.round).toBe(1);
    expect(port.disarmed).toHaveLength(0);
  });
});
