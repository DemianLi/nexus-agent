/**
 * **`run.start` 的 `client_time_zone`：瀏覽器時區記在人話的來源上**——[#1629](https://github.com/DemianLi/nexus-agent/issues/1629)。
 *
 * 照 dsh 的 `session.prompt { clientTimeZone }`（`packages/api/session-controller/src/index.ts:467-482`，`687f282e`）：伺服器驗過、正規化，
 * 記在使用者訊息的來源上，不進 thread 設定（那樣會是整條 thread 共用的一個值，同一條 thread 換了時區就說謊）。
 *
 * 兩層（跟 `run-start-request-id.test.ts` 同形）：
 *
 * - **wire**：真的 `createWireHandler`＋wire client＋假 agent。有效的記進日誌、無效的回 `invalid_argument` 且點名欄位、沒帶的行為與位元組不變。
 * - **pump**：三個位置都帶（`turn/start`、`inbox/spliced` 排進去那一件的 source、`user/message` 的 source；最後一個在 `steer.test.ts` 的真組裝），
 *   舊日誌（沒有這個欄位）照樣讀得回來。
 *
 * **零憑證、零外部連線**：模型是假 agent。
 */

import { SESSION_LOG_FORMAT_VERSION, SessionLog, STEP_INBOX_CONFIG_KEY } from '@nexus/core';
import type { SessionEvent, StepInbox } from '@nexus/core';
import { foldTimeContext } from '@nexus/plugin-time-context';
import { createWireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const COMPLETED = {
  type: 'event',
  seq: 0,
  method: 'lifecycle',
  params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
};

/** 假 agent：每一輪立刻收尾。 */
function instantAgent(): PumpAgent {
  return {
    streamEvents: async () =>
      (async function* () {
        yield COMPLETED;
      })(),
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  } as unknown as PumpAgent;
}

const turnStarts = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'turn/start');

const insertedSources = (events: readonly SessionEvent[]) =>
  events.flatMap((event) =>
    event.type === 'inbox/spliced' && event.data.removedCount === undefined
      ? event.data.inserted.map((item) => item.source)
      : [],
  );

