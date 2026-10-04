import { describe, expect, it } from 'vitest';

import { goalId } from './goal.js';
import {
  currentTurnStart,
  hasUnansweredInterrupt,
  isKnownSessionEventType,
  isLogicalTurnStart,
  isUnreadableSessionEvent,
  MODEL_VISIBLE_EVENT_TYPES,
  openTurnStart,
  SessionLog,
} from './session-log.js';

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

/**
 * 日誌尾巴上有沒有一輪還開著（[#953](https://github.com/DemianLi/nexus-agent/issues/953)）：畫面那一側拿它分「回覆還沒落盤」與「回覆沒有存」。
 * 每一格都配一個對照，免得「永遠回 -1」或「永遠回最後一顆 turn/start」也會綠。
 */
describe('openTurnStart', () => {
  function logOf(script: readonly (readonly [string, unknown])[]): SessionLog {
    const log = new SessionLog('open');
    for (const [type, data] of script)
      log.append(type as 'turn/end', data as Record<string, never>);
    return log;
  }
  const START: readonly [string, unknown] = ['turn/start', { kind: 'message', text: '動手' }];
  const MODEL: readonly [string, unknown] = ['model/start', {}];

  it('最後一輪還沒收尾：回它那顆 turn/start 的位置', () => {
    expect(openTurnStart(logOf([START, MODEL]).events)).toBe(0);
    expect(openTurnStart(logOf([START, ['turn/end', {}], START, MODEL]).events)).toBe(2);
  });

  it('收尾了（完成、拋錯）就是 -1，不論前面有沒有開著過', () => {
    expect(openTurnStart(logOf([START, MODEL, ['turn/end', {}]]).events)).toBe(-1);
    expect(openTurnStart(logOf([START, ['turn/failed', { message: '壞了' }]]).events)).toBe(-1);
  });

  it('停在核准點的那一輪有 turn/end，不算開著；續接它的 resume 一開始就又開著', () => {
    const parked: (readonly [string, unknown])[] = [
      START,
      ['interrupt/raised', { interruptId: 'i-1' }],
      ['turn/end', {}],
    ];
    expect(openTurnStart(logOf(parked).events)).toBe(-1);
    expect(openTurnStart(logOf([...parked, ['turn/start', { kind: 'resume' }]]).events)).toBe(3);
  });

  it('沒有 turn/start、或空的日誌是 -1', () => {
    expect(openTurnStart([])).toBe(-1);
    expect(openTurnStart(logOf([['todo/write', { todos: [] }]]).events)).toBe(-1);
  });

  it('上一個行程留在輪中的，續接之後不算開著（停在 session/end-seed）', () => {
    const before = logOf([START, MODEL]);
    const resumed = new SessionLog('open', { seed: before.events });
    expect(openTurnStart(resumed.events)).toBe(-1);
    resumed.append('turn/start', { kind: 'message', text: '新的一輪' });
    expect(openTurnStart(resumed.events)).toBe(resumed.events.length - 1);
  });
});

/**
 * 續接回來的日誌：**「當前這一段」不往 `session/end-seed` 之前找**
 * （[#251](https://github.com/DemianLi/nexus-agent/issues/251) 的門 A）。
 *
 * 那顆之前的輪屬於上一個行程——開著沒收，是當掉還是被關掉，這裡分不出來也不必分。
 */
describe('當前這一段停在 `session/end-seed`', () => {
  /** 上一個行程的樣子：`events` 裡的每一顆照順序 append。 */
  function earlier(build: (log: SessionLog) => void): SessionLog {
    const log = new SessionLog('seed');
    build(log);
    return new SessionLog('seed', { seed: log.events });
  }

  it('上一個行程當在輪中：續接之後這個行程裡一輪都還沒開始', () => {
    const resumed = earlier((log) => {
      log.append('turn/start', { kind: 'message', text: '跑到一半' });
    });
    expect(currentTurnStart(resumed.events)).toBe(-1);
    // 反例：同一串事件不經 seed，頭就是那一顆。
    expect(currentTurnStart(resumed.events.slice(0, -1))).toBe(0);
  });

  it('續接之後開的第一輪就是當前這一段的頭', () => {
    const resumed = earlier((log) => {
      log.append('turn/start', { kind: 'message', text: '跑到一半' });
    });
    resumed.append('turn/start', { kind: 'message', text: '新的一輪' });
    expect(currentTurnStart(resumed.events)).toBe(2);
  });

  /**
   * 停在核准點收工的日誌：那張卡住在 checkpointer 裡，這個行程沒有人答得了。
   *
   * **照實記下它的作用面有多窄**：不停在 end-seed 的話，續行判的是 `interrupt-pending`；
   * 停了判的是 `no-turn`。兩個都是閒著，而人一開口就開了新的一輪、當前這一段跟著換掉——
   * 所以這一格差的是「閒著的理由講不講得對」，不是續行排不排得出來。
   */
  it('上一個行程停在核准點：續接之後不說「有一顆中斷等著人答」', () => {
    const resumed = earlier((log) => {
      log.append('turn/start', { kind: 'message', text: '要寫檔' });
      log.append('interrupt/raised', { interruptId: 'i-1' });
      log.append('turn/end', {});
    });
    expect(hasUnansweredInterrupt(resumed.events)).toBe(false);
    // 反例：不經 seed 的話，那一顆中斷就在當前這一段裡。
    expect(hasUnansweredInterrupt(resumed.events.slice(0, -1))).toBe(true);
  });
});

