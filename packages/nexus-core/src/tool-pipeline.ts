/**
 * 工具事件：`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`
 * （[#1248](https://github.com/DemianLi/nexus-agent/issues/1248)，事件契約草稿的 S1a）。
 *
 * 事件名與時刻照 dsh 的 `packages/core/tools/src/index.ts`（`5badb15009a`，`docs/tool-execution-pipeline.zh.md`）：
 * 允許／拒絕 → 環繞派發 → 接受／替換結果 → 觀察凍結的最終結果。**這個檔案只放契約與生產者**；消費者今天一顆都沒有搬過來
 * （S1b），所以沒有任何監聽者時，每顆工具呼叫的行為與位元組都跟這個檔案不存在時一樣。
 *
 * ## 生產者在洋蔥的三個位置，加圍堵
 *
 * LangChain 的 `wrapToolCall` 是層層相包的，而 dsh 那四個時刻在我們樹上是**四個陣列位置**（由 `fold.ts` 的槽位表決定，
 * 不由註冊順序決定）：
 *
 * | 事件 | 生產者 | 位置 |
 * | --- | --- | --- |
 * | `tools/pre-execute` | {@link createToolPreExecuteMiddleware} | **緊貼核准閘門外側**：plan-mode 這類 `prepend: true` 的 plugin 今天就在閘門外側，派發點放內側會變成「先跳核准卡再被拒」 |
 * | `tools/post-execute` | {@link createToolPostExecuteMiddleware} | 輸出校驗等貼著工具本體的那幾顆外側（dsh 在 post-execute 之前驗輸出）、plugin middleware 內側 |
 * | `tools/execute` | {@link createToolExecuteMiddleware} | 最內層，環繞工具本體 |
 * | `tools/result` | `containment.ts` | 圍堵：只有它同時看得到內層拋出的錯與回來的結果；在記 `tool/result` 之前派發（同 dsh 的 `notifyResult` 先於迴圈的 `appendToolResult`） |
 *
 * **核准閘門沒有搬**（demian 2026-10-09）：`approvalGate` 仍是自己的 middleware，問人的那條 waterfall 還在 `approvals` 註冊點。
 * 所以 `tools/pre-execute` 沒有 `ask`。取消也沒有 `cancel`：那是 `turn-cancel` 的事。
 *
 * ## 契約不帶 LangChain 型別
 *
 * 簽名只用這個檔案自己的形狀（{@link PipelineExecution}、{@link PipelineResult}），LangChain 的 `ToolMessage`／`Command`
 * 與 `wrapToolCall` 的 `request` 只出現在生產者裡。**沒有人替換時，生產者把原物件原樣交回**：`tool-events.ts` 的錯誤碼掛在
 * 以訊息物件為鍵的 `WeakMap` 上，中途複製訊息碼就斷。
 *
 * ## agent 身分（草稿 D4）
 *
 * `exec.agent` 是 {@link SessionAddress}：root 或某個子代理的 `runId`，來源與圍堵相同（`toolCallSessionAddress`）。三顆生產者是
 * root 與每個子代理共用的一份實例，**沒有 `Scoped<Agent>` 過濾**，監聽者自己看 `exec.agent`。認不出來是誰（不在圖裡）時是 `undefined`。
 *
 * ## 與 dsh 的偏離（動工前登記在 #1248，這裡逐條對）
 *
 * 1. **`tools/execute` 換不了 `exec.signal`。** dsh 允許環繞監聽者換訊號。LangChain `ToolNode` 的 `baseHandler` 用 closure 裡的
 *    `config.signal`，不讀 `request.runtime.signal`，所以表達不出來。退到：`exec` 唯讀，`tools/execute` 只能環繞（計時、計量、
 *    短路），不能換訊號。逾時今天由圍堵與工具宣告處理，不受影響。
 * 2. **`Command` 結果表達不出 `replace`。** 帶狀態更新的工具回 `Command`，沒有可替換的 `content`。退到：`tools/post-execute`
 *    只對 `ToolMessage` 結果派發；`Command` 只走 `tools/result`（`kind: 'command'`，不能改）。
 * 3. **拋出來的錯不經過 `tools/post-execute`。** dsh 的工具拋錯一樣會走 post-execute；我們這側「拋錯翻成訊息」是圍堵（最外層）的
 *    事，翻之前的錯到不了內側的 post-execute。退到：拋錯只走 `tools/result`。要補（例如失敗時補上下文）得先把翻譯搬進來，等到有消費者再說。
 * 4. **resume 會讓 `tools/pre-execute` 對同一個 `callId` 跑兩次。** 核准的 `interrupt()` 穿過之後，同一個呼叫以同一個 `callId`
 *    重進（見 `containment.ts`）。dsh 沒有這回事。**`tools/pre-execute` 的監聽者必須冪等。**
 * 5. **`tools/execute` 的 `next()` 只能呼叫一次**（匯流排的 `next` 是共用的一支，見 `events.ts`），所以 dsh 那種「重試包住 next」
 *    表達不出來。短路（不呼叫 `next()`、回自己的結果）可以。
 * 6. **`tools/pre-execute` 沒有 `ask`／`cancel`**：範圍，不是表達不出來。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';
import type { PreToolDecision } from './approval.js';
import type { AgentMiddleware } from './base-types.js';
import type { EventDispatcher, EventListenerInfo } from './events.js';
import { formatOrigin } from './plugin.js';
import { toolCallSessionAddress } from './session-address.js';
import type { SessionAddress } from './session-address.js';
import { markToolError, readToolOutcome, toolErrorOf, toolRefusal } from './tool-events.js';
import type { ToolErrorInfo } from './tool-events.js';

/**
 * 一次工具呼叫，監聽者看到的樣子。唯讀。
 *
 * 跟核准鏈的 `approval.ts` 的 `ToolExecution`是同一個概念的兩個視圖：那個是核准 listener 看的窄版（名字、參數、可選的 id），
 * 這個多了呼叫者身分、`callId` 一律是字串。核准搬上匯流排時兩者合併。
 */
