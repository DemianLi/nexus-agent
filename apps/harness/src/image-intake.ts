/**
 * 使用者貼的圖，收下之前的檢查（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）。
 *
 * `run.start` 帶的圖是內嵌 base64（`{ type: 'image', mediaType, data, name? }`，見 `@nexus/wire` 的 `PromptAttachment`）。
 * 這一支只做**驗證**：解 base64、從位元組本身認出格式與寬高、四道上限。存下來是 `AttachmentStore.saveImage`。
 *
 * ## 四道上限（照 dsh `attachment-local/src/index.ts:34-40`，`5badb150`）
 *
 * | 上限 | 值 |
 * | --- | --- |
 * | 每張圖（編碼前位元組） | 20 MiB（{@link MAX_IMAGE_BYTES}） |
 * | 每句圖數 | 20（{@link MAX_IMAGES_PER_MESSAGE}） |
 * | 每句圖片總量 | 200 MiB（{@link MAX_MESSAGE_IMAGE_BYTES}） |
 * | 每張像素 | 6400 萬（{@link MAX_IMAGE_PIXELS}，寬乘高） |
 *
 * 超過就**拒收，不縮圖**。位元組上限先看 base64 的長度（不解碼就知道），像素上限要先讀得出寬高。
 *
 * ## 偏離（依 AGENTS.md 登記）
 *
 * 1. **用檔頭認格式與寬高，不整張解碼。** dsh 用 sharp 把整張圖解碼過（`image.ts` 的 `detectImage`）才收，同時做正規化；我們沒有
 *    影像函式庫，也不做正規化（見 `attachment-store.ts` 檔頭偏離 2）。所以「位元組是 PNG／JPEG／WebP／GIF 的檔頭、宣告的
 *    媒體類型對得上、寬高在上限內」會收，**檔頭之後壞掉的圖會被收下**，由端點在請求時拒絕。
 * 2. **EXIF 轉向沒套**：dsh 回報的寬高是轉向之後看起來的軸，我們回報檔頭裡存的軸。只影響顯示用的寬高與像素上限的算法
 *    （乘積不受轉向影響，所以上限判定一樣）。
 *
 * @module
 */

import {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_IMAGES_PER_MESSAGE,
  MAX_MESSAGE_IMAGE_BYTES,
} from '@nexus/wire';
import type { ImageMediaType } from '@nexus/wire';

/** 一道上限的值；測試要壓小才量得到邊界。 */
export interface ImageLimits {
  readonly maxImageBytes: number;
  readonly maxImagesPerMessage: number;
  readonly maxMessageImageBytes: number;
  readonly maxImagePixels: number;
}

/** 出貨的上限，見檔頭的表。 */
export const DEFAULT_IMAGE_LIMITS: ImageLimits = {
  maxImageBytes: MAX_IMAGE_BYTES,
  maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
  maxMessageImageBytes: MAX_MESSAGE_IMAGE_BYTES,
  maxImagePixels: MAX_IMAGE_PIXELS,
};

/** 圖被拒的原因。`message` 是給人看的中文，指出是哪一張、哪一道上限。 */
export type ImageIntakeCode =
  | 'INVALID_IMAGE'
  | 'IMAGE_TOO_LARGE'
  | 'TOO_MANY_IMAGES'
  | 'MESSAGE_IMAGES_TOO_LARGE'
  | 'IMAGE_TOO_MANY_PIXELS';

export class ImageIntakeError extends Error {
  readonly code: ImageIntakeCode;
  constructor(message: string, code: ImageIntakeCode) {
    super(message);
    this.name = 'ImageIntakeError';
    this.code = code;
  }
}

/** 呼叫端送來的一張圖。 */
export interface ImagePart {
  readonly mediaType: string;
  /** 標準 base64。 */
  readonly data: string;
  readonly name?: string | undefined;
}

