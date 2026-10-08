/**
 * 已送出的圖的縮圖（[#733](https://github.com/DemianLi/nexus-agent/issues/733)）：照 `client.readAttachment` 讀回來的 base64 轉成 blob URL。
 *
 * - **一條 thread 一份**（`createAttachmentImageSource(client, threadId)`）：授權是「這條 thread 的日誌引用過那個 `attachmentId`」，換 thread 就整個重掛
 *   （`App.tsx` 的 `key`），所以快取不必帶 thread。
 * - **同一個 `attachmentId` 只讀一次**（內容定址：同一張圖送兩次是同一個 id），成功的結果留著供重畫。失敗的**不留**：
 *   thread 還沒載入完（`attachment_not_found`）之後重畫還能再試，不會永遠卡在失敗。
 * - 拿不到（沒有附件儲存、日誌沒引用、網路壞了）一律回 `undefined`，畫面退回名字＋大小的標籤，不畫壞圖。
 * - `dispose` 把留著的 blob URL 都放掉（thread 卸載時），放掉時還在讀的作廢；之後同一份還能再讀。
 *
 * @module
 */

import type { WireClient } from '@nexus/wire';

export interface AttachmentImageSource {
  /** 圖的 blob URL；讀不到是 `undefined`。 */
  readonly read: (attachmentId: string, mediaType: string) => Promise<string | undefined>;
  readonly dispose: () => void;
}

/** 標準 base64 → 位元組。 */
function decodeBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function createAttachmentImageSource(
  client: Pick<WireClient, 'readAttachment'>,
  threadId: string,
): AttachmentImageSource {
  const cache = new Map<string, Promise<string | undefined>>();
  const urls: string[] = [];
  // 放掉之後（`dispose`）才回來的讀取作廢；StrictMode 開發時會假卸載再掛回來，同一份 source 之後還要能讀。
  let epoch = 0;
  const load = async (attachmentId: string, mediaType: string): Promise<string | undefined> => {
    const started = epoch;
    try {
      const outcome = await client.readAttachment(threadId, attachmentId);
      if (outcome.kind !== 'ok' || started !== epoch) return undefined;
      const url = URL.createObjectURL(
        new Blob([decodeBase64(outcome.result.data)], { type: mediaType }),
      );
      urls.push(url);
      return url;
    } catch {
      return undefined;
    }
  };
  return {
    read(attachmentId, mediaType) {
      const cached = cache.get(attachmentId);
      if (cached !== undefined) return cached;
      const pending = load(attachmentId, mediaType).then((url) => {
        if (url === undefined) cache.delete(attachmentId);
        return url;
      });
      cache.set(attachmentId, pending);
      return pending;
    },
    dispose() {
      epoch += 1;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.length = 0;
      cache.clear();
    },
  };
}
