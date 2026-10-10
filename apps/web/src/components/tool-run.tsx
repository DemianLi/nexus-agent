import { Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ConversationEntry } from '@nexus/wire';

import { Chevron } from '@/components/chevron';
import { RowTrigger } from '@/components/row-trigger';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { MessageScrollerItem } from '@/components/ui/message-scroller';
import type { ToolRunItem } from '@/lib/tool-runs';
import { toolRunLabel, toolRunSummary } from '@/lib/tool-runs';

/**
 * 收起來的一段工具呼叫（[#1309](https://github.com/DemianLi/nexus-agent/issues/1309)）：一列「N 個工具呼叫 · 讀取 ×7、寫入檔案」，
 * 點開才是原本的工具卡與夾在中間的思考，順序不變。哪些收、哪些切開見 `lib/tool-runs.ts`。
 *
 * - 跟思考過程同一種輕的列（`RowTrigger fit="bare"`、可點的字 `text-ui`，#1281），不做卡片。按鈕帶 `aria-expanded`
 *   （`CollapsibleTrigger` 給的），不開 live region：段長大時列上的數字跟著變，不唸。
 * - 展開收合用既有的 250／150（`animate-collapsible-*`）。從觀測分頁定位進來的（`instant`）不做動畫：要捲到裡面那張卡，
 *   高度得當下就是最後的高度。
 * - **裡面每一則照樣是一格 `MessageScrollerItem`**（巢在這一格裡）：捲動與「在對話裡定位」都用條目 id 找，收進來之後照樣找得到。
 */
export function ToolRun({
  run,
  open,
  instant,
  onOpenChange,
  renderEntry,
}: {
  run: ToolRunItem;
  open: boolean;
  /** 這一次展開不做動畫（觀測分頁定位進來的）。 */
  instant: boolean;
  onOpenChange: (open: boolean) => void;
  renderEntry: (entry: ConversationEntry) => ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} data-testid="tool-run">
      <RowTrigger fit="bare" className="text-muted-foreground text-ui">
        <Wrench aria-hidden className="size-4 shrink-0" />
        <span className="shrink-0">{toolRunLabel(run.tools.length)}</span>
        <span aria-hidden className="shrink-0">
          ·
        </span>
        <span className="min-w-0 truncate" data-testid="tool-run-summary">
          {toolRunSummary(run.tools)}
        </span>
        <Chevron className="ml-auto" />
      </RowTrigger>
      <CollapsibleContent
        className={
          instant
            ? 'overflow-hidden'
            : 'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden'
        }
      >
        <div className="flex flex-col gap-4 pt-4">
          {run.entries.map((entry) => (
            <MessageScrollerItem key={entry.id} messageId={entry.id} className="empty:hidden">
              {renderEntry(entry)}
            </MessageScrollerItem>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
