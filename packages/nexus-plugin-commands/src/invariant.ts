/**
 * `@nexus/plugin-commands` 的不變量配套入口——**全樹第一個非空的 package 配套入口**。
 *
 * 在這之前，九個 package 配套入口全是 `InvariantInstaller = () => {}`，唯一真的在檢查
 * 東西的是 `@nexus/core` 自己那個（turn 配對）。這裡有真東西可檢，理由很單純：
 * **命令的生命週期是一對跨筆事件，而它們都在 subject 的那份日誌裡。**
 *
 * ## 檢哪三條
 *
 * 前兩條照 dsh 的 `packages/interaction/commands/src/invariant.ts`（對讀版本
 * `cd5ef8148158c3a752a658978873241fdf8e2bbc`）：`command/run` 的 `commandId` 在同一份
 * 日誌裡不得重複、`command/done` 必須配得到前面某一筆 `command/run`。
 *
 * **第三條是我們有而 dsh 沒有的：序列性。** dsh 的註冊表跨 agent（`view(agent)`），
 * 多個 agent 的命令可以並行，所以「上一個還沒落定就來了下一個」在那邊不成立。我們
 * 一個 `CommandExecutor` 一個 REPL、`execute` 回來之前不會有第二次，所以那是一個
 * **真的**關係——形狀跟 `@nexus/core` 那條 `turn/start` 撞上還開著的輪一模一樣。
 *
 * 它同時補上了 dsh 那份檢查的一個盲點：**只檢「done 配得到 run」的話，漏掉一次
 * `command/done` 是查不出來的**（那是懸空的 run，不是懸空的 done）。序列性讓下一次
 * 執行踩到它。
 *
 * dsh 還檢 `sourceEventSeq` 的合法性；我們的 `CommandResult` 沒有那一格（見
 * `@nexus/core` 的 `commands.ts`），所以那一條沒有指涉對象。
 *
 * ## 沒有檢的那一條，與為什麼
 *
 * 「每一筆 `command/run` 最後都落定」在事件流上檢不出來——最後一筆的落定永遠可能還在
 * 路上。這不是疏漏，是觀察位置決定的：runner 看的是一筆一筆的事件，不是一份收工的
 * 日誌。序列性檢查是它在事件流裡的最強近似。
 *
 * @module
 */

import type { InvariantInstaller, NexusPlugin } from '@nexus/core';

/** 這個配套入口認領的 package 名。 */
export const COMMANDS_INVARIANT_PACKAGE = '@nexus/plugin-commands';

/**
 * 命令生命週期的三條關係。
 *
 * trace 放在 closure 裡：一份日誌一次安裝，不需要 dsh 那個
 * `WeakMap<Session, Set<string>>`（同 `@nexus/core` 的 `sessionInvariant`）。
 */
export const commandsInvariant: InvariantInstaller = (subject, fail) => {
  const seen = new Set<string>();
  let open: string | undefined;

  subject.observe((event) => {
    if (event.type === 'command/run') {
      const { commandId } = event.data;
      if (seen.has(commandId)) {
        fail(
          `command/run（seq ${String(event.seq)}）重複用了 commandId ${JSON.stringify(commandId)}`,
        );
      }
      if (open !== undefined) {
        fail(
          `command/run（seq ${String(event.seq)}）來的時候 ${JSON.stringify(open)} 還沒落定` +
            `——命令是一次一個，上一個沒有 command/done 就是漏了一顆`,
        );
      }
      seen.add(commandId);
      open = commandId;
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
 * @returns 註冊 `@nexus/plugin-commands` 配套入口的 plugin。
 */
export function createCommandsInvariantPlugin(): NexusPlugin {
  return {
    name: 'commands-invariant',
    apply(registry) {
      registry.invariants.register(COMMANDS_INVARIANT_PACKAGE, commandsInvariant);
    },
  };
}
