/**
 * 右側欄的「成本」分頁（[#1032](https://github.com/DemianLi/nexus-agent/issues/1032)，殼與入口在 #1031、決定在
 * [#1017](https://github.com/DemianLi/nexus-agent/issues/1017)、範圍在 [#1019](https://github.com/DemianLi/nexus-agent/issues/1019)；
 * 第 1 版在 [#1034](https://github.com/DemianLi/nexus-agent/issues/1034)）：這條對話累計燒了多少、每一輪各燒了多少、
 * 現在離自動摘要多遠，加上子代理各自的用量。投影與口徑在 `lib/token-meter-view.ts`（第 1 版）與 `lib/cost-view.ts`（第 0 版），這裡只畫。
 *
 * **有用量投影時**（#1028，`projections['token-meter']`）整個畫面改走 {@link StructuredCost}：
 * - **數字只有一個來源**：累計、逐輪、子代理全部取自投影，不再混 `sessionStats`（它的 `llmMs` 沒扣重試退避，兩個來源會差一截）。
 *   累計之外畫「更早合併的」「逐輪」「不在任何輪裡的」三段，加起來就是累計。
 * - **每個數字附口徑**：每一格帶 `data-field`，底下一個摺起來的「每個數字的口徑」逐項列出 `TOKEN_METER_CALIBER` 的句子；沒報用量的呼叫
 *   讓 token 標「下限」，殘差為負照實寫。
 * - **子代理含前景**：從 root 的 `links` 接回 `subagentProjections[runId]`，投影還沒到寫「還沒有資料」；不呼叫 `subagentHistory`。
 * - **「在觀測分頁看這一輪」**：呼叫右側欄的 `revealTurn(seq)`，`seq` 是 `TokenMeterTurn.seq`（等於觀測分頁那一組的 `turn-<seq>`）；
 *   觀測分頁已經沒有那一輪的資料時鈕停用並講原因。
 * - 列只放原始值（`CostTurnRow`），`memo` 才擋得住投影每顆事件整份重送。
 *
 * **沒有用量投影時**（舊伺服器、插件關了、拋過、版本不認得）整個退回第 0 版：
 * - **數字來自總帳，不是從畫面加的**：主對話讀 `tokenUsage`／`sessionStats`／`contextPressure`；背景子代理每個 `runId` 一列，
 *   數字取自 `subagentHistory` 那一頁的兩顆總帳（`lib/subagent-usage.ts`）。
 * - **只在看得見時訂閱與讀取**：主對話走 `useVisibleSnapshot`、子代理走 `useSubagentUsages`，分頁藏起來時串流的逐字片段不重算、
 *   也不發請求。內容那一層 `memo`：看得見時逐字片段會讓這裡重新取快照，但總帳的身分只在值變了才換，所以表不重畫。
 * - **口徑全部寫在畫面上**（`COST_LIMITS`），版型沿用用量鈕的 `Rows`（`dl` 兩欄、`tabular-nums`），不畫圖表。
 *
 * 375／768 單欄，觸控目標 44px（`min-h-11`）。
 */

import type {
  ConversationState,
  TokenMeterView,
  WireContextPressure,
  WireSessionStats,
  WireTokenUsage,
} from '@nexus/wire';
import { LocateFixed, RefreshCw } from 'lucide-react';
import { memo } from 'react';

import { Chevron } from '@/components/chevron';
import { RowTrigger } from '@/components/row-trigger';
import { useRightSidebar } from '@/components/sidebar/right-sidebar-context';
import type { PanelBodyProps } from '@/lib/right-sidebar-api';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible';
import { Rows } from '@/components/cost/usage-rows';
import { useStableNames } from '@/hooks/use-stable-names';
import { useSubagentUsages } from '@/hooks/use-subagent-usages';
import type { SubagentUsageSlot } from '@/hooks/use-subagent-usages';
import { useVisibleSnapshot } from '@/hooks/use-visible-snapshot';
import {
  COST_HEADLINE,
  costLimits,
  COST_LIMITS_HEADING,
  compactionCount,
  contextRows,
  usageSections,
} from '@/lib/cost-view';
import type { SubagentUsageLoader } from '@/lib/subagent-usage';
import { subagentLabel } from '@/lib/subagent-view';
import {
  COST_STRUCTURED_HEADLINE,
  COST_STRUCTURED_LIMITS,
  caliberOf,
  costSubagents,
  costTurnRows,
  distributionRows,
  revealableSeqs,
  sameTurnRow,
  spanRows,
  subagentTitles,
  tokenMeterOf,
  tokensWithSubagents,
} from '@/lib/token-meter-view';
import type { CostSubagent, CostTurnRow, FieldRow } from '@/lib/token-meter-view';
import { exactTokens } from '@/lib/session-usage-view';

