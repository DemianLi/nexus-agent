/**
 * 從會話日誌推回模型的對話歷史——續接時灌回 graph state 的那一串
 * （[#306](https://github.com/DemianLi/nexus-agent/issues/306)）。
 *
 * ## 照 dsh 的哪一段
 *
 * dsh 的模型歷史由日誌推出來：`Session.deriveMessages()` 逐顆走 surface 上的節點，交給
 * `deriveEventMessage` 投影（`packages/core/session/src/index.ts:832`、`surface.ts:92`，`c291e79`）。
 * **我們沒有 surface 那一軸**（每顆事件上的 `surfaceOp`），所以「哪幾種事件產訊息」是型別
 * {@link ./session-log.ts | ModelVisibleEventType}（人打的字在 `turn/start`，模型回覆在
 * `assistant/message`，工具結果在 `tool/result`，外掛塞進對話的在 `user/message`，壓縮的摘要在
 * `compaction/summary`），迴圈先用守衛 `isModelVisibleEvent` 分兩支：子聯集那一支逐種窮舉
 * （`default` 是 `satisfies never`，同 dsh session-reference 的投影），其餘那一支只做記帳、
 * `default` 照舊不管（同 dsh 的 `deriveEventMessage`，因為詞彙可以被別的套件擴充）。
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
 * - **壓縮**：切點直接用在推出來的串上，**對不上就整串不灌**。`compaction/summary` 有兩種順序，**逐顆事件判**
 *   （帶 `beforeCall: true` 的是新的，格式 45，[#1301](https://github.com/DemianLi/nexus-agent/issues/1301)）：
 *   新的記在用到它的 `model/start` 之前，那一刻 state 還沒有這次呼叫的回覆，推出來的恰好是 `messagesBefore` 則；
 *   舊的記在那次呼叫的回覆之後（摘要器包在記回覆那一層外面），恰好是 `messagesBefore + 1` 則（實測）。兩種各自嚴格，
 *   不放寬成兩種都收（那等於拿掉對不齊的唯一防線）；同一份檔可以兩種都有（續寫舊檔時 header 的版本會被蓋掉）。
 *   兩種的切法相同：之後進來的訊息（包括那次呼叫的回覆）都接在切點之後。
 *
 * 第三件（80,000 字元以上的工具結果，模型看到的是基座換過的預覽）要知道組裝怎麼設，交給呼叫端，見
 * {@link ReplayOptions.toolResultAsSeen}。
 *
 * ## 空的助手訊息推導時丟掉，但切點的座標仍算它
 *
 * 沒有內容也沒有工具呼叫的助手訊息（撞輸出上限那一步，`max-tokens.ts` 清掉它的呼叫之後什麼都不剩）不進推出來的串，
 * 照 dsh 的 `deriveEventMessage`（`packages/core/session/src/surface.ts:136-142`，`d7432673886`）：內容長度為 0 就回 `null`，
 * 理由是它只承載撞上限那一步的用量，不能把沒有內容的一輪塞進供應商的對話。**不必補事件**：日誌上有它，是確定的。
 *
 * **但它在 graph state 裡有一格**，壓縮的 `messagesBefore` 與 `cutoffIndex` 是 state 的座標，所以丟掉要等切完：
 * {@link isEmptyAssistant} 的訊息先照樣進 `raw`（對則數、切點都算它），在 {@link settle} 把摘要與切點套完之後才濾掉。
 * 推出來的串因此比 state 少一則；灌回去之後 state 沒有它，**之後的切點以灌回去的那一串為座標**（下一節），所以
 * `session/end-seed` 的 settle 同樣濾掉。
 *
 * **舊日誌的一個縫**：這一版以前續接，灌回去的串帶著這則空訊息，那之後的壓縮記的座標比現在推出來的多一則——
 * 「空訊息在前、end-seed 在後、之後又壓縮」的舊檔會判成 `compaction-misaligned`（整串不灌，模型從空的開始），
 * 不會切錯地方。
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
 * **續接時當掉那一輪的補結寫回日誌**（[#721](https://github.com/DemianLi/nexus-agent/issues/721)）。
dsh 續接時把補的事件寫回日誌（`packages/core/agent-loop/src/index.ts:855-856`，`477b4f4`），冷讀時才只在記憶體裡補
（`packages/session-query/session-query/src/cold-read.ts`）。我們的寫回在 {@link ./interrupted-turn.ts}：當掉那一輪
沒配到結果的呼叫各補一顆錯誤 `tool/result`（記過 `tool/call` 的說結果不明，沒記過的說還沒開始），開著的 `model/start`
補 `model/end`，最後補 `turn/end {interrupted}`；寫回之後這裡讀到的是日誌上那些，句子同一句。
**沒記過 `tool/call` 的那種也寫回了**（卡上原本留的一條偏離，理由是我們的配對不變量；dsh 對合成的「還沒開始」結果明文放行，
`packages/core/session/src/invariant.ts:142-145`，不變量現在也放行，見 `invariant.ts`）。**記憶體裡補的 {@link closer} 還在**，
管的是另一種：一輪**收掉了**、結果卻沒到齊的那一批（停在核准點的輪，在我們的日誌上是收掉的——`interrupt/raised` 之後有
`turn/end`；以及舊檔），那種不在「開著的最後一輪」，不在寫回的射程。
 *
 * **補結可能落在 `session/end-seed` 之後**（舊檔「開著的輪＋end-seed、之後沒有新輪」，照 dsh 的掃描在 end-seed 不重設，
 * 補結接在 end-seed 後面，見 `interrupted-turn.ts`）。所以 end-seed 不能立刻把還沒配齊的那一批補完——補寫的結果可能緊跟在後面，
 * 補了兩次模型就會讀到兩顆同一個 callId 的結果。那一批留到下一則訊息進來（或整份推完）才補，這個時候後面有沒有補寫的結果就已經
 * 清楚了；對沒有補寫的舊檔，補出來的是同一組句子，只是晚一步。
 *
推出來的是確定的，同一份日誌推幾次都一樣，所以留在記憶體裡的那一種也不會漂。
 *
 * ## 推不出來就整串不灌
 *
 * #306 拍板 2：推不出完整的歷史，就不灌半截進去，模型從空的開始。見 {@link UnreplayableReason}。
 */

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

