import { describe, expect, it } from 'vitest';

import { SessionLog } from './session-log.js';

describe('SessionLog', () => {
  it('seq 從 0 開始、逐筆遞增，出自日誌長度', () => {
    const log = new SessionLog('t1');
    expect(log.length).toBe(0);

    const first = log.append('turn/start', { kind: 'message', text: '你好' });
    const second = log.append('interrupt/raised', { interruptId: 'i-1' });
    const third = log.append('turn/end', {});

    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
    expect(log.length).toBe(3);
    expect(log.events.map((event) => event.type)).toEqual([
      'turn/start',
      'interrupt/raised',
      'turn/end',
    ]);
  });

  it('兩份日誌的號各自從 0 開始，互不干擾', () => {
    const a = new SessionLog('a');
    const b = new SessionLog('b');

    a.append('turn/end', {});
    a.append('turn/end', {});
    const firstOfB = b.append('turn/end', {});

    expect(firstOfB.seq).toBe(0);
    expect(a.length).toBe(2);
    expect(b.sessionId).toBe('b');
  });

  it('存進去的是深拷貝——事後改原物件動不到日誌', () => {
    const log = new SessionLog('t1');
    const data = { kind: 'message', text: '原本' } as const;
    const mutable: { kind: 'message'; text: string } = { ...data };

    log.append('turn/start', mutable);
    mutable.text = '改過';

    const stored = log.events[0]?.data as { text: string };
    expect(stored.text).toBe('原本');
  });

  it('回傳的事件是凍過的，改不動', () => {
    const log = new SessionLog('t1');
    const event = log.append('turn/failed', { message: '壞了' });

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.data)).toBe(true);
  });

  it('events 回的是副本，改它動不到日誌', () => {
    const log = new SessionLog('t1');
    log.append('turn/end', {});

    const snapshot = log.events as unknown as unknown[];
    snapshot.push({ type: 'turn/end', seq: 99, time: 0, data: {} });

    expect(log.length).toBe(1);
  });

  it('class 實例當場拋，而且日誌不留半筆', () => {
    const log = new SessionLog('t1');
    class Message {
      readonly text = '嗨';
    }

    expect(() =>
      log.append('turn/failed', { message: new Message() as unknown as string }),
    ).toThrow(/只收純 JSON/);
    expect(log.length).toBe(0);
  });

  it('函式與 undefined 也拋，訊息指名是哪個欄位', () => {
    const log = new SessionLog('t1');

    expect(() => log.append('turn/failed', { message: (() => '嗨') as unknown as string })).toThrow(
      /turn\/failed 的 data\.message/,
    );
    expect(() => log.append('turn/failed', { message: undefined as unknown as string })).toThrow(
      /undefined/,
    );
    expect(log.length).toBe(0);
  });

  it('NaN 與 Infinity 拋——JSON 表達不出來', () => {
    const log = new SessionLog('t1');

    expect(() =>
      log.append('interrupt/raised', { interruptId: Number.NaN as unknown as string }),
    ).toThrow(/NaN/);
    expect(() =>
      log.append('interrupt/raised', { interruptId: Infinity as unknown as string }),
    ).toThrow(/Infinity/);
  });

  it('循環參考拋，不是無窮遞迴', () => {
    const log = new SessionLog('t1');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() => log.append('turn/failed', { message: cyclic as unknown as string })).toThrow(
      /循環參考/,
    );
    expect(log.length).toBe(0);
  });

  it('巢狀的純物件與陣列收得下，而且是深拷貝', () => {
    const log = new SessionLog('t1');
    const nested = { kind: 'message', text: 'x' } as const;
    const payload = { kind: 'message' as const, text: JSON.stringify({ a: [1, { b: nested }] }) };

    const event = log.append('turn/start', payload);

    expect(event.data).toEqual(payload);
    expect(event.data).not.toBe(payload);
  });
});
