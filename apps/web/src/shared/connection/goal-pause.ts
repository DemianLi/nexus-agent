/**
 * `goal.pause` 被拒或業務失敗時，給使用者看的那一句。
 *
 * @module
 */

import type { CommandOutcome, GoalPauseResult, WireGoalPhase } from '@nexus/wire';

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
