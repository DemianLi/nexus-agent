/**
 * 一輪尾端的改動卡（[#443](https://github.com/DemianLi/nexus-agent/issues/443) web 第一刀）：這一輪改了哪些檔、各幾行。
 *
 * 面向參考 dsh `ChangedFiles`（`packages/client/ui-deliverables/src/client/ChangedFiles.tsx`，`ddefc45`）：標頭講總檔數
 * 與總行數，一檔一列，二進位與過大的檔不給行數；超過 {@link COLLAPSED_ROWS} 列先收起。**摘要拿到了、而且有檔才畫**：
 * 還在讀、404（serve 重開後重播的那一格）、讀壞了都不畫，同 dsh。
 *
 * 點列看 diff 是第二刀（shadcn `Sheet`，#443 決議 3）；這一刀的列不能點。不做 `changes.open`（在 Host 上開檔，
 * #443 決議 1）。
 */

import { ChevronDown, ChevronUp, FileDiff } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';

import type { WorkspaceChangedFile } from '@nexus/wire';

import { Button } from '@/components/ui/button';
import type { ChangesSummaryStore } from '@/lib/changes-summary';

/** 收起時先列幾個（dsh `COLLAPSED_ROWS`）。 */
export const COLLAPSED_ROWS = 3;

const GROUPED = new Intl.NumberFormat('en-US');

/** 行數：`+12` 綠、`−3` 紅。報讀器唸「新增 12 行，刪除 3 行」，不唸符號。 */
function Counts({ added, deleted }: { added: number; deleted: number }) {
  return (
    <span className="flex shrink-0 gap-2 font-mono text-xs tabular-nums">
      <span className="text-success">
        <span aria-hidden>{`+${GROUPED.format(added)}`}</span>
        <span className="sr-only">{`新增 ${added} 行，`}</span>
      </span>
      <span className="text-destructive">
        <span aria-hidden>{`−${GROUPED.format(deleted)}`}</span>
        <span className="sr-only">{`刪除 ${deleted} 行`}</span>
      </span>
    </span>
  );
}

function FileCounts({ file }: { file: WorkspaceChangedFile }) {
  if (file.binary === true) return <span className="text-muted-foreground text-xs">二進位檔</span>;
  if (file.oversized === true)
    return <span className="text-muted-foreground text-xs">檔案過大</span>;
  return <Counts added={file.added} deleted={file.deleted} />;
}

export function ChangesCard({ seq, store }: { seq: number; store: ChangesSummaryStore }) {
  const state = useSyncExternalStore(store.subscribe, () => store.read(seq));
  useEffect(() => store.load(seq), [store, seq]);
  const [expanded, setExpanded] = useState(false);

  if (typeof state !== 'object' || state.files.length === 0) return null;
  const { files, total, added, deleted } = state;
  const foldable = files.length > COLLAPSED_ROWS;
  const rows = foldable && !expanded ? files.slice(0, COLLAPSED_ROWS) : files;
  const unlisted = total - files.length;

  return (
    <section
      aria-label={`這一輪改動的檔案，共 ${total} 個`}
      className="bg-stage shadow-stage flex flex-col rounded-xl"
      data-testid="changes"
    >
      <div className="flex items-center gap-3 px-4 pt-3 pb-2">
        <FileDiff className="text-muted-foreground size-5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 font-medium">{`${total} 個檔案有改動`}</span>
        <Counts added={added} deleted={deleted} />
      </div>
      <ul className="flex flex-col px-2 pb-2">
        {rows.map((file) => (
          <li
            key={file.display}
            className="flex items-baseline gap-3 rounded-md px-2 py-1.5"
            data-testid="changed-file"
          >
            <span className="min-w-0 flex-1 font-mono text-xs break-all">{file.display}</span>
            <FileCounts file={file} />
          </li>
        ))}
      </ul>
      {(foldable || unlisted > 0) && (
        <div className="flex items-center gap-3 px-2 pb-2">
          {foldable && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? '收起' : `顯示全部 ${files.length} 個`}
              {expanded ? <ChevronUp /> : <ChevronDown />}
            </Button>
          )}
          {unlisted > 0 && (
            // 摘要有上限；總數與總行數含沒列出來的那些。
            <span className="text-muted-foreground px-2 text-xs">{`另有 ${unlisted} 個檔沒有列出`}</span>
          )}
        </div>
      )}
    </section>
  );
}
