/**
 * `@nexus/tools`：工具登記處這個接縫的**定義套件**（決議 §3-4 第 16 條，dsh 的三角色紀律）。
 *
 * 一個能力接縫由三個角色組成：
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件：token、介面、契約版本 | 只有 `@nexus/sdk`（與工具的型別） |
 * | 提供者 | 樹上一列，行程級的工具登記處（#1416 PR 2）：同一個套件的另一個入口 `@nexus/tools/provider`，由宿主（`apps/harness`）掛一列 | 這個套件、`@nexus/sdk` |
 * | 消費者 | 想註冊工具的插件，今天只有 `echo` | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
 *
 * **不相依 `@nexus/core`**（第 17 條）：外部插件只該看見 SDK 與服務定義。工具的型別取自 `@langchain/core`，
 * 只用型別。
 *
 * 介面只放今天有消費者的東西（`packages/AGENTS.md`「Require a current owner and need」）：
 * `@nexus/core` 註冊點的選項裡，`rootOnly` 與 `outputSchema` 在 `ask-user` 遷出時加進來（#1458，契約跳到 `1.1.0`）；
 * `scope` 今天沒有遷出的消費者，不加。
 *
 * @module
 */

import type { StructuredToolInterface } from '@langchain/core/tools';
import { defineToken } from '@nexus/sdk';

/**
 * 契約版本（semver）。介面破壞性改動跳 major，消費者的 `inject` 範圍擋下不相容的提供者。
 *
 * `1.1.0`（#1458）：`register` 多一個選填的第二個參數 {@link ToolRegisterOptions}（`rootOnly`、`outputSchema`）。
 * 加選項是向後相容的新增，所以跳 minor：`^1.0.0` 的舊消費者照常（不帶選項就是原本的樣子）。
 */
export const TOOLS_CONTRACT_VERSION = '1.1.0';

/**
 * 子代理叫到 `rootOnly` 工具時，那一份拒絕樁自己帶的句與碼（#1458 Q3 (a)）。形狀對應 `@nexus/core` 註冊點的
 * `RootOnlyRefusal`，但這個套件不 import core，所以結構型別寫在這裡。
 */
export interface ToolRootOnlyRefusal {
  /** 模型看到的那一句，`Error: ` 之後的部分；**不要自己帶前綴**。 */
  readonly message: string;
  /** 帶進日誌 `tool/result` 的碼。 */
  readonly error?: { readonly name: string; readonly code: string };
}

/**
 * 一個能「驗」的輸出 schema。只要求 `safeParse`——這個套件不相依 `zod`，消費者傳 zod 的 `ZodType` 就吻合。
 */
export interface ToolOutputSchema {
  safeParse(value: unknown): { readonly success: boolean };
}

/** `register` 的選項（#1458 Q3 (a)）。省略整個物件或任何一格都是「不帶」。 */
export interface ToolRegisterOptions {
  /**
   * 這個工具**只在 root agent 上執行**：每個子代理那一份換成一顆說得出原因的拒絕樁。
   * `true` 走預設那句、不帶碼；給 {@link ToolRootOnlyRefusal} 等於 `true` 再加自己的句與碼。
   */
  readonly rootOnly?: boolean | ToolRootOnlyRefusal;
  /**
   * 這個工具**成功**輸出的形狀：每一次成功的結果會被驗，不合就換成一則帶 `INVALID_TOOL_OUTPUT` 的錯誤。
   * 只有回 JSON 字串的工具宣告得了——驗的是 `JSON.parse(content)`。
   */
  readonly outputSchema?: ToolOutputSchema;
}

/** 工具登記處。 */
export interface ToolRegistry {
  /**
   * 註冊一個工具。
   *
   * 註冊就是 effect：註冊者那一列卸載時登記處自己撤掉，不靠呼叫者記得呼叫回傳的 disposer。
   *
   * @param tool - 工具實例，名字取自它的 `name`；同名報錯。
   * @param options - 選填，`rootOnly` 與 `outputSchema`（契約 `1.1.0` 起；`scope` 沒有消費者，不收）。
   * @returns 只撤銷這一次註冊的冪等 disposer。
   */
  register(tool: StructuredToolInterface, options?: ToolRegisterOptions): () => void;
  /** 目前登記的全部工具，依註冊順序；回傳的是快照，之後的註冊不影響它。 */
  list(): readonly StructuredToolInterface[];
}

/** `tools` 服務的 token。 */
export const toolsToken = defineToken<ToolRegistry>('tools', TOOLS_CONTRACT_VERSION);
