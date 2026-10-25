/** 觀測分頁「載入這一輪的細節」的鈕與它的各種狀態文字（按需拉，#1083）。 */

import { Download, RotateCw } from 'lucide-react';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { DotLoader } from '@/components/ui/dot-loader';
import type { PullStatus } from '@/lib/trajectory-pull';

/** 按需拉那一輪的細節（#1083）。 */
export const TRACE_PULL_LABEL = '載入這一輪的細節';
export const TRACE_PULL_RETRY_LABEL = '重試';
export const TRACE_PULL_LOADING_TEXT = '正在載入這一輪的細節…';
export const TRACE_PULL_SUMMARY_ONLY_TEXT = '只有摘要，細節沒有載入';
/** 載入失敗：後面接伺服器（或連線）給的原因，原樣不加前綴。 */
export const TRACE_PULL_FAILED_TEXT = '無法載入這一輪的細節：';

/**
 * 一列摘要、或只有摘要的組：載入那一輪的細節（#1690 T6）。進行中沒有鈕，是 SG `DotLoader` 加一行灰字；
 * 待命與失敗是 outline 鈕帶圖示，失敗的原因接在鈕後面、掛在鈕的 `aria-describedby`。按下去是唯讀拉取，「重試」是重新載入，
 * 都不重跑模型，也不自動重試。
 */
export function PullControl({ status, onPull }: { status: PullStatus; onPull: () => void }) {
  const failureId = useId();
  if (status.kind === 'loading') {
    return (
      <div className="px-2 pt-1 pb-1" data-testid="trace-pull" data-status={status.kind}>
        <p className="text-muted-foreground flex min-h-11 items-center gap-2 px-2 text-ui lg:min-h-8">
          <DotLoader className="shrink-0" />
          {TRACE_PULL_LOADING_TEXT}
        </p>
      </div>
    );
  }
  const failed = status.kind === 'failed';
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-1 pb-1"
      data-testid="trace-pull"
      data-status={status.kind}
    >
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="min-h-11 text-ui lg:min-h-8"
        aria-describedby={failed ? failureId : undefined}
        onClick={onPull}
      >
        {failed ? <RotateCw aria-hidden /> : <Download aria-hidden />}
        {failed ? TRACE_PULL_RETRY_LABEL : TRACE_PULL_LABEL}
      </Button>
      {status.kind === 'failed' && (
        <p
          id={failureId}
          className="text-destructive min-w-0 text-tip"
          data-testid="trace-pull-failed"
        >
          {TRACE_PULL_FAILED_TEXT}
          {status.message}
        </p>
      )}
    </div>
  );
}
