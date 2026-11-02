/**
 * 圖片轉碼併發上限的**設定條目**（[#2033](https://github.com/DemianLi/nexus-agent/issues/2033)）。
 *
 * 形狀、載體與「關不掉」的理由**逐條同** [`./thread-title.ts`](./thread-title.ts) 的檔頭，不在這裡重述一次。這一顆自己的兩件事：
 *
 * 1. **只有一個鍵**：`imageCompressionConcurrency`，1 到 8 的整數，預設 2。一台主機多人共用，部署方照 CPU 調。
 *    規範化的總像素、長邊與位元組目標不開成設定，是出廠常數（`image-normalization.ts`）。
 * 2. **消費者在 server 起動期**：`serve.ts` 用 `startupSetting` 讀，交給 `AttachmentStore` 的建構子，一個行程一份，比任何一條 thread 都早。
 *
 * @module
 */

import { z } from 'zod';

import type { NexusPlugin, PluginRegistry } from '@nexus/core';

import {
  DEFAULT_IMAGE_COMPRESSION_CONCURRENCY,
  MAX_IMAGE_COMPRESSION_CONCURRENCY,
} from '../attachment-store.js';

/** 這一列在訊息裡叫什麼。 */
export const ATTACHMENT_IMAGES_PLUGIN_NAME = 'attachment-images';

/** `strictObject`：多寫一個欄位是打錯字，同其他幾列。 */
export const attachmentImagesConfigSchema = z.strictObject({
  /** 同時規範化的圖數；超過的排隊（先進先出）。 */
  imageCompressionConcurrency: z
    .number()
    .int()
    .min(1)
    .max(MAX_IMAGE_COMPRESSION_CONCURRENCY)
    .default(DEFAULT_IMAGE_COMPRESSION_CONCURRENCY),
});

/** 驗過的設定。 */
export type AttachmentImagesConfig = z.infer<typeof attachmentImagesConfigSchema>;

/** 只講設定的那一顆，見 `./thread-title.ts` 的檔頭。 */
export const attachmentImagesPlugin: NexusPlugin<AttachmentImagesConfig> = {
  name: ATTACHMENT_IMAGES_PLUGIN_NAME,
  Config: attachmentImagesConfigSchema,
  apply: (_registry: PluginRegistry, _config: AttachmentImagesConfig): void => {
    // 空的：組裝期沒有消費者。
  },
};

export default attachmentImagesPlugin;
