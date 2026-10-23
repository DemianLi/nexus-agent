/**
 * `@nexus/skills`：技能來源這個接縫的**定義套件**（決議 §3-4 第 16 條，dsh 的三角色紀律；
 * [#1446](https://github.com/DemianLi/nexus-agent/issues/1446)）。形狀照 `@nexus/tools`、`@nexus/projections`。
 *
 * 一個能力接縫由三個角色組成：
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件的主入口：token、介面、契約版本 | `@nexus/sdk`，與 `@nexus/core`（單向轉出，見下） |
 * | 提供者 | 樹上一列，行程級的技能來源登記處：同一個套件的另一個入口 `@nexus/skills/provider`，由宿主（`apps/harness`）掛一列 | 這個套件、`@nexus/sdk`、`@nexus/core` 的 `assertLoadableSkillsPath`（見下） |
 * | 消費者 | 想登記技能來源的插件，今天是 `skills` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * ## 接縫的形狀：路徑（#1446 Q1 (a)）
 *
 * `addSource(path)` 登記一個 backend 命名空間下的目錄路徑，登記是 effect、回傳 disposer。宿主把某一列登記的路徑折回
 * 每條 thread 的 `registry.skills.addSource`，基座的 skills 中介層與模型看到的 prompt 位元組都不變。
 *
 * ## 偏離登記：路徑形狀，不是 dsh 的 `registerProvider(create)`（#1446 Q1 (a)）
 *
 * dsh 的 `SkillRegistry` 收的是**提供者**（`registerProvider(create)`，`create(control)` 交出
 * `{ name, list(options), get(candidate, options) }`，`packages/skill/skill/src/index.ts:247-268`、`:390-424`），技能的掃描與
 * 取回由提供者負責。這裡收的是**路徑**，掃描留給基座的 `createSkillsMiddleware`。
 *
 * - **理由不是「表達不出」。** nexus 已經自己組裝、取代了 `createDeepAgent`，skills 中介層也已經用 `createMiddleware` 包過一層，
 *   照 dsh 的形狀做是做得到的；做了就等於自寫 skills 中介層（掃描、prompt 那段、格式化都不能從基座重用），**模型看到的
 *   prompt 位元組會變**。這張是遷移卡，驗收是行為不變（#1435 的 golden 做法），換成 provider 等於換掉基座中介層，是行為變更。
 * - **撤除條件**：自寫 skills 中介層，或拿掉 deepagents 的時候。到時 provider 形狀升這個契約的 major，消費者的 `inject` 範圍
 *   擋下不相容的提供者，不會靜靜壞掉。
 *
 * ## 偏離登記：技能的掃描與渲染只做單向轉出，實作留在 `@nexus/core`（#1574 Q3 (a)）
 *
 * `@nexus/plugin-skills` 的 `/名字` 叫用（`agent/pre-step` listener）要掃技能、渲染 `<skill_content>`、讀訊息的來源，但插件不能
 * import `@nexus/core`（決議 §3-4 第 17 條；#1420 的 lint）。dsh 的對應是 `tool-skill` 經 `ctx.skills.get` 拿定義、用 `dsh-skill` 的
 * `renderSkillContent` 渲染（`packages/skill/tool-skill/src/index.ts:191-202`，`687f282e`）。實作留在 core（skills 中介層的視圖也用
 * 同一份掃描，兩邊判得一樣），這裡**單向轉出**，形狀同 `@nexus/session` 轉出 `sourceKwargs`：這個套件相依 `@nexus/core`（放
 * `peerDependencies`，`devDependencies` 留 `workspace:*`），core 不 import 它。**撤除條件**同 #1421 Q2 (b)：SDK 與定義套件要發布到
 * 私有 registry 之前，把實作搬進這個套件。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）：下面三個值與型別是 `skills` 的 `/名字` 叫用的。
 *
 * @module
 */

import { defineToken } from '@nexus/sdk';

// `/名字` 叫用要的三個值（#1574）：掃技能（含完不完整）、渲染給模型照做的那一段、認一則訊息是不是人講的話。
export { isHumanSpeech, renderSkillInvocation, scanSkills } from '@nexus/core';
export type { SkillCatalogEntry, SkillCatalogScan } from '@nexus/core';

/** 契約版本（semver）。介面破壞性改動跳 major，消費者的 `inject` 範圍擋下不相容的提供者。 */
export const SKILL_SOURCES_CONTRACT_VERSION = '1.0.0';

/** 技能來源登記處。 */
export interface SkillSourceRegistry {
  /**
   * 登記一個技能來源路徑。
   *
   * 登記就是 effect：登記者那一列卸載時登記處自己撤掉，不靠呼叫者記得呼叫回傳的 disposer。
   *
   * - **路徑格式當場擋**：backend 命名空間下的絕對目錄路徑（結尾斜線合法），規則同 core 的 `assertLoadableSkillsPath`。
   * - **同一個目錄只收一次**（`/skills/` 與 `/skills` 是同一個目錄），不論是同一列登記兩次還是兩列各登記一次：後登記的
   *   那一列在這裡拋，掛上它的那一列掉在 `apply` 階段（照 dsh 的 skills：同一層撞名就拋；dsh 撞的是提供者名字，路徑形狀下鍵就是目錄）。
   *
   * @param path - backend 命名空間下的絕對目錄路徑。
   * @returns 只撤銷這一次登記的冪等 disposer。
   * @throws 路徑格式不對、或同一個目錄已經由別列登記過。
   */
  addSource(path: string): () => void;
  /** 目前登記的全部路徑（原文），依登記順序；回傳的是快照。 */
  sources(): readonly string[];
}

/** `skillSources` 服務的 token。 */
export const skillSourcesToken = defineToken<SkillSourceRegistry>(
  'skillSources',
  SKILL_SOURCES_CONTRACT_VERSION,
);
