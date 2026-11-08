/**
 * `@nexus/tools`：工具登記處這個接縫的**定義套件**（決議 §3-4 第 16 條，dsh 的三角色紀律）。
 *
 * 一個能力接縫由三個角色組成：
 *
 * | 角色 | 是誰 | 依賴什麼 |
 * | --- | --- | --- |
 * | 定義 | 這個套件：token、介面、契約版本 | 只有 `@nexus/sdk`（與工具的型別） |
 * | 提供者 | 樹上一列，行程級的工具登記處（#1416 PR 2）：同一個套件的另一個入口 `@nexus/tools/provider`，由宿主（`apps/harness`）掛一列 | 這個套件、`@nexus/sdk` |
 * | 消費者 | 想註冊工具的插件 | **只有這個套件**與 `@nexus/sdk`，永不 import 提供者 |
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
 *
 * `1.3.0`（#1469）：`ToolRegistry` 多一個選填方法 {@link ToolRegistry.onResult}（監聽 `tools/result`，工具最終結果落定的觀察者）。
 * 同樣是向後相容的新增：`^1.0.0`～`^1.2.0` 的舊消費者不呼叫它，照常；要用的消費者宣告 `^1.3.0`。
 *
 * `1.4.0`（#1607）：`ToolRegistry` 多一個選填方法 {@link ToolRegistry.concludeTurn}（宣告了 `returnDirect` 的工具在本體裡標「這一輪在這個結局收」）。
 * 同樣是向後相容的新增：`^1.0.0`～`^1.3.0` 的舊消費者不呼叫它，照常；要用的消費者宣告 `^1.4.0`。
 *
 * `2.0.0`（#2351）：`register` 也收 {@link NexusTool}（參數是 JSON Schema、身分與錯誤碼是資料）。
 * LangChain 的工具照收，介面本身只增不減，但主版號跳 major（#1827 D174）：宣告 `^1.x` 的消費者不滿足 `2.0.0`，停在 PENDING，要改宣告 `^2.0.0`
 * （升級指南 `docs/upgrade-guide/v0.6.0/tools-contract-2/guide.md`）。
 *
 * `2.1.0`（#2352）：{@link ToolExec} 多 {@link ToolExec.deferContext} 與 {@link ToolExec.interrupt}。向後相容的新增：`^2.0.0` 的消費者不呼叫它，照常；
 * 要用的消費者宣告 `^2.1.0`。
 *
 * `2.2.0`（#2353）：{@link NexusTool} 多選填的 {@link NexusTool.concludesTurn}。`exec.concludeTurn()` 只對宣告了它的工具有效，
 * 沒宣告的 `NexusTool` 呼叫它什麼都不做（`2.1.0` 也是這樣，那時還沒有地方宣告）。向後相容的新增：不呼叫 `concludeTurn()` 的消費者照常；
 * 要收輪的消費者宣告 `^2.2.0`（升級指南 `docs/upgrade-guide/v0.6.0/nexus-tool-concludes-turn/guide.md`）。
 *
 * `2.3.0`（#2353）：{@link NexusToolResult} 成功那一格多選填的 `artifact`，{@link NexusTool} 多選填的 {@link NexusTool.rawParameters} 與 {@link NexusTool.timeoutMs}。
 * 向後相容的新增：不帶這幾格的消費者照常；要用的消費者宣告 `^2.3.0`（升級指南 `docs/upgrade-guide/v0.6.0/tools-contract-2-3/guide.md`）。
 *
 * `2.4.0`（#2416）：`onResult` 的 listener 看到的 {@link ToolResultExecution} 多 `signal`，{@link ToolResultOutcome} 多 `content` 與 `blocks`。
 * 向後相容的新增：不讀這幾格的消費者照常；要讀的消費者宣告 `^2.4.0`（升級指南 `docs/upgrade-guide/v0.6.0/tools-contract-2-4/guide.md`）。
 *
 * `2.5.0`（#2533）：`ToolRegistry` 多一個選填方法 {@link ToolRegistry.threadSource}（每次組 thread 時叫一次的工具來源，
 * 拿到 {@link ToolThread}，含 {@link ToolThread.admit}）。向後相容的新增：不呼叫它的消費者照常；要用的消費者宣告 `^2.5.0`。
 *
 * `2.6.0`（#2533）：{@link ToolThread} 多 {@link ToolThread.section}，在這條 thread 的系統提示詞登記一段。向後相容的新增：
 * 不呼叫它的來源照常；要用的消費者宣告 `^2.6.0`。
 *
 * `2.6.1`（#2416）：`tools/execute` 的監聽者交回改過的結果、`blocks` 仍是工具本體那則造出的那一份時，內容的形狀照本體回的那則：`content` 沒換就沿用原本的內容，
 * 換了就照原本是字串或陣列給新的文字（陣列裡的非文字塊不留）。修補號：介面不變，只改這種交回怎麼造回訊息。
 *
 * `2.7.0`（#2533）：{@link ToolThread} 多三個選填方法 {@link ToolThread.on}、{@link ToolThread.join}、{@link ToolThread.provide}。向後相容的新增：
 * 不呼叫它們的來源照常；要用的消費者宣告 `^2.7.0`。
 *
 * `2.8.0`（#2551）：{@link ToolThreadSection.text} 的函式收一個 {@link ToolThreadSectionContext}，帶這一次模型呼叫的身分。向後相容的新增：
 * 不帶參數的函式照樣可以指派；要讀它的消費者宣告 `^2.8.0`。
 *
 * `2.9.0`（#2575）：宿主的工具事件契約（`@nexus/core` 的 `tools/execute`、`tools/post-execute`）多四處向後相容的新增：
 * `command` 視圖帶這次呼叫那則的內容、`tools/execute` 能交回只換 `Command` 裡那一則的結果、視圖多 `shape` 標出內容原本是字串還是陣列、
 * 交回的結果可帶 `fresh` 造一則新訊息。輸出校驗、撞到輸出上限的替換、共用區前綴改成 core 監聽者，插件監聽者看得到兩處時刻變化：
 * {@link ToolExecuteListener} 的 `next()` 交回的是驗過輸出的那一份；匯流排上 `tools/post-execute` 監聽者拿到的 `result` 是加共用區前綴之前的那份。
 * {@link ToolResultOutcome} 在結果是 `Command` 時也帶 `Command` 裡這次呼叫那則的內容。這個檔的型別不變（升級指南 `docs/upgrade-guide/v0.6.0/tools-contract-2-9/guide.md`）。
 */
