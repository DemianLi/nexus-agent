/**
 * 時間讀數（[#1625](https://github.com/DemianLi/nexus-agent/issues/1625)）的單元驗收：文字格式、日誌摺出來的事實、節流。
 *
 * 時間一律固定：`vi.useFakeTimers({ toFake: ['Date'] })` 加 `vi.setSystemTime`，同 dsh 的測試（`tests/time-context.spec.ts:24-37`）；
 * 日誌的 `time` 就是 `Date.now()`，所以「推進 15 分鐘」只要改系統時間。進產品組裝之後的驗收（A–L）在 `apps/harness` 的 `time-context-on-tree.test.ts`。
 *
 * 每一條驗收都配反例：「第三行不是 `0s`」配「真的 0 才寫 `0s`」，「10 分鐘內不注入」配「剛好 10 分鐘就注入」。
 */

import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { PreStepListener } from '@nexus/agent-loop';
import { SessionLog, toLoggedMessage } from '@nexus/core';
import type { SessionLookup } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  Config,
  DEFAULT_REFRESH_INTERVAL_MS,
  TIME_CONTEXT_MARKER,
  TIME_CONTEXT_MIDDLEWARE_NAME,
  apply,
  createTimeContextListener,
  createTimestampFormatter,
  deriveBrowserTimeZoneContext,
  foldTimeContext,
  formatDuration,
  formatTimestamp,
  renderBrowserTimeZoneContext,
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
    // 這一輪已經叫過一次模型，所以若有 invoke 在這之後進來，是第 2 步。（今天核准續接走被中斷的那張圖、不重進 beforeAgent，
    // 見 harness `time-context-on-tree.test.ts` 的「核准續接」；這條折疊規則是防禦。）
    expect(facts.step).toBe(2);
  });

  it('這一輪之前最後一則模型看得到的事件是 compaction/summary 時，基線取它', () => {
    const log = new SessionLog('t');
    log.append('turn/start', { kind: 'message', text: '一' });
    at(1_000);
    log.append('assistant/message', reply('好'));
    at(2_000);
    // 摘要器在一輪結束後才寫摘要：它是模型下一次看到的歷史的一部分（`isModelVisibleEvent` 認它）。
    log.append('compaction/summary', {
      cutoffIndex: 1,
      messagesBefore: 2,
      filePath: null,
      summary: toLoggedMessage(new HumanMessage({ content: '摘要' })),
    });
    at(15 * MIN);
    log.append('turn/start', { kind: 'message', text: '二' });

    expect(foldTimeContext(log.events).baselineBeforeTurn).toBe(T0 + 2_000);
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

  it('牆鐘倒退：不擋（免得時鐘被調回之後永遠不再注入），第三行鉗成 0s', async () => {
    const log = new SessionLog('t');
    const listener = makeListener(log);
    log.append('turn/start', { kind: 'message', text: '一' });
    at(5 * MIN);
    log.append('assistant/message', reply('好'));
    await invoke(log, listener);
    log.append('turn/start', { kind: 'message', text: '二' });
    // 時鐘被調回 4 分鐘：上一則可見事件（5 分）比現在（1 分）還晚。
    at(MIN);
    const [injection] = (await invoke(log, listener)) ?? [];
    expect(injection).toBeDefined();
    // 倒退的差距不能寫成負數（上面 `formatDuration(-5000)` 是單元；這裡問 listener 真的把它寫進第三行）。
    expect(injection?.content.split('\n')[2]).toBe(
      'Elapsed since the preceding model-visible message: 0s.',
    );
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

/** 一句帶（或不帶）時區的人話在日誌上的兩種位置：輪開頭在 `turn/start`、輪中插話在 `user/message`。 */
function humanTurn(log: SessionLog, text: string, clientTimeZone?: string): void {
  log.append('turn/start', {
    kind: 'message',
    text,
    ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
  });
}
function humanInterjection(log: SessionLog, clientTimeZone?: string): void {
  log.append('user/message', {
    message: toLoggedMessage(new AIMessage({ content: '插話' })),
    source: { kind: 'user', ...(clientTimeZone === undefined ? {} : { clientTimeZone }) },
  });
}

describe('瀏覽器時區：三種讀數（#1629，dsh src/request-zone.ts）', () => {
  it('derive：沒有、一個、同一個（去重）、不同（排序）→ missing／resolved／resolved／mixed', () => {
    const none = new SessionLog('t');
    humanTurn(none, '嗨');
    expect(deriveBrowserTimeZoneContext(none.events)).toStrictEqual({ kind: 'missing' });

    const one = new SessionLog('t');
    humanTurn(one, '嗨', 'Asia/Taipei');
    expect(deriveBrowserTimeZoneContext(one.events)).toEqual({
      kind: 'resolved',
      timeZone: 'Asia/Taipei',
    });

    const same = new SessionLog('t');
    humanTurn(same, '嗨', 'Asia/Taipei');
    humanInterjection(same, 'Asia/Taipei');
    expect(deriveBrowserTimeZoneContext(same.events)).toEqual({
      kind: 'resolved',
      timeZone: 'Asia/Taipei',
    });

    const mixed = new SessionLog('t');
    humanTurn(mixed, '嗨', 'Asia/Taipei');
    humanInterjection(mixed, 'America/New_York');
    expect(deriveBrowserTimeZoneContext(mixed.events)).toEqual({
      kind: 'mixed',
      timeZones: ['America/New_York', 'Asia/Taipei'],
    });
  });

  it('只有人話算：插件、子代理來源的 user/message 帶不帶都不影響', () => {
    const log = new SessionLog('t');
    humanTurn(log, '嗨', 'Asia/Taipei');
    log.append('user/message', {
      message: toLoggedMessage(new AIMessage({ content: '讀數' })),
      source: { kind: 'plugin', plugin: TIME_CONTEXT_MIDDLEWARE_NAME },
    });
    // 沒帶時區的人話（舊客戶端）不會把 resolved 變成 mixed，也不會變成 missing。
    humanInterjection(log);
    expect(deriveBrowserTimeZoneContext(log.events)).toEqual({
      kind: 'resolved',
      timeZone: 'Asia/Taipei',
    });
  });

  it('格式不對、Intl 不認得的時區：拋 TypeError（dsh `request-zone.spec.ts`）', () => {
    for (const bad of ['', 'Taipei', ' Asia/Taipei', 'Asia/Nowhere_City', 'asia/../etc']) {
      const log = new SessionLog('t');
      humanTurn(log, '嗨', bad);
      expect(() => deriveBrowserTimeZoneContext(log.events), bad).toThrow(TypeError);
    }
  });

  it('逐字照 dsh：有效但不等於這個執行期正規名的別名也拋（dsh `request-zone.spec.ts:52`）；正規名那個照收', () => {
    // 哪一個是正規名看執行期（Node 25.9 是 Asia/Calcutta；風險見 #1733），所以兩個都試，用 Intl 自己的回答分辨。
    const canonicalOf = (zone: string): string =>
      new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    const [canonical] = ['Asia/Calcutta', 'Asia/Kolkata'].filter(
      (zone) => canonicalOf(zone) === zone,
    );
    const [alias] = ['Asia/Calcutta', 'Asia/Kolkata'].filter((zone) => canonicalOf(zone) !== zone);
    expect(canonical).toBeDefined();
    expect(alias).toBeDefined();

    const accepted = new SessionLog('t');
    humanTurn(accepted, '嗨', canonical);
    expect(deriveBrowserTimeZoneContext(accepted.events)).toStrictEqual({
      kind: 'resolved',
      timeZone: canonical,
    });
    const rejected = new SessionLog('t');
    humanTurn(rejected, '嗨', alias);
    expect(() => deriveBrowserTimeZoneContext(rejected.events)).toThrow('must be canonical');
  });

  it('render：三種字樣逐字照 dsh', () => {
    expect(renderBrowserTimeZoneContext({ kind: 'resolved', timeZone: 'Asia/Taipei' })).toBe(
      'Browser time zone for this request: Asia/Taipei. Interpret otherwise-unqualified dates and times in this zone.',
    );
    expect(
      renderBrowserTimeZoneContext({
        kind: 'mixed',
        timeZones: ['America/New_York', 'Asia/Taipei'],
      }),
    ).toBe(
      'Browser time zone for this request: mixed ["America/New_York","Asia/Taipei"]. Ask the user to clarify otherwise-unqualified dates and times.',
    );
    expect(renderBrowserTimeZoneContext({ kind: 'missing' })).toBe(
      'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.',
    );
  });

  it('舊名字只擋它自己那一輪：下一輪重新記的正規名照收，fold 不再看到上一輪的別名（#1733）', () => {
    const canonicalOf = (zone: string): string =>
      new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
    const [canonical] = ['Asia/Calcutta', 'Asia/Kolkata'].filter(
      (zone) => canonicalOf(zone) === zone,
    );
    const [alias] = ['Asia/Calcutta', 'Asia/Kolkata'].filter((zone) => canonicalOf(zone) !== zone);
    expect(canonical).toBeDefined();
    expect(alias).toBeDefined();

    // 升 Node 之前寫下的別名，這一輪還沒收完就被新 runtime 讀到：這一輪拋。
    const log = new SessionLog('t');
    humanTurn(log, '一', alias);
    expect(() => foldTimeContext(log.events)).toThrow('must be canonical');

    // 下一個 `run.start` 的新一輪由現在的 runtime 重新正規化，上一輪的別名不在這一輪的範圍裡。
    at(MIN);
    humanTurn(log, '二', canonical);
    expect(foldTimeContext(log.events).browser).toEqual({ kind: 'resolved', timeZone: canonical });
  });

  it('fold：只看這一輪——上一輪的時區不外溢，resume 的 turn/start 不重置', () => {
    const log = new SessionLog('t');
    humanTurn(log, '一', 'America/New_York');
    at(MIN);
    humanTurn(log, '二');
    expect(foldTimeContext(log.events).browser).toEqual({ kind: 'missing' });

    at(2 * MIN);
    humanTurn(log, '三', 'Asia/Taipei');
    log.append('turn/start', { kind: 'resume' });
    humanInterjection(log, 'Asia/Tokyo');
    expect(foldTimeContext(log.events).browser).toEqual({
      kind: 'mixed',
      timeZones: ['Asia/Taipei', 'Asia/Tokyo'],
    });
  });

  it('沒有 turn/start 的日誌（同步子代理）：missing', () => {
    const sub = new SessionLog('t/sub');
    humanInterjection(sub, 'Asia/Taipei');
    expect(foldTimeContext(sub.events).browser).toEqual({ kind: 'missing' });
  });

  describe('listener：第二行與第一行時鐘', () => {
    const run = async (log: SessionLog) => {
      const listener = createTimeContextListener({
        refreshIntervalMs: 0,
        formatter: createTimestampFormatter('UTC'),
        timeZone: 'UTC',
        lookup: () => ({ kind: 'ok', address: { kind: 'root' }, log }),
      });
      const [injection] = (await listener([], { configurable: {} })) ?? [];
      return injection?.content.split('\n') ?? [];
    };

    it('resolved：第一行時鐘改用使用者時區，第二行請模型照這個時區解讀', async () => {
      const log = new SessionLog('t');
      humanTurn(log, '嗨', 'Asia/Taipei');
      const lines = await run(log);
      expect(lines[0]).toBe(
        'Time sampled while preparing turn 1, step 1: 2026-10-18T09:00:00+08:00[Asia/Taipei]',
      );
      expect(lines[1]).toBe(
        'Browser time zone for this request: Asia/Taipei. Interpret otherwise-unqualified dates and times in this zone.',
      );
    });

    it('mixed：第一行退回回退時區，第二行列出全部並請模型確認', async () => {
      const log = new SessionLog('t');
      humanTurn(log, '嗨', 'Asia/Taipei');
      humanInterjection(log, 'America/New_York');
      const lines = await run(log);
      expect(lines[0]).toBe(
        'Time sampled while preparing turn 1, step 1: 2026-10-18T01:00:00+00:00[UTC]',
      );
      expect(lines[1]).toBe(
        'Browser time zone for this request: mixed ["America/New_York","Asia/Taipei"]. Ask the user to clarify otherwise-unqualified dates and times.',
      );
    });

    it('missing：第一行用回退時區，第二行 unavailable', async () => {
      const log = new SessionLog('t');
      humanTurn(log, '嗨');
      const lines = await run(log);
      expect(lines[0]).toContain('[UTC]');
      expect(lines[1]).toBe(
        'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.',
      );
    });

    it('查找回 ok、位址是子代理、日誌裡有帶時區的 turn/start：第二行是 resolved（分得出「查到了」與「退回」）', async () => {
      // 同步子代理的日誌正常沒有 turn/start；這裡手放一顆，等於那份日誌有東西可讀。
      // 插件若只認 root 位址、或查到了不讀，這一條會變成 unavailable。
      const log = new SessionLog('t/sub');
      humanTurn(log, '任務', 'Asia/Taipei');
      const listener = createTimeContextListener({
        refreshIntervalMs: 0,
        formatter: createTimestampFormatter('UTC'),
        timeZone: 'UTC',
        lookup: () => ({ kind: 'ok', address: { kind: 'subagent', runId: 'tools:worker-1' }, log }),
      });
      const [injection] = (await listener([], { configurable: {} })) ?? [];
      expect(injection?.content.split('\n')[1]).toBe(
        'Browser time zone for this request: Asia/Taipei. Interpret otherwise-unqualified dates and times in this zone.',
      );
    });

    it('查找不是 ok：沒有日誌可讀，退回 missing', async () => {
      const listener = createTimeContextListener({
        refreshIntervalMs: 0,
        formatter: taipei,
        timeZone: 'Asia/Taipei',
        lookup: () => ({ kind: 'not-attached' }),
      });
      const [injection] = (await listener([], { configurable: {} })) ?? [];
      expect(injection?.content.split('\n')[1]).toContain('unavailable');
    });
  });
});

describe('apply：時區在載入當下解析並留住（dsh tests/time-context.spec.ts:371、:383）', () => {
  const ctxWithServices = (): { ctx: never; captured: PreStepListener[] } => {
    const captured: PreStepListener[] = [];
    const services = new Map<string, unknown>([
      [
        'agentLoop',
        { preStep: (_name: string, listener: PreStepListener) => captured.push(listener) },
      ],
      ['sessionLookup', { forCall: (): SessionLookup => ({ kind: 'not-attached' }) }],
    ]);
    const ctx = new Proxy({}, { get: (_target, key) => services.get(String(key)) });
    return { ctx: ctx as never, captured };
  };

  it('載入之後行程的 TZ 再變，讀數的時區不跟著變', async () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Taipei';
      const { ctx, captured } = ctxWithServices();
      apply(ctx, {});
      process.env.TZ = 'America/New_York';
      const [injection] = (await captured[0]?.([], { configurable: {} })) ?? [];
      expect(injection?.content.split('\n')[0]).toBe(
        'Time sampled while preparing turn 1, step 1: 2026-10-18T09:00:00+08:00[Asia/Taipei]',
      );
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('沒設時區、行程的時區又解析不了：拋 failed to resolve the system time zone', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new RangeError('no zone');
    });
    try {
      expect(() => apply({} as never, {})).toThrow('failed to resolve the system time zone');
    } finally {
      spy.mockRestore();
    }
  });
});
