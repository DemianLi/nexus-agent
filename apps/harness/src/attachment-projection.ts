/**
 * 送進模型之前，把訊息裡的附件參照換成模型看得懂的東西（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * 圖與日誌、存檔點裡只有參照（`nexus-file`／`nexus-image` 區塊）；**這一步發生在組請求的那一刻**，換完的訊息只交給底層的
 * 請求轉換，不回寫任何地方。所以位元組（base64）不可能進日誌、軌跡或存檔點——那是這支存在的意義，也是
 * `attachment-wire.test.ts` 釘住的。照 dsh 的位置（`packages/llm/llm/src/index.ts:1058-1070` 的 `projectFilesToText`／
 * `projectImagesForTextModel`，`5badb150`）：檔案換成確定性的一行字，圖在模型不收圖時換成一行佔位字。
 *
 * ## 規則
 *
 * - **檔案**：一行 {@link fileHandleText}。路徑讀得到（儲存裡還在）用「可讀」的措辭，讀不到用「無法存取，不要聲稱讀過」。
 * - **圖**：被圖片額度省略的（`block.offloaded`）→ 佔位字（`offloadedImageText`），先於下面兩條；型錄宣告了 `input` 而沒有 `image`（`'rejects'`）→ 佔位字（{@link textOnlyImageText}）；其餘（收圖、沒宣告）→ **送模型的那一份**
 *   （`AttachmentStore.readRequestImage`，照預算另做、有快取，見 `request-image.ts`）的 `image_url` data URL，媒體類型是那一份的，**前面一行把手**（`requestImageHandleText`，#1566）。只在型錄**明確**宣告純文字時才換成佔位字，沒宣告時照送。圖的位元組讀不到
 *   （儲存被清掉、被換過）或做不出送模型的那一份 → 佔位字（{@link unavailableImageText}），那一步不因此失敗。
 *
 * ## 登記的偏離
 *
 * dsh 在 adapter 之前、對**整個請求**做這件事。我們在 `ChatOpenAI` 的子類（`attachment-chat-openai.ts`）裡做，因為基座表達不出
 * 「請求轉換之前的一道 hook」：LangChain 的 `handleChatModelStart` 在它之前跑（所以 callback 看到的是參照），而底層轉換
 * 不認得我們的區塊型別。
 *
 * @module
 */

import {
  fileHandleText,
  fileModelPath,
  offloadedImageText,
  requestImageHandleText,
  rewriteAttachmentBlocks,
  textOnlyImageText,
  unavailableImageText,
} from '@nexus/core';
import type { FileAttachmentRef, ImageAttachmentRef } from '@nexus/core';
import type { BaseMessage } from '@langchain/core/messages';

import type { ImageSupport } from './model-catalog.js';
import type { RequestImage } from './request-image.js';

/** 投影要問儲存的兩件事；`AttachmentStore` 滿足它。 */
export interface AttachmentSource {
  /** 這份檔案的存放路徑現在讀不讀得到。 */
  hasFile(ref: FileAttachmentRef): Promise<boolean>;
  /** 送模型的那一份；落盤那一份讀不到、對不上，或做不出來就拋。 */
  readRequestImage(ref: ImageAttachmentRef): Promise<RequestImage>;
}

/**
 * 組請求用的投影。
 *
 * @param messages - 要送出的訊息（含參照區塊）。
 * @param source - 附件儲存。
 * @param imageSupport - 這顆模型收不收圖，見 `acceptsImages`。
 * @returns 沒有附件區塊時是同一個陣列；有的話是換過區塊的新陣列，原訊息不動。
 */
export function projectAttachments(
  messages: readonly BaseMessage[],
  source: AttachmentSource,
  imageSupport: ImageSupport,
): Promise<readonly BaseMessage[]> {
  return rewriteAttachmentBlocks(messages, async (block) => {
    if (block.type === 'nexus-file') {
      const ref = block.attachment;
      return {
        type: 'text',
        text: fileHandleText(ref, (await source.hasFile(ref)) ? fileModelPath(ref) : undefined),
      };
    }
    const ref = block.attachment;
    // 被圖片額度省略的（`image/offload`，#1270）：不讀位元組，也不管這顆收不收圖——佔位字是這個出現永久的樣子。
    if (block.offloaded === true) return { type: 'text', text: offloadedImageText(ref) };
    if (imageSupport === 'rejects') return { type: 'text', text: textOnlyImageText(ref) };
    try {
      const version = await source.readRequestImage(ref);
      return [
        { type: 'text', text: requestImageHandleText(ref, version) },
        {
          type: 'image_url',
          image_url: {
            url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
          },
        },
      ];
    } catch {
      return { type: 'text', text: unavailableImageText(ref) };
    }
  });
}
