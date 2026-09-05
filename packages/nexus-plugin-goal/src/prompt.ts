/**
 * 一輪續行的**模型面文字**：`renderGoalRoundPrompt` 是它唯一的來源。
 *
 * 照抄 dsh 的 `packages/goal/goal-round-driver/src/prompt.ts`（對讀版本
 * `d347e703908d0406b7a7ef80e3a0e594d86b2215`，2026-09-04）。
 *
 * ## 為什麼它是一個純函式，而且住在這個套件
 *
 * 排它的人（`apps/harness` 的排程器）與**驗它的人**（`invariant.ts` 的伴生）必須算得出
 * 同一串字，否則伴生驗的是自己。純函式 ＋ 單一擁有者是那個「同一串」唯一撐得住的形狀：
 * 伴生從耐久前綴重建目標、呼叫這裡、逐字比對日誌上那顆。
 *
 * ## 兩處形狀差異
 *
 * - **回一個 `string`，不是 `ContentBlock[]`。** dsh 的訊息內容是區塊陣列，我們的
 *   `turn/start` 帶的是 `text: string`，而 `HumanMessage` 也吃字串。窄一格，表達力相同。
 * - **吃 `GoalSnapshot`，不是 `GoalView`。** 這個 renderer 只讀 `objective` 與
 *   `maxGoalRounds`，兩格都在快照裡。dsh 吃視圖，於是它的伴生得為此造一份帶假
 *   `activation` 的視圖；吃快照就不必——伴生手上本來就有折疊出來的快照。
 *
 * @module
 */

import type { GoalSnapshot } from '@nexus/core';

/**
 * 排一輪續行時交給模型的那一整段話。
 *
 * **這段文字描述的每一件事都要真的存在。** 最後一句指的是
 * {@link ./tools.ts | goal 工具}的 block 門檻（連續幾輪同一個條件才准報阻塞），那條政策
 * 隨這一輪的授權路徑一起落地；沒有它的話這一句就要拿掉，理由見
 * `tools.ts` 檔頭那條「不要照抄描述我們沒有的機制的句子」。
 *
 * @param goal - 被準入那一輪當下的目標快照。
 * @param round - 第幾輪，從 1 起算。
 * @returns 完整的一段續行指示。
 */
export function renderGoalRoundPrompt(goal: GoalSnapshot, round: number): string {
  return (
    '<goal_round>\n' +
    `Objective: ${JSON.stringify(goal.objective)}\n` +
    `Round: ${round}/${goal.maxGoalRounds}\n\n` +
    'Continue working toward the objective in this same session. Treat the current workspace, ' +
    'tool results, and durable session state as authoritative; inspect them instead of assuming ' +
    'earlier narration is still current. Make concrete progress and verify the result. Before ' +
    'claiming completion, gather evidence that the whole objective is achieved, read the current ' +
    'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow ' +
    'the configured goal-tool policy before reporting a blocker.\n' +
    '</goal_round>'
  );
}
