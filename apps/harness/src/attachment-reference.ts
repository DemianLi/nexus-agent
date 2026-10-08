/**
 * 「這條 thread 的日誌引用過這張圖嗎」（[#733](https://github.com/DemianLi/nexus-agent/issues/733)）：讀圖路由的授權依據。
 *
 * 照 dsh 的 `referencedImage`（`packages/api/session-controller/src/commands.ts:682`，`5badb150`）：附件儲存是整個
 * `NEXUS_AGENT_HOME` 共用、內容定址的，知道 `attachmentId` 不該就換得到位元組——要這條 thread 自己的日誌說過它。
 * dsh 逐種事件找圖片區塊（`imageInEvent`）；我們逐種事件找**參照出現的地方**：
 *
 * | 事件 | 參照在哪 |
 * | --- | --- |
 * | `turn/start`（`kind: 'message'`） | `attachments`（一輪開頭那句話） |
 * | `inbox/spliced` | `inserted[].attachments`（排著的件；被取消的、還沒領走的也算，人確實送過它） |
 * | `user/message` | `message.data.content` 的 `nexus-image` 區塊（輪中插話被領走） |
 * | `tool/result`、`assistant/message` | 同上（模型訊息裡的圖片區塊；今天沒有生產者，先認得，免得之後有人加了讀圖卻畫不出來） |
 *
 * `compaction/summary` 不掃：dsh 掃是因為它的摘要裡可能留著圖片區塊，我們的摘要輸入把圖退成文字佔位（`summarization.ts`），
 * 摘要裡不會有參照。
 *
 * @module
 */

import { isImageBlock } from '@nexus/core';
import type { ImageAttachmentRef, SessionEvent } from '@nexus/core';

/** 一個內容（字串或區塊陣列）裡第一個符合的圖片區塊的參照。 */
function imageInContent(content: unknown, attachmentId: string): ImageAttachmentRef | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const block of content as unknown[]) {
    if (isImageBlock(block) && block.attachment.attachmentId === attachmentId) {
      return block.attachment;
    }
  }
  return undefined;
}

/** 一串附件參照（日誌上的 `AttachmentRef`）裡符合的那張圖。 */
function imageInRefs(refs: unknown, attachmentId: string): ImageAttachmentRef | undefined {
  if (!Array.isArray(refs)) return undefined;
  for (const ref of refs as readonly (Record<string, unknown> | null)[]) {
    if (ref?.['type'] === 'image' && ref['attachmentId'] === attachmentId) {
      const { type: _type, ...image } = ref;
      return image as unknown as ImageAttachmentRef;
    }
  }
  return undefined;
}

function imageInEvent(event: SessionEvent, attachmentId: string): ImageAttachmentRef | undefined {
  switch (event.type) {
    case 'turn/start': {
      const data = event.data;
      return data.kind === 'message' ? imageInRefs(data.attachments, attachmentId) : undefined;
    }
    case 'inbox/spliced': {
      for (const item of event.data.inserted) {
        const found = imageInRefs(item.attachments, attachmentId);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    case 'user/message':
    case 'assistant/message':
      return imageInContent(event.data.message.data.content, attachmentId);
    case 'tool/result':
      return imageInContent(event.data.message?.data.content, attachmentId);
    default:
      return undefined;
  }
}

/**
 * 日誌裡第一次引用到這個 `attachmentId` 的圖的參照；沒有引用就是 `undefined`。
 *
 * @param events - 這條 thread 的 root 日誌。
 * @param attachmentId - `sha256:<hex>`。
 */
export function referencedImage(
  events: readonly SessionEvent[],
  attachmentId: string,
): ImageAttachmentRef | undefined {
  for (const event of events) {
    const found = imageInEvent(event, attachmentId);
    if (found !== undefined) return found;
  }
  return undefined;
}
