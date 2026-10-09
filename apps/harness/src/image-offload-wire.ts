/**
 * 圖片額度省略（`image/offload`，[#1270](https://github.com/DemianLi/nexus-agent/issues/1270)）在線上的樣子：哪幾格附件被省略了。
 * 形狀與認條目的規則見 `@nexus/wire` 的 `image-offload.ts`。
 *
 * 日誌上的決定記的是「某顆事件的第 n 張**圖**」（模型訊息裡的圖片區塊位置）；線上人話的 `attachments` 檔案與圖混在一起，所以這裡把
 * 圖的序號換成 `attachments` 裡的位置。歷史（冷載入）與即時兩條路共用這一支，同一顆日誌推出來的位置一定一樣。
 *
 * @module
 */

import { IMAGE_OFFLOAD } from '@nexus/wire';
import type { ImageOffloadItem, ImageOffloadPayload } from '@nexus/wire';
import type { AttachmentRef, SessionEvent } from '@nexus/core';
import { attachmentRefOfBlock, loggedContentBlocks } from '@nexus/core';

/** 一顆人話事件帶的附件參照，照選取順序。不是人話事件、或沒有附件就是空的。 */
export function attachmentsOfEvent(event: SessionEvent): readonly AttachmentRef[] {
  if (event.type === 'turn/start') {
    return event.data.kind === 'message' ? (event.data.attachments ?? []) : [];
  }
  if (event.type === 'user/message') {
    return loggedContentBlocks(event.data.message.data.content).flatMap((block: unknown) => {
      const ref = attachmentRefOfBlock(block);
      return ref === undefined ? [] : [ref];
    });
  }
  return [];
}

/**
 * 一句人話被省略的圖（第 n 張圖）換成它們在 `attachments` 裡的位置。
 *
 * @param attachments - 那一句的附件參照。
 * @param imageIndexes - 被省略的圖的序號（只數圖，0 起算）。
 * @returns 位置，遞增；序號超出實際圖數的略過。
 */
export function omittedPositionsOf(
  attachments: readonly AttachmentRef[],
  imageIndexes: ReadonlySet<number> | undefined,
): number[] {
  if (imageIndexes === undefined || imageIndexes.size === 0) return [];
  const positions: number[] = [];
  let imageIndex = 0;
  for (const [position, ref] of attachments.entries()) {
    if (ref.type !== 'image') continue;
    if (imageIndexes.has(imageIndex)) positions.push(position);
    imageIndex += 1;
  }
  return positions;
}

/**
 * 一筆 `image/offload` 在線上的 `custom` 事件 `data`。
 *
 * @param event - 那筆 `image/offload`。
 * @param events - 同一份日誌的所有事件（用來找 `targets` 指到的那些人話）。
 * @param inboxIdOf - 即時長出來的那一句是送出佇列的哪一件；不知道（例如重啟前的）回 `undefined`。
 * @returns 酬載；沒有任何一項對得上附件（日誌被截過之類）就是 `undefined`，不送空的。
 */
export function imageOffloadData(
  event: SessionEvent<'image/offload'>,
  events: readonly SessionEvent[],
  inboxIdOf: (seq: number) => string | undefined,
): { readonly name: typeof IMAGE_OFFLOAD; readonly payload: ImageOffloadPayload } | undefined {
  const items: ImageOffloadItem[] = [];
  for (const target of event.data.targets) {
    const source = events.find((candidate) => candidate.seq === target.seq);
    if (source === undefined) continue;
    const positions = omittedPositionsOf(attachmentsOfEvent(source), new Set(target.imageIndexes));
    if (positions.length === 0) continue;
    const inboxId = inboxIdOf(target.seq);
    items.push({ seq: target.seq, ...(inboxId === undefined ? {} : { inboxId }), positions });
  }
  return items.length === 0 ? undefined : { name: IMAGE_OFFLOAD, payload: { items } };
}
