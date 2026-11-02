import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentClient } from '@/lib/agent';
import { clockedFetch, createServerClock, serverClock } from '@/lib/server-clock';

/** 整秒的 server 時刻（標頭只到秒，整秒時區間中點正好比真值晚 500ms）。 */
const SERVER_AT = Date.UTC(2026, 9, 10, 3, 0, 0);
const header = (at: number) => new Date(at).toUTCString();

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  serverClock.reset();
});

describe('createServerClock：從 Date 標頭換算時鐘差（#1308）', () => {
  it('沒有樣本就答不出，不猜 0', () => {
    const clock = createServerClock();
    expect(clock.offset()).toBeUndefined();
    expect(clock.now()).toBeUndefined();
  });

  it.each([
    ['瀏覽器慢 5 分鐘', 5 * 60_000],
    ['瀏覽器快 7 分鐘', -7 * 60_000],
  ])('%s：偏移落在真值的一秒之內', (_, truth) => {
    const clock = createServerClock();
    const browserAt = SERVER_AT - truth;
    clock.observe(header(SERVER_AT), browserAt - 30, browserAt + 30);
    expect(Math.abs(clock.offset()! - truth)).toBeLessThanOrEqual(1000);
    vi.useFakeTimers({ now: browserAt + 4000, toFake: ['Date'] });
    expect(Math.abs(clock.now()! - (SERVER_AT + 4000))).toBeLessThanOrEqual(1000);
  });

  it('多筆取交集：越收越窄，中點更接近真值', () => {
    const truth = 123_456;
    const clock = createServerClock();
    // 第一筆：server 在整秒；第二筆：server 在那一秒的 .9，標頭寫的是同一秒往下取整。
    clock.observe(header(SERVER_AT), SERVER_AT - truth - 10, SERVER_AT - truth + 10);
    const first = Math.abs(clock.offset()! - truth);
    const later = SERVER_AT + 60_900;
    clock.observe(header(later), later - truth - 10, later - truth + 10);
    const second = Math.abs(clock.offset()! - truth);
    expect(second).toBeLessThan(first);
    // 交集是 (真值 − 10, 真值 + 110)，中點晚 50ms。
    expect(second).toBeLessThanOrEqual(60);
  });

  it('交集變空（某一邊的時鐘被調過）：從最新那一筆重來', () => {
    const clock = createServerClock();
    clock.observe(header(SERVER_AT), SERVER_AT - 10, SERVER_AT + 10);
    expect(Math.abs(clock.offset()!)).toBeLessThanOrEqual(1000);
    const jumped = SERVER_AT + 3_600_000;
    clock.observe(header(jumped), jumped - 600_000 - 10, jumped - 600_000 + 10);
    expect(Math.abs(clock.offset()! - 600_000)).toBeLessThanOrEqual(1000);
  });

  it('讀不懂的標頭、缺席的標頭（跨源讀到 null）、收比送早的：都不算樣本', () => {
    const clock = createServerClock();
    clock.observe(null, 0, 1);
    clock.observe(undefined, 0, 1);
    clock.observe('not a date', 0, 1);
    clock.observe(header(SERVER_AT), 10, 5);
    expect(clock.offset()).toBeUndefined();
  });
});

describe('clockedFetch', () => {
  it('每次呼叫才讀 globalThis.fetch，回應原封不動，標頭記成樣本', async () => {
    const clock = createServerClock();
    const wrapped = clockedFetch(clock);
    const response = new Response('ok', { headers: { date: header(SERVER_AT) } });
    const fake = vi.fn(async () => response);
    vi.stubGlobal('fetch', fake);
    vi.useFakeTimers({ now: SERVER_AT - 90_000, toFake: ['Date'] });
    await expect(wrapped('/x', { method: 'GET' })).resolves.toBe(response);
    expect(fake).toHaveBeenCalledWith('/x', { method: 'GET' });
    expect(Math.abs(clock.offset()! - 90_000)).toBeLessThanOrEqual(1000);
  });

  it('假的回應沒有 headers：不拋、沒有樣本', async () => {
    const clock = createServerClock();
    const bare = { ok: true } as unknown as Response;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => bare),
    );
    await expect(clockedFetch(clock)('/x')).resolves.toBe(bare);
    expect(clock.offset()).toBeUndefined();
  });

  it('createAgentClient 沒注入 fetch 時，預設就記到 serverClock', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ type: 'success', result: { items: [], unreadable: 0 } }), {
            headers: { 'content-type': 'application/json', date: header(SERVER_AT) },
          }),
      ),
    );
    vi.useFakeTimers({ now: SERVER_AT + 300_000, toFake: ['Date'] });
    await createAgentClient({ baseUrl: '' }).listThreads();
    expect(Math.abs(serverClock.offset()! + 300_000)).toBeLessThanOrEqual(1000);
  });
});
