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
 * | `tool-goal`（模型工具） | **還沒做**——擋住它的兩件事已經只剩一件，見下面 |
 * | `goal-round-driver`（自動續行） | 可選消費方，dsh 的 README 自己這樣說 |
 *
 * **`tool-goal` 缺的兩件裡，血緣那一件補好了。** 它的權限規則要求「執行時根 agent 的
 * 當前輪次中有一則已接受的 `{ kind: 'user' }` 訊息」，而且要分得出 root 與 subagent 的
 * 血緣。後面那件現在有路：工具用 `rootOnly` 註冊，fold 會把每個 subagent 那一份裡的
 * 同名項換成拒絕樁（`@nexus/core` 的 `fold.ts`）——而**「拒絕 subagent」正是 dsh 對
 * `tool-goal` 的政策本身**，不是我們的收窄（`packages/goal/tool-goal/src/authority.ts`
 * 的 `ctx.agents.roots().includes(execution.agent)`，描述寫著 “rejects non-human and
 * subagent authority”）。
 *
 * 剩下的是前面那件：「當前輪次有一則已接受的使用者訊息」。那在會話日誌裡讀得到
 * （`turn/start` 的 `kind: 'message'`），是這個套件自己的工作，不是水管的。
 *
 * **`goal-round-driver` 是 dsh 自己標成可選的**：「goal 是狀態而非調度器——自動續行是
 * 需要你刻意掛載的可選消費方」（`packages/goal/README.zh.md`）。它另外還需要 goal 來源的
 * 使用者輪次，而我們的 `turn/start` 沒有 `source` 判別欄，見 `fold.ts` 檔頭。
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

/** 掛 goal 域時換得掉的東西。原樣轉給每一份日誌上的 {@link GoalService}。 */
export type GoalPluginOptions = GoalServiceOptions;

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
 * 它掛兩樣東西：`sessions` 通道的一位參與者，與 `commands` 通道的 `/goal`。**不註冊
 * 工具、不改 prompt、不碰 backend**——命令不進模型，它是人對工具說的話。
 *
 * 接線是組裝點的事，一份日誌接一次；接上的那一刻參與者就開始觀察，而觀察會先重播日誌
 * 裡已經有的事件。**命令在接線之前就註冊好了**，所以「還沒接線就打 `/goal`」是走得到
 * 的——那條路回一句說得出原因的錯誤，見 `command.ts` 的 `GOAL_NOT_ATTACHED_MESSAGE`。
 *
 * @param options - 預設輪次上限、時鐘與 id 工廠；省略即真的時鐘與 `randomUUID`。
 * @returns 這一次掛載。
 * @throws {@link GoalError} `defaultMaxGoalRounds` 不是正的安全整數——**在這裡就拋**，
 *   不拖到接線期，見 {@link assertGoalServiceOptions}。
 */
export function createGoalPlugin(options: GoalPluginOptions = {}): GoalPlugin {
  assertGoalServiceOptions(options);
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
        attachedHere.push(service);
        return () => {
          services.delete(subject.log);
          const at = attachedHere.indexOf(service);
          if (at >= 0) attachedHere.splice(at, 1);
        };
      });
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
