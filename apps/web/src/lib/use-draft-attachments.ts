/**
 * 草稿附件的狀態（#733）：加、移、清空，圖的 object URL 在移除、清空、卸載時 revoke。
 *
 * 草稿跟輸入框的文字一樣由呼叫端持有（見 `components/composer.tsx` 檔頭），所以這顆 hook 掛在 App，不在 Composer 裡。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { admitFiles, attachmentKind } from '@/lib/attachments';
import type { DraftAttachment } from '@/lib/attachments';

export interface DraftAttachments {
  readonly items: readonly DraftAttachment[];
  readonly add: (files: readonly File[]) => void;
  readonly remove: (id: string) => void;
  /** 一次移掉幾個（送出成功後移掉送出的那幾個，送出期間才加進來的留著）。 */
  readonly removeMany: (ids: readonly string[]) => void;
  readonly clear: () => void;
}

/**
 * @param onReject - 前端先擋的上限擋下檔案時叫（`lib/attachments.ts` 的 `admitFiles`）：每個被擋的一句原因。
 */
export function useDraftAttachments(
  onReject?: (messages: readonly string[]) => void,
): DraftAttachments {
  const [items, setItems] = useState<readonly DraftAttachment[]>([]);
  const counter = useRef(0);
  // 卸載時要 revoke 的是「當下」這一份，不是第一次渲染時的。
  const latest = useRef(items);
  latest.current = items;

  const reject = useRef(onReject);
  reject.current = onReject;

  const add = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    const { accepted, rejected } = admitFiles(latest.current, files);
    if (rejected.length > 0) reject.current?.(rejected);
    if (accepted.length === 0) return;
    const added = accepted.map((file): DraftAttachment => {
      counter.current += 1;
      const kind = attachmentKind(file);
      const id = `attachment-${counter.current}`;
      return kind === 'image'
        ? { id, file, kind, previewUrl: URL.createObjectURL(file) }
        : { id, file, kind };
    });
    // 之後的 `latest` 要立刻看得到這一批：同一個 tick 連加兩批，後一批的上限要把前一批算進去。
    latest.current = [...latest.current, ...added];
    setItems((current) => [...current, ...added]);
  }, []);

  const remove = useCallback((id: string) => {
    const target = latest.current.find((item) => item.id === id);
    if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const removeMany = useCallback((ids: readonly string[]) => {
    const gone = new Set(ids);
    for (const item of latest.current) {
      if (gone.has(item.id) && item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
    }
    latest.current = latest.current.filter((item) => !gone.has(item.id));
    setItems((current) => current.filter((item) => !gone.has(item.id)));
  }, []);

  const clear = useCallback(() => {
    for (const item of latest.current) {
      if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
    }
    setItems([]);
  }, []);

  useEffect(
    () => () => {
      for (const item of latest.current) {
        if (item.previewUrl !== undefined) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  return { items, add, remove, removeMany, clear };
}
