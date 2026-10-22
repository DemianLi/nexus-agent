import type {
  CommandOutcome,
  GoalPauseResult,
  WireGoal,
  WireGoalActivation,
  WireGoalPhase,
} from '@nexus/wire';

/**
 * 輸入框上方的目標列在畫面上的判斷（[#945](https://github.com/DemianLi/nexus-agent/issues/945)）。資料是 harness 的
 * 投影 `ConversationState.goal`（#897）。
 *
 * 照 dsh 的 `GoalBar`：**有目標才畫，`complete` 與沒有目標都不畫**。`null` 是沒有目標，不分從沒建過、建了又清掉、還沒收到。
 *
 * **列上唯一的動作是暫停**（[#1517](https://github.com/DemianLi/nexus-agent/issues/1517)）：`active` 才給，送 `goal.pause`
 * （#1516）。dsh 的暫停鈕要 `active` 而且 `armed` 才出現（`GoalBar.tsx:141-146`）；PM 定成**只看相位**（UI/UX，不必照 dsh 的
 * 條件），activation 送上線之後也不改（[#1608](https://github.com/DemianLi/nexus-agent/issues/1608) Q1 (a)）：這裡沒有恢復鈕，
 * disarmed 時藏掉暫停，列上就一個動作都沒有。一輪跑著、停在核准點、閒著都給：server 三種都收，跑著時當場停掉那一輪。
 *
 * **階段字不說謊**：`phase === 'active'` 是**持久相位**，不等於「正在續行」——重啟後它仍是 `active`，但可能沒在跑。
 * 會不會自己續行看 activation（[#1575](https://github.com/DemianLi/nexus-agent/issues/1575) 送的 `ConversationState.goalActivation`，#1608）：
 * `armed` 寫「進行中」，`disarmed` 寫「沒有在跑」並給下一步（`/goal resume`；wire 沒有 `goal.resume`，所以不做成按鈕，Q2 (a)）；
 * **還沒收到（`null`）照舊寫中性的「未完成」**，不猜它會不會跑（`goal.ts` 的 `GOAL_ACTIVATION` 說明）。只有 `active` 看
 * activation：`paused`、`blocked` 自己就講了它沒在跑，`complete` 不畫。
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

/** `active` 而且會自己續行（`armed`，#1608 Q3 (a)）。 */
export const GOAL_ACTIVE_ARMED_TEXT = '目標：進行中';

/** `active` 但不會自己續行（`disarmed`：重啟、按了停止、一輪出錯或撞到輸出上限之後，#1608）。 */
export const GOAL_ACTIVE_DISARMED_TEXT = '目標：未完成，沒有在跑';

/** `active`＋`disarmed` 時列上那句下一步：講得出要做什麼，寫法同 {@link PROMPT_REJECTED_TEXT}。 */
export const GOAL_RESUME_HINT = '輸入 /goal resume 讓它繼續。';

/**
 * `prompt-rejected`：目標續行的那一輪在進模型之前被準入閘門擋下（今天的唯一來源是會話已封存，[#633](https://github.com/DemianLi/nexus-agent/issues/633)）。
 * server 給的 `message` 是英文固定句，這裡換成講得出下一步的中文：**取消封存不會自己接回來**，要人 `/goal resume`。
 * 用詞與輸入框上方的封存橫幅、泡泡下的提示一致（「會話已封存」）。
 */
export const PROMPT_REJECTED_TEXT =
  '續行的那一輪被擋下了（會話已封存）。取消封存後請輸入 /goal resume。';

