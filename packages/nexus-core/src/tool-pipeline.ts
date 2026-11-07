/**
 * 工具事件：`tools/pre-execute`、`tools/execute`、`tools/post-execute`、`tools/result`
 * （[#1248](https://github.com/DemianLi/nexus-agent/issues/1248)，事件契約草稿的 S1a）。
 *
 * 事件名與時刻照 dsh 的 `packages/core/tools/src/index.ts`（`5badb15009a`，`docs/tool-execution-pipeline.zh.md`）：
 * 允許／拒絕 → 環繞派發 → 接受／替換結果 → 觀察凍結的最終結果。**這個檔案只放契約與生產者**；消費者目前只有一顆：
 * `@nexus/plugin-present` 的交付寫入掛在 `tools/result`（[#1286](https://github.com/DemianLi/nexus-agent/issues/1286)，S1c）。
 * 其餘三個事件沒有監聽者，所以沒有任何監聽者時，每顆工具呼叫的行為與位元組都跟這個檔案不存在時一樣。
 *
 * ## 生產者在洋蔥的三個位置，加圍堵
 *
 * LangChain 的 `wrapToolCall` 是層層相包的，而 dsh 那四個時刻在我們樹上是**四個陣列位置**（由 `fold.ts` 的槽位表決定，
 * 不由註冊順序決定）。native 的 root 在同一個位置直接呼叫這四格（三顆生產者與圍堵）的那一步（`tool-call-step.ts` 的 `createToolCallStepMiddleware`），
 * 不經它們的 `wrapToolCall`；`langgraph` 與子代理仍經 `wrapToolCall`（TODO(#2359)）：
 *
 * | 事件 | 生產者 | 位置 |
 * | --- | --- | --- |
 * | `tools/pre-execute` | {@link createToolPreExecuteMiddleware} | **緊貼核准閘門外側**：`prepend: true` 的 plugin 今天就在閘門外側，派發點放內側，被拒的呼叫會變成「先跳核准卡再被拒」 |
 * | `tools/post-execute` | {@link createToolPostExecuteMiddleware} | 輸出校驗等貼著工具本體的那幾顆外側（dsh 在 post-execute 之前驗輸出）、plugin middleware 內側 |
 * | `tools/execute` | {@link createToolExecuteMiddleware} | 環繞工具本體：在 `invalidToolArgs` 內側，只有 `max-tokens.ts` 對 `task` 結果的替換還在它內側（dsh 在前景 `task` 本體裡拋，替換在 execute 裡才對得上） |
 * | `tools/result` | `containment.ts` | 圍堵：只有它同時看得到內層拋出的錯與回來的結果；在記 `tool/result` 之前派發（同 dsh 的 `notifyResult` 先於迴圈的 `appendToolResult`） |
 *
 * **核准閘門沒有搬**（demian 2026-10-09）：`approvalGate` 仍是自己的 middleware，問人的那條 waterfall 還在 `approvals` 註冊點。
 * 所以 `tools/pre-execute` 沒有 `ask`。取消也沒有 `cancel`：那是 `turn-cancel` 的事。
 *
 * ## 契約不帶 LangChain 型別
 *
 * 簽名只用這個檔案自己的形狀（{@link PipelineExecution}、{@link PipelineResult}），LangChain 的 `ToolMessage`／`Command`
 * 與請求形狀（`wrappedRequestOf`）只出現在生產者裡。**沒有人替換時，生產者把原物件原樣交回**：`tool-events.ts` 的錯誤碼掛在
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
 *    `config.signal`，不讀 `request.runtime.signal`，所以表達不出來。退到：`exec.signal` 唯讀（看得到這次呼叫的那一支），
 *    `tools/execute` 只能環繞（計時、計量、短路），不能換訊號。逾時今天由圍堵與工具宣告處理，不受影響。
 * 2. **`Command` 結果表達不出 `replace`。** 帶狀態更新的工具回 `Command`，沒有可替換的 `content`。退到：`tools/post-execute`
 *    只對 `ToolMessage` 結果派發；`Command` 只走 `tools/result`（`kind: 'command'`，不能改）。
 * 3. **拋出來的錯到 `tools/post-execute` 時是圍堵會翻的那則訊息，接受就原樣再拋。** 「拋錯翻成訊息」仍是圍堵（最外層）的事；
 *    post 先用同一組翻譯（`containment.ts` 的 `formatToolFailure`／`formatToolTimeout`／`classifyThrownToolError`）造一則給監聽者看，
 *    接受就把同一個錯物件往外拋、由圍堵照舊翻與記，替換就回替換過的那則。
 *    中斷與這一輪被中止的錯不派發。
 * 4. **resume 會讓 `tools/pre-execute` 對同一個 `callId` 跑兩次。** 核准的 `interrupt()` 穿過之後，同一個呼叫以同一個 `callId`
 *    重進（見 `containment.ts`）。dsh 沒有這回事。**`tools/pre-execute` 的監聽者必須冪等。**
 * 5. **每位監聽者的 `next()` 只能呼叫一次**，叫第二次就拋（見 `events.ts`），所以「重試包住 `next()`」表達不出來：
 *    `tools/execute` 的監聽者重跑不了工具本體。短路（不呼叫 `next()`、回自己的結果）可以。
 * 6. **`tools/pre-execute` 沒有 `ask`／`cancel`**：範圍，不是表達不出來。
 * 7. **結果多一份文字視圖**：`PipelineResult.blocks` 是內容區塊，`content` 是由它導出的文字（{@link pipelineTextOf}）。
 *    `tools/execute` 交回的結果兩者都在時以 `blocks` 為準；`replace` 只能給其中一個，兩個都給或都不給拋 `TypeError`。`content` 留著是給只讀文字的監聽者，不必自己串區塊。
 * 8. **`tools/post-execute` 只有 `accept`／`replace`**（範圍，不是表達不出來）：沒有 dsh 的 `block` 與 `additionalContexts`，
 *    等到有消費者要用再加。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import { isGraphBubbleUp } from '@langchain/langgraph';
import type { PreToolDecision } from './approval.js';
import type { AgentMiddleware } from './base-types.js';
import {
  classifyThrownToolError,
  declaredToolTimeoutMs,
  formatToolFailure,
  formatToolTimeout,
  isToolTimeout,
} from './containment.js';
import type { EventDispatcher, EventListenerInfo } from './events.js';
import { formatOrigin } from './plugin.js';
import { callThreadId, toolCallSessionAddress } from './session-address.js';
import type { SessionAddress } from './session-address.js';
import {
  createToolCallStepMiddleware,
  toolNameOfCall,
  wrappedRequestOf,
} from './tool-call-step.js';
import type { ToolCallSite } from './tool-call-step.js';
import { markToolError, readToolOutcome, toolErrorOf, toolRefusal } from './tool-events.js';
import type { ToolErrorInfo } from './tool-events.js';
import { isTurnCancelled } from './turn-cancel.js';

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
  /** 解析後的參數：**深凍結的複本**，監聽者改不動——模型可見的內容只能走已記錄的通道，不能在這裡悄悄改參數。 */
  readonly args: unknown;
  /** 誰在呼叫：root 或某個子代理（`runId`）；認不出來（不在圖裡）是 `undefined`。 */
  readonly agent: SessionAddress | undefined;
  /**
   * 這次呼叫在哪一條 thread 裡（`configurable.thread_id`，{@link callThreadId}）；認不出來是 `undefined`。
   * 一份監聽者只掛一次、服務好幾條 thread 時，**逐條 thread 的暫存要以它為鍵的一部分**：兩條 thread 可能撞上同一個 `callId`
   * （#1418）。與 `agent` 合起來才是完整的身分：`agent` 分 root／子代理，`thread` 分哪一條對話。
   */
  readonly thread: string | undefined;
  /**
   * 這次呼叫的中止訊號（`runtime.signal`）；沒有是 `undefined`。**唯讀**：監聽者可以看它、把它交給自己發的請求，換不了工具本體收到的那一支。
   */
  readonly signal: AbortSignal | undefined;
}

