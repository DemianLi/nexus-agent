import type {
  ConversationState,
  Event,
  RequestSnapshotsView,
  TrajectoryCall,
  TrajectoryDecision,
  TrajectoryDigest,
  TrajectoryTool,
  TrajectoryTurn,
  TrajectoryView,
} from '@nexus/wire';
import {
  PROJECTION,
  REQUEST_SNAPSHOTS_PROJECTION,
  REQUEST_SNAPSHOTS_VERSION,
  TRAJECTORY_PROJECTION,
  TRAJECTORY_VERSION,
  reduceAll,
} from '@nexus/wire';

import type { Script } from '@/test/conversation-frames';

/**
 * 軌跡投影的測試建構器。形狀照 `packages/nexus-wire/src/trajectory.ts`；值是手寫的（插件那一側有自己的折疊測試，
 * 這裡只管 web 怎麼讀），但**送進 `reduceAll` 的是真的 `projection` frame**，所以閘門（key、version、failed）走的是真路徑。
 */
export function tool(callId: string, overrides: Partial<TrajectoryTool> = {}): TrajectoryTool {
  return {
    callId,
    name: 'ls',
    seq: 1,
    time: 1_700_000_000_000,
    status: 'ok',
    endTime: 1_700_000_000_050,
    durationMs: 50,
    ...overrides,
  };
}

export function call(id: number, overrides: Partial<TrajectoryCall> = {}): TrajectoryCall {
  return {
    id,
    time: 1_700_000_000_000 + id,
    endTime: 1_700_000_000_400 + id,
    durationMs: 400,
    model: 'fake-model',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    retries: [],
    tools: [],
    ...overrides,
  };
}

export function turn(index: number, overrides: Partial<TrajectoryTurn> = {}): TrajectoryTurn {
  const calls = overrides.calls ?? [];
  return {
    index,
    seq: index * 100,
    time: 1_700_000_000_000 + index * 1000,
    kind: 'message',
    logical: true,
    end: 'completed',
    durationMs: 900,
    callCount: calls.length,
    toolCount: calls.reduce((sum, c) => sum + c.tools.length, 0),
    toolErrors: 0,
    retryCount: calls.reduce((sum, c) => sum + c.retries.length, 0),
    inputTokens: calls.length * 10,
    outputTokens: calls.length * 5,
    inputs: [],
    calls,
    looseTools: [],
    decisions: [],
    unattributed: 0,
    ...overrides,
  };
}

export function digest(index: number, overrides: Partial<TrajectoryDigest> = {}): TrajectoryDigest {
  return {
    index,
    seq: index * 100,
    time: 1_700_000_000_000 + index * 1000,
    kind: 'message',
    logical: true,
    end: 'completed',
    durationMs: 900,
    callCount: 2,
    toolCount: 1,
    toolErrors: 0,
    retryCount: 0,
    inputTokens: 20,
    outputTokens: 10,
    ...overrides,
  };
}

export function view(
  turns: readonly TrajectoryTurn[],
  extra: Partial<TrajectoryView> = {},
): TrajectoryView {
  return { digests: [], omitted: 0, turns, ...extra };
}

export function decision<K extends TrajectoryDecision['kind']>(
  kind: K,
  seq: number,
  fields: Omit<Extract<TrajectoryDecision, { kind: K }>, 'kind' | 'seq' | 'time'>,
): TrajectoryDecision {
  return { kind, seq, time: 1_700_000_000_000 + seq, ...fields } as TrajectoryDecision;
}

export function projectionFrame(
  script: Script,
  key: string,
  version: number,
  value: unknown,
  extra: { failed?: true; session?: string } = {},
): Event {
  return script.custom(PROJECTION, {
    key,
    version,
    view: extra.failed === true ? null : value,
    ...extra,
  });
}

/** 把軌跡（與選配的請求快照）當成下行的 `projection` frame 折進狀態。 */
export function withTrajectory(
  state: ConversationState,
  script: Script,
  trajectory: TrajectoryView,
  snapshots?: RequestSnapshotsView,
): ConversationState {
  return reduceAll(state, [
    projectionFrame(script, TRAJECTORY_PROJECTION, TRAJECTORY_VERSION, trajectory),
    ...(snapshots === undefined
      ? []
      : [
          projectionFrame(
            script,
            REQUEST_SNAPSHOTS_PROJECTION,
            REQUEST_SNAPSHOTS_VERSION,
            snapshots,
          ),
        ]),
  ]);
}
