import { describe, expect, it } from 'vitest';

import { bytesOfBase64, createLineDecoder, startsWithBom, utf8Length } from '@/lib/line-bytes';
import type { LineChunk } from '@/lib/line-bytes';

/**
 * 位元組窗口讀長行（#555）。判準照路由的文字頁：同一個檔不該因為哪一行比較長就換一個「是不是文字」的判準。
 */

const encode = (text: string) => new TextEncoder().encode(text);

/** 把位元組切成每 `size` 個一個窗口，餵給一個解碼器，接出整行。 */
function readInWindows(bytes: Uint8Array, size: number, atFileStart = false) {
  const decoder = createLineDecoder(atFileStart);
  let text = '';
  let consumed = 0;
  for (let at = 0; at < bytes.length || at === 0; at += size) {
    const window = bytes.subarray(at, at + size);
    const chunk: LineChunk = decoder.push(window, at + size >= bytes.length);
    if (chunk.kind === 'not-text') return chunk;
    text += chunk.text;
    consumed += chunk.consumed;
    if (chunk.done) return { kind: 'done' as const, text, consumed };
  }
  return { kind: 'open' as const, text, consumed };
}

describe('utf8Length', () => {
  it.each(['', 'ascii', '中文字', '🏳️‍🌈 旗子', 'é\u0301', '\r\n混合 mixed 🙂'])(
    '跟真的編碼一次一樣：%j',
    (text) => {
      expect(utf8Length(text)).toBe(encode(text).length);
    },
  );
});

describe('bytesOfBase64', () => {
  it('解回原本的位元組，含 0x00 與 0xff', () => {
    const bytes = new Uint8Array([0, 1, 0x0a, 0xff, 0xef, 0xbb, 0xbf]);
    const base64 = btoa(String.fromCharCode(...bytes));
    expect([...bytesOfBase64(base64)]).toEqual([...bytes]);
    expect(bytesOfBase64('').length).toBe(0);
  });
});

describe('createLineDecoder', () => {
  const LINE = '開頭 🏳️‍🌈 中間 é\u0301 結尾'.repeat(50);

  it.each([1, 2, 3, 5, 7, 64])(
    '多位元組字元被切在兩個窗口之間也接得回來（窗口 %i 位元組）',
    (size) => {
      const result = readInWindows(encode(`${LINE}\nnext`), size);
      expect(result).toEqual({ kind: 'done', text: LINE, consumed: encode(LINE).length });
    },
  );

  it('讀到 `\\n` 就停；同一個窗口裡換行之後的東西不算這一行（含 NUL 與半個字元）', () => {
    const tail = new Uint8Array([0x0a, 0x00, 0xe4, 0xb8]); // 換行、NUL、半個「中」
    const bytes = new Uint8Array([...encode('abc'), ...tail]);
    expect(createLineDecoder(false).push(bytes, false)).toEqual({
      kind: 'text',
      text: 'abc',
      consumed: 3,
      done: true,
    });
  });

  it('`\\r` 留在行裡，同路由', () => {
    expect(readInWindows(encode('a\r\nb'), 16)).toEqual({ kind: 'done', text: 'a\r', consumed: 2 });
  });

  it('檔尾沒有換行：讀到檔尾就是這一行的結尾', () => {
    expect(readInWindows(encode('只有一行'), 4)).toMatchObject({ kind: 'done', text: '只有一行' });
  });

  it.each([
    ['行裡有 NUL', new Uint8Array([0x61, 0x00, 0x62, 0x0a])],
    ['不是 UTF-8', new Uint8Array([0x61, 0xff, 0x62, 0x0a])],
    ['檔尾停在半個字元', new Uint8Array([0x61, 0xe4, 0xb8])],
  ])('%s：不是文字', (_, bytes) => {
    expect(readInWindows(bytes, 2)).toEqual({ kind: 'not-text' });
  });

  it('BOM 只在檔頭吃掉；從檔中間開始的一行，開頭的 U+FEFF 是真的字', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('x\n')]);
    expect(readInWindows(bytes, 2, true)).toMatchObject({ text: 'x', consumed: 4 });
    expect(readInWindows(bytes, 2, false)).toMatchObject({ text: '\uFEFFx', consumed: 4 });
  });

  it('startsWithBom', () => {
    expect(startsWithBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe(true);
    expect(startsWithBom(new Uint8Array([0xef, 0xbb]))).toBe(false);
    expect(startsWithBom(encode('abc'))).toBe(false);
  });
});
