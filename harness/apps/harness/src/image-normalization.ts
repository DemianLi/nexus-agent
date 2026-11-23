/**
 * 收下的圖在落盤之前規範化（[#2033](https://github.com/DemianLi/nexus-agent/issues/2033)）：整張解碼、套 EXIF 轉向、轉 8-bit sRGB、
 * 縮到像素預算以內、重新編碼。落盤的是這一份，附件 id 是它的 sha256，原圖不留（存哪一份見 #1827）。送模型的那一份也用這裡的 {@link normalizeImage}，只是預算不同（`request-image.ts`）。
 *
 * - **整張解碼**（{@link decodeImage}）：`failOn: 'error'`、把像素真的解出來，檔頭之後壞掉的圖在這裡拒收。
 *   寬高回報轉向之後看起來的軸（EXIF 5–8 交換寬高）。
 * - **已經合格的原樣通過**（{@link canPassThroughNormalization}）：不是 GIF、單幀、沒有中繼資料（EXIF／XMP／IPTC／ICC／轉向／註解）、
 *   8-bit、sRGB，而且位元組、總像素、長邊都在政策內，就一個位元組都不動。
 * - **其餘重新編碼**：轉正 → sRGB → 先套總像素預算、再套長邊上限（保比例、不放大）→ 品質 85／75／60 依序試，
 *   有 alpha 用 WebP（effort 0），沒有用 JPEG；第一個不超過位元組目標的就停，全都超過留最小的那份。
 * - **重新編碼的輸出再解一次驗**：單幀、8-bit sRGB、沒有中繼資料、寬高與媒體類型對得上、alpha 相容，不合就是寫入失敗
 *   （`ATTACHMENT_STORE_FAILED`）。另用 {@link probeImageHeader} 比一次：讀圖時（`AttachmentStore.readImage`）比的是這支檔頭探針，
 *   不是 sharp，兩者對同一份位元組報出不同寬高的話，存得進去的圖會讀不出來，所以在收下時就擋住。
 * - 出廠政策（{@link DEFAULT_NORMALIZATION_POLICY}）：總像素 2048²、長邊 8192、位元組目標 4 MiB。
 * - sharp 延遲載入：第一張圖才載 libvips，沒收過圖的 serve 不付這份成本。
 * - **壞圖、型別不符拋 {@link ImageIntakeError}，規範化失敗拋 `AttachmentError`**：wire 上「使用者送的圖不行」與「伺服器存不下」
 *   分兩種回覆，前者是 `invalid_argument`，見 `wire-handler.ts` 收圖那一段。
 *
 * @module
 */

import { createRequire } from 'node:module';

import type { ImageMediaType } from '@nexus/core';
import type { Metadata, Sharp } from 'sharp';
import type sharpModule from 'sharp';

import { AttachmentError } from './attachment-error.js';
import { ImageIntakeError, probeImageHeader } from './image-intake.js';

/** 規範化的政策：落盤那一份用 {@link DEFAULT_NORMALIZATION_POLICY}，送模型那一份用 `REQUEST_IMAGE_POLICY`。 */
export interface NormalizationPolicy {
  /** 總像素預算；超過的等比例縮小。 */
  readonly maxPixels: number;
  /** 長邊上限，套在總像素預算之後，管住極端的長寬比。 */
  readonly maxDimension: number;
  /** 品質階梯的位元組目標；每一階都超過就留最小的那份。 */
  readonly maxBytes: number;
}

/** 出廠的總像素預算（{@link NormalizationPolicy.maxPixels}），不開成設定。 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS = 2048 * 2048;
/** 出廠的長邊上限（{@link NormalizationPolicy.maxDimension}），不開成設定。 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION = 8192;
/** 出廠的位元組目標（{@link NormalizationPolicy.maxBytes}），不開成設定。 */
export const DEFAULT_NORMALIZED_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

