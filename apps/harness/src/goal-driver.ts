/**
 * 續行排程器的**決策那一半**：一輪收工之後，要不要再排一輪。
 *
 * 形狀照 dsh 的 `packages/goal/goal-round-driver/`（對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04），
 * [#180](https://github.com/DemianLi/nexus-agent/issues/180)。
 *
 * ## 為什麼它落在 `apps/harness` 而不是一個 plugin——一筆登記過的載體偏離
 *
 * dsh 的 driver 是一個 Cordis plugin，靠 `agent/pre-step` 與 `ctx.agents` 的 idle 判斷把
 * 一輪排進 agent 的 inbox。我們的 `PluginRegistry` 十五條通道（`registry.ts:559-572`）
 * **沒有一條排得出一輪**——輪迴圈歸入口點所有（`thread-pump.ts` 的 `#runOnce`、
 * `cli.ts` 的 `runTurn`）。所以載體丟掉、紀律照抄，同 `containment.ts` 對
 * `guard/timeout-policy` 那一筆。
 *
 * **但檢查沒有跟著搬**：續行文字的 renderer 與驗它的不變量伴生都留在
 * `@nexus/plugin-goal`，判準是「只要 `kind: 'goal'` 這個詞彙存在，伴生就武裝」——與有
 * 沒有掛排程器無關。只在掛了排程器時才擋的檢查，對一顆手寫或寫壞的輪次是零防守。
 *
 * ## 這個模組是純的，`flush()` 不在裡面
 *
 * 決定與執行分開：這裡回一個**意圖**（排一輪／記一顆 blocker／閒著），呼叫端執行。
 * 耐久檢查點是呼叫端的事，而且順序是**決定 → flush → 再決定一次 → 送**——第二次決定
 * 抓的是「flush 期間有人插話進來」，它最容易被省略而且省略了不會有任何徵兆。
 *
 * ## 就緒不是「`turn/end` 到了」
 *
 * `thread-pump.ts` 自己寫著「跑完**與停在核准點**都算收工」，而 dsh 明文「完成、暂停和
 * 阻塞会阻止续行」。三格都要問，見 {@link decideGoalRound}。
 *
 * ## 刻意沒有做的那一條：CLI 的額外停損
 *
 * [#180](https://github.com/DemianLi/nexus-agent/issues/180) 第五節要求「旗標開著時 CLI
 * 要另有一條停損：連續 N 輪沒有任何工具成功就停」。**這一條經評估後刻意不做**，不是漏了：
 *
 * - 「連續 N 輪沒有工具成功」在會話日誌上**量不到**（十種事件沒有工具事件），只能在
 *   `runTurn` 裡數 stream 上的 `ToolMessage`。而 `HEADLESS_APPROVALS` 是**拒絕**不是
 *   靜默——被拒的工具照樣回一則 `ToolMessage`，所以那個計數抓不到它要抓的那件事。
 * - 「連續 N 輪沒有 `goal/change`」更糟：一個正常工作的模型可以幾十輪不碰 goal 工具，
 *   那是這條路的**正常樣子**，不是停滯。這個判準會在長任務中途把目標 block 掉。
 * - **一條會誤殺健康長任務的停損，比沒有停損更糟。**
 *
 * 代替它的是兩件已經在的東西 ＋ 一行披露：`blockedAfterConsecutiveRounds`（預設 3）讓
 * 模型從第 3 輪起**可以**把自己 block 出去——那是准許不是保證，沒有東西逼它用；而
 * `maxGoalRounds` 是唯一的硬上限。所以 CLI 開旗標時要把上限印出來，見 `cli.ts`。
 *
 * @module
 */

import { currentTurnStart, hasUnansweredInterrupt } from '@nexus/core';
import type { GoalBlockReason, GoalId, GoalRef, SessionEvent } from '@nexus/core';
import { renderGoalRoundPrompt } from '@nexus/plugin-goal';
import type { GoalView } from '@nexus/plugin-goal';

/** 上限耗盡時記的那顆 blocker 的穩定代碼。逐字照 dsh。 */
export const ROUND_LIMIT_BLOCK_CODE = 'round-limit';

/** 排得出一輪時，要交給入口點的東西。 */
export interface GoalRoundRequest {
  /** 送進模型的那一串字。**入口點拿同一個值同時寫日誌與構訊息**，見 `thread-pump.ts`。 */
  readonly text: string;
  readonly goalId: GoalId;
  readonly revision: number;
  readonly round: number;
}

