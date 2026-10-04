/**
 * **把一份日誌上的事件歸到它所屬的那次模型呼叫**（[#1021](https://github.com/DemianLi/nexus-agent/issues/1021)）。
 *
 * 一次呼叫是它的 `model/start`（識別就是那顆的 `seq`，見 {@link ./model-call-scope.ts}）；`model/end`、`model/usage`、
 * `llm/retry*`、`assistant/message`、`context/measure` 靠各自的 `modelCall` 指回去，`tool/call`／`tool/result`
 * 靠 `callId` 指回「發出它的那則回覆」。**不看位置**：一對起訖之間夾了什麼、量測寫在哪一顆後面，都不影響歸屬。
 *
 * ## 為什麼不能看位置（三個真實日誌的反例）
 *
 * 1. `session/title-llm-request`（標題模型，背景跑）落在主呼叫那一對起訖**之間**——位置會把標題請求算成主呼叫的一部分。
 * 2. `inbox/spliced`（子代理回報進佇列）落在另一對起訖裡。
 * 3. `context/measure` 量的是**送出之前**的那份請求，卻寫在 `model/end` **之後**——位置會把它歸給下一次呼叫。
 *
 * 前兩個本來就不屬於任何一次呼叫，所以不出現在任何 {@link ModelCallRecord} 裡（它們沒有 `modelCall`，也不是這支函式管的種類）；
 * 第三個靠 `modelCall` 歸對。
 *
 * ## 舊日誌與歸不到的
 *
 * 沒有 `modelCall` 的事件（這一版以前寫的、或寫入點不在呼叫範圍裡）**不猜**：進 {@link ModelCallIndex.unattributed}，
 * 讀的人標「—」，不是 0、也不是「推測屬於最近那一次」。指向一顆不存在或不是 `model/start` 的 `seq`（分頁截掉了前面）同理。
 * 舊日誌的 `model/start` 照樣成一筆 {@link ModelCallRecord}，只是它的 `end`／`usage`／回覆都是空的——**那不是沒有，是沒記**。
 *
 * ## 工具怎麼歸
 *
 * `tool/call` 沒有自己的 `modelCall`：它的 `callId` 本來就出現在發出它的那則 `assistant/message` 的 `tool_calls[].id`，
 * 這是內容上的確定連結。供應商若在不同回覆重用同一個 id（有的端點每則都從 `call_0` 起算），取**最近一則**帶這個 id 的回覆
 * ——工具永遠跑在發出它的回覆之後、下一則回覆之前。那則回覆沒有 `modelCall`（舊日誌）時，這個 id 歸不到，而且**不會落回更早的同 id 回覆**。
 *
 * @module
 */

import { AIMessage } from '@langchain/core/messages';
import { fromLoggedMessage } from './logged-message.js';
import type { SessionEvent } from './session-log.js';

/** 一次模型呼叫與歸給它的事件，都照日誌順序。 */
export interface ModelCallRecord {
  /** 識別，也就是 `start.seq`。 */
  readonly modelCall: number;
  readonly start: SessionEvent<'model/start'>;
  /** 配對的結尾；沒有＝行程在呼叫中途死了，或這顆是舊日誌的（沒記識別）。 */
  readonly end: SessionEvent<'model/end'> | undefined;
  readonly usage: readonly SessionEvent<'model/usage'>[];
  /** `llm/retry`：每一次排定的重試。第一次嘗試本身沒有事件。 */
  readonly retries: readonly SessionEvent<'llm/retry'>[];
  readonly retryStarts: readonly SessionEvent<'llm/retry-started'>[];
  /** 回覆；被人按停止切斷的那半段（`interrupted`）也在這裡，在正常回覆之後。 */
  readonly replies: readonly SessionEvent<'assistant/message'>[];
  /** 摘要器量這次請求的那一顆（`context/measure`）。 */
  readonly measures: readonly SessionEvent<'context/measure'>[];
  readonly toolCalls: readonly SessionEvent<'tool/call'>[];
  readonly toolResults: readonly SessionEvent<'tool/result'>[];
}

/** {@link indexModelCalls} 的結果。 */
export interface ModelCallIndex {
  /** 每個 `model/start` 一筆，照 `seq`。 */
  readonly calls: readonly ModelCallRecord[];
  /** 這支函式管的種類裡**歸不到**任何一次呼叫的事件，照日誌順序。 */
  readonly unattributed: readonly SessionEvent[];
}

interface MutableRecord {
  modelCall: number;
  start: SessionEvent<'model/start'>;
  end: SessionEvent<'model/end'> | undefined;
  usage: SessionEvent<'model/usage'>[];
  retries: SessionEvent<'llm/retry'>[];
  retryStarts: SessionEvent<'llm/retry-started'>[];
  replies: SessionEvent<'assistant/message'>[];
  measures: SessionEvent<'context/measure'>[];
  toolCalls: SessionEvent<'tool/call'>[];
  toolResults: SessionEvent<'tool/result'>[];
}

