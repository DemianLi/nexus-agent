/**
 * 嚴格解碼與純折疊。
 *
 * **這份測試的主軸是「壞掉的東西讓重放失敗，不是被跳過」**——每一條都斷言它拋，而不是
 * 斷言結果沒變。兩者在一個安靜跳過的實作上都會綠，只有前者分得出來。
 */

import { describe, expect, it } from 'vitest';

import { goalId, SessionLog } from '@nexus/core';
import type {
  SessionEventMap,
  SessionEventType,
  GoalChangeMeta,
  GoalSnapshot,
  GoalSnapshotChangeMeta,
  SessionEvent,
} from '@nexus/core';

import {
  applyGoalChange,
  decodeGoalChange,
  emptyGoalFoldState,
  foldGoal,
  goalChangeRef,
} from './fold.js';

const ID = goalId('goal-1');

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    id: ID,
    revision: 1,
    objective: '把它做完',
    phase: 'active',
    maxGoalRounds: 8,
    ...overrides,
  };
}

function created(overrides: Partial<GoalSnapshot> = {}): GoalSnapshotChangeMeta {
  return {
    kind: 'goal/change',
    version: 1,
    operation: 'create',
    goal: snapshot(overrides),
    roundsStarted: 0,
    createdAt: 10,
    updatedAt: 10,
  };
}

/** 接在 create 之後的一次快照變更。 */
function next(
  operation: 'edit' | 'pause' | 'resume' | 'complete' | 'block',
  goal: GoalSnapshot,
  updatedAt = 11,
): GoalSnapshotChangeMeta {
  return {
    kind: 'goal/change',
    version: 1,
    operation,
    goal,
    roundsStarted: 0,
    createdAt: 10,
    updatedAt,
  };
}

/** 折一串已經解過的變更，回最後的狀態。 */
function fold(...changes: GoalChangeMeta[]): ReturnType<typeof emptyGoalFoldState> {
  const state = emptyGoalFoldState();
  for (const change of changes) applyGoalChange(state, change);
  return state;
}

/** 把一批酬載記進真的日誌，拿它的事件——順便讓 `snapshotJsonValue` 也驗一次。 */
function eventsOf(...payloads: GoalChangeMeta[]): readonly SessionEvent[] {
  const log = new SessionLog('fold');
  for (const payload of payloads) log.append('goal/change', payload);
  return log.events;
}

describe('解碼', () => {
  it('不是 goal 變更的回 undefined，不拋', () => {
    expect(decodeGoalChange({ kind: 'plan/mode' })).toBeUndefined();
    expect(decodeGoalChange(null)).toBeUndefined();
    expect(decodeGoalChange([1, 2])).toBeUndefined();
  });

  it('自稱是 goal 變更但版本不認得——拋', () => {
    expect(() => decodeGoalChange({ kind: 'goal/change', version: 2 })).toThrow(
      /不支援的 goal 變更版本/u,
    );
  });

  it('operation 不認得——拋', () => {
    expect(() => decodeGoalChange({ ...created(), operation: 'archive' })).toThrow(
      /不是認得的動詞/u,
    );
  });

  it('多一格少一格都是不同的東西——拋', () => {
    expect(() => decodeGoalChange({ ...created(), extra: 1 })).toThrow(/欄位必須剛好是/u);
    const { roundsStarted: _dropped, ...missing } = created() as unknown as Record<string, unknown>;
    expect(() => decodeGoalChange(missing)).toThrow(/欄位必須剛好是/u);
  });

  it('blocked 一定要帶理由，沒 blocked 一定不能帶', () => {
    expect(() => decodeGoalChange(created({ phase: 'blocked' }))).toThrow(/相位 blocked 的 goal/u);
    expect(() =>
      decodeGoalChange({
        ...created(),
        goal: { ...snapshot(), blockedReason: { code: 'x', message: 'y' } },
      }),
    ).toThrow(/相位 active 的 goal/u);
  });

  it('理由的 code 要 lower-kebab-case，message 要非空且已正規化', () => {
    const blocked = (blockedReason: unknown): unknown => ({
      ...created(),
      goal: { ...snapshot({ phase: 'blocked' }), blockedReason },
    });
    expect(() => decodeGoalChange(blocked({ code: 'Needs-Info', message: '缺資訊' }))).toThrow(
      /lower-kebab-case/u,
    );
    expect(() => decodeGoalChange(blocked({ code: 'needs-info', message: ' 缺資訊 ' }))).toThrow(
      /必須非空且已正規化/u,
    );
    expect(() => decodeGoalChange(blocked({ code: 'needs-info' }))).toThrow(/欄位必須剛好是/u);
  });

  it('objective 要非空且已正規化，數字欄位要是安全整數', () => {
    expect(() => decodeGoalChange(created({ objective: '  ' }))).toThrow(/必須非空且已正規化/u);
    expect(() => decodeGoalChange(created({ objective: '前面有空白 ' }))).toThrow(
      /必須非空且已正規化/u,
    );
    expect(() => decodeGoalChange(created({ revision: 0 }))).toThrow(/必須是正的安全整數/u);
    expect(() => decodeGoalChange(created({ maxGoalRounds: 1.5 }))).toThrow(/必須是正的安全整數/u);
    expect(() => decodeGoalChange({ ...created(), roundsStarted: -1 })).toThrow(
      /必須是非負的安全整數/u,
    );
  });

  it('updatedAt 不能早於 createdAt', () => {
    expect(() => decodeGoalChange({ ...created(), createdAt: 10, updatedAt: 9 })).toThrow(
      /不能早於 createdAt/u,
    );
  });

  it('墓碑的欄位也是剛好那幾格', () => {
    const tombstone = {
      kind: 'goal/change',
      version: 1,
      operation: 'clear',
      cleared: { id: 'goal-1', revision: 2 },
      clearedAt: 12,
    };
    expect(decodeGoalChange(tombstone)).toEqual(tombstone);
    expect(() => decodeGoalChange({ ...tombstone, extra: 1 })).toThrow(/欄位必須剛好是/u);
    expect(() => decodeGoalChange({ ...tombstone, cleared: { id: 'goal-1' } })).toThrow(
      /欄位必須剛好是/u,
    );
  });
});

