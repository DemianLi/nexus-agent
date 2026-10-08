/**
 * 輸入框底下那一排草稿附件（#733）：圖畫縮圖、其他檔案畫檔案卡（圖示、檔名、`副檔名 · 大小`），每個都有移除鈕。
 *
 * 一排**在列內橫向捲動**：附件再多也不撐開頁面（375 寬量過），所以外層一定要 `min-w-0`。移除鈕滑鼠移上去、鍵盤聚焦才出現；
 * 沒有滑鼠的裝置（`hover: none`）一直看得到，不然手機上移不掉。點圖的縮圖開原圖（dialog），焦點會還給縮圖。
 *
 * 外觀是 shadcn `attachment`；這裡只決定放什麼、怎麼互動。
 */

import { FileText, X } from 'lucide-react';
import { useState } from 'react';

import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { attachmentDetail, formatBytes } from '@/lib/attachments';
import type { DraftAttachment } from '@/lib/attachments';
import { uploadView } from '@/lib/upload-state';
import type { UploadStates, UploadView } from '@/lib/upload-state';

/**
 * 上傳中的進度條（#733）。`percent` 沒有（瀏覽器不知道總量）就畫不確定長度：整條淡淡地閃，不猜百分比；
 * 減少動態效果的人那條不動（`motion-safe`）。
 */
function UploadBar({ view, name }: { readonly view: UploadView; readonly name: string }) {
  const indeterminate = view.percent === undefined;
  return (
    <div
      role="progressbar"
      aria-label={`上傳 ${name}`}
      aria-valuemin={0}
      aria-valuemax={100}
      {...(indeterminate ? {} : { 'aria-valuenow': view.percent })}
      aria-valuetext={view.text}
      data-testid="upload-progress"
      className="bg-muted mt-1 h-1 w-full overflow-hidden rounded-full"
    >
      <div
        className={`bg-primary h-full rounded-full ${indeterminate ? 'w-full motion-safe:animate-pulse' : 'transition-[width] duration-(--duration-quick)'}`}
        style={indeterminate ? undefined : { width: `${view.percent}%` }}
      />
    </div>
  );
}

export function AttachmentRail({
  items,
  onRemove,
  uploads,
  onCancelUpload,
}: {
  readonly items: readonly DraftAttachment[];
  readonly onRemove: (id: string) => void;
  /** 每張卡的上傳狀態（#733）；沒有紀錄的卡照常畫。 */
  readonly uploads?: UploadStates | undefined;
  readonly onCancelUpload?: (() => void) | undefined;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  const preview = items.find((item) => item.id === opened);
  if (items.length === 0) return null;
  return (
    <>
      <AttachmentGroup className="w-full" aria-label="附件" data-testid="attachment-rail">
        {items.map((item) => {
          const phase = uploads?.get(item.id);
          const view = uploadView(phase, formatBytes);
          const busy = phase?.kind === 'uploading' || phase?.kind === 'done';
          return (
            <Attachment
              key={item.id}
              size="sm"
              className="max-w-56"
              data-testid="draft-attachment"
              data-kind={item.kind}
              {...(phase === undefined || phase.kind === 'done'
                ? {}
                : {
                    state:
                      phase.kind === 'uploading'
                        ? 'uploading'
                        : phase.reason === 'failed'
                          ? 'error'
                          : 'idle',
                  })}
              data-upload={phase?.kind ?? 'none'}
            >
              <AttachmentMedia variant={item.kind === 'image' ? 'image' : 'icon'}>
                {item.kind === 'image' && item.previewUrl !== undefined ? (
                  <button
                    type="button"
                    aria-label={`看原圖：${item.file.name}`}
                    className="size-full cursor-zoom-in outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    onClick={() => setOpened(item.id)}
                  >
                    <img src={item.previewUrl} alt="" className="size-full object-cover" />
                  </button>
                ) : (
                  <FileText aria-hidden />
                )}
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle title={item.file.name}>{item.file.name}</AttachmentTitle>
                <AttachmentDescription>
                  {view?.text ?? attachmentDetail(item.file)}
                </AttachmentDescription>
                {view?.phase === 'uploading' && <UploadBar view={view} name={item.file.name} />}
              </AttachmentContent>
              <AttachmentActions>
                {phase?.kind === 'uploading' ? (
                  // 上傳中不能移除（這一句正在帶著它）；能做的是取消。取消是整句取消，見 `lib/upload-state.ts`。
                  <AttachmentAction
                    type="button"
                    aria-label={`取消上傳 ${item.file.name}`}
                    data-testid="upload-cancel"
                    onClick={() => onCancelUpload?.()}
                  >
                    <X />
                  </AttachmentAction>
                ) : (
                  !busy && (
                    <AttachmentAction
                      type="button"
                      aria-label={`移除 ${item.file.name}`}
                      className="opacity-0 group-hover/attachment:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                      onClick={() => onRemove(item.id)}
                    >
                      <X />
                    </AttachmentAction>
                  )
                )}
              </AttachmentActions>
            </Attachment>
          );
        })}
      </AttachmentGroup>
      <Dialog open={preview !== undefined} onOpenChange={(open) => !open && setOpened(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogTitle className="truncate">{preview?.file.name}</DialogTitle>
          <DialogDescription className="sr-only">原圖預覽</DialogDescription>
          {preview?.previewUrl !== undefined && (
            <img
              src={preview.previewUrl}
              alt={preview.file.name}
              className="max-h-[70dvh] w-full object-contain"
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
