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

type PumpFakeMembers = {
  [K in keyof PumpAgent]?: K extends 'streamEvents' ? (...args: never[]) => unknown : PumpAgent[K];
};

const PUMP_DEFAULTS: Partial<LoopAgent> = {
  discardSuspended: () => undefined,
  appendLoggedMessages: () => Promise.resolve(),
  danglingCalls: () => Promise.resolve([]),
};

export function fakePumpAgent(members: PumpFakeMembers = {}): PumpAgent {
  return fakeMembers<PumpAgent>(
    ['streamEvents', 'stream', 'invoke', 'withConfig', 'getState', 'seedThread'],
    members as Partial<PumpAgent>,
    PUMP_DEFAULTS,
  );
}

export function fakeBackgroundAgent(members: Partial<BackgroundAgent> = {}): BackgroundAgent {
  return fakeMembers<BackgroundAgent>(['streamEvents', 'seedThread'], members, {
    discardSuspended: () => undefined,
  });
}
