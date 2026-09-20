/**
 * 一輪改動的審查頁（[#443](https://github.com/DemianLi/nexus-agent/issues/443) web 第二刀）：選一個改動的檔，看它在這一輪
 * 開始與結束時的比較。
 *
 * 面向照 dsh `ReviewTab`（`packages/client/ui-deliverables/src/client/ReviewTab.tsx`，`ddefc45`）：選檔器、單欄或左右對照、
 * 自動換行或橫向捲動，最多畫 {@link MAX_RENDERED_LINES} 行；新建、刪掉、兩側相同、逐行比較逾時、被截斷都講一聲。
 * dsh 放在右側欄，我們沒有右側欄，所以放在 shadcn `Sheet`：桌面從右側滑出，手機全螢幕（#443 決議 3）。
 *
 * **dsh 有、這裡沒有的兩顆鈕**：
 * - 用 Host 的預設程式開檔（`changes.open`）：#443 決議 1 不做，Host 是多人共用的遠端主機。
 * - 在側欄打開整個檔（`review.openFile`）：我們沒有看檔的面（預覽在 #452，還在 triage）。
 */

import { Check, ChevronsUpDown, Columns2, WrapText } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode, UIEvent } from 'react';

import type { WorkspaceChangesSummary, WorkspaceDiffHunk, WorkspaceFileDiff } from '@nexus/wire';

import { Counts, FileCounts } from '@/components/change-counts';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ChangesDiffState, ChangesDiffStore } from '@/lib/changes-diff';
import {
  MAX_RENDERED_LINES,
  hunkHeader,
  hunkRows,
  renderedHunks,
  splitRowKind,
  splitRows,
} from '@/lib/diff-rows';
import { cn } from '@/lib/utils';

type TextDiff = Extract<WorkspaceFileDiff, { kind: 'text' }>;

/**
 * 一列 diff 的底色。正文維持前景色，只有 `+`／`-` 上色（{@link SIGN}）：底色 8% 時符號在亮暗兩邊都還有 4.5:1
 * （colorjs.io 對 `tokens.generated.css` 重算，亮 4.60／暗 4.82 起跳）；12% 的綠字、紅字在亮色只剩 4.3–4.4。
 */
const TONE = {
  add: 'bg-success/8',
  del: 'bg-destructive/8',
  context: '',
} as const;

const SIGN = { add: 'text-success', del: 'text-destructive', context: '' } as const;

const NUMBER = 'text-muted-foreground pr-2 text-right select-none';

export function ChangesReview({
  open,
  onOpenChange,
  seq,
  summary,
  index,
  onSelect,
  diff,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly seq: number;
  readonly summary: WorkspaceChangesSummary;
  /** 要看的檔在 `summary.files` 裡的位置。 */
  readonly index: number;
  readonly onSelect: (index: number) => void;
  readonly diff: ChangesDiffStore;
}) {
  // 跟著這一輪的審查走：換檔、關掉再開都留著（dsh 一個分頁一份）。
  const [split, setSplit] = useState(false);
  const [wrap, setWrap] = useState(false);
  const file = summary.files[index] ?? summary.files[0];
  const at = file === summary.files[index] ? index : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full gap-0 sm:w-[min(90vw,60rem)] sm:max-w-none"
        data-testid="changes-review"
      >
        <SheetHeader className="pr-12">
          <SheetTitle>這一輪的改動</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-x-3">
            {`${summary.total} 個檔案有改動`}
            <Counts added={summary.added} deleted={summary.deleted} />
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 pb-3">
          <FilePicker summary={summary} index={at} onSelect={onSelect} />
          {file !== undefined && <FileCounts file={file} />}
          <div className="ml-auto flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={split}
              onClick={() => setSplit((value) => !value)}
            >
              <Columns2 />
              左右對照
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={wrap}
              onClick={() => setWrap((value) => !value)}
            >
              <WrapText />
              自動換行
            </Button>
          </div>
        </div>
        {open && file !== undefined && (
          <FileBody seq={seq} index={at} diff={diff} split={split} wrap={wrap} />
        )}
      </SheetContent>
    </Sheet>
  );
}

/**
 * 一個檔的路徑標籤：**檔名優先**。位置不夠時先吃掉目錄那一截，不是從尾巴切，
 * 免得 `../packages/nexus-wire/src/workspace-cha…` 這種只剩目錄、看不出是哪個檔
 * （git 快照之後 `display` 會出現 `../` 與 `~` 開頭，路徑更長，見 [#470](https://github.com/DemianLi/nexus-agent/issues/470)）。
 */
