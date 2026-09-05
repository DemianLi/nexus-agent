/**
 * `/goal` 的詞彙：**命令名、參數文法，與它回給人的每一句話**。
 *
 * 形狀照 dsh 的 `@deepseek-ai/dsh-command-goal`
 * （`references/deepseek-harness/packages/goal/command-goal/src/index.ts`，對讀版本
 * `0a53fb55bea101816fa226bb964ae2bed71c343b`）。那邊是獨立套件，這邊住在域的套件裡
 * ——**這是形狀差異不是偏離**：dsh 拆開是因為它的組裝清單逐套件掛載，域與命令要分別
 * 選；我們的 `DEFAULT_PLUGINS` 掛的是工廠函式，`createGoalPlugin()` 與
 * `createGoalCommandPlugin()` 拆成兩個並不會讓任何一種組裝變得表達得出來，只會多一個
 * 「掛了域卻沒掛命令」的無聲失敗態。
 *
 * 它不住在 `index.ts` 裡的理由與 `@nexus/plugin-plan-mode` 的 `command.ts` **只重疊一半**：
 * 那邊有兩條理由（文法的判準要跟配套入口共用一份、`/invariant` 子路徑要輕），這裡兩條
 * 都不成立——goal 的配套入口驗的是 `goal/change` 串本身，不讀命令的文法。留下來的那條
 * 是模組內聚：`index.ts` 回答「這個 plugin 掛什麼」，這裡回答「這一行字是什麼意思、
 * 要印什麼回去」，兩件事各自有測試。
 *
 * ## 不渲染 id 與 revision
 *
 * dsh 在 README 與程式碼裡各講一次：呈現文字**不暴露品牌型別的 id 與 revision**。
 * CAS 是域的內部協定，印出去只會讓人以為那是可以拿來打的東西。我們的 `GoalId` 是
 * branded type，更容易手滑印出來，所以這一條寫在這裡當提醒。
 *
 * @module
 */

import type { CommandResult, GoalPhase, GoalRef } from '@nexus/core';

import { GoalError } from './service.js';
import type { GoalService, GoalView } from './service.js';

/** 命令名，不帶斜線。**寫死的**——命令名是這個套件的介面，不是部署的設定。 */
export const GOAL_COMMAND_NAME = 'goal';

/** 探索清單上的那一句。同上，寫死。 */
export const GOAL_COMMAND_DESCRIPTION = '設定或查看長期任務的目標';

/**
 * 使用者還沒打字時的佔位字串。
 *
 * **dsh 的 `input` 還有一格 `images: true`，我們沒有。** 差的不是這個字串，是整條
 * 附件水管：`CommandInvocation` 沒有 `attachments`，那一格的「是缺，不是省略」已經寫在
 * {@link @nexus/core!CommandInvocation} 的檔頭上。提示字串要跟真的收得下的東西一致，
 * 所以這裡不寫圖片。
 */
export const GOAL_COMMAND_HINT = '[<目標>|clear|edit <目標>|pause|resume]';

/** 打錯時附在後面的那一行。**指名收得下什麼**，不然人只知道自己錯了。 */
export const GOAL_USAGE = `用法：/${GOAL_COMMAND_NAME} [<目標>|clear|edit <目標>|pause|resume]`;

/**
 * 一次 `/goal` 要求的動作。
 *
 * **七個成員，`invalid-edit` 是其中一個**——裸 `edit` 不是「建一個叫 edit 的目標」，
 * 也不是「顯示狀態」，它是一次講清楚的錯誤。dsh 把它做成 union 的一員而不是解析失敗，
 * 因為那樣渲染那一句話的地方只有一處。
 */
export type GoalCommand =
  | { readonly kind: 'show' }
  | { readonly kind: 'create'; readonly objective: string }
  | { readonly kind: 'edit'; readonly objective: string }
  | { readonly kind: 'invalid-edit' }
  | { readonly kind: 'pause' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'clear' };

