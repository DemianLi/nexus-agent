/**
 * `@nexus/projections`：會話投影登記處這個接縫的**定義套件**（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1421](https://github.com/DemianLi/nexus-agent/issues/1421)）。形狀照 {@link https://github.com/DemianLi/nexus-agent/blob/develop/packages/nexus-tools/src/index.ts | `@nexus/tools`}。
 *
 * 一個能力接縫由三個角色組成：
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件：token、介面、契約版本，與投影單元的型別 | `@nexus/sdk`，與 `@nexus/core` 的型別與 `isLogicalTurnStart`（見下） |
 * | 提供者 | 樹上一列，行程級的投影登記處：同一個套件的另一個入口 `@nexus/projections/provider`，由宿主（`apps/harness`）掛一列 | 這個套件、`@nexus/sdk` |
 * | 消費者 | 想登記投影單元的插件，今天是 `token-meter` 與 `trajectory` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * ## 偏離登記：這個定義套件相依 `@nexus/core`（#1421 Q2 (a)）
 *
 * `ProjectionUnit.apply` 的簽名用到 `SessionEvent`，而 `SessionEvent` 與 `isLogicalTurnStart` 活在 `@nexus/core` 的
 * `session-log.ts`。dsh 的對應是 `dsh-session-projection` 相依 `dsh-session`（`SessionEvent` 在 `dsh-session`）；
 * 照那個形狀要抽一個 `@nexus/session` 定義套件，是橫跨整個核心的一刀（Q2 (b)），**這一張不做**。所以：
 *
 * - 四樣東西（`ProjectionUnit`、`SessionEvent`、`isLogicalTurnStart`、`ProjectionDetailError`）**留在 `@nexus/core`，由這個套件單向轉出**。
 *   相依是單向的：這個套件相依 `@nexus/core`，core 不 import 這個套件。插件只 import 這個套件，所以 lint 與決議第 17
 *   條在插件這一側都成立。
 * - **`@nexus/core` 放 `peerDependencies`，`devDependencies` 留 `workspace:*`**（PM 決策 3）：不能讓安裝結果出現第二份
 *   core，理由同 `@nexus/sdk` 放 peer。
 * - 這是第一個相依 core 的定義套件。**撤除條件**：SDK 與定義套件要發布到私有 registry 之前，要先做 Q2 (b)，讓定義套件不再
 *   相依 `@nexus/core`。
 * - 會話日誌的**讀法**（`loggedContentBlocks` 等四個值）不在這裡，由 `@nexus/session` 單向轉出（#1435 Q1 (c)）；`SessionEvent`、
 *   `isLogicalTurnStart` 日後歸 `@nexus/session`，撤除條件一併涵蓋。`ProjectionDetailError` 屬於投影（按需拉細節的錯誤），放這裡名實相符。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）。
 *
 * @module
 */

import type { ProjectionUnit } from '@nexus/core';
import { defineToken } from '@nexus/sdk';

export { isLogicalTurnStart, ProjectionDetailError } from '@nexus/core';
export type { ProjectionUnit, SessionEvent } from '@nexus/core';

/** 契約版本（semver）。介面破壞性改動跳 major，消費者的 `inject` 範圍擋下不相容的提供者。 */
export const PROJECTIONS_CONTRACT_VERSION = '1.0.0';

/** 投影登記處。 */
export interface ProjectionRegistry {
  /**
   * 登記一個投影單元。
   *
   * 登記就是 effect：登記者那一列卸載時登記處自己撤掉，不靠呼叫者記得呼叫回傳的 disposer。
   *
   * **同一個 key、同一個 `stateVersion` 由多列登記時引用計數共用**（照 dsh 的 `SessionProjectionRegistry.register`，
   * `session-projection/src/index.ts:253-292`）；引用計數還沒歸零時一直用第一個登記者的定義。`stateVersion` 不同就拒絕。
   *
   * @param unit - 投影單元；key 與 `stateVersion` 的規則同 `@nexus/core` 的 `normalizeProjectionUnit`。
   * @returns 只撤銷這一次登記的冪等 disposer。
   */
  register(unit: ProjectionUnit): () => void;
  /** 目前登記的全部單元（共用的 key 只算一個），依第一次登記的順序；回傳的是快照。 */
  list(): readonly ProjectionUnit[];
}

/** `projections` 服務的 token。 */
export const projectionsToken = defineToken<ProjectionRegistry>(
  'projections',
  PROJECTIONS_CONTRACT_VERSION,
);
