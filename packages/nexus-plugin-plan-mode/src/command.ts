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

/**
 * 使用者還沒打字時的佔位字串。
 *
 * **dsh 是 `[off|message]`，我們是 `[off]`**——差的那個 `message` 是 dsh 用
 * `agent.steer()` 把它插進對話裡，我們沒有那條路（見 `index.ts` 的偏離說明）。
 * 提示字串要跟真的收得下的東西一致：寫了收不下的東西，等於在騙打字的人。
 */
export const PLAN_COMMAND_HINT = '[off]';

/** 一次 `/plan` 要求的方向。 */
export type PlanCommandRequest = 'enter' | 'leave';

/**
 * 讀 `/plan` 後面的原文。
 *
 * **只收兩種**：空的（進計劃模式）與 `off`（離開）。其餘一律是 `undefined`，由呼叫端
 * 回 `{ kind: 'error' }`——而不是「不認得就當成進入」。安靜地把打錯的參數吞掉，會讓
 * `/plan of` 看起來成功了而其實做了相反的事。
 *
 * @param rawInput - 命令名之後的原文，**含分隔的空白**（`CommandInvocation.rawInput`
 *   不做 trim，文法歸這裡管）。
 * @returns 要求的方向，或參數不合法時的 `undefined`。
 */
export function parsePlanCommandArgs(rawInput: string): PlanCommandRequest | undefined {
  const message = rawInput.trim();
  if (message === '') return 'enter';
  if (message === 'off') return 'leave';
  return undefined;
}

/** 參數不合法時回給人的話。**指名收得下什麼**，不然人只知道自己錯了。 */
export const PLAN_ARGS_ERROR_MESSAGE = `/${PLAN_COMMAND_NAME} 只收兩種：不帶參數（進計劃模式）或 off（離開）。`;

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