import { fromLoggedMessage } from './logged-message.js';
import { stampImageOrigin } from './image-offload.js';
import { humanMessageForTurnStart } from './message-source.js';
import { isModelVisibleEvent } from './session-log.js';
import type { SessionEvent } from './session-log.js';
import { TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN, toolFeedback } from './tool-events.js';

/**
 * 沒有內容也沒有工具呼叫的助手訊息：推導時不送，見檔頭。
 *
 * 內容空＝字串長度 0 或區塊陣列長度 0（照 dsh `content.length === 0`）。**只帶推理區塊的不算空**——
 * 它在 BaseMessage 這一層有區塊；送出時 `fetch` 層會另外收掉（`live-model.ts` 的 `withEmptyAssistantContent`），
 * 那一條不在這張卡。
 */
export function isEmptyAssistant(message: BaseMessage): boolean {
  return (
    AIMessage.isInstance(message) &&
    (message.tool_calls ?? []).length === 0 &&
    message.content.length === 0
  );
}

/** 記過 `tool/call`、結果沒記下來的那次。逐字照抄 dsh `repair.ts:106`。 */
export const TOOL_OUTCOME_UNKNOWN_TEXT =
  'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.';

/** 回覆裡要了、還沒記到 `tool/call` 的那次。逐字照抄 dsh `repair.ts:107`。 */
export const TOOL_NOT_STARTED_TEXT =
  'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.';

