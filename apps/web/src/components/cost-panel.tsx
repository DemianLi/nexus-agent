/**
 * 右側欄的「成本」分頁（[#1032](https://github.com/DemianLi/nexus-agent/issues/1032)，殼與入口在 #1031、決定在
 * [#1017](https://github.com/DemianLi/nexus-agent/issues/1017)、範圍在 [#1019](https://github.com/DemianLi/nexus-agent/issues/1019)）：
 * 這條對話累計燒了多少、現在離自動摘要多遠，加上背景子代理各自的用量。投影與口徑在 `lib/cost-view.ts`，這裡只畫。
 *
 * - **數字來自總帳，不是從畫面加的**：主對話讀 `tokenUsage`／`sessionStats`／`contextPressure`；背景子代理每個 `runId` 一列，
 *   數字取自 `subagentHistory` 那一頁的兩顆總帳（`lib/subagent-usage.ts`）。
 * - **只在看得見時訂閱與讀取**：主對話走 `useVisibleSnapshot`、子代理走 `useSubagentUsages`，分頁藏起來時串流的逐字片段不重算、
 *   也不發請求。內容那一層 `memo`：看得見時逐字片段會讓這裡重新取快照，但總帳的身分只在值變了才換，所以表不重畫。
 * - **口徑全部寫在畫面上**（`COST_LIMITS`），版型沿用用量鈕的 `Rows`（`dl` 兩欄、`tabular-nums`），第 0 版不畫圖表。
 * - 375／768 單欄，觸控目標 44px（`min-h-11`）。
 */

import type { WireContextPressure, WireSessionStats, WireTokenUsage } from '@nexus/wire';
import { RefreshCw } from 'lucide-react';
import { memo } from 'react';

import type { PanelBodyProps } from '@/components/right-sidebar-panels';
import { Button } from '@/components/ui/button';
import { Rows } from '@/components/usage-rows';
import { useStableNames } from '@/hooks/use-stable-names';
import { useSubagentUsages } from '@/hooks/use-subagent-usages';
import type { SubagentUsageSlot } from '@/hooks/use-subagent-usages';
import { useVisibleSnapshot } from '@/hooks/use-visible-snapshot';
import {
  COST_HEADLINE,
  COST_LIMITS,
  COST_LIMITS_HEADING,
  compactionCount,
  contextRows,
  usageSections,
} from '@/lib/cost-view';
import type { SubagentUsageLoader } from '@/lib/subagent-usage';
import { subagentLabel } from '@/lib/subagent-view';

export const COST_EMPTY_TEXT = '尚無資料';
export const COST_RELOAD_LABEL = '重新讀取';
export const COST_NO_USAGE = '還沒有用量';
export const COST_SUBAGENT_LOADING = '讀取中…';

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
      <h3 className="text-muted-foreground text-xs font-medium">{title}</h3>
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
    return <p className="text-muted-foreground text-sm">{COST_NO_USAGE}</p>;
  }
  return (
    <div className="space-y-2 text-sm">
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
      <p className="text-sm font-medium">
        {label}
        <span className="text-muted-foreground ml-2 text-xs font-normal">{runId}</span>
      </p>
      {slot?.error !== undefined ? (
        <p className="text-destructive text-sm" data-testid="cost-subagent-error">
          讀不回來：{slot.error}
        </p>
      ) : slot?.usage !== undefined ? (
        <Totals tokenUsage={slot.usage.tokenUsage} sessionStats={slot.usage.sessionStats} />
      ) : (
        <p className="text-muted-foreground text-sm">{COST_SUBAGENT_LOADING}</p>
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
        <p className="text-muted-foreground text-sm">這條對話裡還沒有派出背景子代理</p>
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

function Limits() {
  return (
    <section aria-labelledby="cost-limits" className="text-muted-foreground mt-2 px-2 text-xs">
      <h3 id="cost-limits" className="mb-1 font-medium">
        {COST_LIMITS_HEADING}
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-4" data-testid="cost-limits">
        {Object.entries(COST_LIMITS).map(([key, text]) => (
          <li key={key} data-limit={key}>
            {text}
          </li>
        ))}
      </ul>
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
      <p className="text-muted-foreground mb-1 px-2 text-xs" data-testid="cost-headline">
        {COST_HEADLINE}
      </p>
      <Section title="這條對話累計" testId="cost-totals">
        <Totals tokenUsage={tokenUsage} sessionStats={sessionStats} />
      </Section>
      {context !== undefined && (
        <Section title="目前的 context" testId="cost-context">
          <div className="text-sm">
            <Rows rows={context} />
          </div>
        </Section>
      )}
      <Section title="壓縮" testId="cost-compactions">
        <div className="text-sm">
          <Rows rows={[['已載入的壓縮次數', `${compactions} 次`]]} />
        </div>
      </Section>
      {loadSubagentUsage !== undefined && (
        <Subagents names={names} load={loadSubagentUsage} visible={visible} />
      )}
      <Limits />
    </section>
  );
});

export function CostBody({ visible, sources }: PanelBodyProps) {
  const state = useVisibleSnapshot(sources.conversation, visible);
  const names = useStableNames(state?.entries ?? NO_ENTRIES);
  if (state === undefined) {
    return (
      <p
        className="text-muted-foreground flex flex-1 items-center justify-center px-6 text-center text-sm"
        data-testid="right-sidebar-panel-cost"
      >
        {COST_EMPTY_TEXT}
      </p>
    );
  }
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
