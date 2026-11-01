/**
 * 派出子代理的那顆工具底下的「子代理的呼叫結構」（#1015 的驗收缺口）：推送的最新一輪直接畫，更早的輪與前景子代理
 * 展開時才向伺服器拉。一輪的呼叫收成 SG `StepGroup` 的一行計數，打開是 `StepList`，跟主對話的工具步驟同一套（#1690 T7）。
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import type { ConversationState, TrajectoryDigest, TrajectoryTurnKind } from '@nexus/wire';

import { CallRow } from '@/components/trace/call';
import { PullControl } from '@/components/trace/pull-control';
import { HeadFacts } from '@/components/trace/turn-head';
import { TOOL_STATUS_LABEL } from '@/components/tool/card';
import { StepGroup } from '@/components/ui/tool-steps';
import type { Step } from '@/components/ui/tool-steps';
import { useFocusHandoff } from '@/hooks/use-focus-handoff';
import { abortedToolLabel } from '@/lib/tool-aborted';
import { cutByParentClock, subagentDigestHead, subagentTurnView } from '@/lib/trace-view';
import type { SubagentCallView, SubagentTurnView } from '@/lib/trace-view';
import type { TrajectoryPuller } from '@/lib/trajectory-pull';
import {
  TURN_KIND_LABEL,
  clockText,
  durationText,
  failureReasonText,
  subagentSnapshotsOf,
  subagentTrajectoryOf,
} from '@/lib/trajectory-view';

/** 派出子代理的那顆工具底下的區塊（子代理自己的呼叫結構）。 */
export const SUBAGENT_CALLS_TITLE = '子代理的呼叫結構';
export const SUBAGENT_CALLS_NO_DATA_TEXT = '還沒有這個子代理的軌跡資料。';
export const SUBAGENT_CALLS_CONTENT_TEXT =
  '只有結構（時刻、耗時、token、重試、叫了哪些工具）；子代理自己的內文不在軌跡裡。';
/**
 * 子代理的一輪怎麼開始的：第一輪是派它的那段任務（不是「人的訊息」）。前景子代理（`run`）整段沒有輪的邊界，也沒有結束標記，
 * 所以不畫耗時與結束狀態——跑完與否看派它的那顆工具。
 */
export const SUBAGENT_TURN_LABEL = (kind: TrajectoryTurnKind): string =>
  kind === 'message' ? '交付的任務' : TURN_KIND_LABEL[kind];
export const SUBAGENT_CALLS_RELOAD_LABEL = '重新載入';
export const SUBAGENT_CALLS_NO_PULL_TEXT = '這個畫面不能按需載入細節。';

/** 子代理自己的軌跡從哪裡讀：`Timeline` 提供，只有展開的「子代理的呼叫結構」會訂（收著時沒有掛載、不付重畫的錢）。 */
export const SubagentSourceContext = createContext<
  { readonly state: ConversationState; readonly puller: TrajectoryPuller | undefined } | undefined
>(undefined);

/** 拉回來過的內容。`load` 每拉成一次加一：整塊換新，鈕跟著換，焦點才會照首次載入那樣交給標題。 */
type PulledTurns = { readonly turns: readonly SubagentTurnView[]; readonly load: number };

type ChildPull =
  | { readonly kind: 'loading'; readonly shown?: PulledTurns }
  | {
      readonly kind: 'failed';
      readonly code: string;
      readonly message: string;
      readonly shown?: PulledTurns;
    }
  | ({ readonly kind: 'loaded' } & PulledTurns);

const shownOf = (pull: ChildPull | undefined): PulledTurns | undefined =>
  pull?.kind === 'loaded' ? pull : pull?.shown;

type SubagentToolView = SubagentCallView['tools'][number];

function interruptedOf(tool: SubagentToolView): string | undefined {
  return tool.status === 'error' ? abortedToolLabel(tool.name, tool.code) : undefined;
}

function SubagentTool({ tool }: { tool: SubagentToolView }) {
  const interrupted = interruptedOf(tool);
  return (
    <li
      className="text-muted-foreground flex min-w-0 flex-wrap gap-x-2 text-tip"
      data-testid="trace-subagent-tool"
    >
      <code className="text-foreground font-mono">{tool.name}</code>
      <span
        className={
          tool.status === 'error' && interrupted === undefined ? 'text-destructive' : undefined
        }
      >
        {interrupted ??
          TOOL_STATUS_LABEL[
            tool.status === 'error' ? 'failed' : tool.status === 'ok' ? 'done' : 'running'
          ]}
      </span>
      {tool.code !== undefined && <code className="font-mono">{tool.code}</code>}
      <span>
        {clockText(tool.time)}
        {tool.durationMs !== undefined && ` · ${durationText(tool.durationMs)}`}
      </span>
    </li>
  );
}

