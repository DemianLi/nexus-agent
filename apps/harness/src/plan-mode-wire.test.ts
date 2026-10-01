/**
 * **計劃模式現在開著還是關著，即時看得到，重新整理之後也一樣**——[#895](https://github.com/DemianLi/nexus-agent/issues/895)
 * 的 harness 那一半。
 *
 * 規則照 dsh 的 `plan` 投影，少了 `pending`（理由見 `@nexus/wire` 的 `plan-mode.ts`）：
 *
 * 1. root 日誌每記一顆 `plan/mode` 就送一顆，開關都送。
 * 2. 歷史只在最新一頁送一顆目前的值；計劃模式跨頁，較舊的頁不帶，免得把新的蓋回舊的。
 * 3. 日誌上一顆都沒有就不送，折疊器的初值 `null`。
 * 4. 子代理日誌上的 `plan/mode` 不進來。
 *
 * 第一組走產品路徑：真的組裝、真的 handler、真的 client、真的 `/plan`，每個檢查點比即時與歷史兩條路。
 * `exit_plan_mode` 同意之後那一顆在 `plan-review-wire.test.ts` 量。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`，測試不碰真的 `~/.nexus-agent`。
 */

import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent, SessionLog } from '@nexus/core';
import { PLAN_COMMAND_NAME } from '@nexus/plugin-plan-mode';
import type { Event, WireClient } from '@nexus/wire';
import { createWireClient, emptyConversation, PLAN_MODE, reduceAll } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { createCliAgent } from './cli.js';
import { historyPage } from './conversation-history.js';
import { loopbackRequest, shippedPlugins, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { ThreadPump } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const shipped = await shippedPlugins();

const BASE_URL = 'http://plan-mode-wire.test';

const settle = () => new Promise((resolve) => setImmediate(resolve));

const planOf = (frames: readonly Event[]) => reduceAll(emptyConversation(), frames).planMode;

/** 這條線上收到的 `plan` frame 的酬載，照收到的先後。 */
const planPayloads = (frames: readonly Event[]) =>
  frames
    .filter((frame) => frame.method === 'custom')
    .map((frame) => frame.params.data as { name: string; payload: unknown })
    .filter((data) => data.name === PLAN_MODE)
    .map((data) => data.payload);

interface Wired {
  readonly client: WireClient;
  readonly frames: Event[];
  log(): SessionLog;
  close(): Promise<void>;
}

let opened: Wired | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

/** 起一條完整的線，同 `slash-wire.test.ts`，並在背景把下行抽進 `frames`。 */
async function wire(): Promise<Wired> {
  const built = await createCliAgent({ live: false }, shipped);
  let captured: SessionLog | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: built.commands,
      dispose: built.dispose,
      attachTelemetry: (sessions) => {
        captured = sessions.root;
        return undefined;
      },
      attachInvariants: built.attachInvariants,
      attachSession: built.attachSession,
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  const frames: Event[] = [];
  const events = await client.openEvents('t');
  void (async () => {
    for await (const frame of events) frames.push(frame);
  })();
  const wired: Wired = {
    client,
    frames,
    log: () => {
      if (captured === undefined) throw new Error('這條 thread 還沒建起來');
      return captured;
    },
    close: () => handler.close(),
  };
  opened = wired;
  return wired;
}

/** 等下行追上：`plan` frame 收到第 `count` 顆。 */
async function untilPlanFrames(wired: Wired, count: number): Promise<void> {
  for (let tries = 0; tries < 200 && planPayloads(wired.frames).length < count; tries += 1) {
    await settle();
  }
}

/** 重新整理拿到的：整份一頁，與只收最後幾則的那一頁。兩種都要跟即時一樣。 */
function refreshed(events: readonly SessionEvent[]) {
  return [historyPage(events), historyPage(events, { maxMessages: 1 })].map((page) =>
    planOf(page.events),
  );
}

describe('打 /plan 之後，即時與重新整理之後一樣', () => {
  it('開、再開、關：第二次開是 noop 不寫日誌也不送；一顆都沒打過就是 null', async () => {
    const wired = await wire();
    // 前提：一顆都沒打過時，下行沒有 `plan` frame，歷史也不送。
    expect(planPayloads(wired.frames)).toEqual([]);

    await wired.client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    await untilPlanFrames(wired, 1);
    expect(wired.log().events.filter((event) => event.type === 'plan/mode')).toHaveLength(1);
    expect(planOf(wired.frames)).toEqual({ active: true });
    expect(refreshed(wired.log().events)).toEqual([{ active: true }, { active: true }]);

    // 對照：同方向再打一次是 noop，日誌沒有第二顆，下行也沒有。
    await wired.client.slashRun('t', `/${PLAN_COMMAND_NAME}`);
    await settle();
    expect(wired.log().events.filter((event) => event.type === 'plan/mode')).toHaveLength(1);
    expect(planPayloads(wired.frames)).toEqual([{ active: true }]);

    await wired.client.slashRun('t', `/${PLAN_COMMAND_NAME} off`);
    await untilPlanFrames(wired, 2);
    expect(planOf(wired.frames)).toEqual({ active: false });
    expect(refreshed(wired.log().events)).toEqual([{ active: false }, { active: false }]);
    expect(planPayloads(wired.frames)).toEqual([{ active: true }, { active: false }]);
  });
});

describe('歷史那一側的折疊', () => {
  let seq = 0;
  const at = <T extends SessionEvent['type']>(
    type: T,
    data: Extract<SessionEvent, { type: T }>['data'],
  ): SessionEvent => ({ type, data, seq: seq++, time: seq }) as SessionEvent;

  /** 一輪：人說一句、模型回一句。 */
  const turn = (text: string): SessionEvent[] => [
    at('turn/start', { kind: 'message', text }),
    at('assistant/message', {
      message: { type: 'ai', data: { content: `回：${text}`, tool_calls: [] } },
    } as never),
    at('turn/end', {}),
  ];

  it('一顆都沒有就不送', () => {
    const events = [...turn('一'), ...turn('二')];
    expect(historyPage(events).events.filter(isPlanFrame)).toEqual([]);
  });

  it('計劃模式開在較舊的頁：最新一頁照樣帶目前的值，較舊的頁不帶', () => {
    const events = [...turn('一'), at('plan/mode', { active: true }), ...turn('二'), ...turn('三')];
    const latest = historyPage(events, { maxMessages: 1 });
    // 前提：最新一頁真的只收到最後一輪，`plan/mode` 落在它之前。
    expect(latest.hasMore).toBe(true);
    expect(latest.firstSeq).toBeGreaterThan(events.findIndex((e) => e.type === 'plan/mode'));
    expect(planOf(latest.events)).toEqual({ active: true });

    const older = historyPage(events, { maxMessages: 1, beforeSeq: latest.firstSeq });
    expect(older.events.filter(isPlanFrame)).toEqual([]);
  });

  it('最後一顆說了算：開了又關，帶的是關', () => {
    const events = [
      ...turn('一'),
      at('plan/mode', { active: true }),
      ...turn('二'),
      at('plan/mode', { active: false }),
      ...turn('三'),
    ];
    expect(planOf(historyPage(events, { maxMessages: 1 }).events)).toEqual({ active: false });
  });

  it('throughSeq 之後才寫的不算', () => {
    const events = [...turn('一'), at('plan/mode', { active: true }), ...turn('二')];
    const through = events.findIndex((e) => e.type === 'plan/mode') - 1;
    expect(historyPage(events, { throughSeq: through }).events.filter(isPlanFrame)).toEqual([]);
  });
});

function isPlanFrame(frame: Event): boolean {
  return frame.method === 'custom' && (frame.params.data as { name?: string }).name === PLAN_MODE;
}

describe('只收 root 的', () => {
  it('root 日誌上的 plan/mode 送出去，子代理日誌上的不送', async () => {
    const worker: PluginEntry = {
      plugin: {
        name: 'plan-mode-wire-fixture',
        apply(registry) {
          registry.subagents.register({ name: 'worker', description: '幹活的。' });
        },
      },
    };
    const model = new ScriptedChatModel({
      turns: [
        {
          content: '',
          toolCalls: [{ name: 'task', args: { description: '做事', subagent_type: 'worker' } }],
        },
        { content: '子代理收工。' },
        { content: '根收工。' },
      ],
    });
    const built = await createNexusAgent({
      model: model as never,
      checkpointer: new MemorySaver(),
      plugins: [worker],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'plan-root-only');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'custom'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    try {
      await pump.submit({ kind: 'message', text: '派出去' });
      await settle();
      const subagent = pump.sessions.list().find((entry) => entry.address.kind === 'subagent');
      // 前提：子代理真的有自己的日誌。
      expect(subagent).toBeDefined();
      expect(planPayloads(frames)).toEqual([]);

      subagent?.log.append('plan/mode', { active: true });
      await settle();
      expect(planPayloads(frames)).toEqual([]);

      // 對照：同一個事件寫在 root 上就送。
      pump.sessionLog.append('plan/mode', { active: true });
      await settle();
      expect(planPayloads(frames)).toEqual([{ active: true }]);
    } finally {
      line.abort();
      await draining;
      detach();
      await built.dispose();
    }
  }, 30000);
});
