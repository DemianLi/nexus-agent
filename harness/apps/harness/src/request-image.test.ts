import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PNG_7X5 } from './image-fixtures.js';
import { budgetedDimensions } from './image-normalization.js';
import {
  createRequestImage,
  DEFAULT_REQUEST_IMAGE_MAX_BYTES,
  readCachedRequestImage,
  REQUEST_IMAGE_POLICY,
  requestImagesRootOf,
  requestImageVariantId,
  writeCachedRequestImage,
} from './request-image.js';

const REF = { attachmentId: `sha256:${'a'.repeat(64)}` };

let home: string;
let root: string;
beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-request-image-'));
  root = requestImagesRootOf(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('預算', () => {
  it('總像素 2048²、長邊 8192、每張 1 MiB', () => {
    expect(REQUEST_IMAGE_POLICY).toEqual({
      maxPixels: 2048 * 2048,
      maxDimension: 8192,
      maxBytes: DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    });
    expect(DEFAULT_REQUEST_IMAGE_MAX_BYTES).toBe(1024 * 1024);
  });
});

describe('那一份的身分', () => {
  it('同一張圖、同一組預算：同一個；附件 id 或預算任何一格不同：不同', () => {
    const base = requestImageVariantId(REF, REQUEST_IMAGE_POLICY);
    expect(requestImageVariantId({ ...REF }, { ...REQUEST_IMAGE_POLICY })).toBe(base);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    const others = [
      requestImageVariantId({ attachmentId: `sha256:${'b'.repeat(64)}` }, REQUEST_IMAGE_POLICY),
      requestImageVariantId(REF, { ...REQUEST_IMAGE_POLICY, maxPixels: 1024 * 1024 }),
      requestImageVariantId(REF, { ...REQUEST_IMAGE_POLICY, maxDimension: 4096 }),
      requestImageVariantId(REF, { ...REQUEST_IMAGE_POLICY, maxBytes: 4 * 1024 * 1024 }),
    ];
    expect(new Set([base, ...others]).size).toBe(5);
  });
});

describe('做出送模型的那一份', () => {
  it('已經合格的小圖：位元組一個都不動', async () => {
    const data = new Uint8Array(Buffer.from(PNG_7X5, 'base64'));
    const made = await createRequestImage(data, REQUEST_IMAGE_POLICY);
    expect(made.data).toBe(data);
    expect(made).toMatchObject({ mediaType: 'image/png', width: 7, height: 5 });
  });

  it('規範化之前落盤的大圖（EXIF 6）：轉正、縮到總像素預算以內，寬高就是 budgetedDimensions 算的', async () => {
    const raw = await sharp({
      create: { width: 3000, height: 2000, channels: 3, background: '#a26' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const made = await createRequestImage(new Uint8Array(raw), REQUEST_IMAGE_POLICY);
    expect({ width: made.width, height: made.height }).toEqual(
      budgetedDimensions(2000, 3000, REQUEST_IMAGE_POLICY.maxPixels),
    );
    expect(made).toMatchObject({ mediaType: 'image/jpeg', width: 1672, height: 2508 });
    const meta = await sharp(made.data).metadata();
    expect(meta).toMatchObject({ width: 1672, height: 2508, space: 'srgb', depth: 'uchar' });
    expect(meta.orientation).toBeUndefined();
  });

  it('16-bit PNG 轉成 8-bit', async () => {
    const deep = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#0c0' } })
      .png()
      .toColourspace('rgb16')
      .toBuffer();
    const made = await createRequestImage(new Uint8Array(deep), REQUEST_IMAGE_POLICY);
    expect((await sharp(made.data).metadata()).depth).toBe('uchar');
  });

  it('超過每張的位元組目標：品質往下試到 1 MiB 以內', async () => {
    const noisy = await sharp({
      create: {
        width: 2048,
        height: 2048,
        channels: 3,
        background: '#888',
        noise: { type: 'gaussian', mean: 128, sigma: 15 },
      },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    expect(noisy.byteLength).toBeGreaterThan(DEFAULT_REQUEST_IMAGE_MAX_BYTES);
    const made = await createRequestImage(new Uint8Array(noisy), REQUEST_IMAGE_POLICY);
    expect(made.data.byteLength).toBeLessThanOrEqual(DEFAULT_REQUEST_IMAGE_MAX_BYTES);
    expect(made).toMatchObject({ mediaType: 'image/jpeg', width: 2048, height: 2048 });
  });

  it('解不開：ATTACHMENT_STORE_FAILED', async () => {
    await expect(
      createRequestImage(new TextEncoder().encode('not an image'), REQUEST_IMAGE_POLICY),
    ).rejects.toMatchObject({ name: 'AttachmentError', code: 'ATTACHMENT_STORE_FAILED' });
  });
});

describe('快取', () => {
  const id = requestImageVariantId(REF, REQUEST_IMAGE_POLICY);
  const data = new Uint8Array(Buffer.from(PNG_7X5, 'base64'));

  it('寫了讀得回；檔案 0600、目錄 0700，路徑是 <前兩碼>/<身分>，沒有留下暫存檔', async () => {
    await writeCachedRequestImage(root, id, data);
    const path = join(root, id.slice(0, 2), id);
    expect(await readFile(path)).toEqual(Buffer.from(data));
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, id.slice(0, 2)))).mode & 0o777).toBe(0o700);
    expect(await readCachedRequestImage(root, id, REQUEST_IMAGE_POLICY)).toEqual({
      data,
      mediaType: 'image/png',
      width: 7,
      height: 5,
    });
  });

  it('沒有、不是圖、超出預算：都當沒有', async () => {
    expect(await readCachedRequestImage(root, id, REQUEST_IMAGE_POLICY)).toBeUndefined();
    await writeCachedRequestImage(root, id, new TextEncoder().encode('garbage'));
    expect(await readCachedRequestImage(root, id, REQUEST_IMAGE_POLICY)).toBeUndefined();
    await writeCachedRequestImage(root, id, data);
    expect(
      await readCachedRequestImage(root, id, { ...REQUEST_IMAGE_POLICY, maxPixels: 7 * 5 - 1 }),
    ).toBeUndefined();
    expect(
      await readCachedRequestImage(root, id, { ...REQUEST_IMAGE_POLICY, maxDimension: 6 }),
    ).toBeUndefined();
  });

  it('同一份再寫一次：蓋過去', async () => {
    await writeCachedRequestImage(root, id, new TextEncoder().encode('first'));
    await writeCachedRequestImage(root, id, data);
    expect(await readFile(join(root, id.slice(0, 2), id))).toEqual(Buffer.from(data));
  });

  it('快取根在 harness home 的 cache 底下，跟附件根分開', () => {
    expect(requestImagesRootOf('/h')).toBe('/h/cache/attachments/request-images');
  });

  it('寫不進去（根是一個檔）：拋', async () => {
    await writeFile(join(home, 'cache'), 'x');
    await expect(writeCachedRequestImage(root, id, data)).rejects.toThrow();
  });
});