export interface PipelineExecution {
  /** 這次呼叫的 id（模型給的 `tool_call.id`）；取不到是 `''`。 */
  readonly callId: string;
  /** 工具名。 */
  readonly name: string;
  /** 解析後的參數，**唯讀**：模型可見的內容只能走已記錄的通道，監聽者不能改它。 */
  readonly args: unknown;
  /** 誰在呼叫：root 或某個子代理（`runId`）；認不出來（不在圖裡）是 `undefined`。 */
  readonly agent: SessionAddress | undefined;
}

/**
 * 一次呼叫落定成什麼，監聽者看到的樣子。唯讀。
 *
 * - `message`：工具回了一則 `ToolMessage`；`content` 是它的文字。
 * - `command`：工具回了 `Command`（帶狀態更新）或別的非訊息值；**沒有可看的 `content`**，也不能被 `tools/post-execute` 替換
 *   （偏離 2）。`isError` 讀的是 `Command` 裡屬於這次呼叫的那則訊息。
 */
export type PipelineResult =
  | {
      readonly kind: 'message';
      readonly content: string;
      readonly isError: boolean;
      /** 認得出種類的失敗才有（`tool-events.ts` 的碼）。 */
      readonly error?: ToolErrorInfo;
    }
  | {
      readonly kind: 'command';
      readonly isError: boolean;
      readonly error?: ToolErrorInfo;
    };

/**
 * `tools/pre-execute` 的決定。`next()` 回 `allow`。
 *
 * **詞彙就是核准鏈的 {@link PreToolDecision}（`kind` 為鍵）去掉 `ask`**：核准還沒搬上匯流排，`ask` 在這裡沒有人接，所以型別上拿掉；
 * 日後核准搬過來，這個型別放回 `ask` 就是了，不必改形狀。
 */
export type PipelinePreDecision = Exclude<PreToolDecision, { readonly kind: 'ask' }>;

/** `tools/post-execute` 的決定。`next()` 回 `accept`。 */
export type PipelinePostDecision =
  { readonly kind: 'accept' } | { readonly kind: 'replace'; readonly content: string };