describe('isLogicalTurnStart（#682）', () => {
  it('message、goal 的 turn/start 開新的邏輯輪；resume 不開；不是 turn/start 的不開', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '嗨' });
    log.append('turn/start', {
      kind: 'goal',
      text: '續',
      goalId: goalId('g-1'),
      revision: 1,
      round: 1,
    });
    log.append('turn/start', { kind: 'resume' });
    log.append('turn/end', {});
    expect(log.events.map(isLogicalTurnStart)).toEqual([true, true, false, false]);
  });
});

/**
 * 格式版本 32 時詞彙裡的每一種（[#507](https://github.com/DemianLi/nexus-agent/issues/507)）。**只增不減，這份清單也只增不減**：
 * 缺席＝必需，所以任何一版寫過的種類，之後每一版都必須認得，否則那份舊日誌從此讀不回來。要退役一種，它留在
 * `KNOWN_SESSION_EVENT_TABLE` 裡、只是不再寫；這裡要拿掉某一行的人，等於宣布「那一類舊日誌從此不能讀」。
 */
const TYPES_WRITTEN_BY_FORMAT_32 = [
  'turn/start',
  'turn/end',
  'turn/failed',
  'interrupt/raised',
  'command/run',
  'command/done',
  'goal/change',
  'todo/write',
  'model/usage',
  'model/start',
  'model/end',
  'llm/retry',
  'llm/retry-started',
  'assistant/message',
  'user/message',
  'compaction/summary',
  'context/measure',
  'sandbox/mode',
  'plan/mode',
  'subagent/model-selection-policy',
  'subagent/catalog',
  'tool/call',
  'tool/result',
  'feedback/message-put',
  'feedback/message-delete',
  'feedback/record',
  'deliverables/presented',
  'workspace/changes',
  'inbox/spliced',
  'session/title',
  'session/title-llm-request',
  'session/end-seed',
] as const;

describe('認得的事件種類與可忽略旗標（#507）', () => {
  it('格式版本 32 寫過的每一種，這一版都認得', () => {
    for (const type of TYPES_WRITTEN_BY_FORMAT_32) {
      expect(isKnownSessionEventType(type), type).toBe(true);
    }
  });

  it('表外的不認得，包括物件原型上的名字', () => {
    for (const type of [
      'future/thing',
      'turn/start ',
      '',
      'constructor',
      '__proto__',
      'toString',
    ]) {
      expect(isKnownSessionEventType(type), JSON.stringify(type)).toBe(false);
    }
  });

  it('不認得又沒標可忽略的，讀方必須拒絕；只有字面的 true 算標了', () => {
    expect(isUnreadableSessionEvent({ type: 'future/thing' })).toBe(true);
    expect(isUnreadableSessionEvent({ type: 'future/thing', ignorable: true })).toBe(false);
    for (const loose of [false, 'true', 1, null, {}]) {
      expect(
        isUnreadableSessionEvent({ type: 'future/thing', ignorable: loose }),
        String(loose),
      ).toBe(true);
    }
  });

  it('認得的種類標不標都能讀：標記只對不認得的有作用', () => {
    expect(isUnreadableSessionEvent({ type: 'turn/end' })).toBe(false);
    expect(isUnreadableSessionEvent({ type: 'turn/end', ignorable: true })).toBe(false);
  });

  it('append 帶 { ignorable: true } 的那一筆有這一格，凍著；沒帶的連這個鍵都沒有', () => {
    const log = new SessionLog('t');
    const plain = log.append('turn/end', {});
    const marked = log.append(
      'llm/retry-started',
      { retryId: 'r-1', retry: 1, waitedMs: 0 },
      { ignorable: true },
    );

    expect('ignorable' in plain).toBe(false);
    expect(marked.ignorable).toBe(true);
    expect(JSON.parse(JSON.stringify(marked))).toMatchObject({
      type: 'llm/retry-started',
      ignorable: true,
    });
    expect(() => {
      (marked as { ignorable?: true }).ignorable = undefined;
    }).toThrow(TypeError);
    // 沒帶選項的，位元組跟以前一樣——既有種類的落盤格式不因為這一刀改變。
    expect(Object.keys(plain)).toEqual(['type', 'seq', 'time', 'data']);
  });

  it('會進模型的種類標可忽略會當場拋，日誌不變：略過它就是對話少一截', () => {
    const log = new SessionLog('t');
    for (const type of MODEL_VISIBLE_EVENT_TYPES) {
      expect(() => log.append(type, {} as never, { ignorable: true }), type).toThrow(
        /會進模型，不能標可忽略/,
      );
    }
    expect(log.length).toBe(0);
  });

  it('seed 接上來的標記原樣活過', () => {
    const resumed = new SessionLog('t', {
      seed: [{ type: 'turn/end', seq: 0, time: 1, data: {}, ignorable: true }],
    });
    expect(resumed.events[0]?.ignorable).toBe(true);
  });
});
