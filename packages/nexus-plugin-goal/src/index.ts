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
 * | `command-goal`（`/goal`） | 下一張 PR，走 `registry.commands` |
 * | `tool-goal`（模型工具） | **被擋住的**，不是取捨——見下面 |
 * | `goal-round-driver`（自動續行） | 可選消費方，dsh 的 README 自己這樣說 |
 *
 * **`tool-goal` 走不了的原因是水管。** 它的權限規則要求「執行時根 agent 的當前輪次中有
 * 一則已接受的 `{ kind: 'user' }` 訊息」，而且要分得出 root 與 subagent 的血緣。我們全樹
 * **零處**讀 `RunnableConfig` / `configurable`——工具執行期不知道是誰在叫它。要做得先補
 * 那條管線，那是另一張卡。
 *
 * **`goal-round-driver` 是 dsh 自己標成可選的**：「goal 是狀態而非調度器——自動續行是
 * 需要你刻意掛載的可選消費方」（`packages/goal/README.zh.md`）。它另外還需要 goal 來源的
 * 使用者輪次，而我們的 `turn/start` 沒有 `source` 判別欄，見 `fold.ts` 檔頭。
 *
 * ## 這個套件不進預設清單
 *
 * `DEFAULT_PLUGINS` 只收它的**配套入口**。域本身在 `/goal` 落地之前沒有任何人打得到的
 * 入口——沒有命令、沒有工具、沒有驅動器，掛上去只是讓每一次執行多接一個觀察者。下一張
 * PR 補上 `/goal` 的時候它才跟著進去，理由與計劃模式那一條同型：**命令沒進預設清單就
 * 等於不存在**。
 *
 * @see [#126](https://github.com/DemianLi/nexus-agent/issues/126)
 * @module
 */

import type { NexusPlugin, SessionLog } from '@nexus/core';

import { assertGoalServiceOptions, GoalService } from './service.js';
import type { GoalServiceOptions } from './service.js';

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
 * 為什麼要多這兩個：一次 `createNexusAgent` 一個 registry，但**不是一份日誌**——CLI 那條
 * 一份，`serve.ts` 那條每個 thread 一份。服務綁的是日誌不是 registry，所以「哪一個服務」
 * 這個問題有指涉對象，而 `registry` 上沒有地方問它。
 *
 * 下一張 PR 的 `/goal` handler 就是靠這裡回答「這一行命令要動哪一個目標」——而那件事
 * 在 `serve.ts` 那條路上還有一個未解的問題（`CommandInvocation` 沒有會話身分），
 * 留給那張卡。
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
 * 它只往 `sessions` 通道掛一位參與者——**不註冊工具、不改 prompt、不碰 backend**。
 * 接線是組裝點的事，一份日誌接一次；接上的那一刻它就開始觀察，而觀察會先重播日誌裡
 * 已經有的事件。
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
      registry.sessions.join((subject) => {
        const service = new GoalService(subject, options);
        services.set(subject.log, service);
        return () => {
          services.delete(subject.log);
        };
      });
    },
    serviceFor: (log) => services.get(log),
    attached: () => [...services.values()],
  };
}