/**
 * 結果的一格內容：`ToolMessage` 陣列內容的一格（`{ type: 'text', text }`、圖片之類）。字串內容視為一格 `text`。唯讀。
 */
export type PipelineContentBlock = Readonly<{ type: string } & Record<string, unknown>>;

/**
 * 一次呼叫落定成什麼，監聽者看到的樣子。唯讀。
 *
 * - `message`：工具回了一則 `ToolMessage`。**`blocks` 是它的內容，`content` 由 `blocks` 導出**（{@link pipelineTextOf}：只串
 *   `text` 區塊，同 `ToolMessage.text`）。
 * - `command`：工具回了 `Command`（帶狀態更新）或別的非訊息值；**沒有可看的 `content`**，也不能被 `tools/post-execute` 替換
 *   （偏離 2）。`isError` 讀的是 `Command` 裡屬於這次呼叫的那則訊息。
 */
export type PipelineResult =
  | {
      readonly kind: 'message';
      /** 訊息的內容，凍結的複本；第一次讀才複製。 */
      readonly blocks: readonly PipelineContentBlock[];
      /** `blocks` 的文字（{@link pipelineTextOf}）。 */
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
 * 監聽者交回的一則訊息結果（`tools/execute` 短路、或改了 `next()` 的結果）：內容給 `content`（字串）或 `blocks`（區塊）其中一個。
 * 原樣交回收到的 {@link PipelineResult} 也可以；兩個都在時以 `blocks` 為準。
 */
export type PipelineMessageInput = {
  readonly kind: 'message';
  readonly isError: boolean;
  readonly error?: ToolErrorInfo;
} & (
  | { readonly content: string; readonly blocks?: never }
  | { readonly blocks: readonly PipelineContentBlock[]; readonly content?: never }
);

/** `tools/execute` 的監聽者可以交回的結果。 */
export type PipelineExecuteResult = PipelineResult | PipelineMessageInput;

/**
 * `tools/pre-execute` 的決定。`next()` 回 `allow`。
 *
 * **詞彙是核准鏈的 {@link PreToolDecision}（`kind` 為鍵）去掉 `ask`**：核准還沒搬上匯流排，`ask` 在這裡沒有人接，所以型別上拿掉。
 * `deny` 多一格選填的 `error`：拒絕那則訊息掛的碼（`tool-events.ts`），日誌的 `tool/result` 照它分類；省略就不掛碼。
 */
export type PipelinePreDecision =
  | Extract<PreToolDecision, { readonly kind: 'allow' }>
  | { readonly kind: 'deny'; readonly reason: string; readonly error?: ToolErrorInfo };

/**
 * `tools/post-execute` 的決定。`next()` 回 `accept`。`replace` 換掉模型收到的內容，給 `content`（字串）或 `blocks`（區塊）其中一個。
 */
export type PipelinePostDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'replace'; readonly content: string; readonly blocks?: never }
  | {
      readonly kind: 'replace';
      readonly blocks: readonly PipelineContentBlock[];
      readonly content?: never;
    };

