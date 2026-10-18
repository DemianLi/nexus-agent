/**
 * 時間讀數（[#1625](https://github.com/DemianLi/nexus-agent/issues/1625)）的單元驗收：文字格式、日誌摺出來的事實、節流。
 *
 * 時間一律固定：`vi.useFakeTimers({ toFake: ['Date'] })` 加 `vi.setSystemTime`，同 dsh 的測試（`tests/time-context.spec.ts:24-37`）；
 * 日誌的 `time` 就是 `Date.now()`，所以「推進 15 分鐘」只要改系統時間。進產品組裝之後的驗收（A–L）在 `apps/harness` 的 `time-context-on-tree.test.ts`。
 *
 * 每一條驗收都配反例：「第三行不是 `0s`」配「真的 0 才寫 `0s`」，「10 分鐘內不注入」配「剛好 10 分鐘就注入」。
 */

import { AIMessage } from '@langchain/core/messages';
import { SessionLog, toLoggedMessage } from '@nexus/core';
import type { SessionLookup } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Config,
  DEFAULT_REFRESH_INTERVAL_MS,
  TIME_CONTEXT_MARKER,
  TIME_CONTEXT_MIDDLEWARE_NAME,
  createTimeContextListener,
  createTimestampFormatter,
  foldTimeContext,
  formatDuration,
  formatTimestamp,
  renderTimeContext,
  validateRefreshInterval,
} from './index.js';

const T0 = Date.parse('2026-10-18T01:00:00Z');
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

const at = (offsetMs: number): void => {
  vi.setSystemTime(T0 + offsetMs);
};

const reply = (text: string) => ({ message: toLoggedMessage(new AIMessage({ content: text })) });

/** 一顆讀數在日誌上的樣子：宿主記的那一顆 `user/message`，來源是本插件。 */
function recordInjection(log: SessionLog, text: string): void {
  log.append('user/message', {
    message: toLoggedMessage(new AIMessage({ content: text })),
    source: { kind: 'plugin', plugin: TIME_CONTEXT_MIDDLEWARE_NAME },
  });
}

const taipei = createTimestampFormatter('Asia/Taipei');

describe('文字格式', () => {
  it('第一行帶偏移與 IANA 時區；UTC 的 GMT 補成 +00:00', () => {
    expect(formatTimestamp(T0, taipei, 'Asia/Taipei')).toBe(
      '2026-10-18T09:00:00+08:00[Asia/Taipei]',
    );
    expect(formatTimestamp(T0, createTimestampFormatter('UTC'), 'UTC')).toBe(
      '2026-10-18T01:00:00+00:00[UTC]',
    );
  });

  it('三行逐字：第 1 步、沒有基線', () => {
    expect(renderTimeContext(T0, 1, 1, undefined, taipei, 'Asia/Taipei')).toBe(
      [
        'Time sampled while preparing turn 1, step 1: 2026-10-18T09:00:00+08:00[Asia/Taipei]',
        'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.',
        'Elapsed since the preceding model-visible message: unavailable.',
      ].join('\n'),
    );
  });

  it('後面的步第三行講 step context；有基線寫時長', () => {
    const text = renderTimeContext(T0 + 90_061_000, 3, 2, T0, taipei, 'Asia/Taipei');
    expect(text.split('\n')[2]).toBe('Elapsed since the preceding step context: 1d 1h 1m 1s.');
    expect(text.split('\n')[0]).toContain('turn 3, step 2');
  });

  it('時長：整秒、零的單位省略、秒一定寫；牆鐘倒退鉗成 0s', () => {
    expect(formatDuration(90_061_000)).toBe('1d 1h 1m 1s');
    expect(formatDuration(15 * MIN)).toBe('15m 0s');
    expect(formatDuration(999)).toBe('0s');
    expect(formatDuration(-5000)).toBe('0s');
  });
});

