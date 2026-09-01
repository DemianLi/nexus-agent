/**
 * 一個會話的**長期目標**——耐久事件 `goal/change` 的詞彙。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-goal`
 * （`references/deepseek-harness/packages/goal/goal/src/types.ts` 與 `domain.ts`，對讀
 * 日期 2026-09-01，版本 `0a53fb55bea101816fa226bb964ae2bed71c343b`）。
 *
 * **為什麼詞彙在這裡而域在 plugin：同 `commands.ts` 那一條。** 命令的詞彙
 * （{@link ./commands.ts | CommandDefinition}）住在 `@nexus/core`，執行那一半住在
 * `@nexus/plugin-commands`；goal 一樣——{@link ./session-log.ts | SessionEventMap} 是
 * 一個**封閉**的映射，`goal/change` 的酬載型別要寫得出來就得住在這裡，而折疊、服務、
 * 錯誤與活的視圖住在 `@nexus/plugin-goal`。dsh 那邊靠宣告合併（`declare module
 * '@deepseek-ai/dsh-session/types'`）把事件種類從 goal 套件那側加進來，**我們沒有那個
 * 機制**，理由與代價見 `session-log.ts` 檔頭與
 * [#101](https://github.com/DemianLi/nexus-agent/issues/101)。
 *
 * **這裡只有耐久的那一半。** `GoalView` 帶的 `activation`（armed／disarmed）刻意不持久，
 * 它是 process 內的東西，所以它跟服務一起住在 plugin 那側——寫進這個檔案就等於暗示
 * 它會進日誌。
 *
 * @see [#126](https://github.com/DemianLi/nexus-agent/issues/126)
 * @module
 */

/** `goal/change` 酬載的版本。**認不得的版本讓重放失敗**，不是被跳過。 */
export const GOAL_CHANGE_VERSION = 1;

declare const goalIdBrand: unique symbol;

/**
 * 一個 goal 跨修訂號的身分。
 *
 * **是 branded string，不是裸 string。** dsh 用共用的 `@deepseek-ai/dsh-brand`
 * （`Branded<'GoalId'>`），我們沒有那個工具，所以就地做一個最小的——買到的是同一件事：
 * 會話 id、修訂號字串、使用者打的目標文字都塞不進這一格。要造一顆只有
 * {@link goalId} 一條路。
 */
export type GoalId = string & { readonly [goalIdBrand]: 'GoalId' };

/**
 * 把一串字掛上 goal id 的標記。
 *
 * **不驗內容**：這一層只負責標記，「非空字串」那條規則歸嚴格解碼器
 * （`@nexus/plugin-goal` 的 `decodeGoalChange`）——驗在兩個地方就會有兩份規則。
 *
 * @param raw - 原始識別字串。
 * @returns 同一串字，帶著編譯期的標記。
 */
export function goalId(raw: string): GoalId {
  return raw as GoalId;
}

/** 指名**剛好那一個修訂號**的 CAS 身分。 */
export interface GoalRef {
  /** 穩定的 goal 身分。 */
  readonly id: GoalId;
  /** 正整數；每一次耐久變更 +1。 */
  readonly revision: number;
}

/** 耐久的續行相位。**activation 是另一件事**，而且不持久。 */
export type GoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

/** 一個 goal 被擋住的理由，機器路由得到也給人看得懂。 */
export interface GoalBlockReason {
  /** 擋它的那條政策自己選的 lower-kebab-case 分類。 */
  readonly code: string;
  /** 給人與模型看的非空說明。 */
  readonly message: string;
}

/** 每一次非 clear 的變更寫下的**整份**耐久狀態。 */
export interface GoalSnapshot extends GoalRef {
  /** 人要求完成的事。 */
  readonly objective: string;
  /** 耐久的生命週期相位。 */
  readonly phase: GoalPhase;
  /**
   * **剛好在 `phase` 是 `blocked` 時存在**。
   *
   * 沒有的時候要**整個不放這個 key**，不能放 `undefined`——`snapshotJsonValue` 對
   * `undefined` 是當場拋的，同 `command/done` 的 `text` 那條既有規矩。
   */
  readonly blockedReason?: GoalBlockReason;
  /** 准許的 goal 輪次總上限。 */
  readonly maxGoalRounds: number;
}

/** 耐久變更記下的動詞。 */
export type GoalOperation = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear';

/** 帶整份快照的變更。 */
export interface GoalSnapshotChangeMeta {
  readonly kind: 'goal/change';
  readonly version: typeof GOAL_CHANGE_VERSION;
  readonly operation: Exclude<GoalOperation, 'clear'>;
  readonly goal: GoalSnapshot;
  /**
   * 這個 goal 已經開始的續行輪次。
   *
   * **這一版恆為 0，因為沒有生產者**——推進它的是 goal 來源的使用者輪次，而我們的
   * `turn/start` 沒有 `source` 判別欄，兩個產生點都是人打的。決議與翻面的條件見
   * [#126](https://github.com/DemianLi/nexus-agent/issues/126) 的決定 3。
   */
  readonly roundsStarted: number;
  /** 建立那一次變更的 epoch 毫秒。 */
  readonly createdAt: number;
  /** 最近一次變更的 epoch 毫秒。 */
  readonly updatedAt: number;
}

/** 目前的 goal 被清掉時留下的墓碑。**歷史不刪**，清的是「目前是哪一個」。 */
export interface GoalClearChangeMeta {
  readonly kind: 'goal/change';
  readonly version: typeof GOAL_CHANGE_VERSION;
  readonly operation: 'clear';
  /** 修訂號是被清掉那一份的下一號。 */
  readonly cleared: GoalRef;
  readonly clearedAt: number;
}

/** `goal/change` 收下的兩種東西。 */
export type GoalChangeMeta = GoalSnapshotChangeMeta | GoalClearChangeMeta;
