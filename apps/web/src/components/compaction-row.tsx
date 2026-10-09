import type { CompactionEntry } from '@nexus/wire';
import { FoldVertical } from 'lucide-react';

import { Chevron } from '@/components/chevron';
import { RowTrigger } from '@/components/row-trigger';
import { MarkdownText } from '@/components/markdown-text';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import {
  COMPACTION_SUMMARY_MAX_REM,
  COMPACTION_UNSAVED_TEXT,
  compactionSummary,
  compactionTitle,
} from '@/lib/compaction-view';

/**
 * 對話裡的壓縮標記（[#944](https://github.com/DemianLi/nexus-agent/issues/944)，對應 dsh 的 `CompactionItem`）：模型的
 * 歷史在這裡換成了一份摘要。**不取代**被蓋掉的列，畫面上的對話一則都沒少。算法在 `lib/compaction-view.ts`。
 *
 * - **預設收合，一行字**：「對話已壓縮：前 N 則換成了摘要」。
 * - **有摘要才能展開**：展開用跟正文同一個 `MarkdownText`。沒有摘要（舊日誌）就是一行不能點的字，不畫成看起來能點。
 * - **`saved === false`**（原文沒有另存）同一行多一小段「原文未另存」，沒有警示色。
 * - **展開區有畫面上的行數上限**（約 20 行），超過就在區內捲，免得一大份摘要把對話擠出畫面。
 * - 展開才掛載摘要的 Markdown：收著的壓縮列不付解析的錢。
 */
export function CompactionRow({ entry }: { readonly entry: CompactionEntry }) {
  const summary = compactionSummary(entry);
  const title = compactionTitle(entry);
  const note = entry.saved ? undefined : COMPACTION_UNSAVED_TEXT;
  const line = (
    <>
      <FoldVertical aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {note !== undefined && <span className="shrink-0">· {note}</span>}
    </>
  );
  const frame = 'bg-chip text-muted-foreground rounded-xl text-tip';
  if (summary === undefined) {
    return (
      <p
        data-testid="compaction-row"
        className={`${frame} flex min-h-9 min-w-0 items-center gap-2 px-3`}
      >
        {line}
      </p>
    );
  }
  return (
    <Collapsible data-testid="compaction-row" className={frame}>
      <RowTrigger fit="bare" className="px-3 lg:min-h-9">
        {line}
        <Chevron />
      </RowTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div
          data-testid="compaction-summary"
          className="overflow-y-auto px-3 pt-1 pb-3"
          style={{ maxHeight: `${COMPACTION_SUMMARY_MAX_REM}rem` }}
        >
          <MarkdownText text={summary} streaming={false} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
