import { Paperclip } from 'lucide-react';

import { Surface } from '@/components/surface';

/**
 * 檔案拖進視窗時蓋滿整頁的提示（#733）。**不收指標事件**（`pointer-events-none`）：放開檔案的是 `window` 上的 `drop`，
 * 提示層自己不能攔。只在 `useFileDrop` 回報正在拖檔案時畫。
 */
export function DropOverlay() {
  return (
    <div
      data-testid="drop-overlay"
      role="presentation"
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <Surface tone="raised" className="flex items-center gap-3 px-6 py-5 text-body">
        <Paperclip aria-hidden className="size-5 text-muted-foreground" />
        <span>放開以加入附件</span>
      </Surface>
    </div>
  );
}
