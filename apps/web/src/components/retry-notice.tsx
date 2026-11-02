import type { WireLlmRetry } from '@nexus/wire';
import { useEffect, useRef, useState } from 'react';

import { DotLoader } from '@/components/ui/dot-loader';
import { retryNoticeText, retryRemainingMs } from '@/lib/retry-view';

/**
 * 輪尾的「N 秒後重試」一行（#520，算法與措辭在 `lib/retry-view.ts`）。一次嘗試（`retryId`＋`retry`）換一次起算時刻；
 * 一秒更新一次，只在字真的變了才重畫。倒數的數字不唸給螢幕閱讀器（每秒唸一次是噪音），只唸一次「原因、正在重試、第幾次」。
 * 外觀是沒有底色的一行、前面 SG 的 `DotLoader`（#1695 X3-B）：跟壓縮標記的底色條分得開，也不像一則獨立的訊息。
 */
export function RetryNotice({ retry }: { readonly retry: WireLlmRetry }) {
  const key = `${retry.retryId}:${retry.retry}`;
  const receivedAt = useRef({ key, at: Date.now() });
  if (receivedAt.current.key !== key) receivedAt.current = { key, at: Date.now() };
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [key]);

  const remaining = retryRemainingMs(retry, receivedAt.current.at, now);
  return (
    <p
      data-testid="llm-retry"
      data-retry={retry.retry}
      className="text-muted-foreground flex min-h-7 min-w-0 items-center gap-2 text-tip"
    >
      <DotLoader className="shrink-0" />
      <span className="sr-only">{retryNoticeText(retry, 0)}</span>
      <span aria-hidden className="min-w-0 flex-1 truncate">
        {retryNoticeText(retry, remaining)}
      </span>
    </p>
  );
}
