/**
 * 從會話日誌推回模型的對話歷史——續接時灌回 graph state 的那一串
 * （[#306](https://github.com/DemianLi/nexus-agent/issues/306)）。
 *
 * ## 照 dsh 的哪一段
 *
 * dsh 的模型歷史由日誌推出來：`Session.deriveMessages()` 逐顆走 surface 上的節點，交給
 * `deriveEventMessage` 投影（`packages/core/session/src/index.ts:832`、`surface.ts:92`，`c291e79`）。
 * **我們沒有 surface 那一軸**（每顆事件上的 `surfaceOp`），所以「哪幾種事件產訊息」照
 * {@link ./session-log.ts} 檔頭那張表判：人打的字在 `turn/start`，模型回覆在 `assistant/message`，
 * 工具結果在 `tool/result`，外掛塞進對話的在 `user/message`，壓縮的摘要在 `compaction/summary`。
 *
 * ## 推出來的串要跟 graph state 一則對一則
 *
 * 壓縮的切點是 graph state 原始訊息串的索引，所以對不齊的話切錯地方。寫的一側有兩處跟 state 的順序不同，
 * 由這裡對回去（[#305](https://github.com/DemianLi/nexus-agent/issues/305) 留下的三件裡的兩件）：
 *
 * - **併發的工具結果**：日誌照落定的先後記，state 照那則回覆裡 `tool_calls` 的順序放（實測：先叫的慢、
 *   後叫的快，日誌是快、慢，state 是慢、快）。所以一批結果先收著，照 `tool_calls` 的順序放。goal 收尾
 *   注入的那則 `user/message` 跟著它那顆結果搬——圍堵在同一個回呼裡連著寫這兩顆（`containment.ts`），
 *   state 裡它也緊跟在那則 ToolMessage 後面。
 * - **壓縮**：切點直接用在推出來的串上，**對不上就整串不灌**。`compaction/summary` 落在它那次呼叫的
 *   回覆之後（摘要器包在記回覆那一層外面），所以那一刻推出來的應該恰好是 `messagesBefore + 1` 則（實測）。
 *
 * 第三件（80,000 字元以上的工具結果，模型看到的是基座換過的預覽）要知道組裝怎麼設，交給呼叫端，見
 * {@link ReplayOptions.toolResultAsSeen}。
 *
 * ## `session/end-seed` 在這裡要穿過去
 *
 * {@link ./session-log.ts | currentTurnStart} 在它那裡停；推歷史反過來——上一個生命週期的對話正是要推回來的
 * 東西。它在這裡是**座標的重設點**：續接時灌回去的那一串就是新 state 的原始訊息串，之後的切點以它為
 * 座標。所以穿過它時，推出來的換成那時灌回去的那一串（壓縮過就是摘要加之後的，連同補上的結果）。
 *
 * ## 沒配到結果的呼叫：照 dsh 的 `repair.ts` 補
 *
 * 行程在工具跑到一半、或停在核准點時結束，會留下一則帶 `tool_calls` 卻沒有對應 ToolMessage 的回覆，
 * 供應商會拒收整串。基座的 `patchToolCallsMiddleware` 會補（實測續接之後走得到它），但它那句話說
 * 「another message came in」，成因是錯的（#265 的 Q12）。所以照 dsh 的 `interruptedTurnClosers`
 * （`packages/core/session/src/repair.ts`，`c291e79`）補：記過 `tool/call` 的說結果不明、先確認外部狀態，
 * 沒記過的說還沒開始、要就重試。字逐字照抄。一批結果在下一則訊息進來時還沒到齊也照這樣補——state 在
 * 那個位置也會有一則（基座補的），一則對一則照樣成立。
 *
 * **偏離：補在記憶體裡，不寫進日誌。** dsh 續接時把補的事件寫回日誌（`packages/core/agent-loop/src/index.ts:892`），
 * 冷讀時才只在記憶體裡補（`packages/session-query/session-query/src/cold-read.ts`）。我們兩處都只在記憶體裡：
 *
 * - 停在核准點的那一輪在我們的日誌上是**收掉的**（`interrupt/raised` 之後有 `turn/end`），dsh「關掉開著的
 *   最後一輪」在這裡找不到那一輪。要寫就得替它另開一輪，而 `turn/start.kind` 是授權的判別欄：合成一顆
 *   等於憑空多出一個「人回覆了」。
 * - 沒記過 `tool/call` 的那種，一顆 `tool/result` 在我們的配對不變量上是違規（`invariant.ts`）。
 *
 * 推出來的是確定的，同一份日誌推幾次都一樣，所以不寫回去也不會漂。
 *
 * ## 推不出來就整串不灌
 *
 * #306 拍板 2：推不出完整的歷史，就不灌半截進去，模型從空的開始。見 {@link UnreplayableReason}。
 */

import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

