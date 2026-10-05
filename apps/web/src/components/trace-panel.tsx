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
} from '@/lib/trace-view';
import type { TraceDigest, TraceRow, TraceTurn, TurnHead } from '@/lib/trace-view';
import {
  ABSENT,
  SIGNAL_LABEL,
  TURN_END_LABEL,
  TURN_KIND_LABEL,
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
      {outcome !== undefined && (
        <span className="bg-chip rounded-full px-2 py-0.5" data-testid="trace-plan-outcome">
          {PLAN_OUTCOME_LABEL[outcome]}
        </span>
      )}
    </>
  );
}

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

function TurnGroup({
  turn,
  structured,
  names,
  missing,
  revealed,
  onLocate,
}: {
  turn: TraceTurn;
  structured: boolean;
  names: ReadonlyMap<string, string>;
  missing: string | undefined;
  /** 剛被成本分頁指到的那一組：畫一圈標示。 */
  revealed: boolean;
  onLocate: (row: TraceRow) => void;
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
}: {
  digests: readonly TraceDigest[];
  omitted: number;
  /** 要顯示的是這裡面的某一輪：展開區塊、展開到那一輪那一頁，再捲過去。 */
  reveal: TurnReveal | undefined;
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
}: {
  state: ConversationState;
  locate: PanelBodyProps['locate'];
  reveal: TurnReveal | undefined;
  onRevealed: (nonce: number) => void;
}) {
  const model = useMemo(() => traceModel(state), [state]);
  const names = useStableNames(state.entries);
  const [missing, setMissing] = useState<string | undefined>(undefined);
  const [announced, setAnnounced] = useState('');
  const [shown, setShown] = useState(TURN_PAGE);
  const [revealedSeq, setRevealedSeq] = useState<number | undefined>(undefined);
  const [readyTurn, setReadyTurn] = useState<number | undefined>(undefined);
  const section = useRef<HTMLElement>(null);
  const revealIn =
    reveal === undefined
      ? undefined
      : model.turns.some((turn) => turn.seq === reveal.seq)
        ? ('turns' as const)
        : model.digests.some((digest) => digest.seq === reveal.seq)
          ? ('digests' as const)
          : ('missing' as const);
  // 「看這一輪」（#1034）：第一段只動狀態——展開到那一組那一頁、或交給摘要區塊自己展開；第二段在畫出來之後才找元素、捲過去、
  // 把焦點放在標題。`readyTurn` 讓兩段落在同一個 commit。1024 以下兩個分頁在同一個抽屜裡，不收抽屜。
  useEffect(() => {
    if (reveal === undefined) return;
    if (revealIn === 'turns') {
      const at = model.turns.findIndex((turn) => turn.seq === reveal.seq);
      setShown((count) => Math.max(count, model.turns.length - at));
      setReadyTurn(reveal.nonce);
    } else if (revealIn === 'missing') {
      setAnnounced(TRACE_REVEAL_MISSING_TEXT);
      onRevealed(reveal.nonce);
    }
  }, [reveal, revealIn, model, onRevealed]);
  useEffect(() => {
    if (reveal === undefined || readyTurn !== reveal.nonce) return;
    const group = section.current?.querySelector<HTMLElement>(`section[data-seq="${reveal.seq}"]`);
    if (group === null || group === undefined) return;
    group.scrollIntoView({ block: 'start' });
    group.querySelector<HTMLElement>('[data-reveal-target]')?.focus({ preventScroll: true });
    setRevealedSeq(reveal.seq);
    setAnnounced(TRACE_REVEALED_TEXT);
    onRevealed(reveal.nonce);
  }, [reveal, readyTurn, shown, onRevealed]);
  const onDigestRevealed = useCallback(
    (nonce: number) => {
      if (reveal !== undefined) setRevealedSeq(reveal.seq);
      setAnnounced(TRACE_REVEALED_TEXT);
      onRevealed(nonce);
    },
    [reveal, onRevealed],
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
      {model.structured && (model.digests.length > 0 || model.omitted > 0) && (
        <Digests
          digests={model.digests}
          omitted={model.omitted}
          reveal={revealIn === 'digests' ? reveal : undefined}
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
    />
  );
}
