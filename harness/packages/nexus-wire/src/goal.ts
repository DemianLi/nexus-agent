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
 * （`GoalActivationChanged`）。這一顆**只有持久的那一半**；續行授權走 {@link GOAL_ACTIVATION}（#1575 N0376），**不塞進
 * {@link WireGoal}、不進歷史頁**。
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

/**
 * `custom` 事件的 `data.name`：這條會話的目標**會不會自己續行**（[#1575](https://github.com/DemianLi/nexus-agent/issues/1575) N0376）。
 *
 * 照 dsh 的 `GoalActivationChanged`（`packages/goal/goal/src/types.ts:72-87`，經 `remote-events.ts:39` 轉給 UI）：**行程內的狀態、
 * 不持久、不是日誌事件**，所以不落盤、不進歷史頁（{@link prependEntries} 不動它）、也不塞進 {@link WireGoal}。只在續行授權
 * 真的變了（`armed` ↔ `disarmed`，值沒變不送）時送一顆；新接上的下行補送「現在」的值（dsh 的 UI 是開線先讀 `goals.get` 再訂）。
 *
 * ## `goalActivation` 怎麼讀（折疊器的格子，`null` 的意思）
 *
 * - `'armed'`：這個行程授權過，目標 active 時會自己排下一輪。
 * - `'disarmed'`：**不會自己跑**。重啟之後、按停止、一輪出錯或撞到輸出上限之後、目標被暫停／完成／清掉，都是這個。
 * - `null`：**還沒收到**。只有「這條 thread 沒有目標」或「frame 還在路上」會讓它停在 `null`；有目標的 thread，server 在下行開線時
 *   一定補送一顆，所以 `goal !== null` 而 `goalActivation === null` 只是一個瞬間，不要把它畫成「會自己跑」，也不要畫成「不會」——
 *   先什麼都不說。
 * - 只在 `goal !== null` 時才有意義：沒有目標時 frame 缺 `goal`，格子收成 `'disarmed'`。
 */
export const GOAL_ACTIVATION = 'goal/activation';

/** 續行授權：這個行程准不准自己排下一輪。 */
export type WireGoalActivation = 'armed' | 'disarmed';

/** {@link GOAL_ACTIVATION} 的 `payload`。沒有目前目標時 `goal` 缺席。 */
export interface GoalActivationPayload {
  readonly goal?: {
    /** 目前目標的身分。 */
    readonly id: string;
    /** 目前目標的修訂。 */
    readonly revision: number;
    readonly activation: WireGoalActivation;
  };
}

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

/**
 * 暫停目標的專用 method（`goal.pause`，[#1516](https://github.com/DemianLi/nexus-agent/issues/1516)）。
 *
 * **人按暫停鈕走這一支，不是 `slash.run` 的 `/goal pause`**（兩條入口都在，效果一樣）：斜線命令是文字，要解析、要過 `slashInFlight`，
 * 而 web 的按鈕有確切的目標 ref 可以帶。照 dsh 的 `goals.pause(ref)`（`packages/goal/goal/src/service.ts`，ref 是 `{ id, revision }`）：
 * 帶**看到的修訂**，修訂對不上就是過期，**回錯、不假裝成功**——兩個分頁同時改一個目標是正常情況，後到的那個不該靜靜蓋掉前一個的結果。
 *
 * **任何時候都收**：一輪跑著（續行輪或人打的那一輪）、停在核准點、閒著——不經過斜線命令那道「還在跑就擋」，理由同回饋那幾支
 * （{@link FEEDBACK_METHODS}）。**跑著時按下去，server 當場中止這一輪**（續行預約隨那一輪收成中止整件拿掉、排在後面的人類輸入保留但停住），
 * 停下來的事實走下行（root 那顆收尾的 `lifecycle` 帶 `aborted: true`）。回應是受理後目標的新樣子，不等停穩。
 *
 * 回應同回饋：`{ ok: true, value }`／`{ ok: false, error: { code } }`，業務失敗走成功回應，`ErrorResponse` 只給「這條線收不了」
 * （含沒有 goal 域的組裝回的 `not_supported`；**不依賴續行排程器**，`--no-goal-driver` 照樣收）。
 */
export const GOAL_PAUSE_METHOD = 'goal.pause';

/** 這個檔定義的 method。 */
export const GOAL_METHODS = [GOAL_PAUSE_METHOD] as const;

export type GoalMethod = (typeof GOAL_METHODS)[number];

export function isGoalMethod(value: unknown): value is GoalMethod {
  return typeof value === 'string' && (GOAL_METHODS as readonly string[]).includes(value);
}

/** 目標的 ref：身分加修訂（compare-and-set 的條件）。 */
export interface WireGoalRef {
  readonly id: string;
  readonly revision: number;
}

export interface GoalPauseCommand {
  readonly id: number;
  readonly method: typeof GOAL_PAUSE_METHOD;
  /** 要暫停的那份目標：身分與**看到的修訂**。 */
  readonly params: { readonly goalId: string; readonly revision: number };
}

/** 回應裡交代目標現在的樣子（只有身分、修訂、相位——完整的值走 {@link GOAL} 下行）。 */
export interface GoalPauseState extends WireGoalRef {
  readonly phase: WireGoalPhase;
}

export type GoalPauseResult =
  | { readonly ok: true; readonly value: { readonly goal: GoalPauseState } }
  | {
      readonly ok: false;
      readonly error:
        /** 這條 thread 沒有目前的目標（沒建過或清掉了）。 */
        | { readonly code: 'goal-not-found' }
        /** 帶來的 ref 過期（身分不同或修訂變了）；`current` 是現在的樣子，讓呼叫端不必再讀一次。 */
        | { readonly code: 'goal-stale'; readonly current: GoalPauseState }
        /** 目標不是 active（已經暫停、被擋住或完成了），沒有東西可暫停。 */
        | { readonly code: 'goal-not-active'; readonly phase: WireGoalPhase };
    };

// 名字→酬載表（#685）上屬於這個檔的格子，見 `custom-frame.ts`。
declare module './custom-frame.js' {
  interface CustomFramePayloads {
    [GOAL]: GoalPayload;
    [GOAL_ACTIVATION]: GoalActivationPayload;
  }
}
