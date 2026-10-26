import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import {
  GIF_7X5,
  JPEG_7X5,
  PNG_7X5,
  WEBP_ALPHA_123X45,
  WEBP_LOSSLESS_7X5,
} from './image-fixtures.js';
import { probeImageHeader } from './image-intake.js';
import {
  budgetedDimensions,
  decodeImage,
  DEFAULT_NORMALIZATION_POLICY,
  normalizeImage,
  prepareImage,
} from './image-normalization.js';
import type { NormalizationPolicy } from './image-normalization.js';

const policy = DEFAULT_NORMALIZATION_POLICY;

function bytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

async function solid(
  width: number,
  height: number,
  format: 'png' | 'jpeg',
  options: { alpha?: boolean; orientation?: number; noise?: boolean } = {},
): Promise<Uint8Array> {
  const channels = options.alpha === true ? 4 : 3;
  let image = sharp({
    create: {
      width,
      height,
      channels,
      background: options.alpha === true ? { r: 200, g: 0, b: 0, alpha: 0.5 } : '#c00',
      ...(options.noise === true ? { noise: { type: 'gaussian', mean: 128, sigma: 60 } } : {}),
    },
  });
  image = format === 'png' ? image.png() : image.jpeg();
  if (options.orientation !== undefined)
    image = image.withMetadata({ orientation: options.orientation });
  return new Uint8Array(await image.toBuffer());
}

async function normalize(data: Uint8Array, custom: NormalizationPolicy = policy) {
  const decoded = await decodeImage(data);
  if (decoded === undefined) throw new Error('解不開');
  return { decoded, normalized: await normalizeImage(data, decoded, custom) };
}

describe('整張解碼', () => {
  it('認得四種格式，寬高與 alpha 對得上', async () => {
    expect(await decodeImage(bytes(PNG_7X5))).toMatchObject({
      mediaType: 'image/png',
      width: 7,
      height: 5,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
      animated: false,
    });
    expect(await decodeImage(bytes(GIF_7X5))).toMatchObject({ mediaType: 'image/gif' });
    expect(await decodeImage(bytes(WEBP_ALPHA_123X45))).toMatchObject({
      mediaType: 'image/webp',
      width: 123,
      height: 45,
      hasAlpha: true,
    });
  });

  it('EXIF 5–8 回報轉向之後的軸，並算成帶中繼資料', async () => {
    const turned = await solid(40, 20, 'jpeg', { orientation: 6 });
    expect(probeImageHeader(turned)).toMatchObject({ width: 40, height: 20 });
    expect(await decodeImage(turned)).toMatchObject({
      width: 20,
      height: 40,
      carriesMetadata: true,
    });
    expect(await decodeImage(await solid(40, 20, 'jpeg', { orientation: 3 }))).toMatchObject({
      width: 40,
      height: 20,
    });
  });

  it('檔頭完整、後面壞掉的圖解不開（檔頭探針認得它）', async () => {
    const whole = await solid(64, 64, 'png', { noise: true });
    const truncated = whole.subarray(0, Math.floor(whole.byteLength / 2));
    expect(probeImageHeader(truncated)).toMatchObject({ mediaType: 'image/png', width: 64 });
    expect(await decodeImage(truncated)).toBeUndefined();
    expect(await decodeImage(new TextEncoder().encode('not an image'))).toBeUndefined();
  });
});

describe('像素預算的寬高', () => {
  it('預算以內不動；超過就等比例縮到乘積不超過預算', () => {
    expect(budgetedDimensions(2048, 2048, 2048 * 2048)).toEqual({ width: 2048, height: 2048 });
    for (const [width, height] of [
      [3000, 2000],
      [2000, 3000],
      [100_000, 7],
      [4097, 4096],
    ] as const) {
      const out = budgetedDimensions(width, height, 2048 * 2048);
      expect(out.width * out.height).toBeLessThanOrEqual(2048 * 2048);
      expect(Math.abs(out.width / out.height - width / height) / (width / height)).toBeLessThan(
        0.01,
      );
    }
    expect(budgetedDimensions(3000, 2000, 2048 * 2048)).toEqual({ width: 2508, height: 1672 });
  });
});