export const TOOLS_CONTRACT_VERSION = '2.9.0';

/** 無損 JSON 值。 */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** 一份 JSON Schema：純資料。根必須是 `type: 'object'`。 */
export type JsonSchema = { readonly [key: string]: JsonValue };

/** 工具結果的內容：一段文字，或內容區塊（形狀同落盤那一則訊息的 `content`）。 */
export type ToolContent = string | readonly { readonly [key: string]: JsonValue }[];

/** 錯誤碼。形狀對應 `@nexus/core` 的 `ToolErrorInfo`；這個套件不 import core，所以結構型別寫在這裡。 */
export interface ToolErrorInfo {
  readonly name: string;
  readonly code: string;
}

/**
 * 一次呼叫交給工具本體的東西（#2351）：身分是資料。
 *
 * 會話與 fs 的查找（`sessionLookup.forCall`、`fs.forCall`）直接收這一份；`@nexus/core` 其他讀呼叫設定的輔助
 * （`isBackgroundCall`、`turnCancelSignalOf`、`toolCallIdOf` 等）不認得它。
 */
export interface ToolExec {
  /** 模型給的 `tool_call.id`；取不到是 `''`。 */
  readonly callId: string;
  /** 這次呼叫在哪一條 thread 裡；認不出來（不在圖裡）是 `undefined`。 */
  readonly threadId: string | undefined;
  /** 誰在呼叫，形狀同 {@link ToolResultExecution.agent}；認不出來是 `undefined`。 */
  readonly agent: ToolResultExecution['agent'];
  /** 這一輪的停止訊號併上 LangGraph 自己的 `signal`，任一個舉起都算；兩個都沒有是 `undefined`。 */
  readonly signal: AbortSignal | undefined;
  /**
   * 標「這一輪在這次呼叫之後收」，規則同 {@link ToolRegistry.concludeTurn}；不帶參數，名字由宿主填這次呼叫的工具。
   * 只對宣告了 {@link NexusTool.concludesTurn} 的工具有效。
   */
  concludeTurn(): void;
  /**
   * 這次呼叫成功的結果之後，補一則插件來源的人話給模型（契約 `2.1.0` 起）。
   * 來源的 `plugin` 是這顆工具的名字；呼叫幾次補幾則，照呼叫順序。結果是 `ok: false` 時不補。
   * 這次呼叫的 `callId` 是 `''`、又補了訊息、結果成功時，宿主拋錯：工具結果造不出來。
   *
   * @param text - 那則人話的內容。
   * @param marks - 掛在那則訊息上的記號（`additional_kwargs`），測試據此認出它；省略是不掛。
   */
  deferContext(text: string, marks?: { readonly [key: string]: JsonValue }): void;
  /**
   * 掛起這次呼叫等人回覆，回的是人給的值（契約 `2.1.0` 起）。**掛起靠拋例外傳播**：不要用 try/catch 攔下它丟出的例外，
   * 真要 catch 就原樣重拋。**恢復時本體從頭重跑一次**，這次呼叫在掛起之前做的事要能重做而不出錯。
   *
   * @param payload - 給答題端的酬載。
   * @returns 人回的值。
   */
  interrupt(payload: JsonValue): Promise<unknown>;
}

