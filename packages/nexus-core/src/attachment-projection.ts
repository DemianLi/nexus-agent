/**
 * 把訊息裡的附件區塊換成模型看得懂的東西（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * 存在圖與日誌裡的是參照（`nexus-file`／`nexus-image` 區塊，見 `attachment-ref.ts`）；送給模型之前才換：檔案換成一行字，
 * 圖換成 `image_url`（有圖的位元組才讀進記憶體）或一行佔位字。**照 dsh 的位置**——組請求那一步，不是寫進日誌的那一刻
 * （`packages/llm/llm/src/index.ts:1058-1070` 的 `projectFilesToText`／`projectImagesForTextModel`，`5badb150`）。
 *
 * 這一支只放與儲存無關的部分：走訪訊息、換區塊的骨架，和幾句固定的佔位字。讀位元組的是 `apps/harness`。
 *
 * @module
 */

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';

import { fileHandleText, fileModelPath, isFileBlock, isImageBlock } from './attachment-ref.js';
import type {
  FileAttachmentRef,
  FileBlock,
  ImageAttachmentRef,
  ImageBlock,
} from './attachment-ref.js';

/** 換完之後留在內容裡的區塊（文字或 `image_url`）。 */
export type ProjectedBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

/** 這則訊息的內容裡有沒有附件區塊。 */
export function hasAttachmentBlocks(message: BaseMessage): boolean {
  return (
    Array.isArray(message.content) &&
    (message.content as readonly unknown[]).some(
      (block) => isFileBlock(block) || isImageBlock(block),
    )
  );
}

/**
 * 檔案給模型的那一行，**假設讀得到**（不問儲存）。給不碰儲存的地方用：摘要器的入口、token 估算。
 * 組請求時會問儲存，讀不到才換成另一種措辭。
 */
export function assumedFileLine(ref: FileAttachmentRef): string {
  return fileHandleText(ref, fileModelPath(ref));
}

/**
 * 模型不收圖時，圖的佔位字。逐字照 dsh `textOnlyImageText`（`packages/llm/llm/src/content.ts:76`）：只用雜湊前八碼辨認。
 * 會話中途換成不收圖的模型時，之前送過的圖就變成這一行。
 */
export function textOnlyImageText(ref: ImageAttachmentRef): string {
  const digest = ref.attachmentId.slice('sha256:'.length, 'sha256:'.length + 8);
  return `[image omitted because this model accepts text only; attachment sha256:${digest}]`;
}

/**
 * 摘要器看到一張圖時的佔位字。摘要器的輸入是基座把訊息串成一段文字的範本，裝不下像素，所以圖在那一步只留「這裡附過一張圖」。
 * 辨認資訊（名字、雜湊前八碼）留著，摘要才寫得出「使用者附了哪張圖」。
 */
export function summaryImageText(ref: ImageAttachmentRef): string {
  const digest = ref.attachmentId.slice('sha256:'.length, 'sha256:'.length + 8);
  const name = ref.name === undefined ? '' : ` ${JSON.stringify(ref.name)}`;
  return `[image${name} (sha256:${digest}, ${String(ref.width)}x${String(ref.height)}) was attached here; its pixels are not part of this text.]`;
}

/**
 * 圖因為請求的圖片額度而被省略時的佔位字（[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）。照 dsh `offloadedImageText`
 * （`packages/llm/llm/src/content.ts:108`）沒有本機路徑的那一支：我們不替模型準備圖的唯讀副本，所以只說「請使用者重新附上」。
 */
export function offloadedImageText(ref: ImageAttachmentRef): string {
  const digest = ref.attachmentId.slice('sha256:'.length, 'sha256:'.length + 8);
  const name = ref.name === undefined ? '' : ` ${JSON.stringify(ref.name)}`;
  return `[image omitted to fit request image limits; image${name} (sha256:${digest}, ${String(ref.width)}x${String(ref.height)}). No local copy is available; ask the user to attach it again if needed.]`;
}

/** 圖的位元組讀不到時（儲存被清掉、被截斷）的佔位字：請使用者重新附上，不要聲稱看過。 */
export function unavailableImageText(ref: ImageAttachmentRef): string {
  const digest = ref.attachmentId.slice('sha256:'.length, 'sha256:'.length + 8);
  const name = ref.name === undefined ? '' : ` ${JSON.stringify(ref.name)}`;
  return `[image${name} (sha256:${digest}) is no longer available in attachment storage; ask the user to attach it again if needed. Do not claim to have seen it.]`;
}

/**
 * 逐則走訪，把人說的話裡的附件區塊換掉。**沒有任何附件區塊時回原本那個陣列**（零成本、物件同一），有的才複製那幾則：
 * 其餘欄位（id、名字、`additional_kwargs`、`response_metadata`）原樣帶過去，原訊息不動。
 *
 * @param messages - 要送出的訊息。
 * @param rewrite - 一個附件區塊換成什麼；可以是非同步（讀儲存）。
 */
export async function rewriteAttachmentBlocks(
  messages: readonly BaseMessage[],
  rewrite: (block: FileBlock | ImageBlock) => ProjectedBlock | Promise<ProjectedBlock>,
): Promise<readonly BaseMessage[]> {
  let changed: BaseMessage[] | undefined;
  for (const [index, message] of messages.entries()) {
    if (!HumanMessage.isInstance(message) || !hasAttachmentBlocks(message)) continue;
    const content: unknown[] = [];
    for (const block of message.content as readonly unknown[]) {
      content.push(isFileBlock(block) || isImageBlock(block) ? await rewrite(block) : block);
    }
    changed ??= [...messages];
    changed[index] = new HumanMessage({
      content: content as never,
      ...(message.id === undefined ? {} : { id: message.id }),
      ...(message.name === undefined ? {} : { name: message.name }),
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
    });
  }
  return changed ?? messages;
}