function PathLabel({ display }: { display: string }) {
  const cut = display.lastIndexOf('/');
  if (cut < 0) return <span className="truncate">{display}</span>;
  return (
    <span className="flex min-w-0 items-baseline">
      <span className="truncate">{display.slice(0, cut + 1)}</span>
      <span className="max-w-full shrink-0 truncate">{display.slice(cut + 1)}</span>
    </span>
  );
}

/** 選檔器：檔多時可以打字找（摘要最多列 500 個）。 */
function FilePicker({
  summary,
  index,
  onSelect,
}: {
  summary: WorkspaceChangesSummary;
  index: number;
  onSelect: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const file = summary.files[index];
  if (file === undefined) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="max-w-full min-w-0 justify-between font-mono text-xs"
          aria-label={`選擇要看的檔案，現在是 ${file.display}`}
          data-testid="review-file"
        >
          <PathLabel display={file.display} />
          <ChevronsUpDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(92vw,32rem)] p-0">
        <Command>
          <CommandInput placeholder="找檔案" />
          <CommandList label="改動的檔案">
            <CommandEmpty>沒有符合的檔案</CommandEmpty>
            {summary.files.map((entry, at) => (
              <CommandItem
                key={entry.display}
                value={String(at)}
                keywords={[entry.display]}
                onSelect={() => {
                  onSelect(at);
                  setOpen(false);
                }}
                className="gap-3"
              >
                <Check className={cn('size-4', at === index ? 'opacity-100' : 'opacity-0')} />
                <span className="min-w-0 flex-1 font-mono text-xs">
                  <PathLabel display={entry.display} />
                </span>
                <FileCounts file={entry} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function Status({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <div
      className="text-muted-foreground flex items-center gap-3 px-4 py-4 text-sm"
      role={busy ? 'status' : undefined}
    >
      {children}
    </div>
  );
}

/** 選中那個檔的比較，或替代它的狀態。 */
function FileBody({
  seq,
  index,
  diff,
  split,
  wrap,
}: {
  seq: number;
  index: number;
  diff: ChangesDiffStore;
  split: boolean;
  wrap: boolean;
}) {
  const state: ChangesDiffState | undefined = useSyncExternalStore(diff.subscribe, () =>
    diff.read(seq, index),
  );
  // 只補還沒讀過的；讀壞的等使用者按重試（同 dsh）。
  useEffect(() => {
    if (diff.read(seq, index) === undefined) diff.load(seq, index);
  }, [diff, seq, index]);

  if (state === undefined || state === 'loading') return <Status busy>正在讀取改動…</Status>;
  if (state === 'missing') return <Status>這一輪的改動已經讀不到了</Status>;
  if (state === 'error')
    return (
      <Status>
        沒辦法讀取改動
        <Button type="button" size="sm" variant="secondary" onClick={() => diff.load(seq, index)}>
          重試
        </Button>
      </Status>
    );
  if (state.kind === 'binary') return <Status>二進位檔，沒辦法顯示改動</Status>;
  if (state.kind === 'oversized') return <Status>檔案過大，沒辦法顯示改動</Status>;
  return <TextDiffBody diff={state} split={split} wrap={wrap} />;
}

/** 值得在 hunks 上面講一聲的事（同 dsh `noteOf`）。 */
function noteOf(diff: TextDiff): string | undefined {
  if (!diff.before) return '這一輪新建的檔案';
  if (!diff.after) return '這一輪刪掉的檔案';
  if (diff.hunks.length === 0) return '兩側內容相同';
  return undefined;
}

function TextDiffBody({ diff, split, wrap }: { diff: TextDiff; split: boolean; wrap: boolean }) {
  const note = noteOf(diff);
  const { hunks, truncated } = useMemo(() => renderedHunks(diff.hunks), [diff.hunks]);
  const notes = [
    note,
    diff.coarse ? '逐行比較逾時，改成整檔替換顯示' : undefined,
    truncated ? `只顯示前 ${MAX_RENDERED_LINES} 行` : undefined,
  ].filter((text) => text !== undefined);
  return (
    <div
      className="min-h-0 flex-1 overflow-auto pt-2 pb-4"
      data-review-view={split ? 'split' : 'unified'}
      data-review-wrap={wrap || undefined}
      data-testid="review-body"
    >
      {notes.map((text) => (
        <p key={text} className="text-muted-foreground px-4 pb-2 text-xs">
          {text}
        </p>
      ))}
      <div className="font-mono text-xs leading-5.5">
        {split && !wrap ? (
          <SplitColumns hunks={hunks} />
        ) : (
          hunks.map((hunk, position) => (
            <section key={position} className={cn('mb-2', !wrap && 'w-max min-w-full')}>
              <HunkHeader hunk={hunk} />
              {split ? <SplitWrapped hunk={hunk} /> : <Unified hunk={hunk} wrap={wrap} />}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function HunkHeader({ hunk }: { hunk: WorkspaceDiffHunk }) {
  return <div className="text-muted-foreground px-4 py-1 whitespace-pre">{hunkHeader(hunk)}</div>;
}

function Unified({ hunk, wrap }: { hunk: WorkspaceDiffHunk; wrap: boolean }) {
  return hunkRows(hunk).map((row, at) => (
    <div
      key={at}
      className={cn(
        'grid min-h-5.5',
        wrap
          ? 'grid-cols-[3.5em_3.5em_1.5em_minmax(0,1fr)] whitespace-pre-wrap'
          : 'grid-cols-[3.5em_3.5em_1.5em_max-content] whitespace-pre',
        TONE[row.kind],
      )}
      data-diff-line={row.kind}
    >
      <span className={NUMBER}>{row.old ?? ''}</span>
      <span className={NUMBER}>{row.new ?? ''}</span>
      <span className={cn('text-center select-none', SIGN[row.kind])}>
        {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
      </span>
      <span className={cn('pr-4', wrap && 'wrap-anywhere')}>{row.text}</span>
    </div>
  ));
}

/** 左右對照而且自動換行：兩側同一列，換行時一起長高，所以對得齊。 */
function SplitWrapped({ hunk }: { hunk: WorkspaceDiffHunk }) {
  return splitRows(hunk).map((row, at) => (
    <div
      key={at}
      className="grid grid-cols-2 whitespace-pre-wrap"
      data-diff-line={splitRowKind(row)}
    >
      {(['left', 'right'] as const).map((side) => {
        const cell = row[side];
        return (
          <span
            key={side}
            className={cn(
              'grid min-w-0 grid-cols-[3.5em_minmax(0,1fr)]',
              side === 'right' && 'border-l',
              cell === undefined ? 'bg-muted' : TONE[cell.kind],
            )}
          >
            <span className={NUMBER}>{cell?.no ?? ''}</span>
            <span className="pr-4 wrap-anywhere">{cell?.text ?? ''}</span>
          </span>
        );
      })}
    </div>
  ));
}

/**
 * 左右對照、不換行（同 dsh `SplitColumns`）：兩欄各自裁掉長行、一起橫向捲動，所以長行不會跑到另一側底下，
 * 兩側也一直看同一段欄位。每一行固定一列高，兩側才對得齊。
 */
function SplitColumns({ hunks }: { hunks: readonly WorkspaceDiffHunk[] }) {
  const paired = useMemo(() => hunks.map((hunk) => ({ hunk, rows: splitRows(hunk) })), [hunks]);
  const columns = useRef<Record<'left' | 'right', HTMLDivElement | null>>({
    left: null,
    right: null,
  });
  // 把一側的橫向位置抄到另一側；被抄的那側自己的 scroll 事件再來時，位置已經一樣，不會來回抄。
  const follow = (side: 'left' | 'right') => (event: UIEvent<HTMLDivElement>) => {
    const other = columns.current[side === 'left' ? 'right' : 'left'];
    if (other !== null && other.scrollLeft !== event.currentTarget.scrollLeft)
      other.scrollLeft = event.currentTarget.scrollLeft;
  };
  return (
    <div className="grid grid-cols-2">
      {(['left', 'right'] as const).map((side) => (
        <div
          key={side}
          ref={(element) => {
            columns.current[side] = element;
          }}
          className={cn('min-w-0 overflow-x-auto', side === 'right' && 'border-l')}
          onScroll={follow(side)}
          data-diff-side={side}
        >
          {paired.map(({ hunk, rows }, position) => (
            <section key={position} className="mb-2 w-max min-w-full">
              <HunkHeader hunk={hunk} />
              {rows.map((row, at) => {
                const cell = row[side];
                return (
                  <div
                    key={at}
                    className={cn(
                      // 空的那一格也要佔一列高，兩欄才對得齊。
                      'grid min-h-5.5 grid-cols-[3.5em_max-content] whitespace-pre',
                      cell === undefined ? 'bg-muted' : TONE[cell.kind],
                    )}
                    data-diff-line={splitRowKind(row)}
                  >
                    <span className={NUMBER}>{cell?.no ?? ''}</span>
                    <span className="pr-4">{cell?.text ?? ''}</span>
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      ))}
    </div>
  );
}
