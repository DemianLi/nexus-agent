/**
 * 觀測分頁一列的基本件：圖示＋標籤＋摘要的一行（`Line`）、不能展開與能展開兩種列、列下面再往下摺一層的小區塊。
 * 其他 `trace-*` 檔都從這裡取，所以這裡不依賴它們。
 */

import type { ComponentType, ReactNode } from 'react';

import type { Attribution } from '@nexus/wire';

import { Chevron } from '@/components/chevron';
import { RowTrigger } from '@/components/row-trigger';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

function attributionLabel(attribution: Attribution | undefined): string | undefined {
  if (attribution === undefined || attribution.kind === 'root') return undefined;
  return attribution.kind === 'subagent' ? `子代理 ${attribution.name}` : '未歸屬的子代理';
}

/** 一列的上半：圖示、標籤、一行摘要；第二行放狀態等補充。 */
export function Line({
  icon: Icon,
  label,
  summary,
  meta,
  attribution,
  tone,
}: {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  summary: string;
  meta?: ReactNode;
  attribution?: Attribution | undefined;
  tone?: 'danger';
}) {
  const who = attributionLabel(attribution);
  return (
    <>
      <Icon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          tone === 'danger' ? 'text-destructive' : 'text-muted-foreground',
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-muted-foreground shrink-0">{label}</span>
          {summary !== '' && (
            <span className="text-foreground min-w-0 truncate text-body">{summary}</span>
          )}
        </span>
        {(meta !== undefined || who !== undefined) && (
          <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 text-tip">
            {who !== undefined && <span>{who}</span>}
            {meta}
          </span>
        )}
      </span>
    </>
  );
}

/** 不能展開的一列（決定、收尾、沒有摘要可看的壓縮之類）。 */
export function StaticLine(props: Parameters<typeof Line>[0]) {
  return (
    <p className="flex min-h-11 w-full min-w-0 items-center gap-2 px-2 text-ui">
      <Line {...props} />
    </p>
  );
}

export function ExpandableLine({
  line,
  children,
}: {
  line: Parameters<typeof Line>[0];
  children: ReactNode;
}) {
  return (
    <Collapsible>
      <RowTrigger fit="bare" className="text-ui">
        <Line {...line} />
        <Chevron className="text-muted-foreground ml-auto" />
      </RowTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="pt-1 pr-2 pb-2 pl-8 text-body">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** 呼叫列裡再往下展開一層的小區塊（系統提示詞全文、設定與工具清單、單一工具的說明）。 */
export function SnapshotBlock({
  title,
  testId,
  children,
}: {
  title: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className="mt-1" data-testid={testId}>
      <RowTrigger fit="bare" className="text-ui">
        <span className="min-w-0 truncate font-medium">{title}</span>
        <Chevron className="text-muted-foreground ml-auto" />
      </RowTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="pt-1 pb-2 pl-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
