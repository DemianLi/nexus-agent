/**
 * `@nexus/plugin-goal`——一個會話的**長期目標**：狀態、CAS 變更、續行授權。
 *
 * 形狀照 dsh 的 `packages/goal/`（對讀日期 2026-09-01，版本
 * `0a53fb55bea101816fa226bb964ae2bed71c343b`）。那一組有四個子套件，**這裡只做兩個**，
 * 而且兩個「沒做」的理由不一樣：
 *
 * | dsh 的子套件 | 這裡 |
 * | --- | --- |
 * | `goal`（域） | 這個套件 |
 * | `command-goal`（`/goal`） | 這個套件的 `command.ts`，走 `registry.commands` |
 * | `tool-goal`（模型工具） | `tools.ts` ＋ `authority.ts`（[#177](https://github.com/DemianLi/nexus-agent/issues/177)） |
 * | `goal-round-driver`（自動續行） | **拆成兩處**，見下面 |
 *
 * **`tool-goal` 當初擋著的兩件都通了。** 它的權限規則要求「執行時根 agent 的當前輪次中
 * 有一則已接受的 `{ kind: 'user' }` 訊息」，而且要分得出 root 與 subagent 的血緣。
 *
 * - 血緣：三顆工具用 `rootOnly` 註冊，fold 把每個 subagent 那一份裡的同名項換成拒絕樁
 *   （`@nexus/core` 的 `fold.ts`）——而**「拒絕 subagent」正是 dsh 對 `tool-goal` 的政策
 *   本身**，不是我們的收窄（`packages/goal/tool-goal/src/authority.ts` 的
 *   `ctx.agents.roots().includes(execution.agent)`，描述寫著 “rejects non-human and
 *   subagent authority”）。
 * - 人類輪次：讀會話日誌的 `turn/start`，判準與它為什麼不能寫成「看最後一顆」在
 *   `authority.ts` 檔頭。
 *
 * ## `goal-round-driver` 拆成兩處，而拆點是一筆登記過的載體偏離
 *
 * dsh 把它做成一個獨立套件；[#180](https://github.com/DemianLi/nexus-agent/issues/180)
 * 落地時發現**排程器不可能是一個 plugin**——`PluginRegistry` 十五條通道沒有一條排得出
 * 一輪，輪迴圈歸入口點所有（`thread-pump.ts` 的 `#runOnce`、`cli.ts` 的 `runTurn`）。
 * 所以：
 *
 * - **排程器落在 `apps/harness`**，由 `--goal-driver` 旗標決定掛不掛。載體丟掉、紀律
 *   照抄，同 `containment.ts` 對 `guard/timeout-policy` 那一筆。
 * - **檢查與 renderer 留在這裡**：`prompt.ts` 是續行文字的唯一來源，`invariant.ts` 驗
 *   每一顆 goal 輪次逐字等於它。判準是**只要 `kind: 'goal'` 這個詞彙存在，伴生就武裝**
 *   ——與有沒有掛排程器無關。只在掛了排程器時才擋的檢查，對一顆手寫或寫壞的輪次是零
 *   防守。
 *
 * 順序當初是被強制的：先掛排程器、後補判別欄的話，它自己排的那一輪在日誌上跟人打的一
 * 模一樣，於是模型自己就過了上面那道人類授權檢查
 * （[#152](https://github.com/DemianLi/nexus-agent/issues/152) 的決議）。所以那張卡的
 * 內部順序是詞彙 → 折疊 → 伴生 → 排程器，排程器最後。
 *
 * ## 這個套件進了預設清單
 *
 * **上一張 PR 這裡寫的是「不進」**，理由是「域在 `/goal` 落地之前沒有任何人打得到的
 * 入口」。`/goal` 落地了，那個理由就沒了：`createGoalPlugin()` 現在同時掛域與命令，
 * 兩件事一起進 `DEFAULT_PLUGINS`。位置跟在計劃模式後面、所有配套入口前面——啟動時印的
 * `plugin：` 那一行按清單順序走，域與配套入口混在一起會讓那行讀不出誰是誰。
 *
 * **域與命令不拆成兩個 plugin。** dsh 拆（`dsh-goal` 與 `dsh-command-goal` 是兩個套件），
 * 因為它的組裝清單逐套件掛載，「掛域不掛命令」是 ACP 那種自動化應用真的要的組裝。我們
 * 的清單掛的是工廠函式，拆開換不到任何一種表達不出來的組裝，只多一個「掛了域卻沒掛
 * 命令」的無聲失敗態。**這是形狀差異不是偏離**，同 `command.ts` 檔頭寫的那一條。
 *
 * @see [#126](https://github.com/DemianLi/nexus-agent/issues/126)
 * @module
 */

