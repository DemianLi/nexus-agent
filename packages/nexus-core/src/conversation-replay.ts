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
 * {@link DeriveOptions.toolResultAsSeen}。
 *
 * ## 空的助手訊息推導時丟掉，但切點的座標仍算它
 *
 * 沒有內容也沒有工具呼叫的助手訊息（{@link isEmptyAssistant}；撞輸出上限那一步，`max-tokens.ts` 清掉它的呼叫之後什麼都不剩）不進推出來的串：
 * 它只承載撞上限那一步的用量，不能把沒有內容的一輪塞進供應商的對話。**不必補事件**：日誌上有它，是確定的。
 *
 * **但它在 graph state 裡有一格**，壓縮的 `messagesBefore` 與 `cutoffIndex` 是 state 的座標，所以丟掉要等切完：
 * {@link isEmptyAssistant} 的訊息先照樣進 `raw`（對則數、切點都算它），在 {@link settledMessages} 把摘要與切點套完之後才濾掉。
 * 推出來的串因此比 state 少一則；灌回去之後 state 沒有它，**之後的切點以灌回去的那一串為座標**（下一節），所以
 * `session/end-seed` 換串時同樣經 {@link settledMessages} 濾掉。
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
 * **配不到任何呼叫的結果（孤兒）照送**：推導只把日誌上有的推出來，不替它判對錯；今天送出前丟掉孤兒的是請求端的 `patchToolCallsMiddleware`。補結與孤兒的規則在推導端只有這一份：
 * 補的是 {@link ReplayFold.pendingMessages}（句子在 {@link closer}），孤兒在 `tool/result` 那一支。請求端的 `patchToolCallsMiddleware`
 * 是另一套（句子不同、孤兒丟掉）。TODO(#2355)：推導成為唯一來源時拿掉它，孤兒由哪一層擋要一起定。
 *
 * **續接時當掉那一輪的補結寫回日誌**（[#721](https://github.com/DemianLi/nexus-agent/issues/721)）。
dsh 續接時把補的事件寫回日誌（`packages/core/agent-loop/src/index.ts:855-856`，`477b4f4`），冷讀時才只在記憶體裡補
（`packages/session-query/session-query/src/cold-read.ts`）。我們的寫回在 {@link ./interrupted-turn.ts}：當掉那一輪
沒配到結果的呼叫各補一顆錯誤 `tool/result`（記過 `tool/call` 的說結果不明，沒記過的說還沒開始），開著的 `model/start`
補 `model/end`，最後補 `turn/end {interrupted}`；寫回之後這裡讀到的是日誌上那些，句子同一句。
**沒記過 `tool/call` 的那種也寫回了**（卡上原本留的一條偏離，理由是我們的配對不變量；dsh 對合成的「還沒開始」結果明文放行，
`packages/core/session/src/invariant.ts:142-145`，不變量現在也放行，見 `invariant.ts`）。**記憶體裡補的 {@link closer} 還在**，
管的是另一種：一輪**收掉了**、結果卻沒到齊的那一批（停在核准點的輪，在我們的日誌上是收掉的——`interrupt/raised` 之後有
`turn/end`；一輪失敗、當場補寫也失敗的；以及舊檔），那種不在「開著的最後一輪」，不在寫回的射程。
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

import {
  offloadedImagesOf,
  offloadLoggedMessages,
  stampLoggedImageOrigin,
} from './image-offload-log.js';
import { turnStartMessage } from './message-source.js';
import { nexusContent, nexusToolCalls } from './nexus-message.js';
import type { NexusMessage } from './nexus-message.js';
import { isModelVisibleEvent, snapshotJsonValue, storedEventDepth } from './session-log.js';
import type { SessionEvent } from './session-log.js';
import { errorResultFields, TOOL_NOT_STARTED, TOOL_OUTCOME_UNKNOWN } from './tool-error-codes.js';
import type { ToolErrorInfo } from './tool-error-codes.js';
import { recordedArgTruncationsOf, truncateLoggedMessages } from './tool-arg-truncation-log.js';
import { pruneLoggedMessages, recordedPrunesOf } from './tool-result-prune-log.js';

/**
 * 助手訊息的 content 是不是**一個字都沒有的陣列**：沒有任何一段非空白的文字。空白算空；有任何一段不是文字（推理、圖）就不算空。
 * 不是陣列（字串、`null`）一律不算。
 */
export function isBlankContentArray(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return !content.some((part: unknown) => {
    if (typeof part !== 'object' || part === null) return true;
    const { type, text } = part as { type?: unknown; text?: unknown };
    if (type !== 'text') return true;
    return typeof text === 'string' && text.trim().length > 0;
  });
}

/** 助手訊息的 content 是不是一個字都沒有，**不分形狀**：`null`、缺席、空白字串、{@link isBlankContentArray}。 */
export function isBlankContent(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === 'string') return content.trim() === '';
  return isBlankContentArray(content);
}

/**
 * 沒有內容也沒有工具呼叫的助手訊息：推導時不送，見檔頭。內容空的判法是 {@link isBlankContent}，與送出時 `fetch` 層整則拿掉的是同一支
 * （`live-model.ts` 的 `normalizeEmptyAssistantContent`）。**只帶推理區塊的不算空**：它的內容（{@link nexusContent} 讀出的那一份）有一段不是文字；轉成 wire 時推理不進 `content`，`fetch` 層照樣整則拿掉。
 */
export function isEmptyAssistant(message: NexusMessage): boolean {
  return (
    message.type === 'ai' &&
    nexusToolCalls(message).length === 0 &&
    isBlankContent(nexusContent(message))
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
export type DerivedConversation =
  | { readonly kind: 'replayed'; readonly messages: readonly NexusMessage[] }
  | { readonly kind: 'unreplayable'; readonly reason: UnreplayableReason; readonly seq: number };

/**
 * 推一份日誌的選項。全部省略時推出的是續接灌回 graph state 的那一份：原文、每則深拷。`apply*` 換成模型實際收到的那一份；
 * {@link DeriveOptions.readOnly}／{@link DeriveOptions.shareStored} 改掉拷法。
 */
export interface DeriveOptions {
  /**
   * 一則工具結果在模型那一格長什麼樣。省略即日誌裡記的那則原樣。
   *
   * 日誌記的是工具的輸出，模型看到的可能是基座換過的預覽（`session-log.ts` 的 `tool/result`）。重算要知道
   * 門檻與暫存路徑，那是組裝點的設定，所以由呼叫端給。
   */
  readonly toolResultAsSeen?: (message: NexusMessage) => NexusMessage;
  /**
   * 把日誌上 `compaction/prune` 記過的剪法套上去（[#1302](https://github.com/DemianLi/nexus-agent/issues/1302)），推出來的就是
   * **模型實際收到的那一份**：被剪的工具結果是剪過的內容。省略即不套——續接灌回 graph state 的那一串要留原文（剪刀下一次請求會照日誌
   * 換上去，見 `tool-result-pruner.ts`），會話內容搜尋要搜原文。
   *
   * 套用時 `origin` 交出的仍是套用**之前**那一則（物件身分對不上回傳串裡被換掉的那幾則）；要用 `origin` 的讀者本來就不該套。
   */
  readonly applyPrunes?: boolean;
  /**
   * 把日誌上 `compaction/truncate-args` 記過的縮短套上去（[#1303](https://github.com/DemianLi/nexus-agent/issues/1303)），推出來的就是
   * **模型實際收到的那一份**：被縮短的舊 `write_file`／`edit_file` 參數是縮短後的字串。理由與預設同 {@link applyPrunes}——續接灌回 graph state 的
   * 那一串要留原文（請求端照日誌換上去，見 `summarization.ts` 的 `withArgTruncationLog`），會話內容搜尋要搜原文。
   *
   * 套用時 `origin` 交出的仍是套用**之前**那一則（物件身分對不上回傳串裡被換掉的那幾則）。
   */
  readonly applyArgTruncations?: boolean;
  /**
   * 把日誌上 `image/offload` 記過的省略套上去（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)），推出來的就是**模型實際收到的那一份**：
   * 被省略的圖標成 `offloaded`。決定落在哪都認（`model/start` 之前或之後），只看它在不在 `events` 裡。理由與預設同 {@link applyPrunes}——
   * 續接灌回 graph state 的那一串留原樣（請求端照日誌標上，見 `image-offload.ts` 的 `createImageOffloadMiddleware`）。
   *
   * 套用時 `origin` 交出的仍是套用**之前**那一則。
   */
  readonly applyImageOffloads?: boolean;
  /**
   * 每從一顆事件推出一則訊息就叫一次，交出那則訊息與那顆事件。補上的結果（{@link TOOL_OUTCOME_UNKNOWN_TEXT}
   * 那兩句）不是從事件推出來的，不叫。
   *
   * 給要知道「推出來的串裡哪一則出自日誌哪一顆」的讀者：會話內容搜尋（`apps/harness` 的 `thread-search.ts`，
   * [#631](https://github.com/DemianLi/nexus-agent/issues/631)）拿它判哪幾顆還在模型看得到的那一串上，
   * 同 dsh 的 `foldSurface` 分 `current` 與 `shadowed`。拿到的是推出來的那一則本身（工具結果是換過預覽之後的），
   * 所以跟回傳的 `messages` 可以用物件身分對。
   */
  readonly origin?: (message: NexusMessage, event: SessionEvent) => void;
  /**
   * 只看推不推得回來（`kind`、`reason`），推出來的訊息讀完就丟：日誌記的每一則原樣交出日誌上那個物件，不深拷；含圖片區塊的那則換成淺拷、加上來源記號（巢狀的值仍與日誌共用）。
   * 給判斷是不是舊日誌的讀者（`apps/harness` 的 `isLegacyLog`）。回傳串或 {@link origin} 交出的訊息要留下來、交給 graph state 或模型的，不能開。
   */
  readonly readOnly?: boolean;
  /**
   * 讀盤共用過的事件（{@link storedEventDepth} 有值，整張深凍過）原樣交出日誌上那個物件，不深拷（含圖片區塊的同 {@link DeriveOptions.readOnly}）；
   * 其餘的事件深拷一份（`snapshotJsonValue`）。推出來的可以交給 graph state：下游就地改巢狀的值會當場拋，不會改到日誌。給續接灌回 graph state 的讀者
   * （`apps/harness` 的 `restoreConversation`）。
   */
  readonly shareStored?: boolean;
}

/** 一則回覆要了、還在等結果的那一批。 */
interface PendingBatch {
  /** 照回覆裡 `tool_calls` 的順序。 */
  readonly calls: readonly { readonly id: string; readonly name: string }[];
  /** callId → 那顆結果，加上跟著它注入的訊息。 */
  readonly results: Map<string, NexusMessage[]>;
  /** 記過 `tool/call` 的。補結果時據此挑 dsh 的哪一句。 */
  readonly started: Set<string>;
}

/** 一則回覆要了哪幾次呼叫，照順序。沒有 id 的配不到結果，不算。 */
export function requestedCalls(message: NexusMessage): PendingBatch['calls'] {
  return nexusToolCalls(message).flatMap((call) =>
    call.id === undefined ? [] : [{ id: call.id, name: call.name }],
  );
}

/**
 * 沒配到結果的那次補的一則錯誤結果（欄位由 {@link errorResultFields} 建）。**不帶 `Error: `**：那兩句是寫好的回饋，不是拒絕
 * （前綴政策見 `tool-events.ts` 的 `toolRefusal`）。錯誤碼不在訊息上：寫日誌用 {@link closerError}，轉成 `ToolMessage` 時由
 * {@link closerErrorOf} 認回，只認這個實例。
 */
export function closer(
  call: { readonly id: string; readonly name: string },
  started: boolean,
): NexusMessage {
  const message: NexusMessage = {
    type: 'tool',
    data: {
      ...errorResultFields(started ? TOOL_OUTCOME_UNKNOWN_TEXT : TOOL_NOT_STARTED_TEXT, {
        callId: call.id,
        name: call.name,
      }),
      additional_kwargs: {},
      response_metadata: {},
    } as NexusMessage['data'],
  };
  closerErrors.set(message, closerError(started));
  return message;
}

/** {@link closer} 造的那幾則各自的錯誤資訊。碼不寫進訊息本身（理由見 `tool-events.ts` 檔頭〈碼怎麼從內層走到外層〉）；轉成 `ToolMessage` 時由轉接器（`toBaseMessage`）掛回去，拷過的那一則認不回。 */
const closerErrors = new WeakMap<NexusMessage, ToolErrorInfo>();

/** 這則是不是 {@link closer} 造的；是的話回它的錯誤資訊。 */
export function closerErrorOf(message: NexusMessage): ToolErrorInfo | undefined {
  return closerErrors.get(message);
}

/** {@link closer} 那一則對應的錯誤資訊，寫進 `tool/result` 的 `error`。 */
export function closerError(started: boolean): ToolErrorInfo {
  return started
    ? { name: 'ToolOutcomeUnknownError', code: TOOL_OUTCOME_UNKNOWN }
    : { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED };
}

/** 這個生命週期最後一次壓縮：摘要那一則與切點（原始訊息串的索引）。 */
export interface ReplaySummary {
  readonly message: NexusMessage;
  readonly cutoff: number;
}

/**
 * 逐顆事件推歷史的狀態，可以接著餵：{@link deriveConversation} 從頭餵一次，`model-history.ts` 的增量推導每次只餵新的事件。
 * 兩者共用這一份規則，所以同一串事件推出來的 {@link ReplayFold.raw}、{@link ReplayFold.summary}、{@link ReplayFold.pendingMessages} 一樣。
 *
 * 推到一處要取結果：先看 {@link ReplayFold.finalFailure}，沒有再拿 {@link ReplayFold.settled}。`options` 的 `applyPrunes`／`applyArgTruncations`
 * 這裡不套：剪法與縮短要整份事件才知道，記在後面的會回頭改前面的那幾則，由呼叫端在 `settled()` 之後套。
 */
export class ReplayFold {
  #raw: NexusMessage[] = [];
  #summary: ReplaySummary | undefined;
  #failure: { readonly reason: UnreplayableReason; readonly seq: number } | undefined;
  #batch: PendingBatch | undefined;
  /** 開著的那一輪有沒有回覆、有沒有停下來等人。 */
  #turn: { replied: boolean; interrupted: boolean } | undefined;
  #previous: SessionEvent | undefined;
  /** 第一顆「模型跑過」的事件。見 {@link UnreplayableReason}。 */
  #modelRan: number | undefined;
  /** 開著、還沒配到 `model/end` 的那顆 `model/start`。行程死在呼叫中途時一直留到最後。 */
  #openCall: number | undefined;
  /** 整份日誌有沒有任何一則回覆。 */
  #replied = false;
  readonly #options: DeriveOptions;

  constructor(options: DeriveOptions = {}) {
    this.#options = options;
  }

  /** 這個生命週期的原始訊息串，與 graph state 的 `messages` 同一組座標。只會往後接，`session/end-seed` 時整串換掉。 */
  get raw(): readonly NexusMessage[] {
    return this.#raw;
  }

  /** 這個生命週期最後一次壓縮。 */
  get summary(): ReplaySummary | undefined {
    return this.#summary;
  }

  /** 第一顆推不下去的事件；有值之後 {@link ReplayFold.feed} 不再看事件。 */
  get failure(): { readonly reason: UnreplayableReason; readonly seq: number } | undefined {
    return this.#failure;
  }

  /** 還在等結果的那一批照 `tool_calls` 的順序排好、缺的補上之後的樣子。不改狀態：之後到的結果還會換掉補上的那幾則。 */
  pendingMessages(): NexusMessage[] {
    const batch = this.#batch;
    if (batch === undefined) return [];
    return batch.calls.flatMap(
      (call) => batch.results.get(call.id) ?? [closer(call, batch.started.has(call.id))],
    );
  }

  /**
   * 推到這裡為止的拒推原因：中途的 {@link ReplayFold.failure}；沒有的話，看整份日誌層級那一道（模型跑過卻一則回覆都沒有，
   * 見 {@link UnreplayableReason} 的 `reply-missing`）。不改狀態。
   */
  finalFailure(): { readonly reason: UnreplayableReason; readonly seq: number } | undefined {
    if (this.#failure !== undefined) return this.#failure;
    // 停在半路的呼叫保守算跑過：續接時 `resumeClosingInterruptedTurn` 會先補一顆帶 `outcome` 的 `model/end`，
    // 所以走續接進來的讀不到這一種；沒補過的舊檔拒推。
    const modelRan = this.#modelRan ?? this.#openCall;
    return modelRan !== undefined && !this.#replied
      ? { reason: 'reply-missing', seq: modelRan }
      : undefined;
  }

  /** 推到這裡為止的那一串，不改狀態：等於這時候收尾（補齊那一批、套摘要、濾掉空的助手訊息）。 */
  settled(): NexusMessage[] {
    return settledMessages([...this.#raw, ...this.pendingMessages()], this.#summary);
  }

  /** 餵一顆事件；推不下去就記進 {@link ReplayFold.failure}，有值之後不做事。 */
  feed(event: SessionEvent): void {
    if (this.#failure !== undefined) return;
    const fail = (reason: UnreplayableReason): void => {
      this.#failure = { reason, seq: event.seq };
    };
    // 先照型別分兩支（#681，照 dsh）：會進模型的那五種窮舉，其餘只做記帳。
    if (isModelVisibleEvent(event)) {
      switch (event.type) {
        case 'turn/start': {
          this.#turn = { replied: false, interrupted: false };
          // `resume` 是回覆核准，沒有使用者說的話——送進圖的是 `Command`，不是一則訊息。
          if (event.data.kind !== 'resume') {
            this.#push(this.#from(turnStartMessage(event.data), event));
          }
          break;
        }
        case 'assistant/message': {
          this.#replied = true;
          if (this.#turn !== undefined) this.#turn.replied = true;
          const message = this.#from(this.#read(event.data.message, event), event);
          const calls = requestedCalls(message);
          this.#push(message);
          if (calls.length > 0) this.#batch = { calls, results: new Map(), started: new Set() };
          break;
        }
        case 'tool/result': {
          if (event.data.message === undefined) return fail('result-missing');
          const message = this.#from(this.#asSeen(this.#read(event.data.message, event)), event);
          if (this.#batch?.calls.some((call) => call.id === event.data.callId) === true) {
            this.#batch.results.set(event.data.callId, [message]);
          } else {
            this.#push(message);
          }
          break;
        }
        case 'user/message': {
          const message = this.#from(this.#read(event.data.message, event), event);
          const { source } = event.data;
          // 緊跟在一顆結果後面、而且是那顆工具注入的：跟著那顆結果走。其餘的（repeat-reminder 的提醒、人插的話）
          // 在那一批之後。人插的話（#710）不屬於任何一顆工具，連比對都不比。
          const previous = this.#previous;
          const owner = previous?.type === 'tool/result' ? previous.data.callId : undefined;
          const call = this.#batch?.calls.find((candidate) => candidate.id === owner);
          const results = call === undefined ? undefined : this.#batch?.results.get(call.id);
          if (source.kind === 'plugin' && call?.name === source.plugin && results !== undefined) {
            results.push(message);
          } else {
            this.#push(message);
          }
          break;
        }
        case 'compaction/summary': {
          const { summary: logged, cutoffIndex, messagesBefore } = event.data;
          if (logged === undefined) {
            return fail('summary-missing');
          }
          // 新順序（`beforeCall`）記在這次呼叫的回覆之前，舊順序記在之後，所以差一則。
          const expected = event.data.beforeCall === true ? messagesBefore : messagesBefore + 1;
          if (
            this.#raw.length + this.#pendingCount() !== expected ||
            cutoffIndex > messagesBefore
          ) {
            return fail('compaction-misaligned');
          }
          this.#summary = {
            message: this.#from(this.#read(logged, event), event),
            cutoff: cutoffIndex,
          };
          break;
        }
        default:
          // 子聯集多一種而這裡沒有 case，這一行編不過。
          event satisfies never;
      }
    } else {
      switch (event.type) {
        case 'model/start': {
          this.#openCall = event.seq;
          break;
        }
        case 'model/end': {
          // 沒正常回來的呼叫（`outcome`）沒有回覆可記，不算「模型跑過」。
          if (this.#openCall !== undefined && event.data.outcome === undefined) {
            this.#modelRan ??= this.#openCall;
          }
          this.#openCall = undefined;
          break;
        }
        case 'tool/call': {
          this.#modelRan ??= event.seq;
          if (this.#batch?.calls.some((call) => call.id === event.data.callId) === true) {
            this.#batch.started.add(event.data.callId);
          }
          break;
        }
        case 'interrupt/raised': {
          if (this.#turn !== undefined) this.#turn.interrupted = true;
          break;
        }
        case 'turn/end': {
          // 停在核准點的那一輪可以沒有回覆：答掉一顆之後，同一批沒被答到的會在叫模型之前再度中斷。
          // 被中止的那一輪同理（停在核准點時按停止，由 pump 收回）。
          const turn = this.#turn;
          if (
            turn !== undefined &&
            event.data.reason === undefined &&
            !turn.replied &&
            !turn.interrupted
          ) {
            return fail('reply-missing');
          }
          this.#turn = undefined;
          break;
        }
        case 'turn/failed': {
          this.#turn = undefined;
          break;
        }
        case 'session/end-seed': {
          // 這個生命週期到此為止：換成那時灌回去的那一串。還沒配齊的那一批留著，補寫的結果可能接在 end-seed 之後，見檔頭。
          this.#raw = settledMessages(this.#raw, this.#summary);
          this.#summary = undefined;
          this.#turn = undefined;
          break;
        }
        default:
          // 只記日誌、不進模型的那些：哪幾種見 {@link ModelVisibleEventType} 以外的每一種。
          // 整個詞彙不逐種列舉（別的套件補進來的種類也走這裡）。
          break;
      }
    }
    this.#previous = event;
  }

  #pendingCount(): number {
    return [...(this.#batch?.results.values() ?? [])].reduce(
      (sum, messages) => sum + messages.length,
      0,
    );
  }

  /** 那一批照 `tool_calls` 的順序放進去，缺的補上，再接這一則。 */
  #push(message: NexusMessage): void {
    this.#raw.push(...this.pendingMessages(), message);
    this.#batch = undefined;
  }

  #read(logged: NexusMessage, event: SessionEvent): NexusMessage {
    return this.#options.readOnly === true ||
      (this.#options.shareStored === true && storedEventDepth(event) !== undefined)
      ? logged
      : (snapshotJsonValue(logged, '日誌訊息') as NexusMessage);
  }

  #asSeen(message: NexusMessage): NexusMessage {
    return this.#options.toolResultAsSeen !== undefined && message.type === 'tool'
      ? this.#options.toolResultAsSeen(message)
      : message;
  }

  /** 這一則出自這一顆，見 {@link DeriveOptions.origin}。 */
  #from(message: NexusMessage, event: SessionEvent): NexusMessage {
    // 含圖的訊息蓋上出自哪顆事件（#1270）：`image/offload` 的決定記的是「哪顆事件的第幾張圖」，續接後要靠它認回來。沒有圖的訊息不動。
    const stamped = stampLoggedImageOrigin(message, event.seq);
    this.#options.origin?.(stamped, event);
    return stamped;
  }
}

/** 套摘要，再濾掉空的助手訊息：切點是 state 的座標，空的助手訊息要等切完才濾（檔頭）。增量推導（`model-history.ts`）逐段借用。 */
export function settledMessages(
  messages: readonly NexusMessage[],
  summary: ReplaySummary | undefined,
): NexusMessage[] {
  const cut =
    summary === undefined ? messages : [summary.message, ...messages.slice(summary.cutoff)];
  return cut.filter((message) => !isEmptyAssistant(message));
}

/**
 * 把一份 root 日誌推回模型的對話歷史。
 *
 * @param events - root 那一份日誌的全部事件，照 `seq` 排（續接時讀回來的那些）。
 * @param options - 見 {@link DeriveOptions}。
 * @returns 要灌回 graph state 的那一串（壓縮過就是摘要加之後的），或推不出來的原因。
 */
export function deriveConversation(
  events: readonly SessionEvent[],
  options: DeriveOptions = {},
): DerivedConversation {
  const fold = new ReplayFold(options);
  for (const event of events) {
    fold.feed(event);
    if (fold.failure !== undefined) break;
  }
  const failure = fold.finalFailure();
  if (failure !== undefined) return { kind: 'unreplayable', ...failure };
  let messages: readonly NexusMessage[] = fold.settled();
  if (options.applyPrunes === true) {
    messages = pruneLoggedMessages(messages, recordedPrunesOf(events));
  }
  if (options.applyArgTruncations === true) {
    messages = truncateLoggedMessages(messages, recordedArgTruncationsOf(events));
  }
  if (options.applyImageOffloads === true) {
    messages = offloadLoggedMessages(messages, offloadedImagesOf(events));
  }
  return { kind: 'replayed', messages: [...messages] };
}
