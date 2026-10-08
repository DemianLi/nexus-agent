import type { WireAttachmentRef } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { attachmentsPreview, sentAttachmentViews } from '@/lib/sent-attachments';

const file = (name: string, bytes: number, id = 'sha256:a'): WireAttachmentRef => ({
  type: 'file',
  attachmentId: id,
  name,
  bytes,
});
const image = (
  extra: Partial<Extract<WireAttachmentRef, { type: 'image' }>> = {},
): WireAttachmentRef => ({
  type: 'image',
  attachmentId: 'sha256:b',
  mediaType: 'image/png',
  bytes: 2048,
  width: 96,
  height: 64,
  ...extra,
});

describe('已送出的附件標籤（#732）', () => {
  it('檔案：名字，第二行「副檔名 · 大小」；沒有副檔名只寫大小', () => {
    expect(sentAttachmentViews([file('report.pdf', 12_595), file('Makefile', 100)])).toMatchObject([
      { kind: 'file', name: 'report.pdf', detail: 'PDF · 12.3 KB' },
      { kind: 'file', name: 'Makefile', detail: '100 B' },
    ]);
  });

  it('圖也是標籤：名字、副檔名（沒有名字用媒體型別）、大小與寬高；沒有名字寫「圖片」', () => {
    expect(
      sentAttachmentViews([image({ name: 'red.png' }), image({ mediaType: 'image/jpeg' })]),
    ).toMatchObject([
      { kind: 'image', name: 'red.png', detail: 'PNG · 2.0 KB · 96×64' },
      { kind: 'image', name: '圖片', detail: 'JPEG · 2.0 KB · 96×64' },
    ]);
  });

  it('圖的名字沒有副檔名時用媒體型別，不是留空', () => {
    expect(
      sentAttachmentViews([image({ name: 'screenshot', mediaType: 'image/webp' })])[0]?.detail,
    ).toBe('WEBP · 2.0 KB · 96×64');
  });

  it('同一個檔送兩次（內容定址的 id 一樣）key 仍不重複；沒給或空陣列是空清單', () => {
    const keys = sentAttachmentViews([file('a.txt', 1), file('a.txt', 1)]).map((view) => view.key);
    expect(new Set(keys).size).toBe(2);
    expect(sentAttachmentViews(undefined)).toEqual([]);
    expect(sentAttachmentViews([])).toEqual([]);
  });

  it('預覽：附件的名字用頓號接起來（排著那一列只有附件、沒有字時用）', () => {
    expect(attachmentsPreview([image({ name: 'red.png' }), file('note.txt', 55)])).toBe(
      'red.png、note.txt',
    );
    expect(attachmentsPreview(undefined)).toBe('');
  });
});
