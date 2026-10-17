/**
 * `@nexus/goal`：長期目標這個**服務**的定義套件（決議 §3-4 第 16 條；
 * [#1486](https://github.com/DemianLi/nexus-agent/issues/1486)，Part of #1385）。形狀照 `@nexus/feedback`、`@nexus/projections`。
 *
 * ## 角色
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件：`goals` 的 token 與結構介面、折疊（`applyGoalEvent`…）、續行輪次的提示文字、目標視圖的型別 | `@nexus/sdk`，與 `@nexus/core` 的詞彙（見下） |
 * | 提供者 | `@nexus/plugin-goal`，樹上一列函式插件：`new` 一個繼承 `ContractService` 的類別，`provide` 成 `goals` | 這個套件、`@nexus/sdk`、`@nexus/session`、`@nexus/tools`、`@nexus/commands` |
 * | 消費者 | 宿主（`apps/harness`）：組 thread 時把服務折進 `registry.services`，續行排程器、逐出判斷與 pump 讀它 | 這個套件；**不 import 提供者套件**（決議 §3-4 第 16 條） |
 *
 * dsh 的對應：`dsh-goal` 自己定義 `ctx.goals`（`packages/goal/goal/src/index.ts:240-251`），別的套件（`tool-goal`、`goal-round-driver`）
 * 值與型別 import 的是這個網域套件，不是工具或命令的套件。
 *
 * ## 偏離登記
 *
 * - **持久狀態不走投影**（#1486 Q1 (a)；類別：遷移卡不改行為（暫時））：dsh 的持久狀態是 session 投影（`stateOf(session, 'goal')`，
 *   `goal/src/index.ts:476-481`，`stateVersion: 6`），行程內的續行授權放在以 Session 為鍵的 `WeakMap`（`:248`，lazy 取用在 `:484-493`）。
 *   nexus 的折疊持在 `GoalService` 的私有欄位上，由第一次被問到某份日誌時 `log.events` 重播、`log.subscribe` 接後續。**行程內那一半跟 dsh 同形**
 *   （以日誌為鍵的 `WeakMap`、第一次被問才建）。**撤除條件**：`@nexus/projections` 長出插件讀狀態的 `stateOf(log, key)`，且
 *   `#pending`（跨同步 append 邊界的授權）在投影的時序下量過同樣成立（今天沒有人量過）；屆時另開卡。
 * - **相依 `@nexus/core`**（照 `@nexus/projections` 的 #1421 Q2 (a)）：目標的詞彙（`GoalSnapshot`、`GoalChangeMeta`、`goalId`、
 *   `GOAL_CHANGE_VERSION`…）與 `goal/change` 的事件擴充留在 `@nexus/core`（`session-log.ts`，同 `todo/write`、`feedback/*`），web 的 wire 與
 *   會話日誌的解碼都讀它，由這個套件單向轉出。**`@nexus/core` 放 `peerDependencies`，`devDependencies` 留 `workspace:*`**。撤除條件併入
 *   #1421 Q2 (b)。
 * - **折疊與續行提示文字搬進來**（#1486 Q4 (a)）：宿主的 pump 與排程器值 import 它們，插件自己的配套入口也要比對同一段文字，
 *   放在定義套件才不會讓配套入口反向依賴 app（#1486 Q4 (c) 的反例）。`hasDirectHumanTurn` 留在插件：宿主只有測試在用，
 *   不放進定義套件（`packages/AGENTS.md`「Require a current owner and need」）。
 *
 * ## `serviceFor` 只收 root 日誌，沒有 `attached()`
 *
 * 狀態住在以日誌為鍵的 `WeakMap` 裡，**第一次被問到某份 root 日誌時才建**（lazy）：WeakMap 列舉不了，所以 `attached()` 沒有了；服務折進每條
 * thread 之後，各條 thread 也不該看見彼此的服務（#459 那一類串台）。`SessionLog` 不帶位址，服務分不出手上的是不是 root，所以**契約寫在這裡**：
 * 呼叫端只交 root 日誌——工具看 `sessionLookup.forCall` 回的 `address.kind`、命令的 `sessionLog` 是命令執行器交的 root、宿主兩個入口交的也是 root。
 * 交了子代理的日誌，服務照建，狀態與 root 的不相干。
 *
 * ## 方法一律不碰 `this.ctx`
 *
 * 宿主拿到的是組 thread 時取的那個值（Cordis 的 traceable proxy），列卸載之後開著的 thread 仍要能呼叫它。服務的方法是**自己的屬性**，
 * 不用 `#私有欄位`（proxy 的 shadow receiver 讀私有欄位會拋）；`serviceFor` 回的 `GoalService` 是閉包裡的原物件，不帶 tracker，原樣交出。
 *
 * @module
 */

import type { GoalBlockReason, GoalRef, GoalSnapshot, SessionLog } from '@nexus/core';
import { defineToken } from '@nexus/sdk';

export {
  GOAL_CHANGE_VERSION,
  goalId,
} from '@nexus/core';
export type {
  GoalBlockReason,
  GoalChangeMeta,
  GoalClearChangeMeta,
  GoalId,
  GoalOperation,
  GoalPhase,
  GoalRef,
  GoalSnapshot,
  GoalSnapshotChangeMeta,
} from '@nexus/core';