declare module './events.js' {
  interface Events {
    /**
     * 派發前允許或拒絕。`next()` 即允許；回 `{ kind: 'deny', reason, error? }` 拒絕，模型收到 `Error: <reason>` 那一則
     * （`toolRefusal`，掛 `error` 的碼），工具本體與更內層都不跑。**沒有 `ask`／`cancel`**：問人還在 `approvals` 註冊點，取消歸 `turn-cancel`。
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
     * 環繞派發：計時、計量、短路。`next()` 跑工具本體並回正規化的結果。`exec` 唯讀，**換不了 `exec.signal`**（偏離 1）；
     * `next()` 只能呼叫一次（偏離 5）。不呼叫 `next()` 而回自己的 `message` 結果即短路，工具本體不跑；交回的 `command` 結果
     * 不是工具本體回的那一個（本體沒跑，或自己另造了一個）就拋 `TypeError`。呼叫了 `next()`、本體回的是 `ToolMessage`、又交回別的 `message` 結果時，換掉的是內容、`status` 與錯誤碼（照交回的 `isError`／`error`；`isError` 為假或省略 `error` 就不掛碼），`tool_call_id`、`name`、`artifact`、`id`、`additional_kwargs` 沿用本體那則。
     * @param exec - 通過 `tools/pre-execute` 的這次呼叫。
     * @param next - 往內一位；最內層跑工具並回結果。
     * @mode waterfall
     */
    'tools/execute'(
      exec: PipelineExecution,
      next: () => Promise<PipelineResult>,
    ): Promise<PipelineExecuteResult>;
    /**
     * 接受或替換一則工具結果。`next()` 即接受；回 `{ kind: 'replace', content }` 或 `{ kind: 'replace', blocks }` 換掉模型收到的內容
     * （`status`、`artifact`、`additional_kwargs`、錯誤碼沿用原本的）。**只對 `ToolMessage` 結果派發**：`Command` 不經過這裡（偏離 2）。
     * 工具拋的錯也到這裡，`result` 是圍堵會翻出來的那則錯誤訊息（逾時那句的毫秒數由這一層量，可能比模型收到的少）；`next()`（接受）就原樣再拋那個錯（偏離 3）。中斷、`Command` 這類控制流與這一輪被中止的錯不派發，原樣往外拋。
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

/** 三顆生產者與圍堵讀得到的請求格子（`wrappedRequestOf`）。 */
export interface PipelineRequest {
  readonly toolCall: { readonly id?: string; readonly name: string; readonly args?: unknown };
  readonly runtime?: { readonly configurable?: unknown; readonly signal?: AbortSignal | undefined };
}

/** 遞迴凍結。 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * 給監聽者的參數：一份**深凍結的複本**，不是請求裡那個活物件。
 *
 * 請求裡的 `args` 就是狀態裡那則 AI 訊息的 `tool_calls[i].args`；`Object.freeze(exec)` 只凍一層，若把它原樣放進去，
 * 監聽者一改，工具會用改過的參數跑、對話狀態跟著變，而圍堵在更外層已經用原參數記了 `tool/call`——日誌與模型看到的就分岔了。
 * 這一步只在有監聽者時才做（`exec` 只在那時造），沒人聽的呼叫不付這個成本。
 *
 * 複製失敗（參數裡有函式之類結構化複製收不了的東西）退回 JSON 來回；再失敗就只凍一層淺複本，盡力而為。
 */
function frozenArgsCopy(args: unknown): unknown {
  if (typeof args !== 'object' || args === null) return args;
  try {
    return deepFreeze(structuredClone(args));
  } catch {
    try {
      return deepFreeze(JSON.parse(JSON.stringify(args)) as unknown);
    } catch {
      return Object.freeze({ ...args });
    }
  }
}

/** 由這次呼叫的請求形狀造出監聽者看的 {@link PipelineExecution}（凍結，參數是深凍結的複本）。 */
export function toolExecutionOf(request: PipelineRequest): PipelineExecution {
  return Object.freeze({
    callId: request.toolCall.id ?? '',
    name: request.toolCall.name,
    args: frozenArgsCopy(request.toolCall.args),
    agent: toolCallSessionAddress({ configurable: request.runtime?.configurable }),
    thread: callThreadId({ configurable: request.runtime?.configurable }),
    signal: request.runtime?.signal,
  });
}

/**
 * 一串內容的文字：只串 `text` 區塊，其餘算空字串。規則同 `ToolMessage.text`，所以 `pipelineTextOf(view.blocks)` 與那則訊息的
 * `text` 逐字相同。
 *
 * @param content - 訊息的內容：字串，或區塊陣列（裡面的字串算一格文字）。
 * @returns 文字。
 */
export function pipelineTextOf(content: string | readonly unknown[]): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => {
      if (typeof block === 'string') return block;
      const { type, text } = (block ?? {}) as { type?: unknown; text?: unknown };
      return type === 'text' ? text : '';
    })
    .join('');
}