describe('create', () => {
  it('折出目前的目標與最近一次身分', () => {
    const state = fold(created());
    expect(state.goal).toEqual(snapshot());
    expect(state.createdAt).toBe(10);
    expect(state.lastRef).toEqual({ id: ID, revision: 1 });
  });

  it('修訂號不是 1、相位不是 active、輪次不是 0，三種都拒', () => {
    expect(() => fold(created({ revision: 2 }))).toThrow(/goal create 需要/u);
    expect(() => fold(created({ phase: 'paused' }))).toThrow(/goal create 需要/u);
    expect(() => fold({ ...created(), roundsStarted: 1 })).toThrow(/goal create 需要/u);
  });

  it('上一個還沒完成就不准建下一個', () => {
    expect(() => fold(created(), created({ id: goalId('goal-2') }))).toThrow(/goal create 需要/u);
  });

  it('完成掉的可以被取代，但 id 用過就不能再用', () => {
    const completed = next('complete', snapshot({ revision: 2, phase: 'complete' }));
    expect(() => fold(created(), completed, created({ id: goalId('goal-2') }))).not.toThrow();
    expect(() => fold(created(), completed, created())).toThrow(/goal create 需要/u);
  });
});

describe('相位轉換', () => {
  const active = created();

  it('pause 只從 active', () => {
    expect(() =>
      fold(active, next('pause', snapshot({ revision: 2, phase: 'paused' }))),
    ).not.toThrow();
    expect(() =>
      fold(
        active,
        next('pause', snapshot({ revision: 2, phase: 'paused' })),
        next('pause', snapshot({ revision: 3, phase: 'paused' }), 12),
      ),
    ).toThrow(/goal pause 的相位轉換不合法/u);
  });

  it('resume 從 active／paused／blocked，complete 之後不行', () => {
    const paused = next('pause', snapshot({ revision: 2, phase: 'paused' }));
    expect(() => fold(active, paused, next('resume', snapshot({ revision: 3 }), 12))).not.toThrow();
    const completed = next('complete', snapshot({ revision: 2, phase: 'complete' }));
    expect(() => fold(active, completed, next('resume', snapshot({ revision: 3 }), 12))).toThrow(
      /goal resume 的相位轉換不合法/u,
    );
  });

  it('resume 的輪次預算——**手寫一份帶輪次的狀態就驗得到**', () => {
    // 這一條走的是「不經過 goal 輪次事件、直接把計數設進去」那條路，所以它釘的是折疊
    // 自己的規則。服務那側的同一條在 `index.test.ts`（燒完預算之後 resume 不了）。
    const state = fold(active, next('pause', snapshot({ revision: 2, phase: 'paused' })));
    state.roundsStarted = 8;
    expect(() =>
      applyGoalChange(state, {
        kind: 'goal/change',
        version: 1,
        operation: 'resume',
        goal: snapshot({ revision: 3 }),
        roundsStarted: 8,
        createdAt: 10,
        updatedAt: 12,
      }),
    ).toThrow(/輪次預算已經用完/u);
  });

  it('block 只從 active，complete 不能重複', () => {
    const blocked = next('block', {
      ...snapshot({ revision: 2, phase: 'blocked' }),
      blockedReason: { code: 'needs-info', message: '缺資訊' },
    });
    expect(() => fold(active, blocked)).not.toThrow();
    expect(() =>
      fold(
        active,
        blocked,
        next(
          'block',
          {
            ...snapshot({ revision: 3, phase: 'blocked' }),
            blockedReason: { code: 'needs-info', message: '缺資訊' },
          },
          12,
        ),
      ),
    ).toThrow(/goal block 的相位轉換不合法/u);
    const completed = next('complete', snapshot({ revision: 2, phase: 'complete' }));
    expect(() =>
      fold(active, completed, next('complete', snapshot({ revision: 3, phase: 'complete' }), 12)),
    ).toThrow(/goal complete 的相位轉換不合法/u);
  });

  it('edit 不得改相位或理由，非 edit 不得改定義', () => {
    expect(() => fold(active, next('edit', snapshot({ revision: 2, phase: 'paused' })))).toThrow(
      /goal edit 不得改動相位/u,
    );
    expect(() =>
      fold(active, next('pause', snapshot({ revision: 2, phase: 'paused', objective: '換一個' }))),
    ).toThrow(/不得改動 objective 或 maxGoalRounds/u);
    expect(() =>
      fold(active, next('edit', snapshot({ revision: 2, objective: '換一個' }))),
    ).not.toThrow();
  });

  it('每次剛好推進一個修訂號，而且要是同一個 goal', () => {
    expect(() => fold(active, next('pause', snapshot({ revision: 3, phase: 'paused' })))).toThrow(
      /推進剛好一個修訂號/u,
    );
    expect(() =>
      fold(active, next('pause', snapshot({ id: goalId('goal-2'), revision: 2, phase: 'paused' }))),
    ).toThrow(/推進剛好一個修訂號/u);
  });

  it('時間戳與計數要保住，updatedAt 不得倒退', () => {
    expect(() =>
      fold(active, { ...next('pause', snapshot({ revision: 2, phase: 'paused' })), createdAt: 9 }),
    ).toThrow(/沒有保住目前的計數與時間戳/u);
    expect(() =>
      fold(active, next('pause', snapshot({ revision: 2, phase: 'paused' }), 9)),
    ).toThrow(/沒有保住目前的計數與時間戳/u);
    expect(() =>
      fold(active, {
        ...next('pause', snapshot({ revision: 2, phase: 'paused' })),
        roundsStarted: 1,
      }),
    ).toThrow(/沒有保住目前的計數與時間戳/u);
  });

  it('沒有目前目標時，非 create 的操作全拒', () => {
    expect(() => fold(next('pause', snapshot({ revision: 2, phase: 'paused' })))).toThrow(
      /goal pause 需要一個目前的 goal/u,
    );
  });
});