describe('wire：run.start 帶 client_time_zone', () => {
  const opened: WireHandler[] = [];
  afterEach(async () => {
    for (const handler of opened.splice(0)) await handler.close();
  });

  function wire() {
    let log: (() => readonly SessionEvent[]) | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent: instantAgent(),
        commands: emptyCommandPoint(),
        dispose: async () => {},
        attachSessions: (sessions) => {
          log = () => sessions.root.events;
          return { detach: async () => {} };
        },
      }),
    });
    opened.push(handler);
    const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      handler.handle(loopbackRequest(input as string, init));
    const client = createWireClient({ baseUrl: 'http://tz.test', fetch });
    const raw = async (thread: string, params: Record<string, unknown>) => {
      const response = await handler.handle(
        loopbackRequest(`http://tz.test/threads/${thread}/commands/run.start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 99,
            method: 'run.start',
            params: {
              assistant_id: 'nexus',
              input: { messages: [{ role: 'human', content: '嗨' }] },
              ...params,
            },
          }),
        }),
      );
      return (await response.json()) as Record<string, unknown>;
    };
    return { client, raw, log: () => log?.() ?? [] };
  }

  it('有效的時區：記在 turn/start 與排進去那一件的 source 上', async () => {
    const { client, log } = wire();
    const result = await client.runStart('tz-valid', '嗨', { clientTimeZone: 'Asia/Taipei' });
    expect(result.type).toBe('success');
    await until(() => turnStarts(log()).length === 1);
    expect(turnStarts(log())[0]?.data).toMatchObject({
      kind: 'message',
      text: '嗨',
      clientTimeZone: 'Asia/Taipei',
    });
    expect(insertedSources(log())).toStrictEqual([{ kind: 'user', clientTimeZone: 'Asia/Taipei' }]);
  });

  it('UTC 也是有效的', async () => {
    const { client, log } = wire();
    expect((await client.runStart('tz-utc', '嗨', { clientTimeZone: 'UTC' })).type).toBe('success');
    await until(() => turnStarts(log()).length === 1);
    expect(turnStarts(log())[0]?.data).toMatchObject({ clientTimeZone: 'UTC' });
  });

  it('別名會正規化：記下的是 Intl 的正規名，同一個時區兩種寫法記同一個值', async () => {
    const { client, log } = wire();
    await client.runStart('tz-alias', '一', { clientTimeZone: 'Asia/Calcutta' });
    await until(() => turnStarts(log()).length === 1);
    await client.runStart('tz-alias', '二', { clientTimeZone: 'Asia/Kolkata' });
    await until(() => turnStarts(log()).length === 2);
    const zones = turnStarts(log()).map(
      (event) => (event.data as { clientTimeZone?: string }).clientTimeZone,
    );
    expect(zones[0]).toBeDefined();
    expect(zones[0]).toBe(zones[1]);
  });

  it('沒帶：日誌與以前位元組相同，turn/start 與 source 都沒有多出來的 key', async () => {
    const { client, log } = wire();
    await client.runStart('tz-omitted', '嗨');
    await until(() => turnStarts(log()).length === 1);
    expect(turnStarts(log())[0]?.data).toStrictEqual({ kind: 'message', text: '嗨' });
    expect(insertedSources(log())).toStrictEqual([{ kind: 'user' }]);
  });

  it('無效的時區：invalid_argument、訊息點名 client_time_zone，不進佇列', async () => {
    const { client, raw, log } = wire();
    const bad = ['', 'Taipei', ' Asia/Taipei', 'Asia/Nowhere_City', 'asia/../etc', 'UTC+8'];
    for (const clientTimeZone of bad) {
      const result = await client.runStart('tz-invalid', '嗨', { clientTimeZone });
      expect(result, clientTimeZone).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(JSON.stringify(result), clientTimeZone).toContain('client_time_zone');
    }
    // 非字串：client 的型別送不出，直接打封包。
    for (const client_time_zone of [7, null, {}, ['Asia/Taipei']]) {
      const result = await raw('tz-invalid', { client_time_zone });
      expect(result, JSON.stringify(client_time_zone)).toMatchObject({
        type: 'error',
        error: 'invalid_argument',
      });
      expect(JSON.stringify(result)).toContain('client_time_zone');
    }
    expect(insertedSources(log())).toHaveLength(0);
    expect(turnStarts(log())).toHaveLength(0);
  });

  it('時區壞了先於重送判斷：同一個 request_id 帶壞時區也是 invalid_argument，不被當成重送', async () => {
    const { client, log } = wire();
    await client.runStart('tz-resend', '嗨', { requestId: 'req-1' });
    await until(() => turnStarts(log()).length === 1);
    const again = await client.runStart('tz-resend', '嗨', {
      requestId: 'req-1',
      clientTimeZone: 'Nowhere',
    });
    expect(again).toMatchObject({ type: 'error', error: 'invalid_argument' });
  });
});

describe('pump：三個位置與舊日誌', () => {
  it('log 格式版本是 49：訊息帶時區的欄位從這一版起才會出現', () => {
    expect(SESSION_LOG_FORMAT_VERSION).toBeGreaterThanOrEqual(49);
  });

  it('turn/start 與排進去那一件的 source 都帶時區；沒帶的那一句兩處都沒有 key', async () => {
    const pump = new ThreadPump(instantAgent(), 'tz-pump');
    try {
      await pump.submit({
        kind: 'message',
        text: '有時區',
        id: 'with-zone',
        clientTimeZone: 'America/New_York',
      });
      await pump.whenIdle();
      await pump.submit({ kind: 'message', text: '沒時區', id: 'without-zone' });
      await pump.whenIdle();
      const events = pump.sessionLog.events;
      expect(turnStarts(events).map((event) => event.data)).toStrictEqual([
        { kind: 'message', text: '有時區', clientTimeZone: 'America/New_York' },
        { kind: 'message', text: '沒時區' },
      ]);
      expect(insertedSources(events)).toStrictEqual([
        { kind: 'user', clientTimeZone: 'America/New_York' },
        { kind: 'user' },
      ]);
    } finally {
      pump.close();
    }
  });

  it('時區獨立於 request_id／run_id：只帶時區也記，兩個都帶各自記', async () => {
    const pump = new ThreadPump(instantAgent(), 'tz-independent');
    try {
      await pump.submit({
        kind: 'message',
        text: '都帶',
        id: 'run-1',
        requestId: 'req-1',
        clientTimeZone: 'Asia/Tokyo',
      });
      await pump.whenIdle();
      expect(turnStarts(pump.sessionLog.events)[0]?.data).toStrictEqual({
        kind: 'message',
        text: '都帶',
        requestId: 'req-1',
        runId: 'run-1',
        clientTimeZone: 'Asia/Tokyo',
      });
      expect(pump.findPromptRequest('req-1')).toBe('run-1');
    } finally {
      pump.close();
    }
  });

  it('舊日誌（沒有這個欄位）交給新的 pump：照樣讀得回來，編號查找不受影響', async () => {
    const first = new ThreadPump(instantAgent(), 'tz-old');
    let seed: readonly SessionEvent[] = [];
    try {
      await first.submit({
        kind: 'message',
        text: '舊的一句',
        id: 'run-old',
        requestId: 'req-old',
      });
      await first.whenIdle();
      seed = [...first.sessionLog.events];
    } finally {
      first.close();
    }
    expect(JSON.stringify(seed)).not.toContain('clientTimeZone');

    const second = new ThreadPump(instantAgent(), 'tz-old', undefined, seed);
    try {
      expect(second.findPromptRequest('req-old')).toBe('run-old');
      await second.submit({
        kind: 'message',
        text: '新的一句',
        id: 'run-new',
        clientTimeZone: 'Asia/Taipei',
      });
      await second.whenIdle();
      expect(turnStarts(second.sessionLog.events).map((event) => event.data)).toStrictEqual([
        { kind: 'message', text: '舊的一句', requestId: 'req-old', runId: 'run-old' },
        { kind: 'message', text: '新的一句', clientTimeZone: 'Asia/Taipei' },
      ]);
    } finally {
      second.close();
    }
  });
});

// #1779：升 Node 之前排著、還沒開跑的項目（排隊中的 `next-turn`、插話的 `next-step`）也帶著日誌上記的時區名。
// 開那一輪（或領走）時 `pumpInputOf`／`userMessageSourceOf` 把它**原樣**抄進 `turn/start`／`user/message`，不重新正規化；
// 那個名字在新 Node 上若不是正規名，讀的時候（`foldTimeContext`）就拋 `must be canonical`。`docs/operations.md`「升 Node 之前」
// 寫的處理方式（升之前佇列也要清空）依據的就是這個行為；這裡把它釘住，不改行為。
describe('升 Node 之前排著的項目：原樣抄進新一輪，讀的時候才拋（#1779）', () => {
  /** 在這個執行期上不是正規名的舊名字：升級前的 runtime 記的是它，升級後的 `Intl` 回報另一個。 */
  const OLD_NAME = 'Asia/Kolkata';

  it('前提：OLD_NAME 在這個執行期上不是正規名（ICU 哪天變了，這條先紅，不是下面的斷言莫名紅）', () => {
    const canonical = new Intl.DateTimeFormat('en-US', { timeZone: OLD_NAME }).resolvedOptions()
      .timeZone;
    expect(canonical).not.toBe(OLD_NAME);
  });

  /** 領得走插話的假 agent：一輪開頭領一次、收尾前領到空為止。 */
  function claimingAgent(): PumpAgent {
    return {
      streamEvents: async (_input: unknown, config: { configurable: Record<string, unknown> }) => {
        const inbox = config.configurable[STEP_INBOX_CONFIG_KEY] as StepInbox;
        return (async function* () {
          await inbox.claim();
          while ((await inbox.finish()).length > 0);
          yield COMPLETED;
        })();
      },
      getState: async () => ({ values: {} }),
      updateState: async () => ({}),
    } as unknown as PumpAgent;
  }

  function pumpOver(seed: SessionLog, agent: PumpAgent): ThreadPump {
    return new ThreadPump(
      agent,
      'tz-upgrade',
      undefined,
      seed.events,
      undefined,
      undefined,
      undefined,
      true,
    );
  }

  it('排隊中（next-turn）：帶別名的那一件開成新一輪，turn/start 照抄別名，foldTimeContext 拋 must be canonical', async () => {
    const seed = new SessionLog('tz-upgrade');
    seed.append('inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [
        { id: 'old-q', text: '升級前排著的', source: { kind: 'user', clientTimeZone: OLD_NAME } },
      ],
    });
    const pump = pumpOver(seed, claimingAgent());
    try {
      expect(pump.inbox.map((item) => item.id)).toEqual(['old-q']);
      // 使用者升級後再送一句：排在舊項目後面，舊項目先開那一輪。
      await pump.submit({
        kind: 'message',
        text: '升級後的新一句',
        id: 'new-q',
        clientTimeZone: 'Asia/Calcutta',
      });
      await pump.whenIdle();
      const starts = turnStarts(pump.sessionLog.events).map((event) => event.data);
      expect(starts[0]).toStrictEqual({
        kind: 'message',
        text: '升級前排著的',
        clientTimeZone: OLD_NAME,
      });
      // 讀「第一輪」的日誌（最後一個 turn/start 之前的那一段）：舊名字原樣在裡面，一讀就拋。
      const events = pump.sessionLog.events;
      const firstStart = events.findIndex((event) => event.type === 'turn/start');
      const secondStart = events.findIndex(
        (event, index) => index > firstStart && event.type === 'turn/start',
      );
      expect(() => foldTimeContext(events.slice(0, secondStart))).toThrow(
        `browser time zone must be canonical: "${OLD_NAME}"`,
      );
    } finally {
      pump.close();
    }
  });

  it('插話（next-step）：領走時 user/message 的 source 照抄別名，foldTimeContext 拋 must be canonical', async () => {
    const seed = new SessionLog('tz-upgrade');
    seed.append('inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{ id: 'm1', text: '開始', source: { kind: 'user' } }],
    });
    seed.append('turn/start', { kind: 'message', text: '開始' });
    seed.append('inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
    seed.append('inbox/spliced', {
      target: 'next-step',
      start: 0,
      inserted: [
        { id: 'old-s', text: '升級前插的', source: { kind: 'user', clientTimeZone: OLD_NAME } },
      ],
    });
    seed.append('turn/end', { reason: { kind: 'aborted', cause: { kind: 'user' } } });
    const pump = pumpOver(seed, claimingAgent());
    try {
      expect(pump.nextStep.map((item) => item.id)).toEqual(['old-s']);
      await pump.submit({
        kind: 'message',
        text: '升級後',
        id: 'new-m',
        clientTimeZone: 'Asia/Calcutta',
      });
      await pump.whenIdle();
      const claimed = pump.sessionLog.events.filter(
        (event) => event.type === 'user/message' && event.data.source.kind === 'user',
      );
      expect(claimed.map((event) => (event.data as { source: unknown }).source)).toContainEqual({
        kind: 'user',
        clientTimeZone: OLD_NAME,
      });
      expect(() => foldTimeContext(pump.sessionLog.events)).toThrow(
        `browser time zone must be canonical: "${OLD_NAME}"`,
      );
    } finally {
      pump.close();
    }
  });
});
