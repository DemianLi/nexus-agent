import { describe, expect, it } from 'vitest';

import { currentTurnStart, hasUnansweredInterrupt, SessionLog } from './session-log.js';

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

describe('SessionLog 的觀察者', () => {
  it('listener 被叫到的時候，這一筆已經在日誌裡了', () => {
    const log = new SessionLog('t1');
    const seen: { length: number; last: string | undefined }[] = [];
    log.subscribe((event) => {
      seen.push({
        length: log.length,
        last: log.events.at(-1)?.type,
      });
      expect(log.events.at(-1)?.seq).toBe(event.seq);
    });

    log.append('turn/start', { kind: 'resume' });
    log.append('turn/end', {});

    // 「先推進再回呼」的外顯就是這個：第一次回呼時長度已經是 1，不是 0。
    expect(seen).toEqual([
      { length: 1, last: 'turn/start' },
      { length: 2, last: 'turn/end' },
    ]);
  });

  it('不補發歷史：訂閱之前的那些要自己讀 events', () => {
    const log = new SessionLog('t1');
    log.append('turn/start', { kind: 'resume' });
    const seen: number[] = [];
    log.subscribe((event) => void seen.push(event.seq));
    log.append('turn/end', {});
    expect(seen).toEqual([1]);
  });

  it('退訂是冪等的，而且只退自己那一個', () => {
    const log = new SessionLog('t1');
    const a: number[] = [];
    const b: number[] = [];
    const off = log.subscribe((event) => void a.push(event.seq));
    log.subscribe((event) => void b.push(event.seq));

    log.append('turn/start', { kind: 'resume' });
    off();
    off();
    log.append('turn/end', {});

    expect(a).toEqual([0]);
    expect(b).toEqual([0, 1]);
  });

  it('回呼裡再 append 會拋，而且日誌不會被那一筆污染', () => {
    const log = new SessionLog('t1');
    let thrown: unknown;
    log.subscribe(() => {
      try {
        log.append('turn/end', {});
      } catch (error) {
        thrown = error;
      }
    });

    log.append('turn/start', { kind: 'resume' });

    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('不能在另一次 append 的回呼裡重入');
    expect(log.length).toBe(1);
  });

  it('重入被擋掉之後，下一次正常的 append 照樣成立', () => {
    const log = new SessionLog('t1');
    let armed = true;
    log.subscribe(() => {
      if (!armed) return;
      armed = false;
      try {
        log.append('turn/end', {});
      } catch {
        /* 擋掉是預期的，這條要驗的是旗標有被放掉 */
      }
    });

    log.append('turn/start', { kind: 'resume' });
    log.append('turn/end', {});

    expect(log.length).toBe(2);
  });

  it('listener 拋錯只換來一行 warn，append 照樣回傳，後面的 listener 照樣被叫', () => {
    const warnings: string[] = [];
    const log = new SessionLog('t1', { onListenerError: (message) => void warnings.push(message) });
    const later: number[] = [];
    log.subscribe(() => {
      throw new Error('後端炸了');
    });
    log.subscribe((event) => void later.push(event.seq));

    const event = log.append('turn/start', { kind: 'resume' });

    expect(event.seq).toBe(0);
    expect(log.length).toBe(1);
    expect(later).toEqual([0]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('後端炸了');
    expect(warnings[0]).toContain('turn/start');
  });

  it('async listener 的 reject 也被接住，不會變成 unhandled rejection', async () => {
    const warnings: string[] = [];
    const log = new SessionLog('t1', { onListenerError: (message) => void warnings.push(message) });
    log.subscribe((() => Promise.reject(new Error('晚一點才炸'))) as () => void);

    log.append('turn/start', { kind: 'resume' });
    await Promise.resolve();

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('晚一點才炸');
    expect(warnings[0]).toContain('reject');
  });

  it('data 拷不動時，listener 一個都不會被叫到', () => {
    const log = new SessionLog('t1');
    let calls = 0;
    log.subscribe(() => void (calls += 1));

    // 驗證跑在推進與回呼之前，所以這一筆連「發生過」都不算。
    expect(() =>
      log.append('turn/failed', { message: (() => undefined) as unknown as string }),
    ).toThrow(/只收純 JSON/);

    expect(calls).toBe(0);
    expect(log.length).toBe(0);
  });
});

/**
 * **這兩個是「當前這一段物理輪次」那個走法的擁有者**，見它們的說明。
 * 另一種走法（往回追鏈）住在 `@nexus/plugin-goal` 的 `authority.ts`，兩邊各有一組測試
 * 釘住它們**走的不是同一條路**。
 */
describe('當前這一段物理輪次', () => {
  function logOf(script: readonly (readonly [string, unknown])[]): SessionLog {
    const log = new SessionLog('walk');
    for (const [type, data] of script) {
      log.append(type as 'turn/end', data as Record<string, never>);
    }
    return log;
  }

  const START: readonly [string, unknown] = ['turn/start', { kind: 'message', text: '動手' }];
  const RAISED: readonly [string, unknown] = ['interrupt/raised', { interruptId: 'i-1' }];
  const END: readonly [string, unknown] = ['turn/end', {}];
  const RESUME: readonly [string, unknown] = ['turn/start', { kind: 'resume' }];

  it('找的是最後一顆，不是第一顆', () => {
    expect(currentTurnStart(logOf([START, END, RESUME]).events)).toBe(2);
    expect(currentTurnStart(logOf([START]).events)).toBe(0);
  });

  it('一顆 turn/start 都沒有時是 -1', () => {
    expect(currentTurnStart([])).toBe(-1);
    expect(currentTurnStart(logOf([['todo/write', { todos: [] }]]).events)).toBe(-1);
  });

  /**
   * **停在核准點的那一輪照樣有 `turn/end`。** 所以拿 `turn/end` 判「收工了」的人一定要
   * 再問這一句，不然一個等著人按批准的會話會被當成閒下來了——而對續行排程器來說，那是
   * 在一顆掛著的中斷上面再排一輪。
   */
  it('停在核准點之後，中斷還掛著', () => {
    expect(hasUnansweredInterrupt(logOf([START, RAISED, END]).events)).toBe(true);
  });

  it('人回答了（新的一輪開始了）就不掛了', () => {
    expect(hasUnansweredInterrupt(logOf([START, RAISED, END, RESUME]).events)).toBe(false);
  });

  it('沒中斷的一輪不掛，空日誌也不掛', () => {
    expect(hasUnansweredInterrupt(logOf([START, END]).events)).toBe(false);
    expect(hasUnansweredInterrupt([])).toBe(false);
  });

  /** 更早那一輪的中斷不算——**回答會開新的一輪，所以它一定在當前這一段之外**。 */
  it('只看當前這一段，不往上穿', () => {
    const events = logOf([START, RAISED, END, RESUME, END]).events;
    expect(hasUnansweredInterrupt(events)).toBe(false);
  });
});
