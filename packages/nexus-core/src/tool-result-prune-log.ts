/**
 * 工具結果剪刀的決定在會話日誌裡的樣子，與把它們換上去的純函式
 * （[#1302](https://github.com/DemianLi/nexus-agent/issues/1302)，日誌格式 46）。
 *
 * 剪刀（{@link ./tool-result-pruner.ts}）剪的是**請求**，以前不寫日誌，所以從日誌推不回模型實際看到的那一份。現在剪的當下記一筆
 * `compaction/prune`（`session-log.ts`），**每顆工具結果只記一次，之後每次請求都沿用**——照 dsh 的 `compaction/prune`，落盤的替換是永久的。
 * 兩個讀者共用這個檔：請求端的剪刀（每次呼叫前讀日誌、把記過的換上去）與推導端的 `replayConversation`（`applyPrunes` 選項），
 * 所以**兩邊換出來的東西逐位元組相同**不是巧合，是同一個函式。
 *
 * ## 對得上才換
 *
 * 以 `callId`（`tool_call_id`）指到被剪的那則，**再比一次文字量**（`originalChars`）：有的供應商會重用 `tool_call_id`，
 * 訊息也可能在這之間被別人改過，不能把另一顆結果的剪法套上去。對不上就原樣放過，不拋。
 *
 * @module
 */

import { ToolMessage } from '@langchain/core/messages';
import type { BaseMessage, MessageContent } from '@langchain/core/messages';
import type { SessionEvent } from './session-log.js';

/**
 * 數 Unicode code point，不是 UTF-16 code unit。
 *
 * `'😀'.length` 是 2 但只有一個 code point；用 `.length` 去切會劈開代理對，剪出來的尾巴
 * 開頭會是一個孤兒 surrogate。字素叢集（emoji ＋ 修飾符）還是可能被切開，dsh 也一樣，
 * 那是它明文接受的代價。
 *
 * @param text - 要量的文字。
 * @returns code point 數。
 */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * 複合內容裡的一個區塊。走陣列那條時，只有 `type === 'text'` 的區塊算進預算、也只有它們會被剪；圖片之類的
 * **原序留著**（dsh 的 `measureContent`／`pruneContent` 同款）。
 */
export type ContentPart = Extract<BaseMessage['content'], readonly unknown[]>[number];
export type TextBlock = ContentPart & { type: 'text'; text: string };

export function isTextBlock(block: ContentPart): block is TextBlock {
  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === 'text' && typeof candidate.text === 'string';
}

/**
 * 量一則內容裡的文字總量。
 *
 * @param content - 工具結果的內容。
 * @returns 文字區塊的 code point 總數；非文字區塊算 0。
 */
export function measureToolResultContent(content: BaseMessage['content']): number {
  if (typeof content === 'string') return codePointLength(content);
  let chars = 0;
  for (const block of content) if (isTextBlock(block)) chars += codePointLength(block.text);
  return chars;
}

/** 日誌上記的一顆剪法：被剪之前的文字量，與剪完的內容。 */
export interface RecordedPrune {
  /** 剪之前的文字總量（Unicode code point，非文字區塊不算）。 */
  readonly originalChars: number;
  /** 剪過的內容。 */
  readonly content: MessageContent;
}

/** 日誌上記過的剪法，鍵是 `tool_call_id`。 */
export type RecordedPrunes = ReadonlyMap<string, RecordedPrune>;

/**
 * 從日誌讀出所有剪法。
 *
 * 同一顆結果記了不只一次（不該發生，崩潰重寫之類）時以**後記的**為準。
 *
 * @param events - 日誌事件，照 `seq` 排。
 * @returns 沒有 `compaction/prune` 就是空 Map。
 */
export function recordedPrunesOf(events: readonly SessionEvent[]): RecordedPrunes {
  const recorded = new Map<string, RecordedPrune>();
  for (const event of events) {
    if (event.type !== 'compaction/prune') continue;
    for (const result of (event as SessionEvent<'compaction/prune'>).data.results) {
      recorded.set(result.callId, {
        originalChars: result.originalChars,
        content: result.content,
      });
    }
  }
  return recorded;
}

/**
 * 把一則訊息換上記過的剪法。
 *
 * @param message - 任何一則訊息；不是工具結果的原樣回。
 * @param recorded - {@link recordedPrunesOf} 的結果。
 * @returns 換過的新 `ToolMessage`（只換 `content`，其餘欄位原樣）；沒記過、或文字量對不上就是**傳進來的那一則**。
 */
export function applyRecordedPrune(message: BaseMessage, recorded: RecordedPrunes): BaseMessage {
  if (!ToolMessage.isInstance(message)) return message;
  const prune = recorded.get(message.tool_call_id);
  if (prune === undefined) return message;
  if (measureToolResultContent(message.content) !== prune.originalChars) return message;
  // 先拷一份：日誌裡的事件是凍過的，建構子可能回頭改欄位（同 `fromLoggedMessage`）。
  return new ToolMessage({ ...message, content: structuredClone(prune.content) });
}

/**
 * 把一串訊息裡每一則記過的工具結果換上剪過的內容。
 *
 * @param messages - 原訊息串。
 * @param recorded - {@link recordedPrunesOf} 的結果。
 * @returns 一則都沒換時是**原本那個陣列**；否則長度與順序與輸入相同的新陣列。
 */
export function applyRecordedPrunes(
  messages: readonly BaseMessage[],
  recorded: RecordedPrunes,
): readonly BaseMessage[] {
  if (recorded.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    const replaced = applyRecordedPrune(message, recorded);
    if (replaced !== message) changed = true;
    return replaced;
  });
  return changed ? next : messages;
}
