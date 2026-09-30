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
import type {
  GoalId,
  SessionEvent,
  SessionEventMap,
  SessionReferenceSourceEntry,
} from '@nexus/core';

import { completionAuthority, hasDirectHumanTurn, isMatchingGoalRound } from './authority.js';
import type { GoalView } from './service.js';

/**
 * **釘住 `turn/start` 的酬載聯集剛好是那四個成員。**
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
      // 父代理傳給背景子代理的訊息（#839）。**不帶人類授權**，見下面 fail-closed 那條。
      readonly kind: 'agent-message';
      readonly text: string;
      readonly senderSessionId: string;
    }
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

  it('父代理傳來的訊息（agent-message）那一輪背後沒有人：追到它就停住回假（fail closed）', () => {
    const agentMessage: readonly [keyof SessionEventMap, unknown] = [
      'turn/start',
      {
        kind: 'agent-message',
        text: 'Agent root-1 sent a message: 動手',
        senderSessionId: 'root-1',
      },
    ];
    expect(hasDirectHumanTurn(logOf([agentMessage]).events)).toBe(false);
    // 更早的人話不替它背書：停住，不往上穿。
    expect(hasDirectHumanTurn(logOf([HUMAN, END, agentMessage]).events)).toBe(false);
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

describe('當前的續行輪次', () => {
  /** 一份長得像視圖的東西；只有四格進得了判準。 */
  function view(overrides: Partial<GoalView> = {}): GoalView {
    return {
      id: goalId('g-1'),
      revision: 1,
      objective: '把它做完',
      phase: 'active',
      maxGoalRounds: 8,
      roundsStarted: 1,
      createdAt: 10,
      updatedAt: 10,
      activation: 'armed',
      ...overrides,
    };
  }

  const ROUND_1: readonly [keyof SessionEventMap, unknown] = [
    'turn/start',
    { kind: 'goal', text: '<goal_round>…', goalId: goalId('g-1'), revision: 1, round: 1 },
  ];

  /**
   * **比對的是 `roundsStarted` 本身，不是 `roundsStarted + 1`。**
   *
   * 這一輪的 `turn/start` 早在工具跑起來之前就 append 過了，所以折疊已經把計數推到它。
   * 寫成 `+1` 的話每一次都拒絕，而那在畫面上看起來像權限壞了不像差一格——這是這個檔裡
   * 最容易寫錯而且最難看出來的一格。
   */
  it('對得上的是第 roundsStarted 輪，不是下一輪', () => {
    const events = logOf([ROUND_1]).events;
    expect(isMatchingGoalRound(events, view({ roundsStarted: 1 }))).toBe(true);
    expect(isMatchingGoalRound(events, view({ roundsStarted: 2 }))).toBe(false);
    expect(isMatchingGoalRound(events, view({ roundsStarted: 0 }))).toBe(false);
  });

  it('身分對不上就不算', () => {
    const events = logOf([ROUND_1]).events;
    expect(isMatchingGoalRound(events, view({ id: goalId('g-2') }))).toBe(false);
    expect(isMatchingGoalRound(events, view({ revision: 2 }))).toBe(false);
  });

  it('人打的那一輪不是任何目標的續行輪次', () => {
    expect(isMatchingGoalRound(logOf([HUMAN]).events, view())).toBe(false);
    expect(isMatchingGoalRound([], view())).toBe(false);
  });

  /**
   * **這一條釘的是兩個判準走的不是同一條走法。**
   *
   * `hasDirectHumanTurn` 往回追鏈，`isMatchingGoalRound` 只讀當前這一段的頭。兩個住在
   * 同一個檔裡，實作時最容易發生的事就是共用錯的那一個 helper——而拿追鏈那一個去做後
   * 者的話，**一顆更早的 goal round 會讓一個人類輪次拿到 `goal-round` 授權**。
   */
  it('人接著打字之後，追鏈為真而當前輪次為假', () => {
    const events = logOf([ROUND_1, END, HUMAN]).events;
    expect(hasDirectHumanTurn(events)).toBe(true);
    expect(isMatchingGoalRound(events, view({ roundsStarted: 1 }))).toBe(false);
  });

  /** 反過來的那一半：在續行輪次裡，追鏈為假而當前輪次為真。 */
  it('在續行輪次裡，追鏈為假而當前輪次為真', () => {
    const events = logOf([HUMAN, END, ROUND_1]).events;
    expect(hasDirectHumanTurn(events)).toBe(false);
    expect(isMatchingGoalRound(events, view({ roundsStarted: 1 }))).toBe(true);
  });
});

