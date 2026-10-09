/**
 * 事件匯流排的語意（[#1217](https://github.com/DemianLi/nexus-agent/issues/1217)，S0）。
 *
 * dsh 的 `vendor/cordis` 沒有任何匯流排測試，所以這些是從 `events.ts` 原始碼逐條寫的一致性測試：每一條對到原始碼的哪一行寫在
 * 該條的註解裡。事件表是空的，測試用的名字全部在這個檔案裡用 declaration merging 加（`test/` 前綴），這同時是
 * 「靠擴充 `Events` 加事件」這個機制本身的證明（跨套件那一側見 `apps/harness/src/events-augmentation.test.ts`）。
 */

import { describe, expect, it } from 'vitest';

import { EventBus, isBailed } from './events.js';

declare module './events.js' {
  interface Events {
    /**
     * 測試用。
     * @mode emit
     */
    'test/emit'(label: string): unknown;
    /**
     * 測試用。
     * @mode serial
     */
    'test/serial'(label: string): unknown;
    /**
     * 測試用。
     * @mode waterfall
     */
    'test/waterfall'(label: string, next: () => string): string;
    /**
     * 測試用，非同步 waterfall。
     * @mode waterfall
     */
    'test/waterfall-async'(label: string, next: () => Promise<string>): Promise<string>;
  }
}

describe('isBailed', () => {
  it('null、false、undefined 不是 bail 值；其餘（含 0、空字串）都是', () => {
    expect([null, false, undefined].map(isBailed)).toEqual([false, false, false]);
    expect([0, '', 'x', true, {}, []].map(isBailed)).toEqual([true, true, true, true, true, true]);
  });
});

describe('emit：同步、不等、回傳值丟掉', () => {
  it('依掛上的順序呼叫每一位，帶同樣的參數', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('test/emit', (label) => seen.push(`a:${label}`));
    bus.on('test/emit', (label) => seen.push(`b:${label}`));
    bus.emit('test/emit', 'x');
    expect(seen).toEqual(['a:x', 'b:x']);
  });

  it('不等監聽者回傳的 promise；回傳值不影響後面的監聽者', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('test/emit', () => new Promise(() => undefined));
    bus.on('test/emit', () => 'bail 值也不會讓 emit 停');
    bus.on('test/emit', (label) => seen.push(label));
    bus.emit('test/emit', 'x');
    expect(seen).toEqual(['x']);
  });

  it('同步拋錯會中斷後面的監聽者並往外拋（events.ts:emit 是一個 map，沒有 try）', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('test/emit', () => {
      throw new Error('炸');
    });
    bus.on('test/emit', (label) => seen.push(label));
    expect(() => bus.emit('test/emit', 'x')).toThrow('炸');
    expect(seen).toEqual([]);
  });

  it('沒有監聽者就什麼都不發生', () => {
    expect(() => new EventBus().emit('test/emit', 'x')).not.toThrow();
  });
});

describe('observe：隔離的 emit（#1248），給生產者不能被觀察者拖下水的事件', () => {
  it('同步拋錯、promise 拒絕都交給 onError，其餘監聽者照跑，observe 自己不拋', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const errors: string[] = [];
    bus.on('test/emit', () => {
      throw new Error('同步壞');
    });
    bus.on('test/emit', () => Promise.reject(new Error('非同步壞')));
    bus.on('test/emit', (label) => seen.push(label));
    expect(() =>
      bus.observe('test/emit', (error) => errors.push((error as Error).message), 'x'),
    ).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual(['x']);
    expect(errors).toEqual(['同步壞', '非同步壞']);
  });

  it('onError 帶出是哪一位壞了（origin、prepend）；onError 自己拋也被吞掉', () => {
    const bus = new EventBus();
    const origin = { plugin: 'p', index: 0 } as never;
    bus.on(
      'test/emit',
      () => {
        throw new Error('壞');
      },
      { prepend: true },
      origin,
    );
    const infos: unknown[] = [];
    expect(() =>
      bus.observe(
        'test/emit',
        (_error, listener) => {
          infos.push(listener);
          throw new Error('回報也壞');
        },
        'x',
      ),
    ).not.toThrow();
    expect(infos).toEqual([{ name: 'test/emit', origin, prepend: true }]);
  });

  it('派發當下取快照：途中新掛上的不參與這一次', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('test/emit', () => {
      bus.on('test/emit', () => seen.push('新的'));
      seen.push('舊的');
    });
    bus.observe('test/emit', () => undefined, 'x');
    expect(seen).toEqual(['舊的']);
  });

  it('沒有監聽者就什麼都不做', () => {
    expect(() => new EventBus().observe('test/emit', () => undefined, 'x')).not.toThrow();
  });
});