describe('clear', () => {
  const active = created();
  const tombstone: GoalChangeMeta = {
    kind: 'goal/change',
    version: 1,
    operation: 'clear',
    cleared: { id: ID, revision: 2 },
    clearedAt: 12,
  };

  it('清掉之後沒有目前目標，但墓碑留著', () => {
    const state = fold(active, tombstone);
    expect(state.goal).toBeUndefined();
    expect(state.createdAt).toBeUndefined();
    expect(state.roundsStarted).toBe(0);
    expect(state.lastRef).toEqual({ id: ID, revision: 2 });
    expect(goalChangeRef(tombstone)).toEqual({ id: ID, revision: 2 });
  });

  it('要有目前目標、修訂號要 +1、時間不得倒退', () => {
    expect(() => fold(tombstone)).toThrow(/goal clear 需要一個目前的 goal/u);
    expect(() => fold(active, { ...tombstone, cleared: { id: ID, revision: 3 } })).toThrow(
      /推進剛好一個修訂號/u,
    );
    expect(() => fold(active, { ...tombstone, clearedAt: 9 })).toThrow(/不能早於/u);
  });

  it('清掉之後 id 還是用過的——不准回收', () => {
    expect(() => fold(active, tombstone, created())).toThrow(/goal create 需要/u);
  });
});

