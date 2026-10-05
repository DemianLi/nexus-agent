/**
 * 右側欄的「觀測」分頁（[#1033](https://github.com/DemianLi/nexus-agent/issues/1033)，殼與入口在 #1031、決定在
 * [#1017](https://github.com/DemianLi/nexus-agent/issues/1017)；第 1 版在 [#1034](https://github.com/DemianLi/nexus-agent/issues/1034)）：
 * 把對話一輪一組、依序列成一列一列，點開看細節。
 *
 * **有軌跡投影時**（`lib/trace-view.ts` 的結構化模式）輪界、模型呼叫段落、重試、重複呼叫提醒、時刻與耗時都讀它；**沒有時**
 * 退回第 0 版（只有順序），兩種的限制都全部寫在畫面上（`TRACE_LIMITS`、`TRACE_STRUCTURED_LIMITS`）。投影的歸位在
 * `lib/trace-view.ts`，這裡只畫。UI/UX 以 shadcn＋Tailwind 為基底、Libraries.dev 為模仿對象，不是照 dsh 的
 * `ui-trajectory` 畫時間線。
 *
 * - **畫面上的列數有上限**：只畫最新的 {@link TURN_PAGE} 組、每組只畫最新的 {@link ROW_PAGE} 列，更早的按「顯示更早的」再展開；窗口外的輪摘要（最多 200 列）收在
 *   一個摺起來的區塊、同樣分段。投影每顆事件整份換掉，所以列只放原始值（`lib/trace-view.ts`），`memo` 才擋得住。
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
  Cpu,
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
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';

import type { Attribution, ConversationState } from '@nexus/wire';

import { CompactionRow } from '@/components/compaction-row';
import { MarkdownText } from '@/components/markdown-text';
import { PlanToolCard } from '@/components/plan-review';
import { ReasoningRow } from '@/components/reasoning-row';
import type { PanelBodyProps, TurnReveal } from '@/components/right-sidebar-panels';
import { ToolCard, TOOL_STATUS_LABEL } from '@/components/tool-card';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useStableNames } from '@/hooks/use-stable-names';
import { useTrajectoryPull } from '@/hooks/use-trajectory-pull';
import { useVisibleSnapshot } from '@/hooks/use-visible-snapshot';
import { mentionDisplayText } from '@/lib/session-mention';
import { EXIT_PLAN_MODE, PLAN_OUTCOME_LABEL } from '@/lib/plan-review';
import { reasoningRunning } from '@/lib/reasoning-view';
import {
  ENDING_LABEL,
  TRACE_CALL_UNLOADED_TEXT,
  TRACE_HEADLINE,
  TRACE_LIMITS,
  TRACE_STRUCTURED_HEADLINE,
  TRACE_STRUCTURED_LIMITS,
  TRACE_TARGET_MISSING_TEXT,
  sameRow,
  traceModel,
  turnSeqOfMessage,
} from '@/lib/trace-view';
import type { TraceDigest, TraceRow, TraceTurn, TurnHead } from '@/lib/trace-view';
import { statusOf } from '@/lib/trajectory-pull';
import type { PullSnapshot, PullStatus, TrajectoryPuller } from '@/lib/trajectory-pull';
import {
  ABSENT,
  SIGNAL_LABEL,
  TURN_END_LABEL,
  TURN_KIND_LABEL,
  approvalCodeText,
  clockText,
  durationText,
  tokenText,
  trajectoryOf,
} from '@/lib/trajectory-view';
import { cn } from '@/lib/utils';

/** 面板還沒有資料可畫時那一句（也是 #1031 留下的那一句）。 */
export const TRACE_EMPTY_TEXT = '尚無資料';

export const TRACE_LOCATE_LABEL = '在對話裡定位';
export const TRACE_LOCATED_TEXT = '已在對話裡定位';
export const TRACE_LIMITS_HEADING = '這一版的限制';
export const TRACE_REVEALED_TEXT = '已捲到那一輪';
export const TRACE_REVEAL_MISSING_TEXT = '觀測分頁已經沒有那一輪的資料';
/** 從回覆底下按「這一輪的過程」，那一則歸不進軌跡的輪（窗口之前、投影還沒跟上、或沒有軌跡投影）。 */
export const TRACE_REPLY_UNPLACED_TEXT =
  '這一則回覆歸不到軌跡裡的輪：它在軌跡窗口之前，或軌跡還沒跟上、或這個會話沒有軌跡投影。';
