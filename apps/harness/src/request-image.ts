/**
 * 送模型的那一份圖（[#2033](https://github.com/DemianLi/nexus-agent/issues/2033)）：組請求時照預算從落盤那一份做出來，存在快取裡，
 * 之後每一輪讀快取、不再轉碼（落盤那一份照樣每一輪先讀、驗過）。
 *
 * - **預算**（{@link REQUEST_IMAGE_POLICY}）：總像素 2048²、長邊 8192、每張位元組目標 1 MiB，出廠常數，不開成設定。
 *   歷史裡的每張圖每一輪都重送，位元組目標比落盤的 4 MiB 低，新收、超過 1 MiB 的圖送出時再壓一次。
 * - **做法同落盤**：整張解碼、轉正、轉 8-bit sRGB、縮、重新編碼（`image-normalization.ts`）。規範化之前落盤的圖可能是原圖
 *   （16-bit、帶 EXIF 轉向、GIF 動圖），所以不能假設來源已經合格；合格的原樣通過。
 * - **快取**：`<harness home>/cache/attachments/request-images/<前兩碼>/<雜湊>`，雜湊是 {@link requestImageVariantId}：附件 id（來源位元組的
 *   sha256）、預算、品質階梯與這支的版本，任何一樣變了就是另一份。原樣通過的也存一份，下一輪不必再整張解碼才知道能原樣送。
 *   先寫暫存檔、`rename` 進正式位置，讀的一方讀不到寫一半的檔；目錄 `0700`、檔案 `0600`。讀快取時重讀檔頭，媒體類型不是
 *   JPEG／WebP／PNG、或寬高超出預算就當沒有；內容不跟落盤那一份比對，信任範圍同 harness home（`0700`）。
 * - **沒有淘汰**：每份附件在一組預算下一份，位元組目標 1 MiB（品質階梯每一階都超過時留最小的那份，可能略大）。換了轉換版本或預算，
 *   舊的那份留在原地、沒有東西清；整個目錄刪掉只是下一輪重新轉碼。
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { ImageAttachmentRef, ImageMediaType } from '@nexus/core';

import { AttachmentError } from './attachment-error.js';
import { probeImageHeader } from './image-intake.js';
import {
  decodeImage,
  DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
  IMAGE_ENCODING_QUALITIES,
  normalizeImage,
} from './image-normalization.js';
import type { NormalizationPolicy } from './image-normalization.js';
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from './owner-only.js';

/** 轉換版本：做法改了就換，舊的快取自然不再命中。 */
export const REQUEST_IMAGE_TRANSFORM_VERSION = 'request-image-v1';

/** 每張請求圖的位元組目標，不開成設定。 */
export const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;

/** 送模型那一份的出廠預算。 */
export const REQUEST_IMAGE_POLICY: NormalizationPolicy = Object.freeze({
  maxPixels: DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
  maxDimension: DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
});

/** 送模型的那一份。 */
export interface RequestImage {
  readonly data: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

/** 請求圖的快取根：`<harness home>/cache/attachments/request-images`。只解析，不建目錄。 */
export function requestImagesRootOf(home: string): string {
  return join(home, 'cache', 'attachments', 'request-images');
}

/**
 * 一張圖在一組預算下的那一份的身分：轉換版本、附件 id、預算與品質階梯的 sha256。
 *
 * @param ref - 落盤那一份的參照。
 * @param policy - 預算。
 */
export function requestImageVariantId(
  ref: Pick<ImageAttachmentRef, 'attachmentId'>,
  policy: NormalizationPolicy,
): string {
  const descriptor = JSON.stringify({
    transformVersion: REQUEST_IMAGE_TRANSFORM_VERSION,
    attachmentId: ref.attachmentId,
    maxPixels: policy.maxPixels,
    maxDimension: policy.maxDimension,
    maxBytes: policy.maxBytes,
    qualities: IMAGE_ENCODING_QUALITIES,
  });
  return createHash('sha256').update(descriptor).digest('hex');
}

function cachePathOf(root: string, variantId: string): string {
  return join(root, variantId.slice(0, 2), variantId);
}

const CACHEABLE_TYPES: ReadonlySet<ImageMediaType> = new Set([
  'image/jpeg',
  'image/webp',
  'image/png',
]);

/**
 * 讀快取裡的那一份；沒有、讀不了、檔頭不對或寬高超出預算都回 `undefined`（當成沒有，重做）。
 *
 * @param root - {@link requestImagesRootOf}。
 * @param variantId - {@link requestImageVariantId}。
 * @param policy - 同一組預算。
 */
export async function readCachedRequestImage(
  root: string,
  variantId: string,
  policy: NormalizationPolicy,
): Promise<RequestImage | undefined> {
  let data: Uint8Array;
  try {
    data = new Uint8Array(await readFile(cachePathOf(root, variantId)));
  } catch {
    return undefined;
  }
  const facts = probeImageHeader(data);
  if (
    facts === undefined ||
    !CACHEABLE_TYPES.has(facts.mediaType) ||
    facts.width * facts.height > policy.maxPixels ||
    Math.max(facts.width, facts.height) > policy.maxDimension
  ) {
    return undefined;
  }
  return { data, mediaType: facts.mediaType, width: facts.width, height: facts.height };
}

/**
 * 從落盤那一份做出送模型的那一份，不碰快取。不走限流：呼叫端排進 `AttachmentStore` 的轉碼限流器（`readRequestImage` 就是這樣叫的）。
 *
 * @param source - 落盤那一份的位元組（已驗過雜湊）。
 * @param policy - 預算。
 * @throws {AttachmentError} 解不開或轉不出合格的輸出（`ATTACHMENT_STORE_FAILED`）。
 */
export async function createRequestImage(
  source: Uint8Array,
  policy: NormalizationPolicy,
): Promise<RequestImage> {
  const decoded = await decodeImage(source);
  if (decoded === undefined) {
    throw new AttachmentError('存好的圖解不開，做不出送模型的那一份', 'ATTACHMENT_STORE_FAILED');
  }
  return normalizeImage(source, decoded, policy);
}

/**
 * 寫進快取：暫存檔加 `rename`，目錄 `0700`、檔案 `0600`。
 *
 * @param root - {@link requestImagesRootOf}。
 * @param variantId - {@link requestImageVariantId}。
 * @param data - 那一份的位元組。
 * @throws 建目錄、寫暫存檔或 `rename` 失敗：原樣的 fs 錯誤，不包成 `AttachmentError`。不 fsync，快取丟了下一輪重做。
 */
export async function writeCachedRequestImage(
  root: string,
  variantId: string,
  data: Uint8Array,
): Promise<void> {
  const path = cachePathOf(root, variantId);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, data, { mode: PRIVATE_FILE_MODE, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
