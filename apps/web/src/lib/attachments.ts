/**
 * 輸入框的草稿附件（#733）：還沒送出的檔案與圖，排在輸入框底下，可以移除。
 *
 * 這一層只管**畫面上的草稿**——檔案選進來、排成一列、移掉。上傳、收據、送出時帶上收據，
 * 要等 #732 的連線協定（那邊還沒合）；這裡不猜它的形狀。
 *
 * @module
 */

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
 * 伺服器收不收附件。**現在一律不收**：#732 的上傳與收據還沒有，沒有它，附件選進來也送不出去（貼上一張圖會變成
 * 一顆永遠送不出的晶片）。連線協定合進來之後，這裡改成讀伺服器回的能力，收到 `not_supported` 就維持 `false`
 * ——整個功能（按鈕、貼上、拖放）都不出現。
 */
export function serverSupportsAttachments(): boolean {
  return false;
}

/** 瀏覽器認得它是圖就當圖畫，其餘都是檔案。 */
export function attachmentKind(file: Pick<File, 'type'>): DraftAttachment['kind'] {
  return file.type.startsWith('image/') ? 'image' : 'file';
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
