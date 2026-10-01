/**
 * root 會話目前的目標，折成線上的 `custom` 事件 `data`（[#897](https://github.com/DemianLi/nexus-agent/issues/897)）。
 * 形狀與規則見 `@nexus/wire` 的 `goal.ts`。
 *
 * 即時（pump 逐顆餵）與歷史（一頁一次餵整段）共用這一個類別，所以兩條路對同一份日誌算出同一個值。折疊用的是
 * `@nexus/plugin-goal` 的 `applyGoalEvent`，跟耐久的重放同一份程式：`goal/change` 換整份快照或清掉，
 * `turn/start{kind:'goal'}` 推進續行輪數。**嚴格**：接不上的變更或不屬於目前目標的輪次會拋，這裡接住、記下原因，
 * 之後**停在最後一個好的值**，不再往下送——寫壞的日誌不該讓畫面畫出編出來的目標。
 *
 * @module
 */

import type { SessionEvent } from '@nexus/core';
import { applyGoalEvent, emptyGoalFoldState } from '@nexus/plugin-goal';
import type { GoalFoldState } from '@nexus/plugin-goal';
import type { GoalPayload, WireGoal } from '@nexus/wire';
import { GOAL } from '@nexus/wire';

/**
 * 目標在線上的 `custom` 事件 `data`。即時與歷史共用。
 *
 * @param goal - 目前的目標，沒有（或清掉了）是 `null`。
 * @returns `{ name, payload }`，形狀見 `@nexus/wire` 的 `GoalPayload`。
 */
export function goalData(goal: WireGoal | null): {
  readonly name: typeof GOAL;
  readonly payload: GoalPayload;
} {
  return { name: GOAL, payload: { goal } };
}

/** 折疊狀態 → 線上的值。沒有目標是 `null`；`blockedReason` 沒有時整個不放 key。 */
function wireGoalOf(state: GoalFoldState): WireGoal | null {
  const goal = state.goal;
  if (goal === undefined) return null;
  return {
    id: goal.id,
    revision: goal.revision,
    objective: goal.objective,
    phase: goal.phase,
    ...(goal.blockedReason === undefined
      ? {}
      : { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } }),
    maxGoalRounds: goal.maxGoalRounds,
    roundsStarted: state.roundsStarted,
    // 有目標就一定有這兩個（`applyGoalChange` 同進同出）。
    createdAt: state.createdAt ?? 0,
    updatedAt: state.updatedAt ?? 0,
  };
}

export class RootGoal {
  #state = emptyGoalFoldState();
  /** 最近一次交出去的值，序列化過好比較。一開始是「沒有目標」：折出來還是沒有就不送。 */
  #sent = JSON.stringify(null);
  #failure: string | undefined;
  #failureTaken = false;
  #touched = false;

  /**
   * 套一顆，回傳這一顆讓值變了就是新的 `data`，沒變是 `undefined`，並記成「已經交出去」。
   *
   * @param event - root 日誌的下一顆。
   */
  apply(event: SessionEvent): ReturnType<typeof goalData> | undefined {
    this.seed([event]);
    return this.flush();
  }

  /**
   * 只折不交。之後叫一次 {@link flush} 就是「到這裡為止」的值：歷史頁拿它送；pump 帶著上一個行程留下的 seed 起來時
   * 拿它丟掉——那一段的值由歷史的最後一頁送，即時只送之後的變化。
   *
   * @param events - 要折進來的那一段。
   */
  seed(events: Iterable<SessionEvent>): void {
    for (const event of events) {
      if (this.#failure !== undefined) return;
      if (event.type === 'goal/change') this.#touched = true;
      try {
        applyGoalEvent(this.#state, event);
      } catch (error) {
        this.#failure = error instanceof Error ? error.message : String(error);
        return;
      }
    }
  }

  /** 跟上一次交出去的不一樣就交出去，並記下來。折壞了之後不再送。 */
  flush(): ReturnType<typeof goalData> | undefined {
    if (this.#failure !== undefined) return undefined;
    const value = wireGoalOf(this.#state);
    const serialized = JSON.stringify(value);
    if (serialized === this.#sent) return undefined;
    this.#sent = serialized;
    return goalData(value);
  }

  /** 目前的值（折壞了就是最後一個好的）。 */
  get value(): WireGoal | null {
    return wireGoalOf(this.#state);
  }

  /** 折過的事件裡有沒有 `goal/change`。歷史頁靠它分「從沒有過」與「清掉了」。 */
  get touched(): boolean {
    return this.#touched;
  }

  /** 折壞了嗎。 */
  get broken(): boolean {
    return this.#failure !== undefined;
  }

  /** 折壞的原因，**只交出一次**——給 pump 講一行 warn，不是每顆事件講一次。 */
  takeFailure(): string | undefined {
    if (this.#failure === undefined || this.#failureTaken) return undefined;
    this.#failureTaken = true;
    return this.#failure;
  }
}