import type { NexusPlugin, SessionLog } from '@nexus/core';

import {
  executeGoalCommand,
  GOAL_COMMAND_DESCRIPTION,
  GOAL_COMMAND_HINT,
  GOAL_COMMAND_NAME,
} from './command.js';
import { assertGoalServiceOptions, GoalService } from './service.js';
import type { GoalServiceOptions } from './service.js';
import { createGoalTools, resolveGoalToolPolicy } from './tools.js';
import type { GoalToolPolicy } from './tools.js';

export type { GoalCommand } from './command.js';
export {
  commandHint,
  executeGoalCommand,
  GOAL_CLEARED_MESSAGE,
  GOAL_COMMAND_DESCRIPTION,
  GOAL_COMMAND_HINT,
  GOAL_COMMAND_NAME,
  GOAL_INVALID_EDIT_MESSAGE,
  GOAL_NONE_MESSAGE,
  GOAL_NOT_ATTACHED_MESSAGE,
  GOAL_NOTHING_TO_CLEAR_MESSAGE,
  GOAL_REJECTED_MESSAGE,
  GOAL_USAGE,
  goalAlreadyMessage,
  goalAmbiguousMessage,
  goalMissingMessage,
  parseGoalCommand,
  phaseLabel,
  renderGoal,
} from './command.js';

export type {
  GoalToolLookup,
  GoalToolPolicy,
  GoalToolValue,
  GoalToolWiring,
  GoalUpdateAction,
} from './tools.js';
export {
  createGoalTools,
  DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS,
  GOAL_TOOL_COMPLETION_AUTHORITY_MESSAGE,
  goalToolBlockTooSoonMessage,
  resolveGoalToolPolicy,
  GOAL_CREATE_TOOL_NAME,
  GOAL_GET_TOOL_NAME,
  GOAL_MODEL_REPORTED_CODE,
  GOAL_TOOL_AUTHORITY_MESSAGE,
  GOAL_TOOL_ERROR_PREFIX,
  GOAL_TOOL_INVALID_REF_MESSAGE,
  GOAL_TOOL_NO_SERVICE_MESSAGE,
  GOAL_TOOL_NOT_ATTACHED_MESSAGE,
  GOAL_TOOL_REASON_MISPLACED_MESSAGE,
  GOAL_TOOL_REASON_REQUIRED_MESSAGE,
  GOAL_TOOL_REPLACEMENT_MISPLACED_MESSAGE,
  GOAL_TOOL_UNKNOWN_CALLER_MESSAGE,
  GOAL_UPDATE_TOOL_NAME,
  goalToolAmbiguousMessage,
  goalToolValue,
} from './tools.js';

export type { GoalToolAuthority } from './authority.js';
export { completionAuthority, hasDirectHumanTurn, isMatchingGoalRound } from './authority.js';

export { renderGoalRoundPrompt } from './prompt.js';
export { renderWrapupContext } from './wrapup.js';

export type { FoldedGoal, GoalFoldState } from './fold.js';
export {
  applyGoalChange,
  applyGoalEvent,
  decodeGoalChange,
  emptyGoalFoldState,
  foldGoal,
  goalChangeRef,
} from './fold.js';

export type {
  CreateGoalRequest,
  EditGoalRequest,
  GoalActivation,
  GoalErrorCode,
  GoalServiceOptions,
  GoalView,
} from './service.js';
export {
  assertGoalServiceOptions,
  DEFAULT_MAX_GOAL_ROUNDS,
  GoalError,
  GoalService,
} from './service.js';