/**
 * 一次呼叫的結果（#2351）。失敗是 `ok: false`，碼放在 `error`。
 *
 * 失敗那一格的 `content` 是模型看到的原因，**不要自己帶 `Error: `**：宿主照 `toolRefusal` 加前綴。
 *
 * 成功那一格的 `artifact`（契約 `2.3.0` 起）：跟著這則結果落盤、還原時讀回，**不送給模型**。省略就是沒有，跟帶 `[]` 不同：
 * 帶了，落盤的那則訊息才有這一格。⚠️ 不送模型不等於私密：它跟著 `tool/result` 原樣進本機日誌與遙測。
 */
export type NexusToolResult =
  | { readonly ok: true; readonly content: ToolContent; readonly artifact?: JsonValue }
  | { readonly ok: false; readonly content: string; readonly error?: ToolErrorInfo };

/** 一個工具（#2351）。除了 `execute`，每一格都是可序列化的資料。 */
export interface NexusTool {
  readonly name: string;
  readonly description: string;
  /**
   * 參數的 JSON Schema，input 模式：模型可以送的形狀。沒宣告 {@link rawParameters} 時，寫了 `additionalProperties: false` 的物件多帶鍵就拒，沒寫的收下後丟掉。
   * 用 zod 寫的插件經 `z.toJSONSchema(schema, { io: 'input' })` 轉：`.strict()` 編成 `false`，一般的 `z.object` 不寫。
   * 送上線時，宿主在帶 `properties`、沒寫 `additionalProperties` 的物件補 `false`，所以送上線的不是這一份原樣。
   * 宿主只認一小組關鍵字，認不得的在轉換時就拋；別人寫的 schema（MCP server 公告的）用 {@link rawParameters}。
   */
  readonly parameters: JsonSchema;
  /**
   * {@link parameters} 原樣上線、照 JSON Schema 驗（契約 `2.3.0` 起）：不補 `additionalProperties`，任何關鍵字都收，根物件沒有
   * `properties` 時補一個空的；沒寫 `additionalProperties: false` 的多帶鍵原樣交給 {@link execute}。給 schema 不是自己寫的工具（MCP server
   * 公告的那份）。省略是照上面那一小組關鍵字轉。
   */
  readonly rawParameters?: boolean;
  /**
   * 一次呼叫的預算（毫秒，契約 `2.3.0` 起），不送模型。到期時宿主舉起 `exec.signal`，逾時的措辭講出這個數字；本體要接住
   * `exec.signal` 收手：宿主不等本體，到期就以逾時結果收這次呼叫，沒接住的本體在背景跑完、結果丟掉、副作用照樣發生。
   * 省略是沒有期限。不是正的有限數，轉換時就拋。
   */
  readonly timeoutMs?: number;
  /**
   * 執行。經宿主呼叫時，`args` 已照 {@link parameters} 驗過；沒宣告 {@link rawParameters} 時，收下的未宣告鍵已丟掉，宣告了的原樣交進來。預期中的失敗回 `ok: false`；
   * reject 不會轉成 `ok: false`，照 LangChain 工具拋錯的路往外走。
   *
   * @param args - 模型給的參數。
   * @param exec - 這次呼叫的身分與控制。
   * @returns 這次呼叫的結果。
   */
  execute(args: { readonly [key: string]: JsonValue }, exec: ToolExec): Promise<NexusToolResult>;
  /**
   * 這顆工具可能在本體裡呼叫 `exec.concludeTurn()` 收這一輪（契約 `2.2.0` 起）。省略是不會：那時 `concludeTurn()` 什麼都不做。
   * 宣告了也只有呼叫了才收，其餘結局照常回頭叫模型。
   */
  readonly concludesTurn?: boolean;
}