/** 驗過的一張圖：位元組已解開，媒體類型與寬高是從位元組認出來的。 */
export interface AdmittedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
  readonly name?: string | undefined;
}

/** 從檔頭認出來的格式與寬高。 */
export interface ImageHeaderFacts {
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function startsWith(bytes: Uint8Array, signature: readonly number[], at = 0): boolean {
  return signature.every((value, index) => bytes[at + index] === value);
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[at + index] ?? 0);
  }
  return text;
}

const u16be = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number): number => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number): number =>
  (b[at] ?? 0) * 0x1000000 +
  (((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0));

function probePng(bytes: Uint8Array): ImageHeaderFacts | undefined {
  // 簽名之後第一個 chunk 必須是 IHDR（長度 13）：寬高各四個位元組，大端。
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== 'IHDR' || u32be(bytes, 8) !== 13) {
    return undefined;
  }
  return { mediaType: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function probeGif(bytes: Uint8Array): ImageHeaderFacts | undefined {
  if (bytes.length < 10) return undefined;
  return { mediaType: 'image/gif', width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

/** JPEG 的 SOF 標記（帶影像尺寸的那一族）：C0–CF 去掉 DHT（C4）、JPG（C8）、DAC（CC）。 */
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function probeJpeg(bytes: Uint8Array): ImageHeaderFacts | undefined {
  let at = 2;
  while (at + 3 < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    // 標記前面可以有任意多個 0xFF 墊底。
    while (bytes[at] === 0xff && at < bytes.length) at += 1;
    const marker = bytes[at] ?? 0;
    at += 1;
    // 沒有長度的標記：RSTn、TEM、SOI、EOI。
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      if (marker === 0xd9) return undefined;
      continue;
    }
    const length = u16be(bytes, at);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (at + 7 > bytes.length) return undefined;
      return { mediaType: 'image/jpeg', height: u16be(bytes, at + 3), width: u16be(bytes, at + 5) };
    }
    // 還沒看到 SOF 就進了影像資料：沒有尺寸可讀。
    if (marker === 0xda) return undefined;
    at += length;
  }
  return undefined;
}

function probeWebp(bytes: Uint8Array): ImageHeaderFacts | undefined {
  if (bytes.length < 30) return undefined;
  const chunk = ascii(bytes, 12, 4);
  const data = 20;
  if (chunk === 'VP8X') {
    return {
      mediaType: 'image/webp',
      width: u24le(bytes, data + 4) + 1,
      height: u24le(bytes, data + 7) + 1,
    };
  }
  if (chunk === 'VP8L') {
    if (bytes[data] !== 0x2f) return undefined;
    const b1 = bytes[data + 1] ?? 0;
    const b2 = bytes[data + 2] ?? 0;
    const b3 = bytes[data + 3] ?? 0;
    const b4 = bytes[data + 4] ?? 0;
    return {
      mediaType: 'image/webp',
      width: (((b2 & 0x3f) << 8) | b1) + 1,
      height: (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    // 失真壓縮：影格標頭的起始碼 9d 01 2a 之後是兩個 14 位元的小端寬高。
    if (!startsWith(bytes, [0x9d, 0x01, 0x2a], data + 3)) return undefined;
    return {
      mediaType: 'image/webp',
      width: u16le(bytes, data + 6) & 0x3fff,
      height: u16le(bytes, data + 8) & 0x3fff,
    };
  }
  return undefined;
}

/**
 * 從位元組本身認出格式與寬高（不解碼像素）。認不出、檔頭殘缺、寬或高是 0，都回 `undefined`。
 *
 * @param bytes - 完整的編碼後圖片。
 */
export function probeImageHeader(bytes: Uint8Array): ImageHeaderFacts | undefined {
  let facts: ImageHeaderFacts | undefined;
  if (startsWith(bytes, PNG_SIGNATURE)) facts = probePng(bytes);
  else if (ascii(bytes, 0, 3) === 'GIF' && /^8[79]a$/.test(ascii(bytes, 3, 3)))
    facts = probeGif(bytes);
  else if (startsWith(bytes, [0xff, 0xd8])) facts = probeJpeg(bytes);
  else if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') facts = probeWebp(bytes);
  return facts !== undefined && facts.width > 0 && facts.height > 0 ? facts : undefined;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** 標準 base64 解出來有幾個位元組（不解碼）。不合格式回 `undefined`。 */
function base64DecodedLength(data: string): number | undefined {
  if (data.length % 4 !== 0 || !BASE64.test(data)) return undefined;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function label(index: number, part: ImagePart): string {
  return part.name === undefined || part.name === ''
    ? `第 ${String(index + 1)} 張圖`
    : `第 ${String(index + 1)} 張圖（${part.name}）`;
}

/**
 * 驗一句話裡所有的圖，**全部通過才回**：只要有一張不行整句拒收，沒有「前幾張先存了」。
 * 先做不解碼就知道的檢查（張數、各張與總量的位元組上限），再解碼、認格式、看像素。
 *
 * @param parts - 這一句話帶的圖，照選取順序。
 * @param limits - 四道上限，預設是出貨值。
 * @returns 驗過的圖，順序不變。
 * @throws {ImageIntakeError} 任何一道不過。
 */
export function admitImages(
  parts: readonly ImagePart[],
  limits: ImageLimits = DEFAULT_IMAGE_LIMITS,
): AdmittedImage[] {
  if (parts.length > limits.maxImagesPerMessage) {
    throw new ImageIntakeError(
      `一句話最多 ${String(limits.maxImagesPerMessage)} 張圖，收到 ${String(parts.length)} 張`,
      'TOO_MANY_IMAGES',
    );
  }
  const sizes = parts.map((part, index) => {
    if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(part.mediaType)) {
      throw new ImageIntakeError(
        `${label(index, part)}的媒體類型 ${JSON.stringify(part.mediaType)} 不收，只收 ${IMAGE_MEDIA_TYPES.join('、')}`,
        'INVALID_IMAGE',
      );
    }
    const length = base64DecodedLength(part.data);
    if (length === undefined) {
      throw new ImageIntakeError(`${label(index, part)}不是合格的 base64`, 'INVALID_IMAGE');
    }
    if (length > limits.maxImageBytes) {
      throw new ImageIntakeError(
        `${label(index, part)}有 ${String(length)} 位元組，超過每張 ${String(limits.maxImageBytes)} 的上限`,
        'IMAGE_TOO_LARGE',
      );
    }
    return length;
  });
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total > limits.maxMessageImageBytes) {
    throw new ImageIntakeError(
      `這句話的圖共 ${String(total)} 位元組，超過每句 ${String(limits.maxMessageImageBytes)} 的上限`,
      'MESSAGE_IMAGES_TOO_LARGE',
    );
  }
  return parts.map((part, index) => {
    const bytes = new Uint8Array(Buffer.from(part.data, 'base64'));
    const facts = probeImageHeader(bytes);
    if (facts === undefined) {
      throw new ImageIntakeError(
        `${label(index, part)}不是看得懂的 PNG、JPEG、WebP 或 GIF`,
        'INVALID_IMAGE',
      );
    }
    if (facts.mediaType !== part.mediaType) {
      throw new ImageIntakeError(
        `${label(index, part)}宣告是 ${part.mediaType}，位元組卻是 ${facts.mediaType}`,
        'INVALID_IMAGE',
      );
    }
    if (facts.width * facts.height > limits.maxImagePixels) {
      throw new ImageIntakeError(
        `${label(index, part)}是 ${String(facts.width)}×${String(facts.height)}，超過每張 ${String(limits.maxImagePixels)} 像素的上限`,
        'IMAGE_TOO_MANY_PIXELS',
      );
    }
    return { bytes, ...facts, name: part.name };
  });
}