/** 一輪收著那一行：呼叫與工具各幾個、幾個失敗，有工具還沒結束時再接「執行中」。純字串、會被報讀，所以用「，」接。 */
function subagentStepsSummary(calls: readonly SubagentCallView[]): string {
  const tools = calls.flatMap((call) => call.tools);
  const failed = tools.filter(
    (tool) => tool.status === 'error' && interruptedOf(tool) === undefined,
  ).length;
  const running = tools.some((tool) => tool.status !== 'ok' && tool.status !== 'error');
  return [
    `${calls.length} 次呼叫`,
    `${tools.length} 個工具${failed > 0 ? `（${failed} 個失敗）` : ''}`,
    ...(running ? ['執行中'] : []),
  ].join('，');
}

/** 一輪的步驟（每次呼叫一步、每個工具一步），只拿來判斷要不要包群組與是否執行中；畫出來的列是 children。 */
function stepsOf(calls: readonly SubagentCallView[]): Step[] {
  return calls.flatMap((call) => [
    { id: call.row.key, label: call.row.key, status: 'done' as const },
    ...call.tools.map((tool) => ({
      id: tool.key,
      label: tool.name,
      status:
        tool.status === 'error'
          ? ('error' as const)
          : tool.status === 'ok'
            ? ('done' as const)
            : ('running' as const),
    })),
  ]);
}

function SubagentCall({ call }: { call: SubagentCallView }) {
  return (
    <div data-testid="trace-subagent-call">
      <CallRow row={call.row} />
      {call.retries.map((retry) => (
        <p
          key={retry.key}
          className="text-muted-foreground px-2 pl-8 text-tip"
          data-testid="trace-subagent-retry"
        >
          重試 {retry.retry}/{retry.maxRetries} ·{' '}
          <span title={retry.code} data-failure-code={retry.code}>
            {failureReasonText(retry.code, retry.status)}
          </span>
          {retry.waitedMs !== undefined && ` · 等了 ${durationText(retry.waitedMs)}`}
        </p>
      ))}
      {call.tools.length > 0 && (
        <ul className="space-y-0.5 pb-1 pl-8">
          {call.tools.map((tool) => (
            <SubagentTool key={tool.key} tool={tool} />
          ))}
        </ul>
      )}
    </div>
  );
}

function SubagentTurn({ turn }: { turn: SubagentTurnView }) {
  const steps = stepsOf(turn.calls);
  // SG 的 `StepGroup` 在只有一步、而且沒在跑時直接畫 `steps[0]`、丟掉 children；這裡的列是 children，所以同樣的條件下自己不包群組。
  const grouped = steps.length > 1 || steps.some((step) => step.status === 'running');
  return (
    <section className="mb-2" data-testid="trace-subagent-turn" data-seq={turn.seq}>
      <p
        className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 px-2 text-tip outline-none"
        // 按「載入這一輪的細節」拉回來之後焦點交到這裡（#2009）；平常不在 Tab 順序裡。不用 `data-reveal-target`：
        // 「看這一輪」在主對話那一組裡找它，子代理的輪巢在組內，沒有標題的組會找到這一列。
        data-subagent-turn-head=""
        tabIndex={-1}
      >
        <span>{SUBAGENT_TURN_LABEL(turn.head.kind)}</span>
        <HeadFacts head={turn.head} noEnd={turn.head.kind === 'run'} />
      </p>
      {turn.elidedCalls !== undefined && (
        <p className="text-muted-foreground px-2 text-tip">
          更早的 {turn.elidedCalls} 次呼叫被單輪上限摺掉了，只留計數。
        </p>
      )}
      {grouped ? (
        <div className="px-2 pt-1">
          <StepGroup steps={steps} summary={subagentStepsSummary(turn.calls)} defaultOpen>
            {turn.calls.map((call) => (
              <SubagentCall key={call.row.key} call={call} />
            ))}
          </StepGroup>
        </div>
      ) : (
        turn.calls.map((call) => <SubagentCall key={call.row.key} call={call} />)
      )}
    </section>
  );
}

/**
 * 派出子代理的那顆工具底下：那個子代理自己的呼叫結構（#1015 的驗收缺口）。推送的最新一輪直接畫；更早的輪與前景子代理
 * （整段只有一份摘要）展開時才向伺服器拉（`fetchTurns({ runId, seq })`）。
 *
 * `parentCutByClock`：派它的那一輪（含續接段）被時鐘切斷；只影響前景子代理的呼叫列，見 {@link cutByParentClock}。
 */
