/**
 * 改動的行數（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）：改動卡與審查頁共用。`+12` 綠、`−3` 紅；
 * 報讀器唸「新增 12 行，刪除 3 行」，不唸符號。二進位與過大的檔不給行數（同 dsh `Counts`）。
 */

import type { WorkspaceChangedFile } from '@nexus/wire';

const GROUPED = new Intl.NumberFormat('en-US');

export function Counts({ added, deleted }: { added: number; deleted: number }) {
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

export function FileCounts({ file }: { file: WorkspaceChangedFile }) {
  if (file.binary === true) return <span className="text-muted-foreground text-xs">二進位檔</span>;
  if (file.oversized === true)
    return <span className="text-muted-foreground text-xs">檔案過大</span>;
  return <Counts added={file.added} deleted={file.deleted} />;
}
