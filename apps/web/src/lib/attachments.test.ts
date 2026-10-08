// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  attachmentDetail,
  attachmentKind,
  fileExtension,
  formatBytes,
  serverSupportsAttachments,
} from '@/lib/attachments';
import { dragHasFiles } from '@/lib/file-drag';

describe('草稿附件的純函式', () => {
  it('image/* 是圖，其餘（含沒有型別）是檔案', () => {
    expect(attachmentKind({ type: 'image/png' })).toBe('image');
    expect(attachmentKind({ type: 'image/svg+xml' })).toBe('image');
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

  it('伺服器收不收附件：連線協定（#732）合進來之前一律不收', () => {
    expect(serverSupportsAttachments()).toBe(false);
  });

  it('整頁拖放只認檔案：文字、連結不算', () => {
    expect(dragHasFiles(['Files'])).toBe(true);
    expect(dragHasFiles(['text/plain', 'Files'])).toBe(true);
    expect(dragHasFiles(['text/plain'])).toBe(false);
    expect(dragHasFiles(['text/uri-list'])).toBe(false);
    expect(dragHasFiles(undefined)).toBe(false);
  });
});
