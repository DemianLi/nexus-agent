/**
 * 一個改動過的檔的行數（[#443](https://github.com/DemianLi/nexus-agent/issues/443)）：改動卡與審查頁共用。
 * 行數畫成 SG 的 `DiffStats`（nexus 層 `components/ui/diff-view.tsx`，#1685 PR A：報讀器唸「新增 12 行，刪除 3 行」，不唸符號）。
 * 二進位與過大的檔不給行數、寫字說明（同 dsh `ChangedFiles.tsx` 的做法），SG 沒有這兩種，留在這一層。
 * 說明字跟著改動卡 `Pressable` 的 `group/pressable`（`changes/card.tsx`）在 hover 時換成 foreground；審查頁沒有這個祖先，不換。
 */

import type { WorkspaceChangedFile } from '@nexus/wire';

import { DiffStats } from '@/components/ui/diff-view';

export function FileCounts({ file }: { file: WorkspaceChangedFile }) {
  if (file.binary === true)
    return (
      <span className="text-muted-foreground group-hover/pressable:text-foreground text-tip">
        二進位檔
      </span>
    );
  if (file.oversized === true)
    return (
      <span className="text-muted-foreground group-hover/pressable:text-foreground text-tip">
        檔案過大
      </span>
    );
  return <DiffStats added={file.added} removed={file.deleted} />;
}