/** 同上，但軌跡有更早輪的摘要：多半是那一輪太舊，只剩摘要，對不到是哪一輪。 */
export const TRACE_REPLY_OLDER_TEXT =
  '這一則回覆多半在軌跡窗口之前：更早的輪只剩摘要（上面「更早的輪」），對不到是哪一輪。';
/** 按需拉那一輪的細節（#1083）。 */
export const TRACE_PULL_LABEL = '載入這一輪的細節';
export const TRACE_PULL_RETRY_LABEL = '重試';
export const TRACE_PULL_LOADING_TEXT = '正在載入這一輪的細節…';
export const TRACE_PULL_SUMMARY_ONLY_TEXT = '只有摘要，細節沒有載入';
/** 載入失敗：後面接伺服器（或連線）給的原因，原樣不加前綴。 */
export const TRACE_PULL_FAILED_TEXT = '無法載入這一輪的細節：';
/** 「看這一輪」標示的那一圈亮多久。 */
export const REVEAL_HIGHLIGHT_MS = 3000;

const noop = () => {};

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

export const TRACE_SNAPSHOT_REASON_TEXT = {
  initial: '第一次記錄',
  change: '內容變了才又記一份',
} as const;
export const TRACE_SYSTEM_TRUNCATED_TEXT = '這份系統提示詞太長，只留前面的部分，下面不是全文。';
export const TRACE_TOOLS_DIFF_PREFIX = '相對上一份工具清單：';
export const TRACE_HEADER_BAD_TEXT = '這份設定與工具清單讀不出來。';

const SNAPSHOT_STATE_TEXT = { none: ABSENT, gone: '已不保留' } as const;

/** 呼叫上記的請求快照：沒記是 `—`，指到的那份已被擠掉是「已不保留」（快照只留最新 4 份）。 */
function snapshotText(
  row: Extract<TraceRow, { kind: 'call' }>,
  which: 'system' | 'header',
): string {
  const state = row[which];
  if (state !== 'kept') return SNAPSHOT_STATE_TEXT[state];
  if (which === 'system') {
    return row.systemChars === undefined
      ? '已記錄'
      : `${tokenText(row.systemChars)} 字元${row.systemTruncated === true ? '（已截斷）' : ''}`;
  }
  return row.headerTools === undefined ? '已記錄' : `工具 ${row.headerTools} 個`;
}

