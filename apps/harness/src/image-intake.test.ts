/**
 * 圖片收下的檢查（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：檔頭認格式與寬高、四道上限、
 * 全有或全無。真檔（`image-fixtures.ts`）逐種對過；手組的檔頭只用來造「真檔造不出來」的邊界（超大的寬高、殘缺）。
 */

import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  JPEG_7X5,
  GIF_7X5,
  PNG_7X5,
  WEBP_ALPHA_123X45,
  WEBP_LOSSLESS_7X5,
  WEBP_LOSSY_7X5,
} from './image-fixtures.js';
import {
  admitImages,
  DEFAULT_IMAGE_LIMITS,
  ImageIntakeError,
  probeImageHeader,
} from './image-intake.js';

const bytesOf = (base64: string) => new Uint8Array(Buffer.from(base64, 'base64'));

/** 只有 PNG 簽名與 IHDR 的檔頭：夠讓探針讀寬高，造得出 8001×8000 這種真圖片檔造不出來的東西。 */
function pngHeader(width: number, height: number): Uint8Array {
  const out = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(out);
  out.writeUInt32BE(13, 8);
  out.write('IHDR', 12, 'ascii');
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt8(8, 24);
  out.writeUInt8(2, 25);
  return new Uint8Array(out);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('檔頭認格式與寬高（真檔）', () => {
  it.each([
    ['PNG', PNG_7X5, 'image/png', 7, 5],
    ['JPEG（EXIF、ICC 在 SOF 前面）', JPEG_7X5, 'image/jpeg', 7, 5],
    ['GIF', GIF_7X5, 'image/gif', 7, 5],
    ['WebP 有損（VP8）', WEBP_LOSSY_7X5, 'image/webp', 7, 5],
    ['WebP 無損（VP8L）', WEBP_LOSSLESS_7X5, 'image/webp', 7, 5],
    ['WebP 帶透明度（VP8X）', WEBP_ALPHA_123X45, 'image/webp', 123, 45],
  ])('%s', (_label, data, mediaType, width, height) => {
    expect(probeImageHeader(bytesOf(data))).toEqual({ mediaType, width, height });
  });

  it('PNG 的寬高在四個位元組的大端：大於 65535 也讀對', () => {
    expect(probeImageHeader(pngHeader(70000, 3))).toEqual({
      mediaType: 'image/png',
      width: 70000,
      height: 3,
    });
  });
});

describe('認不出來的一律是 undefined', () => {
  it('空的、純文字、別的格式（BMP）', () => {
    expect(probeImageHeader(new Uint8Array(0))).toBeUndefined();
    expect(probeImageHeader(new TextEncoder().encode('hello world, not an image'))).toBeUndefined();
    expect(probeImageHeader(Buffer.from('BM' + 'x'.repeat(60)))).toBeUndefined();
  });

  it('檔頭殘缺：每一種格式砍到一半', () => {
    for (const data of [PNG_7X5, JPEG_7X5, GIF_7X5, WEBP_LOSSY_7X5, WEBP_LOSSLESS_7X5]) {
      const full = bytesOf(data);
      expect(probeImageHeader(full.subarray(0, 9))).toBeUndefined();
    }
  });

  it('寬或高是 0', () => {
    expect(probeImageHeader(pngHeader(0, 5))).toBeUndefined();
    expect(probeImageHeader(pngHeader(5, 0))).toBeUndefined();
  });

  it('PNG 簽名後面第一個 chunk 不是 IHDR', () => {
    const header = Buffer.from(pngHeader(7, 5));
    header.write('IDAT', 12, 'ascii');
    expect(probeImageHeader(new Uint8Array(header))).toBeUndefined();
  });

  it('JPEG 沒碰到 SOF 就進了影像資料（SOS）', () => {
    const noFrame = Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0, 0, 0, 0]);
    expect(probeImageHeader(new Uint8Array(noFrame))).toBeUndefined();
  });

  it('JPEG 的 SOF2（漸進式）也認得，標記前的 0xFF 墊底跳過', () => {
    const frame = Buffer.from([
      0xff, 0xd8, 0xff, 0xff, 0xff, 0xc2, 0x00, 0x0b, 8, 0x00, 0x20, 0x00, 0x40, 1, 1, 0x11, 0,
    ]);
    expect(probeImageHeader(new Uint8Array(frame))).toEqual({
      mediaType: 'image/jpeg',
      width: 64,
      height: 32,
    });
  });
});