describe('completionAuthority', () => {
  function view(): GoalView {
    return {
      id: goalId('g-1'),
      revision: 1,
      objective: '把它做完',
      phase: 'active',
      maxGoalRounds: 8,
      roundsStarted: 1,
      createdAt: 10,
      updatedAt: 10,
      activation: 'armed',
    };
  }

  const ROUND_1: readonly [keyof SessionEventMap, unknown] = [
    'turn/start',
    { kind: 'goal', text: '<goal_round>…', goalId: goalId('g-1'), revision: 1, round: 1 },
  ];

  it('人在的時候是 direct-human，而且不必有目標', () => {
    expect(completionAuthority(logOf([HUMAN]).events, undefined)).toEqual({ kind: 'direct-human' });
  });

  it('續行輪次裡是 goal-round，而且帶得出那份視圖', () => {
    const granted = completionAuthority(logOf([HUMAN, END, ROUND_1]).events, view());
    expect(granted?.kind).toBe('goal-round');
    expect(granted?.kind === 'goal-round' && granted.goal.roundsStarted).toBe(1);
  });

  it('兩條都不成立時是 undefined', () => {
    expect(completionAuthority(logOf([RESUME]).events, view())).toBeUndefined();
    expect(completionAuthority(logOf([HUMAN, END, ROUND_1]).events, undefined)).toBeUndefined();
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

/**
 * **釘住 `user/message` 的來源聯集剛好是那三個成員**（#710、#713）。理由同上面那一條：user 來源是授權的另一條路（插話），
 * 放寬它就是多開一條，而 `hasDirectHumanTurn` 只認 `kind: 'user'`——加一個成員不會讓任何一條現有測試變紅。
 *
 * 第三個成員是引用別的會話時凍下來的快照（[#713](https://github.com/DemianLi/nexus-agent/issues/713)）：**內容來自另一條
 * 會話，不是這條會話的人打的**，所以不是人類授權。下面「快照不是人」那條測試釘的是行為，這裡釘的是形狀。
 */
type UserMessageSourcePinned =
  | { readonly kind: 'plugin'; readonly plugin: string }
  | { readonly kind: 'user' }
  | {
      readonly kind: 'session-reference';
      readonly form: 'recall';
      readonly version: 1;
      readonly references: readonly SessionReferenceSourceEntry[];
    };
type UserMessageSourceActual = SessionEventMap['user/message']['source'];
const _sourceWidened: UserMessageSourcePinned = undefined as unknown as UserMessageSourceActual;
const _sourceNarrowed: UserMessageSourceActual = undefined as unknown as UserMessageSourcePinned;
void _sourceWidened;
void _sourceNarrowed;

describe('輪中插話算直接人類授權（#710）', () => {
  const GOAL_ROUND: readonly [keyof SessionEventMap, unknown] = [
    'turn/start',
    { kind: 'goal', text: '<goal_round>…', goalId: goalId('g-1'), revision: 1, round: 1 },
  ];
  const message = { type: 'human', data: { content: '改用 X', additional_kwargs: {} } };
  const STEER: readonly [keyof SessionEventMap, unknown] = [
    'user/message',
    { message, source: { kind: 'user' } },
  ];
  const INJECTED: readonly [keyof SessionEventMap, unknown] = [
    'user/message',
    { message, source: { kind: 'plugin', plugin: 'repeat-reminder' } },
  ];

  it('續行輪次裡人插了話：拿得到', () => {
    expect(hasDirectHumanTurn(logOf([GOAL_ROUND, STEER]).events)).toBe(true);
  });

  it('沒有插話的續行輪次照舊拿不到', () => {
    expect(hasDirectHumanTurn(logOf([GOAL_ROUND]).events)).toBe(false);
  });

  it('外掛塞的 user/message 不是人，拿不到（#152 的底線）', () => {
    expect(hasDirectHumanTurn(logOf([GOAL_ROUND, INJECTED]).events)).toBe(false);
  });

  it('引用別的會話的快照不是人，拿不到（#713）：內容是另一條會話的，不是這條會話的人打的', () => {
    const SNAPSHOT: readonly [keyof SessionEventMap, unknown] = [
      'user/message',
      {
        message,
        source: { kind: 'session-reference', form: 'recall', version: 1, references: [] },
      },
    ];
    expect(hasDirectHumanTurn(logOf([GOAL_ROUND, SNAPSHOT]).events)).toBe(false);
    // 反過來：人插的話在前、快照在後，人的那一句仍然算數。
    expect(hasDirectHumanTurn(logOf([GOAL_ROUND, STEER, SNAPSHOT]).events)).toBe(true);
  });

  it('插話之後停在核准點、恢復：同一條鏈，恢復那一段照樣拿得到', () => {
    const events = logOf([
      GOAL_ROUND,
      STEER,
      ['interrupt/raised', { interruptId: 'i-1' }],
      END,
      RESUME,
    ]).events;
    expect(hasDirectHumanTurn(events)).toBe(true);
  });

  it('更早那一條鏈裡插過的話不算：界線同追根', () => {
    const events = logOf([HUMAN, STEER, END, GOAL_ROUND]).events;
    expect(hasDirectHumanTurn(events)).toBe(false);
  });
});