/**
 * 一格內容的凍結複本。字串算一格 `text`。複製失敗退回 JSON 來回，再失敗就只凍一層淺複本，同 {@link frozenArgsCopy}。
 */
function frozenBlock(block: unknown): PipelineContentBlock {
  if (typeof block === 'string') return Object.freeze({ type: 'text', text: block });
  if (typeof block !== 'object' || block === null) {
    return Object.freeze({ type: 'unknown', value: block });
  }
  try {
    return deepFreeze(structuredClone(block)) as PipelineContentBlock;
  } catch {
    try {
      return deepFreeze(JSON.parse(JSON.stringify(block)) as PipelineContentBlock);
    } catch {
      return Object.freeze({ ...block }) as PipelineContentBlock;
    }
  }
}

/**
 * 一則 `ToolMessage` 的內容造成凍結的區塊。陣列內容不原地凍：那是對話狀態裡那則訊息自己的陣列，凍了會改到模型收到、存檔點存的那一份，所以複製。
 */
function frozenBlocksOf(content: unknown): readonly PipelineContentBlock[] {
  if (typeof content === 'string') return Object.freeze([frozenBlock(content)]);
  if (!Array.isArray(content)) return Object.freeze([]);
  return Object.freeze(content.map(frozenBlock));
}

/**
 * 由內層（`next()`）回來的值造出監聽者看的 {@link PipelineResult}（凍結）。
 *
 * `blocks` 第一次讀才複製（getter）：有 `tools/result` 監聽者時，圍堵每次呼叫都造視圖給它；出廠的那一位（present）只讀 `isError`，帶大圖的結果不必每次都複製。
 *
 * @param result - 內層（`next()`）回來的值（或圍堵翻出來的訊息）。
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
    const raw: unknown = result.content;
    let blocks: readonly PipelineContentBlock[] | undefined;
    const view = {
      kind: 'message' as const,
      content: typeof raw === 'string' || Array.isArray(raw) ? pipelineTextOf(raw) : '',
      isError: outcome.isError,
      ...error,
    };
    Object.defineProperty(view, 'blocks', {
      enumerable: true,
      get: () => (blocks ??= frozenBlocksOf(raw)),
    });
    return Object.freeze(view) as PipelineResult;
  }
  return Object.freeze({ kind: 'command', isError: outcome.isError, ...error });
}

function isErrorInfo(value: unknown): value is ToolErrorInfo {
  const { name, code } = (value ?? {}) as { name?: unknown; code?: unknown };
  return typeof value === 'object' && typeof name === 'string' && typeof code === 'string';
}

/** 監聽者回的決定不是詞彙內的值。 */
function badDecision(event: string, value: unknown): TypeError {
  return new TypeError(
    `${event} 的監聽者回了不認得的決定：${JSON.stringify(value) ?? String(value)}`,
  );
}

