/**
 * `image/offload` 在會話日誌裡的樣子，與把決定標上去的純函式（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）。
 *
 * 兩個讀者共用「標哪幾張」的規則（{@link offloadedContent}）：請求端（`image-offload.ts` 的 middleware，在 `BaseMessage` 上標）與推導端
 * （`conversation-replay.ts` 的 `applyImageOffloads`、`model-history.ts`，在 {@link NexusMessage} 上標，{@link offloadLoggedMessages}）。
 * 決定怎麼下、額度怎麼量見 {@link ./image-offload.ts}。
 *
 * @module
 */

import { isImageBlock } from './attachment-ref.js';
import type { ImageBlock } from './attachment-ref.js';
import { nexusContent } from './nexus-message.js';
import type { MessageContent, NexusMessage } from './nexus-message.js';
import type { SessionEvent } from './session-log.js';

/** 訊息 `additional_kwargs` 上記「這則訊息出自日誌的哪一顆事件」的鍵。只蓋在含圖片區塊的訊息上。 */
export const IMAGE_ORIGIN_KEY = 'nexus_event_seq';

/** 日誌上一格決定：這則訊息（出自哪顆事件）的哪幾張圖被省略。 */
export interface ImageOffloadTarget {
  readonly seq: number;
  readonly imageIndexes: readonly number[];
}

/** 訊息內容裡由前往後的圖片區塊，連同它在這則訊息裡的位置（含已省略者）。 */
export interface ImageOccurrence {
  readonly imageIndex: number;
  readonly block: ImageBlock;
}

/** 一則訊息內容裡的圖片區塊，由前往後。位置從 0 數，算上已省略的。不是陣列的內容沒有圖。 */
export function imageOccurrencesIn(content: unknown): ImageOccurrence[] {
  const found: ImageOccurrence[] = [];
  if (!Array.isArray(content)) return found;
  let imageIndex = 0;
  for (const block of content as readonly unknown[]) {
    if (!isImageBlock(block)) continue;
    found.push({ imageIndex, block });
    imageIndex += 1;
  }
  return found;
}

/** `additional_kwargs` 上的來源記號；沒有、或不是非負整數回 `undefined`。 */
export function imageOriginIn(additionalKwargs: unknown): number | undefined {
  const value = (additionalKwargs as Record<string, unknown> | undefined)?.[IMAGE_ORIGIN_KEY];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 日誌上所有的 `image/offload`，攤成「事件 `seq` → 被省略的圖片位置」。形狀不對的格略過（不拋：這份資料由我們自己寫、讀的時機是叫模型之前，
 * 拋出去等於整輪失敗；略過的後果只是那幾張圖又被送出，額度檢查會再省略一次）。
 */
export function offloadedImagesOf(events: readonly SessionEvent[]): Map<number, Set<number>> {
  const offloaded = new Map<number, Set<number>>();
  for (const event of events) recordImageOffloadInto(offloaded, event);
  return offloaded;
}

/** {@link offloadedImagesOf} 的一顆：是 `image/offload` 就把它的決定併進 `offloaded`，其餘事件略過。 */
export function recordImageOffloadInto(
  offloaded: Map<number, Set<number>>,
  event: SessionEvent,
): void {
  if (event.type !== 'image/offload') return;
  const targets: unknown = event.data?.targets;
  if (!Array.isArray(targets)) return;
  for (const target of targets as readonly Record<string, unknown>[]) {
    const seq = target?.['seq'];
    const indexes = target?.['imageIndexes'];
    if (typeof seq !== 'number' || !Array.isArray(indexes)) continue;
    const set = offloaded.get(seq) ?? new Set<number>();
    for (const index of indexes) if (typeof index === 'number') set.add(index);
    offloaded.set(seq, set);
  }
}

/**
 * 把 `indexes` 那幾張圖標成 `offloaded: true` 之後的內容；一張都沒標到（不在 `indexes`、或已經標過）回 `undefined`。
 * 請求端與推導端共用這一支，所以兩邊標出來的區塊相同。
 */
export function offloadedContent(
  content: unknown,
  indexes: ReadonlySet<number>,
): unknown[] | undefined {
  if (!Array.isArray(content)) return undefined;
  let imageIndex = 0;
  let touched = false;
  const next = (content as readonly unknown[]).map((block) => {
    if (!isImageBlock(block)) return block;
    const here = imageIndex;
    imageIndex += 1;
    if (!indexes.has(here) || block.offloaded === true) return block;
    touched = true;
    return { ...block, offloaded: true as const };
  });
  return touched ? next : undefined;
}

/**
 * 替含圖片區塊的訊息蓋上來源記號（{@link IMAGE_ORIGIN_KEY}）。沒有圖片區塊時回同一則，不帶記號；
 * 有的話回一則新的，`additional_kwargs` 換成加了記號的一份，原訊息不動（日誌那一份是凍過的）。
 */
export function stampLoggedImageOrigin(message: NexusMessage, seq: number): NexusMessage {
  if (imageOccurrencesIn(nexusContent(message)).length === 0) return message;
  return {
    type: message.type,
    data: {
      ...message.data,
      additional_kwargs: { ...(message.data.additional_kwargs ?? {}), [IMAGE_ORIGIN_KEY]: seq },
    },
  };
}

/**
 * 把日誌上已經省略的圖標在這則人話上。只認有來源記號的人話；沒有要標的回同一則。
 *
 * 換出來的那則只帶 `content`、`id`、`name`、`additional_kwargs`、`response_metadata`，與請求端 `applyImageOffload` 建的 `HumanMessage` 同一組欄位
 * （沒有 `additional_kwargs`／`response_metadata` 時補空物件，同 `BaseMessage` 建構子）。
 */
export function offloadLoggedMessage(
  message: NexusMessage,
  offloaded: ReadonlyMap<number, ReadonlySet<number>>,
): NexusMessage {
  if (message.type !== 'human') return message;
  const origin = imageOriginIn(message.data.additional_kwargs);
  const indexes = origin === undefined ? undefined : offloaded.get(origin);
  if (indexes === undefined) return message;
  const content = offloadedContent(nexusContent(message), indexes);
  if (content === undefined) return message;
  const { id, name, additional_kwargs, response_metadata } = message.data;
  return {
    type: 'human',
    data: {
      content: content as MessageContent,
      ...(id === undefined ? {} : { id }),
      ...(name === undefined ? {} : { name }),
      additional_kwargs: additional_kwargs ?? {},
      response_metadata: response_metadata ?? {},
    },
  };
}

/** {@link offloadLoggedMessage} 套在一串上。沒有任何一則要標時回原本那個陣列。 */
export function offloadLoggedMessages(
  messages: readonly NexusMessage[],
  offloaded: ReadonlyMap<number, ReadonlySet<number>>,
): readonly NexusMessage[] {
  if (offloaded.size === 0) return messages;
  let changed: NexusMessage[] | undefined;
  for (const [position, message] of messages.entries()) {
    const next = offloadLoggedMessage(message, offloaded);
    if (next === message) continue;
    changed ??= [...messages];
    changed[position] = next;
  }
  return changed ?? messages;
}
