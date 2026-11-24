/**
 * 子代理一輪的畫面形狀：標題與逐次呼叫（只有結構，沒有內文）。
 *
 * @module
 */

import type {
  RequestSnapshotsView,
  TrajectoryDigest,
  TrajectoryTool,
  TrajectoryTurn,
} from '@nexus/wire';
import type { TraceRow, TurnHead } from '@/features/trace/model';
import { failedTools, headOf } from '@/features/trace/heads';
import { snapshotPartsOf, callRowOf } from '@/features/trace/calls';

/** 子代理一輪的摘要（還沒拉細節）的標題。 */
export function subagentDigestHead(digest: TrajectoryDigest): TurnHead {
  return headOf(digest, 1);
}

/**
 * 派它的那一輪被時鐘切斷時，前景子代理被中止的呼叫也講成時間到（[#2240](https://github.com/DemianLi/nexus-agent/issues/2240)）。
 * 前景子代理的日誌沒有 `turn/end`，自己沒有 `endCause`；它讀的中止訊號就是派它那一輪的，沒有別的來源，所以父輪的原因就是它的。
 * 背景子代理（`kind` 不是 `run`）有自己的原因，不動。
 *
 * @param view - {@link subagentTurnView} 的結果。
 * @returns 換過呼叫列的那一份；不是前景子代理就原樣。
 */
export function cutByParentClock(view: SubagentTurnView): SubagentTurnView {
  if (view.head.kind !== 'run') return view;
  return {
    ...view,
    calls: view.calls.map((call) =>
      call.row.outcome === 'aborted'
        ? { ...call, row: { ...call.row, outcome: 'timed-out' as const } }
        : call,
    ),
  };
}

/** 子代理的一次呼叫：呼叫段落列、它的重試、它叫的工具（只有結構，沒有內文）。 */
export interface SubagentCallView {
  readonly row: Extract<TraceRow, { kind: 'call' }>;
  readonly retries: readonly Extract<TraceRow, { kind: 'retry' }>[];
  readonly tools: readonly SubagentToolView[];
}

export interface SubagentToolView {
  readonly key: string;
  readonly name: string;
  readonly status: TrajectoryTool['status'];
  readonly time: number;
  readonly durationMs?: number;
  readonly code?: string;
}

/** 子代理的一輪（或一份前景子代理的整段執行）：標題與逐次呼叫。 */
export interface SubagentTurnView {
  readonly seq: number;
  readonly head: TurnHead;
  /** 單輪上限摺掉的呼叫數；沒摺過沒有這一格。 */
  readonly elidedCalls?: number;
  readonly calls: readonly SubagentCallView[];
}

/**
 * 一個子代理的一輪轉成畫面要的形狀。**只放原始值**（理由同 `call` 那一列）；快照讀子代理自己的 `request-snapshots`
 * （`system`／`header` 指的是它自己日誌的位置）。呼叫的 `loaded` 一律是真的：子代理的內文不在這條路上，沒有「內文沒載入」可講。
 */
export function subagentTurnView(
  turn: TrajectoryTurn,
  snapshots: RequestSnapshotsView | undefined,
): SubagentTurnView {
  const snapshotParts = snapshotPartsOf(snapshots);
  const skipped = turn.elided?.calls ?? 0;
  return {
    seq: turn.seq,
    head: { ...headOf(turn, 1), toolErrors: failedTools(turn) },
    ...(skipped === 0 ? {} : { elidedCalls: skipped }),
    calls: turn.calls.map((call, c) => ({
      row: callRowOf(call, {
        n: skipped + c + 1,
        target: undefined,
        loaded: true,
        snapshotParts,
        endCause: turn.endCause,
      }),
      retries: call.retries.map((retry) => ({
        kind: 'retry' as const,
        key: `retry-${call.id}-${retry.retry}`,
        target: undefined,
        retry: retry.retry,
        maxRetries: retry.maxRetries,
        time: retry.time,
        code: retry.code,
        ...(retry.status === undefined ? {} : { status: retry.status }),
        ...(retry.waitedMs === undefined ? {} : { waitedMs: retry.waitedMs }),
      })),
      tools: call.tools.map((tool) => ({
        key: tool.callId,
        name: tool.name,
        status: tool.status,
        time: tool.time,
        ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
        ...(tool.code === undefined ? {} : { code: tool.code }),
      })),
    })),
  };
}