export interface GoalBarView {
  /** 階段字，例如「目標：未完成」。 */
  readonly phase: string;
  /** 目標內容全文。畫面上單行截短，全文放 `title` 與 {@link label}。 */
  readonly objective: string;
  /** 「第 N／M 輪」；還沒開始過續行（`roundsStarted === 0`）就沒有。這是「目標會不會跑到上限」唯一看得到的線索。 */
  readonly rounds?: string;
  /** `blocked` 時的理由全文，直接顯示在列上，不只放 `title`（觸控裝置沒有滑過）。 */
  readonly blockedReason?: string;
  /** `active` 但不會自己續行時的下一步（{@link GOAL_RESUME_HINT}），同 {@link blockedReason} 直接顯示在列上。 */
  readonly resumeHint?: string;
  /** 整列的無障礙名稱：階段、目標全文、輪數、理由或下一步。 */
  readonly label: string;
  /** 列上要不要給暫停鈕：相位是 `active` 才給（#1517）。 */
  readonly pausable: boolean;
}

/**
 * 這一刻目標列畫什麼；`undefined` 就是不畫。
 *
 * @param activation - `ConversationState.goalActivation`：`null` 是還沒收到，照中性的寫。
 */
export function goalBarView(
  goal: WireGoal | null,
  activation: WireGoalActivation | null,
): GoalBarView | undefined {
  if (goal === null || goal.phase === 'complete') return undefined;
  const live = goal.phase === 'active' ? activation : null;
  const phase =
    live === 'armed'
      ? GOAL_ACTIVE_ARMED_TEXT
      : live === 'disarmed'
        ? GOAL_ACTIVE_DISARMED_TEXT
        : GOAL_PHASE_TEXT[goal.phase];
  const resumeHint = live === 'disarmed' ? GOAL_RESUME_HINT : undefined;
  const rounds =
    goal.roundsStarted > 0 ? `第 ${goal.roundsStarted}／${goal.maxGoalRounds} 輪` : undefined;
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined;
  const blockedReason = reason?.code === 'prompt-rejected' ? PROMPT_REJECTED_TEXT : reason?.message;
  return {
    phase,
    objective: goal.objective,
    ...(rounds === undefined ? {} : { rounds }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
    ...(resumeHint === undefined ? {} : { resumeHint }),
    label: [phase, goal.objective, rounds, blockedReason, resumeHint]
      .filter((part): part is string => part !== undefined)
      .join('，'),
    pausable: goal.phase === 'active',
  };
}

/** 暫停鈕的名稱與 tooltip：講按下去會發生的事。 */
export const GOAL_PAUSE_LABEL = '暫停目標';

/** 斷線時暫停鈕停用的提示。 */
export const GOAL_PAUSE_OFFLINE_HINT = '連線恢復後才能暫停';

/** `goal-not-active`：按下去的時候目標已經不是 `active`，依現在的相位講。`active` 不會出現在這個碼，鍵只為了齊。 */
const NOT_ACTIVE_TEXT = {
  active: '目標沒有暫停成功，請再按一次。',
  paused: '目標已經暫停了。',
  blocked: '目標受阻，沒有在跑，不用暫停。',
  complete: '目標已經完成了。',
} as const satisfies Record<WireGoalPhase, string>;

/**
 * `goal.pause` 的結果換成講給人聽的一句；成功回 `undefined`（列等下行把相位翻成 `paused`，按鈕自己消失，不搶先改畫面）。
 *
 * - `goal-stale`：按下去那一刻看到的目標已經被改過（別的分頁、模型自己的 `update_goal`）。**不重送**——server 回錯就是
 *   不讓後到的那一下蓋掉別人的結果；畫面隨後換成新的目標，要不要再按由人看過再決定。
 * - `not_supported`：這台 server 沒有 goal 域。
 * - 其餘 `rejected`（這條線收不了）照 server 的原話。
 */
export function goalPauseFailureText(outcome: CommandOutcome<GoalPauseResult>): string | undefined {
  if (outcome.kind === 'rejected') {
    return outcome.code === 'not_supported' ? '這台伺服器不支援暫停目標。' : outcome.message;
  }
  const { result } = outcome;
  if (result.ok) return undefined;
  switch (result.error.code) {
    case 'goal-stale':
      return '目標剛被改過，這次沒有暫停。請看過現在的目標再決定。';
    case 'goal-not-active':
      return NOT_ACTIVE_TEXT[result.error.phase];
    case 'goal-not-found':
      return '這條對話已經沒有目標了。';
  }
}
