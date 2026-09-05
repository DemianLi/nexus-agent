/**
 * 執行時的權限判準：**這一顆變更呼叫背後有沒有一個人**。
 *
 * 形狀照 dsh 的 `packages/goal/tool-goal/src/authority.ts`（對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04）。**兩種授權都在**：直接人類，
 * 與**當前 Goal Round**（[#180](https://github.com/DemianLi/nexus-agent/issues/180) 補上
 * 了生產者）。哪一種夠用是按操作分的，見 {@link completionAuthority}。
 *
 * ## 判準是「往回追」，不是「看最後一顆」
 *
 * 寫成「最後一顆 `turn/start` 是不是 `kind: 'message'`」會**拒絕掉一個人剛剛動了兩次手
 * 的情形**。停在核准點也算 `turn/end`（`session-log.ts` 明文），而恢復時 append 的是
 * **一顆新的** `turn/start`、`kind` 為 `resume`：
 *
 * ```
 * turn/start{message} → interrupt/raised → turn/end
 * turn/start{resume}  → …模型在這一段呼叫 create_goal
 * ```
 *
 * 所以要追的是**鏈**：往回走，遇到 `resume` 繼續往回，遇到 `message` 就是找到根。
 *
 * ## 認不得的 `kind` 一律**當場停住**，不是跳過
 *
 * 這是這個檔最重要的一行。今天 `turn/start` 的酬載只有 `{kind:'message'}` 與
 * `{kind:'resume'}` 兩個成員，所以「有 message 輪次 ⇒ 有人類授權」成立**完全是因為
 * 沒有第三個生產者**。dsh 的 `goal-round-driver` 排入的正是第三種：一則 goal 來源的
 * user 輪次，長得跟人打的一模一樣。
 *
 * 所以遇到不認得的 `kind` 時**不往回穿**：一個未知的生產者既不該自己拿到人類授權，也
 * 不該讓我們越過它去撿一則更早的人類輪次。fail-closed。
 *
 * **這條在 [#180](https://github.com/DemianLi/nexus-agent/issues/180) 從絆索變成了驗收
 * 句**：`kind: 'goal'` 是真的第三個成員了，而它直接落到那個 `return false`——
 * **這個函式一行都沒有改**。今天它擋的是下一個生產者。
 *
 * ## 兩個判準走的不是同一條走法
 *
 * {@link hasDirectHumanTurn} 往回**追鏈**（`resume` 一路穿過去找根），
 * {@link isMatchingGoalRound} **只讀當前這一段物理輪次的頭**（遇到第一顆 `turn/start`
 * 就停，不穿）。dsh 兩邊都掃「開放輪次」，因為它有 `turnBoundary` 投影告訴它這一輪從
 * 哪顆事件開始；**我們沒有那個投影**，所以兩個判準各自從日誌推導，而它們要的東西不同：
 * 一個問「這條鏈的根是不是人」，另一個問「我現在人在哪一輪裡」。
 *
 * 拿追鏈那一個去做後者的話，**一顆更早的 goal round 會讓一個人類輪次拿到 `goal-round`
 * 授權**。`authority.test.ts` 有一條測試專門釘住這個分歧。
 *
 * @module
 */

import { currentTurnStart } from '@nexus/core';
import type { SessionEvent, SessionEventMap } from '@nexus/core';

import type { GoalView } from './service.js';

/** `turn/start` 的酬載。**單獨取出來是為了讓下面那個 `default` 分支有話可說**。 */
type TurnStart = SessionEventMap['turn/start'];

/**
 * 這條物理輪次鏈往回追到的是不是一則人類訊息。
 *
 * @param events - 一份會話日誌到目前為止的全部事件，照 `seq` 排。
 * @returns 追到 `kind: 'message'` 為真；追到頭、或撞上認不得的 `kind` 為假。
 */
export function hasDirectHumanTurn(events: readonly SessionEvent[]): boolean {
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at];
    if (event === undefined || event.type !== 'turn/start') continue;
    const data = event.data as TurnStart;
    if (data.kind === 'message') return true;
    if (data.kind === 'resume') continue;
    // 認不得的第三種：停住，見檔頭。
    return false;
  }
  return false;
}

/**
 * 現在這一輪**正是**這個目標這個修訂號的當前準入輪次。
 *
 * **比對的是 `roundsStarted` 本身，不是 `roundsStarted + 1`**：這一輪的
 * `turn/start` 早在工具跑起來之前就 append 過了，折疊已經把計數推到它。寫成 `+1` 的話
 * 每一次都拒絕，而那看起來像權限壞了不像差一格。
 *
 * **只讀當前物理輪次的頭**——往回遇到的第一顆 `turn/start` 就是答案，不往上穿。理由見
 * 檔頭那一節。
 *
 * @param events - 一份會話日誌到目前為止的全部事件，照 `seq` 排。
 * @param goal - 目前那份視圖，帶著它折疊出來的 `roundsStarted`。
 * @returns 當前輪次就是這個目標的第 `roundsStarted` 輪時為真。
 */
export function isMatchingGoalRound(events: readonly SessionEvent[], goal: GoalView): boolean {
  // **走法借自 `@nexus/core`，不是在這裡重寫一遍。** 同一個走法今天有三個消費者，而
  // 「某一份多穿了一格」這種錯不會讓任何測試變紅——它只是讓一個更早的輪次替現在這一輪
  // 背書。理由與另外兩個消費者見 {@link currentTurnStart} 的說明。
  const at = currentTurnStart(events);
  if (at < 0) return false;
  const data = events[at]?.data as TurnStart | undefined;
  return (
    data?.kind === 'goal' &&
    data.goalId === goal.id &&
    data.revision === goal.revision &&
    data.round === goal.roundsStarted
  );
}

/** 一次變更呼叫拿到的授權。照 dsh 的 `GoalToolAuthority`。 */
export type GoalToolAuthority =
  { readonly kind: 'direct-human' } | { readonly kind: 'goal-round'; readonly goal: GoalView };

/**
 * `complete` 與 `blocked` 的授權：**直接人類，或當前這一輪**。
 *
 * 其餘四個動作（`create`／`edit`／`pause`／`resume`）**仍然只收直接人類**。那不是保守，
 * 是這條路的整個重點：一個自己排得出輪次的模型若也能 `create`／`edit`，它就能改寫自己
 * 要達成的東西，而 `complete` 只是承認一件已經發生的事。
 *
 * @param events - 一份會話日誌到目前為止的全部事件。
 * @param goal - 目前那份視圖；沒有目前目標時給 `undefined`。
 * @returns 拿到的授權，兩條都不成立時是 `undefined`。
 */
export function completionAuthority(
  events: readonly SessionEvent[],
  goal: GoalView | undefined,
): GoalToolAuthority | undefined {
  if (hasDirectHumanTurn(events)) return { kind: 'direct-human' };
  if (goal !== undefined && isMatchingGoalRound(events, goal)) return { kind: 'goal-round', goal };
  return undefined;
}
