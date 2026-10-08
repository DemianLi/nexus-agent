import type { WireClient } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAttachmentImageSource } from '@/lib/attachment-image';

type AttachmentReadOutcome = Awaited<ReturnType<WireClient['readAttachment']>>;

const ok = (data: string): AttachmentReadOutcome => ({
  kind: 'ok',
  result: {
    attachment: {
      type: 'image',
      attachmentId: 'sha256:a',
      mediaType: 'image/png',
      bytes: 3,
      width: 1,
      height: 1,
    },
    data,
  },
});
const rejected = (code: string): AttachmentReadOutcome => ({
  kind: 'rejected',
  code,
  message: code,
});

/** jsdom 的 Blob 沒有 arrayBuffer()，用 FileReader 讀。 */
const bytesOf = (blob: Blob) =>
  new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });

let created: Blob[];
let revoked: string[];
beforeEach(() => {
  created = [];
  revoked = [];
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => {
      created.push(blob);
      return `blob:${created.length}`;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('已送出的圖的縮圖來源（#733）', () => {
  it('讀回來的 base64 轉成 blob URL，型別照參照的媒體型別，位元組逐個對得上', async () => {
    const readAttachment = vi.fn(async () => ok(btoa('abc')));
    const source = createAttachmentImageSource({ readAttachment }, 'thread-1');
    await expect(source.read('sha256:a', 'image/png')).resolves.toBe('blob:1');
    expect(readAttachment).toHaveBeenCalledWith('thread-1', 'sha256:a');
    expect(created[0]?.type).toBe('image/png');
    expect(new Uint8Array(await bytesOf(created[0]!))).toEqual(new Uint8Array([97, 98, 99]));
  });

  it('同一個 attachmentId 只讀一次（同時問兩次也一次）；不同的 id 各讀各的', async () => {
    const readAttachment = vi.fn(async () => ok(btoa('abc')));
    const source = createAttachmentImageSource({ readAttachment }, 't');
    const [first, second] = await Promise.all([
      source.read('sha256:a', 'image/png'),
      source.read('sha256:a', 'image/png'),
    ]);
    expect(first).toBe(second);
    await source.read('sha256:a', 'image/png');
    expect(readAttachment).toHaveBeenCalledTimes(1);
    await source.read('sha256:b', 'image/png');
    expect(readAttachment).toHaveBeenCalledTimes(2);
  });

  it('讀不到回 undefined（被拒、拋錯都是）；失敗的不留，下一次還會再試', async () => {
    const readAttachment = vi
      .fn<() => Promise<AttachmentReadOutcome>>()
      .mockResolvedValueOnce(rejected('attachment_not_found'))
      .mockRejectedValueOnce(new Error('網路斷了'))
      .mockResolvedValueOnce(ok(btoa('abc')));
    const source = createAttachmentImageSource({ readAttachment }, 't');
    await expect(source.read('sha256:a', 'image/png')).resolves.toBeUndefined();
    await expect(source.read('sha256:a', 'image/png')).resolves.toBeUndefined();
    await expect(source.read('sha256:a', 'image/png')).resolves.toBe('blob:1');
    expect(readAttachment).toHaveBeenCalledTimes(3);
  });

  it('dispose 放掉已建的 blob URL；還在讀的作廢（不建 URL）；放掉之後同一份還能再讀', async () => {
    let release: (outcome: AttachmentReadOutcome) => void = () => {};
    const readAttachment = vi
      .fn<() => Promise<AttachmentReadOutcome>>()
      .mockResolvedValueOnce(ok(btoa('abc')))
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)))
      .mockResolvedValueOnce(ok(btoa('xyz')));
    const source = createAttachmentImageSource({ readAttachment }, 't');
    await source.read('sha256:a', 'image/png');
    const inFlight = source.read('sha256:b', 'image/png');
    source.dispose();
    expect(revoked).toEqual(['blob:1']);
    release(ok(btoa('abc')));
    await expect(inFlight).resolves.toBeUndefined();
    expect(created).toHaveLength(1);
    await expect(source.read('sha256:a', 'image/png')).resolves.toBe('blob:2');
  });
});