/**
 * 是不是 {@link NexusTool}：LangChain 的工具沒有 `parameters` 與 `execute`。
 *
 * @param tool - 登記進來的工具。
 * @returns 是 `NexusTool` 就是 `true`。
 */
export function isNexusTool(tool: NexusTool | StructuredToolInterface): tool is NexusTool {
  return 'parameters' in tool && typeof (tool as { execute?: unknown }).execute === 'function';
}

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

/**
 * 一次已落定的工具呼叫，`onResult` 的 listener 看到的樣子（#1469）。形狀對應 `@nexus/core` 的 `PipelineExecution`，但這個套件不
 * import core，所以結構型別寫在這裡。唯讀。
 */
export interface ToolResultExecution {
  /** 這次呼叫的 id（模型給的 `tool_call.id`）；取不到是 `''`。 */
  readonly callId: string;
  /** 工具名。 */
  readonly name: string;
  /** 解析後的參數：深凍結的複本。 */
  readonly args: unknown;
  /** 誰在呼叫：root 或某個子代理（`runId`）；認不出來（不在圖裡）是 `undefined`。 */
  readonly agent:
    { readonly kind: 'root' } | { readonly kind: 'subagent'; readonly runId: string } | undefined;
  /**
   * 這次呼叫在哪一條 thread 裡；認不出來是 `undefined`。一份 listener 只登記一次、服務好幾條 thread 時，**逐條 thread 的暫存要以它
   * 為鍵的一部分**：兩條 thread 可能撞上同一個 `callId`（#1418）。
   */
  readonly thread: string | undefined;
  /** 這次呼叫的中止訊號；沒有是 `undefined`。唯讀，`2.4.0` 起才有。 */
  readonly signal?: AbortSignal | undefined;
}

/** 一次呼叫落定成什麼，`onResult` 的 listener 看到的樣子（#1469）。對應 `@nexus/core` 的 `PipelineResultView`。 */
export interface ToolResultOutcome {
  /** 最終回給模型的結果是不是錯誤。 */
  readonly isError: boolean;
  /**
   * 最終那則訊息的內容區塊，凍結；字串內容視為一格 `text`。`2.4.0` 起才有。結果是 `Command` 時，帶 `Command` 裡屬於這次呼叫那則的內容，
   * 沒有那一則就沒有（`2.9.0` 起）。
   */
  readonly blocks?: readonly Readonly<{ type: string } & Record<string, unknown>>[];
  /** `blocks` 的文字（只串 `text` 區塊）。`2.4.0` 起才有；結果是 `Command` 時同 {@link ToolResultOutcome.blocks}。 */
  readonly content?: string;
}