export const COST_EMPTY_TEXT = '尚無資料';
export const COST_RELOAD_LABEL = '重新讀取';
export const COST_NO_USAGE = '還沒有用量';
export const COST_SUBAGENT_LOADING = '讀取中…';
export const COST_REVEAL_LABEL = '在觀測分頁看這一輪';
export const COST_REVEAL_GONE_TEXT = '觀測分頁已經沒有這一輪的資料';
export const COST_SUBAGENT_PENDING = '還沒有資料';

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-1.5 px-2 py-3" data-testid={testId} aria-label={title}>
      <h3 className="text-muted-foreground text-tip font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Totals({
  tokenUsage,
  sessionStats,
}: {
  tokenUsage: WireTokenUsage | null;
  sessionStats: WireSessionStats | null;
}) {
  const { tokens, stats } = usageSections(tokenUsage, sessionStats);
  if (tokens === undefined && stats === undefined) {
    return <p className="text-muted-foreground text-body">{COST_NO_USAGE}</p>;
  }
  return (
    <div className="space-y-2 text-body">
      {tokens !== undefined && <Rows rows={tokens} />}
      {stats !== undefined && <Rows rows={stats} />}
    </div>
  );
}

function SubagentRow({
  runId,
  label,
  slot,
}: {
  runId: string;
  label: string;
  slot: SubagentUsageSlot | undefined;
}) {
  return (
    <li className="space-y-1.5 py-2" data-testid="cost-subagent" data-run-id={runId}>
      <p className="text-body font-medium">
        {label}
        <span className="text-muted-foreground ml-2 text-tip font-normal">{runId}</span>
      </p>
      {slot?.error !== undefined ? (
        <p className="text-destructive text-body" data-testid="cost-subagent-error">
          讀不回來：{slot.error}
        </p>
      ) : slot?.usage !== undefined ? (
        <Totals tokenUsage={slot.usage.tokenUsage} sessionStats={slot.usage.sessionStats} />
      ) : (
        <p className="text-muted-foreground text-body">{COST_SUBAGENT_LOADING}</p>
      )}
    </li>
  );
}