describe('設定', () => {
  it('間隔：非負的安全整數才過；預設是 10 分鐘', () => {
    expect(DEFAULT_REFRESH_INTERVAL_MS).toBe(10 * MIN);
    expect(() => validateRefreshInterval(0)).not.toThrow();
    expect(() => validateRefreshInterval(600_000)).not.toThrow();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) {
      expect(() => validateRefreshInterval(bad)).toThrow('non-negative safe integer');
    }
  });

  it('不是 IANA 名的時區建不出格式器；未知欄位讓 schema 拒絕', () => {
    expect(() => createTimestampFormatter('Asia/Taipe')).toThrow();
    expect(Config.safeParse({ timeZone: 'Asia/Taipei', refreshIntervalMs: 0 }).success).toBe(true);
    expect(Config.safeParse({}).success).toBe(true);
    expect(Config.safeParse({ extra: 1 }).success).toBe(false);
  });
});

describe('foldTimeContext：從日誌摺出事實', () => {
  it('第 1 步的基線取這一輪之前最後一則模型看得到的事件，不算這一輪自己的', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '第一句' });
    at(5_000);
    log.append('assistant/message', reply('好'));
    at(15 * MIN);
    log.append('turn/start', { kind: 'message', text: '第二句' });
    recordInjection(log, 'AGENTS 基線');

    const facts = foldTimeContext(log.events);
    expect(facts.turn).toBe(2);
    expect(facts.step).toBe(1);
    // 基線是第一輪的助理回覆（T0+5s），不是這一輪的 turn/start 或基線訊息（那樣第三行會永遠是 0s）。
    expect(facts.baselineBeforeTurn).toBe(T0 + 5_000);
  });

  it('前幾輪 turn/start 帶的人話也算（dsh 把人話記成 user/message，我們記在 turn/start）', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '第一句' });
    at(10 * MIN);
    log.append('turn/start', { kind: 'message', text: '第二句' });

    expect(foldTimeContext(log.events).baselineBeforeTurn).toBe(T0);
  });

  it('第一輪、或日誌上沒有 turn/start（同步子代理）：沒有基線', () => {
    const first = new SessionLog('t');
    first.append('turn/start', { kind: 'message', text: '嗨' });
    expect(foldTimeContext(first.events).baselineBeforeTurn).toBeNull();

    const sub = new SessionLog('t/sub');
    sub.append('user/message', {
      message: toLoggedMessage(new AIMessage({ content: '任務' })),
      source: { kind: 'user' },
    });
    const facts = foldTimeContext(sub.events);
    expect(facts.baselineBeforeTurn).toBeNull();
    expect(facts.turn).toBe(1);
    expect(facts.step).toBe(1);
  });

  it('resume 的 turn/start 不開新的一輪：輪數不加、基線仍是上一輪', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '一' });
    at(1_000);
    log.append('assistant/message', reply('二'));
    at(2_000);
    log.append('turn/start', { kind: 'message', text: '三' });
    log.append('model/start', {});
    at(3_000);
    log.append('turn/start', { kind: 'resume' });

    const facts = foldTimeContext(log.events);
    expect(facts.turn).toBe(2);
    expect(facts.baselineBeforeTurn).toBe(T0 + 1_000);
    // 這一輪已經叫過一次模型，核准後續接的 invoke 是第 2 步。
    expect(facts.step).toBe(2);
  });

  it('注入的時間記在 lastInjectionTime；這一輪的那一格在每個 turn/start、turn/end 清掉', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '一' });
    at(1_000);
    recordInjection(log, '讀數');
    expect(foldTimeContext(log.events)).toMatchObject({
      lastInjectionTime: T0 + 1_000,
      lastTurnInjectionTime: T0 + 1_000,
    });

    at(2_000);
    log.append('turn/end', {});
    expect(foldTimeContext(log.events)).toMatchObject({
      lastInjectionTime: T0 + 1_000,
      lastTurnInjectionTime: null,
    });
  });

  it('別的插件寫的 user/message 不算本插件的注入', () => {
    const log = new SessionLog('t');
    log.append('user/message', {
      message: toLoggedMessage(new AIMessage({ content: '基線' })),
      source: { kind: 'plugin', plugin: 'AgentInstructionsMiddleware' },
    });
    expect(foldTimeContext(log.events).lastInjectionTime).toBeNull();
  });
});

