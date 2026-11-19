/**
 * 觀測分頁（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)、[#1034](https://github.com/DemianLi/nexus-agent/issues/1034)
 * 觀測那一半）怎麼把對話投成「一輪一組、依序一列一列」。UI/UX 的數值以 solid-glass 為準、Libraries.dev 只當元件多樣性與
 * 交互模式的參考，**不是照 dsh 的 `ui-trajectory` 畫時間線**（AGENTS.md「不在這條範圍內的」）。
 *
 * ## 兩種模式
 *
 * - **結構化**：有軌跡投影（#1027，`projections.trajectory`，閘門見 `trajectory-view.ts`）時，輪界、模型呼叫、重試、重複呼叫
 *   提醒、時刻與耗時都讀它。**條目（`entries`）仍是內文的來源**，投影只帶結構、不帶內文，用鍵指回來。
 * - **第 0 版**：沒有投影（舊伺服器、插件關了、拋過、版本不認得）時完全照 #1033 的做法：只有順序、以人那一句切輪，
 *   四條限制全寫在畫面上。
 *
 * ## 結構化模式怎麼把條目歸到輪（探針量過，即時與重新整理後各一次）
 *
 * | 條目 | 鍵 |
 * | --- | --- |
 * | 工具 | `tool-<callId>`（**不是** `callId` 本身） |
 * | 模型回覆 | `AiEntry.messageId` 等於投影的 `reply.messageId`；歷史的條目 id 另外是 `history-<reply.seq>` |
 * | 人的話 | **沒有鍵**：即時是 `inbox:<runId>`、歷史是 `history-<seq>`，而且 `turn.seq` 是 `turn/start` 的位置、不是人話的位置 |
 *
 * 所以**輪界由成員決定，不由人那一格決定**：先用鍵把工具與回覆歸進 `(輪, 呼叫)`，沒有鍵的「開輪條目」（人的話、結算通知、
 * 子代理來信）歸給**它後面第一個歸得進去的條目**所在的輪——**目標自己排的輪沒有人話，第一個成員就開了那一輪**，#1033 的
 * 限制 1 因此拿掉。其餘沒有鍵的（還在吐字的回覆、決定、壓縮、子代理自己的列）沿用前一個條目的位置：子代理的列照出現
 * 的先後交錯，跟第 0 版一樣（背景的子代理在別的輪之間冒出來是它們實際發生的順序，不硬搬回發起它的那一輪）。
 *
 * 兩個方向的對不上都有去處，不丟列：
 *
 * - **窗口之前的條目**（投影只帶最近幾輪）：已載入但不在任何一輪裡，照第 0 版以人那一句切成組，標「沒有結構資料」。
 * - **投影有、條目沒載入**的輪或呼叫：照樣畫輪的標題與呼叫段落，只是沒有內文可展開，並說明原因。呼叫段落照樣有定位鈕：
 *   按下去先往前載到那一輪（`loadThrough`，#1601）再定位。
 *   窗口更早的輪只剩 `digests` 的計數，畫成只有數字的摘要列；人要看（或「看這一輪」落在那裡）時向伺服器按需拉那一輪的細節
 *   （`features/trace/trajectory-pull.ts`），拉回來的併進去、原位取代那一列摘要。
 *
 * ## 事實讀投影，不讀條目
 *
 * 呼叫的起訖與耗時、工具的耗時取自投影：重新整理後條目上模型回覆的 `startedAt` 等於 `settledAt`（#1048），算出來是錯的。
 * 缺席的欄位寫 `—`，不補 0。
 *
 * **子代理自己的軌跡在 `subagentProjections[runId]`**（#1070）。子代理的條目列照舊以歸屬標籤夾在主對話的列之間；它內部的呼叫結構畫在
 * 派它的那顆工具底下（`features/trace/subagent.tsx`）。前景子代理的日誌沒有輪尾，被時鐘切斷的呼叫靠父輪的原因分開講，見 {@link cutByParentClock}。
 *
 * ## 第 0 版的切輪靠「人那一格」，而這會錯
 *
 * 沿用畫面按輪歸位的老規矩（`startsTurn`：人的話、背景子代理的結算通知與來信）。目標自己排的輪次沒有人話
 * （`apps/harness/src/conversation-history.ts`），那一輪的列會黏在前一輪後面；折疊器也沒有輪 id。
 *
 * ## 哪些條目長列、哪些不長
 *
 * | 條目 | 列 |
 * | --- | --- |
 * | 人的話、結算通知、子代理來信 | `input`／`notice`／`agent-message`，開一輪 |
 * | 模型回覆的推理、正文 | `thinking`、`reply`（空白的正文與推理都不長列，同對話區 `Entry` 的判準） |
 * | 回覆被打斷、撞輸出上限、出錯 | `ending` |
 * | 工具呼叫 | `tool`（`exit_plan_mode` 帶計劃結果；提問帶答案） |
 * | 核准的決定 | `decision` |
 * | 人答的提問 | **配得到提問卡的併進那一列**（答案優先讀工具結果文字，`AnswerEntry` 只是退路，同 `ToolCard`）；配不到的（放棄整組、舊日誌）才自己長一列 |
 * | 壓縮標記 | `compaction` |
 * | **交付檔（`deliverables`）與改動紀錄（`workspace-changes`）** | **不長列**：卡上沒列它們；交付由那顆 `present` 工具列看得到，改動紀錄只是指標。有測試釘住，免得被當成漏掉 |
 *
 * 結構化模式另外長三種不是條目的列：`call`（模型呼叫段落）、`retry`（重試）、`signal`（重複呼叫提醒、目標、計劃模式、
 * 待辦、停下來等人）。投影裡的壓縮不長列，因為對話裡那一則壓縮標記已經有一列。
 *
 * 輪的收尾（停止／失敗）除了回覆上的旗標，也讀最後一輪的 `status`：停在工具執行中被按停止的那一輪沒有「講到一半」的回覆，
 * 旗標標不到。**只有最新那一輪看得到這一格**——狀態是「現在」的事，更早的輪只剩工具卡上的失敗碼。
 *
 * @module
 */

