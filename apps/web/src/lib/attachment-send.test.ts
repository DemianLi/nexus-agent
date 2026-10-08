import type { UploadOutcome } from '@nexus/wire';
import { MODEL_DOES_NOT_SUPPORT_IMAGES } from '@nexus/wire';
import { describe, expect, it, vi } from 'vitest';

import { attachmentRejectionText, prepareAttachments } from '@/lib/attachment-send';
import { attachmentKind } from '@/lib/attachments';
import type { DraftAttachment } from '@/lib/attachments';

const item = (name: string, type: string, content = 'hello'): DraftAttachment => {
  const file = new File([content], name, { type });
  return { id: name, file, kind: attachmentKind(file) };
};

/** 假上傳：記下每次的 (thread, 檔名)，依檔名回收據 `r-<檔名>`，或照 `fail` 回別的。 */
function uploader(fail: Record<string, UploadOutcome | Error> = {}) {
  const calls: [string, string][] = [];
  const uploadFile = vi.fn(async (threadId: string, body: Blob | Uint8Array, name?: string) => {
    calls.push([threadId, name ?? '']);
    const wrong = fail[name ?? ''];
    if (wrong instanceof Error) throw wrong;
    if (wrong !== undefined) return wrong;
    void body;
    return { kind: 'ok', receipt: { receiptId: `r-${name}`, name: name ?? '', bytes: 5 } } as const;
  });
  return { uploadFile, calls };
}

