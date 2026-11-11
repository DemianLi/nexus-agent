/**
 * 請求快照與作廢的嘗試各歸哪次模型呼叫（[#2416](https://github.com/DemianLi/nexus-agent/issues/2416)，格式 55），夾具產生器與
 * `session-format-fixtures.test.ts` 共用。
 *
 * - `request/*` 有兩種形狀：54 以前帶 `modelCall`、寫在 `model/start` 之後；55 起不帶、寫在它所屬那次的 `model/start` 之前。
 *   帶的照它指的那顆；不帶的歸下一顆 `model/start`，在那之前輪就收了的是 `null`。
 * - `assistant/attempt` 照它帶的 `modelCall`，並記那次呼叫失敗收尾的 `model/end` 落在它前面沒有。
 */

import type { SessionEvent } from '@nexus/core';

/** 一顆請求快照歸哪次呼叫。 */
export interface RequestSnapshotCall {
  /** `request/system` 或 `request/header`。 */
  readonly type: string;
  /** 事件自己帶的 `modelCall`；新形狀不帶，是 `null`。 */
  readonly modelCall: number | null;
  /** 歸屬那次呼叫的 `model/start` 的 `seq`。 */
  readonly call: number | null;
}

/** 一顆作廢的嘗試歸哪次呼叫。 */
export interface AttemptCall {
  readonly modelCall: number | null;
  /** 那次呼叫以 `error` 或 `aborted` 收尾的 `model/end` 在這顆之前（舊位置，`langgraph` 下 pump 寫的）。 */
  readonly afterFailedEnd: boolean;
  /**
   * 那次呼叫以 `error` 或 `aborted` 收尾的 `model/end` 在這顆之後（新位置，native 下起訖紀錄器寫的）。兩格都是 `false`：
   * 那次呼叫根本沒失敗，不合法（檢查器報 `attempt-before-failed-end`）。
   */
  readonly beforeFailedEnd: boolean;
}

function modelCallOf(event: SessionEvent): number | null {
  const value = (event.data as { modelCall?: unknown }).modelCall;
  return typeof value === 'number' ? value : null;
}

/** 日誌上每顆請求快照依序歸哪次呼叫，規則見檔頭。 */
export function requestSnapshotCalls(events: readonly SessionEvent[]): RequestSnapshotCall[] {
  return events.flatMap((event, index): RequestSnapshotCall[] => {
    if (event.type !== 'request/system' && event.type !== 'request/header') return [];
    const modelCall = modelCallOf(event);
    if (modelCall !== null) return [{ type: event.type, modelCall, call: modelCall }];
    const next = events
      .slice(index + 1)
      .find(
        (later) =>
          later.type === 'model/start' || later.type === 'turn/end' || later.type === 'turn/failed',
      );
    return [
      {
        type: event.type,
        modelCall,
        call: next?.type === 'model/start' ? (next.seq as number) : null,
      },
    ];
  });
}

/** 日誌上每顆 `assistant/attempt` 依序歸哪次呼叫、失敗收尾在它前面還是後面。 */
export function attemptCalls(events: readonly SessionEvent[]): AttemptCall[] {
  return events.flatMap((event, index): AttemptCall[] => {
    if (event.type !== 'assistant/attempt') return [];
    const modelCall = modelCallOf(event);
    const failedEndIn = (range: readonly SessionEvent[]): boolean =>
      range.some((other) => {
        if (other.type !== 'model/end' || modelCallOf(other) !== modelCall) return false;
        const outcome = (other.data as { outcome?: unknown }).outcome;
        return outcome === 'error' || outcome === 'aborted';
      });
    return [
      {
        modelCall,
        afterFailedEnd: failedEndIn(events.slice(0, index)),
        beforeFailedEnd: failedEndIn(events.slice(index + 1)),
      },
    ];
  });
}
