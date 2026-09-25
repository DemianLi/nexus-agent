/**
 * 一輪尾端的交付卡片（[#441](https://github.com/DemianLi/nexus-agent/issues/441) 第二刀）：這一輪 `present` 成功
 * 宣告交付的檔案。
 *
 * 資料只來自 harness 在成功時才送的交付事件，不從工具卡推（#441 決議 2）。面向參考 dsh `Deliverables`／
 * `PresentedFileCard`（`packages/client/ui-deliverables/src/client/`，`ddefc45`）：檔案圖示、檔名、說明（沒給就退回
 * 副檔名）、一顆動作；超過 {@link COLLAPSED_COUNT} 個先收起。
 *
 * **不做「在 Host 上開啟」**（#441 決議 3）：dsh 有那顆，我們沒有——部署在多人共用的遠端主機、經 SSH 轉 port
 * 連進來，在 Host 上開啟使用者看不到，而且等於讓瀏覽器驅動伺服器開程式。
 *
 * **每個檔案帶著讀檔路由的座標**（{@link LocatedFile}，[#452](https://github.com/DemianLi/nexus-agent/issues/452)）：
 * 第一刀接線，第二刀拿那組 `(seq, index)` 開預覽（`deliverable-preview.tsx`；#640 起在右側欄開成一個分頁），
 * 第三刀是下載（{@link DownloadIconButton}）。三顆動作鈕**各自獨立可選**：沒有右側欄（或它沒有讀檔的 store）
 * 就不畫預覽鈕，`download` 沒給就不畫下載鈕，複製路徑一直都在——它不需要讀檔。
 */

import { Check, ChevronDown, ChevronUp, Copy, Eye, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { DownloadIconButton } from '@/components/deliverable-download-button';
import { useRightSidebar } from '@/components/right-sidebar';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import type { DeliverableDownloader } from '@/lib/deliverable-download';
import type { LocatedFile } from '@/lib/deliverables-view';
import { basename } from '@/lib/present-view';

/** 收起時先列幾個（dsh `COLLAPSED_PRESENTED_COUNT`）。 */
export const COLLAPSED_COUNT = 4;

/** 複製成功的勾勾留多久。 */
const COPIED_MS = 1500;

/** 沒給說明時的那一行：副檔名大寫，沒有副檔名就寫「檔案」。 */
export function fallbackDescription(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? `${name.slice(dot + 1).toUpperCase()} 檔` : '檔案';
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    if (await copyText(path)) {
      clearTimeout(timer.current);
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), COPIED_MS);
      toast('已複製路徑', { description: path });
    } else {
      toast.error('沒辦法複製路徑', {
        description: '瀏覽器不讓這個頁面寫剪貼簿，請手動選取路徑。',
      });
    }
  };

  const label = `複製路徑：${path}`;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      title={label}
      aria-label={label}
      onClick={() => void copy()}
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

export function DeliverablesCard({
  files,
  download,
}: {
  files: readonly LocatedFile[];
  /** 沒給就不畫下載鈕。 */
  download?: DeliverableDownloader | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = useRightSidebar()?.openDeliverable;
  if (files.length === 0) return null;
  const collapsible = files.length > COLLAPSED_COUNT;
  const shown = collapsible && !expanded ? files.slice(0, COLLAPSED_COUNT) : files;

  return (
    <section
      aria-label={`這一輪交付的檔案，共 ${files.length} 個`}
      className="@container flex flex-col gap-2"
      data-testid="deliverables"
    >
      {/* 兩欄看的是會話區多寬，不是視窗多寬：右側欄打開時寬視窗裡的會話區可能只剩 480（#640）。 */}
      <ul className="grid gap-2 @xl:grid-cols-2">
        {shown.map((file) => (
          <li
            // **用座標當 key，不用列表位置**：同一輪可能宣告兩次同一個路徑，而 `(seq, index)` 本來就唯一
            // ——`seq` 是日誌位置，一顆事件一個（#452）。列表位置在合併之後不再對應宣告當下的位置。
            key={`${file.seq}:${file.index}`}
            className="bg-stage shadow-stage flex min-w-0 items-start gap-3 rounded-xl p-3"
            data-testid="deliverable"
          >
            <FileText className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium">{basename(file.path)}</span>
              <span className="text-muted-foreground text-xs">
                {file.description ?? fallbackDescription(file.path)}
              </span>
              <span className="text-muted-foreground font-mono text-xs break-all">{file.path}</span>
            </div>
            {preview !== undefined && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0"
                title={`預覽：${file.path}`}
                aria-label={`預覽：${file.path}`}
                onClick={() => preview(file)}
              >
                <Eye />
              </Button>
            )}
            {download !== undefined && <DownloadIconButton file={file} downloader={download} />}
            <CopyPathButton path={file.path} />
          </li>
        ))}
      </ul>
      {collapsible && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : `顯示全部 ${files.length} 個`}
          {expanded ? <ChevronUp /> : <ChevronDown />}
        </Button>
      )}
    </section>
  );
}