describe('prepareAttachments', () => {
  it('白名單內的圖內嵌 base64（不上傳）、檔案上傳換收據，照選取順序', async () => {
    const { uploadFile, calls } = uploader();
    const outcome = await prepareAttachments(
      { uploadFile },
      'thread-1',
      [item('a.png', 'image/png'), item('b.pdf', 'application/pdf'), item('c.gif', 'image/gif')],
      async () => undefined,
    );
    expect(outcome).toEqual({
      kind: 'ok',
      attachments: [
        { type: 'image', mediaType: 'image/png', data: btoa('hello'), name: 'a.png' },
        { type: 'file', receiptId: 'r-b.pdf' },
        { type: 'image', mediaType: 'image/gif', data: btoa('hello'), name: 'c.gif' },
      ],
    });
    // 圖不走上傳；檔案上傳到的是這條 thread。
    expect(calls).toEqual([['thread-1', 'b.pdf']]);
  });

  it('不在白名單的圖（svg）當檔案上傳，不內嵌', async () => {
    const { uploadFile, calls } = uploader();
    const outcome = await prepareAttachments(
      { uploadFile },
      't',
      [item('logo.svg', 'image/svg+xml')],
      async () => undefined,
    );
    expect(outcome).toEqual({
      kind: 'ok',
      attachments: [{ type: 'file', receiptId: 'r-logo.svg' }],
    });
    expect(calls).toEqual([['t', 'logo.svg']]);
  });

  it('順序不受上傳快慢影響：慢的檔案排在前面，結果還是它在前', async () => {
    const order: string[] = [];
    const uploadFile = vi.fn(async (_t: string, _b: Blob | Uint8Array, name?: string) => {
      await new Promise((resolve) => setTimeout(resolve, name === 'slow.pdf' ? 30 : 0));
      order.push(name ?? '');
      return {
        kind: 'ok',
        receipt: { receiptId: `r-${name}`, name: name ?? '', bytes: 1 },
      } as const;
    });
    const outcome = await prepareAttachments(
      { uploadFile },
      't',
      [item('slow.pdf', 'application/pdf'), item('fast.pdf', 'application/pdf')],
      async () => undefined,
    );
    expect(order).toEqual(['fast.pdf', 'slow.pdf']);
    expect(outcome).toEqual({
      kind: 'ok',
      attachments: [
        { type: 'file', receiptId: 'r-slow.pdf' },
        { type: 'file', receiptId: 'r-fast.pdf' },
      ],
    });
  });

  it('上傳被拒：not_supported 說伺服器不收附件；別的碼帶檔名與原因', async () => {
    const notSupported = await prepareAttachments(
      {
        uploadFile: uploader({ 'a.pdf': { kind: 'rejected', code: 'not_supported', message: 'x' } })
          .uploadFile,
      },
      't',
      [item('a.pdf', 'application/pdf')],
    );
    expect(notSupported).toEqual({ kind: 'failed', message: '這個伺服器不收檔案附件。' });

    const other = await prepareAttachments(
      { uploadFile: uploader({ 'a.pdf': { kind: 'rejected', message: '磁碟滿了' } }).uploadFile },
      't',
      [item('a.pdf', 'application/pdf')],
    );
    expect(other).toEqual({ kind: 'failed', message: '「a.pdf」上傳失敗：磁碟滿了' });
  });

  it('上傳拋錯（斷線）也是失敗，不是未處理的拒絕', async () => {
    const outcome = await prepareAttachments(
      { uploadFile: uploader({ 'a.pdf': new Error('fetch failed') }).uploadFile },
      't',
      [item('a.pdf', 'application/pdf')],
    );
    expect(outcome).toEqual({ kind: 'failed', message: 'fetch failed' });
  });

  it('任何一個失敗整句就不備好：回第一個失敗（照選取順序）', async () => {
    const outcome = await prepareAttachments(
      {
        uploadFile: uploader({
          'b.pdf': { kind: 'rejected', message: 'B 壞了' },
          'c.pdf': { kind: 'rejected', message: 'C 壞了' },
        }).uploadFile,
      },
      't',
      [
        item('a.pdf', 'application/pdf'),
        item('b.pdf', 'application/pdf'),
        item('c.pdf', 'application/pdf'),
      ],
    );
    expect(outcome).toEqual({ kind: 'failed', message: '「b.pdf」上傳失敗：B 壞了' });
  });

  describe('單張圖的像素上限（逐張、讀得到長寬才擋）', () => {
    it('超過 64 百萬像素：說尺寸，什麼都不上傳', async () => {
      const { uploadFile } = uploader();
      const outcome = await prepareAttachments(
        { uploadFile },
        't',
        [item('doc.pdf', 'application/pdf'), item('huge.png', 'image/png')],
        async () => ({ width: 8200, height: 7900 }),
      );
      expect(outcome.kind).toBe('failed');
      expect(outcome.kind === 'failed' && outcome.message).toContain('huge.png');
      expect(outcome.kind === 'failed' && outcome.message).toContain('8200×7900');
      expect(uploadFile).not.toHaveBeenCalled();
    });

    it('剛好 64 百萬像素收；讀不到長寬不擋', async () => {
      const exact = await prepareAttachments(
        { uploadFile: uploader().uploadFile },
        't',
        [item('a.png', 'image/png')],
        async () => ({ width: 8000, height: 8000 }),
      );
      expect(exact.kind).toBe('ok');
      const unknown = await prepareAttachments(
        { uploadFile: uploader().uploadFile },
        't',
        [item('a.png', 'image/png')],
        async () => undefined,
      );
      expect(unknown.kind).toBe('ok');
    });

    it('是每一張各自算，不加總：兩張各 40 百萬像素（合計超過 64）都收', async () => {
      const outcome = await prepareAttachments(
        { uploadFile: uploader().uploadFile },
        't',
        [item('a.png', 'image/png'), item('b.png', 'image/png')],
        async () => ({ width: 8000, height: 5000 }),
      );
      expect(outcome.kind).toBe('ok');
    });

    it('多張裡只有一張超過：點名那一張', async () => {
      const sizes = [
        { width: 1000, height: 1000 },
        { width: 8200, height: 7900 },
      ];
      let index = 0;
      const outcome = await prepareAttachments(
        { uploadFile: uploader().uploadFile },
        't',
        [item('small.png', 'image/png'), item('huge.png', 'image/png')],
        async () => sizes[index++],
      );
      expect(outcome.kind === 'failed' && outcome.message).toContain('huge.png');
      expect(outcome.kind === 'failed' && outcome.message).not.toContain('small.png');
    });

    it('只看白名單內的圖：檔案不讀尺寸', async () => {
      const readSize = vi.fn(async () => ({ width: 99999, height: 99999 }));
      const outcome = await prepareAttachments(
        { uploadFile: uploader().uploadFile },
        't',
        [item('logo.svg', 'image/svg+xml'), item('a.pdf', 'application/pdf')],
        readSize,
      );
      expect(outcome.kind).toBe('ok');
      expect(readSize).not.toHaveBeenCalled();
    });
  });
});

describe('attachmentRejectionText', () => {
  it('模型不收圖與伺服器不收附件換成給人看的話；不認得的碼回 undefined', () => {
    expect(attachmentRejectionText(MODEL_DOES_NOT_SUPPORT_IMAGES)).toContain('目前的模型不收圖片');
    expect(attachmentRejectionText('not_supported')).toBe('這個伺服器不收附件。');
    expect(attachmentRejectionText('invalid_argument')).toBeUndefined();
    expect(attachmentRejectionText(undefined)).toBeUndefined();
  });
});
