/**
 * `@nexus/plugin-plan-mode` 的不變量配套入口——**全樹第三個真的在檢查東西的**。
 *
 * 這個檔案要說兩件事，而且兩件都要說，因為它們指的是不同的關係。
 *
 * ## 模式狀態：看得到了，但檢得到的只有形狀
 *
 * 模式從 [#251](https://github.com/DemianLi/nexus-agent/issues/251) 的第二刀起住在日誌上
 * （`plan/mode`，見 `index.ts` 檔頭），所以這份配套入口**看得到它了**——以前它活在 graph
 * state 裡，這一節原本的標題是「檢不到的那一條」。
 *
 * **但看得到的只有形狀，照 dsh 的 plan-mode 配套入口**（`packages/plan/plan-mode/src/invariant.ts`）：
 * `plan/mode` 是整份值的單顆事件，選擇在兩輪之間當場提交（dsh 另有一條輪中排隊、在步邊界提交
 * 的路，我們沒有），**沒有 turn 包圍關係可以檢**，剩下的就是 `active` 必須是布林。
 *
 * 這個 package 最想檢的兩條——「批准之後模式必定關閉」「模式外不會有批准」——**仍然檢不到**，
 * 理由換了：模式在日誌上了，工具執行也在了（`tool/call`／`tool/result`，
 * [#264](https://github.com/DemianLi/nexus-agent/issues/264)），**批准仍然不在**（攔截索引第 4 格
 * 的紀錄差：核准一顆事件都沒有）。一顆 `exit_plan_mode` 的成功結果分不出是人批准了、還是
 * 閘門根本沒問，所以那兩條照舊證在別處，三樣都是 dsh 明說的「型別、載入或
 * 單元測試關注點」：
 *
 * - **模式狀態的讀寫**由 `index.test.ts` 與 `apps/harness/src/plan-mode.test.ts` 驗，
 *   後者跑的是真的 agent 迴圈——獲准之後日誌上多一顆 `plan/mode`、下一步的 prompt 沒有指引。
 * - **工具撞名**歸 `PluginRegistry` 的註冊期擋（同一個 `exit_plan_mode` 註冊兩次當場拋）。
 * - **middleware 的順序**（`prepend` 要排在核准閘門之前）歸 `fold.ts` 與它的測試。
 *
 * ## 檢得到的那一條：`/plan` 的參數契約
 *
 * [#120](https://github.com/DemianLi/nexus-agent/issues/120) 之後這個 package 多了一個
 * **完全活在日誌裡**的關係：`/plan` 只收不帶參數與 `off` 兩種，其餘一律是
 * `{ kind: 'error' }`。`command/run` 已經把 `name` 與 `args` 原樣記下來了，配對的
 * `command/done` 記著 `kind`——**判斷需要的東西一顆都不缺**。
 *
 * **而它只有這個 package 檢得到。** `@nexus/plugin-commands` 的配套入口看的是生命週期
 * 的形狀（id 不重複、done 配得到 run、一次一個），它不知道 `plan` 的文法是什麼；
 * `@nexus/core` 更不知道。文法歸擁有那個命令的人。
 *
 * 它擋的缺陷很具體：`parsePlanCommandArgs` 哪天被改成「不認得就當成進入」，
 * `/plan of` 會安靜地做相反的事——單元測試改一行就跟著綠了，這條在真的跑過的
 * session 上會紅。
 *
 * ## 一個前提要講明
 *
 * 這條規則假設日誌裡那個叫 `plan` 的命令是**我們註冊的那個**。同一份組裝裡這是保證的
 * （`registry.commands.register()` 撞名當場拋），但配套入口與 plugin 本體是分開掛的，
 * 所以「掛了配套入口、沒掛 plugin、別人註冊了自己的 `/plan`」在理論上會誤報。
 * 預設清單兩個都掛（`cli.ts` 的 `DEFAULT_PLUGINS`），這條路只有自訂清單走得到。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin } from '@nexus/core';

import { parsePlanCommandArgs, PLAN_COMMAND_NAME } from './command.js';

/** 這個配套入口認領的 package 名。 */
export const PLAN_MODE_INVARIANT_PACKAGE = '@nexus/plugin-plan-mode';

/**
 * 兩條：`plan/mode` 的形狀，與 `/plan` 的參數契約（**非法的參數必須落定成 `error`**）。
 *
 * trace 放在 closure 裡：一份日誌一次安裝，同 `@nexus/plugin-commands` 的那份。
 * 只記「還開著的那一次」——序列性歸 `@nexus/plugin-commands` 檢，這裡不重複檢。
 */
export const planModeInvariant: InvariantInstaller = (subject, fail) => {
  /** 還沒落定、而且參數不合法的那一次 `/plan`。 */
  let openIllegal: { readonly commandId: string; readonly args: string } | undefined;

  subject.observe((event) => {
    if (event.type === 'plan/mode') {
      // 型別說它是布林，但日誌是從磁碟讀回來的純物件也會進這裡（`--resume` 的 seed），
      // 那一條路上型別什麼都沒保證。照 dsh 那條：只檢得到形狀。
      const { active } = event.data as { active?: unknown };
      if (typeof active !== 'boolean') {
        fail(
          `plan/mode（seq ${String(event.seq)}）帶的 active 是 ${JSON.stringify(active)}` +
            '——只收布林',
        );
      }
      return;
    }
    if (event.type === 'command/run') {
      const { commandId, name, args } = event.data;
      // 每一筆 `command/run` 都重設：序列的執行器裡上一次一定已經落定了，而沒落定
      // 那件事本身歸 `@nexus/plugin-commands` 報。
      openIllegal =
        name === PLAN_COMMAND_NAME && parsePlanCommandArgs(args) === undefined
          ? { commandId, args }
          : undefined;
      return;
    }
    if (event.type !== 'command/done') return;
    if (openIllegal === undefined || openIllegal.commandId !== event.data.commandId) return;
    const illegal = openIllegal;
    openIllegal = undefined;
    if (event.data.kind === 'error') return;
    fail(
      `command/done（seq ${String(event.seq)}）把 /${PLAN_COMMAND_NAME} ` +
        `${JSON.stringify(illegal.args)} 落定成 ${JSON.stringify(event.data.kind)}` +
        `——這個參數收不下，只能落定成 error`,
    );
  });
};

/**
 * 把 `@nexus/plugin-plan-mode` 的配套入口掛上去。
 *
 * **掛了會真的裝上檢查**（`plan/mode` 的形狀與 `/plan` 的參數契約），與空的那些不同。違規的去處
 * 仍然是進入點的事（CLI 走 `onInvariantViolation`），這個檔案只負責註冊。
 *
 * @returns 註冊 `@nexus/plugin-plan-mode` 配套入口的 plugin。
 */
export function createPlanModeInvariantPlugin(): NexusPlugin {
  return {
    name: 'plan-mode-invariant',
    apply(registry) {
      registry.invariants.register(PLAN_MODE_INVARIANT_PACKAGE, planModeInvariant);
    },
  };
}
