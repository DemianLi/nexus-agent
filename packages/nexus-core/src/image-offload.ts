/**
 * 圖片額度與 `image/offload`（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)，#732 第 8 項）。
 *
 * 看圖模型一次請求收得下的圖有限（`meta/llama-3.2-90b-vision-instruct` 的窗口只有 32,768 token，一張圖約 3,166 token）。圖一多，請求就超過
 * 端點收得下的量而失敗，而沒有任何東西會把舊圖讓出位子。這一支照 dsh 補上：**超額時記一筆 `image/offload`，把最舊的幾張換成佔位字，之後每一次
 * 請求都沿用**。
 *
 * ## 照 dsh 的部分（`5badb15009a`）
 *
 * - 額度的形狀：`LlmImageRequestBudget`（`packages/llm/llm/src/types.ts:356-367`）的 `maxImages`、`maxBytes`（base64 長度）。**單位是張數與位元組，
 *   不是 token**——dsh 的預設是 20 MiB 的 base64，不看模型窗口。看圖模型要靠張數把圖留在窗口裡（型錄的 `imageBudget`）。
 * - 算「最舊的要省略幾張」：`requiredImageOffload`／`offloadedImagePrefixCount`（`packages/llm/llm/src/content.ts:284-332`）。
 * - 決定寫成 `image/offload { targets: [{ seq, imageIndexes }] }`、永久省略（`packages/compaction/compaction-image-offload/src/image-offload.ts:17-45`）；
 *   解譯是純函式（`project-message.ts`），被省略的圖打上 `offloaded` 旗標（`projection.ts`）；佔位字見 `attachment-projection.ts` 的 `offloadedImageText`。
 *
 * ## 檢查在 adapter、決定在上層（dsh 的形狀）
 *
 * dsh 的 adapter 只投影、不決定：請求裡留著的圖超過額度時，adapter 以 `IMAGE_OFFLOAD_REQUIRED` 失敗並帶 `offloadImages`（還要再省略最舊的幾張），
 * 上層 `agent/request-error` 接住、記 `image/offload`、重試，**不花供應商的重試額度、不記 `llm/retry`**。這裡逐項對應：
 *
 * - **adapter**：{@link assertImageBudget} 在請求轉換之前量留著的圖（`AttachmentChatOpenAI`、`ScriptedChatModel` 各自呼叫），超過就拋
 *   {@link ImageOffloadRequiredError}。額度來自型錄條目（`imageBudget`），跟著建出這顆 adapter 的那一列走——換模型就換了一顆 adapter、換了額度。
 * - **上層**：{@link createImageOffloadRecoveryMiddleware} 接住那個錯、挑最舊的 `offloadImages` 張寫成 `image/offload`、改好請求再送一次。
 *   它排在起訖紀錄器、用量記錄器與串流重打的**內側**（`fold.ts` 的槽位表），所以失敗的那一次嘗試在它們看來從沒發生：同一次 `model/start`／`model/end`、
 *   同一次用量、沒有 `llm/retry`；供應商的重試額度（`AsyncCaller` 在 `super._generate` 裡面，我們的拋錯在它前面）也沒碰到。
 * - **沒東西可省就往外拋**：挑不到（沒有來源記號的圖、已經全省略）時原錯誤原樣往外，走一般失敗路徑——同 dsh「沒有可省略的就委派下游」。
 *
 * ## 登記的偏離
 *
 * 1. **解譯不在 session surface 上，而在每次叫模型前讀日誌。** dsh 的 surface 把訊息節點與事件綁在一起，`image/offload` 直接改節點；我們的訊息住在
 *    LangGraph state 裡，沒有 surface 這一軸。所以訊息帶著「出自日誌哪一顆事件」的記號（`additional_kwargs`，{@link IMAGE_ORIGIN_KEY}），
 *    {@link createImageOffloadMiddleware} 照日誌上的決定把落在請求裡的圖標成已省略（{@link applyImageOffload}）。記號由 pump 在記 `turn/start`／`user/message`
 *    之後蓋上、由 `replayConversation` 在推回歷史時蓋上，日誌本身不存記號。
 * 2. **只處理有記號的圖。** 沒有記號的訊息（目前沒有生產者）算進額度、但選不到、也就不會被省略；省略之後額度仍超出時，adapter 再拋、上層挑不到，錯誤往外。
 * 3. **摘要請求不走這一支。** 摘要器的輸入是一段文字，圖在那一步已是文字佔位（`summarization.ts` 的 `withAttachmentText`），摘要請求不帶圖，所以 dsh 的
 *    `compaction/summary-error` 接這個碼的那一支在我們這裡沒有對應的失敗。
 *
 * @module
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { createMiddleware } from 'langchain';

import { isImageBlock } from './attachment-ref.js';
import type { ImageBlock } from './attachment-ref.js';
import type { AgentMiddleware } from './base-types.js';
import type { SessionLookup } from './registry.js';
import type { SessionEvent } from './session-log.js';

/** 訊息 `additional_kwargs` 上記「這則訊息出自日誌的哪一顆事件」的鍵。只蓋在含圖片區塊的訊息上。 */
export const IMAGE_ORIGIN_KEY = 'nexus_event_seq';