/**
 * 推不出完整歷史的原因。
 *
 * - `reply-missing`：一輪正常收尾、中間沒有中斷，卻一則模型回覆都沒有；**或是整份日誌有模型「正常回來」的呼叫
 *   （`model/end` 沒帶 `outcome`）、`tool/call`、或停在半路沒配到 `model/end` 的 `model/start`，卻一則回覆都沒有**。
 *   格式 8 以前的日誌不記回覆，正常收尾的每一輪都中第一道；每一輪都被中止、或唯一那一輪沒收尾的，第一道碰不到，
 *   由第二道接。9 以後只有回覆沒記進去才會。**格式版本判不出這件事**：續寫的把手第一次寫入時把 header 的
 *   `version` 蓋成這一版（`session-store.ts`），8 開頭、9 續寫的檔 header 是 9。
 *   **帶 `outcome` 的 `model/end`（`aborted`、`error`，#1022）不算**：那次呼叫沒有正常回來，本來就沒有回覆可記，
 *   線上的圖狀態也沒有——使用者的話留著，下一次請求照樣帶它（#1190）。`outcome` 是 #1022 才開始寫的選填格，
 *   舊日誌的 `model/end` 都沒有，所以放行不會誤放格式 8 以前漏記回覆的檔。
 * - `result-missing`：一顆 `tool/result` 沒帶 `message`——8 以前，或圍堵在回傳裡找不到那則訊息。
 * - `summary-missing`：一顆 `compaction/summary` 沒帶 `summary`——8 以前。
 * - `compaction-misaligned`：切點那一刻推出來的則數對不上（新順序 `messagesBefore`、舊順序 `messagesBefore + 1`），切下去會切錯地方。
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
  /**
   * 每從一顆事件推出一則訊息就叫一次，交出那則訊息與那顆事件。補上的結果（{@link TOOL_OUTCOME_UNKNOWN_TEXT}
   * 那兩句）不是從事件推出來的，不叫。
   *
   * 給要知道「推出來的串裡哪一則出自日誌哪一顆」的讀者：會話內容搜尋（`apps/harness` 的 `thread-search.ts`，
   * [#631](https://github.com/DemianLi/nexus-agent/issues/631)）拿它判哪幾顆還在模型看得到的那一串上，
   * 同 dsh 的 `foldSurface` 分 `current` 與 `shadowed`。拿到的是推出來的那一則本身（工具結果是換過預覽之後的），
   * 所以跟回傳的 `messages` 可以用物件身分對。
   */
  readonly origin?: (message: BaseMessage, event: SessionEvent) => void;
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
export function requestedCalls(message: BaseMessage): PendingBatch['calls'] {
  if (!AIMessage.isInstance(message)) return [];
  return (message.tool_calls ?? []).flatMap((call) =>
    call.id === undefined ? [] : [{ id: call.id, name: call.name }],
  );
}

/**
 * 沒配到結果的那次，照 dsh `repair.ts` 補一則錯誤結果。**不帶 `Error: `**：那兩句是 dsh 的作者寫好的
 * 回饋，走第二條政策（`tool-events.ts` 的 `toolRefusal`）。
 */
