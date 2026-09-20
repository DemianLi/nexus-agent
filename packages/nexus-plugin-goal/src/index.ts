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
 * 落地時發現**排程器不可能是一個 plugin**——`PluginRegistry` 十六條通道沒有一條排得出
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

import type { NexusPlugin, PluginEntry, PluginRegistry, SessionLog } from '@nexus/core';
import { z } from 'zod';

import {
  executeGoalCommand,
  GOAL_COMMAND_DESCRIPTION,
  GOAL_COMMAND_HINT,
  GOAL_COMMAND_NAME,
} from './command.js';
import { assertGoalServiceOptions, DEFAULT_MAX_GOAL_ROUNDS, GoalService } from './service.js';
import type { GoalServiceOptions } from './service.js';
import {
  createGoalTools,
  DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS,
  GOAL_TOOL_OUTPUT_SCHEMA,
} from './tools.js';

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
 * 這個 plugin 的設定，**純資料**。
 *
 * 形狀照 dsh 的 `GoalService.Config`（`packages/goal/goal/src/index.ts:243-245`，`ddefc45`）：
 * 它只有 `defaultMaxGoalRounds` 一格，時鐘與 id 一律直接 `Date.now()` / `randomUUID()`
 * （`:310-312`）——**標準的設定裡沒有測試縫**。我們多一格
 * `blockedAfterConsecutiveRounds`，那是 dsh 拆在 `tool-goal` 那個套件的設定；兩個套件合成
 * 一顆是登記過的形狀差異（見檔頭），設定跟著合。
 *
 * **正整數那條不寫在 schema 裡**，照 dsh 留在域裡拋（{@link assertGoalServiceOptions} 與
 * {@link resolveGoalToolPolicy}）。寫進 schema 換來的是一顆 zod 錯誤，而
 * `GOAL_INVALID_MAX_ROUNDS` 這個碼會沒有生產者。
 */
export const goalConfigSchema = z.strictObject({
  /** create 沒指定上限時用它。見 {@link DEFAULT_MAX_GOAL_ROUNDS}。 */
  defaultMaxGoalRounds: z.number().default(DEFAULT_MAX_GOAL_ROUNDS),
  /** 三顆工具自己的政策。見 {@link DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS}。 */
  blockedAfterConsecutiveRounds: z.number().default(DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS),
});

/** 驗過的設定。 */
export type GoalConfig = z.infer<typeof goalConfigSchema>;

/**
 * **這一次組裝**的時鐘與 id 工廠。
 *
 * 它們不是部署協作者，是**測試縫**——時間戳與 id 都進耐久快照，而折疊對 `updatedAt`
 * 有規則（不得早於前一次），換不掉就驗不了那些規則。所以它們**不進 Config**（Config 是
 * #454 要從 YAML 餵的資料，函式在那裡表達不出來）也**不進服務命名空間**（服務是
 * 部署期的協作者，見 [#459](https://github.com/DemianLi/nexus-agent/issues/459) 的決議 5）。
 * 它們走 {@link createGoalPlugin} 的閉包，而那條路只有測試在走。
 */
export interface GoalSeams {
  /** 現在幾點。省略即 `Date.now`。 */
  readonly now?: () => number;
  /** 新目標的 id 怎麼來。省略即 `goal-<randomUUID()>`。 */
  readonly newGoalId?: () => string;
}

/**
 * {@link createGoalPlugin} 收的東西：設定的輸入面，加上兩道測試縫。
 */
export type GoalPluginOptions = z.input<typeof goalConfigSchema> & GoalSeams;

/** 服務名。`registry.services` 上這個字串就是 goal 域的位址。 */
export const GOALS_SERVICE = 'goals';