import { fromLoggedMessage } from './logged-message.js';
import type { SessionEvent } from './session-log.js';
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, toolRefusal } from './tool-events.js';

/** 記過 `tool/call`、結果沒記下來的那次。逐字照抄 dsh `repair.ts:106`。 */
export const TOOL_OUTCOME_UNKNOWN_TEXT =
  'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.';

/** 回覆裡要了、還沒記到 `tool/call` 的那次。逐字照抄 dsh `repair.ts:107`。 */
export const TOOL_NOT_STARTED_TEXT =
  'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.';

/**
 * 推不出完整歷史的原因。
 *
 * - `reply-missing`：一輪正常收尾、中間沒有中斷，卻一則模型回覆都沒有；**或是整份日誌叫過模型**
 *   （`model/start`、`tool/call`）**卻一則回覆都沒有**。格式 8 以前的日誌不記回覆，正常收尾的每一輪都中
 *   第一道；每一輪都被中止、或唯一那一輪沒收尾的，第一道碰不到，由第二道接。9 以後只有回覆沒記進去、或
 *   每一次呼叫都沒產出看得見的內容時才會——從空的開始是安全的那一邊。**格式版本判不出這件事**：續寫的
 *   把手第一次寫入時把 header 的 `version` 蓋成這一版（`session-store.ts`），8 開頭、9 續寫的檔 header 是 9。
 * - `result-missing`：一顆 `tool/result` 沒帶 `message`——8 以前，或圍堵在回傳裡找不到那則訊息。
 * - `summary-missing`：一顆 `compaction/summary` 沒帶 `summary`——8 以前。
 * - `compaction-misaligned`：切點那一刻推出來的則數對不上 `messagesBefore + 1`，切下去會切錯地方。
 */
export type UnreplayableReason =
  'reply-missing' | 'result-missing' | 'summary-missing' | 'compaction-misaligned';

/** 推的結果。`seq` 是第一顆推不下去的事件。 */
export type ConversationReplay =
  | { readonly kind: 'replayed'; readonly messages: readonly BaseMessage[] }
  | { readonly kind: 'unreplayable'; readonly reason: UnreplayableReason; readonly seq: number };

export interface ReplayOptions {
  /**
   * 一則工具結果在模型那一格長什麼樣。省略即日誌裡記的那則原樣。
   *
   * 日誌記的是工具的輸出，模型看到的可能是基座換過的預覽（`session-log.ts` 的 `tool/result`）。重算要知道
   * 門檻與暫存路徑，那是組裝點的設定，所以由呼叫端給。
   */
  readonly toolResultAsSeen?: (message: ToolMessage) => BaseMessage;
}

/** 一則回覆要了、還在等結果的那一批。 */
interface PendingBatch {
  /** 照回覆裡 `tool_calls` 的順序。 */
  readonly calls: readonly { readonly id: string; readonly name: string }[];
  /** callId → 那顆結果，加上跟著它注入的訊息。 */
  readonly results: Map<string, BaseMessage[]>;
  /** 記過 `tool/call` 的。補結果時據此挑 dsh 的哪一句。 */
  readonly started: Set<string>;
}

/** 一則回覆要了哪幾次呼叫，照順序。沒有 id 的配不到結果，不算。 */
function requestedCalls(message: BaseMessage): PendingBatch['calls'] {
  if (!AIMessage.isInstance(message)) return [];
  return (message.tool_calls ?? []).flatMap((call) =>
    call.id === undefined ? [] : [{ id: call.id, name: call.name }],
  );
}

/** 沒配到結果的那次，照 dsh `repair.ts` 補一則錯誤結果。 */
function closer(
  call: { readonly id: string; readonly name: string },
  started: boolean,
): ToolMessage {
  return toolRefusal(started ? TOOL_OUTCOME_UNKNOWN_TEXT : TOOL_NOT_STARTED_TEXT, {
    callId: call.id,
    name: call.name,
    error: started
      ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
      : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
  });
}

/**
 * 把一份 root 日誌推回模型的對話歷史。
 *
 * @param events - root 那一份日誌的全部事件，照 `seq` 排（續接時讀回來的那些）。
 * @param options - 見 {@link ReplayOptions}。
 * @returns 要灌回 graph state 的那一串（壓縮過就是摘要加之後的），或推不出來的原因。
 */
