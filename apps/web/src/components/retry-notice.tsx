import type { WireLlmRetry } from '@nexus/wire';
import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { retryNoticeText, retryRemainingMs } from '@/lib/retry-view';

/**
 * 輪尾的「N 秒後重試」一行（#520，算法與措辭在 `lib/retry-view.ts`）。一次嘗試（`retryId`＋`retry`）換一次起算時刻；
 * 一秒更新一次，只在字真的變了才重畫。倒數的數字不唸給螢幕閱讀器（每秒唸一次是噪音），只唸一次「原因、正在重試、第幾次」。
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
      className="bg-chip text-muted-foreground flex min-h-9 min-w-0 items-center gap-2 rounded-xl px-3 text-tip"
    >
      <RotateCw aria-hidden className="size-4 shrink-0" />
      <span className="sr-only">{retryNoticeText(retry, 0)}</span>
      <span aria-hidden className="min-w-0 flex-1 truncate">
        {retryNoticeText(retry, remaining)}
      </span>
    </p>
  );
}
