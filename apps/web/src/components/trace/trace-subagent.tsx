/**
 * 派出子代理的那顆工具底下的「子代理的呼叫結構」（#1015 的驗收缺口）：推送的最新一輪直接畫，更早的輪與前景子代理
 * 展開時才向伺服器拉。
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import type { ConversationState, TrajectoryDigest, TrajectoryTurnKind } from '@nexus/wire';

import { CallRow } from '@/components/trace/trace-call';
import { PullControl } from '@/components/trace/trace-pull-control';
import { HeadFacts } from '@/components/trace/trace-turn-head';
import { TOOL_STATUS_LABEL } from '@/components/tool/tool-card';
import { Button } from '@/components/ui/button';
import { subagentDigestHead, subagentTurnView } from '@/lib/trace-view';
import type { SubagentCallView, SubagentTurnView } from '@/lib/trace-view';
import type { TrajectoryPuller } from '@/lib/trajectory-pull';
import {
  TURN_KIND_LABEL,
  clockText,
  durationText,
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

type ChildPull =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'loaded'; readonly turns: readonly SubagentTurnView[] };

function SubagentTool({ tool }: { tool: SubagentCallView['tools'][number] }) {
  return (
    <li
      className="text-muted-foreground flex min-w-0 flex-wrap gap-x-2 text-xs"
      data-testid="trace-subagent-tool"
    >
      <code className="text-foreground font-mono">{tool.name}</code>
      <span className={tool.status === 'error' ? 'text-destructive' : undefined}>
        {
          TOOL_STATUS_LABEL[
            tool.status === 'error' ? 'failed' : tool.status === 'ok' ? 'done' : 'running'
          ]
        }
      </span>
      {tool.code !== undefined && <code className="font-mono">{tool.code}</code>}
      <span>
        {clockText(tool.time)}
        {tool.durationMs !== undefined && ` · ${durationText(tool.durationMs)}`}
      </span>
    </li>
  );
}

function SubagentTurn({ turn }: { turn: SubagentTurnView }) {
  return (
    <section className="mb-2" data-testid="trace-subagent-turn" data-seq={turn.seq}>
      <p className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 px-2 text-xs">
        <span>{SUBAGENT_TURN_LABEL(turn.head.kind)}</span>
        <HeadFacts head={turn.head} noEnd={turn.head.kind === 'run'} />
      </p>
      {turn.elidedCalls !== undefined && (
        <p className="text-muted-foreground px-2 text-xs">
          更早的 {turn.elidedCalls} 次呼叫被單輪上限摺掉了，只留計數。
        </p>
      )}
      {turn.calls.map((call) => (
        <div key={call.row.key} data-testid="trace-subagent-call">
          <CallRow row={call.row} />
          {call.retries.map((retry) => (
            <p
              key={retry.key}
              className="text-muted-foreground px-2 pl-8 text-xs"
              data-testid="trace-subagent-retry"
            >
              重試 {retry.retry}/{retry.maxRetries} ·{' '}
              {retry.status === undefined ? retry.code : `${retry.code} · HTTP ${retry.status}`}
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
      ))}
    </section>
  );
}

/**
 * 派出子代理的那顆工具底下：那個子代理自己的呼叫結構（#1015 的驗收缺口）。推送的最新一輪直接畫；更早的輪與前景子代理
 * （整段只有一份摘要）展開時才向伺服器拉（`fetchTurns({ runId, seq })`）。
 */
export function SubagentCalls({ runId }: { runId: string }) {
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

  const pullSeq = useCallback(
    (seq: number) => {
      if (puller === undefined) return;
      const abort = new AbortController();
      aborts.current.add(abort);
      setPulls((old) => new Map(old).set(seq, { kind: 'loading' }));
      void puller.fetchTurns({ runId, seq }, abort.signal).then((outcome) => {
        aborts.current.delete(abort);
        if (abort.signal.aborted) return;
        setPulls((old) =>
          new Map(old).set(
            seq,
            outcome.ok
              ? {
                  kind: 'loaded',
                  turns: outcome.turns.map((turn) => subagentTurnView(turn, snapshots)),
                }
              : { kind: 'failed', code: outcome.code, message: outcome.message },
          ),
        );
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
      <p className="text-muted-foreground px-2 text-xs" data-testid="trace-subagent-nodata">
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
    <div data-testid="trace-subagent-calls">
      <p className="text-muted-foreground px-2 pb-1 text-xs">{SUBAGENT_CALLS_CONTENT_TEXT}</p>
      {child.omitted > 0 && (
        <p className="text-muted-foreground px-2 pb-1 text-xs">
          更早還有 {child.omitted} 輪連摘要都沒留。
        </p>
      )}
      {digests.map((digest) => {
        const pull = pulls.get(digest.seq);
        if (pull?.kind === 'loaded') {
          return (
            <div key={digest.seq}>
              {pull.turns.map((turn) => (
                <SubagentTurn key={turn.seq} turn={turn} />
              ))}
              <div className="px-2 pb-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="min-h-11 text-xs lg:min-h-8"
                  onClick={() => pullSeq(digest.seq)}
                >
                  {SUBAGENT_CALLS_RELOAD_LABEL}
                </Button>
              </div>
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
            <p className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5 px-2 text-xs">
              <span>{SUBAGENT_TURN_LABEL(head.kind)}</span>
              <HeadFacts head={head} noEnd={head.kind === 'run'} />
            </p>
            {puller === undefined ? (
              <p className="text-muted-foreground px-2 text-xs">{SUBAGENT_CALLS_NO_PULL_TEXT}</p>
            ) : (
              <PullControl status={pull ?? { kind: 'idle' }} onPull={() => pullSeq(digest.seq)} />
            )}
          </section>
        );
      })}
      {child.turns.map((turn) => (
        <SubagentTurn key={turn.seq} turn={subagentTurnView(turn, snapshots)} />
      ))}
    </div>
  );
}