/**
 * `goals` 服務：**這一次組裝**接上的每一份日誌，與它們各自的域。
 *
 * **為什麼是查表而不是一顆 `GoalService`**：`provide` 跑在 `apply` 當下，而
 * `GoalService` 要到 `attachSession` 才出生——那是載入**之後**的事。所以放進註冊點的
 * 只能是一個晚綁的把手。
 *
 * dsh 的 `ctx.goals` 也是一份服務對很多個會話，只是它把那層鍵藏在裡面（`runtimeStates`
 * 是一張 `WeakMap<Session, …>`，每個方法收 `agent`）；我們把同一層鍵攤成
 * {@link serviceFor}。**同樣的資訊，不同的表面**，不是新的偏離。
 */
export interface GoalServices {
  /**
   * 某一份日誌上的域。
   * @param log - 已經接過線的日誌。
   * @returns 那一份的服務，沒接過就是 `undefined`。
   */
  serviceFor(log: SessionLog): GoalService | undefined;
  /**
   * 這一次組裝目前接著的每一份，**依接線順序**。
   * @returns 服務清單；一份都沒接時是空的。
   */
  attached(): readonly GoalService[];
}

declare module '@nexus/core' {
  interface NexusServices {
    goals: GoalServices;
  }
}

/**
 * 一次掛載。**每一次組裝各跑一遍，狀態全在這個函式的閉包裡**——模組層級一格都沒有。
 *
 * 那一格以前在 `createGoalPlugin` 的閉包裡，而 `apps/harness` 為了問它，在模組層級留了
 * 一顆 plugin 物件的 handle（[#459](https://github.com/DemianLi/nexus-agent/issues/459)
 * 拆掉的就是這個）。同一個 process 裡兩次組裝共用一份查表，症狀是一條 thread 的
 * `/goal pause` 暫停到另一條 thread 的目標。
 *
 * @param registry - 這一次組裝的註冊表。
 * @param config - 驗過的設定。
 * @param seams - 時鐘與 id 工廠；產品路徑上是空的。
 * @throws {@link GoalError} `defaultMaxGoalRounds` 不是正的安全整數。
 * @throws `blockedAfterConsecutiveRounds` 不是正的安全整數（`TypeError`）。
 */
function applyGoal(registry: PluginRegistry, config: GoalConfig, seams: GoalSeams): void {
  // **設定錯誤炸在載入當下**，不拖到接線期：`sessions` 接線的圍堵會把一顆 `GoalError`
  // 吞成一行 warn（那道圍堵是對的——一個參與者壞掉不該扳倒 agent loop），而使用者得到的
  // 是一個安靜地沒有目標域的 agent。dsh 同樣驗在 constructor 裡，不在 Config schema 裡。
  const serviceOptions: GoalServiceOptions = {
    defaultMaxGoalRounds: config.defaultMaxGoalRounds,
    ...seams,
  };
  assertGoalServiceOptions(serviceOptions);
  // **工具政策那一格不在這裡驗**：`createGoalTools` 自己第一行就 `resolveGoalToolPolicy`，
  // 在這裡再叫一次是一道量不出來的重複——拿掉它整套測試照樣綠（實測，突變 7）。兩者的
  // 差別只有「在 `sessions.join` 之前還是之後拋」，而載入失敗本來就會把已登記的撤掉。
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
    const service = new GoalService(subject, serviceOptions);
    servicesHere.set(subject.log, service);
    attachedHere.push(service);
    return () => {
      servicesHere.delete(subject.log);
      const at = attachedHere.indexOf(service);
      if (at >= 0) attachedHere.splice(at, 1);
    };
  });
  // **消費者是組裝點，不是別的 plugin**：`agent-factory` 在 `loadPlugins` 回來之後讀它，
  // 交給續行排程器（`apps/harness` 的 `goalDriverPort`）。所以這一條的清單位置不承重
  // ——與第一刀那三個「在自己的 `apply` 當下就讀」的正好相反。
  registry.services.provide(GOALS_SERVICE, {
    serviceFor: (log) => servicesHere.get(log),
    attached: () => [...attachedHere],
  });
  // **三顆工具一律 `rootOnly`。** `fold.ts` 會把每個 subagent 那一份裡的同名項換成
  // 拒絕樁，而**那正是 dsh 對 `tool-goal` 的政策本身**（`authority.ts` 的
  // `ctx.agents.roots().includes(execution.agent)`），不是我們的收窄。目標是人交代
  // 的，subagent 沒有人可以交代。
  for (const goalTool of createGoalTools(
    {
      forCall: (callConfig) => registry.sessions.forCall(callConfig),
      serviceFor: (log) => servicesHere.get(log),
    },
    config,
  )) {
    // 輸出 schema 隨註冊帶，同 dsh `defineTool` 的 `output`（#252）。
    registry.tools.register(goalTool, {
      rootOnly: true,
      outputSchema: GOAL_TOOL_OUTPUT_SCHEMA,
    });
  }
  registry.commands.register({
    name: GOAL_COMMAND_NAME,
    description: GOAL_COMMAND_DESCRIPTION,
    input: { hint: GOAL_COMMAND_HINT },
    handler: ({ rawInput }) => executeGoalCommand(attachedHere, rawInput),
  });
}