/**
 * 掛 goal 域時換得掉的東西。
 *
 * **兩半各給各的**：域那幾格（時鐘、id 工廠、預設輪次上限）原樣轉給每一份日誌上的
 * {@link GoalService}；`blockedAfterConsecutiveRounds` 是**工具的政策**，只到
 * {@link createGoalTools}。dsh 也是這樣分的——它是兩個套件各自的 config。
 */
export interface GoalPluginOptions extends GoalServiceOptions, GoalToolPolicy {}

/**
 * 這一次掛載，加上**找得到每一份日誌的服務**的兩個方法。
 *
 * 為什麼要多這兩個：同一個 plugin 物件會被組裝很多次（`serve.ts` 每個 thread 一次），
 * 服務綁的是日誌不是 plugin，所以「哪一個服務」這個問題有指涉對象，而 `NexusPlugin`
 * 上沒有地方問它。
 *
 * **`/goal` 不走這裡。** 上一張 PR 的註解說它會，那是錯的——handler 拿到的
 * `CommandInvocation` 沒有日誌，`serviceFor(log)` 問不出來。它走的是**逐次 `apply` 的
 * 閉包**：`load.ts` 一次組裝呼叫一次 `apply`，而一份 registry 只接一份日誌，所以那一格
 * 就是答案（同 `@nexus/plugin-plan-mode` 的 cell）。這兩個方法留著是**診斷用的**，
 * 沒有 production 消費者。
 */
export interface GoalPlugin extends NexusPlugin {
  /**
   * 某一份日誌上的服務。
   * @param log - 已經接過線的日誌。
   * @returns 那一份的服務，沒接過就是 `undefined`。
   */
  serviceFor(log: SessionLog): GoalService | undefined;
  /**
   * 目前接著的每一份，**依接線順序**。
   * @returns 服務清單；一份都沒接時是空的。
   */
  attached(): readonly GoalService[];
}

/**
 * 建一個 goal 域的 plugin。
 *
 * 它掛三樣東西：`sessions` 通道的一位參與者、`tools` 通道的三顆工具，與 `commands`
 * 通道的 `/goal`。**不改 prompt、不碰 backend。**
 *
 * **那三顆與 `/goal` 面對的不是同一個人**：命令不進模型，它是人對工具說的話；工具才是
 * 模型那一側，而且一律 `rootOnly`——目標是人交代的，subagent 沒有人可以交代（見下面
 * `apply` 裡那段，與 dsh 的 `tool-goal` 同一條政策）。
 *
 * **「不註冊工具」那句話在 [#177](https://github.com/DemianLi/nexus-agent/issues/177)
 * 之前是真的**，模型側的三顆正是那張卡交的東西。`index.test.ts` 第一條把它釘成「剛好
 * `create_goal`／`get_goal`／`update_goal` 三顆，而且三顆都是 `rootOnly`」——多一顆、
 * 少一顆、或哪天有人把 `rootOnly` 拿掉，那裡紅。
 *
 * 接線是組裝點的事，一份日誌接一次；接上的那一刻參與者就開始觀察，而觀察會先重播日誌
 * 裡已經有的事件。**命令在接線之前就註冊好了**，所以「還沒接線就打 `/goal`」是走得到
 * 的——那條路回一句說得出原因的錯誤，見 `command.ts` 的 `GOAL_NOT_ATTACHED_MESSAGE`。
 *
 * @param options - 預設輪次上限、時鐘、id 工廠與 block 門檻；省略即真的時鐘與
 *   `randomUUID`。
 * @returns 這一次掛載。
 * @throws {@link GoalError} `defaultMaxGoalRounds` 不是正的安全整數——**在這裡就拋**，
 *   不拖到接線期，見 {@link assertGoalServiceOptions}。
 * @throws `blockedAfterConsecutiveRounds` 不是正的安全整數（`TypeError`）。
 */