describe('serial：依序 await，遇到 bail 值就停', () => {
  it('回傳第一個 bail 值，後面的不跑', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('test/serial', async () => {
      seen.push('a');
      return undefined;
    });
    bus.on('test/serial', async () => {
      seen.push('b');
      return 'stop';
    });
    bus.on('test/serial', () => {
      seen.push('c');
    });
    await expect(bus.serial('test/serial', 'x')).resolves.toBe('stop');
    expect(seen).toEqual(['a', 'b']);
  });

  it('0 與空字串是 bail 值（isBailed 只放過 null、false、undefined）', async () => {
    const bus = new EventBus();
    bus.on('test/serial', () => 0);
    bus.on('test/serial', () => 'later');
    await expect(bus.serial('test/serial', 'x')).resolves.toBe(0);
  });

  it('沒有人 bail 就是 undefined；前一位沒做完，下一位不開始', async () => {
    const bus = new EventBus();
    const order: string[] = [];
    bus.on('test/serial', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('slow');
    });
    bus.on('test/serial', () => {
      order.push('fast');
    });
    await expect(bus.serial('test/serial', 'x')).resolves.toBeUndefined();
    expect(order).toEqual(['slow', 'fast']);
  });
});

describe('waterfall：最後一個參數是最內層 next，由外而內，不呼叫 next 就是否決', () => {
  it('沒有監聽者：直接是最內層', () => {
    expect(new EventBus().waterfall('test/waterfall', 'x', () => 'inner')).toBe('inner');
  });

  it('由外而內：先掛的在外層；每位拿到的 next 呼叫下一位，最後才是最內層；回傳最外層的回傳值', () => {
    const bus = new EventBus();
    const trace: string[] = [];
    bus.on('test/waterfall', (_label, next) => {
      trace.push('a>');
      const inner = next();
      trace.push('<a');
      return `a(${inner})`;
    });
    bus.on('test/waterfall', (label, next) => {
      trace.push('b>');
      return `b(${next()},${label})`;
    });
    const out = bus.waterfall('test/waterfall', 'x', () => {
      trace.push('inner');
      return 'I';
    });
    expect(out).toBe('a(b(I,x))');
    expect(trace).toEqual(['a>', 'b>', 'inner', '<a']);
  });

  it('不呼叫 next 就是否決：後面的監聽者與最內層都不跑', () => {
    const bus = new EventBus();
    let innerRan = false;
    let bRan = false;
    bus.on('test/waterfall', () => 'veto');
    bus.on('test/waterfall', (_label, next) => {
      bRan = true;
      return next();
    });
    const out = bus.waterfall('test/waterfall', 'x', () => {
      innerRan = true;
      return 'I';
    });
    expect(out).toBe('veto');
    expect([bRan, innerRan]).toEqual([false, false]);
  });

  it('可以是非同步：外層 await next() 後再改結果', async () => {
    const bus = new EventBus();
    bus.on('test/waterfall-async', async (_label, next) => `外(${await next()})`);
    await expect(
      bus.waterfall('test/waterfall-async', 'x', () => Promise.resolve('內')),
    ).resolves.toBe('外(內)');
  });
});

describe('掛上與撤銷', () => {
  it('prepend 排到現有監聽者前面', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on('test/emit', () => seen.push('a'));
    bus.on('test/emit', () => seen.push('b'), { prepend: true });
    bus.emit('test/emit', 'x');
    expect(seen).toEqual(['b', 'a']);
  });

  it('派發當下取快照：途中新掛的不參與這一次，途中撤銷的仍在這一次的名單上', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    let undoLater: () => boolean = () => false;
    bus.on('test/emit', () => {
      seen.push('first');
      bus.on('test/emit', () => seen.push('新掛的'));
      undoLater();
    });
    undoLater = bus.on('test/emit', () => seen.push('later'));
    bus.emit('test/emit', 'x');
    expect(seen).toEqual(['first', 'later']);
    seen.length = 0;
    bus.emit('test/emit', 'x');
    expect(seen).toEqual(['first', '新掛的']);
  });

  it('撤銷冪等，回傳撤到了沒有', () => {
    const bus = new EventBus();
    const undo = bus.on('test/emit', () => undefined);
    expect([undo(), undo()]).toEqual([true, false]);
    expect(bus.count('test/emit')).toBe(0);
  });

  it('同一個函式被掛兩次，撤銷只撤自己那一筆（dsh 靠 reflect.bind 讓每筆註冊各有一支 callback，效果相同）', () => {
    const bus = new EventBus();
    const shared = (): undefined => undefined;
    const undoFirst = bus.on('test/emit', shared);
    bus.on('test/emit', shared);
    undoFirst();
    undoFirst();
    expect(bus.count('test/emit')).toBe(1);
  });

  it('once：第一次被呼叫時先撤掉自己；沒被呼叫前可以撤', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.once('test/emit', () => void (calls += 1));
    bus.emit('test/emit', 'x');
    bus.emit('test/emit', 'x');
    expect(calls).toBe(1);
    expect(bus.count('test/emit')).toBe(0);
    const undo = bus.once('test/emit', () => void (calls += 1));
    expect(undo()).toBe(true);
    bus.emit('test/emit', 'x');
    expect(calls).toBe(1);
  });

  it('listeners() 依事件名、再依執行順序；clear() 清空，之後的撤銷是 no-op', () => {
    const bus = new EventBus();
    const undo = bus.on('test/serial', () => undefined);
    bus.on('test/emit', () => undefined, { prepend: false });
    bus.on('test/emit', () => undefined, { prepend: true });
    expect(bus.listeners().map((each) => [each.name, each.prepend])).toEqual([
      ['test/emit', true],
      ['test/emit', false],
      ['test/serial', false],
    ]);
    bus.clear();
    expect(bus.listeners()).toEqual([]);
    expect(undo()).toBe(false);
  });
});
