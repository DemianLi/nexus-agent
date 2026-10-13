/**
 * `@nexus/tools`：工具登記處這個接縫的**定義套件**（決議 §3-4 第 16 條，dsh 的三角色紀律）。
 *
 * 一個能力接縫由三個角色組成：
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件：token、介面、契約版本 | 只有 `@nexus/sdk`（與工具的型別） |
 * | 提供者 | 樹上一列，行程級的工具登記處（#1416 PR 2，落在 `apps/harness`） | 這個套件、`@nexus/sdk` |
 * | 消費者 | 想註冊工具的插件，今天只有 `echo` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * **不相依 `@nexus/core`**（第 17 條）：外部插件只該看見 SDK 與服務定義。工具的型別取自 `@langchain/core`，
 * 只用型別。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）：
 * `scope`、`rootOnly`、`outputSchema` 這些 `@nexus/core` 註冊點有的選項，等第一顆需要它們的插件遷出時再加，
 * 契約版本跟著跳。
 *
 * @module
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { defineToken } from '@nexus/sdk';

/** 契約版本（semver）。介面破壞性改動跳 major，消費者的 `inject` 範圍擋下不相容的提供者。 */
export const TOOLS_CONTRACT_VERSION = '1.0.0';

/** 工具登記處。 */
export interface ToolRegistry {
  /**
   * 註冊一個工具。
   *
   * 註冊就是 effect：註冊者那一列卸載時登記處自己撤掉，不靠呼叫者記得呼叫回傳的 disposer。
   *
   * @param tool - 工具實例，名字取自它的 `name`；同名報錯。
   * @returns 只撤銷這一次註冊的冪等 disposer。
   */
  register(tool: StructuredToolInterface): () => void;
  /** 目前登記的全部工具，依註冊順序；回傳的是快照，之後的註冊不影響它。 */
  list(): readonly StructuredToolInterface[];
}

/** `tools` 服務的 token。 */
export const toolsToken = defineToken<ToolRegistry>('tools', TOOLS_CONTRACT_VERSION);
