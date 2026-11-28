import type { LoopAgent } from '@nexus/core';

import type { BackgroundAgent } from './background-subagents.js';
import type { PumpAgent } from './thread-pump.js';

type MemberNames<T> = readonly (keyof T & string)[];

function fakeMembers<T extends object>(
  required: MemberNames<T>,
  members: Partial<T>,
  defaults: Partial<T> = {},
): T {
  const target: Record<string, unknown> = { ...defaults, ...members };
  return new Proxy(target, {
    get(held, name) {
      if (!(name in held) && required.includes(name as never)) {
        return () => {
          throw new Error(`假 agent 沒給成員 ${String(name)}，卻被呼叫了`);
        };
      }
      return Reflect.get(held, name);
    },
  }) as T;
}

/**
 * 成員的簽名照 {@link LoopAgent}。只有 `streamEvents` 放寬成任意參數、任意回傳：測試替身吐的封包只寫用得到的那幾格，不湊成完整的
 * {@link RawProtocolEvent}。
 */
type PumpFakeMembers = {
  [K in keyof PumpAgent]?: K extends 'streamEvents' ? (...args: never[]) => unknown : PumpAgent[K];
};

const PUMP_DEFAULTS: Partial<LoopAgent> = {
  discardSuspended: () => undefined,
  appendLoggedMessages: () => Promise.resolve(),
  danglingCalls: () => Promise.resolve([]),
};

/**
 * 沒給的 `streamEvents`、`getState` 等一呼叫就拋錯。pump 不管對話內容時會碰的三個寫入成員有預設：收回什麼都不收、接上去的訊息直接收下、沒有懸著的呼叫；
 * 測試要看它們被叫了沒就自己給。
 */
export function fakePumpAgent(members: PumpFakeMembers = {}): PumpAgent {
  return fakeMembers<PumpAgent>(
    ['streamEvents', 'stream', 'invoke', 'withConfig', 'getState', 'seedThread'],
    members as Partial<PumpAgent>,
    PUMP_DEFAULTS,
  );
}

/** 沒給的成員一呼叫就拋錯；收回什麼都不收。 */
export function fakeBackgroundAgent(members: Partial<BackgroundAgent> = {}): BackgroundAgent {
  return fakeMembers<BackgroundAgent>(['streamEvents', 'seedThread'], members, {
    discardSuspended: () => undefined,
  });
}