export function closer(
  call: { readonly id: string; readonly name: string },
  started: boolean,
): ToolMessage {
  return toolFeedback(started ? TOOL_OUTCOME_UNKNOWN_TEXT : TOOL_NOT_STARTED_TEXT, {
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
  /** 開著、還沒配到 `model/end` 的那顆 `model/start`。行程死在呼叫中途時一直留到最後。 */
  let openCall: number | undefined;
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
  /**
   * 這個生命週期到此為止：換成那時灌回去的那一串。
   *
   * @param keepBatch - end-seed 傳 `true`：還沒配齊的那一批留著，補寫的結果可能接在 end-seed 之後，見檔頭。
   */
  const settle = (keepBatch = false): void => {
    if (!keepBatch) flush();
    if (summary !== undefined) raw = [summary.message, ...raw.slice(summary.cutoff)];
    summary = undefined;
    // 切點是 state 的座標，空的助手訊息要等切完才濾（檔頭）。
    raw = raw.filter((message) => !isEmptyAssistant(message));
  };
  const asSeen = (message: BaseMessage): BaseMessage =>
    options.toolResultAsSeen !== undefined && ToolMessage.isInstance(message)
      ? options.toolResultAsSeen(message)
      : message;
  /** 這一則出自這一顆，見 {@link ReplayOptions.origin}。 */
  const from = <M extends BaseMessage>(message: M, event: SessionEvent): M => {
    // 含圖的訊息蓋上出自哪顆事件（#1270）：`image/offload` 的決定記的是「哪顆事件的第幾張圖」，續接後要靠它認回來。沒有圖的訊息不動。
    stampImageOrigin(message, event.seq);
    options.origin?.(message, event);
    return message;
  };

  for (const event of events) {
    // 先照型別分兩支（#681，照 dsh）：會進模型的那五種窮舉，其餘只做記帳。
    if (isModelVisibleEvent(event)) {
      switch (event.type) {
        case 'turn/start': {
          turn = { replied: false, interrupted: false };
          // `resume` 是回覆核准，沒有使用者說的話——送進圖的是 `Command`，不是一則訊息。
          if (event.data.kind !== 'resume') push(from(humanMessageForTurnStart(event.data), event));
          break;
        }
        case 'assistant/message': {
          replied = true;
          if (turn !== undefined) turn.replied = true;
          const message = from(fromLoggedMessage(event.data.message), event);
          const calls = requestedCalls(message);
          push(message);
          if (calls.length > 0) batch = { calls, results: new Map(), started: new Set() };
          break;
        }
        case 'tool/result': {
          if (event.data.message === undefined) {
            return { kind: 'unreplayable', reason: 'result-missing', seq: event.seq };
          }
          const message = from(asSeen(fromLoggedMessage(event.data.message)), event);
          if (batch?.calls.some((call) => call.id === event.data.callId) === true) {
            batch.results.set(event.data.callId, [message]);
          } else {
            push(message);
          }
          break;
        }
        case 'user/message': {
          const message = from(fromLoggedMessage(event.data.message), event);
          const { source } = event.data;
          // 緊跟在一顆結果後面、而且是那顆工具注入的：跟著那顆結果走。其餘的（repeat-reminder 的提醒、人插的話）
          // 在那一批之後。人插的話（#710）不屬於任何一顆工具，連比對都不比。
          const owner = previous?.type === 'tool/result' ? previous.data.callId : undefined;
          const call = batch?.calls.find((candidate) => candidate.id === owner);
          const results = call === undefined ? undefined : batch?.results.get(call.id);
          if (source.kind === 'plugin' && call?.name === source.plugin && results !== undefined) {
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
          // 新順序（`beforeCall`）記在這次呼叫的回覆之前，舊順序記在之後，所以差一則。
          const expected = event.data.beforeCall === true ? messagesBefore : messagesBefore + 1;
          if (raw.length + pendingCount() !== expected || cutoffIndex > messagesBefore) {
            return { kind: 'unreplayable', reason: 'compaction-misaligned', seq: event.seq };
          }
          summary = { message: from(fromLoggedMessage(logged), event), cutoff: cutoffIndex };
          break;
        }
        default:
          // 子聯集多一種而這裡沒有 case，這一行編不過。
          event satisfies never;
      }
    } else {
      switch (event.type) {
        case 'model/start': {
          openCall = event.seq;
          break;
        }
        case 'model/end': {
          // 沒正常回來的呼叫（`outcome`）沒有回覆可記，不算「模型跑過」。
          if (openCall !== undefined && event.data.outcome === undefined) modelRan ??= openCall;
          openCall = undefined;
          break;
        }
        case 'tool/call': {
          modelRan ??= event.seq;
          if (batch?.calls.some((call) => call.id === event.data.callId) === true) {
            batch.started.add(event.data.callId);
          }
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
          settle(true);
          turn = undefined;
          break;
        }
        default:
          // 只記日誌、不進模型的那些：哪幾種見 {@link ModelVisibleEventType} 以外的每一種。
          // 整個詞彙不逐種列舉（別的套件補進來的種類也走這裡）。
          break;
      }
    }
    previous = event;
  }
  // 停在半路的呼叫保守算跑過：續接時 `resumeClosingInterruptedTurn` 會先補一顆帶 `outcome` 的 `model/end`，
  // 所以走續接進來的讀不到這一種；沒補過的舊檔照舊拒推。
  modelRan ??= openCall;
  if (modelRan !== undefined && !replied) {
    return { kind: 'unreplayable', reason: 'reply-missing', seq: modelRan };
  }
  settle();
  return { kind: 'replayed', messages: raw };
}