/**
 * 一位 `tools/result` 觀察者（#1469）。**觀察者的失敗被隔離**：同步拋錯與 promise 拒絕都只報警告，其餘觀察者與那次呼叫的結果不受影響。
 * 在記 `tool/result` **之前**同步派發（`tool/call → listener 寫的事件 → tool/result` 的次序靠這一點）。
 */
export type ToolResultListener = (
  exec: ToolResultExecution,
  result: ToolResultOutcome,
) => void | Promise<void>;

/** 放不放行某個工具名（`2.5.0` 起）。形狀對應 `@nexus/core` 的 `ToolAdmission`。 */
export interface ToolAdmission {
  /**
   * @param name - 工具名。
   * @returns 放行是 `true`。
   */
  admits(name: string): boolean;
}

/** {@link ToolThread.admit} 的選項。 */
export interface ToolAdmitOptions {
  /** 這一格在這條 thread 的工具鏈上的名字，同一條 thread 上不能重複；省略時宿主以列 id 與序號命名。 */
  readonly name?: string;
}

/** {@link ToolRegistry.threadSource} 的選項。 */
export interface ToolThreadSourceOptions {
  /**
   * 這個來源要讀的宿主服務名。{@link ToolThread.services} 只給這裡宣告過、而且宿主授權給這顆插件的；宣告了宿主不授權的，
   * 登記當下就拋。省略是一個都不讀。
   */
  readonly services?: readonly string[];
}

/** {@link ToolThreadSection.text} 的函式收到的這一次模型呼叫（`2.8.0` 起）。 */
export interface ToolThreadSectionContext {
  /**
   * 這一次模型呼叫的身分，原樣交給 `@nexus/session` 的 `sessionLookup.forCall`，認出呼叫者是 root 還是哪一個子代理；段不自己解析它。
   * 同一段會接到這條 thread 的 root 與每個子代理的呼叫上。
   */
  readonly call: unknown;
}

/** {@link ToolThread.section} 登記的一段系統提示詞（`2.6.0` 起）。 */
export interface ToolThreadSection {
  /** 段的名字，同一條 thread 上不能重複。 */
  readonly name: string;
  /** 排序值，只收宿主開放給插件的那幾個（`@nexus/core` 的 `PLUGIN_SECTION_ORDERS`）。 */
  readonly order: number;
  /**
   * 文字，照原文接。給函式就是每次模型呼叫現算，回 `''` 那一次不接；`2.8.0` 起函式收這一次呼叫的 {@link ToolThreadSectionContext}。
   */
  readonly text: string | ((context: ToolThreadSectionContext) => string);
  /** 這一段開頭加的字（這一次不接時也不加）；省略即 `'\n\n'`。 */
  readonly separator?: string;
}

declare const toolExecuteOutcome: unique symbol;

/**
 * {@link ToolExecuteListener} 的 `next()` 交回的結果（`2.7.0` 起）。**不透明**：監聽者只能把 `next()` 交回的那一份原樣交出去，
 * 造不出、也換不了一個結果。
 */
export interface ToolExecuteOutcome {
  readonly [toolExecuteOutcome]: never;
}

/**
 * 一位 `tools/execute` 監聽者（`2.7.0` 起）：包住一次工具呼叫往內交的那一段。`next()` 只能呼叫一次；拋錯等於這次呼叫拋錯。
 *
 * @param exec - 這次呼叫，形狀同 {@link ToolResultExecution}。
 * @param next - 往內一位；最內層跑工具本體。
 * @returns `next()` 交回的那一份。
 */
export type ToolExecuteListener = (
  exec: ToolResultExecution,
  next: () => Promise<ToolExecuteOutcome>,
) => Promise<ToolExecuteOutcome>;