import type { ConversationEntry, ConversationState } from '@nexus/wire';

import { closeWithStatus, waitingOf } from '@/features/trace/closing';
import { legacyGroups } from '@/features/trace/legacy';
import { itemsOf } from '@/features/trace/rows';
import { structuredTurns } from '@/features/trace/structured';
import { mergePulled } from '@/features/trace/trajectory-pull';
import type { PulledTurn } from '@/features/trace/trajectory-pull';
import { trajectoryOf } from '@/features/trace/trajectory-view';
import type { TraceModel, TraceRow, TraceTurn } from '@/features/trace/model';

// 型別與兩張字表搬到 `model.ts`、子代理的畫面形狀搬到 `subagent-view.ts`，這裡原樣再匯出，外面照舊從 `view.ts` 取。
export { CALL_OUTCOME_LABEL, ENDING_LABEL } from '@/features/trace/model';
export type {
  EndingReason,
  SnapshotReason,
  SnapshotState,
  TraceDigest,
  TraceModel,
  TraceRow,
  TraceTurn,
  TurnHead,
} from '@/features/trace/model';
export {
  cutByParentClock,
  subagentDigestHead,
  subagentTurnView,
} from '@/features/trace/subagent-view';
export type {
  SubagentCallView,
  SubagentToolView,
  SubagentTurnView,
} from '@/features/trace/subagent-view';

/** 找不到那一則時（沒載入、或那一則畫不出來）。說法沿用計劃分頁（`PLAN_TAB_MISSING_TEXT`）。 */
export const TRACE_TARGET_MISSING_TEXT =
  '這一則不在目前載入的對話裡。往上捲載入更早的對話，再從這裡定位。';

/**
 * 這一列要先往前載入對話才定位得到（#1601）：投影說這次呼叫有東西可看、卻沒有任何條目歸在它上面。
 * 載到它那一輪之後同一列（鍵不變）會有 `target`。
 */
export function loadsThrough(row: TraceRow): boolean {
  return row.kind === 'call' && row.target === undefined && row.hasContent && !row.loaded;
}

/** 投影有、條目沒載入的呼叫段落底下那一句。 */
export const TRACE_CALL_UNLOADED_TEXT = '這次呼叫的內文不在目前載入的對話裡。';

/**
 * 對話投成一輪一組的列，以及（結構化模式）窗口外那些輪的摘要。純函式，只看 `state` 與選配的、按需拉回來的輪（`features/trace/trajectory-pull.ts`）。
 *
 * 子代理的歸屬原樣帶著（`attribution`）；同一輪裡主對話與子代理的列照出現的先後交錯。
 */
export function traceModel(
  state: ConversationState,
  pulled?: ReadonlyMap<number, PulledTurn>,
): TraceModel {
  const items = itemsOf(state);
  const pushed = trajectoryOf(state);
  const merged =
    pushed === undefined
      ? undefined
      : pulled === undefined
        ? { view: pushed, placeholders: new Set<number>() }
        : mergePulled(pushed, pulled);
  const model: TraceModel =
    merged === undefined
      ? { structured: false, turns: legacyGroups(items), digests: [], omitted: 0 }
      : structuredTurns(state, items, merged.view, merged.placeholders);
  const last = model.turns.at(-1);
  if (last !== undefined) {
    const rows = [...last.rows];
    closeWithStatus(rows, state);
    const waiting = last.head === undefined ? undefined : waitingOf(state, last.head);
    if (rows.length !== last.rows.length || waiting !== undefined) {
      const next = {
        ...last,
        rows,
        ...(waiting === undefined || last.head === undefined
          ? {}
          : { head: { ...last.head, waiting } }),
      };
      return { ...model, turns: [...model.turns.slice(0, -1), next] };
    }
  }
  return model;
}

/**
 * 一則回覆（訊息 id）落在哪一輪：回那一組的 `seq`（`TokenMeterTurn.seq`、`reveal` 的鍵）。
 * 答不出就 `undefined`：條目不在這份對話裡、那一則歸不進投影的輪（窗口之前、投影還沒跟上）、或沒有軌跡投影（第 0 版的組沒有 `seq`）。
 * 續接併回前一輪的組，所以續接之後那一則的答案是併起來那一組。
 */
export function turnSeqOfMessage(
  model: TraceModel,
  entries: readonly ConversationEntry[],
  messageId: string,
): number | undefined {
  const entry = entries.find((e) => e.kind === 'ai' && e.messageId === messageId);
  if (entry === undefined) return undefined;
  return model.turns.find(
    (turn) => turn.seq !== undefined && turn.rows.some((row) => row.target === entry.id),
  )?.seq;
}

/** {@link traceModel} 的輪。 */
export function traceTurns(state: ConversationState): readonly TraceTurn[] {
  return traceModel(state).turns;
}

/**
 * 兩列畫出來會一樣嗎：每個欄位 `===`。條目沒變時折疊器留著同一個參照，所以沒動的列判得出來——串流中每一格只有正在長的
 * 那幾列要重畫，其餘的 `memo` 擋掉。投影的列只放原始值，理由見 `call` 那一列。
 */
export function sameRow(a: TraceRow, b: TraceRow): boolean {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}
