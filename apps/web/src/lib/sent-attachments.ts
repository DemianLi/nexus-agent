/**
 * 已送出的附件在畫面上怎麼寫（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：人的泡泡與排著的那一列都畫「名字＋大小」的標籤。
 *
 * 資料是線上的**參照**（`WireAttachmentRef`：`attachmentId`、名字、位元組，圖另有媒體型別與寬高），沒有位元組。
 * 讀圖的路由還沒有（#733 的下一張），所以**圖也畫成標籤，不畫縮圖、不畫壞圖**；有了路由再把縮圖換上去。
 *
 * @module
 */

import type { WireAttachmentRef } from '@nexus/wire';

import { fileExtension, formatBytes } from '@/lib/attachments';

export interface SentAttachmentView {
  /** 同一句裡不重複：內容定址的 id 一樣的兩件（同一個檔送兩次）靠位置分。 */
  readonly key: string;
  readonly kind: 'image' | 'file';
  /** 標題：名字；圖沒帶名字（貼上的圖常沒有）寫「圖片」。 */
  readonly name: string;
  /** 第二行：`副檔名 · 大小`；圖沒有副檔名就用媒體型別（`image/jpeg` → `JPEG`），圖另帶 `寬×高`。 */
  readonly detail: string;
}

/** `image/jpeg` → `JPEG`。 */
function mediaLabel(mediaType: string): string {
  return (mediaType.split('/')[1] ?? mediaType).toUpperCase();
}

export function sentAttachmentViews(
  refs: readonly WireAttachmentRef[] | undefined,
): readonly SentAttachmentView[] {
  return (refs ?? []).map((ref, index) => {
    const key = `${index}:${ref.attachmentId}`;
    if (ref.type === 'file') {
      const extension = fileExtension(ref.name);
      const size = formatBytes(ref.bytes);
      return {
        key,
        kind: 'file',
        name: ref.name,
        detail: extension === undefined ? size : `${extension} · ${size}`,
      };
    }
    const name = ref.name ?? '圖片';
    const label =
      (ref.name === undefined ? undefined : fileExtension(ref.name)) ?? mediaLabel(ref.mediaType);
    return {
      key,
      kind: 'image',
      name,
      detail: `${label} · ${formatBytes(ref.bytes)} · ${ref.width}×${ref.height}`,
    };
  });
}

/** 排著的那一列：一句話只有附件、沒有字時，預覽寫附件的名字，不留一列空白。 */
export function attachmentsPreview(refs: readonly WireAttachmentRef[] | undefined): string {
  return sentAttachmentViews(refs)
    .map((view) => view.name)
    .join('、');
}