describe('收下一句話的圖（四道上限、全有或全無）', () => {
  const png = { mediaType: 'image/png', data: PNG_7X5, name: 'a.png' } as const;

  it('收得下的：位元組解開、事實從位元組認、順序與名字不變', () => {
    const [first, second] = admitImages([png, { mediaType: 'image/gif', data: GIF_7X5 }]);
    expect(first).toMatchObject({ mediaType: 'image/png', width: 7, height: 5, name: 'a.png' });
    expect(first!.bytes).toEqual(bytesOf(PNG_7X5));
    expect(second).toMatchObject({ mediaType: 'image/gif', width: 7, height: 5 });
  });

  it('宣告的媒體類型與位元組對不上：拒收', () => {
    expect(() => admitImages([{ mediaType: 'image/jpeg', data: PNG_7X5 }])).toThrow(
      /宣告是 image\/jpeg，位元組卻是 image\/png/,
    );
  });

  it('不是四種之一的媒體類型、不是 base64、不是圖：INVALID_IMAGE', () => {
    for (const part of [
      { mediaType: 'image/bmp', data: PNG_7X5 },
      { mediaType: 'image/png', data: 'not base64!!' },
      { mediaType: 'image/png', data: 'abc' },
      { mediaType: 'image/png', data: b64(new TextEncoder().encode('hello hello hello')) },
      { mediaType: 'image/png', data: '' },
    ]) {
      const error = (() => {
        try {
          admitImages([part]);
        } catch (caught) {
          return caught;
        }
        return undefined;
      })();
      expect(error, JSON.stringify(part).slice(0, 60)).toBeInstanceOf(ImageIntakeError);
      expect((error as ImageIntakeError).code).toBe('INVALID_IMAGE');
    }
  });

  const small = { ...DEFAULT_IMAGE_LIMITS, maxImageBytes: 100 };

  it('每張的位元組上限：IMAGE_TOO_LARGE，先看 base64 長度、不解碼就拒', () => {
    const big = b64(new Uint8Array(101));
    expect(() => admitImages([{ mediaType: 'image/png', data: big }], small)).toThrowError(
      expect.objectContaining({ code: 'IMAGE_TOO_LARGE' }),
    );
    // 剛好等於上限的不算超過（解出來不是圖，所以走到 INVALID_IMAGE 而不是 TOO_LARGE）。
    expect(() =>
      admitImages([{ mediaType: 'image/png', data: b64(new Uint8Array(100)) }], small),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE' }));
  });

  it('超大的 base64 在解碼之前就被位元組上限擋下（預設 20 MiB）', () => {
    const huge = 'A'.repeat(4 * 1024 * 1024 * 7); // 解出來約 21 MiB
    expect(() => admitImages([{ mediaType: 'image/png', data: huge }])).toThrowError(
      expect.objectContaining({ code: 'IMAGE_TOO_LARGE' }),
    );
  });

  it('每句張數上限：TOO_MANY_IMAGES；第 21 張就拒，不看內容', () => {
    const twenty = Array.from({ length: 20 }, () => png);
    expect(admitImages(twenty)).toHaveLength(20);
    expect(() => admitImages([...twenty, png])).toThrowError(
      expect.objectContaining({ code: 'TOO_MANY_IMAGES' }),
    );
  });

  it('每句總量上限：MESSAGE_IMAGES_TOO_LARGE', () => {
    const total = { ...DEFAULT_IMAGE_LIMITS, maxMessageImageBytes: 100 };
    const one = bytesOf(PNG_7X5).byteLength;
    const count = Math.floor(100 / one) + 1;
    expect(() =>
      admitImages(
        Array.from({ length: count }, () => png),
        total,
      ),
    ).toThrowError(expect.objectContaining({ code: 'MESSAGE_IMAGES_TOO_LARGE' }));
    expect(
      admitImages(
        Array.from({ length: count - 1 }, () => png),
        total,
      ),
    ).toHaveLength(count - 1);
  });

  it('每張像素上限：8000×8000 = 6400 萬剛好收，8001×8000 拒', () => {
    expect(
      admitImages([{ mediaType: 'image/png', data: b64(pngHeader(8000, 8000)) }]),
    ).toHaveLength(1);
    expect(() =>
      admitImages([{ mediaType: 'image/png', data: b64(pngHeader(8001, 8000)) }]),
    ).toThrowError(expect.objectContaining({ code: 'IMAGE_TOO_MANY_PIXELS' }));
  });

  it('全有或全無：第二張不行，整句拒、不回前一張', () => {
    expect(() =>
      admitImages([png, { mediaType: 'image/png', data: b64(pngHeader(8001, 8000)) }]),
    ).toThrow(/第 2 張圖/);
  });

  it('訊息指出是哪一張、叫什麼名字', () => {
    expect(() =>
      admitImages([png, { mediaType: 'image/png', data: 'zzzz', name: 'bad.png' }]),
    ).toThrow(/第 2 張圖（bad\.png）/);
  });

  it('壓縮過的真 PNG（zlib 手組）也走得通', () => {
    const idat = deflateSync(Buffer.alloc(10));
    expect(idat.byteLength).toBeGreaterThan(0);
    expect(admitImages([png])[0]!.bytes.byteLength).toBe(bytesOf(PNG_7X5).byteLength);
  });
});