/**
 * 一位會話參與者（`2.7.0` 起）：這條 thread 每開一份會話日誌（root 與每個子代理各一份）就被叫一次。
 *
 * `subject` 是 `@nexus/session` 的 `SessionSubject`；這個套件不相依它，所以留成 `unknown`，由消費者自己轉型（同 {@link ToolThread.services}）。
 *
 * @returns 收拾函式，或什麼都不回。
 */
export type ToolThreadParticipant = (subject: unknown) => (() => void) | void;

/** {@link ToolThread.provide} 收的能力（`2.7.0` 起）。只開放今天有消費者的這一種：這次組裝有工作區。 */
export type ToolThreadCapability = 'workspace';

/**
 * 一條 thread 的組裝，{@link ToolThreadSource} 看到的樣子（`2.5.0` 起）。來源結束（resolve 或 reject）之後再呼叫
 * `register`、`gate`、`admit`、`section`、`on`、`join`、`provide`、`onDispose` 會拋；`services.get`、`shared`、`logger.warn` 不受限。
 *
 * `on`、`join`、`provide` 放在這裡、不放各自的定義套件，是因為它們要登記在**這條 thread 的** registry 上（沙箱模式與核准政策的控制器
 * 每條 thread 一份），樹上的插件只有經這條 thread 的來源碰得到。**撤除條件**：這兩顆控制器改成以會話為參數、由日誌投影提供的行程級服務（#2554）之後，三者改回各自的定義套件。
 */
export interface ToolThread {
  /** 這條 thread 的宿主服務。 */
  readonly services: {
    /**
     * @param name - 服務名。
     * @returns 那個服務；宿主這條 thread 沒有提供它是 `undefined`。
     * @throws {Error} 沒在 {@link ToolThreadSourceOptions.services} 宣告。
     */
    get(name: string): unknown;
  };
  /**
   * 在這條 thread 上登記一個工具，選項同 {@link ToolRegistry.register}。
   *
   * @returns 只撤這一次登記的 disposer。
   */
  register(tool: NexusTool | StructuredToolInterface, options?: ToolRegisterOptions): () => void;
  /**
   * 在這條 thread 上登記一位核准閘門 listener，語意同 {@link ToolRegistry.gate}。
   *
   * @returns 只撤這一次登記的 disposer。
   */
  gate(listener: ToolGateListener): () => void;
  /**
   * 決定這條 thread 每一次模型呼叫看得到哪些工具：不放行的從模型那一側的清單拿掉，呼叫那一側照常。每次模型呼叫都問一次，
   * 所以 `admits` 可以隨時間改答案。一個名字都沒拿掉時，請求原樣往內交。
   *
   * @returns 只撤這一格的 disposer。
   */
  admit(admission: ToolAdmission, options?: ToolAdmitOptions): () => void;
  /**
   * 在這條 thread 的系統提示詞中段登記一段（`2.6.0` 起）。
   *
   * @returns 只撤這一段的 disposer；這條 thread 組好之後才撤，已經組進去的那一段照接。
   * @throws 段的形狀不對（`TypeError`）、`order` 不是開放給插件的值（`RangeError`），或同一條 thread 上已有同名的段。
   */
  section(section: ToolThreadSection): () => void;
  /**
   * 在這條 thread 上登記一位 `tools/execute` 監聽者（`2.7.0` 起）。排在這一列在清單上的位置，落在宿主固定的兩段 core 監聽者之間；
   * 不開放 `prepend`。
   *
   * **選填**：`2.5.0`、`2.6.x` 的宿主沒有它。消費者宣告 `^2.7.0` 就保證有。
   *
   * @returns 只撤這一位的冪等 disposer；這一列在組裝中掉了，宿主一併撤；這條 thread 收掉時也清掉。
   */
  on?(event: 'tools/execute', listener: ToolExecuteListener): () => void;
  /**
   * 在這條 thread 上掛一位會話參與者（`2.7.0` 起）。多位參與者依清單上的列序安裝，這一列的排在這一列的位置。
   *
   * **選填**：同 {@link ToolThread.on}。
   *
   * @returns 只撤這一位的冪等 disposer。這條 thread 接上會話之後才撤，已接上的會話（含之後在那裡開的子代理會話）照樣裝這一位；
   *   這一列在組裝中掉了，宿主一併撤。
   */
  join?(participant: ToolThreadParticipant): () => void;
  /**
   * 宣告這次組裝提供某個能力（`2.7.0` 起）。重複宣告冪等。
   *
   * **選填**：同 {@link ToolThread.on}。
   *
   * @returns 只撤這一次宣告的冪等 disposer。這條 thread 組好之後才撤，這次組裝有沒有工作區不跟著改；這一列在組裝中掉了，宿主一併撤。
   */
  provide?(capability: ToolThreadCapability): () => void;
  /** 這條 thread 收掉時要做的事，照登記的反序跑。這一列有任何來源失敗時，它所有來源已登記的會當場跑。 */
  onDispose(dispose: () => void | Promise<void>): void;
  /** 這條 thread 的警告，記在這一列名下；thread 收掉之前任何時候都能叫。 */
  readonly logger: { warn(message: string): void };
  /**
   * 這條 thread 上，**同一顆插件**的每一列拿到同一個物件；別的插件、別的 thread 拿到的是別的。給同一顆插件跨列的協調用
   * （例如同名的偵測），不要放跨 thread 的東西。
   */
  readonly shared: object;
}

