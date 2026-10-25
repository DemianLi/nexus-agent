/**
 * 觀測分頁一列的基本件（#1690 T3）：一則一行，SG `StepRow` 的句型——標籤與摘要接成一句，收著時看得到的補充（狀態、碼、歸屬）
 * 接在同一行後面；能展開的列把時刻、耗時收進展開區，展開區另放細節。不能展開的列不是停用的鈕，是同一個句型的一行字，時刻接在後面。
 * 其他 `trace-*` 檔都從這裡取，所以這裡不依賴它們。
 */

import type { ComponentType, ReactNode } from 'react';

import type { Attribution } from '@nexus/wire';

import { Chevron } from '@/components/chevron';
import { RowTrigger } from '@/components/row-trigger';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { StepRow } from '@/components/ui/tool-steps';
import { cn } from '@/lib/utils';

function attributionLabel(attribution: Attribution | undefined): string | undefined {
  if (attribution === undefined || attribution.kind === 'root') return undefined;
  return attribution.kind === 'subagent' ? `子代理 ${attribution.name}` : '未歸屬的子代理';
}

interface LineProps {
  icon: ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  summary: string;
  /** 只有不能展開的列用：摘要是某個失敗碼的一句話時的原碼，放進 `title` 與 `data-failure-code`，同輪標頭的「失敗（…）」。 */
  code?: string;
  /** 收著時就要看得到的補充：狀態字、錯誤碼、結果 chip。 */
  meta?: ReactNode;
  /** 時刻、耗時這類展開才看的補充：能展開的列收進展開區，不能展開的接在那一行後面。 */
  time?: ReactNode;
  attribution?: Attribution | undefined;
  tone?: 'danger';
}

/**
 * 圖示框跟右邊的定位鈕（`row.tsx`）同高：1024 以下 44px、以上 36px。1024 以下列的按鈕也是 44px（覆寫檔第 63 條）；1024 以上列只有一行字高，
 * 靠 `ExpandableLine` 的 `lg:pt-2` 讓字的中心對上圖示框的中心。
 */
function LineIcon({ icon: Icon, tone }: Pick<LineProps, 'icon' | 'tone'>) {
  return (
    <span className="flex h-11 shrink-0 items-center lg:h-9">
      <Icon
        aria-hidden
        className={cn('size-4', tone === 'danger' ? 'text-destructive' : 'text-muted-foreground')}
      />
    </span>
  );
}

function Extras({ attribution, meta }: Pick<LineProps, 'attribution' | 'meta'>) {
  const who = attributionLabel(attribution);
  return (
    <>
      {who !== undefined && <span className="shrink-0 text-tip">{who}</span>}
      {meta !== undefined && (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-tip">{meta}</span>
      )}
    </>
  );
}

/** 不能展開的一列（決定、收尾、重試、提醒之類）：同一個句型的一行字，時刻接在後面。 */
export function StaticLine({
  icon,
  label,
  summary,
  code,
  meta,
  time,
  attribution,
  tone,
}: LineProps) {
  return (
    <div className="text-muted-foreground flex w-full min-w-0 items-start gap-2 px-2">
      <LineIcon icon={icon} tone={tone} />
      <p className="flex min-h-11 min-w-0 flex-1 flex-wrap items-center gap-x-2 py-1 text-ui lg:min-h-9">
        <span className="min-w-0">
          {label}
          {summary !== '' && (
            <>
              {'　'}
              <span {...(code === undefined ? {} : { title: code, 'data-failure-code': code })}>
                {summary}
              </span>
            </>
          )}
        </span>
        <Extras attribution={attribution} meta={meta} />
        {time !== undefined && <span className="shrink-0 text-tip">{time}</span>}
      </p>
    </div>
  );
}

/** 能展開的一列：SG `StepRow`，打開是 `time`（有給才畫）與 `children`。 */
export function ExpandableLine({
  line,
  children,
}: {
  line: Omit<LineProps, 'code'>;
  children: ReactNode;
}) {
  const { icon, label, summary, meta, time, attribution, tone } = line;
  return (
    <div className="flex w-full min-w-0 items-start gap-2 px-2">
      <LineIcon icon={icon} tone={tone} />
      <div className="min-w-0 flex-1 pb-1 lg:pt-2">
        <StepRow
          step={{
            id: label,
            label: summary === '' ? label : [label, summary].join('　'),
            status: tone === 'danger' ? 'error' : 'done',
          }}
          trailing={
            // 窄的時候標題先拿寬度，這一段只用剩下的、自己換行（碼放不下才斷開），不壓到右邊的箭頭與定位鈕。
            <span className="flex min-w-0 grow basis-0 flex-wrap items-center gap-x-2 text-left wrap-anywhere">
              <Extras attribution={attribution} meta={meta} />
            </span>
          }
        >
          {time !== undefined && (
            <p className="text-muted-foreground flex flex-wrap gap-x-2 text-tip">{time}</p>
          )}
          <div className="text-body">{children}</div>
        </StepRow>
      </div>
    </div>
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