/** `AttachmentStore` 落盤用的出廠政策。 */
export const DEFAULT_NORMALIZATION_POLICY: NormalizationPolicy = Object.freeze({
  maxPixels: DEFAULT_NORMALIZED_IMAGE_MAX_PIXELS,
  maxDimension: DEFAULT_NORMALIZED_IMAGE_MAX_DIMENSION,
  maxBytes: DEFAULT_NORMALIZED_IMAGE_MAX_BYTES,
});

/** 品質階梯，由高到低依序試。 */
export const IMAGE_ENCODING_QUALITIES = [85, 75, 60] as const;
/** WebP 固定最低 effort：編碼時間優先。 */
const WEBP_ENCODING_EFFORT = 0;

/** 整張解碼之後的事實。 */
export interface DecodedImage {
  readonly mediaType: ImageMediaType;
  /** 套過 EXIF 轉向、看起來的寬。 */
  readonly width: number;
  /** 套過 EXIF 轉向、看起來的高。 */
  readonly height: number;
  /** 不只一幀。 */
  readonly animated: boolean;
  /** 帶描述性中繼資料、色彩描述檔或轉向。 */
  readonly carriesMetadata: boolean;
  /** sharp 回報的取樣深度（`uchar` 是 8-bit）。 */
  readonly depth: string;
  /** sharp 回報的色彩空間。 */
  readonly space: string;
  readonly hasAlpha: boolean;
}

/** 規範化之後要落盤的那一份。 */
export interface NormalizedImage {
  readonly data: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly width: number;
  readonly height: number;
}

type SharpFactory = typeof sharpModule;

let loadedSharp: SharpFactory | undefined;

/** 第一次用到才載 sharp（連帶 libvips）。 */
function requireSharp(): SharpFactory {
  loadedSharp ??= createRequire(import.meta.url)('sharp') as SharpFactory;
  return loadedSharp;
}

const MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function carriesRetainedMetadata(metadata: Metadata): boolean {
  return (
    metadata.exif !== undefined ||
    metadata.xmp !== undefined ||
    metadata.iptc !== undefined ||
    metadata.icc !== undefined ||
    metadata.hasProfile === true ||
    metadata.tifftagPhotoshop !== undefined ||
    metadata.comments !== undefined ||
    metadata.orientation !== undefined
  );
}

async function imageFacts(image: Sharp): Promise<DecodedImage | undefined> {
  const metadata = await image.metadata();
  const mediaType = MEDIA_TYPES[metadata.format as string];
  if (mediaType === undefined) return undefined;
  // EXIF 5–8 轉置了存的點陣，回報看起來的軸：規範化政策的判定與參照的寬高都用這一組。
  const transposed = metadata.orientation !== undefined && metadata.orientation >= 5;
  return {
    mediaType,
    width: transposed ? metadata.height : metadata.width,
    height: transposed ? metadata.width : metadata.height,
    animated: (metadata.pages ?? 1) > 1,
    carriesMetadata: carriesRetainedMetadata(metadata),
    depth: metadata.depth,
    space: metadata.space,
    hasAlpha: metadata.hasAlpha,
  };
}

/**
 * 整張解碼一份圖，回報它的事實。認不出、解不完都回 `undefined`。
 *
 * @param data - 完整的編碼後位元組。
 */
export async function decodeImage(data: Uint8Array): Promise<DecodedImage | undefined> {
  const sharp = requireSharp();
  try {
    // 不設 sharp 的像素上限：進來的位元組都先過了檔頭那一關（`admitImages`）的總像素與單邊上限，或是這一支自己的輸出，或是讀回的落盤那一份（收下時至少過了總像素上限）。
    const image = sharp(data, { failOn: 'error', limitInputPixels: false });
    const facts = await imageFacts(image);
    if (facts === undefined) return undefined;
    await image.raw().toBuffer();
    return facts;
  } catch {
    return undefined;
  }
}

/**
 * 已經合格、可以一個位元組都不動地通過的圖。
 *
 * @param decoded - 整張解碼的事實。
 * @param bytes - 編碼後的位元組數。
 * @param policy - 規範化政策。
 */
