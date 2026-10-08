// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  admitFiles,
  attachmentDetail,
  attachmentKind,
  imageMediaType,
  MAX_MESSAGE_IMAGE_BYTES,
  fileExtension,
  formatBytes,
  serverSupportsAttachments,
} from '@/lib/attachments';
import { dragHasFiles } from '@/lib/file-drag';

describe('草稿附件的純函式', () => {
  it('只有 dsh 白名單內的四種是圖（png、jpeg、webp、gif），其餘（含不在白名單的圖、沒有型別）是檔案', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
      expect(attachmentKind({ type })).toBe('image');
      expect(imageMediaType({ type })).toBe(type);
    }
    // 不是「image/ 開頭」：伺服器的收圖檢查不收這些，當一般檔案走上傳。
    for (const type of ['image/svg+xml', 'image/heic', 'image/bmp', 'image/tiff', 'image/avif']) {
      expect(attachmentKind({ type })).toBe('file');
      expect(imageMediaType({ type })).toBeUndefined();
    }
    expect(attachmentKind({ type: 'application/pdf' })).toBe('file');
    expect(attachmentKind({ type: '' })).toBe('file');
  });

  it('位元組數：B 不帶小數，其餘 1024 進位一位小數', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(12_595)).toBe('12.3 KB');
    expect(formatBytes(4 * 1024 * 1024)).toBe('4.0 MB');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
  });

  it('副檔名取最後一段並轉大寫；沒有副檔名、隱藏檔、結尾的點都是沒有', () => {
    expect(fileExtension('report.final.pdf')).toBe('PDF');
    expect(fileExtension('截圖.png')).toBe('PNG');
    expect(fileExtension('Makefile')).toBeUndefined();
    expect(fileExtension('.env')).toBeUndefined();
    expect(fileExtension('weird.')).toBeUndefined();
  });

  it('附件卡第二行：有副檔名寫「副檔名 · 大小」，沒有只寫大小', () => {
    expect(attachmentDetail({ name: 'a.pdf', size: 2048 })).toBe('PDF · 2.0 KB');
    expect(attachmentDetail({ name: 'Makefile', size: 100 })).toBe('100 B');
  });

  it('伺服器收不收附件：上傳與 run.start 的 attachments 都落地了（#732），出貨就開', () => {
    expect(serverSupportsAttachments()).toBe(true);
  });

  it('整頁拖放只認檔案：文字、連結不算', () => {
    expect(dragHasFiles(['Files'])).toBe(true);
    expect(dragHasFiles(['text/plain', 'Files'])).toBe(true);
    expect(dragHasFiles(['text/plain'])).toBe(false);
    expect(dragHasFiles(['text/uri-list'])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});

/** 不真的配置那麼大的記憶體：檔案物件的 `size` 另外指定。 */
const fileOf = (name: string, type: string, size = 10): File => {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
};
const draft = (file: File, id = file.name) => ({ id, file, kind: attachmentKind(file) }) as const;
const MB = 1024 * 1024;

describe('前端先擋的上限（admitFiles）', () => {
  it('單張超過 20 MB：不收、說原因；剛好 20 MB 收', () => {
    const { accepted, rejected } = admitFiles(
      [],
      [fileOf('big.png', 'image/png', 20 * MB + 1), fileOf('edge.png', 'image/png', 20 * MB)],
    );
    expect(accepted.map((file) => file.name)).toEqual(['edge.png']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('big.png');
    expect(rejected[0]).toContain('20.0 MB');
  });

  it('一句話最多 20 張圖：算上草稿裡已有的，第 21 張不收', () => {
    const current = Array.from({ length: 19 }, (_, i) => draft(fileOf(`${i}.png`, 'image/png')));
    const { accepted, rejected } = admitFiles(current, [
      fileOf('20.png', 'image/png'),
      fileOf('21.png', 'image/png'),
    ]);
    expect(accepted.map((file) => file.name)).toEqual(['20.png']);
    expect(rejected[0]).toContain('最多 20 張');
    expect(rejected[0]).toContain('21.png');
  });

  it('圖片加起來最多 200 MB：超過的那張不收，後面小的還收', () => {
    const current = [draft(fileOf('a.png', 'image/png', 15 * MB))];
    const incoming = [
      ...Array.from({ length: 9 }, (_, i) => fileOf(`b${i}.jpg`, 'image/jpeg', 20 * MB)),
      fileOf('c.jpg', 'image/jpeg', 6 * MB),
      fileOf('tiny.jpg', 'image/jpeg', 1 * MB),
    ];
    // 15 + 9×20 = 195；再 6 → 201 超過；tiny 1 → 196 收。
    const { accepted, rejected } = admitFiles(current, incoming);
    expect(accepted.map((file) => file.name)).toEqual(
      [...incoming.slice(0, 9), incoming[10]!].map((f) => f.name),
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain('c.jpg');
    expect(rejected[0]).toContain(`${MAX_MESSAGE_IMAGE_BYTES / MB}.0 MB`);
  });

  it('一般檔案與不在白名單的圖不受這三條管、也不佔額度', () => {
    const current = Array.from({ length: 20 }, (_, i) => draft(fileOf(`${i}.png`, 'image/png')));
    const { accepted, rejected } = admitFiles(current, [
      fileOf('huge.pdf', 'application/pdf', 900 * MB),
      fileOf('logo.svg', 'image/svg+xml', 30 * MB),
    ]);
    expect(accepted.map((file) => file.name)).toEqual(['huge.pdf', 'logo.svg']);
    expect(rejected).toEqual([]);
  });

  it('收進來的照原本順序', () => {
    const { accepted } = admitFiles(
      [],
      [
        fileOf('1.png', 'image/png'),
        fileOf('2.pdf', 'application/pdf'),
        fileOf('3.gif', 'image/gif'),
      ],
    );
    expect(accepted.map((file) => file.name)).toEqual(['1.png', '2.pdf', '3.gif']);
  });
});