declare module './events.js' {
  interface Events {
    /**
     * 派發前允許或拒絕。`next()` 即允許；回 `{ kind: 'deny', reason }` 拒絕，模型收到 `Error: <reason>` 那一則
     * （`toolRefusal`），工具本體與更內層都不跑。**沒有 `ask`／`cancel`**：問人還在 `approvals` 註冊點，取消歸 `turn-cancel`。
     * 位置在核准閘門外側，所以被拒的呼叫不會先跳核准卡。**同一個 `callId` 在核准 resume 之後會再跑一次，監聽者必須冪等。**
     * 沒有 `Scoped<Agent>`：所有 agent 的呼叫都派發，看 `exec.agent` 自己過濾。
     * @param exec - 這次呼叫（名字、解析後的參數、呼叫者）。
     * @param next - 往內一位；最內層回 `allow`。
     * @mode waterfall
     */
    'tools/pre-execute'(
      exec: PipelineExecution,
      next: () => Promise<PipelinePreDecision>,
    ): Promise<PipelinePreDecision>;
    /**
     * 環繞派發：計時、計量、短路。`next()` 跑工具本體並回正規化的結果。`exec` 唯讀，**換不了 `exec.signal`**
     * （LangChain 的 tool handler 不讀它，偏離 1）；`next()` 只能呼叫一次，所以沒有重試（偏離 5）。
     * 不呼叫 `next()` 而回自己的 `message` 結果即短路，工具本體不跑。回 `command` 結果而沒呼叫 `next()` 會拋。
     * @param exec - 通過 `tools/pre-execute` 的這次呼叫。
     * @param next - 往內一位；最內層跑工具並回結果。
     * @mode waterfall
     */
    'tools/execute'(
      exec: PipelineExecution,
      next: () => Promise<PipelineResult>,
    ): Promise<PipelineResult>;
    /**
     * 接受或替換一則工具結果。`next()` 即接受；回 `{ kind: 'replace', content }` 換掉模型收到的文字
     * （`status`、`artifact`、錯誤碼沿用原本的）。**只對 `ToolMessage` 結果派發**：`Command` 不經過這裡（偏離 2），
     * 工具拋的錯也不經過這裡（偏離 3）。
     * @param exec - 剛跑完的這次呼叫。
     * @param result - 工具落定的結果，唯讀。
     * @param next - 往內一位；最內層回 `accept`。
     * @mode waterfall
     */
    'tools/post-execute'(
      exec: PipelineExecution,
      result: Readonly<PipelineResult>,
      next: () => Promise<PipelinePostDecision>,
    ): Promise<PipelinePostDecision>;
    /**
     * 觀察最終結果，凍結、不能改。在記 `tool/result` 之前派發。**監聽者的失敗被隔離**：同步拋錯與 promise 拒絕都只報警告，
     * 其餘監聽者照跑，結果不受影響（`EventDispatcher.observe`）。成功、工具拋的錯、被拒絕的呼叫都會到這裡。
     * @param exec - 這次呼叫，凍結。
     * @param result - 最終回給模型的結果，凍結。
     * @mode emit
     */
    'tools/result'(exec: Readonly<PipelineExecution>, result: Readonly<PipelineResult>): void;
  }
}

/** 三顆生產者與圍堵讀得到的 `wrapToolCall` 請求格子。 */
export interface PipelineRequest {
  readonly toolCall: { readonly id?: string; readonly name: string; readonly args?: unknown };
  readonly runtime?: { readonly configurable?: unknown };
}

/** 由 `wrapToolCall` 的請求造出監聽者看的 {@link PipelineExecution}（凍結）。 */
export function toolExecutionOf(request: PipelineRequest): PipelineExecution {
  return Object.freeze({
    callId: request.toolCall.id ?? '',
    name: request.toolCall.name,
    args: request.toolCall.args,
    agent: toolCallSessionAddress({ configurable: request.runtime?.configurable }),
  });
}

