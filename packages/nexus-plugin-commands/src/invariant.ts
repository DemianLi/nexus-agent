/**
 * `@nexus/plugin-commands` 的不變量配套入口——**全樹第一個非空的 package 配套入口**。
 *
 * 在這之前，九個 package 配套入口全是 `InvariantInstaller = () => {}`，唯一真的在檢查
 * 東西的是 `@nexus/core` 自己那個（turn 配對）。這裡有真東西可檢，理由很單純：
 * **命令的生命週期是一對跨筆事件，而它們都在 subject 的那份日誌裡。**
 *
 * ## 檢哪三條
 *
 * 前兩條：`command/run` 的 `commandId` 在同一份
 * 日誌裡不得重複、`command/done` 必須配得到前面某一筆 `command/run`。
 *
 * **第三條：序列性。** 一個 `CommandExecutor` 一個 REPL、`execute` 回來之前不會有
 * 第二次，所以「上一個還沒落定就來了下一個」是一個**真的**關係——形狀跟 `@nexus/core` 那條 `turn/start` 撞上還開著的輪一模一樣。
 *
 * 它同時補上了一個盲點：**只檢「done 配得到 run」的話，漏掉一次
 * `command/done` 是查不出來的**（那是懸空的 run，不是懸空的 done）。序列性讓下一次
 * 執行踩到它。
 *
 * `CommandResult` 沒有 `sourceEventSeq` 那一格（見 `@nexus/core` 的
 * `commands.ts`），所以沒有檢它的合法性。
 *
 * ## 沒有檢的那一條，與為什麼
 *
 * 「每一筆 `command/run` 最後都落定」在事件流上檢不出來——最後一筆的落定永遠可能還在
 * 路上。這不是疏漏，是觀察位置決定的：runner 看的是一筆一筆的事件，不是一份收工的
 * 日誌。序列性檢查是它在事件流裡的最強近似。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin, PluginEntry } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const COMMANDS_INVARIANT_PACKAGE = '@nexus/plugin-commands';

/**
 * 命令生命週期的三條關係。
 *
 * trace 放在 closure 裡：一份日誌一次安裝，不需要跨 session 的
 * `WeakMap`（同 `@nexus/core` 的 `sessionInvariant`）。
 */
export const commandsInvariant: InvariantInstaller = (subject, fail) => {
  const seen = new Set<string>();
  let open: string | undefined;

  subject.observe((event) => {
    if (event.type === 'session/end-seed') {
      // seed 結尾沒落定的那一個屬於上一個行程——它等不到自己的 `command/done` 了。不重設
      // 的話，resume 之後的第一個命令必然報「上一個還沒落定」
      // （[#251](https://github.com/DemianLi/nexus-agent/issues/251)）。`seen` 不動：
      // `commandId` 帶每個執行器自己的亂數段，跨行程不會撞。
      open = undefined;
      return;
    }
    if (event.type === 'command/run') {
      const { commandId } = event.data;
      const duplicate = seen.has(commandId);
      const previous = open;
      // `fail` 會拋，所以狀態要在它之前記好：不然違規的這一顆 run 沒進 `seen`，
      // 它的 `command/done` 會被連帶誤報成配不到 run。
      seen.add(commandId);
      open = commandId;
      if (duplicate) {
        fail(
          `command/run（seq ${String(event.seq)}）重複用了 commandId ${JSON.stringify(commandId)}`,
        );
      }
      if (previous !== undefined) {
        fail(
          `command/run（seq ${String(event.seq)}）來的時候 ${JSON.stringify(previous)} 還沒落定` +
            `——命令是一次一個，上一個沒有 command/done 就是漏了一顆`,
        );
      }
      return;
    }
    if (event.type !== 'command/done') return;
    const { commandId } = event.data;
    if (!seen.has(commandId)) {
      fail(
        `command/done（seq ${String(event.seq)}）的 commandId ${JSON.stringify(commandId)} ` +
          `在這份日誌裡配不到任何 command/run`,
      );
    }
    open = undefined;
  });
};

/**
 * 把 `@nexus/plugin-commands` 的配套入口掛上去。
 *
 * **這一個掛了會真的裝上檢查**——與其他九個不同。違規的去處仍然是進入點的事
 * （CLI 走 `onInvariantViolation`），這個檔案只負責註冊。
 *
 * @returns 掛著它的條目，註冊 `@nexus/plugin-commands` 配套入口的 plugin。
 */
export function createCommandsInvariantPlugin(): PluginEntry {
  return { plugin: commandsInvariantPlugin };
}

/**
 * 模組層級的那一顆。不收設定，所以沒有 `Config`；
 * [#454](https://github.com/DemianLi/nexus-agent/issues/454) 從設定檔 import 的就是它。
 */
export const commandsInvariantPlugin: NexusPlugin = {
  name: 'commands-invariant',
  apply(registry) {
    registry.invariants.register(COMMANDS_INVARIANT_PACKAGE, commandsInvariant);
  },
};

export default commandsInvariantPlugin;