/**
 * 監聽者交回的內容：`blocks` 是陣列就用它（可改的複本，交給 `ToolMessage`），否則 `content` 是字串就用它；兩個都不合是 `undefined`。
 */
function bodyOf(value: {
  readonly content?: unknown;
  readonly blocks?: unknown;
}): string | Record<string, unknown>[] | undefined {
  if (Array.isArray(value.blocks)) {
    return value.blocks.map((block: unknown) => {
      if (typeof block !== 'object' || block === null) return { type: 'text', text: String(block) };
      try {
        return structuredClone(block) as Record<string, unknown>;
      } catch {
        return { ...(block as Record<string, unknown>) };
      }
    });
  }
  return typeof value.content === 'string' ? value.content : undefined;
}

/**
 * 換掉一則 `ToolMessage` 的內容，其餘（`tool_call_id`、`name`、`artifact`、`id`、`additional_kwargs`）沿用。
 *
 * @param original - 本體回的那則。
 * @param body - 新的內容。
 * @param outcome - 省略就沿用原本的 `status` 與錯誤碼；給了就照它設 `status`，`isError` 時掛它的碼。
 */
function rebuildMessage(
  original: ToolMessage,
  body: string | Record<string, unknown>[],
  outcome?: { readonly isError: boolean; readonly error?: ToolErrorInfo },
): ToolMessage {
  const status = outcome === undefined ? original.status : outcome.isError ? 'error' : 'success';
  const kwargs = original.additional_kwargs;
  const replaced = new ToolMessage({
    content: body as ToolMessage['content'],
    tool_call_id: original.tool_call_id,
    ...(original.name !== undefined && { name: original.name }),
    ...(status !== undefined && { status }),
    ...(original.artifact !== undefined && { artifact: original.artifact }),
    ...(original.id !== undefined && { id: original.id }),
    ...(Object.keys(kwargs).length > 0 && { additional_kwargs: { ...kwargs } }),
  });
  const code =
    outcome === undefined ? toolErrorOf(original) : outcome.isError ? outcome.error : undefined;
  return code === undefined ? replaced : markToolError(replaced, code);
}

