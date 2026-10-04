/**
 * 右側欄的「觀測」分頁（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)，殼與入口在 #1031、決定在
 * [#1017](https://github.com/DemianLi/nexus-agent/issues/1017)）：把對話一輪一組、依序列成一列一列，點開看細節。
 *
 * **第 0 版只有順序、沒有時間**，限制全部寫在畫面上（`TRACE_LIMITS`）。投影在 `lib/trace-view.ts`，這裡只畫。UI/UX 以 shadcn＋
 * Tailwind 為基底、Libraries.dev 為模仿對象，不是照 dsh 的 `ui-trajectory` 畫時間線。
 *
 * - **資料走可訂閱的 store**（`sources.conversation`），而且**只在看得見時訂閱**（`useVisibleSnapshot`）：分頁藏起來時
 *   不卸載（保住捲動位置與展開狀態），但串流的逐字片段不會讓它重算。
 * - **細節是展開的**：思考與壓縮本身就是一列可展開的元件（`ReasoningRow`、`CompactionRow`），直接當列用，不再包一層；
 *   工具列展開時才掛 `ToolCard`（沿用它的全部畫法，收著的列不付它的錢）。
 * - **375／768 單欄**：細節在列下面展開，不並排；觸控目標 44px（`min-h-11`）。串流中新增的列不做進場動效（spec §7）。
 * - **「在對話裡定位」**：每列右邊一顆鈕，捲到對話區那一則（`lib/transcript-locate.ts`）；1024 以下由右側欄先收掉抽屜、
 *   再把焦點交給那一則（`right-sidebar.tsx`）。找不到時在那一列底下講原因。
 */

import {
  Bell,
  Bot,
  ChevronDown,
  CircleHelp,
  LocateFixed,
  MessageSquareText,
  OctagonAlert,
  ShieldCheck,
  User,
  Wrench,
} from 'lucide-react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

import type { Attribution, ConversationState } from '@nexus/wire';

import { CompactionRow } from '@/components/compaction-row';
import { MarkdownText } from '@/components/markdown-text';
import { PlanToolCard } from '@/components/plan-review';
import { ReasoningRow } from '@/components/reasoning-row';
import type { PanelBodyProps } from '@/components/right-sidebar-panels';
import { ToolCard, TOOL_STATUS_LABEL } from '@/components/tool-card';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useVisibleSnapshot } from '@/hooks/use-visible-snapshot';
import { mentionDisplayText } from '@/lib/session-mention';
import { EXIT_PLAN_MODE, PLAN_OUTCOME_LABEL } from '@/lib/plan-review';
import { reasoningRunning } from '@/lib/reasoning-view';
import { subagentNames } from '@/lib/subagent-view';
import {
  ENDING_LABEL,
  TRACE_HEADLINE,
  TRACE_LIMITS,
  TRACE_TARGET_MISSING_TEXT,
  sameRow,
  traceTurns,
} from '@/lib/trace-view';
import type { TraceRow, TraceTurn } from '@/lib/trace-view';
import { cn } from '@/lib/utils';

/** 面板還沒有資料可畫時那一句（也是 #1031 留下的那一句）。 */
export const TRACE_EMPTY_TEXT = '尚無資料';

export const TRACE_LOCATE_LABEL = '在對話裡定位';
export const TRACE_LOCATED_TEXT = '已在對話裡定位';
export const TRACE_LIMITS_HEADING = '這一版的限制';

const LINE =
  'group hover:bg-chip-hover active:bg-chip-pressed flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-2 text-left text-xs transition-colors duration-(--duration-quick)';

function Chevron() {
  return (
    <ChevronDown
      aria-hidden
      className="text-muted-foreground ml-auto size-4 shrink-0 transition-transform duration-(--duration-fast) ease-(--ease-smooth-out) group-data-[state=open]:rotate-180"
    />
  );
}

function attributionLabel(attribution: Attribution | undefined): string | undefined {
  if (attribution === undefined || attribution.kind === 'root') return undefined;
  return attribution.kind === 'subagent' ? `子代理 ${attribution.name}` : '未歸屬的子代理';
}

/** 一列的上半：圖示、標籤、一行摘要；第二行放狀態等補充。 */
function Line({
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
            <span className="text-foreground min-w-0 truncate text-sm">{summary}</span>
          )}
        </span>
        {(meta !== undefined || who !== undefined) && (
          <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
            {who !== undefined && <span>{who}</span>}
            {meta}
          </span>
        )}
      </span>
    </>
  );
}

/** 不能展開的一列（決定、收尾、沒有摘要可看的壓縮之類）。 */
function StaticLine(props: Parameters<typeof Line>[0]) {
  return (
    <p className="flex min-h-11 w-full min-w-0 items-center gap-2 px-2 text-xs">
      <Line {...props} />
    </p>
  );
}

