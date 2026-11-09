/**
 * 可共用的 seed（[#2117](https://github.com/DemianLi/nexus-agent/issues/2117)）：`shareStoredEvents` 交出的陣列，`SessionLog` 驗信封
 * 與 `seq`、不拷；沒標過的逐顆拷、凍。標記跟著陣列，不跟著事件：複製一份就退回拷的那條路。
 */

import { describe, expect, it } from 'vitest';

import { appendSharedEvents, SessionLog, shareStoredEvents } from './session-log.js';
import type { SessionEvent } from './session-log.js';

/** 從 JSON 解出來的樣子：純物件，沒凍。 */
function decoded(count: number): SessionEvent[] {
  const lines = Array.from({ length: count }, (_, seq) =>
    JSON.stringify({ type: 'model/usage', seq, time: 1, data: {} }),
  );
  return lines.map((line) => JSON.parse(line) as SessionEvent);
}

describe('shareStoredEvents', () => {
  it('原地深凍、回同一個陣列；當 seed 時每一顆原封不動收下', () => {
    const events = decoded(2);
    const shared = shareStoredEvents(events);
    expect(shared).toBe(events);
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared[0]!.data)).toBe(true);
    const log = new SessionLog('t', { seed: shared });
    expect(log.events[0]).toBe(shared[0]);
    expect(log.events[1]).toBe(shared[1]);
  });

  it('沒標過的照拷、照凍', () => {
    const events = decoded(1);
    const log = new SessionLog('t', { seed: events });
    expect(log.events[0]).not.toBe(events[0]);
    expect(log.events[0]).toEqual(events[0]);
    expect(Object.isFrozen(log.events[0]!.data)).toBe(true);
    expect(Object.isFrozen(events[0])).toBe(false);
  });

  it('複製出來的陣列沒有標記，退回拷的那條路', () => {
    const shared = shareStoredEvents(decoded(1));
    const log = new SessionLog('t', { seed: [...shared] });
    expect(log.events[0]).not.toBe(shared[0]);
  });

  it('不拷也照驗：seq 不連續照拋', () => {
    const events = decoded(2);
    const broken = shareStoredEvents([events[1]!]);
    expect(() => new SessionLog('t', { seed: broken })).toThrow(/不連續/u);
  });

  it('不拷也照驗：信封不對照拋', () => {
    const [event] = decoded(1);
    const bad = shareStoredEvents([{ ...event!, time: 'later' } as unknown as SessionEvent]);
    expect(() => new SessionLog('t', { seed: bad })).toThrow(/seed 第 0 顆/u);
  });
});

describe('appendSharedEvents', () => {
  it('接上的陣列照樣可共用；新接的那幾顆也凍了', () => {
    const shared = shareStoredEvents(decoded(1));
    const [extra] = decoded(2).slice(1);
    const joined = appendSharedEvents(shared, [extra!]);
    expect(Object.isFrozen(extra!.data)).toBe(true);
    const log = new SessionLog('t', { seed: joined });
    expect(log.events[0]).toBe(shared[0]);
    expect(log.events[1]).toBe(extra);
  });

  it('前面那份沒標過就是普通的串接：不凍，當 seed 時照拷', () => {
    const plain = decoded(2);
    const joined = appendSharedEvents(plain.slice(0, 1), plain.slice(1));
    expect(Object.isFrozen(plain[0]!.data)).toBe(false);
    const log = new SessionLog('t', { seed: joined });
    expect(log.events[0]).not.toBe(plain[0]);
  });
});
