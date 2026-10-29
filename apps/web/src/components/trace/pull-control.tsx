/** 觀測分頁「載入這一輪的細節」的鈕與它的各種狀態文字（按需拉，#1083）。 */

import { Download, RotateCw } from 'lucide-react';
import { useId } from 'react';

import { Button } from '@/components/ui/button';
import { DotLoader } from '@/components/ui/dot-loader';
import { useSettledLabel } from '@/hooks/use-focus-handoff';
import { cn } from '@/lib/utils';
import type { PullStatus } from '@/lib/trajectory-pull';

/** 按需拉那一輪的細節（#1083）。 */
export const TRACE_PULL_LABEL = '載入這一輪的細節';
export const TRACE_PULL_RETRY_LABEL = '重試';
export const TRACE_PULL_LOADING_TEXT = '正在載入這一輪的細節…';
export const TRACE_PULL_SUMMARY_ONLY_TEXT = '只有摘要，細節沒有載入';
/** 載入失敗：後面接伺服器（或連線）給的原因，原樣不加前綴。 */
export const TRACE_PULL_FAILED_TEXT = '無法載入這一輪的細節：';

/** 讀取中的鈕畫得跟 #1690 T6 的「DotLoader 加一行灰字」一樣：沒有框、沒有底，滑過去沒有反應。 */
const LOADING_CLASS =
  'text-muted-foreground h-auto gap-2 px-2 font-normal whitespace-normal data-[disabled]:pointer-events-none';

/**
 * 一列摘要、或只有摘要的組：載入那一輪的細節（#1690 T6）。待命與失敗是 outline 鈕帶圖示，失敗的原因接在鈕後面、掛在鈕的
 * `aria-describedby`；進行中同一顆鈕換成 SG `DotLoader` 加一行灰字。按下去是唯讀拉取，「重試」是重新載入，都不重跑模型，也不自動重試。
 *
 * 讀取中鈕不卸載（#2009）：`disabled`＋`focusableWhenDisabled`（`aria-disabled`），焦點留在鈕上、再按不會再拉一次，名稱維持
 * 按下去之前那一句（`useSettledLabel`）。`onPull` 收到這顆鈕，給呼叫端記下「是按鈕帶動的」（`hooks/use-focus-handoff.ts`）。
 */
export function PullControl({
  status,
  onPull,
}: {
  status: PullStatus;
  onPull: (button: HTMLElement) => void;
}) {
  const failureId = useId();
  const loading = status.kind === 'loading';
  const failed = status.kind === 'failed';
  const label = failed ? TRACE_PULL_RETRY_LABEL : TRACE_PULL_LABEL;
  const name = useSettledLabel(label, loading);
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 pt-1 pb-1"
      data-testid="trace-pull"
      data-status={status.kind}
    >
      <Button
        type="button"
        variant={loading ? 'ghost' : 'outline'}
        size="sm"
        className={cn('min-h-11 text-ui lg:min-h-8', loading && LOADING_CLASS)}
        disabled={loading}
        focusableWhenDisabled
        aria-label={loading ? name : undefined}
        aria-describedby={failed ? failureId : undefined}
        onClick={(event) => onPull(event.currentTarget)}
      >
        {loading ? (
          <>
            <DotLoader className="shrink-0" />
            {TRACE_PULL_LOADING_TEXT}
          </>
        ) : (
          <>
            {failed ? <RotateCw aria-hidden /> : <Download aria-hidden />}
            {label}
          </>
        )}
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