/**
 * 讀 `/goal` 後面的原文。
 *
 * **控制詞只有在填滿整串輸入時才算控制詞。** `/goal pause after verification` 建的是
 * 「pause after verification」這個字面目標，不是暫停——照抄 dsh 的文法。理由是這個命令
 * 的主要用途是打一句話當目標，而一句話很可能以控制詞開頭；把前綴當控制詞會讓人的目標
 * 被靜靜吃掉一個詞。
 *
 * `edit` 是唯一收後綴的控制詞，而且要後面真的接著空白才算——`/goal editorial` 是目標。
 *
 * @param rawInput - 命令名之後的原文，**含分隔的空白**（`CommandInvocation.rawInput`
 *   不做 trim，文法歸這裡管）。
 * @returns 這一行要求的動作。**沒有「解析失敗」這個結果**：任何非空且不是控制詞的
 *   輸入都是目標。
 */
export function parseGoalCommand(rawInput: string): GoalCommand {
  const input = rawInput.trim();
  if (input.length === 0) return { kind: 'show' };
  const control = input.toLowerCase();
  if (control === 'clear') return { kind: 'clear' };
  if (control === 'pause') return { kind: 'pause' };
  if (control === 'resume') return { kind: 'resume' };
  if (control === 'edit') return { kind: 'invalid-edit' };
  if (/^edit(?=\s)/iu.test(input)) return { kind: 'edit', objective: input.slice(4).trim() };
  return { kind: 'create', objective: input };
}

/**
 * 每一個耐久相位給人看的說法。
 *
 * **是 `Record` 不是 `switch`**：`GoalPhase` 多一個成員時，這裡當場少一個 key 而
 * 編譯失敗——`switch` 只有在編譯器開了 `noImplicitReturns` 之類的旗標時才擋得住，
 * 而那是設定管的事，不是這個檔案管得到的。
 */
const PHASE_LABELS: Record<GoalPhase, string> = {
  active: '進行中',
  paused: '暫停',
  blocked: '被擋住',
  complete: '完成',
};

/** 一個耐久相位給人看的說法。 */
export function phaseLabel(phase: GoalPhase): string {
  return PHASE_LABELS[phase];
}

/** 停著的目標與剛續上的 session 走的是同一條路：先 resume。 */
const RESUME_HINT = `/${GOAL_COMMAND_NAME} edit <目標>、/${GOAL_COMMAND_NAME} resume、/${GOAL_COMMAND_NAME} clear`;

/** 每一個相位在**已授權**前提下打得動的命令。同上，`Record` 是為了少一個 key 就紅。 */
const PHASE_HINTS: Record<GoalPhase, string> = {
  active: `/${GOAL_COMMAND_NAME} edit <目標>、/${GOAL_COMMAND_NAME} pause、/${GOAL_COMMAND_NAME} clear`,
  paused: RESUME_HINT,
  blocked: RESUME_HINT,
  complete: `/${GOAL_COMMAND_NAME} <目標>、/${GOAL_COMMAND_NAME} clear`,
};

/**
 * 從這一個確切的狀態出發，**現在打得動的命令**。
 *
 * 這不是把所有子命令列一遍：`active` 且已授權時列的是 pause，沒授權時列的是 resume
 * ——後者正是 session 續上之後那個 disarmed 邊要走的路。照抄 dsh 的分支。
 */
export function commandHint(goal: GoalView): string {
  if (goal.phase === 'active' && goal.activation === 'disarmed') return RESUME_HINT;
  return PHASE_HINTS[goal.phase];
}

/** process 內的續行授權給人看的說法。 */
function activationLabel(goal: GoalView): string {
  return goal.activation === 'armed' ? '已授權' : '未授權';
}

/**
 * 把一份狀態渲染成直接印給人看的成功結果。
 *
 * **不放 id 也不放 revision**，見檔頭。
 *
 * @param title - 第一行，說這一次做了什麼。
 * @param goal - 要渲染的狀態。
 * @returns 一顆 `success`。
 * @throws 相位是 `blocked` 卻沒有理由——耐久重放保證每一個被擋住的目標都帶著它驗過的
 *   理由，所以這是實作壞掉，不是可預期的拒絕。
 */
