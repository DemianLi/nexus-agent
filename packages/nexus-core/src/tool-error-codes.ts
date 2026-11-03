/**
 * 工具結果的錯誤碼、錯誤資訊（{@link ToolErrorInfo}）與錯誤結果的欄位（{@link errorResultFields}），不依賴任何訊息型別：
 * 從日誌推模型歷史的那一側（`conversation-replay.ts`）與日誌型別（`session-log.ts`）要用它們，不能經 `tool-events.ts` 拉進 LangChain。
 * `tool-events.ts` 全數轉匯出；碼怎麼從內層走到外層見那裡的檔頭。
 *
 * @module
 */

/**
 * 帶穩定分類碼的錯誤基底，照 dsh 的 `HarnessError`（`packages/llm/llm/src/error.ts:13-22`，`477b4f4`）：
 * `code` 給程式分流用，跟給人讀的 `message` 分開；`name` 預設是子類別的建構子名。
 *
 * **工具拋它的時候碼會進會話日誌**：圍堵的 `classifyThrownToolError` 把它記成 `{ name, code }`，
 * 同 dsh 執行管線的 `errorInfo`。其餘的拋錯沒有碼。
 */
export class HarnessError extends Error {
  /** 穩定的機器可讀分類碼。分流看這一格，不要解析 `message`。 */
  readonly code: string;

  /**
   * @param message - 給人讀的訊息。
   * @param code - 分類碼。
   * @param options - 標準的 `ErrorOptions`（`cause`）。
   */
  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
  }
}

/** 一次失敗的結果是哪一種。照 dsh 的 `ToolErrorInfo`：`name` 是錯誤類別名，`code` 是分類碼。 */
export interface ToolErrorInfo {
  readonly name: string;
  readonly code: string;
}

/** 工具等太久。dsh `guard/timeout-policy` 的 `TOOL_TIMEOUT`。 */
export const TOOL_TIMEOUT = 'TOOL_TIMEOUT';
/**
 * 這一輪被中止，取消了這次呼叫：**本體已經開始**，落定之後結果被換掉。dsh `packages/core/tools` 的
 * `TOOL_ABORTED`，字串是 `ABORTED`（`packages/core/tools/src/index.ts:462`）。
 */
export const TOOL_ABORTED = 'ABORTED';
/**
 * 這一輪被中止，取消了這次呼叫：**本體從沒開始**。dsh 同檔 `:465` 的 `TOOL_ABORTED_BEFORE_DISPATCH`。
 * 生產者見 `turn-cancel.ts`，與停在核准點被收回的那幾顆（`apps/harness` 的 pump）。
 */
export const TOOL_ABORTED_BEFORE_DISPATCH = 'ABORTED_BEFORE_DISPATCH';
/**
 * 參數不合工具宣告的 schema。dsh `ToolArgsError` 的碼。
 *
 * **兩個生產者、同一個碼**，同 dsh：圍堵認出的 schema 不合（`containment.ts`），與 JSON 都不合格的那顆
 * （`invalid-tool-args.ts`）。下游分不開是照抄，沒有讀者要分。
 */
export const INVALID_ARGS = 'INVALID_ARGS';
/** 模型叫了一個不存在的工具。dsh `ToolNotFoundError` 的碼。 */
export const UNKNOWN_TOOL = 'UNKNOWN_TOOL';
/** 成功的輸出不合它宣告的 schema。dsh `ToolOutputError` 的碼。 */
export const INVALID_TOOL_OUTPUT = 'INVALID_TOOL_OUTPUT';
/**
 * 行程結束時記過 `tool/call`、結果沒記下來。dsh `packages/core/session/src/repair.ts:18` 的
 * `TOOL_OUTCOME_UNKNOWN`。生產者是推模型歷史的一側，見 {@link ./conversation-replay.ts}。
 */
export const TOOL_OUTCOME_UNKNOWN = 'TOOL_OUTCOME_UNKNOWN';
/** 回覆裡要了、行程結束前還沒記到 `tool/call`。dsh 同檔 `:15` 的 `TOOL_NOT_STARTED`。 */
export const TOOL_NOT_STARTED = 'TOOL_NOT_STARTED';