/**
 * 把監聽者交回的 `message` 結果從 `exec` 造成一則新的 `ToolMessage`：短路時，或叫了 `next()` 而本體回的不是 `ToolMessage` 時。
 * 交回的是 `command` 結果就拋 `TypeError`，訊息照 `bodyRan`（工具本體跑了沒）分兩句：模型看得到這段文字，要講出實際的情形。
 * 判準是本體跑了沒，不是交回的那位叫了 `next()` 沒：有多位監聽者時，叫了 `next()` 也可能被內層短路。
 */
function materialize(
  view: PipelineExecuteResult,
  exec: PipelineExecution,
  bodyRan: boolean,
): ToolMessage {
  const body = view.kind === 'message' ? bodyOf(view) : undefined;
  if (body === undefined) {
    throw view.kind === 'message'
      ? badDecision('tools/execute', view)
      : new TypeError(bodyRan ? COMMAND_NOT_FROM_BODY : COMMAND_WITHOUT_BODY);
  }
  const message = new ToolMessage({
    content: body as ToolMessage['content'],
    tool_call_id: exec.callId,
    name: exec.name,
    status: view.isError ? 'error' : 'success',
  });
  return view.error === undefined ? message : markToolError(message, view.error);
}

const COMMAND_WITHOUT_BODY =
  'tools/execute 的監聽者回了 command 結果，但工具本體沒有跑：Command 造不出來（偏離 2）';
const COMMAND_NOT_FROM_BODY =
  'tools/execute 的監聽者交回的 command 結果不是 next() 回的那一個：Command 造不出來（偏離 2）';

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
  return createToolCallStepMiddleware(TOOL_PRE_EXECUTE_MIDDLEWARE_NAME, async (call, next) => {
    if (events.count('tools/pre-execute') === 0) return next();
    const exec = toolExecutionOf(wrappedRequestOf(call));
    const decision = await events.waterfall('tools/pre-execute', exec, () =>
      Promise.resolve(ALLOW),
    );
    if (decision.kind === 'allow') return next();
    if (decision.kind === 'deny' && typeof decision.reason === 'string') {
      const error = decision.error as unknown;
      if (error === undefined) {
        return toolRefusal(decision.reason, { callId: exec.callId, name: exec.name });
      }
      if (!isErrorInfo(error)) throw badDecision('tools/pre-execute', decision);
      return toolRefusal(decision.reason, { callId: exec.callId, name: exec.name, error });
    }
    throw badDecision('tools/pre-execute', decision);
  });
}

/**
 * `tools/execute` 的生產者，環繞工具本體。沒有監聽者時直接交給下一層。
 *
 * **沒有人短路時，回的是內層原本回的那個物件**（同一個 `ToolMessage` 或 `Command`），不是重建的。
 *
 * @param events - 宿主持有的派發面。
 * @returns 可以放進 `middleware` 陣列的 middleware。
 */
export function createToolExecuteMiddleware(events: EventDispatcher): AgentMiddleware {
  return createToolCallStepMiddleware(TOOL_EXECUTE_MIDDLEWARE_NAME, async (call, next) => {
    if (events.count('tools/execute') === 0) return next();
    const exec = toolExecutionOf(wrappedRequestOf(call));
    let raw: unknown;
    let viewOfRaw: PipelineResult | undefined;
    const view = await events.waterfall('tools/execute', exec, async () => {
      raw = await next();
      viewOfRaw = toolResultView(raw, exec.callId);
      return viewOfRaw;
    });
    // 沒人短路（或原樣回了 `next()` 的結果）：把內層原本的物件交回去，錯誤碼掛在它身上。
    if (viewOfRaw !== undefined && view === viewOfRaw) return raw;
    if (viewOfRaw !== undefined && ToolMessage.isInstance(raw) && view.kind === 'message') {
      const body = bodyOf(view);
      if (body === undefined) throw badDecision('tools/execute', view);
      return rebuildMessage(raw, body, view);
    }
    return materialize(view, exec, viewOfRaw !== undefined);
  });
}

