/**
 * **`run.start` 的客戶端請求編號：重送同一句不會排兩次**——[#1335](https://github.com/DemianLi/nexus-agent/issues/1335)。
 *
 * 照 dsh 的 `session.prompt { requestId }`（`packages/api/session-controller/src/commands.ts:330`，`d7432673886`）：收到時先查這個
 * 編號收過沒有，收過就不再排。三個階段都認得——排著、已領走、已落日誌（含重啟之後）。
 *
 * **和 dsh 不同的一處**：dsh 回 `{ accepted: true }`，我們回原本那一件的 `run_id`（它兼作佇列項目的 id，畫面靠它對上
 * 自己送出的那一句），所以重送與第一次的回應形狀相同。
 *
 * 兩層：
 *
 * - **wire**：真的 `createWireHandler`＋wire client＋假 agent。重送在三個階段各一則，加上「不同編號照樣排兩次」「沒帶編號
 *   行為不變」「同編號不同文字回原本那一件」「被刪掉的不算」「形狀不對回 `invalid_argument`」。
 * - **重啟**：同一份日誌交給新的 `ThreadPump`，排著的與已開跑的編號都還認得。
 *
 * **零憑證、零外部連線**：模型是假 agent。
 */

import type { SessionEvent } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { createWireClient, REQUEST_ID_MAX_LENGTH } from '@nexus/wire';
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

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

const COMPLETED = {
  type: 'event',
  seq: 0,
  method: 'lifecycle',
  params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
};

/**
 * 假 agent：第 N 輪開跑後等 `holds[N-1]`（沒排就直接收尾）。`ran` 記下每一輪收到的人話，驗「模型看到幾次」。
 */
