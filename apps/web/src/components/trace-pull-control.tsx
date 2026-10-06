/** 觀測分頁「載入這一輪的細節」的鈕與它的各種狀態文字（按需拉，#1083）。 */

import { Button } from '@/components/ui/button';
import type { PullStatus } from '@/lib/trajectory-pull';

/** 按需拉那一輪的細節（#1083）。 */
export const TRACE_PULL_LABEL = '載入這一輪的細節';
export const TRACE_PULL_RETRY_LABEL = '重試';
export const TRACE_PULL_LOADING_TEXT = '正在載入這一輪的細節…';
export const TRACE_PULL_SUMMARY_ONLY_TEXT = '只有摘要，細節沒有載入';
/** 載入失敗：後面接伺服器（或連線）給的原因，原樣不加前綴。 */
export const TRACE_PULL_FAILED_TEXT = '無法載入這一輪的細節：';

/** 一列摘要、或只有摘要的組：載入那一輪的細節（進行中講進度，失敗講原因並給重試）。 */
export function PullControl({ status, onPull }: { status: PullStatus; onPull: () => void }) {
  return (
    <div className="px-2 pt-1 pb-1" data-testid="trace-pull" data-status={status.kind}>
      {status.kind === 'failed' && (
        <p className="text-destructive pb-1 text-xs" data-testid="trace-pull-failed">
          {TRACE_PULL_FAILED_TEXT}
          {status.message}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-11 text-xs lg:min-h-8"
        disabled={status.kind === 'loading'}
        onClick={onPull}
      >
        {status.kind === 'loading'
          ? TRACE_PULL_LOADING_TEXT
          : status.kind === 'failed'
            ? TRACE_PULL_RETRY_LABEL
            : TRACE_PULL_LABEL}
      </Button>
    </div>
  );
}
