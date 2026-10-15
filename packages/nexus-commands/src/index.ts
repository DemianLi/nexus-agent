/**
 * `@nexus/commands`：人打的斜線命令這個接縫的**定義套件**（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1456](https://github.com/DemianLi/nexus-agent/issues/1456)，Part of #1385）。形狀照 `@nexus/tools`、`@nexus/projections`。
 *
 * 一個能力接縫由三個角色組成：
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件的主入口：token、介面、契約版本，與命令定義的型別 | `@nexus/sdk`，與 `@nexus/core` 的**型別**（見下） |
 * | 提供者 | 樹上一列，行程級的命令登記處：同一個套件的另一個入口 `@nexus/commands/provider`，由宿主（`apps/harness`）掛一列 | 這個套件、`@nexus/sdk`、`@nexus/core` 的 `normalizeCommandDefinition` |
 * | 消費者 | 想登記命令的插件，今天是 `feedback` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * ## 跟 `@nexus/plugin-commands` 的分工
 *
 * 兩個名字只差一段，管的是同一件事的兩半，不要混：
 *
 * | 套件 | 管什麼 | 誰 import |
 * | --- | --- | --- |
 * | `@nexus/commands`（這裡） | **登記**：有哪些命令、誰登記的、重名怎麼擋。接縫的定義與行程級登記處 | 登記命令的插件、宿主的樹 |
 * | `@nexus/plugin-commands` | **執行**：解析一行輸入、查命令、寫 `command/run`／`command/done`、呼叫 handler | 兩個發派入口（REPL、wire handler） |
 *
 * 執行器只讀每條 thread 的 `registry.commands`（`find`），不經這個接縫；宿主把樹上登記的命令折進那一張 registry
 * （`apps/harness` 的 `registerFolded`），所以執行那一半一行不用改。
 *
 * ## 偏離登記：這個定義套件相依 `@nexus/core` 的型別（照 `@nexus/projections` 的 #1421 Q2 (a)）
 *
 * `CommandDefinition.handler` 的簽名用到 `CommandInvocation`，後者帶著 `SessionLog` 與 `AttachmentRef`——它們都活在
 * `@nexus/core`。dsh 的對應是 `dsh-commands` 相依 `dsh-session`；照那個形狀抽出核心是橫跨整個核心的一刀（#1421 Q2 (b)），
 * 這一張不做。所以命令的型別**留在 `@nexus/core`，由這個套件單向轉出**：
 *
 * - 相依是單向的：這個套件相依 `@nexus/core`，core 不 import 這個套件。插件只 import 這個套件，所以 lint 與決議第 17 條在
 *   插件那一側成立。
 * - **`@nexus/core` 放 `peerDependencies`，`devDependencies` 留 `workspace:*`**（#1421 PM 決策 3）。
 * - **撤除條件**：併入 #1421 Q2 (b)——SDK 與定義套件要發布到私有 registry 之前，型別的實作搬進定義套件。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）：沒有 dsh 的 `ScopedLayers`、
 * `commands/change` 通知與 `definitionId`（`@nexus/core` 的 `CommandRegistrationPoint` 檔頭已登記為什麼不做）。
 *
 * @module
 */

import type { CommandDefinition, CommandDescriptor } from '@nexus/core';
import { defineToken } from '@nexus/sdk';

export type {
  CommandDefinition,
  CommandDescriptor,
  CommandInputDescriptor,
  CommandInvocation,
  CommandResult,
} from '@nexus/core';

/** 契約版本（semver）。介面破壞性改動跳 major，消費者的 `inject` 範圍擋下不相容的提供者。 */
export const COMMANDS_CONTRACT_VERSION = '1.0.0';

/** 命令登記處。 */
export interface CommandRegistry {
  /**
   * 登記一個命令。
   *
   * 登記就是 effect：登記者那一列卸載時登記處自己撤掉，不靠呼叫者記得呼叫回傳的 disposer。
   *
   * - **中繼資料當場驗**：規則同 `@nexus/core` 的 `normalizeCommandDefinition`（名字的形狀、描述非空、handler 是函式、
   *   `input.hint` 非空）。
   * - **同一個名字只收一次**，不論是同一列登記兩次還是兩列各登記一次：後登記的那一列在這裡拋，掛上它的那一列掉在 `apply`
   *   階段（#1456 Q5 (a)；照 dsh 的 `commands`：同一層重名就拋，`packages/interaction/commands/src/index.ts:93-111`）。
   *
   * @param definition - 命令名、描述、可選的輸入提示與 handler。
   * @returns 只撤銷這一次登記的冪等 disposer。
   * @throws 中繼資料不合格，或同一個名字已經由別列登記過。
   */
  register(definition: CommandDefinition): () => void;
  /** 目前登記的命令，**依名字排序**、不帶 handler；回傳的是快照。 */
  list(): readonly CommandDescriptor[];
}

/** `commands` 服務的 token。 */
export const commandsToken = defineToken<CommandRegistry>('commands', COMMANDS_CONTRACT_VERSION);