/**
 * 由 handler 回來的值造出監聽者看的 {@link PipelineResult}（凍結）。
 *
 * @param result - `handler(request)` 回來的值（或圍堵翻出來的訊息）。
 * @param callId - 這次呼叫的 id，用來在 `Command` 裡認出屬於它的那則。
 * @returns 凍結的視圖。
 */
export function toolResultView(result: unknown, callId: string): PipelineResult {
  const outcome = readToolOutcome(result, callId);
  const error =
    outcome.isError && outcome.error !== undefined
      ? { error: Object.freeze({ ...outcome.error }) }
      : {};
  if (ToolMessage.isInstance(result)) {
    return Object.freeze({
      kind: 'message',
      content: result.text,
      isError: outcome.isError,
      ...error,
    });
  }
  return Object.freeze({ kind: 'command', isError: outcome.isError, ...error });
}

/** 監聽者回的決定不是詞彙內的值。 */
function badDecision(event: string, value: unknown): TypeError {
  return new TypeError(
    `${event} 的監聽者回了不認得的決定：${JSON.stringify(value) ?? String(value)}`,
  );
}

/** 換掉一則 `ToolMessage` 的文字，其餘（`tool_call_id`、`name`、`status`、`artifact`、`id`、錯誤碼）沿用。 */
function replaceContent(original: ToolMessage, content: string): ToolMessage {
  const replaced = new ToolMessage({
    content,
    tool_call_id: original.tool_call_id,
    ...(original.name !== undefined && { name: original.name }),
    ...(original.status !== undefined && { status: original.status }),
    ...(original.artifact !== undefined && { artifact: original.artifact }),
    ...(original.id !== undefined && { id: original.id }),
  });
  const code = toolErrorOf(original);
  return code === undefined ? replaced : markToolError(replaced, code);
}

/** 把監聽者在 `tools/execute` 短路時回的 `message` 結果造成一則 `ToolMessage`。 */
function materialize(view: PipelineResult, exec: PipelineExecution): ToolMessage {
  if (view.kind !== 'message') {
    throw new TypeError(
      'tools/execute 的監聽者回了 command 結果，但沒有呼叫 next()：Command 造不出來（偏離 2）',
    );
  }
  const message = new ToolMessage({
    content: view.content,
    tool_call_id: exec.callId,
    name: exec.name,
    status: view.isError ? 'error' : 'success',
  });
  return view.error === undefined ? message : markToolError(message, view.error);
}

const ALLOW: PipelinePreDecision = Object.freeze({ kind: 'allow' });
const ACCEPT: PipelinePostDecision = Object.freeze({ kind: 'accept' });

/** middleware 的名字。 */
export const TOOL_PRE_EXECUTE_MIDDLEWARE_NAME = 'nexusToolPreExecute';
/** middleware 的名字。 */
export const TOOL_EXECUTE_MIDDLEWARE_NAME = 'nexusToolExecute';
/** middleware 的名字。 */
export const TOOL_POST_EXECUTE_MIDDLEWARE_NAME = 'nexusToolPostExecute';

/**
 * `tools/pre-execute` 的生產者。**沒有監聽者時直接交給下一層**，連 `exec` 都不造。
 *
 * 拒絕回的是 `toolRefusal(reason, …)`，外面的圍堵像對待任何一則回來的錯誤訊息一樣把它記成 `tool/result`。
 *
 * @param events - 宿主持有的派發面。
 * @returns 可以放進 `middleware` 陣列的 middleware。
 */
export function createToolPreExecuteMiddleware(events: EventDispatcher): AgentMiddleware {
  return createMiddleware({
    name: TOOL_PRE_EXECUTE_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      if (events.count('tools/pre-execute') === 0) return handler(request);
      const exec = toolExecutionOf(request as PipelineRequest);
      const decision = await events.waterfall('tools/pre-execute', exec, () =>
        Promise.resolve(ALLOW),
      );
      if (decision.kind === 'allow') return handler(request);
      if (decision.kind === 'deny' && typeof decision.reason === 'string') {
        return toolRefusal(decision.reason, { callId: exec.callId, name: exec.name });
      }
      throw badDecision('tools/pre-execute', decision);
    },
  }) as AgentMiddleware;
}

