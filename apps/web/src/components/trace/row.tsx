/**
 * 觀測分頁的一列（`TraceRowView`）：照列的種類畫內容，右邊一顆「在對話裡定位」。細節是展開的——思考與壓縮本身就是一列可展開的
 * 元件，工具列展開時才掛 `ToolCard`（收著的列不付它的錢）。
 */

import {
  Bell,
  Bot,
  CircleHelp,
  Info,
  LocateFixed,
  MessageSquareText,
  OctagonAlert,
  Repeat,
  RotateCw,
  ShieldCheck,
  User,
  Wrench,
} from 'lucide-react';
import { memo } from 'react';

import { CompactionRow } from '@/components/compaction-row';
import { MarkdownText } from '@/components/markdown-text';
import { PlanToolCard } from '@/components/plan/review';
import { ReasoningRow } from '@/components/reasoning-row';
import { CallRow } from '@/components/trace/call';
import { ExpandableLine, SnapshotBlock, StaticLine } from '@/components/trace/lines';
import { SUBAGENT_CALLS_TITLE, SubagentCalls } from '@/components/trace/subagent';
import { ToolCard, TOOL_STATUS_LABEL } from '@/components/tool/card';
import { Button } from '@/components/ui/button';
import { mentionDisplayText } from '@/lib/session-mention';
import { EXIT_PLAN_MODE, PLAN_OUTCOME_LABEL } from '@/lib/plan-review';
import { reasoningRunning } from '@/lib/reasoning-view';
import { ENDING_LABEL, TRACE_TARGET_MISSING_TEXT, sameRow } from '@/lib/trace-view';
import type { TraceRow } from '@/lib/trace-view';
import { SIGNAL_LABEL, approvalCodeText, clockText, durationText } from '@/lib/trajectory-view';

export const TRACE_LOCATE_LABEL = '在對話裡定位';

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
  const approvalCode =
    entry.errorCode === undefined ? undefined : approvalCodeText(entry.errorCode);
  return (
    <>
      <span className={entry.status === 'failed' ? 'text-destructive' : undefined}>
        {TOOL_STATUS_LABEL[entry.status]}
      </span>
      {row.time !== undefined && (
        <span data-testid="trace-time">
          {clockText(row.time)}
          {row.durationMs !== undefined && ` · ${durationText(row.durationMs)}`}
        </span>
      )}
      {entry.errorCode !== undefined && (
        <code className="font-mono" data-testid="trace-error-code">
          {entry.errorCode}
        </code>
      )}
      {approvalCode !== undefined && <span data-testid="trace-approval-code">{approvalCode}</span>}
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
          {row.subagentRunId !== undefined && (
            <SnapshotBlock testId="trace-subagent-block" title={SUBAGENT_CALLS_TITLE}>
              <SubagentCalls runId={row.subagentRunId} />
            </SnapshotBlock>
          )}
        </ExpandableLine>
      );
    case 'call':
      return <CallRow row={row} />;
    case 'retry':
      return (
        <StaticLine
          icon={RotateCw}
          label={`重試 ${row.retry}/${row.maxRetries}`}
          summary={row.status === undefined ? row.code : `${row.code} · HTTP ${row.status}`}
          meta={
            <span data-testid="trace-time">
              {clockText(row.time)} · 等了 {durationText(row.waitedMs)}
            </span>
          }
        />
      );
    case 'signal':
      return (
        <StaticLine
          icon={row.signal === 'reminder' ? Repeat : Info}
          label={SIGNAL_LABEL[row.signal]}
          summary={row.summary}
          meta={<span data-testid="trace-time">{clockText(row.time)}</span>}
        />
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

export const TraceRowView = memo(
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
    case 'call':
      return `模型呼叫 #${row.n}`;
    case 'retry':
      return `重試 ${row.retry}/${row.maxRetries}`;
    case 'signal':
      return row.summary;
  }
}