export function canPassThroughNormalization(
  decoded: DecodedImage,
  bytes: number,
  policy: NormalizationPolicy,
): boolean {
  return (
    decoded.mediaType !== 'image/gif' &&
    !decoded.animated &&
    !decoded.carriesMetadata &&
    decoded.depth === 'uchar' &&
    decoded.space === 'srgb' &&
    bytes <= policy.maxBytes &&
    decoded.width * decoded.height <= policy.maxPixels &&
    Math.max(decoded.width, decoded.height) <= policy.maxDimension
  );
}

/**
 * 總像素不超過預算的寬高，保比例：長邊先取整，短邊照比例四捨五入，還超過就把長邊再減一。
 */
export function budgetedDimensions(
  width: number,
  height: number,
  maxPixels: number,
): { width: number; height: number } {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale));
    let projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round((projectedWidth * height) / width));
    }
    return { width: projectedWidth, height: projectedHeight };
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale));
  let projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(1, Math.round((projectedHeight * width) / height));
  }
  return { width: projectedWidth, height: projectedHeight };
}

/** 先套總像素預算、再套長邊上限：保比例（取整誤差內）、不放大。 */
function targetDimensions(
  decoded: DecodedImage,
  policy: NormalizationPolicy,
): { width: number; height: number } {
  const budgeted = budgetedDimensions(decoded.width, decoded.height, policy.maxPixels);
  const longEdge = Math.max(budgeted.width, budgeted.height);
  if (longEdge <= policy.maxDimension) return budgeted;
  const scale = policy.maxDimension / longEdge;
  return {
    width: Math.max(1, Math.floor(budgeted.width * scale)),
    height: Math.max(1, Math.floor(budgeted.height * scale)),
  };
}

/** 固定尺寸、已轉正、不帶中繼資料的 sRGB 管線。 */
function preparedPipeline(data: Uint8Array, width: number, height: number): Sharp {
  // 不設像素上限的理由同 {@link decodeImage}。
  return requireSharp()(data, { failOn: 'error', limitInputPixels: false })
    .rotate()
    .toColourspace('srgb')
    .resize({ width, height, fit: 'inside', withoutEnlargement: true });
}

async function encode(
  pipeline: Sharp,
  mediaType: 'image/jpeg' | 'image/webp',
  quality: number,
): Promise<NormalizedImage> {
  const encoded =
    mediaType === 'image/webp'
      ? pipeline.webp({ quality, effort: WEBP_ENCODING_EFFORT })
      : pipeline.jpeg({ quality });
  const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), mediaType, width: info.width, height: info.height };
}

/**
 * 依品質階梯一階一階編碼，第一個不超過目標的就停；每一階都超過就回最小的那份。
 */
async function encodeWithinTarget(
  prepared: Sharp,
  hasAlpha: boolean,
  maxBytes: number,
): Promise<NormalizedImage> {
  const mediaType = hasAlpha ? 'image/webp' : 'image/jpeg';
  let smallest: NormalizedImage | undefined;
  for (const quality of IMAGE_ENCODING_QUALITIES) {
    const candidate = await encode(prepared.clone(), mediaType, quality);
    if (candidate.data.byteLength <= maxBytes) return candidate;
    if (smallest === undefined || candidate.data.byteLength < smallest.data.byteLength) {
      smallest = candidate;
    }
  }
  return smallest!;
}

/**
 * 輸出的 alpha 跟來源相容：libvips 可能把全不透明的 alpha 平面從 WebP 拿掉，其餘的增減都是不相容。
 * 來源是 GIF 時不比（幀的 alpha 沒有定義；呼叫端傳 `undefined`）。
 */
function alphaIsCompatible(
  sourceHasAlpha: boolean | undefined,
  output: Pick<DecodedImage, 'mediaType' | 'hasAlpha'>,
): boolean {
  return (
    sourceHasAlpha === undefined ||
    output.hasAlpha === sourceHasAlpha ||
    (sourceHasAlpha && !output.hasAlpha && output.mediaType === 'image/webp')
  );
}