/**
 * goal 域的 plugin。
 *
 * 它掛四樣東西：`sessions` 通道的一位參與者、`tools` 通道的三顆工具、`commands`
 * 通道的 `/goal`，與 `services` 通道的 {@link GOALS_SERVICE}。**不改 prompt、不碰 backend。**
 *
 * **那三顆與 `/goal` 面對的不是同一個人**：命令不進模型，它是人對工具說的話；工具才是
 * 模型那一側，而且一律 `rootOnly`——目標是人交代的，subagent 沒有人可以交代（見
 * {@link applyGoal} 裡那段，與 dsh 的 `tool-goal` 同一條政策）。
 *
 * 接線是組裝點的事，一份日誌接一次；接上的那一刻參與者就開始觀察，而觀察會先重播日誌
 * 裡已經有的事件。**命令在接線之前就註冊好了**，所以「還沒接線就打 `/goal`」是走得到
 * 的——那條路回一句說得出原因的錯誤，見 `command.ts` 的 `GOAL_NOT_ATTACHED_MESSAGE`。
 *
 * **模組層級的一顆常數**，給 [#454](https://github.com/DemianLi/nexus-agent/issues/454)
 * 從設定檔 import。**這一顆就是 `DEFAULT_PLUGINS` 裡的那一顆**（`createGoalPlugin()`
 * 不帶測試縫時回的是它本身，`index.test.ts` 釘著這條）。
 */
export const goalPlugin: NexusPlugin<GoalConfig> = {
  name: 'goal',
  Config: goalConfigSchema,
  apply: (registry, config) => applyGoal(registry, config, {}),
};

export default goalPlugin;

/**
 * 建一個條目。
 *
 * **不帶測試縫時回的就是 {@link goalPlugin} 本身**——產品路徑與預設清單走的是同一顆
 * 物件，所以釘「兩次組裝不共用」的那條測試量得到的是交付物，不是相似品。帶了縫才另外
 * 包一顆，兩條路的 `apply` 是同一個函式。
 *
 * 設定不在這裡驗，驗在載入的時候——那時候才有 id 可以指名（同其餘每一顆，#453）。
 *
 * @param options - 設定，形狀見 {@link goalConfigSchema}；外加 {@link GoalSeams} 兩道縫。
 * @returns 可以放進組裝點清單的條目。
 */
export function createGoalPlugin(options: GoalPluginOptions = {}): PluginEntry {
  const { now, newGoalId, ...config } = options;
  if (now === undefined && newGoalId === undefined) return { plugin: goalPlugin, config };
  const seams: GoalSeams = {
    ...(now === undefined ? {} : { now }),
    ...(newGoalId === undefined ? {} : { newGoalId }),
  };
  return {
    plugin: {
      name: 'goal',
      Config: goalConfigSchema,
      apply: (registry, resolved) => applyGoal(registry, resolved, seams),
    } satisfies NexusPlugin<GoalConfig>,
    config,
  };
}
