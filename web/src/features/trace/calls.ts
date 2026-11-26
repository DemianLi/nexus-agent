/**
 * 模型呼叫段落列，以及它上面的請求快照部分。root 的與子代理的共用。
 *
 * @module
 */

import type { TrajectoryCall, TrajectoryView, TurnStopCause } from '@nexus/wire';
import { stoppedByTurnClock } from '@/shared/lib/stop-cause';
import { ABSENT, snapshotsOf } from '@/features/trace/trajectory-view';
import { bucketFields } from '@/features/trace/heads';
import type { TraceRow } from '@/features/trace/model';

export type SnapshotParts = Pick<
  Extract<TraceRow, { kind: 'call' }>,
  | 'system'
  | 'systemChars'
  | 'systemTruncated'
  | 'systemText'
  | 'systemReason'
  | 'header'
  | 'headerTools'
  | 'headerJson'
  | 'headerReason'
  | 'toolsDiff'
>;

function toolNamesOf(header: unknown): string[] | undefined {
  if (typeof header !== 'object' || header === null) return undefined;
  const { tools } = header as { tools?: unknown };
  if (!Array.isArray(tools)) return undefined;
  return tools.map((tool) =>
    typeof tool === 'object' &&
    tool !== null &&
    typeof (tool as { name?: unknown }).name === 'string'
      ? (tool as { name: string }).name
      : ABSENT,
  );
}

/** 「新增 a、b；移除 c」；兩份的名字集合相同就是 `undefined`。 */
function toolsDiffText(before: readonly string[], after: readonly string[]): string | undefined {
  const added = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  if (added.length === 0 && removed.length === 0) return undefined;
  return [
    added.length === 0 ? undefined : `新增 ${added.join('、')}`,
    removed.length === 0 ? undefined : `移除 ${removed.join('、')}`,
  ]
    .filter((part) => part !== undefined)
    .join('；');
}

/**
 * 呼叫列上的請求快照部分的產生器。**一份快照在一次建模型裡只轉一次 JSON**（一輪可以有幾十次呼叫，它們指到同一份）：
 * 整份清單帶每個工具的說明與參數，常有二十幾 KB。
 */
export function snapshotPartsOf(
  snapshots: ReturnType<typeof snapshotsOf>,
): (call: TrajectoryView['turns'][number]['calls'][number]) => SnapshotParts {
  const json = new Map<number, string>();
  const jsonOf = (seq: number, header: unknown): string => {
    let text = json.get(seq);
    if (text === undefined) {
      text = JSON.stringify(header) ?? 'null';
      json.set(seq, text);
    }
    return text;
  };
  return (call) => {
    const system =
      call.system === undefined ? undefined : snapshots?.system.find((s) => s.seq === call.system);
    const header =
      call.header === undefined ? undefined : snapshots?.header.find((s) => s.seq === call.header);
    const tools = toolNamesOf(header?.header);
    const previous =
      header === undefined ? undefined : snapshots?.header.filter((s) => s.seq < header.seq).at(-1);
    const before = previous === undefined ? undefined : toolNamesOf(previous.header);
    const diff =
      tools === undefined || before === undefined ? undefined : toolsDiffText(before, tools);
    return {
      system: call.system === undefined ? 'none' : system === undefined ? 'gone' : 'kept',
      header: call.header === undefined ? 'none' : header === undefined ? 'gone' : 'kept',
      ...(system === undefined ? {} : { systemChars: system.chars }),
      ...(system?.truncated === true ? { systemTruncated: true } : {}),
      ...(system === undefined ? {} : { systemText: system.text, systemReason: system.reason }),
      ...(tools === undefined ? {} : { headerTools: tools.length }),
      ...(header === undefined
        ? {}
        : { headerJson: jsonOf(header.seq, header.header), headerReason: header.reason }),
      ...(diff === undefined ? {} : { toolsDiff: diff }),
    };
  };
}

/** 一次模型呼叫的段落列。root 的與子代理的共用：`loaded` 是「有沒有條目歸在這次呼叫上」。 */
export function callRowOf(
  call: TrajectoryCall,
  options: {
    readonly n: number;
    readonly target: string | undefined;
    readonly loaded: boolean;
    readonly snapshotParts: (call: TrajectoryCall) => SnapshotParts;
    readonly endCause: TurnStopCause | undefined;
  },
): Extract<TraceRow, { kind: 'call' }> {
  const outcome =
    call.outcome === 'aborted' && stoppedByTurnClock(options.endCause) ? 'timed-out' : call.outcome;
  return {
    kind: 'call',
    key: `call-${call.id}`,
    target: options.target,
    n: options.n,
    time: call.time,
    toolCount: call.tools.length,
    retryCount: call.retries.length,
    loaded: options.loaded,
    hasContent:
      call.tools.length > 0 ||
      (call.reply !== undefined && call.reply.textChars + call.reply.reasoningChars > 0),
    ...(call.endTime === undefined ? {} : { endTime: call.endTime }),
    ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
    ...(outcome === undefined ? {} : { outcome }),
    ...(call.model === undefined ? {} : { model: call.model }),
    ...(call.usage === undefined
      ? {}
      : {
          inputTokens: call.usage.inputTokens,
          outputTokens: call.usage.outputTokens,
          ...bucketFields(call.usage),
        }),
    ...options.snapshotParts(call),
  };
}
