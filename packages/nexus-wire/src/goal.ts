/**
 * 會話目前的目標與階段上線的形狀（[#897](https://github.com/DemianLi/nexus-agent/issues/897)）。
 *
 * 照 dsh 的 `goal` 投影（`packages/goal/goal/src/types.ts:107-141`、`index.ts:162-169`，`c1b47e41fcd`）：值是
 * 「目前的目標連同已開始的續行輪數與時間」，**還沒建立或建立後被清掉是 `null`**。dsh 的 `GoalProjection` 是
 * `{ goal: GoalSnapshot, roundsStarted, createdAt, updatedAt }`，這裡攤平成一層（{@link WireGoal}），欄位一一對得上。
 *
 * 載體是協定的 `custom` 事件，`data.name` 是 {@link GOAL}，`payload` 是 {@link GoalPayload}——**投影的整個值**，
 * 後到的取代先到的：
 *
 * - **即時**：root 日誌的 `goal/change`（換整份快照或清掉）與 `turn/start{kind:'goal'}`（推進輪數）每改變一次值就
 *   送一顆。沒有變就不送。
 * - **歷史**：只在最新一頁送一顆**目前的**值，同標題與計劃模式；較舊的頁不帶。日誌上一顆 `goal/change` 都沒有就不送，
 *   清掉了送 `{ goal: null }`。
 *
 * ## `null` 的意思
 *
 * 折疊器的 `goal` 初值是 `null`，意思是**沒有目標**，不分「從沒建立過」與「建立後清掉了」，也不分「還沒收到」。目標列只在
 * 有目標時才畫，分不出這幾種也畫不出兩樣。dsh 另分 `undefined`（能力不在或還在載入）；組裝有沒有目標功能看 `slash.list`
 * 有沒有 `goal`。
 *
 * ## 不在這裡的：activation
 *
 * dsh 另有 `'armed' | 'disarmed'`，**行程內的狀態、不持久**，是否會自己續行看它，另走一條即時事件
 * （`GoalActivationChanged`）。這一顆**只有持久的那一半**：#638、#660、#661 正在改 activation 什麼時候變，等它們落地後
 * 另開一張。畫面先顯示階段與輪數，不顯示「會不會自己續行」。
 *
 * ## 少了什麼
 *
 * 沒有偏離 dsh 的欄位。折疊用的是 `@nexus/plugin-goal` 的 `applyGoalEvent`，跟耐久的重放同一份程式，**嚴格**：接不上的
 * 變更或不屬於目前目標的續行輪次會拋。投影遇到時**停在最後一個好的值**，不再往下送（寫壞的日誌不該讓畫面畫出編出來的
 * 目標）；日誌那一側的違規由 goal 的配套入口報。
 *
 * @module
 */

/** `custom` 事件的 `data.name`：這條會話的目標現在是這樣（或沒有）。 */
export const GOAL = 'goal';

/** 目標的耐久相位。 */
export const GOAL_PHASES = ['active', 'paused', 'blocked', 'complete'] as const;
export type WireGoalPhase = (typeof GOAL_PHASES)[number];

/** 目標被擋住的理由：`code` 是機器分類，`message` 給人看。 */
export interface WireGoalBlockedReason {
  readonly code: string;
  readonly message: string;
}

/** 目前的目標連同續行的輪數與時間。照 dsh 的 `GoalProjection`，攤平一層。 */
export interface WireGoal {
  /** 穩定的 goal 身分。 */
  readonly id: string;
  /** 正整數；每一次耐久變更 +1。 */
  readonly revision: number;
  /** 人要求完成的事。 */
  readonly objective: string;
  readonly phase: WireGoalPhase;
  /** 剛好在 `phase` 是 `blocked` 時有。 */
  readonly blockedReason?: WireGoalBlockedReason;
  /** 准許的 goal 輪次總上限。 */
  readonly maxGoalRounds: number;
  /** 已經開始的續行輪次。 */
  readonly roundsStarted: number;
  /** 建立那一次變更的 epoch 毫秒。 */
  readonly createdAt: number;
  /** 最近一次變更的 epoch 毫秒。 */
  readonly updatedAt: number;
}

/** {@link GOAL} 的 `payload`：投影的整個值。 */
export interface GoalPayload {
  /** 目前的目標；沒有（或清掉了）是 `null`。 */
  readonly goal: WireGoal | null;
}
