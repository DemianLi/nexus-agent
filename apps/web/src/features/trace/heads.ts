/**
 * 輪的標題：從投影的輪或摘要算 `TurnHead`、併續接、折疊摘要清單。
 *
 * @module
 */

import type { TrajectoryDigest, TrajectoryTurn } from '@nexus/wire';
import { abortedToolLabel } from '@/features/tool';
import type { TurnHead } from '@/features/trace/model';

interface BucketFields {
  readonly uncachedInputTokens?: number | undefined;
  readonly cacheReadTokens?: number | undefined;
  readonly cacheWriteTokens?: number | undefined;
}

/** 三格快取分桶：缺席的不放進去（列只放有的原始值，`sameRow` 逐欄 `===`）。 */
export function bucketFields(source: BucketFields): BucketFields {
  return {
    ...(source.uncachedInputTokens === undefined
      ? {}
      : { uncachedInputTokens: source.uncachedInputTokens }),
    ...(source.cacheReadTokens === undefined ? {} : { cacheReadTokens: source.cacheReadTokens }),
    ...(source.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: source.cacheWriteTokens }),
  };
}

/** 併續接時的桶：兩段都有才加，缺一段就是沒記。 */
function addBucket(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined || right === undefined ? undefined : left + right;
}

/**
 * 細節已載入的一輪裡真的失敗的工具數：`toolErrors` 減掉被中止的（#2247）。摘要沒有逐顆工具，
 * 被單輪上限摺掉的也沒有，那些維持投影的數。
 */
export function failedTools(turn: TrajectoryTurn): number {
  const tools = [...turn.looseTools, ...turn.calls.flatMap((call) => call.tools)];
  const interrupted = tools.filter(
    (tool) => tool.status === 'error' && abortedToolLabel(tool.name, tool.code) !== undefined,
  );
  return turn.toolErrors - interrupted.length;
}

export function headOf(digest: TrajectoryDigest, number: number): TurnHead {
  return {
    number,
    kind: digest.kind,
    time: digest.time,
    callCount: digest.callCount,
    toolCount: digest.toolCount,
    toolErrors: digest.toolErrors,
    subagentCount: digest.subagentCount,
    retryCount: digest.retryCount,
    inputTokens: digest.inputTokens,
    outputTokens: digest.outputTokens,
    ...bucketFields(digest),
    ...(digest.end === undefined ? {} : { end: digest.end }),
    ...(digest.failureCode === undefined ? {} : { failureCode: digest.failureCode }),
    ...(digest.endCause === undefined ? {} : { endCause: digest.endCause }),
    ...(digest.endTime === undefined ? {} : { endTime: digest.endTime }),
    ...(digest.durationMs === undefined ? {} : { durationMs: digest.durationMs }),
  };
}

/** 把接在後面的 `resume` 併進它接著的那一輪：計數相加，收尾取最後一段，牆鐘從第一段開始算（含等人核准）。 */
export function mergeHead(first: TurnHead, resume: TurnHead): TurnHead {
  const elidedCalls = (first.elidedCalls ?? 0) + (resume.elidedCalls ?? 0);
  const elidedTools = (first.elidedTools ?? 0) + (resume.elidedTools ?? 0);
  return {
    number: first.number,
    kind: first.kind,
    time: first.time,
    callCount: first.callCount + resume.callCount,
    toolCount: first.toolCount + resume.toolCount,
    toolErrors: first.toolErrors + resume.toolErrors,
    subagentCount: first.subagentCount + resume.subagentCount,
    retryCount: first.retryCount + resume.retryCount,
    inputTokens: first.inputTokens + resume.inputTokens,
    outputTokens: first.outputTokens + resume.outputTokens,
    ...bucketFields({
      uncachedInputTokens: addBucket(first.uncachedInputTokens, resume.uncachedInputTokens),
      cacheReadTokens: addBucket(first.cacheReadTokens, resume.cacheReadTokens),
      cacheWriteTokens: addBucket(first.cacheWriteTokens, resume.cacheWriteTokens),
    }),
    ...(resume.end === undefined ? {} : { end: resume.end }),
    ...(resume.failureCode === undefined ? {} : { failureCode: resume.failureCode }),
    ...(resume.endCause === undefined ? {} : { endCause: resume.endCause }),
    ...(resume.endTime === undefined
      ? {}
      : { endTime: resume.endTime, durationMs: resume.endTime - first.time }),
    ...(elidedCalls > 0 ? { elidedCalls } : {}),
    ...(elidedTools > 0 ? { elidedTools } : {}),
  };
}

/** 摘要或輪的標題清單：`resume` 併回前一項（清單第一項若是 `resume`，它的前一輪在清單之外，原樣留著）。 */
export function foldResumes<T extends { readonly head: TurnHead; readonly logical: boolean }>(
  items: readonly T[],
): T[] {
  const out: T[] = [];
  for (const item of items) {
    const previous = out.at(-1);
    if (!item.logical && previous !== undefined) {
      out[out.length - 1] = { ...previous, head: mergeHead(previous.head, item.head) };
    } else {
      out.push(item);
    }
  }
  return out;
}
