/**
 * 「這條 thread 的日誌引用過這份附件嗎」：兩條路由的授權依據——網頁讀圖（[#733](https://github.com/DemianLi/nexus-agent/issues/733)，
 * {@link referencedImage}）與模型讀附件（[#1773](https://github.com/DemianLi/nexus-agent/issues/1773)，{@link referencedFilePaths}，
 * 路由在 `attachment-route.ts`）。兩條都從同一份事件對照表（{@link referencedAttachments}）出發，新增一種帶附件的事件只改一處。
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
 * 檔案區塊（`nexus-file`）與檔案參照走同樣的位置，#1773 起一併認得。
 *
 * `compaction/summary` 不掃：dsh 掃是因為它的摘要裡可能留著圖片區塊，我們的摘要輸入把圖退成文字佔位（`summarization.ts`），
 * 摘要裡不會有參照。
 *
 * @module
 */

import { isFileBlock, isImageBlock } from '@nexus/core';
import type { FileAttachmentRef, ImageAttachmentRef, SessionEvent } from '@nexus/core';

/** 日誌上某一處出現的一份附件參照；`kind` 判別是檔案還是圖。 */
export type ReferencedAttachment =
  | { readonly kind: 'file'; readonly ref: FileAttachmentRef }
  | { readonly kind: 'image'; readonly ref: ImageAttachmentRef };

/** 一個內容（字串或區塊陣列）裡的附件區塊，依出現順序。 */
function* attachmentsInContent(content: unknown): Generator<ReferencedAttachment> {
  if (!Array.isArray(content)) return;
  for (const block of content as unknown[]) {
    if (isImageBlock(block)) yield { kind: 'image', ref: block.attachment };
    else if (isFileBlock(block)) yield { kind: 'file', ref: block.attachment };
  }
}

/**
 * 一串附件參照（日誌上的 `AttachmentRef`）裡的每一份。**只看 `type` 與 `attachmentId`，不驗整個形狀**（讀圖路由從 #733 起就是這個鬆度）；
 * 回的參照不含 `type`。
 */
function* attachmentsInRefs(refs: unknown): Generator<ReferencedAttachment> {
  if (!Array.isArray(refs)) return;
  for (const entry of refs as readonly unknown[]) {
    // `null`、`undefined`、字串、數字都不是參照：略過，不拋（#1782；#733 起讀圖路由用 `ref?.['type']`，對 `undefined` 也是略過）。
    if (entry === null || typeof entry !== 'object') continue;
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate['attachmentId'] !== 'string') continue;
    const { type, ...ref } = candidate;
    if (type === 'image') yield { kind: 'image', ref: ref as unknown as ImageAttachmentRef };
    else if (type === 'file') yield { kind: 'file', ref: ref as unknown as FileAttachmentRef };
  }
}

function* attachmentsInEvent(event: SessionEvent): Generator<ReferencedAttachment> {
  switch (event.type) {
    case 'turn/start': {
      const data = event.data;
      if (data.kind === 'message') yield* attachmentsInRefs(data.attachments);
      return;
    }
    case 'inbox/spliced': {
      for (const item of event.data.inserted) yield* attachmentsInRefs(item.attachments);
      return;
    }
    case 'user/message':
    case 'assistant/message':
      yield* attachmentsInContent(event.data.message.data.content);
      return;
    case 'tool/result':
      yield* attachmentsInContent(event.data.message?.data.content);
      return;
    default:
      return;
  }
}

/**
 * 日誌裡每一處附件參照（檔案與圖），依出現順序，不去重。
 *
 * **這是「這條 thread 引用過什麼」的唯一一份事件對照表**：讀圖路由（{@link referencedImage}）與模型讀附件的路由
 * （{@link referencedFilePaths}，#1773）都從這裡出發，新增一種帶附件的事件只改這一處。
 *
 * @param events - 這條 thread 的 root 日誌。
 */
export function referencedAttachments(
  events: readonly SessionEvent[],
): Generator<ReferencedAttachment> {
  return (function* walk(): Generator<ReferencedAttachment> {
    for (const event of events) yield* attachmentsInEvent(event);
  })();
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
  for (const found of referencedAttachments(events)) {
    if (found.kind === 'image' && found.ref.attachmentId === attachmentId) return found.ref;
  }
  return undefined;
}

/**
 * 這條 thread 的日誌引用過這份附件嗎（[#1773](https://github.com/DemianLi/nexus-agent/issues/1773)）：模型讀附件那條路由的判準，
 * 檔案與圖兩種都認。
 *
 * - **檔案**：`attachmentId` 與 `name` 都要對上。同樣的位元組被不同的人用不同的檔名上傳，各自有一條檔名別名（`files/<前兩碼>/<hex>/<檔名>`），
 *   引用的是哪一條就只算哪一條。
 * - **圖**：只比 `attachmentId`（圖不建檔名別名，模型不經檔案路徑讀圖，這一支給讀圖類的判準用）。
 *
 * @param events - 這條 thread 的 root 日誌（呼叫當下的樣子，不要拿快照）。
 * @param target - 要問的參照。
 */
export function referencesAttachment(
  events: readonly SessionEvent[],
  target:
    | { readonly kind: 'file'; readonly attachmentId: string; readonly name: string }
    | { readonly kind: 'image'; readonly attachmentId: string },
): boolean {
  for (const found of referencedAttachments(events)) {
    if (found.kind !== target.kind || found.ref.attachmentId !== target.attachmentId) continue;
    if (target.kind === 'image') return true;
    if ((found.ref as FileAttachmentRef).name === target.name) return true;
  }
  return false;
}

const ATTACHMENT_ID = /^sha256:([a-f0-9]{64})$/u;

/**
 * 這條 thread 的日誌引用過的**檔案**，換成附件路由底下的相對路徑集合（`/<前兩碼>/<hex>/<檔名>`，與
 * `AttachmentStore.modelPathOf` 去掉 `/attachments` 前綴同形）。格式不對的參照（雜湊不合）略過，不拋。
 *
 * @param events - 這條 thread 的 root 日誌。
 */
export function referencedFilePaths(events: readonly SessionEvent[]): Set<string> {
  const paths = new Set<string>();
  for (const found of referencedAttachments(events)) {
    if (found.kind !== 'file') continue;
    const sha256 = ATTACHMENT_ID.exec(found.ref.attachmentId)?.[1];
    if (sha256 === undefined || typeof found.ref.name !== 'string' || found.ref.name === '')
      continue;
    paths.add(`/${sha256.slice(0, 2)}/${sha256}/${found.ref.name}`);
  }
  return paths;
}