/** 這顆middleware 的名字。排序斷言與錯誤訊息用得到。 */
export const IMAGE_OFFLOAD_MIDDLEWARE_NAME = 'nexusImageOffload';

/**
 * 一次請求的圖片額度，來自型錄（`imageBudget`）。**兩格都省略＝不檢查**，同 dsh `LlmImageRequestBudget` 的「absent leaves … unbounded」。
 *
 * `countQuantum`／`byteQuantum`（dsh 讓路由一次多省幾張以維持快取前綴）我們沒有：省略的永遠是剛好夠的最少張數。
 */
export interface ImageBudget {
  /** 一次請求最多留幾張圖。 */
  readonly maxImages?: number;
  /** 一次請求的圖片 base64 總長度上限（位元組）。 */
  readonly maxBytes?: number;
}

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

function contentBlocks(message: BaseMessage): readonly unknown[] {
  return Array.isArray(message.content) ? (message.content as readonly unknown[]) : [];
}

/** 一則訊息裡的圖片區塊，由前往後。位置從 0 數，算上已省略的。 */
export function imageOccurrences(message: BaseMessage): ImageOccurrence[] {
  const found: ImageOccurrence[] = [];
  let imageIndex = 0;
  for (const block of contentBlocks(message)) {
    if (!isImageBlock(block)) continue;
    found.push({ imageIndex, block });
    imageIndex += 1;
  }
  return found;
}

/** 這則訊息有沒有圖片區塊。 */
export function hasImageBlock(message: BaseMessage): boolean {
  return contentBlocks(message).some(isImageBlock);
}

