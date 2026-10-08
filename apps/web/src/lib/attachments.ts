/**
 * 輸入框的草稿附件（#733）：還沒送出的檔案與圖，排在輸入框底下，可以移除。
 *
 * 這一層管**畫面上的草稿**與前端先擋的上限（`admitFiles`）；上傳、收據與送出時帶什麼在 `lib/attachment-send.ts`，
 * 連線協定在 `@nexus/wire` 的 `attachments.ts`（#732）。
 *
 * @module
 */

import { IMAGE_MEDIA_TYPES, MAX_IMAGE_BYTES, MAX_IMAGES_PER_MESSAGE } from '@nexus/wire';
import type { ImageMediaType } from '@nexus/wire';

/** 一個草稿附件。 */
export interface DraftAttachment {
  readonly id: string;
  readonly file: File;
  /** 圖畫縮圖、其餘畫檔案卡。 */
  readonly kind: 'image' | 'file';
  /** 圖的 object URL（縮圖與原圖共用）；移除與卸載時一定要 revoke。 */
  readonly previewUrl?: string;
}

/** 輸入框收附件需要的三件事；**沒給就沒有附件這個功能**（按鈕、貼上、拖放都不出現），同 `fileReferences` 的給法。 */
export interface ComposerAttachments {
  readonly items: readonly DraftAttachment[];
  readonly onAdd: (files: File[]) => void;
  readonly onRemove: (id: string) => void;
}

/**
 * 這個組裝收不收附件。**寫死 `false`，不在執行期探測**：web 與 serve 一起打包出貨，伺服器端的上傳與收圖
 * （[#732](https://github.com/DemianLi/nexus-agent/issues/732)）有沒有落地，是出貨時就知道的事，不需要執行期問；
 * 探測反而多一條「探測失敗算有還是沒有」的路。
 *
 * 伺服器端實作合進 develop 之後，**另開一張 PR 把這裡改成 `true`**（只改這一行與它的測試）。在那之前整個功能
 * （加入鈕、貼上、拖放、附件列）都不出現：沒有它，附件選進來也送不出去，貼上一張圖會變成一顆永遠送不出的晶片。
 * 萬一出貨時開了、伺服器卻回 `not_supported`，送出會失敗並說出原因、草稿與附件留著（見 `lib/attachment-send.ts`）。
 */
export function serverSupportsAttachments(): boolean {
  return false;
}

/**
 * 這個檔案是不是伺服器收的內嵌圖片：只認 dsh 的 `ImageMediaType` 白名單（`IMAGE_MEDIA_TYPES`：png、jpeg、webp、gif），
 * 不是「`image/` 開頭」。svg、heic、bmp、tiff 等沒在白名單裡的圖，伺服器的收圖檢查不收，**當一般檔案走上傳**。
 */
export function imageMediaType(file: Pick<File, 'type'>): ImageMediaType | undefined {
  return IMAGE_MEDIA_TYPES.find((type) => type === file.type);
}

/** 白名單裡的圖畫縮圖、其餘（含不在白名單的圖）都是檔案卡。 */
export function attachmentKind(file: Pick<File, 'type'>): DraftAttachment['kind'] {
  return imageMediaType(file) === undefined ? 'file' : 'image';
}

/**
 * 一句話所有內嵌圖片的位元組總和上限，同 dsh 的 `DEFAULT_MAX_MESSAGE_IMAGE_BYTES`
 * （`packages/attachment/attachment-local/src/index.ts:38`）。單張與張數上限在 `@nexus/wire`（`MAX_IMAGE_BYTES`、
 * `MAX_IMAGES_PER_MESSAGE`）；這一個 wire 沒有收，前端自己對著 dsh 的預設擋。
 */
export const MAX_MESSAGE_IMAGE_BYTES = 200 * 1024 * 1024;

/** 單張圖的總像素上限，同 dsh 的 `DEFAULT_MAX_IMAGE_PIXELS`（`attachment-local/src/index.ts:40`）。讀得到尺寸時才擋。 */
export const MAX_IMAGE_PIXELS = 64_000_000;

export interface Admission {
  /** 收得進來的，照原本的順序。 */
  readonly accepted: readonly File[];
  /** 擋下的，每個一句講得出原因的話。 */
  readonly rejected: readonly string[];
}

/**
 * 前端先擋的上限（單張 20 MB、一句話 20 張、一句話圖片總量 200 MB）：新選進來的檔案逐個看，**超過的那一個不收進草稿**，
 * 並說原因；其餘照常收。超過就拒收、不縮圖（同 dsh）。不是白名單內的圖與一般檔案不受這三條管（檔案的大小由伺服器決定）。
 * 總像素要讀圖才知道，在送出時擋（`lib/attachment-send.ts`）。
 *
 * @param current - 草稿裡已經有的。
 */
export function admitFiles(
  current: readonly DraftAttachment[],
  incoming: readonly File[],
): Admission {
  let images = 0;
  let bytes = 0;
  for (const item of current) {
    if (item.kind === 'image') {
      images += 1;
      bytes += item.file.size;
    }
  }
  const accepted: File[] = [];
  const rejected: string[] = [];
  for (const file of incoming) {
    if (attachmentKind(file) === 'file') {
      accepted.push(file);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      rejected.push(
        `「${file.name}」有 ${formatBytes(file.size)}，一張圖最多 ${formatBytes(MAX_IMAGE_BYTES)}（超過不縮圖）。`,
      );
    } else if (images >= MAX_IMAGES_PER_MESSAGE) {
      rejected.push(`一句話最多 ${MAX_IMAGES_PER_MESSAGE} 張圖，「${file.name}」沒有加進來。`);
    } else if (bytes + file.size > MAX_MESSAGE_IMAGE_BYTES) {
      rejected.push(
        `一句話的圖片加起來最多 ${formatBytes(MAX_MESSAGE_IMAGE_BYTES)}，「${file.name}」沒有加進來。`,
      );
    } else {
      images += 1;
      bytes += file.size;
      accepted.push(file);
    }
  }
  return { accepted, rejected };
}

/** 位元組數寫成人讀的樣子：`0 B`、`512 B`、`12.3 KB`、`4.0 MB`（1024 進位，一位小數，B 不帶小數）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.floor(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** 大寫的副檔名：`report.final.pdf` → `PDF`；沒有副檔名（或只有開頭的點）是 `undefined`。 */
export function fileExtension(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toUpperCase();
}

/** 附件卡第二行：`PDF · 12.3 KB`，沒有副檔名就只有大小。 */
export function attachmentDetail(file: Pick<File, 'name' | 'size'>): string {
  const extension = fileExtension(file.name);
  const size = formatBytes(file.size);
  return extension === undefined ? size : `${extension} · ${size}`;
}
