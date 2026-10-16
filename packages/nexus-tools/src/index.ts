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
 *
 * `1.2.0`（#1466）：`ToolRegistry` 多一個選填方法 {@link ToolRegistry.gate}（核准閘門，登記一位 pre-execute listener）。
 * 同樣是向後相容的新增：`^1.0.0`、`^1.1.0` 的舊消費者不呼叫它，照常；要用的消費者宣告 `^1.2.0`。
 */
export const TOOLS_CONTRACT_VERSION = '1.2.0';

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

/**
 * 一次待決的工具呼叫（#1466）。形狀對應 `@nexus/core` 的 `ToolExecution`，但這個套件不 import core，所以結構型別寫在這裡。
 * **刻意不帶 `tool` 實例**：基座在動態註冊時給的是 `undefined`，伸手拿就會炸（理由見 core 的 `approval.ts`）。
 */
export interface ToolGateExecution {
  /** 工具名。執行當下拿到的，不是宣告出來的。 */
  readonly name: string;
  /** 已解析的參數。 */
  readonly args: Record<string, unknown>;
  /** 這一次呼叫的 id。基座偶爾不給，所以可選。 */
  readonly callId: string | undefined;
}

/**
 * 一次 pre-execute 決定（#1466）。**三格封閉，照 dsh**（`packages/core/tools/src/index.ts:589`）：`allow`／`deny`／`ask`。
 * 對應 `@nexus/core` 的 `PreToolDecision`。
 */
export type ToolGateDecision =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'ask'; readonly reason?: string };

/**
 * 一位核准閘門 listener（#1466）。waterfall 依註冊順序跑，**鏈底是 `allow`**；`next()` 委派給下一位，不呼叫就是把後面的人
 * 短路掉（照 dsh 的 waterfall 語義）。
 */
export type ToolGateListener = (
  exec: ToolGateExecution,
  next: () => Promise<ToolGateDecision>,
) => Promise<ToolGateDecision> | ToolGateDecision;

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
  /**
   * 登記一位**核准閘門** listener（契約 `1.2.0` 起，#1466 Q1 (a)）：對一次工具呼叫回 `allow`／`deny`／`ask`。
   *
   * 對應 dsh 的 `ctx.on('tools/pre-execute')`（`packages/core/tools/src/index.ts:1512-1516`，鏈底 `allow`）。**偏離**：樹上沒有
   * 事件匯流排的 token，核准也不搬上匯流排（demian 2026-10-09），所以退到 tools 服務上的一個方法；宿主把這一列登記的
   * listener 折進**每條 thread 自己的** `registry.approvals`，問人仍走 `nexusApprovalGate` 中介層（管道、政策、確定拒絕照舊）。
   *
   * 註冊就是 effect：登記者那一列卸載時自己撤掉。已經折進某條 thread 的那一份不受影響（組 thread 時取快照，決議 §3-2 第 6 條）。
   *
   * **選填**：`1.0.0`／`1.1.0` 的提供者沒有它。消費者宣告 `^1.2.0` 就保證有。
   *
   * @param listener - 這一位 listener。
   * @returns 只撤銷這一次登記的冪等 disposer。
   */
  gate?(listener: ToolGateListener): () => void;
}

/** `tools` 服務的 token。 */
export const toolsToken = defineToken<ToolRegistry>('tools', TOOLS_CONTRACT_VERSION);