describe('listener：節流與內容', () => {
  const okLookup = (log: SessionLog) => (): SessionLookup => ({
    kind: 'ok',
    address: { kind: 'root' },
    log,
  });

  function makeListener(log: SessionLog, refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS) {
    return createTimeContextListener({
      refreshIntervalMs,
      formatter: taipei,
      timeZone: 'Asia/Taipei',
      lookup: okLookup(log),
    });
  }

  /** 叫一次 listener；注入了就像宿主那樣把那顆 `user/message` 記進日誌。 */
  async function invoke(log: SessionLog, listener: ReturnType<typeof makeListener>) {
    const result = await listener([], { configurable: {} });
    if (result !== undefined) recordInjection(log, result[0]?.content ?? '');
    return result;
  }

  it('同一條 thread 10 分鐘內第二輪不注入；剛好 10 分鐘注入', async () => {
    const log = new SessionLog('t');
    const listener = makeListener(log);
    log.append('turn/start', { kind: 'message', text: '一' });
    expect(await invoke(log, listener)).toHaveLength(1);

    at(10 * MIN - 1);
    log.append('turn/start', { kind: 'message', text: '二' });
    expect(await invoke(log, listener)).toBeUndefined();

    at(10 * MIN);
    log.append('turn/start', { kind: 'message', text: '三' });
    expect(await invoke(log, listener)).toHaveLength(1);
  });

  it('refreshIntervalMs 是 0：每次都注入（不是關掉）', async () => {
    const log = new SessionLog('t');
    const listener = makeListener(log, 0);
    log.append('turn/start', { kind: 'message', text: '一' });
    expect(await invoke(log, listener)).toHaveLength(1);
    expect(await invoke(log, listener)).toHaveLength(1);
  });

  it('牆鐘倒退：不擋（免得時鐘被調回之後永遠不再注入）', async () => {
    const log = new SessionLog('t');
    const listener = makeListener(log);
    log.append('turn/start', { kind: 'message', text: '一' });
    at(5 * MIN);
    await invoke(log, listener);
    at(MIN);
    expect(await invoke(log, listener)).toHaveLength(1);
  });

  it('兩條 thread 不共用節流狀態', async () => {
    const [a, b] = [new SessionLog('a'), new SessionLog('b')];
    a.append('turn/start', { kind: 'message', text: '一' });
    b.append('turn/start', { kind: 'message', text: '一' });
    const listenerA = makeListener(a);
    const listenerB = makeListener(b);
    expect(await invoke(a, listenerA)).toHaveLength(1);
    expect(await invoke(b, listenerB)).toHaveLength(1);
  });

  it('第二輪的第三行是上一則模型看得到的事件到現在的時長，不是 0s', async () => {
    const log = new SessionLog('t');
    const listener = makeListener(log, 0);
    log.append('turn/start', { kind: 'message', text: '一' });
    at(1_000);
    log.append('assistant/message', reply('好'));
    at(15 * MIN);
    log.append('turn/start', { kind: 'message', text: '二' });

    const [injection] = (await invoke(log, listener)) ?? [];
    expect(injection?.content.split('\n')[2]).toBe(
      'Elapsed since the preceding model-visible message: 14m 59s.',
    );
    expect(injection?.content.split('\n')[0]).toContain('turn 2, step 1');
  });

  it('讀數帶記號，記號裡是取樣時間', async () => {
    const log = new SessionLog('t');
    const [injection] = (await makeListener(log)([], { configurable: {} })) ?? [];
    expect(injection?.additionalKwargs).toEqual({ [TIME_CONTEXT_MARKER]: { sampledAt: T0 } });
  });

  it('查找不是 ok：照樣注入、時長 unavailable；節流退回看 visible 上的記號', async () => {
    const listener = createTimeContextListener({
      refreshIntervalMs: DEFAULT_REFRESH_INTERVAL_MS,
      formatter: taipei,
      timeZone: 'Asia/Taipei',
      lookup: () => ({ kind: 'not-attached' }),
    });
    const first = await listener([], { configurable: {} });
    expect(first).toHaveLength(1);
    expect(first?.[0]?.content).toContain(
      'Elapsed since the preceding model-visible message: unavailable.',
    );

    const visible = [
      new AIMessage({
        content: first?.[0]?.content ?? '',
        additional_kwargs: first?.[0]?.additionalKwargs ?? {},
      }),
    ];
    at(MIN);
    expect(await listener(visible, { configurable: {} })).toBeUndefined();
    at(10 * MIN);
    expect(await listener(visible, { configurable: {} })).toHaveLength(1);
  });
});
