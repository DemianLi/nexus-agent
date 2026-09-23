import { Brain, ChevronDown } from 'lucide-react';

import { MarkdownText } from '@/components/markdown-text';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { reasoningSummary } from '@/lib/reasoning-view';

/**
 * 一則回覆的推理（[#527](https://github.com/DemianLi/nexus-agent/issues/527)），畫在泡泡上方、跟工具卡分開
 * （同 dsh 的 `ReasoningRow`）。**預設收合**：推理是旁白不是回覆，展開會把工具卡擠出畫面。
 *
 * 比工具卡輕：沒有卡片底，一列小字。一輪有好幾步時每一步都有一列，做成卡片會變成一面卡片牆。
 *
 * - 收合時一行摘要：串流中是最新一行，講完是第一行（`reasoningSummary`）。
 * - 展開用正文的 `MarkdownText`，外層縮成 `text-xs`（`.markdown` 的字級都是 `em`）。
 * - **摘要不進可存取名稱**（`aria-hidden`）：它每來一顆 chunk 就變一次，焦點停在按鈕上時報讀器會跟著重唸。
 *   全文展開後照樣讀得到；推理也不進 polite 區唸（狀態列已經唸「執行中」）。
 */
export function ReasoningRow({ text, running }: { text: string; running: boolean }) {
  const summary = reasoningSummary(text, running);
  return (
    <Collapsible data-testid="reasoning-row" data-running={running || undefined}>
      <CollapsibleTrigger className="group text-muted-foreground hover:bg-chip-hover active:bg-chip-pressed flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-2 text-left text-xs transition-colors duration-(--duration-quick)">
        <Brain aria-hidden className="size-4 shrink-0" />
        <span className={running ? 'text-shimmer shrink-0' : 'shrink-0'}>
          {running ? '思考中' : '思考過程'}
        </span>
        {summary !== '' && (
          <>
            <span aria-hidden className="shrink-0 group-data-[state=open]:hidden">
              ·
            </span>
            {running ? (
              // 串流中要看到的是最新的字：外層不撐滿、可以縮，太長時 `justify-end` 讓溢出往左邊裁。
              // 不像 dsh 每三幀讀版面改 `scrollLeft`，純 CSS、不讀版面。
              <span
                aria-hidden
                data-testid="reasoning-summary"
                className="flex min-w-0 justify-end overflow-hidden group-data-[state=open]:hidden"
              >
                <span className="shrink-0 whitespace-nowrap">{summary}</span>
              </span>
            ) : (
              <span
                aria-hidden
                data-testid="reasoning-summary"
                className="min-w-0 truncate group-data-[state=open]:hidden"
              >
                {summary}
              </span>
            )}
          </>
        )}
        <ChevronDown
          aria-hidden
          className="ml-auto size-4 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="text-muted-foreground pt-1 pr-2 pb-2 pl-8 text-xs">
          <MarkdownText text={text} streaming={running} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