/**
 * 為什麼這一刻排不出一輪。**每一種各有一個名字**，因為它們的成因不同——尤其
 * `turn-failed` 與 `turn-open`：合成一句「最後一顆不是 `turn/end`」的話，一次「拋錯之後
 * 照樣續行」的重構會通過每一條測試。
 */
export type GoalDriverIdleReason =
  /** 這份日誌上一輪都還沒開始——人還沒說話。 */
  | 'no-turn'
  /** 上一輪還在跑（沒有結尾）。 */
  | 'turn-open'
  /** 上一輪**拋錯**結束。續行不重試，見 [#180](https://github.com/DemianLi/nexus-agent/issues/180) 的 Out of scope。 */
  | 'turn-failed'
  /** 停在核准點，中斷還掛著。 */
  | 'interrupt-pending'
  /** 沒有目前的目標。 */
  | 'no-goal'
  /** 有目標但相位不是 active（完成、暫停、被擋住都算）。 */
  | 'not-active'
  /** 相位是 active 但這個 process 沒有續行授權。 */
  | 'disarmed';

/** 這一刻該做什麼。 */
export type GoalDriverDecision =
  | { readonly kind: 'run'; readonly round: GoalRoundRequest }
  | { readonly kind: 'block'; readonly ref: GoalRef; readonly reason: GoalBlockReason }
  | { readonly kind: 'idle'; readonly reason: GoalDriverIdleReason };

/** 當前這一段物理輪次收工了沒——**拋錯結束與還在跑是兩件事**。 */
function turnClosed(events: readonly SessionEvent[]): GoalDriverIdleReason | undefined {
  const start = currentTurnStart(events);
  if (start < 0) return 'no-turn';
  for (let at = start + 1; at < events.length; at += 1) {
    const type = events[at]?.type;
    if (type === 'turn/end') return undefined;
    if (type === 'turn/failed') return 'turn-failed';
  }
  return 'turn-open';
}

/**
 * 現在該不該再排一輪。**純函式**：讀日誌與一份視圖，不動任何東西。
 *
 * @param events - 這一份會話日誌到目前為止的全部事件。
 * @param goal - 目前那份視圖；沒有目前目標時給 `undefined`。
 * @returns 排一輪、記一顆 blocker，或閒著（帶得出理由）。
 */
export function decideGoalRound(
  events: readonly SessionEvent[],
  goal: GoalView | undefined,
): GoalDriverDecision {
  const notClosed = turnClosed(events);
  if (notClosed !== undefined) return { kind: 'idle', reason: notClosed };
  // **停在核准點也算 `turn/end`**，所以這一句非問不可——少了它，排程器會在一顆等著人按
  // 批准的中斷上面再排一輪，而那一輪會把中斷靜靜吃掉（`thread-pump.ts` 檔頭第 5 點）。
  if (hasUnansweredInterrupt(events)) return { kind: 'idle', reason: 'interrupt-pending' };
  if (goal === undefined) return { kind: 'idle', reason: 'no-goal' };
  if (goal.phase !== 'active') return { kind: 'idle', reason: 'not-active' };
  // **掛載、resume、fork 之後絕不自行復活**：授權從 `disarmed` 開始，要一次有人授權的
  // `create` 或 `resume` 才 armed（`service.ts` 的「永遠不持久」）。
  if (goal.activation !== 'armed') return { kind: 'idle', reason: 'disarmed' };
  if (goal.roundsStarted >= goal.maxGoalRounds) {
    return {
      kind: 'block',
      ref: { id: goal.id, revision: goal.revision },
      reason: {
        code: ROUND_LIMIT_BLOCK_CODE,
        message: `目標用完了設定的 ${goal.maxGoalRounds} 個續行輪次。`,
      },
    };
  }
  const round = goal.roundsStarted + 1;
  return {
    kind: 'run',
    round: {
      // **一次 render，一個值。** 入口點拿它同時寫 `turn/start.text` 與構模型訊息，所以
      // 「日誌上寫的」與「模型讀到的」在結構上是同一串字，不是兩份要互相對齊的東西。
      text: renderGoalRoundPrompt(goal, round),
      goalId: goal.id,
      revision: goal.revision,
      round,
    },
  };
}