function agentWith(holds: readonly Promise<void>[] = []) {
  const ran: string[] = [];
  let call = 0;
  const agent = {
    streamEvents: async (input: { messages?: { content?: unknown }[] }) => {
      const hold = holds[call];
      call += 1;
      ran.push(String(input.messages?.[0]?.content ?? ''));
      return (async function* () {
        if (hold !== undefined) await hold;
        yield COMPLETED;
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  };
  return { agent: agent as unknown as PumpAgent, ran };
}

const turnStarts = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'turn/start');

const insertedIds = (events: readonly SessionEvent[]) =>
  events.flatMap((event) =>
    event.type === 'inbox/spliced' && event.data.removedCount === undefined
      ? event.data.inserted.map((item) => item.id)
      : [],
  );

describe('wire：重送同一個請求編號', () => {
  const opened: WireHandler[] = [];
  afterEach(async () => {
    for (const handler of opened.splice(0)) await handler.close();
  });

  function wire(agent: PumpAgent) {
    let log: (() => readonly SessionEvent[]) | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => ({
        agent,
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
    const client = createWireClient({ baseUrl: 'http://reqid.test', fetch });
    return { client, log: () => log?.() ?? [] };
  }

  const runIdOf = (result: unknown): string =>
    (result as { result: { run_id: string } }).result.run_id;

  it('排著時重送：回原本那一件的 run_id，佇列只有一件', async () => {
    const hold = gate();
    const { agent, ran } = agentWith([hold.opened]);
    const { client, log } = wire(agent);
    const thread = 'reqid-queued';
    await client.runStart(thread, '第一句');
    await until(() => turnStarts(log()).length === 1);

    const first = await client.runStart(thread, '第二句', { requestId: 'req-2' });
    expect(first.type).toBe('success');
    const again = await client.runStart(thread, '第二句', { requestId: 'req-2' });
    expect(again.type).toBe('success');
    expect(runIdOf(again)).toBe(runIdOf(first));
    // 日誌上只插進過兩件（第一句、第二句），第二句只有一件。
    expect(insertedIds(log())).toHaveLength(2);

    hold.open();
    await until(() => turnStarts(log()).length === 2);
    await until(() => log().filter((event) => event.type === 'turn/end').length === 2);
    expect(ran).toHaveLength(2);
  });

  it('已領走、那一輪還在跑時重送：回原本那一件的 run_id，不再排', async () => {
    const hold = gate();
    const { agent, ran } = agentWith([hold.opened]);
    const { client, log } = wire(agent);
    const thread = 'reqid-claimed';
    const first = await client.runStart(thread, '嗨', { requestId: 'req-1' });
    await until(() => turnStarts(log()).length === 1);
    // 領走之後它已經不在收件匣上了：只有 turn/start 上的編號還認得它。
    const again = await client.runStart(thread, '嗨', { requestId: 'req-1' });
    expect(runIdOf(again)).toBe(runIdOf(first));
    expect(insertedIds(log())).toHaveLength(1);
    hold.open();
    await until(() => log().some((event) => event.type === 'turn/end'));
    expect(ran).toEqual(['嗨']);
  });

  it('那一輪已經收尾、落進日誌之後重送：回原本那一件的 run_id，不再開一輪', async () => {
    const { agent, ran } = agentWith();
    const { client, log } = wire(agent);
    const thread = 'reqid-logged';
    const first = await client.runStart(thread, '嗨', { requestId: 'req-1' });
    await until(() => log().some((event) => event.type === 'turn/end'));
    const again = await client.runStart(thread, '嗨', { requestId: 'req-1' });
    expect(runIdOf(again)).toBe(runIdOf(first));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(turnStarts(log())).toHaveLength(1);
    expect(ran).toEqual(['嗨']);
  });

  it('不同編號的同一句話照樣排兩次；沒帶編號的行為不變', async () => {
    const hold = gate();
    const { agent } = agentWith([hold.opened]);
    const { client, log } = wire(agent);
    const thread = 'reqid-different';
    await client.runStart(thread, '開頭');
    await until(() => turnStarts(log()).length === 1);
    const a = await client.runStart(thread, '一樣的話', { requestId: 'req-a' });
    const b = await client.runStart(thread, '一樣的話', { requestId: 'req-b' });
    const c = await client.runStart(thread, '一樣的話');
    const d = await client.runStart(thread, '一樣的話');
    expect(new Set([runIdOf(a), runIdOf(b), runIdOf(c), runIdOf(d)]).size).toBe(4);
    expect(insertedIds(log())).toHaveLength(5);
    hold.open();
  });

  it('只比編號、不比內容：同編號不同文字回原本那一件，新的字不進佇列', async () => {
    const hold = gate();
    const { agent } = agentWith([hold.opened]);
    const { client, log } = wire(agent);
    const thread = 'reqid-content';
    await client.runStart(thread, '開頭');
    await until(() => turnStarts(log()).length === 1);
    const first = await client.runStart(thread, '原本的字', { requestId: 'req-1' });
    const again = await client.runStart(thread, '改過的字', { requestId: 'req-1' });
    expect(runIdOf(again)).toBe(runIdOf(first));
    const texts = log().flatMap((event) =>
      event.type === 'inbox/spliced' ? event.data.inserted.map((item) => item.text) : [],
    );
    expect(texts).not.toContain('改過的字');
    hold.open();
  });

  it('排著的那一句被刪掉之後，同一個編號再送是新的一句', async () => {
    const hold = gate();
    const { agent } = agentWith([hold.opened]);
    const { client, log } = wire(agent);
    const thread = 'reqid-removed';
    await client.runStart(thread, '開頭');
    await until(() => turnStarts(log()).length === 1);
    const first = await client.runStart(thread, '要刪的', { requestId: 'req-1' });
    expect(
      await client.queueUpdate(thread, { item_id: runIdOf(first), action: { kind: 'remove' } }),
    ).toMatchObject({ type: 'success' });
    const again = await client.runStart(thread, '要刪的', { requestId: 'req-1' });
    expect(again.type).toBe('success');
    expect(runIdOf(again)).not.toBe(runIdOf(first));
    hold.open();
  });

  it('request_id 形狀不對：invalid_argument，不進佇列', async () => {
    const { agent } = agentWith();
    const { client, log } = wire(agent);
    const thread = 'reqid-shape';
    for (const requestId of ['', 'x'.repeat(REQUEST_ID_MAX_LENGTH + 1)]) {
      expect(await client.runStart(thread, '嗨', { requestId })).toMatchObject({
        type: 'error',
        error: 'invalid_argument',
      });
    }
    // 非字串：client 的型別送不出，直接打封包。
    const raw = await createRaw(thread);
    expect(raw).toMatchObject({ type: 'error', error: 'invalid_argument' });
    expect(insertedIds(log())).toHaveLength(0);

    async function createRaw(threadId: string) {
      const handler = opened[0]!;
      const response = await handler.handle(
        loopbackRequest(`http://reqid.test/threads/${threadId}/commands/run.start`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            id: 99,
            method: 'run.start',
            params: {
              assistant_id: 'nexus',
              input: { messages: [{ role: 'human', content: '嗨' }] },
              request_id: 7,
            },
          }),
        }),
      );
      return (await response.json()) as Record<string, unknown>;
    }
  });
});

describe('重啟：同一份日誌交給新的 pump', () => {
  function open(agent: PumpAgent, seed?: readonly SessionEvent[]) {
    const pump = new ThreadPump(agent, 'reqid-restart', undefined, seed);
    const frames: Event[] = [];
    const line = new AbortController();
    const draining = (async () => {
      for await (const frame of pump.subscribe(['lifecycle'], line.signal)) frames.push(frame);
    })();
    return {
      pump,
      close: async () => {
        pump.close();
        line.abort();
        await draining;
      },
    };
  }

  it('排著的與已開跑的編號，重啟之後都還認得', async () => {
    const hold = gate();
    const first = open(agentWith([hold.opened]).agent);
    let seed: readonly SessionEvent[] = [];
    try {
      void first.pump
        .submit({ kind: 'message', text: '已開跑', id: 'run-1', requestId: 'req-1' })
        .catch(() => undefined);
      await until(() => first.pump.running);
      void first.pump
        .submit({ kind: 'message', text: '還排著', id: 'run-2', requestId: 'req-2' })
        .catch(() => undefined);
      await until(() => first.pump.inbox.length === 1);
      expect(first.pump.findPromptRequest('req-1')).toBe('run-1');
      expect(first.pump.findPromptRequest('req-2')).toBe('run-2');
      seed = [...first.pump.sessionLog.events];
    } finally {
      hold.open();
      await first.close();
    }

    const second = open(agentWith().agent, seed);
    try {
      // 上一個行程留下的：req-1 在 turn/start 上、req-2 在還排著的那一件的 source 上。
      expect(second.pump.findPromptRequest('req-1')).toBe('run-1');
      expect(second.pump.findPromptRequest('req-2')).toBe('run-2');
      expect(second.pump.findPromptRequest('req-never')).toBeUndefined();
    } finally {
      await second.close();
    }
  });

  it('沒帶編號的送出，日誌與以前位元組相同：turn/start 與佇列項都沒有多出來的 key', async () => {
    const run = open(agentWith().agent);
    try {
      await run.pump.submit({ kind: 'message', text: '嗨', id: 'plain' });
      await run.pump.whenIdle();
      const start = run.pump.sessionLog.events.find((event) => event.type === 'turn/start');
      expect(start?.data).toEqual({ kind: 'message', text: '嗨' });
      const inserted = run.pump.sessionLog.events.find(
        (event) => event.type === 'inbox/spliced' && event.data.inserted.length > 0,
      );
      expect((inserted?.data as { inserted: { source: unknown }[] }).inserted[0]?.source).toEqual({
        kind: 'user',
      });
    } finally {
      await run.close();
    }
  });
});
