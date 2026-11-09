/**
 * 往系統提示加字的一步（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)）：一步拿到這次模型請求，回要接上的那幾塊
 * （{@link SystemPromptPiece}），由 {@link applySystemPromptPieces} 照順序套到系統訊息上。一步回的那幾塊是純字串，不帶 LangChain 型別。
 *
 * **wrapModelCall 由登記的那一份造出來**（{@link withSystemPromptStep}）：同一份 cell 既造那顆的 `wrapModelCall`，也登記給 native，
 * 所以兩者分不開。native 的 root 在模型那一串（`native-loop/agent.ts` 的 `#modelCells`）直接呼叫 {@link systemPromptWrapWith} 造的
 * 那一支，不經那顆的 `wrapModelCall`；`langgraph` 與子代理照舊經 `wrapModelCall`。一步是同步的，套完就在同一個 tick 往內交，中間沒有 `await`。
 *
 * @module
 */

import { SystemMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

import type { AgentMiddleware } from './base-types.js';

/**
 * 接上的一塊。三種接法送出的位元組各不相同：`append` 給中段段格、Skills 與尾段，`prepend` 給 `nexusSystemPrompt` 的頭段，`block` 給記憶（同基座）。
 *
 * - `append`：`SystemMessage.concat(text)`（內容是區塊陣列時另開一塊，見 `@langchain/core` 的 `mergeContent`）。
 * - `prepend`：接在最前面，後面空一行；字串內容接成 `${text}\n\n${content}`，區塊陣列就在最前面加一塊 `${text}\n\n`。
 * - `block`：另建一則內容是區塊陣列的系統訊息，原本的內容（字串先包成一塊）之後加一塊 `text`。
 */
export type SystemPromptPiece =
  { readonly append: string } | { readonly prepend: string } | { readonly block: string };

/** 一次模型呼叫：`wrapModelCall` 的請求上，一步用得到的那幾格。其餘欄位原樣讀穿。 */
export interface SystemPromptRequest {
  readonly systemMessage?: SystemMessage;
  readonly tools?: readonly unknown[];
  readonly runtime?: unknown;
  readonly model?: unknown;
}

/** 回要接上的那幾塊；`undefined` 或空陣列是這一次不接，往內交原本那個請求物件。 */
export type SystemPromptStep = (
  request: SystemPromptRequest,
) => readonly SystemPromptPiece[] | undefined;

/** 登記的那一份。 */
export interface SystemPromptCell {
  readonly step: SystemPromptStep;
  /**
   * 請求上沒有 `systemMessage` 時怎麼辦。`'empty'` 是當成 `new SystemMessage('')` 再接；函式是整個交給它、不叫 `step`；不給就把
   * `undefined` 當系統訊息接，`step` 回了要接的就拋 `TypeError`。兩個 loop 都一定設 `systemMessage`，走得到這一條的只有直接叫
   * `wrapModelCall` 或 `applySections` 的測試。
   */
  readonly withoutSystemMessage?: 'empty' | (<R extends SystemPromptRequest>(request: R) => R);
}

/**
 * 把幾塊照順序套到系統訊息上。
 *
 * @param message - 原本的系統訊息。
 * @param pieces - 要接上的那幾塊。
 * @returns 接好的系統訊息；`pieces` 是空的就回 `message` 本身。
 */
export function applySystemPromptPieces(
  message: SystemMessage,
  pieces: readonly SystemPromptPiece[],
): SystemMessage {
  let next = message;
  for (const piece of pieces) {
    if ('append' in piece) {
      next = next.concat(piece.append);
    } else if ('prepend' in piece) {
      const { content } = next;
      next = new SystemMessage({
        content:
          typeof content === 'string'
            ? `${piece.prepend}\n\n${content}`
            : [{ type: 'text', text: `${piece.prepend}\n\n` }, ...content],
      });
    } else {
      const existing = next.content;
      const blocks =
        typeof existing === 'string'
          ? [{ type: 'text', text: existing }]
          : Array.isArray(existing)
            ? existing
            : [];
      next = new SystemMessage({
        content: [...blocks, { type: 'text', text: piece.block }] as never,
      });
    }
  }
  return next;
}

/**
 * 把登記的一格轉成 `wrapModelCall`：一步回的那幾塊接上系統訊息再往內交，沒有要接的就交原本那個請求。
 *
 * @param cell - 登記的那一格。
 * @returns 可以放進 `createMiddleware({ wrapModelCall })` 的函式。
 */
export function systemPromptWrapWith<Request extends SystemPromptRequest, Result>(
  cell: SystemPromptCell,
): (request: Request, handler: (request: Request) => Result) => Result {
  return (request, handler) => {
    const missing = request.systemMessage === undefined;
    if (missing && typeof cell.withoutSystemMessage === 'function') {
      return handler(cell.withoutSystemMessage(request));
    }
    const pieces = cell.step(request);
    if (pieces === undefined || pieces.length === 0) return handler(request);
    const base =
      missing && cell.withoutSystemMessage === 'empty'
        ? new SystemMessage('')
        : (request.systemMessage as SystemMessage);
    return handler({ ...request, systemMessage: applySystemPromptPieces(base, pieces) });
  };
}

const registeredCells = new WeakMap<object, SystemPromptCell>();

/**
 * 用 `cell` 造 `wrapModelCall` 交給 `build`，再把同一份 `cell` 登記在 `build` 造出來的那顆上（{@link systemPromptCellOf}）。
 * TODO([#2363](https://github.com/DemianLi/nexus-agent/issues/2363))：`langgraph` 那條路徑拿掉、內建不再造成 middleware 時收掉。
 *
 * @param cell - 這一格。
 * @param build - 拿 `wrapModelCall` 造那顆 middleware。
 * @returns `build` 造的那顆。
 */
export function withSystemPromptStep<M extends object>(
  cell: SystemPromptCell,
  build: (wrapModelCall: (request: never, handler: never) => unknown) => M,
): M {
  const middleware = build(systemPromptWrapWith(cell) as never);
  registeredCells.set(middleware, cell);
  return middleware;
}

/**
 * 只往系統提示加字的一顆 middleware，並登記這一步。
 *
 * @param name - middleware 的名字。
 * @param cell - 這一格。
 * @returns 可以放進 middleware 陣列的實例。
 */
export function createSystemPromptStepMiddleware(
  name: string,
  cell: SystemPromptCell,
): AgentMiddleware {
  return withSystemPromptStep(
    cell,
    (wrapModelCall) =>
      createMiddleware({
        name,
        wrapModelCall: wrapModelCall as never,
      }) as unknown as AgentMiddleware,
  );
}

/**
 * 這顆 middleware 登記的系統提示那一格；沒登記是 `undefined`。
 * TODO([#2363](https://github.com/DemianLi/nexus-agent/issues/2363))：`langgraph` 那條路徑拿掉、內建不再造成 middleware 時收掉。
 *
 * @param middleware - 那一顆，照身分查：複製出來的物件查不到。
 * @returns 那一格。
 */
export function systemPromptCellOf(middleware: object): SystemPromptCell | undefined {
  return registeredCells.get(middleware);
}