/**
 * `tools/execute` 的生產者，環繞工具本體。沒有監聽者時直接交給下一層。
 *
 * **沒有人短路時，回的是 handler 原本回的那個物件**（同一個 `ToolMessage` 或 `Command`），不是重建的。
 *
 * @param events - 宿主持有的派發面。
 * @returns 可以放進 `middleware` 陣列的 middleware。
 */
export function createToolExecuteMiddleware(events: EventDispatcher): AgentMiddleware {
  return createMiddleware({
    name: TOOL_EXECUTE_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      if (events.count('tools/execute') === 0) return handler(request);
      const exec = toolExecutionOf(request as PipelineRequest);
      let raw: unknown;
      let viewOfRaw: PipelineResult | undefined;
      const view = await events.waterfall('tools/execute', exec, async () => {
        raw = await handler(request);
        viewOfRaw = toolResultView(raw, exec.callId);
        return viewOfRaw;
      });
      // 沒人短路（或原樣回了 `next()` 的結果）：把 handler 原本的物件交回去，錯誤碼掛在它身上。
      if (viewOfRaw !== undefined && view === viewOfRaw)
        return raw as Awaited<ReturnType<typeof handler>>;
      return materialize(view, exec);
    },
  }) as AgentMiddleware;
}

/**
 * `tools/post-execute` 的生產者。沒有監聽者、結果是 `Command`、或決定是 `accept`，都回 handler 原本的那個物件。
 *
 * **工具拋的錯不經過這裡**（偏離 3）：它們從 `handler` 往外拋，由外面的圍堵翻成訊息。
 *
 * @param events - 宿主持有的派發面。
 * @returns 可以放進 `middleware` 陣列的 middleware。
 */
export function createToolPostExecuteMiddleware(events: EventDispatcher): AgentMiddleware {
  return createMiddleware({
    name: TOOL_POST_EXECUTE_MIDDLEWARE_NAME,
    wrapToolCall: async (request, handler) => {
      const result = await handler(request);
      if (events.count('tools/post-execute') === 0) return result;
      if (!ToolMessage.isInstance(result)) return result;
      const exec = toolExecutionOf(request as PipelineRequest);
      const view = toolResultView(result, exec.callId);
      const decision = await events.waterfall('tools/post-execute', exec, view, () =>
        Promise.resolve(ACCEPT),
      );
      if (decision.kind === 'accept') return result;
      if (decision.kind === 'replace' && typeof decision.content === 'string') {
        return replaceContent(result, decision.content);
      }
      throw badDecision('tools/post-execute', decision);
    },
  }) as AgentMiddleware;
}

/**
 * 給圍堵用：派發 `tools/result`。**失敗全部隔離**——同步拋錯、promise 拒絕、連造 `exec`／視圖時出的事都不外洩，
 * 因為這一步發生在一次已經有結果的呼叫上，任何失敗都不能把它翻成別的。
 *
 * @param events - 宿主持有的派發面。
 * @param request - `wrapToolCall` 收到的請求。
 * @param result - 最終回給模型的值（成功的、或圍堵翻出來的錯誤訊息）。
 * @param report - 某位監聽者壞了往哪裡講；省略即 `console.warn`。
 */
export function notifyToolResult(
  events: EventDispatcher,
  request: PipelineRequest,
  result: unknown,
  report: (message: string) => void = (message) => console.warn(message),
): void {
  try {
    if (events.count('tools/result') === 0) return;
    const exec = toolExecutionOf(request);
    const view = toolResultView(result, exec.callId);
    events.observe(
      'tools/result',
      (error: unknown, listener: EventListenerInfo) => {
        const who = listener.origin === undefined ? '（來源不明）' : formatOrigin(listener.origin);
        const detail = error instanceof Error ? error.message : String(error);
        report(`tools/result 的監聽者 ${who} 失敗（${exec.name}，${exec.callId}）：${detail}`);
      },
      exec,
      view,
    );
  } catch {
    // 造 `exec`／視圖或派發面自己出事：同樣不能影響結果。
  }
}
