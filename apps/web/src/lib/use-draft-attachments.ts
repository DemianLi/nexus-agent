/**
 * 草稿附件的狀態（#733）：加、移、清空，圖的 object URL 在移除、清空、卸載時 revoke。
 *
 * 草稿跟輸入框的文字一樣由呼叫端持有（見 `components/composer.tsx` 檔頭），所以這顆 hook 掛在 App，不在 Composer 裡。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { attachmentKind } from '@/lib/attachments';
import type { DraftAttachment } from '@/lib/attachments';

export interface DraftAttachments {
  readonly items: readonly DraftAttachment[];
  readonly add: (files: readonly File[]) => void;
  readonly remove: (id: string) => void;
  readonly clear: () => void;
}

export function useDraftAttachments(): DraftAttachments {
  const [items, setItems] = useState<readonly DraftAttachment[]>([]);
  const counter = useRef(0);
  // 卸載時要 revoke 的是「當下」這一份，不是第一次渲染時的。
  const latest = useRef(items);
  latest.current = items;

  const add = useCallback((files: readonly File[]) => {
    if (files.length === 0) return;
    const added = files.map((file): DraftAttachment => {
      counter.current += 1;
      const kind = attachmentKind(file);
      const id = `attachment-${counter.current}`;
      return kind === 'image'
        ? { id, file, kind, previewUrl: URL.createObjectURL(file) }
        : { id, file, kind };
    });
    setItems((current) => [...current, ...added]);
  }, []);

  const remove = useCallback((id: string) => {
    const target = latest.current.find((item) => item.id === id);
    if (target?.previewUrl !== undefined) URL.revokeObjectURL(target.previewUrl);
    setItems((current) => current.filter((item) => item.id !== id));
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

  return { items, add, remove, clear };
}