export function SubagentCalls({
  runId,
  parentCutByClock = false,
}: {
  runId: string;
  parentCutByClock?: boolean;
}) {
  const source = useContext(SubagentSourceContext);
  const child = source === undefined ? undefined : subagentTrajectoryOf(source.state, runId);
  const snapshots = source === undefined ? undefined : subagentSnapshotsOf(source.state, runId);
  const puller = source?.puller;
  const [pulls, setPulls] = useState<ReadonlyMap<number, ChildPull>>(new Map());
  const aborts = useRef(new Set<AbortController>());
  useEffect(() => {
    const live = aborts.current;
    return () => {
      for (const abort of live) abort.abort();
    };
  }, []);

  const shownTurn = (turn: SubagentTurnView) => (parentCutByClock ? cutByParentClock(turn) : turn);

  // 拉完（#2009）：焦點在鈕上、鈕收掉了，就落在拉回來的第一輪的標題；這一區沒有輪就落在「重新載入」。
  const handoff = useFocusHandoff<number>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const seq = handoff.pending();
    if (seq === undefined || pulls.get(seq)?.kind === 'loading') return;
    const block = root.current?.querySelector<HTMLElement>(`[data-pulled-seq="${seq}"]`);
    handoff.land(
      block?.querySelector<HTMLElement>('[data-subagent-turn-head]') ??
        block?.querySelector<HTMLElement>('button'),
      { scroll: true },
    );
  }, [pulls, handoff]);
  const pullSeq = useCallback(
    (seq: number) => {
      if (puller === undefined) return;
      const abort = new AbortController();
      aborts.current.add(abort);
      setPulls((old) => {
        const shown = shownOf(old.get(seq));
        return new Map(old).set(seq, { kind: 'loading', ...(shown && { shown }) });
      });
      void puller.fetchTurns({ runId, seq }, abort.signal).then((outcome) => {
        aborts.current.delete(abort);
        if (abort.signal.aborted) return;
        setPulls((old) => {
          const shown = shownOf(old.get(seq));
          return new Map(old).set(
            seq,
            outcome.ok
              ? {
                  kind: 'loaded',
                  turns: outcome.turns.map((turn) => subagentTurnView(turn, snapshots)),
                  load: (shown?.load ?? 0) + 1,
                }
              : {
                  kind: 'failed',
                  code: outcome.code,
                  message: outcome.message,
                  ...(shown && { shown }),
                },
          );
        });
      });
    },
    // `snapshots` 只用來畫拉回來的那一輪；它每個 frame 都是新的，不該讓拉取的函式跟著換。
    [puller, runId],
  );

  // 前景子代理整段只有一份摘要、推送沒有逐呼叫結構：展開就拉，不讓人再多按一下。
  const only =
    child !== undefined && child.turns.length === 0 && child.digests.length === 1
      ? child.digests[0]
      : undefined;
  const onlySeq = only?.seq;
  useEffect(() => {
    if (onlySeq !== undefined) pullSeq(onlySeq);
  }, [onlySeq, pullSeq]);

  if (child === undefined) {
    return (
      <p className="text-muted-foreground px-2 text-tip" data-testid="trace-subagent-nodata">
        {SUBAGENT_CALLS_NO_DATA_TEXT}
      </p>
    );
  }
  // 摘要裡的續接輪併回它接著的那一輪：拉那一輪，連續接輪一起回來。
  const digests: TrajectoryDigest[] = [];
  child.digests.forEach((digest, i) => {
    if (!digest.logical && i > 0) return;
    digests.push(digest);
  });
  return (
    <div ref={root} data-testid="trace-subagent-calls">
      <p className="text-muted-foreground px-2 pb-1 text-tip">{SUBAGENT_CALLS_CONTENT_TEXT}</p>
      {child.omitted > 0 && (
        <p className="text-muted-foreground px-2 pb-1 text-tip">
          更早還有 {child.omitted} 輪連摘要都沒留。
        </p>
      )}
      {digests.map((digest) => {
        const pull = pulls.get(digest.seq);
        const shown = shownOf(pull);
        const status =
          pull === undefined || pull.kind === 'loaded' ? { kind: 'idle' as const } : pull;
        if (shown !== undefined) {
          return (
            <div key={`${digest.seq}:${shown.load}`} data-pulled-seq={digest.seq}>
              {shown.turns.map((turn) => (
                <SubagentTurn key={turn.seq} turn={shownTurn(turn)} />
              ))}
              <PullControl
                status={status}
                reloadLabel={SUBAGENT_CALLS_RELOAD_LABEL}
                onPull={() => pullSeq(digest.seq)}
                onArm={(button) => handoff.arm(digest.seq, button)}
              />
            </div>
          );
        }
        const head = subagentDigestHead(digest);
        return (
          <section
            key={digest.seq}
            className="mb-2"
            data-testid="trace-subagent-digest"
            data-seq={digest.seq}
          >
            <p className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 px-2 text-tip">
              <span>{SUBAGENT_TURN_LABEL(head.kind)}</span>
              <HeadFacts head={head} noEnd={head.kind === 'run'} />
            </p>
            {puller === undefined ? (
              <p className="text-muted-foreground px-2 text-tip">{SUBAGENT_CALLS_NO_PULL_TEXT}</p>
            ) : (
              <PullControl
                status={status}
                onPull={() => pullSeq(digest.seq)}
                onArm={(button) => handoff.arm(digest.seq, button)}
              />
            )}
          </section>
        );
      })}
      {child.turns.map((turn) => (
        <SubagentTurn key={turn.seq} turn={shownTurn(subagentTurnView(turn, snapshots))} />
      ))}
    </div>
  );
}