/** 呼叫列裡再往下展開一層的小區塊（系統提示詞全文、設定與工具清單、單一工具的說明）。 */
function SnapshotBlock({
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
      <CollapsibleTrigger className={LINE}>
        <span className="min-w-0 truncate font-medium">{title}</span>
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden">
        <div className="pt-1 pb-2 pl-2">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

const SNAPSHOT_PRE =
  'bg-chip max-h-72 min-w-0 overflow-auto rounded-lg p-2 font-mono text-xs break-words whitespace-pre-wrap';

interface ParsedHeader {
  readonly config: readonly (readonly [string, string])[];
  readonly tools: readonly {
    readonly name: string;
    readonly description: string;
    readonly rest: string;
  }[];
}

/** 展開時才解析（整份常有二十幾 KB）。讀不出來是 `undefined`，不猜。 */
function parseHeader(json: string): ParsedHeader | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { config, tools } = value as { config?: unknown; tools?: unknown };
  const text = (v: unknown) => (typeof v === 'string' ? v : (JSON.stringify(v) ?? ABSENT));
  return {
    config:
      typeof config === 'object' && config !== null
        ? Object.entries(config).map(([key, v]) => [key, text(v)] as const)
        : [],
    tools: Array.isArray(tools)
      ? tools.map((tool: unknown) => {
          if (typeof tool !== 'object' || tool === null)
            return { name: ABSENT, description: '', rest: text(tool) };
          const { name, description, ...rest } = tool as Record<string, unknown>;
          return {
            name: typeof name === 'string' ? name : ABSENT,
            description: typeof description === 'string' ? description : '',
            rest: Object.keys(rest).length === 0 ? '' : JSON.stringify(rest, null, 2),
          };
        })
      : [],
  };
}

function HeaderBody({ json, diff }: { json: string; diff: string | undefined }) {
  const header = useMemo(() => parseHeader(json), [json]);
  if (header === undefined) {
    return <p className="text-muted-foreground text-xs">{TRACE_HEADER_BAD_TEXT}</p>;
  }
  return (
    <div className="space-y-2 text-xs">
      {header.config.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1" data-testid="trace-header-config">
          {header.config.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="text-foreground min-w-0 font-mono break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {diff !== undefined && (
        <p className="text-foreground" data-testid="trace-header-diff">
          {TRACE_TOOLS_DIFF_PREFIX}
          {diff}
        </p>
      )}
      <ul className="space-y-0.5" data-testid="trace-header-tools">
        {header.tools.map((tool, index) => (
          <li key={`${tool.name}-${index}`}>
            <SnapshotBlock
              testId="trace-header-tool"
              title={<code className="font-mono">{tool.name}</code>}
            >
              {tool.description !== '' && (
                <p className="mb-1 break-words whitespace-pre-wrap">{tool.description}</p>
              )}
              {tool.rest !== '' && <pre className={SNAPSHOT_PRE}>{tool.rest}</pre>}
            </SnapshotBlock>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 這次呼叫當時送出去的系統提示詞全文，與取樣設定、工具清單（日誌的 `request/system`、`request/header`）。 */
function SnapshotDetails({ row }: { row: Extract<TraceRow, { kind: 'call' }> }) {
  return (
    <>
      {row.systemText !== undefined && (
        <SnapshotBlock
          testId="trace-system-text"
          title={`系統提示詞全文（${tokenText(row.systemChars)} 字元）`}
        >
          {row.systemReason !== undefined && (
            <p className="text-muted-foreground mb-1 text-xs">
              {TRACE_SNAPSHOT_REASON_TEXT[row.systemReason]}
            </p>
          )}
          {row.systemTruncated === true && (
            <p className="text-muted-foreground mb-1 text-xs" data-testid="trace-system-truncated">
              {TRACE_SYSTEM_TRUNCATED_TEXT}
            </p>
          )}
          <pre className={SNAPSHOT_PRE}>{row.systemText}</pre>
        </SnapshotBlock>
      )}
      {row.headerJson !== undefined && (
        <SnapshotBlock
          testId="trace-header-block"
          title={
            row.headerTools === undefined
              ? '取樣設定與工具清單'
              : `取樣設定與工具清單（工具 ${row.headerTools} 個）`
          }
        >
          {row.headerReason !== undefined && (
            <p className="text-muted-foreground mb-1 text-xs">
              {TRACE_SNAPSHOT_REASON_TEXT[row.headerReason]}
            </p>
          )}
          <HeaderBody json={row.headerJson} diff={row.toolsDiff} />
        </SnapshotBlock>
      )}
    </>
  );
}

/** 一次模型呼叫的段落：起訖、用量、模型與當時送出的設定。 */
function CallRow({ row }: { row: Extract<TraceRow, { kind: 'call' }> }) {
  const details: [string, string][] = [
    ['開始', clockText(row.time)],
    ['結束', clockText(row.endTime)],
    ['耗時', durationText(row.durationMs)],
    ['模型', row.model ?? ABSENT],
    ['輸入 token', tokenText(row.inputTokens)],
    ['輸出 token', tokenText(row.outputTokens)],
    ['這次叫的工具', `${row.toolCount} 個`],
    ['重試', `${row.retryCount} 次`],
    ['系統提示詞', snapshotText(row, 'system')],
    ['設定與工具清單', snapshotText(row, 'header')],
  ];
  return (
    <ExpandableLine
      line={{
        icon: Cpu,
        label: `模型呼叫 #${row.n}`,
        summary: row.model ?? '',
        meta: (
          <span data-testid="trace-time">
            {clockText(row.time)} · {durationText(row.durationMs)}
            {row.inputTokens !== undefined &&
              ` · 輸入 ${tokenText(row.inputTokens)}／輸出 ${tokenText(row.outputTokens)}`}
          </span>
        ),
      }}
    >
      <dl
        className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs"
        data-testid="trace-call-details"
      >
        {details.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="text-foreground min-w-0 break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <SnapshotDetails row={row} />
      {row.hasContent && !row.loaded && (
        <p className="text-muted-foreground mt-2 text-xs" data-testid="trace-call-unloaded">
          {TRACE_CALL_UNLOADED_TEXT}
        </p>
      )}
    </ExpandableLine>
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
    case 'call':
      return `模型呼叫 #${row.n}`;
    case 'retry':
      return `重試 ${row.retry}/${row.maxRetries}`;
    case 'signal':
      return row.summary;
  }
}

function Limits({ structured }: { structured: boolean }) {
  const limits = structured ? TRACE_STRUCTURED_LIMITS : TRACE_LIMITS;
  return (
    <section aria-labelledby="trace-limits" className="text-muted-foreground mt-2 px-2 text-xs">
      <h3 id="trace-limits" className="mb-1 font-medium">
        {TRACE_LIMITS_HEADING}
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="trace-limits">
        {Object.entries(limits).map(([key, text]) => (
          <li key={key} data-limit={key}>
            {text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 一次畫幾組；更早的按「顯示更早的」再展開。 */
export const TURN_PAGE = 12;
/** 窗口外的輪摘要一次畫幾列。 */
export const DIGEST_PAGE = 20;
/** 一組裡一次畫幾列（最新的）；單輪可以很長（目標自己排的輪、一輪幾百次呼叫），列數不設限畫面會凍住。 */
export const ROW_PAGE = 200;

export const TRACE_MORE_TURNS_LABEL = '顯示更早的輪';
export const TRACE_MORE_DIGESTS_LABEL = '顯示更早的摘要';
export const TRACE_MORE_ROWS_LABEL = '顯示更早的列';
export const TRACE_LEGACY_GROUP_TEXT = '沒有結構資料的一輪：以人說的那一句切開';

/** 一輪的數字（呼叫、工具、重試、token）；摺掉的部分仍算在計數裡，所以另外講。 */
function HeadFacts({ head }: { head: TurnHead }) {
  return (
    <>
      <span>{clockText(head.time)}</span>
      <span>耗時 {durationText(head.durationMs)}</span>
      <span>{head.end === undefined ? '進行中' : TURN_END_LABEL[head.end]}</span>
      <span>{head.callCount} 次呼叫</span>
      <span>
        {head.toolCount} 個工具
        {head.toolErrors > 0 && `（${head.toolErrors} 個失敗）`}
      </span>
      {head.subagentCount > 0 && (
        <span data-testid="trace-subagent-count">{head.subagentCount} 個子代理</span>
      )}
      {head.retryCount > 0 && <span>重試 {head.retryCount} 次</span>}
      <span>
        輸入 {tokenText(head.inputTokens)}／輸出 {tokenText(head.outputTokens)}
      </span>
    </>
  );
}

function TurnHeader({ head }: { head: TurnHead }) {
  return (
    <header className="px-2 pt-1 pb-1" data-testid="trace-turn-head">
      <h3
        className="text-foreground text-sm font-medium outline-none"
        // 成本分頁的「看這一輪」把焦點交到這裡（`reveal`）；平常不在 Tab 順序裡。
        data-reveal-target=""
        tabIndex={-1}
      >
        第 {head.number} 輪
        <span className="text-muted-foreground ml-2 text-xs font-normal">
          {TURN_KIND_LABEL[head.kind]}
        </span>
      </h3>
      <p className="text-muted-foreground flex flex-wrap gap-x-2 text-xs">
        <HeadFacts head={head} />
      </p>
      {head.elidedCalls !== undefined && (
        <p className="text-muted-foreground text-xs" data-testid="trace-elided">
          另有 {head.elidedCalls} 次呼叫已摺掉
          {head.elidedTools !== undefined && `、${head.elidedTools} 個工具已摺掉`}
          ，上面的計數仍包含它們。
        </p>
      )}
    </header>
  );
}

/** 一列摘要、或只有摘要的組：載入那一輪的細節（進行中講進度，失敗講原因並給重試）。 */
function PullControl({ status, onPull }: { status: PullStatus; onPull: () => void }) {
  return (
    <div className="px-2 pt-1 pb-1" data-testid="trace-pull" data-status={status.kind}>
      {status.kind === 'failed' && (
        <p className="text-destructive pb-1 text-xs" data-testid="trace-pull-failed">
          {TRACE_PULL_FAILED_TEXT}
          {status.message}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-11 text-xs lg:min-h-8"
        disabled={status.kind === 'loading'}
        onClick={onPull}
      >
        {status.kind === 'loading'
          ? TRACE_PULL_LOADING_TEXT
          : status.kind === 'failed'
            ? TRACE_PULL_RETRY_LABEL
            : TRACE_PULL_LABEL}
      </Button>
    </div>
  );
}

function TurnGroup({
  turn,
  structured,
  names,
  missing,
  revealed,
  onLocate,
  pullStatus,
  onPull,
}: {
  turn: TraceTurn;
  structured: boolean;
  names: ReadonlyMap<string, string>;
  missing: string | undefined;
  /** 剛被成本分頁指到的那一組：畫一圈標示。 */
  revealed: boolean;
  onLocate: (row: TraceRow) => void;
  /** 只有摘要的組才有：載入細節的進度（沒給就不畫載入鈕）。 */
  pullStatus?: PullStatus | undefined;
  onPull?: ((seq: number) => void) | undefined;
}) {
  const title = turn.head === undefined ? '' : `第 ${turn.head.number} 輪`;
  const [shown, setShown] = useState(ROW_PAGE);
  const hiddenRows = Math.max(0, turn.rows.length - shown);
  const rows = hiddenRows === 0 ? turn.rows : turn.rows.slice(hiddenRows);
  return (
    <section
      className={`border-border mb-4 border-l pl-1 ${revealed ? 'ring-ring rounded-md ring-2' : ''}`}
      data-testid="trace-turn"
      data-legacy={turn.legacy ? '' : undefined}
      data-seq={turn.seq}
      data-revealed={revealed ? '' : undefined}
    >
      {turn.head !== undefined && <TurnHeader head={turn.head} />}
      {turn.summaryOnly === true && (
        <p className="text-muted-foreground px-2 text-xs" data-testid="trace-summary-only">
          {TRACE_PULL_SUMMARY_ONLY_TEXT}
        </p>
      )}
      {turn.summaryOnly === true &&
        turn.seq !== undefined &&
        pullStatus !== undefined &&
        onPull !== undefined && (
          <PullControl status={pullStatus} onPull={() => onPull(turn.seq!)} />
        )}
      {structured && turn.legacy && (
        <p className="text-muted-foreground px-2 pt-1 text-xs" data-testid="trace-legacy-group">
          {TRACE_LEGACY_GROUP_TEXT}
        </p>
      )}
      {hiddenRows > 0 && (
        <Button
          type="button"
          variant="ghost"
          className="min-h-11 w-full text-xs lg:min-h-9"
          data-testid="trace-more-rows"
          onClick={() => setShown((count) => count + ROW_PAGE)}
        >
          {TRACE_MORE_ROWS_LABEL}（還有 {hiddenRows} 列）
        </Button>
      )}
      <ol
        aria-label={`${title}的過程，共 ${turn.rows.length} 列`.trimStart()}
        className="flex flex-col gap-0.5"
      >
        {rows.map((row) => (
          <TraceRowView
            key={row.key}
            row={row}
            names={names}
            missing={missing === row.key}
            onLocate={onLocate}
          />
        ))}
      </ol>
    </section>
  );
}

/** 窗口外那些輪：只有計數，沒有內文、沒有定位鈕。 */
function Digests({
  digests,
  omitted,
  reveal,
  revealedSeq,
  onRevealed,
  statusOf: pullStatusOf,
  onPull,
}: {
  digests: readonly TraceDigest[];
  omitted: number;
  /** 載入某一輪細節的進度與動作（沒給就不畫載入鈕）。 */
  statusOf?: ((seq: number) => PullStatus) | undefined;
  onPull?: ((seq: number) => void) | undefined;
  /** 要顯示的是這裡面的某一輪：展開區塊、展開到那一輪那一頁，再捲過去。 */
  reveal: { readonly seq: number; readonly nonce: number } | undefined;
  revealedSeq: number | undefined;
  onRevealed: (nonce: number) => void;
}) {
  const [shown, setShown] = useState(DIGEST_PAGE);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState<number | undefined>(undefined);
  const list = useRef<HTMLOListElement>(null);
  const hidden = Math.max(0, digests.length - shown);
  const visible = digests.slice(hidden);
  // 第一段：決定要展開到哪（只動狀態）。第二段在這些狀態落地、列畫出來之後才找元素。
  useEffect(() => {
    if (reveal === undefined) return;
    const at = digests.findIndex((digest) => digest.seq === reveal.seq);
    if (at === -1) return;
    setOpen(true);
    setShown((count) => Math.max(count, digests.length - at));
    setReady(reveal.nonce);
  }, [reveal, digests]);
  useEffect(() => {
    if (reveal === undefined || ready !== reveal.nonce) return;
    const target = list.current?.querySelector<HTMLElement>(`[data-seq="${reveal.seq}"]`);
    if (target === null || target === undefined) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
    onRevealed(reveal.nonce);
  }, [reveal, ready, shown, open, onRevealed]);
  return (
    <Collapsible className="mb-4" data-testid="trace-digests" open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className={LINE}>
        <span className="text-muted-foreground">
          更早的 {digests.length + omitted} 輪（只有摘要）
        </span>
        <Chevron />
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden">
        {omitted > 0 && (
          <p className="text-muted-foreground px-2 pb-1 text-xs" data-testid="trace-omitted">
            再更早的 {omitted} 輪連摘要都沒留下。
          </p>
        )}
        {hidden > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="mb-1 min-h-11 w-full text-xs lg:min-h-9"
            data-testid="trace-more-digests"
            onClick={() => setShown((count) => count + DIGEST_PAGE)}
          >
            {TRACE_MORE_DIGESTS_LABEL}（還有 {hidden} 輪）
          </Button>
        )}
        <ol ref={list} className="flex flex-col gap-1 px-2 text-xs" aria-label="更早的輪的摘要">
          {visible.map((digest) => (
            <li
              key={digest.key}
              className={`outline-none ${revealedSeq === digest.seq ? 'ring-ring rounded-md ring-2' : ''}`}
              data-testid="trace-digest"
              data-number={digest.number}
              data-seq={digest.seq}
              data-revealed={revealedSeq === digest.seq ? '' : undefined}
              tabIndex={-1}
            >
              <p className="text-foreground">
                第 {digest.number} 輪
                <span className="text-muted-foreground ml-2">{TURN_KIND_LABEL[digest.kind]}</span>
              </p>
              <p className="text-muted-foreground flex flex-wrap gap-x-2">
                <HeadFacts head={digest} />
              </p>
              {pullStatusOf !== undefined && onPull !== undefined && (
                <PullControl status={pullStatusOf(digest.seq)} onPull={() => onPull(digest.seq)} />
              )}
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

const Timeline = memo(function Timeline({
  state,
  locate,
  reveal,
  onRevealed,
  puller,
  pull,
}: {
  state: ConversationState;
  locate: PanelBodyProps['locate'];
  reveal: TurnReveal | undefined;
  onRevealed: (nonce: number) => void;
  /** 按需拉細節（#1083）；沒給就只有推送的那幾輪。 */
  puller: TrajectoryPuller | undefined;
  pull: PullSnapshot | undefined;
}) {
  const pulled = pull?.turns;
  const model = useMemo(() => traceModel(state, pulled), [state, pulled]);
  const names = useStableNames(state.entries);
  const [missing, setMissing] = useState<string | undefined>(undefined);
  const [announced, setAnnounced] = useState('');
  // 找不到那一輪時，畫面上也要說（`announced` 只給讀屏）：不然看得見的人只看到側邊欄打開、什麼都沒標示。
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [shown, setShown] = useState(TURN_PAGE);
  const [revealedSeq, setRevealedSeq] = useState<number | undefined>(undefined);
  const [readyTurn, setReadyTurn] = useState<number | undefined>(undefined);
  // 「看這一輪」落在只有摘要的輪、或回覆歸不進軌跡時，先把那一輪的細節拉回來再定位（#1083）：`loading` 期間不下結論，
  // `settled` 之後照拉不到的老辦法講；失敗的原因記在這裡，給標示用。
  const [pullNote, setPullNote] = useState<
    | {
        readonly nonce: number;
        readonly phase: 'loading' | 'settled';
        readonly failure?: string;
      }
    | undefined
  >(undefined);
  const section = useRef<HTMLElement>(null);
  // 回覆底下的「這一輪的過程」給的是訊息 id：先換成那一輪的 `seq`，換不出來（歸不進軌跡的輪）就講明白。
  const target = useMemo(() => {
    if (reveal === undefined) return undefined;
    if (reveal.seq !== undefined) return { nonce: reveal.nonce, seq: reveal.seq };
    const seq = turnSeqOfMessage(model, state.entries, reveal.messageId);
    return seq === undefined ? 'unplaced' : { nonce: reveal.nonce, seq };
  }, [reveal, model, state.entries]);
  const placed = target === undefined || target === 'unplaced' ? undefined : target;
  const revealIn =
    target === undefined
      ? undefined
      : target === 'unplaced'
        ? ('unplaced' as const)
        : model.turns.some((turn) => turn.seq === target.seq)
          ? ('turns' as const)
          : model.digests.some((digest) => digest.seq === target.seq)
            ? ('digests' as const)
            : ('missing' as const);
  const pullAnchor =
    puller === undefined || reveal === undefined || !model.structured
      ? undefined
      : revealIn === 'digests' && placed !== undefined
        ? { seq: placed.seq }
        : revealIn === 'unplaced' && reveal.messageId !== undefined
          ? { messageId: reveal.messageId }
          : undefined;
  const pullHold =
    pullAnchor !== undefined &&
    reveal !== undefined &&
    !(pullNote?.nonce === reveal.nonce && pullNote.phase === 'settled');
  useEffect(() => {
    if (reveal === undefined || puller === undefined || pullAnchor === undefined) return;
    if (pullNote?.nonce === reveal.nonce) return;
    const { nonce } = reveal;
    setPullNote({ nonce, phase: 'loading' });
    void puller.pull(pullAnchor).then((outcome) => {
      setPullNote((current) =>
        current?.nonce === nonce
          ? {
              nonce,
              phase: 'settled',
              ...(outcome.ok || outcome.code === 'turn_not_found' || outcome.code === 'aborted'
                ? {}
                : { failure: outcome.message }),
            }
          : current,
      );
    });
  }, [reveal, puller, pullAnchor, pullNote]);
  // 「看這一輪」（#1034）：第一段只動狀態——展開到那一組那一頁、或交給摘要區塊自己展開；第二段在畫出來之後才找元素、捲過去、
  // 把焦點放在標題。`readyTurn` 讓兩段落在同一個 commit。1024 以下兩個分頁在同一個抽屜裡，不收抽屜。
  useEffect(() => {
    if (reveal === undefined) return;
    if (pullHold) {
      setAnnounced(TRACE_PULL_LOADING_TEXT);
      setNotice(TRACE_PULL_LOADING_TEXT);
      return;
    }
    const failure = pullNote?.nonce === reveal.nonce ? pullNote.failure : undefined;
    if (revealIn === 'digests') {
      // 摘要列自己會捲過去、標示（`Digests`）；拉失敗就在上面講原因，不是靜靜退回摘要。
      const text = failure === undefined ? undefined : `${TRACE_PULL_FAILED_TEXT}${failure}`;
      setNotice(text);
      if (text !== undefined) setAnnounced(text);
    } else if (revealIn === 'turns' && placed !== undefined) {
      setNotice(undefined);
      const at = model.turns.findIndex((turn) => turn.seq === placed.seq);
      setShown((count) => Math.max(count, model.turns.length - at));
      setReadyTurn(reveal.nonce);
    } else if (revealIn === 'missing' || revealIn === 'unplaced') {
      const base =
        revealIn === 'missing'
          ? TRACE_REVEAL_MISSING_TEXT
          : model.structured && (model.digests.length > 0 || model.omitted > 0)
            ? TRACE_REPLY_OLDER_TEXT
            : TRACE_REPLY_UNPLACED_TEXT;
      const text = failure === undefined ? base : `${base}（${TRACE_PULL_FAILED_TEXT}${failure}）`;
      setAnnounced(text);
      setNotice(text);
      // 說明在最上面；面板可能停在很下面，捲回去才看得到。
      if (section.current !== null) section.current.scrollTop = 0;
      onRevealed(reveal.nonce);
    }
  }, [reveal, revealIn, placed, model, onRevealed, pullHold, pullNote]);
  useEffect(() => {
    if (placed === undefined || readyTurn !== placed.nonce) return;
    const group = section.current?.querySelector<HTMLElement>(`section[data-seq="${placed.seq}"]`);
    if (group === null || group === undefined) return;
    group.scrollIntoView({ block: 'start' });
    group.querySelector<HTMLElement>('[data-reveal-target]')?.focus({ preventScroll: true });
    setRevealedSeq(placed.seq);
    setAnnounced(TRACE_REVEALED_TEXT);
    onRevealed(placed.nonce);
  }, [placed, readyTurn, shown, onRevealed]);
  const onDigestRevealed = useCallback(
    (nonce: number) => {
      if (placed !== undefined) setRevealedSeq(placed.seq);
      setAnnounced(TRACE_REVEALED_TEXT);
      onRevealed(nonce);
    },
    [placed, onRevealed],
  );
  // 標示只亮一下。
  useEffect(() => {
    if (revealedSeq === undefined) return;
    const timer = setTimeout(() => setRevealedSeq(undefined), REVEAL_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [revealedSeq]);
  const onLocate = useCallback(
    (row: TraceRow) => {
      if (row.target === undefined) return;
      const found = locate(row.target);
      setMissing(found ? undefined : row.key);
      setAnnounced(found ? TRACE_LOCATED_TEXT : '');
    },
    [locate],
  );
  const onPull = useMemo(
    () =>
      puller === undefined
        ? undefined
        : (seq: number) => {
            void puller.pull({ seq });
          },
    [puller],
  );
  const statusFor = useMemo(
    () =>
      pull === undefined || puller === undefined ? undefined : (seq: number) => statusOf(pull, seq),
    [pull, puller],
  );
  const hiddenTurns = Math.max(0, model.turns.length - shown);
  const turns = hiddenTurns === 0 ? model.turns : model.turns.slice(hiddenTurns);
  return (
    <section
      ref={section}
      aria-label="對話的過程"
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      data-testid="right-sidebar-panel-trace"
      // 可捲動的區塊要能用鍵盤捲：進 Tab 順序（同計劃分頁，§8）。
      tabIndex={0}
    >
      <p className="text-muted-foreground mb-3 px-2 text-xs" data-testid="trace-headline">
        {model.structured ? TRACE_STRUCTURED_HEADLINE : TRACE_HEADLINE}
      </p>
      {notice !== undefined && (
        <p
          // 讀屏已經從下面的 `role=status` 聽到同一句，這裡只給看得見的人。
          aria-hidden
          className="bg-chip mb-3 rounded-md px-3 py-2 text-xs"
          data-testid="trace-reveal-notice"
        >
          {notice}
        </p>
      )}
      {model.structured && (model.digests.length > 0 || model.omitted > 0) && (
        <Digests
          digests={model.digests}
          omitted={model.omitted}
          reveal={revealIn === 'digests' && !pullHold ? placed : undefined}
          statusOf={statusFor}
          onPull={onPull}
          revealedSeq={revealedSeq}
          onRevealed={onDigestRevealed}
        />
      )}
      {hiddenTurns > 0 && (
        <Button
          type="button"
          variant="ghost"
          className="mb-3 min-h-11 w-full text-xs lg:min-h-9"
          data-testid="trace-more-turns"
          onClick={() => setShown((count) => count + TURN_PAGE)}
        >
          {TRACE_MORE_TURNS_LABEL}（還有 {hiddenTurns} 組）
        </Button>
      )}
      {turns.map((turn) => (
        <TurnGroup
          key={turn.key}
          turn={turn}
          structured={model.structured}
          names={names}
          missing={missing}
          revealed={turn.seq !== undefined && turn.seq === revealedSeq}
          onLocate={onLocate}
          pullStatus={
            turn.summaryOnly === true && turn.seq !== undefined ? statusFor?.(turn.seq) : undefined
          }
          onPull={onPull}
        />
      ))}
      <Limits structured={model.structured} />
      <p role="status" className="sr-only">
        {announced}
      </p>
    </section>
  );
});

export function TraceBody({ visible, sources, locate, reveal, onRevealed }: PanelBodyProps) {
  const state = useVisibleSnapshot(sources.conversation, visible);
  const pull = useVisibleSnapshot(sources.trajectoryPull, visible);
  useTrajectoryPull(sources.trajectoryPull, state, visible);
  // 條目是空的、但軌跡投影已經有輪（內文沒載入）時照樣畫結構，不寫「尚無資料」。
  const empty =
    state === undefined ||
    (state.entries.length === 0 &&
      (trajectoryOf(state)?.turns.length ?? 0) + (trajectoryOf(state)?.digests.length ?? 0) === 0);
  if (empty) {
    return (
      <p
        className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm"
        data-testid="right-sidebar-panel-trace"
      >
        {TRACE_EMPTY_TEXT}
      </p>
    );
  }
  return (
    <Timeline
      state={state}
      locate={locate}
      // 看不見時不消費：分頁選中之後才會有最新的快照可找。
      reveal={visible ? reveal : undefined}
      onRevealed={onRevealed ?? noop}
      puller={sources.trajectoryPull}
      pull={pull}
    />
  );
}