/** 這則訊息出自日誌的哪一顆事件；沒有記號回 `undefined`。 */
export function imageOriginOf(message: BaseMessage): number | undefined {
  const value = (message.additional_kwargs as Record<string, unknown> | undefined)?.[
    IMAGE_ORIGIN_KEY
  ];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * 替含圖片區塊的訊息蓋上來源記號。**就地改**：呼叫端剛建出這則訊息、還沒有別人拿著它。沒有圖片區塊時什麼都不做，所以沒有圖的訊息與以前逐位元組相同。
 *
 * @returns 同一則訊息，方便串著用。
 */
export function stampImageOrigin<M extends BaseMessage>(message: M, seq: number): M {
  if (!hasImageBlock(message)) return message;
  message.additional_kwargs = { ...message.additional_kwargs, [IMAGE_ORIGIN_KEY]: seq };
  return message;
}

/** 位元組換成 base64 之後的長度。 */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * 日誌上所有的 `image/offload`，攤成「事件 `seq` → 被省略的圖片位置」。形狀不對的格略過（不拋：這份資料由我們自己寫、讀的時機是叫模型之前，
 * 拋出去等於整輪失敗；略過的後果只是那幾張圖又被送出，額度檢查會再省略一次）。
 */
export function offloadedImagesOf(events: readonly SessionEvent[]): Map<number, Set<number>> {
  const offloaded = new Map<number, Set<number>>();
  for (const event of events) {
    if (event.type !== 'image/offload') continue;
    const targets: unknown = event.data?.targets;
    if (!Array.isArray(targets)) continue;
    for (const target of targets as readonly Record<string, unknown>[]) {
      const seq = target?.['seq'];
      const indexes = target?.['imageIndexes'];
      if (typeof seq !== 'number' || !Array.isArray(indexes)) continue;
      const set = offloaded.get(seq) ?? new Set<number>();
      for (const index of indexes) if (typeof index === 'number') set.add(index);
      offloaded.set(seq, set);
    }
  }
  return offloaded;
}

/**
 * 把日誌上已經省略的圖標在請求副本上（`offloaded: true`）。**沒有任何圖需要標時回原本那個陣列**（物件同一）；有的才複製那幾則，
 * 其餘欄位（id、名字、`additional_kwargs`、`response_metadata`）原樣帶過去，原訊息不動——LangGraph state 裡的訊息永遠是參照，旗標只活在這次請求。
 *
 * 只認有來源記號的訊息；沒有記號的訊息原樣通過。
 */
export function applyImageOffload(
  messages: readonly BaseMessage[],
  offloaded: ReadonlyMap<number, ReadonlySet<number>>,
): readonly BaseMessage[] {
  if (offloaded.size === 0) return messages;
  let changed: BaseMessage[] | undefined;
  for (const [position, message] of messages.entries()) {
    const origin = imageOriginOf(message);
    const indexes = origin === undefined ? undefined : offloaded.get(origin);
    if (indexes === undefined || !HumanMessage.isInstance(message)) continue;
    let imageIndex = 0;
    let touched = false;
    const content = contentBlocks(message).map((block) => {
      if (!isImageBlock(block)) return block;
      const here = imageIndex;
      imageIndex += 1;
      if (!indexes.has(here) || block.offloaded === true) return block;
      touched = true;
      return { ...block, offloaded: true as const };
    });
    if (!touched) continue;
    changed ??= [...messages];
    changed[position] = new HumanMessage({
      content: content as never,
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.name === undefined ? {} : { name: message.name }),
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  }
  return changed ?? messages;
}

/** 請求裡還留著（沒被省略）的圖片區塊，由舊到新。 */
function retainedImages(messages: readonly BaseMessage[]): ImageBlock[] {
  const retained: ImageBlock[] = [];
  for (const message of messages) {
    for (const { block } of imageOccurrences(message))
      if (block.offloaded !== true) retained.push(block);
  }
  return retained;
}

/**
 * 這份請求還要再省略幾張最舊的才進得了額度；進得了回 0。逐字照 dsh `offloadedImagePrefixCount`（無 quantum）：
 * 張數超出與位元組超出各算一個要移除的量，從最舊的開始累計到兩者都滿足為止。
 */
export function requiredImageOffload(
  messages: readonly BaseMessage[],
  budget: ImageBudget,
): number {
  const lengths = retainedImages(messages).map((block) => base64Length(block.attachment.bytes));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const excessCount =
    budget.maxImages === undefined ? 0 : Math.max(0, lengths.length - budget.maxImages);
  const excessBytes = budget.maxBytes === undefined ? 0 : Math.max(0, total - budget.maxBytes);
  if (excessCount === 0 && excessBytes === 0) return 0;
  let count = 0;
  let removedBytes = 0;
  for (const length of lengths) {
    if (count >= excessCount && removedBytes >= excessBytes) break;
    removedBytes += length;
    count += 1;
  }
  return count;
}

/**
 * 從請求裡挑最舊的 `count` 張還留著的圖，寫成 `image/offload` 的 `targets`。**只挑有來源記號的訊息裡的**（沒有記號的定位不到、記不進日誌）。
 *
 * @returns 要記的 `targets`（照 `seq` 由小到大、位置嚴格遞增），與實際挑到幾張（可能少於 `count`）。
 */
export function selectImagesToOffload(
  messages: readonly BaseMessage[],
  count: number,
): { readonly targets: ImageOffloadTarget[]; readonly selected: number } {
  const bySeq = new Map<number, number[]>();
  let selected = 0;
  for (const message of messages) {
    if (selected >= count) break;
    const origin = imageOriginOf(message);
    for (const { imageIndex, block } of imageOccurrences(message)) {
      if (selected >= count) break;
      if (block.offloaded === true) continue;
      if (origin === undefined) continue;
      const list = bySeq.get(origin) ?? [];
      list.push(imageIndex);
      bySeq.set(origin, list);
      selected += 1;
    }
  }
  const targets = [...bySeq.entries()]
    .sort(([left], [right]) => left - right)
    .map(([seq, imageIndexes]) => ({ seq, imageIndexes }));
  return { targets, selected };
}

/** 請求轉換之前，adapter 量到留著的圖超過額度時拋的碼。同 dsh `IMAGE_OFFLOAD_REQUIRED_CODE`。 */
export const IMAGE_OFFLOAD_REQUIRED_CODE = 'IMAGE_OFFLOAD_REQUIRED';

/**
 * 請求裡留著的圖超過額度。同 dsh `LlmError(…, IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages })`：`offloadImages` 是還要再省略最舊的幾張。
 * 這個錯**在送出請求之前**拋，沒有任何東西到過供應商。
 */
export class ImageOffloadRequiredError extends Error {
  readonly code = IMAGE_OFFLOAD_REQUIRED_CODE;

  constructor(readonly offloadImages: number) {
    super(
      `request images exceed the route budget; ${offloadImages} oldest image(s) must be offloaded`,
    );
    this.name = 'ImageOffloadRequiredError';
  }
}

/** 從錯誤（含 `cause` 鏈，最多往下找幾層）裡找出 {@link ImageOffloadRequiredError}；不是回 `undefined`。 */
export function imageOffloadRequiredOf(error: unknown): ImageOffloadRequiredError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current instanceof ImageOffloadRequiredError) return current;
    current = current.cause;
  }
  return undefined;
}

