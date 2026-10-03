import type { WireGoal, WireGoalPhase } from '@nexus/wire';

/**
 * 輸入框上方的目標列在畫面上的判斷（[#945](https://github.com/DemianLi/nexus-agent/issues/945)）。資料是 harness 的
 * 投影 `ConversationState.goal`（#897）。
 *
 * 照 dsh 的 `GoalBar`：**有目標才畫，`complete` 與沒有目標都不畫**。`null` 是沒有目標，不分從沒建過、建了又清掉、還沒收到。
 *
 * **階段字不說謊**：`phase === 'active'` 是**持久相位**，不等於「正在續行」——重啟後它仍是 `active`，但可能沒在跑。
 * dsh 用 activation 區分「進行中」與「未運行」，我們的線上還沒有那一半（#638、#660、#661），所以 `active` 只寫中性的
 * 「未完成」，**不寫「進行中」「正在跑」**；activation 落地後再細分。
 *
 * @module
 */

/** 四個相位各一句。`complete` 不畫，但鍵要齊：wire 多一個相位，這裡編不過。 */
export const GOAL_PHASE_TEXT = {
  active: '目標：未完成',
  paused: '目標：已暫停',
  blocked: '目標：受阻',
  complete: '目標：已完成',
} as const satisfies Record<WireGoalPhase, string>;

export interface GoalBarView {
  /** 階段字，例如「目標：未完成」。 */
  readonly phase: string;
  /** 目標內容全文。畫面上單行截短，全文放 `title` 與 {@link label}。 */
  readonly objective: string;
  /** 「第 N／M 輪」；還沒開始過續行（`roundsStarted === 0`）就沒有。這是「目標會不會跑到上限」唯一看得到的線索。 */
  readonly rounds?: string;
  /** `blocked` 時的理由全文，直接顯示在列上，不只放 `title`（觸控裝置沒有滑過）。 */
  readonly blockedReason?: string;
  /** 整列的無障礙名稱：階段、目標全文、輪數。 */
  readonly label: string;
}

/** 這一刻目標列畫什麼；`undefined` 就是不畫。 */
export function goalBarView(goal: WireGoal | null): GoalBarView | undefined {
  if (goal === null || goal.phase === 'complete') return undefined;
  const phase = GOAL_PHASE_TEXT[goal.phase];
  const rounds =
    goal.roundsStarted > 0 ? `第 ${goal.roundsStarted}／${goal.maxGoalRounds} 輪` : undefined;
  const blockedReason = goal.phase === 'blocked' ? goal.blockedReason?.message : undefined;
  return {
    phase,
    objective: goal.objective,
    ...(rounds === undefined ? {} : { rounds }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    label: [phase, goal.objective, rounds, blockedReason]
      .filter((part): part is string => part !== undefined)
      .join('，'),
  };
}