async function verifyNormalized(
  image: NormalizedImage,
  sourceHasAlpha: boolean | undefined,
): Promise<NormalizedImage> {
  const decoded = await decodeImage(image.data);
  const header = probeImageHeader(image.data);
  if (
    decoded === undefined ||
    decoded.mediaType !== image.mediaType ||
    decoded.width !== image.width ||
    decoded.height !== image.height ||
    decoded.animated ||
    decoded.carriesMetadata ||
    decoded.depth !== 'uchar' ||
    decoded.space !== 'srgb' ||
    !alphaIsCompatible(sourceHasAlpha, decoded) ||
    header?.mediaType !== image.mediaType ||
    header.width !== image.width ||
    header.height !== image.height
  ) {
    throw new AttachmentError(
      '圖片規範化沒有產出寬高與中繼資料都對得上的單幀 8-bit sRGB 圖',
      'ATTACHMENT_STORE_FAILED',
    );
  }
  return image;
}

/**
 * 照政策做出一份：收圖時是落盤那一份，組請求時是送模型那一份。已經合格的原樣通過；其餘重新編碼並驗過。
 *
 * @param data - 完整的編碼後位元組（收下的，或讀回的落盤那一份）。
 * @param decoded - 整張解碼的事實（{@link decodeImage}）。
 * @param policy - 規範化政策。
 * @throws {AttachmentError} 轉不出合格的輸出（`ATTACHMENT_STORE_FAILED`）。
 */
export async function normalizeImage(
  data: Uint8Array,
  decoded: DecodedImage,
  policy: NormalizationPolicy,
): Promise<NormalizedImage> {
  if (canPassThroughNormalization(decoded, data.byteLength, policy)) {
    return { data, mediaType: decoded.mediaType, width: decoded.width, height: decoded.height };
  }
  try {
    const { width, height } = targetDimensions(decoded, policy);
    const chosen = await encodeWithinTarget(
      preparedPipeline(data, width, height),
      decoded.hasAlpha,
      policy.maxBytes,
    );
    return await verifyNormalized(
      chosen,
      decoded.mediaType === 'image/gif' ? undefined : decoded.hasAlpha,
    );
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError(
      `這張 ${decoded.depth} ${decoded.mediaType.slice('image/'.length).toUpperCase()} 轉不成規範化的 8-bit sRGB：${
        error instanceof Error ? error.message : String(error)
      }`,
      'ATTACHMENT_STORE_FAILED',
      { cause: error },
    );
  }
}

/** 收下的一張圖：檔頭那一關（`admitImages`）已經過了。 */
export interface ImageSubmission {
  readonly bytes: Uint8Array;
  readonly mediaType: ImageMediaType;
  readonly name?: string | undefined;
  /** 錯誤訊息裡指這一張的說法（「第 2 張圖（a.png）」）。 */
  readonly label: string;
}

/** 預備好、還沒落盤的一張圖。 */
export interface PreparedImage {
  readonly normalized: NormalizedImage;
  /** 解碼出來、轉向之後的原寬高。 */
  readonly source: { readonly width: number; readonly height: number };
  readonly name?: string | undefined;
}

/**
 * 整張解碼、比宣告的型別、規範化，不碰儲存。
 *
 * @throws {ImageIntakeError} 解不完（`INVALID_IMAGE`）或宣告的型別跟位元組不符（`IMAGE_TYPE_MISMATCH`）。
 * @throws {AttachmentError} 規範化失敗（`ATTACHMENT_STORE_FAILED`）。
 */
export async function prepareImage(
  input: ImageSubmission,
  policy: NormalizationPolicy,
): Promise<PreparedImage> {
  const decoded = await decodeImage(input.bytes);
  if (decoded === undefined) {
    throw new ImageIntakeError(`${input.label}解不開，可能已經損毀`, 'INVALID_IMAGE');
  }
  if (decoded.mediaType !== input.mediaType) {
    throw new ImageIntakeError(
      `${input.label}宣告是 ${input.mediaType}，位元組卻是 ${decoded.mediaType}`,
      'IMAGE_TYPE_MISMATCH',
    );
  }
  return {
    normalized: await normalizeImage(input.bytes, decoded, policy),
    source: { width: decoded.width, height: decoded.height },
    name: input.name,
  };
}