export function createGoalPlugin(options: GoalPluginOptions = {}): GoalPlugin {
  assertGoalServiceOptions(options);
  // 同一條理由（設定錯誤要炸在設定的地方），只是這一格歸工具不歸域。
  resolveGoalToolPolicy(options);
  // 插入序的 Map：`attached()` 要回得出「先接的在前」，而 Set／物件都給不了那個保證。
  const services = new Map<SessionLog, GoalService>();
  return {
    name: 'goal',
    apply(registry) {
      // **這一格活在 `apply` 裡，不在 `createGoalPlugin` 裡**，同 `@nexus/plugin-plan-mode`
      // 的 cell：`load.ts` 一次組裝呼叫一次 `apply`，所以放這裡就是一組裝一格。放進工廠
      // 閉包的話，同一個 plugin 物件被兩次組裝共用時兩邊會串台——`serve.ts` 每個 thread
      // 組裝一次，串台就是一個 thread 的 `/goal pause` 暫停到另一個 thread 的目標。
      //
      // 它是陣列不是單一格，因為「剛好一份」是一個**假設**：`attachSession` 是組裝點
      // 自己呼叫的一步，沒有東西攔得住它被呼叫兩次。多了或少了都由命令當場說出來，
      // 見 `command.ts` 的 `goalAmbiguousMessage`。
      const attachedHere: GoalService[] = [];
      // **工具問的是「這次呼叫的那份日誌」，命令問的是「這次組裝的那一份」**，所以除了
      // 上面那個陣列還要一張依日誌查的表。兩者同生同滅，在同一個 `join` 裡進出。
      const servicesHere = new Map<SessionLog, GoalService>();
      registry.sessions.join((subject) => {
        // **只管 root，subagent 那些一份都不接。**
        //
        // [#137](https://github.com/DemianLi/nexus-agent/issues/137) 之後 subagent 有自己
        // 的會話日誌，而參與者是**每一份會話各裝一次**的。不看這一格的話，每一次 spawn
        // 都會多長出一個 `GoalService`，`/goal` 於是從第二次委派開始一律回
        // `goalAmbiguousMessage`——一個沒有人動過 `/goal` 卻壞掉的命令。
        //
        // 而「只管 root」不是為了繞過那件事，**它就是 dsh 對 goal 的政策**：`tool-goal`
        // 的 `hasDirectHumanInput` 第一道是 `ctx.agents.roots().includes(execution.agent)`
        // （`packages/goal/tool-goal/src/authority.ts`）。目標是**人**交代的，subagent
        // 沒有人可以交代。同一條政策的另一半是
        // [#136](https://github.com/DemianLi/nexus-agent/pull/136) 的 `rootOnly`。
        if (subject.address.kind !== 'root') return;
        const service = new GoalService(subject, options);
        services.set(subject.log, service);
        servicesHere.set(subject.log, service);
        attachedHere.push(service);
        return () => {
          services.delete(subject.log);
          servicesHere.delete(subject.log);
          const at = attachedHere.indexOf(service);
          if (at >= 0) attachedHere.splice(at, 1);
        };
      });
      // **三顆工具一律 `rootOnly`。** `fold.ts` 會把每個 subagent 那一份裡的同名項換成
      // 拒絕樁，而**那正是 dsh 對 `tool-goal` 的政策本身**（`authority.ts` 的
      // `ctx.agents.roots().includes(execution.agent)`），不是我們的收窄。目標是人交代
      // 的，subagent 沒有人可以交代。
      for (const goalTool of createGoalTools(
        {
          forCall: (config) => registry.sessions.forCall(config),
          serviceFor: (log) => servicesHere.get(log),
        },
        options,
      )) {
        registry.tools.register(goalTool, { rootOnly: true });
      }
      registry.commands.register({
        name: GOAL_COMMAND_NAME,
        description: GOAL_COMMAND_DESCRIPTION,
        input: { hint: GOAL_COMMAND_HINT },
        handler: ({ rawInput }) => executeGoalCommand(attachedHere, rawInput),
      });
    },
    serviceFor: (log) => services.get(log),
    attached: () => [...services.values()],
  };
}