/**
 * 每次組 thread 時叫一次的工具來源（`2.5.0` 起）。reject 等於這一列在那次組裝裡失敗：已登記的撤掉、這一列所有來源已登記的
 * `onDispose` 照跑，結果跟那一列掛在相容層、`apply` 拋錯時相同。
 */
export type ToolThreadSource = (thread: ToolThread) => void | Promise<void>;

/** 工具登記處。 */
export interface ToolRegistry {
  /**
   * 註冊一個工具。
   *
   * 註冊就是 effect：註冊者那一列卸載時登記處自己撤掉，不靠呼叫者記得呼叫回傳的 disposer。
   *
   * @param tool - 工具，名字取自它的 `name`；同名報錯。{@link NexusTool} 從契約 `2.0.0` 起收。
   * @param options - 選填，`rootOnly` 與 `outputSchema`（契約 `1.1.0` 起；`scope` 沒有消費者，不收）。
   * @returns 只撤銷這一次註冊的冪等 disposer。
   */
  register(tool: NexusTool | StructuredToolInterface, options?: ToolRegisterOptions): () => void;
  /** 目前登記的全部工具，依註冊順序；回傳的是快照，之後的註冊不影響它。 */
  list(): readonly (NexusTool | StructuredToolInterface)[];
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
  /**
   * 登記一位 **`tools/result` 觀察者**（契約 `1.3.0` 起，#1469 Q1 (a)）：每一次工具呼叫的最終結果落定時（成功、工具拋的錯、被拒絕的都算）
   * 被叫，在記 `tool/result` 之前。
   *
   * 對應 dsh 的 `ctx.on('tools/result')`（`packages/deliverables/tool-present/src/index.ts:100-108`）。**偏離**：樹上沒有事件匯流排的
   * token，退到 tools 服務上的一個方法（理由同 {@link ToolRegistry.gate}）；宿主把這一列登記的 listener 折進**每條 thread 自己的**
   * `registry.events.on('tools/result', l)`，所以派發的時機與次序不變，而且 listener 跟工具一起被快照——登記者那一列之後被停用或重載，
   * 開著的 thread 手上的工具與 listener 仍然成對可用。
   *
   * **listener 服務好幾條 thread**：看到的每一次呼叫都帶 `thread` 與 `agent`，逐條 thread 的暫存要以它們為鍵。
   *
   * 註冊就是 effect：登記者那一列卸載時自己撤掉。已經折進某條 thread 的那一份不受影響（組 thread 時取快照，決議 §3-2 第 6 條）。
   *
   * **選填**：`1.0.0`～`1.2.0` 的提供者沒有它。消費者宣告 `^1.3.0` 就保證有。
   *
   * @param listener - 這一位觀察者。
   * @returns 只撤銷這一次登記的冪等 disposer。
   */
  onResult?(listener: ToolResultListener): () => void;
  /**
   * 標「這一輪在這個工具呼叫之後收」（契約 `1.4.0` 起，#1607）：宣告了 `returnDirect: true` 的工具（`NexusTool` 宣告的是 `concludesTurn: true`，轉接器轉成同一格），在**本體執行當中**、
   * 走到要收的那個結局時呼叫它。對應 dsh 的 `exec.concludeTurn()`（`packages/core/tools/src/index.ts:1862` 的 `concludingExecutions`，
   * 由 plan-mode 在 `ASK_CANCELLED` 呼叫，`plan-mode/src/index.ts:331-341`）。
   *
   * **`returnDirect` 的語意因此改了**：基座把 `returnDirect: true` 當成「這顆工具的每一種結局都收這一輪」；宿主現在改成**標了才收**。
   * 宣告了 `returnDirect` 卻不呼叫這個方法的工具，這一輪**不再**在它之後結束（升級指南 `returndirect-conclude-turn`）。
   *
   * 要收，同時要成立：
   * - 在該工具本體執行當中呼叫，且 `toolName` 是正在執行的那顆（別顆的名字、槽外呼叫都什麼都不做）；
   * - 那個工具宣告了 `returnDirect: true`（`NexusTool` 宣告的是 `concludesTurn: true`，轉接器轉成同一格）；
   * - 最終結果不是錯誤（錯誤不收，dsh 的 `ToolExecutionFailure` 寫的是 `concludesTurn?: never`）；
   * - 同一則 AI 訊息叫的工具只有這一個（**偏離**，下）。
   *
   * **偏離（理由 1：基座表達不出來）**：dsh 的 `concludeTurn()` 在**每次呼叫各自的 exec 物件**上，基座的工具沒有；所以退到 tools 服務上
   * 的一個方法，以工具名認人。另外，dsh 是批內任何一個工具標了就收，基座把批裡每個呼叫各自送成一個 `Send`、tools 路由各判各的，
   * 混批會擲 `InvalidUpdateError`，所以批裡不只一個呼叫時標了也照常繼續叫模型。
   *
   * 這個方法由**宿主**注入（定義套件不相依 `@nexus/core`）；沒注入的提供者呼叫它什麼都不做。
   *
   * **選填**：`1.0.0`～`1.3.0` 的提供者沒有它。消費者宣告 `^1.4.0` 就保證有。
   *
   * @param toolName - 正在執行的這顆工具的名字。
   */
  concludeTurn?(toolName: string): void;
  /**
   * 登記一個**每次組 thread 時叫一次**的工具來源（契約 `2.5.0` 起，#2533）。給工具清單要在組裝當下才知道、或要讀這條 thread 的宿主
   * 服務才組得出來的插件（預定的消費者是 `@nexus/plugin-mcp`，#2533：每次組裝連線，憑證與連線池是這條 thread 的服務）。
   *
   * 宿主在這一列折進那條 thread 的位置 await 它，所以它登記的東西排在清單上這一列的位置。登記之前已經組好的 thread 不受影響；
   * 登記者那一列卸載時登記處自己撤掉，已經折進某條 thread 的那一份留到那條 thread 收掉。
   *
   * **選填**：`2.0.0`～`2.4.0` 的提供者沒有它。消費者宣告 `^2.5.0` 就保證有。
   *
   * @param source - 這個來源。
   * @param options - 要讀的宿主服務。
   * @returns 只撤銷這一次登記的冪等 disposer。
   * @throws {Error} 宣告了宿主不授權給這顆插件的服務。
   */
  threadSource?(source: ToolThreadSource, options?: ToolThreadSourceOptions): () => void;
}

/** `tools` 服務的 token。 */
export const toolsToken = defineToken<ToolRegistry>('tools', TOOLS_CONTRACT_VERSION);