/**
 * `tools/post-execute` 的生產者。沒有監聽者、結果是 `Command`、或決定是 `accept`，都回內層原本的那個物件。
 *
 * **工具拋的錯也派發**：監聽者看到的是圍堵會翻出來的那則錯誤訊息（文字與碼同 `containment.ts`，只有逾時那句的毫秒數由這一層量）。`accept` 時把**同一個錯物件**
 * 原樣再拋，交給外面的圍堵照舊翻；`replace` 時回替換過的那則（`status: 'error'`，碼沿用）。中斷與 `Command` 這類控制流
 * （`isGraphBubbleUp`）和這一輪被中止的錯（`isTurnCancelled`，交給外面的 `turn-cancel` 換成 `ABORTED`）不派發，原樣往外拋。
 *
 * @param events - 宿主持有的派發面。
 * @returns 可以放進 `middleware` 陣列的 middleware。
 */
export function createToolPostExecuteMiddleware(events: EventDispatcher): AgentMiddleware {
  return createToolCallStepMiddleware(TOOL_POST_EXECUTE_MIDDLEWARE_NAME, async (call, next) => {
    if (events.count('tools/post-execute') === 0) return next();
    const startedAt = Date.now();
    let result: unknown;
    try {
      result = await next();
    } catch (error) {
      if (isGraphBubbleUp(error) || isTurnCancelled(error)) throw error;
      return postExecuteThrown(events, call, error, Date.now() - startedAt);
    }
    if (!ToolMessage.isInstance(result)) return result;
    return postExecuteMessage(events, toolExecutionOf(wrappedRequestOf(call)), result);
  });
}

/** 對一則 `ToolMessage` 結果派發 `tools/post-execute`；`accept` 回原物件。 */
async function postExecuteMessage(
  events: EventDispatcher,
  exec: PipelineExecution,
  result: ToolMessage,
): Promise<ToolMessage> {
  const view = toolResultView(result, exec.callId);
  const decision = await events.waterfall('tools/post-execute', exec, view, () =>
    Promise.resolve(ACCEPT),
  );
  const replaced = replacedBy(decision, result);
  if (replaced === undefined) throw badDecision('tools/post-execute', decision);
  return replaced;
}

/**
 * 本體拋了錯：把圍堵會翻出來的那則訊息交給監聽者。`accept` 原樣再拋那個錯。
 *
 * 逾時那句的毫秒數從這一層量起，圍堵量的是它自己那一層，accept 之後模型收到的那則可能多幾毫秒。
 */
async function postExecuteThrown(
  events: EventDispatcher,
  call: ToolCallSite,
  error: unknown,
  elapsedMs: number,
): Promise<ToolMessage> {
  const request = wrappedRequestOf(call);
  const exec = toolExecutionOf(request);
  const toolName = toolNameOfCall(call);
  const kind = classifyThrownToolError(error);
  const message = toolRefusal(
    isToolTimeout(error)
      ? formatToolTimeout(toolName, elapsedMs, declaredToolTimeoutMs(request))
      : formatToolFailure(toolName, error),
    { callId: exec.callId, name: toolName, ...(kind !== undefined && { error: kind }) },
  );
  const view = toolResultView(message, exec.callId);
  const decision = await events.waterfall('tools/post-execute', exec, view, () =>
    Promise.resolve(ACCEPT),
  );
  if (decision.kind === 'accept') throw error;
  const replaced = replacedBy(decision, message);
  if (replaced === undefined) throw badDecision('tools/post-execute', decision);
  return replaced;
}

/** `accept` 回 `result` 本身，合規的 `replace` 回替換過的那則，其餘 `undefined`。 */
function replacedBy(decision: PipelinePostDecision, result: ToolMessage): ToolMessage | undefined {
  if (decision.kind === 'accept') return result;
  if (decision.kind !== 'replace') return undefined;
  const hasBlocks = (decision.blocks as unknown) !== undefined;
  const hasContent = (decision.content as unknown) !== undefined;
  const body = hasBlocks === hasContent ? undefined : bodyOf(decision);
  return body === undefined ? undefined : rebuildMessage(result, body);
}

/**
 * 給圍堵用：派發 `tools/result`。**失敗全部隔離**——同步拋錯、promise 拒絕、連造 `exec`／視圖時出的事都不外洩，
 * 因為這一步發生在一次已經有結果的呼叫上，任何失敗都不能把它翻成別的。
 *
 * @param events - 宿主持有的派發面。
 * @param request - 圍堵造的請求形狀（`wrappedRequestOf`）。
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