function ExpandableLine({
  line,
  children,
}: {
  line: Parameters<typeof Line>[0];
  children: ReactNode;
}) {
  return (
    <Collapsible>
      <CollapsibleTrigger className={LINE}>
        <Line {...line} />
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        <div className="pt-1 pr-2 pb-2 pl-8 text-sm">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolDetail({
  row,
  names,
}: {
  row: Extract<TraceRow, { kind: 'tool' }>;
  names: ReadonlyMap<string, string>;
}) {
  const { entry } = row;
  // 交出計劃的那一顆在對話區畫成計劃卡（`Entry`），這裡同樣。
  if (entry.name === EXIT_PLAN_MODE) return <PlanToolCard entry={entry} beam={false} />;
  return (
    <ToolCard
      entry={entry}
      beam={false}
      defaultOpen
      subagentNames={names}
      {...(row.answer === undefined ? {} : { answer: row.answer })}
    />
  );
}

function toolMeta(row: Extract<TraceRow, { kind: 'tool' }>) {
  const { entry, outcome } = row;
  return (
    <>
      <span className={entry.status === 'failed' ? 'text-destructive' : undefined}>
        {TOOL_STATUS_LABEL[entry.status]}
      </span>
      {entry.errorCode !== undefined && (
        <code className="font-mono" data-testid="trace-error-code">
          {entry.errorCode}
        </code>
      )}
      {outcome !== undefined && (
        <span className="bg-chip rounded-full px-2 py-0.5" data-testid="trace-plan-outcome">
          {PLAN_OUTCOME_LABEL[outcome]}
        </span>
      )}
    </>
  );
}

/** 一列的內容（不含定位鈕）。 */
function RowBody({ row, names }: { row: TraceRow; names: ReadonlyMap<string, string> }) {
  switch (row.kind) {
    case 'input':
      return (
        <ExpandableLine line={{ icon: User, label: '輸入', summary: row.summary }}>
          <p className="whitespace-pre-wrap">{mentionDisplayText(row.entry.text)}</p>
        </ExpandableLine>
      );
    case 'notice':
      return <StaticLine icon={Bell} label="通知" summary={row.summary} />;
    case 'agent-message':
      return (
        <ExpandableLine line={{ icon: Bot, label: row.caption, summary: row.summary }}>
          <p className="whitespace-pre-wrap">{row.entry.text}</p>
        </ExpandableLine>
      );
    case 'thinking':
      return <ReasoningRow text={row.text} running={reasoningRunning(row.entry)} />;
    case 'reply':
      return (
        <ExpandableLine
          line={{
            icon: MessageSquareText,
            label: '回覆',
            summary: row.summary,
            attribution: row.attribution,
            ...(row.entry.streaming ? { meta: '輸出中' } : {}),
          }}
        >
          <div className="text-body">
            <MarkdownText text={row.entry.text} streaming={row.entry.streaming} />
          </div>
        </ExpandableLine>
      );
    case 'tool':
      return (
        <ExpandableLine
          line={{
            icon: Wrench,
            label: row.title,
            summary: row.summary,
            attribution: row.attribution,
            meta: toolMeta(row),
            ...(row.entry.status === 'failed' ? { tone: 'danger' as const } : {}),
          }}
        >
          <ToolDetail row={row} names={names} />
        </ExpandableLine>
      );
    case 'decision':
      return <StaticLine icon={ShieldCheck} label="決定" summary={row.summary} />;
    case 'answer':
      return <StaticLine icon={CircleHelp} label="回答" summary={row.summary} />;
    case 'compaction':
      return <CompactionRow entry={row.entry} />;
    case 'ending':
      return (
        <StaticLine
          icon={OctagonAlert}
          label={ENDING_LABEL[row.reason]}
          summary={row.reason === 'stopped' ? '' : row.summary}
          attribution={row.attribution}
          {...(row.reason === 'failed' ? { tone: 'danger' as const } : {})}
        />
      );
  }
}

const TraceRowView = memo(
  function TraceRowView({
    row,
    names,
    missing,
    onLocate,
  }: {
    row: TraceRow;
    names: ReadonlyMap<string, string>;
    /** 上一次按這一列的定位找不到。 */
    missing: boolean;
    onLocate: (row: TraceRow) => void;
  }) {
    return (
      <li data-testid="trace-row" data-kind={row.kind}>
        <div className="flex items-start gap-1">
          <div className="min-w-0 flex-1">
            <RowBody row={row} names={names} />
          </div>
          {row.target !== undefined && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground size-11 shrink-0 rounded-full lg:size-9"
              aria-label={`${TRACE_LOCATE_LABEL}：${rowLabel(row)}`}
              title={TRACE_LOCATE_LABEL}
              data-testid="trace-locate"
              onClick={() => onLocate(row)}
            >
              <LocateFixed aria-hidden />
            </Button>
          )}
        </div>
        {missing && (
          <p
            role="status"
            className="text-muted-foreground px-2 pb-2 text-xs"
            data-testid="trace-missing"
          >
            {TRACE_TARGET_MISSING_TEXT}
          </p>
        )}
      </li>
    );
  },
  (previous, next) =>
    sameRow(previous.row, next.row) &&
    previous.names === next.names &&
    previous.missing === next.missing &&
    previous.onLocate === next.onLocate,
);

/** 定位鈕的名稱帶上這一列是什麼，同一頁十幾顆鈕才分得出來。 */
function rowLabel(row: TraceRow): string {
  switch (row.kind) {
    case 'input':
    case 'notice':
    case 'reply':
    case 'decision':
    case 'answer':
      return row.summary;
    case 'agent-message':
      return row.caption;
    case 'thinking':
      return '思考過程';
    case 'tool':
      return `${row.title} ${row.summary}`.trim();
    case 'compaction':
      return '壓縮';
    case 'ending':
      return ENDING_LABEL[row.reason];
  }
}

function Limits() {
  return (
    <section aria-labelledby="trace-limits" className="text-muted-foreground mt-2 px-2 text-xs">
      <h3 id="trace-limits" className="mb-1 font-medium">
        {TRACE_LIMITS_HEADING}
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="trace-limits">
        {Object.entries(TRACE_LIMITS).map(([key, text]) => (
          <li key={key} data-limit={key}>
            {text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TurnGroup({
  turn,
  names,
  missing,
  onLocate,
}: {
  turn: TraceTurn;
  names: ReadonlyMap<string, string>;
  missing: string | undefined;
  onLocate: (row: TraceRow) => void;
}) {
  return (
    <ol
      aria-label={`一輪的過程，共 ${turn.rows.length} 列`}
      className="border-border mb-4 flex flex-col gap-0.5 border-l pl-1"
      data-testid="trace-turn"
    >
      {turn.rows.map((row) => (
        <TraceRowView
          key={row.key}
          row={row}
          names={names}
          missing={missing === row.key}
          onLocate={onLocate}
        />
      ))}
    </ol>
  );
}

/**
 * 背景子代理的名字表。`entries` 每一格串流都換一個新的，表的內容卻幾乎從不變；內容沒變就回上一份，列的 `memo` 才擋得住
 * （每次算出新的 `Map` 身分就變，所有列跟著重畫）。
 */
function useStableNames(entries: ConversationState['entries']): ReadonlyMap<string, string> {
  const previous = useRef<ReadonlyMap<string, string>>(new Map());
  const next = subagentNames(entries);
  const same =
    next.size === previous.current.size &&
    [...next].every(([runId, name]) => previous.current.get(runId) === name);
  if (!same) previous.current = next;
  return previous.current;
}

const Timeline = memo(function Timeline({
  state,
  locate,
}: {
  state: ConversationState;
  locate: PanelBodyProps['locate'];
}) {
  const turns = useMemo(() => traceTurns(state), [state]);
  const names = useStableNames(state.entries);
  const [missing, setMissing] = useState<string | undefined>(undefined);
  const [announced, setAnnounced] = useState('');
  const onLocate = useCallback(
    (row: TraceRow) => {
      if (row.target === undefined) return;
      const found = locate(row.target);
      setMissing(found ? undefined : row.key);
      setAnnounced(found ? TRACE_LOCATED_TEXT : '');
    },
    [locate],
  );
  return (
    <section
      aria-label="對話的過程"
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      data-testid="right-sidebar-panel-trace"
      // 可捲動的區塊要能用鍵盤捲：進 Tab 順序（同計劃分頁，§8）。
      tabIndex={0}
    >
      <p className="text-muted-foreground mb-3 px-2 text-xs" data-testid="trace-headline">
        {TRACE_HEADLINE}
      </p>
      {turns.map((turn) => (
        <TurnGroup key={turn.key} turn={turn} names={names} missing={missing} onLocate={onLocate} />
      ))}
      <Limits />
      <p role="status" className="sr-only">
        {announced}
      </p>
    </section>
  );
});

export function TraceBody({ visible, sources, locate }: PanelBodyProps) {
  const state = useVisibleSnapshot(sources.conversation, visible);
  if (state === undefined || state.entries.length === 0) {
    return (
      <p
        className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm"
        data-testid="right-sidebar-panel-trace"
      >
        {TRACE_EMPTY_TEXT}
      </p>
    );
  }
  return <Timeline state={state} locate={locate} />;
}
