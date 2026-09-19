/**
 * 一輪尾端的交付卡片（[#441](https://github.com/DemianLi/nexus-agent/issues/441) 第二刀）：這一輪 `present` 成功
 * 宣告交付的檔案。
 *
 * 資料只來自 harness 在成功時才送的交付事件，不從工具卡推（#441 決議 2）。面向參考 dsh `Deliverables`／
 * `PresentedFileCard`（`packages/client/ui-deliverables/src/client/`，`ddefc45`）：檔案圖示、檔名、說明（沒給就退回
 * 副檔名）、一顆動作；超過 {@link COLLAPSED_COUNT} 個先收起。
 *
 * **動作只有「複製路徑」**（#441 決議 3）：dsh 的「在 Host 上開啟」不做——部署在多人共用的遠端主機、經 SSH 轉 port
 * 連進來，在 Host 上開啟使用者看不到，而且等於讓瀏覽器驅動伺服器開程式。預覽與下載另見 #452。
 */

import { Check, ChevronDown, ChevronUp, Copy, FileText } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { basename } from '@/lib/present-view';
import type { PresentedFile } from '@/lib/present-view';

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

export function DeliverablesCard({ files }: { files: readonly PresentedFile[] }) {
  const [expanded, setExpanded] = useState(false);
  if (files.length === 0) return null;
  const collapsible = files.length > COLLAPSED_COUNT;
  const shown = collapsible && !expanded ? files.slice(0, COLLAPSED_COUNT) : files;

  return (
    <section
      aria-label={`這一輪交付的檔案，共 ${files.length} 個`}
      className="flex flex-col gap-2"
      data-testid="deliverables"
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {shown.map((file, index) => (
          <li
            // 同一輪可能宣告兩次同一個路徑，所以帶上位置。
            key={`${index}:${file.path}`}
            className="bg-stage shadow-stage flex min-w-0 items-start gap-3 rounded-xl p-3"
            data-testid="deliverable"
          >
            <FileText className="text-muted-foreground mt-0.5 size-5 shrink-0" aria-hidden />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate font-medium">{basename(file.path)}</span>
              <span className="text-muted-foreground text-xs">
                {file.description ?? fallbackDescription(file.path)}
              </span>
              <span className="text-muted-foreground truncate font-mono text-xs" title={file.path}>
                {file.path}
              </span>
            </div>
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
