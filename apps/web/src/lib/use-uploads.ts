/**
 * 附件上傳的狀態與取消（[#733](https://github.com/DemianLi/nexus-agent/issues/733)）：狀態規則在 `lib/upload-state.ts`，
 * 上傳本身在 `lib/attachment-send.ts`。這顆 hook 把兩邊接起來：每一句開一個 `AbortController`、把進度回呼接到 reducer。
 *
 * 跟草稿附件一樣掛在 App（見 `lib/use-draft-attachments.ts`）。**一次只有一句在上傳**：App 在上傳期間不收第二次送出。
 */

import { useCallback, useEffect, useReducer, useRef } from 'react';

import type { UploadHooks } from '@/lib/attachment-send';
import { NO_UPLOADS, reduceUploads } from '@/lib/upload-state';
import type { UploadStates } from '@/lib/upload-state';

export interface Uploads {
  readonly states: UploadStates;
  /** 開始上傳這一句：回給 `prepareAttachments` 的觀察點與取消。 */
  readonly begin: () => UploadHooks;
  /** 這一句沒送成：還在上傳或已上傳的卡回到未上傳；沒給原因是上傳都成功、伺服器沒收下，卡片照常畫。 */
  readonly settle: (reason?: 'cancelled' | 'failed') => void;
  /** 這些卡離開草稿了（送出成功）。 */
  readonly forget: (ids: readonly string[]) => void;
  /** 取消這一句還在跑的全部上傳（沒有在上傳就什麼都不做）。 */
  readonly cancel: () => void;
}

export function useUploads(): Uploads {
  const [states, dispatch] = useReducer(reduceUploads, NO_UPLOADS);
  const controller = useRef<AbortController | undefined>(undefined);

  const begin = useCallback((): UploadHooks => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    return {
      signal: current.signal,
      onStart: (id) => dispatch({ type: 'start', ids: [id] }),
      onProgress: (id, progress) =>
        dispatch({ type: 'progress', id, loaded: progress.loaded, total: progress.total }),
      onDone: (id) => dispatch({ type: 'done', id }),
    };
  }, []);

  const settle = useCallback((reason?: 'cancelled' | 'failed') => {
    controller.current = undefined;
    dispatch({ type: 'reset', reason });
  }, []);

  const forget = useCallback((ids: readonly string[]) => {
    controller.current = undefined;
    dispatch({ type: 'forget', ids });
  }, []);

  const cancel = useCallback(() => controller.current?.abort(), []);

  useEffect(() => () => controller.current?.abort(), []);

  return { states, begin, settle, forget, cancel };
}