/**
 * adapter 在請求轉換之前呼叫：留著的圖超過額度就拋 {@link ImageOffloadRequiredError}（帶還要省略幾張），否則什麼都不做。
 * 照 dsh：**adapter 只量、不決定**，記不記、省哪幾張是上層的事。
 */
export function assertImageBudget(messages: readonly BaseMessage[], budget: ImageBudget): void {
  const need = requiredImageOffload(messages, budget);
  if (need > 0) throw new ImageOffloadRequiredError(need);
}

/** 兩顆 middleware 要的東西。 */
export interface ImageOffloadDeps {
  /** 註冊表的 `sessions` 通道：問「這次呼叫該讀、該寫哪一份日誌」。 */
  readonly sessions: { forCall(config: unknown): SessionLookup };
}

function callConfigurable(request: unknown): { configurable?: unknown } {
  return {
    configurable: (request as { runtime?: { configurable?: unknown } }).runtime?.configurable,
  };
}

/**
 * 每次叫模型之前：把日誌上已經省略的圖標在請求上，然後才把請求交下去。**沒有任何圖片區塊的請求原樣通過、不讀日誌。**
 *
 * 位置：緊貼換模型之後、摘要器外面（`fold.ts` 的槽位表），所以摘要器的門檻估算、起訖紀錄與請求快照看到的都是省略過的請求。
 * 只折進 root：圖由人送出、住在 root 的日誌上。**新的決定不在這裡下**，見 {@link createImageOffloadRecoveryMiddleware}。
 */
export function createImageOffloadMiddleware(deps: ImageOffloadDeps): AgentMiddleware {
  return createMiddleware({
    name: IMAGE_OFFLOAD_MIDDLEWARE_NAME,
    wrapModelCall: (request, handler) => {
      const messages = (request.messages ?? []) as readonly BaseMessage[];
      if (!messages.some(hasImageBlock)) return handler(request);
      const found = deps.sessions.forCall(callConfigurable(request));
      // 沒有日誌可讀（手搭的組裝沒接 session）就不標：決定記不下來，每一步都重算會讓同一張圖時有時無。
      if (found.kind !== 'ok') return handler(request);
      const view = applyImageOffload(messages, offloadedImagesOf(found.log.events));
      return handler(view === messages ? request : { ...request, messages: [...view] });
    },
  }) as unknown as AgentMiddleware;
}

/** 接住 adapter 的 {@link ImageOffloadRequiredError} 的那顆 middleware 的名字。 */
export const IMAGE_OFFLOAD_RECOVERY_MIDDLEWARE_NAME = 'nexusImageOffloadRecovery';

/**
 * dsh 的 `agent/request-error` 上 `compaction-image-offload` 的位置：接住 adapter 的 {@link ImageOffloadRequiredError}，挑最舊的
 * `offloadImages` 張寫一筆 `image/offload`，把這幾張標成已省略後**再送一次**。
 *
 * **排在起訖紀錄器、用量記錄器與串流重打的內側**：失敗的嘗試沒有送出任何東西，不該成為一次模型呼叫，也不該花重試額度（見檔頭）。
 * 一次最多迴圈到所有圖都省略為止——每圈至少多省一張，所以一定會停。挑不到（沒有來源記號的圖、已全省略）就把原錯誤往外拋。
 */
export function createImageOffloadRecoveryMiddleware(deps: ImageOffloadDeps): AgentMiddleware {
  return createMiddleware({
    name: IMAGE_OFFLOAD_RECOVERY_MIDDLEWARE_NAME,
    wrapModelCall: async (request, handler) => {
      let current = request;
      for (;;) {
        try {
          return await handler(current);
        } catch (error) {
          const required = imageOffloadRequiredOf(error);
          if (required === undefined) throw error;
          const found = deps.sessions.forCall(callConfigurable(current));
          if (found.kind !== 'ok') throw error;
          const messages = (current.messages ?? []) as readonly BaseMessage[];
          const { targets, selected } = selectImagesToOffload(messages, required.offloadImages);
          if (selected === 0) throw error;
          // 先在副本上試：標得上才記。**記了卻標不上的決定是日誌裡永遠沒有效果的一筆**，而且再送一次只會原樣再拋。
          const decided = offloadedImagesOf(found.log.events);
          for (const { seq, imageIndexes } of targets) {
            const set = decided.get(seq) ?? new Set<number>();
            for (const index of imageIndexes) set.add(index);
            decided.set(seq, set);
          }
          const next = applyImageOffload(messages, decided);
          // 每圈都得真的少掉留著的圖，所以一定會停。
          if (retainedImages(next).length >= retainedImages(messages).length) throw error;
          found.log.append('image/offload', { targets });
          current = { ...current, messages: [...next] };
        }
      }
    },
  }) as unknown as AgentMiddleware;
}