describe('從會話日誌重放', () => {
  it('不是 goal/change 的事件原樣略過', () => {
    const log = new SessionLog('mixed');
    log.append('turn/start', { kind: 'resume' });
    log.append('goal/change', created());
    log.append('turn/end', {});
    expect(foldGoal(log.events).goal).toEqual(snapshot());
  });

  it('壞掉的那一筆讓重放失敗，不是被跳過', () => {
    // 跳過的話，下面這串會折出一個「還在 active」的目標，而日誌裡明明記著它被暫停過。
    const events = eventsOf(created(), {
      ...next('pause', snapshot({ revision: 5, phase: 'paused' })),
    });
    expect(() => foldGoal(events)).toThrow(/推進剛好一個修訂號/u);
  });

  it('自稱是 goal/change 卻連 kind 都不對——連這種也拋', () => {
    const log = new SessionLog('bad');
    // 只有轉型騙得過型別；真流量上這是另一個生產者寫壞了才會發生的事。
    log.append('goal/change', { kind: 'goal/oops' } as unknown as GoalChangeMeta);
    expect(() => foldGoal(log.events)).toThrow(/沒有自稱是 goal 變更/u);
  });

  it('空日誌折出來就是「沒有目標」', () => {
    expect(foldGoal([])).toEqual({ roundsStarted: 0 });
  });
});

describe('goal 來源的輪次', () => {
  /** 一份真的日誌：create 之後接一串 `turn/start`。 */
  function logWith(
    ...starts: readonly SessionEventMap['turn/start'][]
  ): ReturnType<typeof foldGoal> {
    const log = new SessionLog('rounds');
    log.append('goal/change', created());
    for (const start of starts) log.append('turn/start', start);
    return foldGoal(log.events);
  }

  /** 對得上的第 `round` 輪。 */
  function round(round: number, overrides: Record<string, unknown> = {}) {
    return {
      kind: 'goal',
      text: `<goal_round>第 ${round} 輪`,
      goalId: ID,
      revision: 1,
      round,
      ...overrides,
    } as SessionEventMap['turn/start'];
  }

  it('一顆準入的輪次把計數推到它自己的 round', () => {
    expect(logWith(round(1)).roundsStarted).toBe(1);
    expect(logWith(round(1), round(2), round(3)).roundsStarted).toBe(3);
  });

  it('人打的與核准恢復都不推它', () => {
    const folded = logWith({ kind: 'message', text: '動手' }, { kind: 'resume' }, round(1), {
      kind: 'message',
      text: '再來',
    });
    expect(folded.roundsStarted).toBe(1);
  });

  /**
   * 四格逐個試。**每一格都是拋不是跳過**——見 `fold.ts` 檔頭：靜靜跳過一顆對不上的輪次，
   * 換來的是一個看起來正常、實際上少算了一輪的預算。
   */
  it('四格任何一格不符就拋', () => {
    const bad = /不是目前 active 目標的下一個準入輪次/u;
    expect(() => logWith(round(1, { goalId: goalId('goal-2') }))).toThrow(bad);
    expect(() => logWith(round(1, { revision: 2 }))).toThrow(bad);
    // 跳號：第 1 輪還沒排就排第 2 輪。
    expect(() => logWith(round(2))).toThrow(bad);
    // 重播同一輪：`round === roundsStarted + 1` 同時擋住跳號與重複。
    expect(() => logWith(round(1), round(1))).toThrow(bad);
  });

  it('超過 maxGoalRounds 的那一輪拋——**上限是折疊的規則不只是排程器的禮貌**', () => {
    const log = new SessionLog('cap');
    log.append('goal/change', created({ maxGoalRounds: 2 }));
    log.append('turn/start', round(1));
    log.append('turn/start', round(2));
    log.append('turn/start', round(3));
    expect(() => foldGoal(log.events)).toThrow(/不是目前 active 目標的下一個準入輪次/u);
  });

  it('目標不是 active 的時候一輪都排不進來', () => {
    const log = new SessionLog('paused');
    log.append('goal/change', created());
    log.append('goal/change', next('pause', snapshot({ revision: 2, phase: 'paused' })));
    log.append('turn/start', round(1, { revision: 2 }));
    expect(() => foldGoal(log.events)).toThrow(/不是目前 active 目標的下一個準入輪次/u);
  });

  it('沒有目標的時候也一樣', () => {
    const log = new SessionLog('none');
    log.append('turn/start', round(1));
    expect(() => foldGoal(log.events)).toThrow(/不是目前 active 目標的下一個準入輪次/u);
  });
});