function Subagents({
  names,
  load,
  visible,
}: {
  names: ReadonlyMap<string, string>;
  load: SubagentUsageLoader;
  visible: boolean;
}) {
  const runIds = [...names.keys()];
  const { slots, reload } = useSubagentUsages(load, runIds, visible);
  const loading = [...slots.values()].some((slot) => slot.loading);
  return (
    <Section title="背景子代理" testId="cost-subagents">
      {runIds.length === 0 ? (
        <p className="text-muted-foreground text-body">這條對話裡還沒有派出背景子代理</p>
      ) : (
        <>
          <ul className="divide-border divide-y">
            {runIds.map((runId) => (
              <SubagentRow
                key={runId}
                runId={runId}
                label={subagentLabel(names, runId)}
                slot={slots.get(runId)}
              />
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            className="h-11 w-full lg:h-9"
            data-testid="cost-subagent-reload"
            disabled={loading}
            onClick={reload}
          >
            <RefreshCw aria-hidden />
            {COST_RELOAD_LABEL}
          </Button>
          <p role="status" className="sr-only">
            {loading ? COST_SUBAGENT_LOADING : ''}
          </p>
        </>
      )}
    </Section>
  );
}

function Limits({ tokenUsage }: { tokenUsage: WireTokenUsage | null }) {
  return (
    <section aria-labelledby="cost-limits" className="text-muted-foreground mt-2 px-2 text-tip">
      <h3 id="cost-limits" className="mb-1 font-medium">
        {COST_LIMITS_HEADING}
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="cost-limits">
        {Object.entries(costLimits(tokenUsage)).map(([key, text]) => (
          <li key={key} data-limit={key}>
            {text}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 兩欄清單，每一格帶 `data-field`（口徑表的鍵）：每個數字都找得到它的口徑句。 */
function FieldRows({ rows }: { rows: readonly FieldRow[] }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 tabular-nums">
      {rows.map(([field, label, value]) => (
        <div key={field} className="contents" data-field={field}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-right">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const NO_REVEAL = () => {};

const TurnCard = memo(
  function TurnCard({ row }: { row: CostTurnRow }) {
    const sidebar = useRightSidebar();
    const reveal = sidebar?.revealTurn ?? NO_REVEAL;
    const describedBy = `cost-turn-gone-${row.seq}`;
    return (
      <li className="space-y-1.5 py-3" data-testid="cost-turn" data-seq={row.seq}>
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h4 className="text-body font-medium">第 {row.number} 輪</h4>
          <span className="text-muted-foreground text-tip">{row.kindLabel}</span>
        </div>
        <p className="text-muted-foreground flex flex-wrap gap-x-2 text-tip">
          <span>{row.time}</span>
          <span>耗時 {row.wall}</span>
          <span>{row.endLabel}</span>
        </p>
        <div className="text-body">
          <FieldRows rows={row.fields} />
        </div>
        {sidebar !== undefined && (
          <>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full lg:min-h-9"
              data-testid="cost-turn-reveal"
              disabled={!row.revealable}
              aria-describedby={row.revealable ? undefined : describedBy}
              onClick={() => reveal(row.seq)}
            >
              <LocateFixed aria-hidden />
              {COST_REVEAL_LABEL}
            </Button>
            {!row.revealable && (
              <p id={describedBy} className="text-muted-foreground text-tip">
                {COST_REVEAL_GONE_TEXT}
              </p>
            )}
          </>
        )}
      </li>
    );
  },
  (a, b) => sameTurnRow(a.row, b.row),
);

function Distributions({ meter }: { meter: TokenMeterView }) {
  const { models, tools } = distributionRows(meter.session);
  if (models.length === 0 && tools.length === 0) return null;
  return (
    <Collapsible data-testid="cost-distributions">
      <RowTrigger fit="bare" className="text-muted-foreground justify-between text-tip lg:min-h-9">
        依模型、依工具
        <Chevron />
      </RowTrigger>
      <CollapsibleContent className="space-y-2 px-2 pb-2 text-body">
        {models.length > 0 && <Rows rows={models} />}
        {tools.length > 0 && <Rows rows={tools} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function SubagentCard({ subagent, label }: { subagent: CostSubagent; label: string }) {
  const { runId, mode, turn, view } = subagent;
  return (
    <li
      className="space-y-1.5 py-2"
      data-testid="cost-subagent"
      data-run-id={runId}
      data-mode={mode}
    >
      <p className="text-body font-medium">
        {label}
        <span className="text-muted-foreground ml-2 text-tip font-normal">
          {mode === 'one-shot' ? '前景' : '背景'}
          {turn !== undefined && `・第 ${turn + 1} 輪派出`}
        </span>
      </p>
      {view === undefined ? (
        <p className="text-muted-foreground text-body" data-testid="cost-subagent-pending">
          {COST_SUBAGENT_PENDING}
        </p>
      ) : (
        <div className="text-body">
          <FieldRows rows={spanRows(view.session)} />
        </div>
      )}
      {mode === 'one-shot' && (
        <p className="text-muted-foreground text-tip">
          前景子代理跑的時間已經在派它的那顆工具的耗時裡，不要和主對話的時間相加。
        </p>
      )}
    </li>
  );
}

function Calibers({ rows }: { rows: readonly FieldRow[] }) {
  const fields = new Map<string, string>();
  for (const [field, label] of rows) if (!fields.has(field)) fields.set(field, label);
  return (
    <Collapsible data-testid="cost-calibers" className="mt-2">
      <RowTrigger
        fit="bare"
        className="text-muted-foreground justify-between text-tip font-medium lg:min-h-9"
      >
        每個數字的口徑（{fields.size} 項）
        <Chevron />
      </RowTrigger>
      <CollapsibleContent className="px-2">
        <ul className="text-muted-foreground flex list-disc flex-col gap-1 pb-2 pl-4 text-tip">
          {[...fields].map(([field, label]) => (
            <li key={field} data-caliber={field}>
              <span className="text-foreground">{label}</span>：{caliberOf(field) ?? ''}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function StructuredLimits() {
  return (
    <section aria-labelledby="cost-limits" className="text-muted-foreground mt-2 px-2 text-tip">
      <h3 id="cost-limits" className="mb-1 font-medium">
        {COST_LIMITS_HEADING}
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="cost-limits">
        {Object.entries(COST_STRUCTURED_LIMITS).map(([key, text]) => (
          <li key={key} data-limit={key}>
            {text}
          </li>
        ))}
      </ul>
    </section>
  );
}

interface StructuredCostProps {
  meter: TokenMeterView;
  turns: readonly CostTurnRow[];
  subagents: readonly CostSubagent[];
  titles: ReadonlyMap<string, string>;
  compactions: number;
  contextPressure: WireContextPressure | null;
}

/** 有用量投影：累計、逐輪、子代理全部取自投影，不再混 `sessionStats`（口徑不同，見 `lib/token-meter-view.ts`）。 */
function StructuredCost({
  meter,
  turns,
  subagents,
  titles,
  compactions,
  contextPressure,
}: StructuredCostProps) {
  const context = contextRows(contextPressure);
  const total = spanRows(meter.session);
  const withSubagents = subagents.length > 0 ? tokensWithSubagents(meter, subagents) : undefined;
  const hasOutside = meter.outside.steps > 0 || meter.outside.toolCalls > 0;
  const allRows: readonly FieldRow[] = [
    ...total,
    ...(withSubagents === undefined ? [] : [['subagentTokens', '含子代理的 token', ''] as const]),
    ...turns.flatMap((row) => row.fields),
    ...(meter.earlier === undefined ? [] : spanRows(meter.earlier)),
  ];
  const empty = meter.session.steps === 0 && meter.session.toolCalls === 0;
  return (
    <section
      aria-label="這條對話的成本"
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      data-testid="right-sidebar-panel-cost"
      data-structured=""
      tabIndex={0}
    >
      <p className="text-muted-foreground mb-1 px-2 text-tip" data-testid="cost-headline">
        {COST_STRUCTURED_HEADLINE}
      </p>
      <Section title="這條對話累計" testId="cost-totals">
        {empty ? (
          <p className="text-muted-foreground text-body">{COST_NO_USAGE}</p>
        ) : (
          <div className="space-y-2 text-body">
            <FieldRows rows={total} />
            {withSubagents !== undefined && (
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 tabular-nums">
                <div className="contents" data-field="subagentTokens">
                  <dt className="text-muted-foreground">含子代理的 token</dt>
                  <dd className="text-right">
                    {exactTokens(withSubagents.total)}
                    {withSubagents.complete ? '' : '（下限）'}
                  </dd>
                </div>
              </dl>
            )}
          </div>
        )}
      </Section>
      <Distributions meter={meter} />
      {context !== undefined && (
        <Section title="目前的 context" testId="cost-context">
          <div className="text-body">
            <Rows rows={context} />
          </div>
        </Section>
      )}
      <Section title="壓縮" testId="cost-compactions">
        <div className="text-body">
          <Rows rows={[['已載入的壓縮次數', `${compactions} 次`]]} />
        </div>
      </Section>
      <Section title="逐輪" testId="cost-turns">
        {meter.earlier !== undefined && (
          <div className="space-y-1.5 pb-2 text-body" data-testid="cost-earlier">
            <p className="text-muted-foreground text-tip">
              更早的 {meter.earlier.turns} 輪合計（沒有逐輪的列）
            </p>
            <FieldRows rows={spanRows(meter.earlier)} />
          </div>
        )}
        {turns.length === 0 && meter.earlier === undefined ? (
          <p className="text-muted-foreground text-body">還沒有開過輪</p>
        ) : (
          <ol className="divide-border divide-y">
            {turns.map((row) => (
              <TurnCard key={row.key} row={row} />
            ))}
          </ol>
        )}
        {hasOutside && (
          <div className="space-y-1.5 pt-2 text-body" data-testid="cost-outside">
            <p className="text-muted-foreground text-tip">不在任何一輪裡的用量</p>
            <FieldRows rows={spanRows(meter.outside)} />
          </div>
        )}
      </Section>
      <Section title="子代理" testId="cost-subagents">
        {subagents.length === 0 ? (
          <p className="text-muted-foreground text-body">這條對話裡還沒有派出子代理</p>
        ) : (
          <ul className="divide-border divide-y">
            {subagents.map((subagent) => (
              <SubagentCard
                key={subagent.runId}
                subagent={subagent}
                label={titles.get(subagent.runId) ?? subagent.runId}
              />
            ))}
          </ul>
        )}
        {meter.linksOmitted > 0 && (
          <p className="text-muted-foreground text-tip" data-testid="cost-links-omitted">
            更早派出的 {meter.linksOmitted} 個子代理沒有逐個列出，含子代理的 token 因此是下限。
          </p>
        )}
      </Section>
      <Calibers rows={allRows} />
      <StructuredLimits />
    </section>
  );
}

interface CostViewProps {
  tokenUsage: WireTokenUsage | null;
  sessionStats: WireSessionStats | null;
  contextPressure: WireContextPressure | null;
  compactions: number;
  names: ReadonlyMap<string, string>;
  loadSubagentUsage: SubagentUsageLoader | undefined;
  visible: boolean;
}

const CostView = memo(function CostView({
  tokenUsage,
  sessionStats,
  contextPressure,
  compactions,
  names,
  loadSubagentUsage,
  visible,
}: CostViewProps) {
  const context = contextRows(contextPressure);
  return (
    <section
      aria-label="這條對話的成本"
      className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      data-testid="right-sidebar-panel-cost"
      // 可捲動的區塊要能用鍵盤捲：進 Tab 順序（同觀測與計劃分頁，§8）。
      tabIndex={0}
    >
      <p className="text-muted-foreground mb-1 px-2 text-tip" data-testid="cost-headline">
        {COST_HEADLINE}
      </p>
      <Section title="這條對話累計" testId="cost-totals">
        <Totals tokenUsage={tokenUsage} sessionStats={sessionStats} />
      </Section>
      {context !== undefined && (
        <Section title="目前的 context" testId="cost-context">
          <div className="text-body">
            <Rows rows={context} />
          </div>
        </Section>
      )}
      <Section title="壓縮" testId="cost-compactions">
        <div className="text-body">
          <Rows rows={[['已載入的壓縮次數', `${compactions} 次`]]} />
        </div>
      </Section>
      {loadSubagentUsage !== undefined && (
        <Subagents names={names} load={loadSubagentUsage} visible={visible} />
      )}
      <Limits tokenUsage={tokenUsage} />
    </section>
  );
});

/** 有用量投影時的內容：把投影整理成只含原始值的列，再交給 `StructuredCost`。 */
function StructuredBody({
  state,
  meter,
  names,
}: {
  state: ConversationState;
  meter: TokenMeterView;
  names: ReadonlyMap<string, string>;
}) {
  const turns = costTurnRows(meter, revealableSeqs(state));
  const subagents = costSubagents(state, meter);
  const titles = subagentTitles(state.entries, subagents, names);
  return (
    <StructuredCost
      meter={meter}
      turns={turns}
      subagents={subagents}
      titles={titles}
      compactions={compactionCount(state.entries)}
      contextPressure={state.contextPressure}
    />
  );
}

export function CostBody({ visible, sources }: PanelBodyProps) {
  const state = useVisibleSnapshot(sources.conversation, visible);
  const names = useStableNames(state?.entries ?? NO_ENTRIES);
  if (state === undefined) {
    return (
      <p
        className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-body"
        data-testid="right-sidebar-panel-cost"
      >
        {COST_EMPTY_TEXT}
      </p>
    );
  }
  const meter = tokenMeterOf(state.projections);
  if (meter !== undefined) return <StructuredBody state={state} meter={meter} names={names} />;
  return (
    <CostView
      tokenUsage={state.tokenUsage}
      sessionStats={state.sessionStats}
      contextPressure={state.contextPressure}
      compactions={compactionCount(state.entries)}
      names={names}
      loadSubagentUsage={sources.subagentUsage}
      visible={visible}
    />
  );
}

const NO_ENTRIES: never[] = [];