/**
 * 核准被拒的五個碼（[#1029](https://github.com/DemianLi/nexus-agent/issues/1029)）。**這五個是我們多出來的，dsh 沒有**：
 * dsh 的核准拒絕（`packages/core/tools/src/index.ts:1744-1766`，`5badb15`）只回一則 `Error: <reason>`，不帶 `error.info`；
 * 它分「人拒」與「政策拒」靠 `approval/policy` 事件。**登記的偏離**：依據是 demian 在 #1018 Q2（2026-10-04）拍板的
 * 「拒絕帶原因碼」——這是產品要求，不是 dsh 的做法（#1029 卡上說 dsh 的拒絕帶 `error{name,code,reason}`，那是讀錯：
 * dsh 的核准拒絕結果沒有這一格）。載體是 dsh `PreToolDecision` 的 `deny.info?: ToolErrorInfo`
 * （「structured error identity」，dsh 自己沒用在核准上）：槽是 dsh 的，填法是我們的，所以不是新機制。
 * `approval/policy` 事件（#437）記政策的值（`ask`／`never`）；日誌上 `approval/decided` 的 `rejected` 分不出人拒與政策拒，要看這些碼。
 *
 * - {@link APPROVAL_REJECTED_BY_USER}：有人看過並按了拒絕。
 * - {@link APPROVAL_POLICY_NEVER}：確定性拒絕，沒有人被問到。兩種原因共用這個碼：入口沒有人在（`approvals.enabled: false`，CLI／評測），
 *   或使用者把核准政策選成不問（`never`，#437）；兩種的話不同，分辨看 `tool/result.message`。
 * - {@link APPROVAL_NO_CHANNEL}：沒有可用的核准管道（沒有 checkpointer），沒有人被問到。
 * - {@link APPROVAL_INVALID_REPLY}：問了人，但收到的回覆不是 `approve` 也不是 `reject`（[#2027](https://github.com/DemianLi/nexus-agent/issues/2027)），
 *   沒有拿到有效的決定，照拒絕處理。稽核上的結局是 `unavailable`。
 * - {@link TOOL_DENIED_BY_LISTENER}：某位 pre-execute listener 直接回了 `deny`（沒有問人）。哪一位看 `tool/result.message`。
 */
export const APPROVAL_REJECTED_BY_USER = 'APPROVAL_REJECTED_BY_USER';
export const APPROVAL_POLICY_NEVER = 'APPROVAL_POLICY_NEVER';
export const APPROVAL_NO_CHANNEL = 'APPROVAL_NO_CHANNEL';
export const APPROVAL_INVALID_REPLY = 'APPROVAL_INVALID_REPLY';
export const TOOL_DENIED_BY_LISTENER = 'TOOL_DENIED_BY_LISTENER';

/** 核准拒絕的 {@link ToolErrorInfo}：四個核准的碼共用 `ApprovalDenied` 這個名字（`name` 是錯誤類別名，不是分類）。 */
export function approvalDenied(
  code:
    | typeof APPROVAL_REJECTED_BY_USER
    | typeof APPROVAL_POLICY_NEVER
    | typeof APPROVAL_NO_CHANNEL
    | typeof APPROVAL_INVALID_REPLY,
): ToolErrorInfo {
  return { name: 'ApprovalDenied', code };
}

/**
 * 一則錯誤結果（`status: 'error'`）的欄位，交給 `ToolMessage` 建構子或直接當 nexus 訊息的 `data`。**錯誤結果只在這裡建**：
 * 請求端的 `toolRefusal`／`toolFeedback`（`tool-events.ts`）與推導端補的那兩句（`conversation-replay.ts` 的 `closer`）共用，
 * 前綴（`Error: `）加不加由呼叫端決定，碼不在欄位裡。
 */
export function errorResultFields(
  content: string,
  options: { readonly callId: string; readonly name: string },
) {
  return { content, tool_call_id: options.callId, name: options.name, status: 'error' as const };
}