describe('規範化', () => {
  it('已經合格的原樣通過：位元組一個都不動', async () => {
    for (const fixture of [PNG_7X5, WEBP_LOSSLESS_7X5]) {
      const data = bytes(fixture);
      const { normalized } = await normalize(data);
      expect(normalized.data).toBe(data);
    }
  });

  it('總像素超過預算：縮到 2048² 以內、保比例，JPEG、sRGB、不帶中繼資料，檔頭探針讀得出同樣的寬高', async () => {
    const { normalized } = await normalize(await solid(3000, 2000, 'png'));
    expect(normalized).toMatchObject({ mediaType: 'image/jpeg', width: 2508, height: 1672 });
    const meta = await sharp(normalized.data).metadata();
    expect(meta).toMatchObject({ format: 'jpeg', width: 2508, height: 1672, space: 'srgb' });
    expect(meta.exif).toBeUndefined();
    expect(probeImageHeader(normalized.data)).toEqual({
      mediaType: 'image/jpeg',
      width: 2508,
      height: 1672,
    });
  });

  it('長邊上限套在像素預算之後：極端長寬比照樣收在長邊以內', async () => {
    const { normalized } = await normalize(await solid(200, 10, 'png'), {
      ...policy,
      maxDimension: 100,
    });
    expect(normalized).toMatchObject({ width: 100, height: 5 });
  });

  it('EXIF 轉向的圖轉正、拿掉轉向；沒縮就寬高是轉向之後的', async () => {
    const { normalized } = await normalize(await solid(40, 20, 'jpeg', { orientation: 6 }));
    expect(normalized).toMatchObject({ mediaType: 'image/jpeg', width: 20, height: 40 });
    expect((await sharp(normalized.data).metadata()).orientation).toBeUndefined();
  });

  it('帶 alpha 的編成 WebP、alpha 留著，檔頭探針（VP8X）讀得出同樣的寬高', async () => {
    const { normalized } = await normalize(await solid(3000, 2000, 'png', { alpha: true }));
    expect(normalized.mediaType).toBe('image/webp');
    expect((await decodeImage(normalized.data))?.hasAlpha).toBe(true);
    expect(probeImageHeader(normalized.data)).toEqual({
      mediaType: 'image/webp',
      width: normalized.width,
      height: normalized.height,
    });
  });

  it('GIF 一律重新編碼；帶中繼資料的小 JPEG 也重新編碼', async () => {
    expect((await normalize(bytes(GIF_7X5))).normalized).toMatchObject({
      mediaType: 'image/jpeg',
      width: 7,
      height: 5,
    });
    const jpeg = bytes(JPEG_7X5);
    const { decoded, normalized } = await normalize(jpeg);
    expect(decoded.carriesMetadata).toBe(true);
    expect(normalized.data).not.toBe(jpeg);
    expect((await sharp(normalized.data).metadata()).exif).toBeUndefined();
  });

  it('16-bit PNG 轉成 8-bit', async () => {
    const deep = new Uint8Array(
      await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0c0' } })
        .png()
        .toColourspace('rgb16')
        .toBuffer(),
    );
    const { decoded, normalized } = await normalize(deep);
    expect(decoded.depth).toBe('ushort');
    expect((await decodeImage(normalized.data))?.depth).toBe('uchar');
  });

  it('品質階梯每一階都超過位元組目標：留最小的那份', async () => {
    const noisy = await solid(512, 512, 'png', { noise: true });
    const results = await Promise.all(
      [85, 60].map(async (quality) =>
        sharp(noisy)
          .jpeg({ quality })
          .toBuffer()
          .then((buffer) => buffer.byteLength),
      ),
    );
    const { normalized } = await normalize(noisy, { ...policy, maxBytes: 1 });
    expect(normalized.data.byteLength).toBeLessThan(results[0]!);
    expect(normalized.data.byteLength).toBe(results[1]!);
  });
});

describe('預備一張圖', () => {
  it('解不開：INVALID_IMAGE；宣告的型別跟位元組不符：IMAGE_TYPE_MISMATCH', async () => {
    const whole = await solid(64, 64, 'png', { noise: true });
    await expect(
      prepareImage(
        { bytes: whole.subarray(0, 100), mediaType: 'image/png', label: '第 1 張圖' },
        policy,
      ),
    ).rejects.toMatchObject({ name: 'ImageIntakeError', code: 'INVALID_IMAGE' });
    await expect(
      prepareImage({ bytes: bytes(GIF_7X5), mediaType: 'image/png', label: '第 2 張圖' }, policy),
    ).rejects.toMatchObject({
      name: 'ImageIntakeError',
      code: 'IMAGE_TYPE_MISMATCH',
      message: expect.stringContaining('第 2 張圖') as unknown,
    });
  });

  it('原寬高是轉向之後的', async () => {
    const prepared = await prepareImage(
      {
        bytes: await solid(3000, 1000, 'jpeg', { orientation: 6 }),
        mediaType: 'image/jpeg',
        label: '第 1 張圖',
      },
      policy,
    );
    expect(prepared.source).toEqual({ width: 1000, height: 3000 });
    expect(prepared.normalized.height).toBeGreaterThan(prepared.normalized.width);
  });
});