describe('什麼推得動 roundsStarted', () => {
  it('十種事件裡只有一種推得動——**加事件種類的人會被這一條擋下來**', () => {
    // 下面那條走一次生命週期的斷言**自己不會紅**：它餵的只有 `goal/change`，而推輪次的
    // 是別種事件。真正的絆索是這一條，而它釘的是**詞彙**不是值——`SessionEventType` 多
    // 一種，下面的 `satisfies` 就在 `typecheck` 當場紅，逼寫的人回到這個檔案回答一句話：
    // 「這一種推得動輪次嗎？」
    //
    // **十種裡面只有 `turn/start` 的答案是「推」，而且只有它的 `kind: 'goal'` 那一支**
    // （[#180](https://github.com/DemianLi/nexus-agent/issues/180)）：那一支是排程器排的
    // 續行輪次，`kind` 為 `message`／`resume` 的兩支照樣不推——它們是人打的，不花目標的
    // 輪次預算。其餘九種：四種是進入點寫的人類活動，`goal/change` 是狀態本身，剩下的見下。
    //
    // **`todo/write` 是這條絆索第一次真的擋下人**（[#132](https://github.com/DemianLi/nexus-agent/issues/132)）。
    // 它的答案也是不推，而理由不是「它不重要」：goal 的輪次預算數的是**目標驅動的
    // 使用者輪次**，而 todo 是模型在**同一輪之內**改自己的規劃草稿——一輪裡寫五次
    // 清單仍然是一輪。把它算進去的話，`maxGoalRounds` 會變成「模型改了幾次計畫」的
    // 上限，那不是任何人設定它時想限制的東西。
    //
    // **`model/usage` 是第二次**（[#153](https://github.com/DemianLi/nexus-agent/issues/153)）。
    // 答案同樣是不推，理由跟 `todo/write` 同型但更遠：它一輪有幾格模型呼叫就有幾筆，
    // 而「叫了幾次模型」正是 `recursionLimit` 在管的東西，不是 `maxGoalRounds`。兩個
    // 預算數的是兩件事，讓其中一個去數另一個那件事，兩個都會失準。
    //
    // **`compaction/summary` 是第三次**（[#143](https://github.com/DemianLi/nexus-agent/issues/143)）。
    // 不推，而這一次的理由最乾脆：它記的是**上下文被壓過一次**，跟目標推進到哪裡完全無關。
    // 真要說有關係也是反向的——一場長任務壓縮得越多，代表它走得越久，讓它去推一個
    // 「還能再問幾輪」的預算等於因為對話變長而扣使用者的額度。
    const KNOWN = [
      'turn/start',
      'turn/end',
      'turn/failed',
      'interrupt/raised',
      'command/run',
      'command/done',
      'goal/change',
      'todo/write',
      'model/usage',
      'compaction/summary',
    ] as const;
    KNOWN satisfies readonly SessionEventType[];
    // 反過來這一條才是絆索：多一種而沒有列進來，`Exhaustive` 就變成 `never`。
    type Exhaustive = SessionEventType extends (typeof KNOWN)[number] ? true : never;
    const exhaustive: Exhaustive = true;
    expect(exhaustive).toBe(true);
    expect(foldGoal([]).roundsStarted).toBe(0);
  });

  it('一整串 goal/change 推不動它——**沒有輪次事件就沒有輪次**', () => {
    // **這一條是絆索，不是覆蓋率。** 它釘的是「狀態變更不等於一輪」：pause／resume／
    // complete 走完一整圈，輪次照樣是 0。少了它，一個把 `roundsStarted` 綁到變更次數上
    // 的實作會全綠——而那會讓 `maxGoalRounds` 變成「這個目標被改過幾次」的上限。
    const state = fold(
      created(),
      next('pause', snapshot({ revision: 2, phase: 'paused' })),
      next('resume', snapshot({ revision: 3 }), 12),
      next('complete', snapshot({ revision: 4, phase: 'complete' }), 13),
    );
    expect(state.goal?.phase).toBe('complete');
    expect(state.roundsStarted).toBe(0);
  });
});