export function renderGoal(title: string, goal: GoalView): CommandResult {
  const reason = goal.phase === 'blocked' ? goal.blockedReason : undefined;
  if (goal.phase === 'blocked' && reason === undefined) {
    throw new TypeError('被擋住的目標少了它的理由');
  }
  return {
    kind: 'success',
    text: [
      title,
      `狀態：${phaseLabel(goal.phase)}`,
      ...(reason === undefined ? [] : [`擋住它的：${reason.code}：${reason.message}`]),
      `目標：${goal.objective}`,
      `輪次：${String(goal.roundsStarted)}/${String(goal.maxGoalRounds)}`,
      `續行授權：${activationLabel(goal)}`,
      '',
      `現在打得動：${commandHint(goal)}`,
    ].join('\n'),
  };
}

/** 裸 `/goal` 而且一個目標都沒有。**這是成功不是錯誤**——問了就答，沒有就說沒有。 */
export const GOAL_NONE_MESSAGE = `目前沒有設定目標。\n${GOAL_USAGE}`;

/** 裸 `edit`：收得下後綴，但這一次沒給。 */
export const GOAL_INVALID_EDIT_MESSAGE = `/${GOAL_COMMAND_NAME} edit 要接一句新的目標。\n${GOAL_USAGE}`;

/** `clear` 成功。 */
export const GOAL_CLEARED_MESSAGE = '目標清掉了。';

/**
 * `clear` 而且本來就沒有目標。**成功，不是錯誤。**
 *
 * 這一條與 `edit` / `pause` / `resume` 的不對稱是照抄 dsh 的，而且它是對的：clear 要的
 * 結果是「之後沒有目標」，本來就沒有的時候那個結果已經成立了。另外三個要的是「改動
 * 現在這一個」，沒有主詞就做不成。
 */
export const GOAL_NOTHING_TO_CLEAR_MESSAGE = '沒有目標可清。';

/** `edit` / `pause` / `resume` 而且沒有目標。 */
export function goalMissingMessage(action: string): string {
  return `目前沒有設定目標，/${GOAL_COMMAND_NAME} ${action} 需要一個。${GOAL_USAGE}`;
}

/** `create` 而且已經有一個沒完成的。**指路而不是只說不行**。 */
export function goalAlreadyMessage(phase: GoalPhase): string {
  return (
    `已經有一個${phaseLabel(phase)}的目標。` +
    `用 /${GOAL_COMMAND_NAME} edit <目標> 改它，或先 /${GOAL_COMMAND_NAME} clear 再換一個。`
  );
}

/**
 * 域的可預期拒絕轉成的那一句話。
 *
 * **固定一句，不透出 `GoalError.code` 也不透出它的訊息**——照抄 dsh。域的訊息裡帶著
 * id 與相位轉換的內部說法，那些是給程式看的；打字的人要的是「現在能打什麼」，而那個
 * 答案裸 `/goal` 印得出來。
 */
export const GOAL_REJECTED_MESSAGE = `這個 goal 命令在目前的狀態下不成立。打 /${GOAL_COMMAND_NAME} 看現在能做什麼。`;

/**
 * 這一份組裝一份日誌都沒接上。
 *
 * **這條走得到的路是真的**：`attachSession` 是組裝點自己要呼叫的一步，漏掉它的入口
 * 拿到的是一個註冊了命令卻沒有狀態的 plugin。回一句說得出原因的話，比讓
 * `services[0]` 是 `undefined` 然後在某處炸掉好。
 */
export const GOAL_NOT_ATTACHED_MESSAGE = `goal 域還沒接上這個會話的日誌，/${GOAL_COMMAND_NAME} 沒有可以動的目標。`;

/**
 * 這一份組裝接了不只一份日誌。
 *
 * **這一句釘住的是一個假設，不是一個功能。** `/goal` 靠「一次 `apply` 對應一份日誌」
 * 找得到它要動的服務——CLI 一份、`serve.ts` 每個 thread 各自 `createCliAgent` 因此
 * 各自一份 registry，兩條路都成立。假設破掉時要**當場說**，不能讓後接上的那一份
 * 靜靜贏走：那樣一次 `/goal pause` 會暫停另一個 thread 的目標而沒有任何徵兆。
 *
 * 它不寫成安裝期的 throw，是因為 `createSessionRunner` 把參與者安裝失敗**圍堵成一行
 * warn**——在那裡拋，換來的是一個沒有 goal 服務、而且沒有人看得到原因的 agent。
 */
