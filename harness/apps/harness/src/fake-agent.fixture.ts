import type { BackgroundAgent } from './background-subagents.js';
import type { PumpAgent } from './thread-pump.js';

type MemberNames<T> = readonly (keyof T & string)[];

function fakeMembers<T extends object>(required: MemberNames<T>, members: Partial<T>): T {
  const target: Record<string, unknown> = { ...members };
  return new Proxy(target, {
    get(held, name) {
      if (typeof name === 'string' && !(name in held) && required.includes(name as never)) {
        return () => {
          throw new Error(`假 agent 沒給成員 ${name}，卻被呼叫了`);
        };
      }
      return Reflect.get(held, name);
    },
  }) as T;
}

type AllMemberNames<T> = T extends unknown ? keyof T & string : never;

type LoosePumpMembers = { [K in AllMemberNames<PumpAgent>]?: (...args: never[]) => unknown };

/** 沒給的 `streamEvents`／`getState` 一呼叫就拋錯；選填成員沒給就不存在（產品碼靠 `!== undefined` 認 loop）。 */
export function fakePumpAgent(members: LoosePumpMembers = {}): PumpAgent {
  return fakeMembers<PumpAgent>(['streamEvents', 'getState'], members as Partial<PumpAgent>);
}

/** 沒給的 `streamEvents` 一呼叫就拋錯；選填成員沒給就不存在。 */
export function fakeBackgroundAgent(members: Partial<BackgroundAgent> = {}): BackgroundAgent {
  return fakeMembers<BackgroundAgent>(['streamEvents'], members);
}
