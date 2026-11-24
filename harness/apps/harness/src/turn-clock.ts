/**
 * 一輪的時鐘（[#1624](https://github.com/DemianLi/nexus-agent/issues/1624)）：`ThreadPump` 的 root 那一輪與背景子代理的每一輪共用。
 *
 * 到點叫一次 `onExpire`（呼叫端照停止鍵的路中止這一輪），再過寬限這一輪還沒收尾就叫一次 `onGrace`（只記一行，不丟下工具，
 * Q-B2 (a)）。呼叫端在這一輪收尾時（正常、拋錯、停在核准點都算）叫回傳的 `stop`，兩顆計時器都清掉。
 *
 * 計時器可以注入（{@link TurnTimers}）：卡上要求「拿掉清計時器的那一行要紅」，而呼叫端到點時會先比對這一輪還是不是當下那一輪，
 * 漏清的計時器在行為上碰不到下一輪，只有數得到還掛著幾顆才抓得到。值與設定列見 `settings/turn-timeout.ts`。
 *
 * @module
 */

import type { SessionEvent } from '@nexus/core';

/** 到點之後再等多久還沒收尾就記一行（Q-B2 (a)）。 */
export const DEFAULT_TURN_TIMEOUT_GRACE_MS = 5_000;

/** 排與清計時器的那一組；預設是 `setTimeout`／`clearTimeout`。 */
export interface TurnTimers {
  readonly set: (callback: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

/** 一輪的時鐘設定。沒有這一格（`undefined`）就是不限，同今天。 */
export interface TurnClock {
  /** 一輪最多跑幾毫秒，由 `turn-timeout` 那一列來。 */
  readonly timeoutMs: number;
  /** 到點之後的寬限；省略即 {@link DEFAULT_TURN_TIMEOUT_GRACE_MS}。 */
  readonly graceMs?: number;
  /** 省略即真的計時器。 */
  readonly timers?: TurnTimers;
}

/**
 * 真的計時器。**`unref`**：一顆還沒到點的時鐘不該讓行程留著（serve 本來就活著；測試與一次性的組裝不該被它拖住）。
 */
export const REAL_TURN_TIMERS: TurnTimers = {
  set: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * 起一輪的時鐘。
 *
 * @param clock - 設定；`undefined` 就不起，回一個什麼都不做的 `stop`。
 * @param onExpire - 到點時叫一次。
 * @param onGrace - 到點之後過了寬限還沒被 `stop` 時叫一次。
 * @returns 收尾時叫的 `stop`（冪等）。
 */
export function startTurnClock(
  clock: TurnClock | undefined,
  onExpire: () => void,
  onGrace: () => void,
): () => void {
  if (clock === undefined) return () => {};
  const timers = clock.timers ?? REAL_TURN_TIMERS;
  const graceMs = clock.graceMs ?? DEFAULT_TURN_TIMEOUT_GRACE_MS;
  let handle: unknown;
  let active = true;
  handle = timers.set(() => {
    if (!active) return;
    handle = timers.set(() => {
      if (!active) return;
      active = false;
      handle = undefined;
      onGrace();
    }, graceMs);
    onExpire();
  }, clock.timeoutMs);
  return () => {
    if (!active) return;
    active = false;
    timers.clear(handle);
    handle = undefined;
  };
}

/**
 * 這一輪（最近一顆 `turn/start` 之後）開了 `tool/call`、還沒有 `tool/result` 的工具名，依開的先後。給時鐘到點後收不了尾的那一行 warn
 * （#1624 的 Q-B2 (a)）：只看傳進來的那一份日誌；root 那一份裡，前景子代理裡面的工具算在它那顆 `task` 上。
 */
export function unsettledToolNames(events: readonly SessionEvent[]): string[] {
  const open = new Map<string, string>();
  for (let at = events.length - 1; at >= 0; at -= 1) {
    const event = events[at]!;
    if (event.type === 'turn/start') break;
    if (event.type === 'tool/result') open.set(event.data.callId, '');
    else if (event.type === 'tool/call' && !open.has(event.data.callId)) {
      open.set(event.data.callId, event.data.name);
    }
  }
  return [...open.values()].filter((name) => name !== '').reverse();
}