export function replayConversation(
  events: readonly SessionEvent[],
  options: ReplayOptions = {},
): ConversationReplay {
  /** 這個生命週期的原始訊息串，與 graph state 的 `messages` 同一組座標。 */
  let raw: BaseMessage[] = [];
  /** 這個生命週期最後一次壓縮。 */
  let summary: { readonly message: BaseMessage; readonly cutoff: number } | undefined;
  let batch: PendingBatch | undefined;
  /** 開著的那一輪有沒有回覆、有沒有停下來等人。 */
  let turn: { replied: boolean; interrupted: boolean } | undefined;
  let previous: SessionEvent | undefined;
  /** 第一顆「模型跑過」的事件，與整份日誌有沒有任何一則回覆。見 {@link UnreplayableReason}。 */
  let modelRan: number | undefined;
  let replied = false;

  const pendingCount = (): number =>
    [...(batch?.results.values() ?? [])].reduce((sum, messages) => sum + messages.length, 0);
  /** 那一批照 `tool_calls` 的順序放進去，缺的補上。 */
  const flush = (): void => {
    if (batch === undefined) return;
    for (const call of batch.calls) {
      raw.push(...(batch.results.get(call.id) ?? [closer(call, batch.started.has(call.id))]));
    }
    batch = undefined;
  };
  const push = (message: BaseMessage): void => {
    flush();
    raw.push(message);
  };
  /** 這個生命週期到此為止：換成那時灌回去的那一串。 */
  const settle = (): void => {
    flush();
    if (summary !== undefined) raw = [summary.message, ...raw.slice(summary.cutoff)];
    summary = undefined;
  };
  const asSeen = (message: BaseMessage): BaseMessage =>
    options.toolResultAsSeen !== undefined && ToolMessage.isInstance(message)
      ? options.toolResultAsSeen(message)
      : message;

  for (const event of events) {
    switch (event.type) {
      case 'turn/start': {
        turn = { replied: false, interrupted: false };
        // `resume` 是回覆核准，沒有使用者說的話——送進圖的是 `Command`，不是一則訊息。
        if (event.data.kind !== 'resume') push(new HumanMessage(event.data.text));
        break;
      }
      case 'model/start': {
        modelRan ??= event.seq;
        break;
      }
      case 'assistant/message': {
        replied = true;
        if (turn !== undefined) turn.replied = true;
        const message = fromLoggedMessage(event.data.message);
        const calls = requestedCalls(message);
        push(message);
        if (calls.length > 0) batch = { calls, results: new Map(), started: new Set() };
        break;
      }
      case 'tool/call': {
        modelRan ??= event.seq;
        if (batch?.calls.some((call) => call.id === event.data.callId) === true) {
          batch.started.add(event.data.callId);
        }
        break;
      }
      case 'tool/result': {
        if (event.data.message === undefined) {
          return { kind: 'unreplayable', reason: 'result-missing', seq: event.seq };
        }
        const message = asSeen(fromLoggedMessage(event.data.message));
        if (batch?.calls.some((call) => call.id === event.data.callId) === true) {
          batch.results.set(event.data.callId, [message]);
        } else {
          push(message);
        }
        break;
      }
      case 'user/message': {
        const message = fromLoggedMessage(event.data.message);
        // 緊跟在一顆結果後面、而且是那顆工具注入的：跟著那顆結果走。其餘的（repeat-reminder 的提醒）
        // 在那一批之後。
        const owner = previous?.type === 'tool/result' ? previous.data.callId : undefined;
        const call = batch?.calls.find((candidate) => candidate.id === owner);
        const results = call === undefined ? undefined : batch?.results.get(call.id);
        if (call?.name === event.data.source.plugin && results !== undefined) {
          results.push(message);
        } else {
          push(message);
        }
        break;
      }
      case 'compaction/summary': {
        const { summary: logged, cutoffIndex, messagesBefore } = event.data;
        if (logged === undefined) {
          return { kind: 'unreplayable', reason: 'summary-missing', seq: event.seq };
        }
        if (raw.length + pendingCount() !== messagesBefore + 1 || cutoffIndex > messagesBefore) {
          return { kind: 'unreplayable', reason: 'compaction-misaligned', seq: event.seq };
        }
        summary = { message: fromLoggedMessage(logged), cutoff: cutoffIndex };
        break;
      }
      case 'interrupt/raised': {
        if (turn !== undefined) turn.interrupted = true;
        break;
      }
      case 'turn/end': {
        // 停在核准點的那一輪可以沒有回覆：答掉一顆之後，同一批沒被答到的會在叫模型之前再度中斷。
        // 被中止的那一輪同理（停在核准點時按停止，由 pump 收回）。
        if (
          turn !== undefined &&
          event.data.reason === undefined &&
          !turn.replied &&
          !turn.interrupted
        ) {
          return { kind: 'unreplayable', reason: 'reply-missing', seq: event.seq };
        }
        turn = undefined;
        break;
      }
      case 'turn/failed': {
        turn = undefined;
        break;
      }
      case 'session/end-seed': {
        settle();
        turn = undefined;
        break;
      }
      default:
        // 只記日誌、不進模型的那些（命令、目標、todo、模式、用量、評分）。
        break;
    }
    previous = event;
  }
  if (modelRan !== undefined && !replied) {
    return { kind: 'unreplayable', reason: 'reply-missing', seq: modelRan };
  }
  settle();
  return { kind: 'replayed', messages: raw };
}
