/**
 * `/plan` 的詞彙：**命令名、參數文法，與它回給人的每一句話**。
 *
 * 這個模組刻意只相依標準庫，而且刻意不住在 `index.ts` 裡，兩個理由各擋一種缺陷：
 *
 * 1. **判準只能有一份。** `index.ts` 註冊 handler 時用 {@link parsePlanCommandArgs}
 *    判參數合不合法，`invariant.ts` 用**同一個函式**判日誌裡那一筆 `command/run` 的
 *    `args`。各寫一份 `trim() === 'off'` 的話，兩邊一漂，配套入口報的就是不存在的違規。
 * 2. **配套入口的子路徑要輕。** `@nexus/plugin-commands` 那份 `invariant.ts` 只有
 *    type-only import 是刻意的——`invariant-companions.test.ts` 與 CLI 的預設清單都走
 *    `@nexus/plugin-plan-mode/invariant`，從那裡值匯入 `index.js` 會把 `langchain`、
 *    `zod` 與 `@langchain/langgraph` 整串拖進那條路。
 *
 * @module
 */

/** 命令名，不帶斜線。**寫死的**——命令名是這個套件的介面，不是部署的設定。 */
export const PLAN_COMMAND_NAME = 'plan';

/** 探索清單上的那一句。同上，寫死。 */
export const PLAN_COMMAND_DESCRIPTION = '進入或離開計劃模式';

/** 使用者還沒打字時的佔位字串。同 dsh 的 `[off|message]`（#776）。 */
export const PLAN_COMMAND_HINT = '[off|message]';

/**
 * 一次 `/plan` 要求什麼。
 *
 * `enter` 帶著 `message` 時，命令進了計劃模式之後還要把這句話當成人打的一句話送進對話
 * （`CommandInvocation.steer`，dsh 的 `agent.steer()`）。
 */
export type PlanCommandRequest =
  { readonly kind: 'leave' } | { readonly kind: 'enter'; readonly message?: string };

/**
 * 讀 `/plan` 後面的原文。**照 dsh**（`packages/plan/plan-mode/src/index.ts` 的 handler）：
 * 剛好是 `off`（去掉頭尾空白後）就離開，其餘都是進入，非空的部分是要送進對話的話。
 *
 * **這裡沒有「不合法的參數」了。** 以前只收空的與 `off`，其餘回 `error`，理由是安靜吞掉打錯的
 * 參數會讓 `/plan of` 看起來成功了而其實做了相反的事；收下自由訊息之後，`/plan of` 就是
 * 「進計劃模式並把 `of` 送給模型」，同 dsh。要擋這一類缺陷改由 `invariant.ts` 看日誌：
 * `/plan off` 落定之前寫下的 `plan/mode` 必須是關、其餘必須是開。
 *
 * @param rawInput - 命令名之後的原文，**含分隔的空白**（`CommandInvocation.rawInput`
 *   不做 trim，文法歸這裡管）。
 * @returns 要求的方向與要送的話。
 */
export function parsePlanCommandArgs(rawInput: string): PlanCommandRequest {
  const message = rawInput.trim();
  if (message === 'off') return { kind: 'leave' };
  return message === '' ? { kind: 'enter' } : { kind: 'enter', message };
}

/**
 * 這一份組裝還沒接上會話日誌。
 *
 * 模式住在日誌上（`plan/mode`），沒有日誌就沒有地方記——**說出原因**，而不是回「開了」
 * 然後什麼都沒發生。同 `@nexus/plugin-goal` 的 `GOAL_NOT_ATTACHED_MESSAGE`：命令在接線之前
 * 就註冊好了，所以這條路走得到。
 */
export const PLAN_NOT_ATTACHED_MESSAGE = `計劃模式還沒接上這個會話的日誌，/${PLAN_COMMAND_NAME} 沒有地方記下模式，所以沒有動。`;

/**
 * 這一份組裝接了不只一份 root 日誌，挑不出要改哪一份。
 *
 * @param count - 接了幾份。
 * @returns 回給人的那一句。
 */
export function planAmbiguousMessage(count: number): string {
  return `這個組裝接了 ${String(count)} 份會話日誌，/${PLAN_COMMAND_NAME} 不知道要改哪一份，所以沒有動。`;
}

/** `/plan`：這一刻真的把模式打開了。 */
export const PLAN_ENTERED_MESSAGE = `計劃模式開了。用 /${PLAN_COMMAND_NAME} off 離開。`;

/** `/plan`：本來就開著。 */
export const PLAN_ALREADY_ACTIVE_MESSAGE = '已經在計劃模式裡了。';

/** `/plan off`：這一刻真的把模式關掉了。 */
export const PLAN_LEFT_MESSAGE = '計劃模式關了。';

/** `/plan off`：本來就沒開。 */
export const PLAN_ALREADY_INACTIVE_MESSAGE = '本來就不在計劃模式裡。';
