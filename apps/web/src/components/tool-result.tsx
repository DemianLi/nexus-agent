/**
 * 工具卡展開之後的兩種內容（[#601](https://github.com/DemianLi/nexus-agent/issues/601)）：寫檔／改檔的 diff，以及通用卡的結果文字。
 * 要畫哪一段、切在哪裡由 `lib/tool-diff.ts` 與 `lib/tool-output.ts` 決定，這裡只管畫。
 *
 * - **diff**：對話裡最多 {@link CHAT_DIFF_MAX_LINES} 列，頭尾兩段、中間一顆鈕展開（照 dsh `DiffBlock` 的 `FoldToggle`）；
 *   展開之後照審查頁的上限畫到 {@link MAX_RENDERED_LINES} 列。底色與符號色跟審查頁同一組（`DIFF_TONE`／`DIFF_SIGN`）。
 * - **結果**：純文字、自動換行，限高 150px 在框裡捲（dsh `ToolRow.module.css` 的 `.ioText`）。框可以捲，所以
 *   鍵盤要能停上去。
 */

import { useMemo, useState } from 'react';

import type { WorkspaceDiffHunk } from '@nexus/wire';

import { DIFF_SIGN, DIFF_TONE, MAX_RENDERED_LINES } from '@/lib/diff-rows';
import { CHAT_DIFF_MAX_LINES, cappedRows, diffRows } from '@/lib/tool-diff';
import type { ToolDiffRow } from '@/lib/tool-diff';
import type { ToolOutput } from '@/lib/tool-output';
import { cn } from '@/lib/utils';

function DiffLine({ row }: { row: ToolDiffRow }) {
  if (row.kind === 'path') {
    return (
      <div className="text-muted-foreground px-3 pb-1 font-medium break-all" data-diff-line="path">
        {row.text}
      </div>
    );
  }
  if (row.kind === 'gap') {
    return (
      <div className="text-muted-foreground px-3 select-none" data-diff-line="gap">
        {row.text}
      </div>
    );
  }
  return (
    <div
      className={cn(
        'grid grid-cols-[1.5em_minmax(0,1fr)] whitespace-pre-wrap',
        DIFF_TONE[row.kind],
      )}
      data-diff-line={row.kind}
    >
      <span className={cn('text-center select-none', DIFF_SIGN[row.kind])}>
        {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
      </span>
      <span className="pr-3 wrap-anywhere">{row.text}</span>
    </div>
  );
}

export function ToolDiff({ path, hunks }: { path: string; hunks: readonly WorkspaceDiffHunk[] }) {
  const rows = useMemo(() => diffRows(path, hunks), [path, hunks]);
  const [expanded, setExpanded] = useState(false);
  const { head, tail, hidden } = cappedRows(rows, CHAT_DIFF_MAX_LINES);
  const shown = expanded ? rows.slice(0, MAX_RENDERED_LINES) : head;
  const truncated = expanded && rows.length > MAX_RENDERED_LINES;
  return (
    <div
      className="bg-stage shadow-stage rounded-xl py-2 font-mono text-xs leading-5.5"
      data-testid="tool-diff"
    >
      {shown.map((row, at) => (
        <DiffLine key={at} row={row} />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground hover:bg-chip-hover w-full px-3 py-0.5 text-left font-sans transition-colors duration-(--duration-quick)"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          data-testid="tool-diff-toggle"
        >
          {expanded ? '收起' : `展開其餘 ${hidden} 行`}
        </button>
      )}
      {!expanded && tail.map((row, at) => <DiffLine key={head.length + hidden + at} row={row} />)}
      {truncated && (
        <p className="text-muted-foreground px-3 pt-1 font-sans">
          只顯示前 {MAX_RENDERED_LINES} 行
        </p>
      )}
    </div>
  );
}

export function ToolOutputBlock({ output }: { output: ToolOutput }) {
  return (
    <div className="bg-stage shadow-stage rounded-xl" data-testid="tool-output">
      <div className="text-muted-foreground px-3 pt-2 text-xs">結果</div>
      <pre
        tabIndex={0}
        aria-label="工具結果"
        className="max-h-[150px] overflow-auto px-3 pt-1 pb-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere"
      >
        {output.head}
        {output.omitted > 0 && (
          <>
            {'\n'}
            <span
              className="text-muted-foreground font-sans italic"
              data-testid="tool-output-omitted"
            >
              {`⋯ 中間 ${output.omitted} 行沒畫 ⋯`}
            </span>
            {'\n'}
            {output.tail}
          </>
        )}
      </pre>
    </div>
  );
}