export type { FoldedGoal, GoalFoldState } from './fold.js';
export {
  applyGoalChange,
  applyGoalEvent,
  decodeGoalChange,
  emptyGoalFoldState,
  foldGoal,
  goalChangeRef,
} from './fold.js';
export { renderGoalRoundPrompt } from './prompt.js';

/** 契約版本（semver）。介面破壞性改動跳 major，宿主的範圍檢查擋下不相容的提供者。 */
export const GOALS_CONTRACT_VERSION = '1.0.0';

/** `goals` 服務的名字。`registry.services` 上這個字串就是 goal 域的位址。 */
export const GOALS_SERVICE = 'goals';

/**
 * `maxGoalRounds` 沒指定時的預設，**照抄 dsh 的 256**。
 *
 * **它進耐久快照，所以是建立當下的那個值**，不是讀取當下的預設：改了這個常數不會追溯到既有的目標身上。消費它的是續行排程器
 * （`apps/harness` 的 `goal-driver.ts`）——用完就記一顆 `round-limit` 的 blocker，而那是開著 `--goal-driver` 時**唯一的硬上限**。
 */
export const DEFAULT_MAX_GOAL_ROUNDS = 256;

/**
 * 這個 process 准不准自動續行這個目標。**永遠不持久**。
 *
 * 它不進日誌是 dsh 刻意的：續行授權是「這個活著的行程被誰授權過」，重放一段歷史不該讓一個沒有人在的行程自己動起來。
 */
export type GoalActivation = 'armed' | 'disarmed';

/** 目前的目標加上重放算出來的東西。 */
export interface GoalView extends GoalSnapshot {
  /** 已經開始的續行輪次。只有被準入的 `turn/start{kind:'goal'}` 推得動它，見 `fold.ts`。 */
  readonly roundsStarted: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** process 內的續行授權，不持久。 */
  readonly activation: GoalActivation;
}

/**
 * 一份 root 日誌上的 goal 域，**宿主（續行排程器、逐出判斷）要用的那幾格**。
 *
 * 只放今天有宿主消費者的方法：讀目前的視圖、記一顆 blocker、暫停、收回續行授權。插件自己的工具與命令用的是插件裡的具體類別
 * （`create`／`edit`／`resume`／`complete`…），不經過這個介面。
 */
export interface GoalService {
  /**
   * 目前的目標。
   * @returns 一份新的視圖，或沒有目前目標時的 `undefined`。
   * @throws 這份日誌的 goal 串已經重放失敗：折疊壞掉之後每一次讀與每一次變更都拋裸 `Error`。
   */
  get(): GoalView | undefined;
  /** 記一顆 blocker（排程器在輪次用完時用）。帶預期的修訂號，過期會拋。 */
  block(ref: GoalRef, reason: GoalBlockReason): GoalView;
  /** 暫停一個 active 的目標並收回授權。帶預期的修訂號，過期會拋。 */
  pause(ref: GoalRef): GoalView;
  /** 收回 process 內的續行授權，**不動耐久的相位與修訂號**。 */
  disarm(): GoalView | undefined;
}

/**
 * `goals` 服務：**每一份 root 日誌**各自的 goal 域。
 *
 * 契約（#1486 Q1、Q3）：兩個方法都**只收 root 日誌**；沒有列舉用的 `attached()`（見檔頭）。
 */
export interface GoalServices {
  /**
   * 這一份 root 日誌上的域，**沒有就建**（lazy）：第一次被問到時讀 `log.events` 重播、`log.subscribe` 接後續，兩步在同一個同步區塊裡
   * （`SessionLog.append` 先凍住監聽清單、再 push、再同步發布，`session-log.ts:1702-1707`，所以不漏、不重）。同一份日誌永遠回同一個實例。
   *
   * @param log - root 日誌。
   * @returns 那一份的服務。
   */
  serviceFor(log: SessionLog): GoalService;
  /**
   * 這一份 root 日誌上**已經建好的**域；沒被問過就是 `undefined`，**不建、不重播**。
   *
   * 給「問了不該改變任何東西」的讀者：閒置逐出的判斷（#1486 對 #1484）每輪掃描都對每條 thread 問一次，對一條從沒碰過 goal 的 thread
   * 呼叫 `serviceFor` 會觸發整份日誌的重播。**「還沒被問過」與「沒有武裝的目標」在那個判斷上等價**：續行授權只活在行程內
   * （`fold.ts` 的 `activation` 不落盤），只有服務自己的方法（`create`／`resume`…）才能把它掛成 `armed`，而那些方法只有拿到服務才呼叫得到；
   * 沒有服務就沒有人掛過授權。
   *
   * @param log - root 日誌。
   * @returns 已經建好的服務，或 `undefined`。
   */
  existingFor(log: SessionLog): GoalService | undefined;
}

/** `goals` 服務的 token。 */
export const goalsToken = defineToken<GoalServices>(GOALS_SERVICE, GOALS_CONTRACT_VERSION);

declare module '@nexus/core' {
  interface NexusServices {
    /** 目標服務。由 `@nexus/plugin-goal` 提供，宿主與測試用 `services.use(GOALS_SERVICE)` 讀。 */
    goals: GoalServices;
  }
}
