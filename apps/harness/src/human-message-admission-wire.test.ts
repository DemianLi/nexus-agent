/**
 * 太大的人話在 wire 上的拒收（[#2415](https://github.com/DemianLi/nexus-agent/issues/2415)）。量法對著基座比在
 * `@nexus/core` 的 `human-message-admission.test.ts`；這一檔問的是接線：
 *
 * 1. `native` 下 `run.start` 與 `queue.update` 的 `edit` 拒收，日誌一個字都不寫；剛好等於上限的照收；點名的提示字算進去。
 * 2. `langgraph` 下照收。
 * 3. 產品路徑上的 serve 照 `--agent-loop` 決定：沒給就是 `langgraph`；native 套件把它當成 `native`（`native-loop.setup.ts`）。
 */

import { HUMAN_MESSAGE_LIMIT_CHARS, mentionHintText } from '@nexus/core';
import type { AgentLoopKind, SessionEvent } from '@nexus/core';
import { createWireClient } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import {
  emptyCommandPoint,
  foldTurn,
  loopbackRequest,
  serveClient,
  TEST_BROWSER_AUTH,
} from './fixtures.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const TOO_LARGE = 'x'.repeat(HUMAN_MESSAGE_LIMIT_CHARS + 1);
const AT_LIMIT = 'y'.repeat(HUMAN_MESSAGE_LIMIT_CHARS);
const REJECTION = 'message-too-large: 這則訊息有 200,001 字，超過上限 200,000 字';

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** 第一輪等 `hold` 開了才收尾的假 agent，讓後面送的那幾件排在隊裡。 */
function heldAgent(hold: Promise<void>): PumpAgent {
  let call = 0;
  return {
    streamEvents: async () => {
      call += 1;
      const first = call === 1;
      return (async function* () {
        if (first) await hold;
        yield {
          type: 'event',
          seq: 0,
          method: 'lifecycle',
          params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
        };
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  } as unknown as PumpAgent;
}

describe('wire handler 照 agentLoop 拒收', () => {
  const opened: WireHandler[] = [];
  let release: (() => void) | undefined;
  afterEach(async () => {
    release?.();
    for (const handler of opened.splice(0)) await handler.close();
  });

  function wire(agentLoop: AgentLoopKind) {
    const hold = new Promise<void>((resolve) => (release = resolve));
    let pumpLog: (() => readonly SessionEvent[]) | undefined;
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      agentLoop,
      createAgent: async () => ({
        agent: heldAgent(hold),
        subagentKinds: [{ name: 'reviewer', description: '審稿' }],
        commands: emptyCommandPoint(),
        dispose: async () => {},
        attachSessions: (sessions) => {
          pumpLog = () => sessions.root.events;
          return { detach: async () => {} };
        },
      }),
    });
    opened.push(handler);
    const client = createWireClient({
      baseUrl: 'http://size.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    const types = () => (pumpLog?.() ?? []).map((event) => event.type);
    return { client, types };
  }

  it('native：run.start 太大的回 invalid_argument，日誌不動；剛好等於上限的照收', async () => {
    const { client, types } = wire('native');
    const thread = 'native-run-start';
    expect(await client.runStart(thread, TOO_LARGE)).toEqual({
      type: 'error',
      id: expect.any(Number),
      error: 'invalid_argument',
      message: REJECTION,
    });
    expect(types()).toEqual([]);
    expect((await client.runStart(thread, AT_LIMIT)).type).toBe('success');
    await until(() => types().includes('turn/start'));
  });

  it('native：點名的提示字算進去，字本身沒過線、加上提示就過線的拒收', async () => {
    const { client, types } = wire('native');
    const thread = 'native-mention';
    const mention = { kind: 'subagent', name: 'reviewer' } as const;
    // 文字區塊與提示區塊以一個換行接起來，所以這句話剛好比上限多一個字。
    const text = 'z'.repeat(HUMAN_MESSAGE_LIMIT_CHARS - mentionHintText(mention).length);
    expect(await client.runStart(thread, text, { mention })).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
      message: 'message-too-large: 這則訊息有 200,001 字，超過上限 200,000 字',
    });
    expect(types()).toEqual([]);
    expect((await client.runStart(thread, text)).type).toBe('success');
  });

  it('native：queue.update 改成太大的回 invalid_argument，排著的那一件不動', async () => {
    const { client, types } = wire('native');
    const thread = 'native-queue-edit';
    await client.runStart(thread, '第一句');
    await until(() => types().includes('turn/start'));
    const queued = await client.runStart(thread, '第二句');
    const id = (queued as { result: { run_id: string } }).result.run_id;
    // 改成功會落一顆 inbox/spliced：長度不變就是那一件沒被改。
    const before = types().length;
    expect(
      await client.queueUpdate(thread, { item_id: id, action: { kind: 'edit', text: TOO_LARGE } }),
    ).toMatchObject({ type: 'error', error: 'invalid_argument', message: REJECTION });
    expect(types()).toHaveLength(before);
    expect(
      await client.queueUpdate(thread, { item_id: id, action: { kind: 'edit', text: AT_LIMIT } }),
    ).toMatchObject({ type: 'success' });
  });

  it('langgraph：run.start 與 queue.update 都照收', async () => {
    const { client, types } = wire('langgraph');
    const thread = 'langgraph-both';
    expect((await client.runStart(thread, TOO_LARGE)).type).toBe('success');
    await until(() => types().includes('turn/start'));
    const queued = await client.runStart(thread, '第二句');
    const id = (queued as { result: { run_id: string } }).result.run_id;
    expect(
      await client.queueUpdate(thread, { item_id: id, action: { kind: 'edit', text: TOO_LARGE } }),
    ).toMatchObject({ type: 'success' });
  });
});

describe('產品路徑上的 serve', () => {
  let running: RunningServe | undefined;
  afterEach(async () => {
    await running?.close();
    running = undefined;
  });

  it('沒給 --agent-loop：langgraph 照收；native 套件當成 native、拒收', async () => {
    running = (await runServe({
      argv: ['--port', '0'],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    const client = await serveClient(running);
    const events = await client.openEvents('serve-size');
    const outcome = await client.runStart('serve-size', TOO_LARGE);
    if (process.env.NEXUS_TEST_AGENT_LOOP === 'native') {
      expect(outcome).toMatchObject({
        type: 'error',
        error: 'invalid_argument',
        message: REJECTION,
      });
    } else {
      expect(outcome.type).toBe('success');
      await foldTurn(events);
    }
    await events.return?.(undefined);
  });

  it('明給 --agent-loop native：兩個套件都拒收', async () => {
    running = (await runServe({
      argv: ['--port', '0', '--agent-loop', 'native'],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    const client = await serveClient(running);
    expect(await client.runStart('serve-native', TOO_LARGE)).toMatchObject({
      type: 'error',
      error: 'invalid_argument',
      message: REJECTION,
    });
  });
});