/** 一則回覆發出的工具呼叫 id；讀不出來（壞掉的訊息）當作沒有。 */
function toolCallIds(event: SessionEvent<'assistant/message'>): readonly string[] {
  try {
    const message = fromLoggedMessage(event.data.message);
    if (!AIMessage.isInstance(message)) return [];
    return (message.tool_calls ?? []).flatMap((each) =>
      typeof each.id === 'string' && each.id !== '' ? [each.id] : [],
    );
  } catch {
    return [];
  }
}

/** {@link createModelCallIndexer} 的產物。 */
export interface ModelCallIndexer {
  /** 折進一顆事件（照 `seq` 的順序）。每顆 O(1)，所以長會話可以逐顆折、不必每顆重折全部。 */
  push(event: SessionEvent): void;
  /** 目前為止的歸屬。回的陣列是活的（之後的 `push` 會長進去），呼叫端不要改。 */
  result(): ModelCallIndex;
}

/**
 * 增量版：一顆一顆折，隨時讀結果。軌跡投影（#1027）的 `apply` 用它；{@link indexModelCalls} 就是把整串推進去，
 * 所以**歸屬邏輯只有這一份**，即時與歷史不會各寫一次。
 */
export function createModelCallIndexer(): ModelCallIndexer {
  const bySeq = new Map<number, MutableRecord>();
  const order: MutableRecord[] = [];
  const unattributed: SessionEvent[] = [];
  // 工具呼叫 id → 發出它的那次呼叫；值是 `undefined` 表示最近一則帶這個 id 的回覆歸不到（舊日誌）。
  const owner = new Map<string, MutableRecord | undefined>();

  const attach = <T extends SessionEvent>(
    event: T,
    modelCall: number | undefined,
    put: (record: MutableRecord, event: T) => void,
  ): MutableRecord | undefined => {
    const record = modelCall === undefined ? undefined : bySeq.get(modelCall);
    if (record === undefined) unattributed.push(event);
    else put(record, event);
    return record;
  };

  const push = (event: SessionEvent): void => {
    switch (event.type) {
      case 'model/start': {
        const start = event as SessionEvent<'model/start'>;
        const record: MutableRecord = {
          modelCall: start.seq,
          start,
          end: undefined,
          usage: [],
          retries: [],
          retryStarts: [],
          replies: [],
          measures: [],
          toolCalls: [],
          toolResults: [],
        };
        bySeq.set(start.seq, record);
        order.push(record);
        break;
      }
      case 'model/end': {
        const each = event as SessionEvent<'model/end'>;
        attach(each, each.data.modelCall, (record, e) => {
          record.end = e;
        });
        break;
      }
      case 'model/usage': {
        const each = event as SessionEvent<'model/usage'>;
        attach(each, each.data.modelCall, (record, e) => record.usage.push(e));
        break;
      }
      case 'llm/retry': {
        const each = event as SessionEvent<'llm/retry'>;
        attach(each, each.data.modelCall, (record, e) => record.retries.push(e));
        break;
      }
      case 'llm/retry-started': {
        const each = event as SessionEvent<'llm/retry-started'>;
        attach(each, each.data.modelCall, (record, e) => record.retryStarts.push(e));
        break;
      }
      case 'context/measure': {
        const each = event as SessionEvent<'context/measure'>;
        attach(each, each.data.modelCall, (record, e) => record.measures.push(e));
        break;
      }
      case 'assistant/message': {
        const each = event as SessionEvent<'assistant/message'>;
        const record = attach(each, each.data.modelCall, (r, e) => r.replies.push(e));
        // 歸不到的回覆也要蓋掉同 id 較早的歸屬，否則它發出的工具會落到更早一次呼叫上。
        for (const id of toolCallIds(each)) owner.set(id, record);
        break;
      }
      case 'tool/call': {
        const each = event as SessionEvent<'tool/call'>;
        const record = owner.get(each.data.callId);
        if (record === undefined) unattributed.push(each);
        else record.toolCalls.push(each);
        break;
      }
      case 'tool/result': {
        const each = event as SessionEvent<'tool/result'>;
        const record = owner.get(each.data.callId);
        if (record === undefined) unattributed.push(each);
        else record.toolResults.push(each);
        break;
      }
      default:
        break;
    }
  };
  return { push, result: () => ({ calls: order, unattributed }) };
}

/**
 * 把一份日誌的事件歸到它們的模型呼叫。純函式，一趟走完，成本隨事件數線性。
 *
 * @param events - 一份日誌的事件，照 `seq` 排（可以是從中間切開的一段）。
 */
export function indexModelCalls(events: readonly SessionEvent[]): ModelCallIndex {
  const indexer = createModelCallIndexer();
  for (const event of events) indexer.push(event);
  return indexer.result();
}
