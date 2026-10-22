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
 * 落地時發現**排程器不可能是一個 plugin**——`PluginRegistry` 十九條通道沒有一條排得出
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
 * 入口」。`/goal` 落地了，那個理由就沒了：這一列現在同時掛域與命令，
 * 兩件事一起進出貨清單（`apps/harness/cordis.yml`）。位置跟在計劃模式後面、所有配套入口前面——啟動時印的
 * `plugin：` 那一行按清單順序走，域與配套入口混在一起會讓那行讀不出誰是誰。
 *
 * **域與命令不拆成兩個 plugin。** dsh 拆（`dsh-goal` 與 `dsh-command-goal` 是兩個套件），
 * 因為它的組裝清單逐套件掛載，「掛域不掛命令」是 ACP 那種自動化應用真的要的組裝。我們
 * 的清單掛的是工廠函式，拆開換不到任何一種表達不出來的組裝，只多一個「掛了域卻沒掛
 * 命令」的無聲失敗態。**這是形狀差異不是偏離**，同 `command.ts` 檔頭寫的那一條。
 *
 * ## 遷上 Cordis 樹（[#1486](https://github.com/DemianLi/nexus-agent/issues/1486)，Part of #1385）
 *
 * 函式插件，具名匯出 `name`／`inject`／`Config`／`manifest`／`apply`，**沒有 default**；`src/` 除了從 lint 排除的 `invariant.ts` 都不 import
 * `@nexus/core`（套 #1420 的 lint 設定）。這是第一個**插件提供、宿主消費、而且狀態是逐份日誌**的服務：
 *
 * - **`goals` 由這一列提供**（`@nexus/goal` 的 token，契約 `1.1.0`，`onActivationChanged` 從 1.1.0 起）：`new` 一個繼承 `ContractService` 的類別，宿主組 thread 時把它折進
 *   `registry.services`（同 #1456 的 `feedback`）。
 * - **逐份日誌的 `GoalService` 改成 lazy**：不再靠 `registry.sessions.join` 在接上日誌時建，而是第一次被問到某份 root 日誌時才建，
 *   存在 `apply` 閉包裡的 `WeakMap<SessionLog, GoalService>`。三個入口——工具（`sessionLookup.forCall` 回的 root 日誌）、`/goal`（命令執行器交的
 *   `sessionLog`）、宿主（`goals.serviceFor(log)`）——都出自**同一次 `apply`** 的閉包，所以一份日誌只有一個服務；列重載之後，開著的 thread 手上三樣
 *   還是舊閉包的（組 thread 時在同一個臨界區取的快照），新閉包只會被新 thread 問到。訂閱與閉包**不掛在列的 effect 上**，列卸載不會撤掉開著的
 *   thread 的狀態（決議 §3-2 第 6 條）。建立時**不碰 `ctx`**。
 * - **`goals.attached()` 沒了**：`WeakMap` 列舉不了，而服務折進每條 thread 之後各條 thread 也不該看見彼此的服務。
 * - **行為改變（只在產品路徑走不到的那幾條上，Q2）**：`/goal` 的「接了幾份」（`goalAmbiguousMessage`）與兩句「沒接上」（`GOAL_NOT_ATTACHED_MESSAGE`、
 *   root 那條的 `GOAL_TOOL_NO_SERVICE_MESSAGE`）拿掉了——lazy 之後服務一定建得出來，產品上一次組裝也只有一份 root。**工具層非 root 的那一句還在**
 *   （`GOAL_TOOL_NOT_ROOT_MESSAGE`，文字沿用原句）：直接帶子代理的 `checkpoint_ns` 呼叫真工具今天就走得到。
 *
 * 要的三個服務都由宿主在樹上提供：`tools`（`^1.1.0`，三顆工具一律 `rootOnly` 並帶 `outputSchema`）、`commands`（`^1.1.0`）、
 * `sessionLookup`（`^1.0.0`）。**舊的 `NexusPlugin` 外殼搬走了**（`apps/harness/src/goal.fixture.ts` 給 harness 的測試，這個套件自己的測試用 `goal-shell.test.helper.ts`，同 todo、feedback 的前例）：它與樹上這一列共用
 * 同一份 lazy 核心（{@link createGoalCore}），只有「這次呼叫的會話怎麼來」那一格不同。
 *
 * **`src/invariant.ts` 不在這條路上**：配套入口還是相容層的列（`goal-invariant`），它 import `@nexus/core` 並寫 `NexusPlugin`。它從 SDK lint 排除
 * （偏離，登記在 `docs/plugin-contract.md`；撤除條件是 2026-11-03 配套入口重審）。
 *
 * @see [#126](https://github.com/DemianLi/nexus-agent/issues/126)
 * @module
 */

import type { Context } from '@nexus/cordis';
import { commandsToken } from '@nexus/commands';
import type { CommandDefinition } from '@nexus/commands';
import { DEFAULT_MAX_GOAL_ROUNDS, goalsToken } from '@nexus/goal';
import type { GoalActivationChange, GoalActivationListener, GoalServices } from '@nexus/goal';
import { ContractService, defineManifest, injectOf, need, service } from '@nexus/sdk';
import { sessionLookupToken } from '@nexus/session';
import type { SessionLog } from '@nexus/session';
import { toolsToken } from '@nexus/tools';
import { z } from 'zod';

import {
  executeGoalCommand,
  GOAL_COMMAND_DESCRIPTION,
  GOAL_COMMAND_HINT,
  GOAL_COMMAND_NAME,
  GOAL_RUN_WHILE_BUSY,
} from './command.js';
import { assertGoalServiceOptions, GoalService } from './service.js';
import type { GoalServiceOptions } from './service.js';
import {
  createGoalTools,
  DEFAULT_BLOCKED_AFTER_CONSECUTIVE_ROUNDS,
  GOAL_TOOL_OUTPUT_SCHEMA,
} from './tools.js';
import type { GoalToolLookup } from './tools.js';

export type { GoalCommand } from './command.js';
export {
  commandHint,
  executeGoalCommand,
  GOAL_ATTACHMENTS_ONLY_MESSAGE,
  GOAL_ATTACHMENTS_TEXT,
  GOAL_CLEARED_MESSAGE,
  GOAL_COMMAND_DESCRIPTION,
  GOAL_COMMAND_HINT,
  GOAL_COMMAND_NAME,
  GOAL_INVALID_EDIT_MESSAGE,
  GOAL_NONE_MESSAGE,
  GOAL_NOTHING_TO_CLEAR_MESSAGE,
  GOAL_REJECTED_MESSAGE,
  GOAL_RUN_WHILE_BUSY,
  GOAL_USAGE,
  goalAlreadyMessage,
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
  GOAL_TOOL_NOT_ATTACHED_MESSAGE,
  GOAL_TOOL_NOT_ROOT_MESSAGE,
  GOAL_TOOL_REASON_MISPLACED_MESSAGE,
  GOAL_TOOL_REASON_REQUIRED_MESSAGE,
  GOAL_TOOL_REPLACEMENT_MISPLACED_MESSAGE,
  GOAL_TOOL_UNKNOWN_CALLER_MESSAGE,
  GOAL_UPDATE_TOOL_NAME,
  GOAL_WRAPUP_MARKER,
  goalToolAmbiguousMessage,
  goalToolValue,
} from './tools.js';

export type { GoalToolAuthority } from './authority.js';
export { completionAuthority, hasDirectHumanTurn, isMatchingGoalRound } from './authority.js';

export { renderWrapupContext } from './wrapup.js';

export type {
  CreateGoalRequest,
  EditGoalRequest,
  GoalErrorCode,
  GoalServiceOptions,
} from './service.js';
export { assertGoalServiceOptions, GoalError, GoalService } from './service.js';

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
 * **這一次掛載**的時鐘與 id 工廠。
 *
 * 它們不是部署協作者，是**測試縫**——時間戳與 id 都進耐久快照，而折疊對 `updatedAt`
 * 有規則（不得早於前一次），換不掉就驗不了那些規則。所以它們**不進 Config**（Config 是
 * #454 要從 YAML 餵的資料，函式在那裡表達不出來）。它們走 {@link createGoalCore} /
 * {@link createGoalApply} 的參數，而那條路只有測試在走。
 */
export interface GoalSeams {
  /** 現在幾點。省略即 `Date.now`。 */
  readonly now?: () => number;
  /** 新目標的 id 怎麼來。省略即 `goal-<randomUUID()>`。 */
  readonly newGoalId?: () => string;
}

/** {@link createGoalCore} 回的東西：逐份日誌的查找。 */
export interface GoalCore {
  /** 這份 root 日誌上的域，沒有就建（lazy）。契約：只收 root 日誌。 */
  serviceFor(log: SessionLog): GoalService;
  /** 已經建好的；沒被問過是 `undefined`，不建、不重播。 */
  existingFor(log: SessionLog): GoalService | undefined;
  /** 訂續行授權的變化（N0376）。**不建服務**：監聽登記在日誌上，服務之後才建也照樣通知。見 {@link GoalServices.onActivationChanged}。 */
  onActivationChanged(log: SessionLog, listener: GoalActivationListener): () => void;
}

/**
 * 逐份日誌的 lazy 核心：`WeakMap<SessionLog, GoalService>` 與建服務的那一步。**樹上那一列與相容層的測試外殼共用這一份**。
 *
 * **狀態全在這個函式的閉包裡**——模組層級一格都沒有。同一個 process 裡兩次掛載各有各的 `WeakMap`，症狀是一條 thread 的 `/goal pause` 暫停到另一條
 * thread 的目標，那條路由 {@link #459} 拆掉之後不能回來。
 *
 * **建立時不碰 `ctx`、訂閱不掛 effect**：列卸載之後開著的 thread 仍會來問（它手上的三個入口是組 thread 時取的快照）。
 *
 * @param config - 驗過的設定。
 * @param seams - 時鐘與 id 工廠；產品路徑上是空的。
 * @returns 兩個查找方法。
 * @throws {@link GoalError} `defaultMaxGoalRounds` 不是正的安全整數。
 */
export function createGoalCore(config: GoalConfig, seams: GoalSeams = {}): GoalCore {
  // **設定錯誤炸在載入當下**，不拖到第一次被問：lazy 之後沒有接線期可以炸，拖到第一次 `/goal` 才拋會讓使用者得到一個看起來載入成功、
  // 打了命令才壞的 agent。dsh 同樣驗在 constructor 裡，不在 Config schema 裡。
  const serviceOptions: GoalServiceOptions = {
    defaultMaxGoalRounds: config.defaultMaxGoalRounds,
    ...seams,
  };
  assertGoalServiceOptions(serviceOptions);
  const services = new WeakMap<SessionLog, GoalService>();
  // 授權變化的監聽，逐份日誌、逐次掛載（跟 `services` 同一個閉包）：列重載之後開著的 thread 掛在它組裝時拿到的那一份核心上，
  // 新閉包只給新 thread，各掛各的。監聽不經 `serviceFor`——訂閱不該觸發 lazy 重播（#1486），而沒建過服務的日誌授權本來就是 disarmed。
  const listeners = new WeakMap<SessionLog, Set<GoalActivationListener>>();
  const notify = (log: SessionLog, change: GoalActivationChange): void => {
    for (const listener of [...(listeners.get(log) ?? [])]) {
      try {
        listener(change);
      } catch {
        // 一個監聽壞了不該扳倒日誌的 append（服務是在日誌的觀察者裡呼叫這裡的），也不該餓死後面的監聽。
      }
    }
  };
  return {
    serviceFor(log) {
      let existing = services.get(log);
      if (existing === undefined) {
        // 建構子同步地「讀 `log.events` 重播 → `log.subscribe`」，見 `service.ts`。
        existing = new GoalService(log, {
          ...serviceOptions,
          onActivationChanged: (change) => notify(log, change),
        });
        services.set(log, existing);
      }
      return existing;
    },
    existingFor: (log) => services.get(log),
    onActivationChanged(log, listener) {
      let set = listeners.get(log);
      if (set === undefined) {
        set = new Set();
        listeners.set(log, set);
      }
      set.add(listener);
      return () => void set.delete(listener);
    },
  };
}

/** 插件在樹上的列用的名字（`ctx.fiber.runtime.name`，錯誤訊息、log 與相容層清單用）。 */
export const name = 'goal';

/**
 * 要的服務：`tools`（`^1.1.0`，`rootOnly` 與 `outputSchema` 從 `1.1.0` 起）、`commands`（`^1.1.0`，`runWhileBusy` 從 `1.1.0` 起）與 `sessionLookup`（`^1.0.0`）。範圍在這裡宣告，
 * 落進 Cordis 的 `Context.intercept`，提供者的 `check` 讀得到。
 */
export const inject = injectOf(
  need(toolsToken, '^1.1.0'),
  need(commandsToken, '^1.1.0'),
  need(sessionLookupToken, '^1.0.0'),
);

/** 這個插件的設定（manifest 的 `config`）：見 {@link goalConfigSchema}。`strictObject`：未知欄位讓載入失敗。 */
export const Config = goalConfigSchema;

export const manifest = defineManifest({
  id: 'goal',
  version: '0.1.0',
  owner: '平台團隊',
  provides: [{ token: goalsToken.name, version: goalsToken.version }],
  consumes: [
    { token: toolsToken.name, range: '^1.1.0' },
    { token: commandsToken.name, range: '^1.1.0' },
    { token: sessionLookupToken.name, range: '^1.0.0' },
  ],
  config: Config,
  // 換程式碼要重啟行程；設定一改，下一條 thread 看到新的上限與政策，開著的不動（#1405、決議 §3-2 第 6 條）。
  reload: { code: 'restart', config: 'next-thread' },
  capabilities: [],
});

/**
 * `goals` 服務的實作：把 {@link createGoalCore} 掛成一個契約服務。
 *
 * 兩個方法是**自己的屬性、閉包住核心**，不是原型上的方法，也不用 `#私有欄位`：宿主取到的是 traceable proxy，方法在 proxy 的 shadow 上執行，
 * 私有欄位在那個 receiver 上會拋。方法體一律不碰 `this.ctx`（見檔頭）。`serviceFor` 回的 `GoalService` 是閉包裡的原物件，不帶 tracker，
 * 原樣交出，實例相同。
 */
class GoalServicesProvider extends ContractService<GoalServices> implements GoalServices {
  readonly serviceFor: GoalServices['serviceFor'];
  readonly existingFor: GoalServices['existingFor'];
  readonly onActivationChanged: GoalServices['onActivationChanged'];

  constructor(ctx: Context, core: GoalCore) {
    super(ctx, goalsToken);
    this.serviceFor = (log) => core.serviceFor(log);
    this.existingFor = (log) => core.existingFor(log);
    this.onActivationChanged = (log, listener) => core.onActivationChanged(log, listener);
  }
}

/** {@link mountGoal} 要宿主給的東西：登記工具、登記命令，與「這次呼叫屬於哪份日誌」。 */
export interface GoalMountHost {
  /** 登記一顆工具；三顆一律帶 `{ rootOnly: true, outputSchema }`。 */
  registerTool(
    tool: ReturnType<typeof createGoalTools>[number],
    options: { readonly rootOnly: true; readonly outputSchema: typeof GOAL_TOOL_OUTPUT_SCHEMA },
  ): void;
  /** 登記 `/goal`。 */
  registerCommand(definition: CommandDefinition): void;
  /** 這次工具呼叫屬於哪一份日誌；呼叫當下才問，整份呼叫設定原樣傳。 */
  forCall(config: unknown): GoalToolLookup;
}

/**
 * 把三顆工具與 `/goal` 掛上去。**樹上那一列（{@link createGoalApply}）與相容層的測試外殼（`apps/harness/src/goal.fixture.ts`）共用這一份**：
 * 兩邊唯一不同的是「這次呼叫的會話怎麼來」（`host.forCall`），所以工具本體、命令 handler 與 lazy 核心只有一個出處。
 *
 * @param host - 登記處與會話查找。
 * @param core - {@link createGoalCore} 的結果。
 * @param config - 驗過的設定。
 */
export function mountGoal(host: GoalMountHost, core: GoalCore, config: GoalConfig): void {
  // **三顆工具一律 `rootOnly`。** `fold.ts` 會把每個 subagent 那一份裡的同名項換成拒絕樁，而**那正是 dsh 對 `tool-goal` 的政策本身**
  // （`authority.ts` 的 `ctx.agents.roots().includes(execution.agent)`），不是我們的收窄。目標是人交代的，subagent 沒有人可以交代。
  for (const goalTool of createGoalTools(
    {
      forCall: (callConfig) => host.forCall(callConfig),
      serviceFor: (log) => core.serviceFor(log),
    },
    config,
  )) {
    // 輸出 schema 隨註冊帶，同 dsh `defineTool` 的 `output`（#252）。
    host.registerTool(goalTool, { rootOnly: true, outputSchema: GOAL_TOOL_OUTPUT_SCHEMA });
  }
  host.registerCommand({
    name: GOAL_COMMAND_NAME,
    description: GOAL_COMMAND_DESCRIPTION,
    // 收附件（#732）：隨目標走，見 `GOAL_COMMAND_HINT` 的說明。
    input: { hint: GOAL_COMMAND_HINT, attachments: true },
    // 忙的時候只放行 `/goal pause`（#1516）：人下的暫停要能在一輪跑著時送進去，而且送進去就當場停掉那一輪。
    // 其餘子命令照舊只在兩輪之間——`create`／`edit` 帶附件會 steer 起一輪，`resume`／`clear` 沒有理由跟飛行中的輪賽跑。
    runWhileBusy: GOAL_RUN_WHILE_BUSY,
    // 命令要動哪一份日誌由執行器交過來（`CommandInvocation.sessionLog`，#688，契約上是 root）。
    handler: ({ rawInput, sessionLog, attachments, steer, openTurn }) =>
      executeGoalCommand(core.serviceFor(sessionLog), rawInput, attachments, steer, openTurn),
  });
}

/**
 * 造一個帶測試縫的 `apply`。產品路徑上的 {@link apply} 就是 `createGoalApply()`。
 *
 * @param seams - 時鐘與 id 工廠。
 * @returns 可以放進函式插件模組的 `apply`。
 */
export function createGoalApply(seams: GoalSeams = {}): (ctx: Context, config: GoalConfig) => void {
  return (ctx, config) => {
    const core = createGoalCore(config, seams);
    // 用 `new` 不用 `ctx.plugin(Class)`：不開子 fiber，歸屬就是這一列。建構子 `provide` 是 effect，列卸載時服務跟著撤。
    new GoalServicesProvider(ctx, core);
    // 三個服務在這裡抓進閉包：列卸載之後經 `ctx` 取服務會拋，抓住的那份仍可呼叫。**呼叫當下才 `forCall`**。
    const sessions = service(ctx, sessionLookupToken);
    const tools = service(ctx, toolsToken);
    const commands = service(ctx, commandsToken);
    mountGoal(
      {
        registerTool: (goalTool, options) => void tools.register(goalTool, options),
        registerCommand: (definition) => void commands.register(definition),
        forCall: (callConfig) => sessions.forCall(callConfig),
      },
      core,
      config,
    );
  };
}

/** 掛上：見 {@link createGoalApply}。 */
export const apply = createGoalApply();