export function goalAmbiguousMessage(count: number): string {
  return (
    `這一份組裝接了 ${String(count)} 份會話日誌，/${GOAL_COMMAND_NAME} 分不出要動哪一份。` +
    `一份組裝只接一份日誌。`
  );
}

/**
 * 跑一次已經解析好的命令，**變更一律經過擁有耐久性的域**。
 *
 * 錯誤分兩類，而分法照抄 dsh：
 *
 * - {@link GoalError} 是**可預期的拒絕**（相位不對、CAS 過期），轉成一顆固定訊息的
 *   `kind: 'error'`，命令算是跑完了。
 * - 其餘一律**往外拋**，讓發派面把它報成一次命令失敗。這條路在我們這裡比 dsh 更常
 *   走得到：折疊壞掉之後 `GoalService` 的每一個方法都丟裸 `Error`，所以**連裸
 *   `/goal` 都會拋**。兩條進入點都接得住——REPL 印到 stderr，wire 回一顆
 *   `kind: 'error'` 的封包，而執行器在往外拋之前已經把 `command/done` 寫進日誌了。
 *
 * @param services - 這一次 `apply` 接上的服務，**期望剛好一個**。
 * @param rawInput - 命令名之後的原文。
 * @returns 直接呈現給人的結果。
 * @throws 域的非預期失敗，包含折疊壞掉之後的每一次讀。
 */
export function executeGoalCommand(
  services: readonly GoalService[],
  rawInput: string,
): CommandResult {
  if (services.length === 0) return { kind: 'error', text: GOAL_NOT_ATTACHED_MESSAGE };
  if (services.length > 1) {
    return { kind: 'error', text: goalAmbiguousMessage(services.length) };
  }
  const goals = services[0] as GoalService;
  const command = parseGoalCommand(rawInput);
  try {
    const current = goals.get();
    switch (command.kind) {
      case 'show':
        return current === undefined
          ? { kind: 'success', text: GOAL_NONE_MESSAGE }
          : renderGoal('目標', current);
      case 'invalid-edit':
        return { kind: 'error', text: GOAL_INVALID_EDIT_MESSAGE };
      case 'create': {
        // **域自己也擋這一條**，這裡先擋一次是為了那句指得出下一步的話——域丟的
        // `GOAL_ALREADY_EXISTS` 會變成固定的那一句，而那一句說不出「用 edit 改它」。
        if (current !== undefined && current.phase !== 'complete') {
          return { kind: 'error', text: goalAlreadyMessage(current.phase) };
        }
        return renderGoal('目標建好了', goals.create({ objective: command.objective }));
      }
      case 'edit': {
        if (current === undefined) return { kind: 'error', text: goalMissingMessage('edit') };
        // **完成掉的目標用 edit 換一個新的**，而且回的是「建好了」不是「改好了」——
        // 換掉的是身分不只是敘述，說成「改好了」會讓人以為歷史還接在同一條上。
        if (current.phase === 'complete') {
          return renderGoal('目標建好了', goals.create({ objective: command.objective }));
        }
        return renderGoal(
          '目標改好了',
          goals.edit(goalRef(current), { objective: command.objective }),
        );
      }
      case 'pause':
        if (current === undefined) return { kind: 'error', text: goalMissingMessage('pause') };
        return renderGoal('目標暫停了', goals.pause(goalRef(current)));
      case 'resume':
        if (current === undefined) return { kind: 'error', text: goalMissingMessage('resume') };
        return renderGoal('目標續上了', goals.resume(goalRef(current)));
      case 'clear':
        if (current === undefined) return { kind: 'success', text: GOAL_NOTHING_TO_CLEAR_MESSAGE };
        goals.clear(goalRef(current));
        return { kind: 'success', text: GOAL_CLEARED_MESSAGE };
    }
  } catch (error: unknown) {
    if (error instanceof GoalError) return { kind: 'error', text: GOAL_REJECTED_MESSAGE };
    throw error;
  }
}

/** 現在這一刻的 CAS ref。**只在這個檔案裡用**，不進渲染。 */
function goalRef(goal: GoalView): GoalRef {
  return { id: goal.id, revision: goal.revision };
}
