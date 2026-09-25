/**
 * 一輪尾端的改動卡（[#443](https://github.com/DemianLi/nexus-agent/issues/443) web 第一刀）：這一輪改了哪些檔、各幾行。
 *
 * 面向參考 dsh `ChangedFiles`（`packages/client/ui-deliverables/src/client/ChangedFiles.tsx`，`ddefc45`）：標頭講總檔數
 * 與總行數，一檔一列，二進位與過大的檔不給行數；超過 {@link COLLAPSED_ROWS} 列先收起。**摘要拿到了、而且有檔才畫**：
 * 還在讀、404（serve 重開後重播的那一格）、讀壞了都不畫，同 dsh。
 *
 * 點標頭從第一個檔打開這一輪的審查頁，點一列就打開那一列的檔（同 dsh；審查頁見 `changes-review.tsx`）。
 * 審查頁住在右側欄，一輪一個分頁（#640）；**沒有右側欄時標頭與列都不能點**，不給一顆按了沒反應的鈕。
 * 不做 `changes.open`（在 Host 上開檔，#443 決議 1）。
 */

import { ChevronDown, ChevronUp, FileDiff } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import { Counts, FileCounts } from '@/components/change-counts';
import { useRightSidebar } from '@/components/right-sidebar';
import { Button } from '@/components/ui/button';
import type { ChangesStores } from '@/lib/changes-diff';

/** 收起時先列幾個（dsh `COLLAPSED_ROWS`）。 */
export const COLLAPSED_ROWS = 3;

/** 可以點的標頭與列：跟工具卡的標頭同一套 chip 階梯。 */
const PRESSABLE =
  'hover:bg-chip-hover active:bg-chip-pressed focus-visible:ring-ring/50 rounded-lg text-left outline-none transition-colors duration-(--duration-quick) focus-visible:ring-[3px]';

export function ChangesCard({ seq, changes }: { seq: number; changes: ChangesStores }) {
  const { summary: store } = changes;
  const state = useSyncExternalStore(store.subscribe, () => store.read(seq));
  useEffect(() => store.load(seq), [store, seq]);
  const [expanded, setExpanded] = useState(false);
  const sidebar = useRightSidebar();

  if (typeof state !== 'object' || state.files.length === 0) return null;
  const { files, total, added, deleted } = state;
  const foldable = files.length > COLLAPSED_ROWS;
  const listed = files.map((file, index) => ({ file, index }));
  const rows = foldable && !expanded ? listed.slice(0, COLLAPSED_ROWS) : listed;
  const unlisted = total - files.length;
  const openAt =
    sidebar === undefined ? undefined : (index: number) => sidebar.openChanges(seq, index);

  return (
    <section
      aria-label={`這一輪改動的檔案，共 ${total} 個`}
      className="bg-stage shadow-stage flex flex-col rounded-xl p-1"
      data-testid="changes"
    >
      <Pressable
        onPress={openAt === undefined ? undefined : () => openAt(0)}
        className="flex items-center gap-3 px-3 pt-2 pb-2"
      >
        <FileDiff className="text-muted-foreground size-5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 font-medium">{`${total} 個檔案有改動`}</span>
        <Counts added={added} deleted={deleted} />
      </Pressable>
      <ul className="flex flex-col px-1 pb-1">
        {rows.map(({ file, index }) => (
          <li key={file.display} data-testid="changed-file">
            <Pressable
              onPress={openAt === undefined ? undefined : () => openAt(index)}
              className="flex w-full items-baseline gap-3 px-2 py-1.5"
            >
              <span className="min-w-0 flex-1 font-mono text-xs break-all">{file.display}</span>
              <FileCounts file={file} />
            </Pressable>
          </li>
        ))}
      </ul>
      {(foldable || unlisted > 0) && (
        <div className="flex items-center gap-3 px-1 pb-1">
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

/** 有右側欄就是一顆鈕，沒有就只是一格排版。 */
function Pressable({
  onPress,
  className,
  children,
}: {
  onPress: (() => void) | undefined;
  className: string;
  children: ReactNode;
}) {
  if (onPress === undefined) return <div className={className}>{children}</div>;
  return (
    <button type="button" className={`${PRESSABLE} ${className}`} onClick={onPress}>
      {children}
    </button>
  );
}
