/**
 * 全部 thread 共用的那條下行（[#632](https://github.com/DemianLi/nexus-agent/issues/632)）。
 *
 * 照 dsh：在跑／閒著的切換廣播（`api-session/status`），等人回答的請求接上時補送（`pendingRemoteEvents`），答掉或收回
 * 時撤回。前半對著 pump 量它講了什麼、按什麼順序；後半走真的 handler 與 client。
 *
 * **最容易假綠的是「停在核准點時沒講閒著」**：狀態整個壞掉（一顆都不送）時也成立。所以每一條都先證它講過在跑，
 * 序列一律整串比對。
 *
 * **零憑證、零外部連線**：模型是 `ScriptedChatModel`。
 */

import { tool } from '@langchain/core/tools';
import { CONCURRENCY_SAFE_METADATA_KEY } from '@nexus/core';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry } from '@nexus/core';
import type { Event, ThreadFeedFrame } from '@nexus/wire';
import { createWireClient } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { ThreadFeed } from './thread-feed.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpActivity, PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import { composeAttachSessions } from './session-attach.js';

const BASE_URL = 'http://thread-feed.test';

/** 產品路徑的閘門（`approvals.gate`）：`names` 裡的工具各自 `interrupt()`。 */
function gated(names: readonly string[]): PluginEntry {
  return {
    plugin: {
      name: 'gated',
      apply(registry) {
        for (const name of names) {
          registry.tools.register(
            tool(() => `${name} 跑過了`, {
              name,
              description: `要核准的 ${name}`,
              schema: z.object({}),
              // 宣告可重疊（#711 第 2 步）：這份測試要的是同一輪兩顆中斷同時掛出來；沒宣告的工具是獨佔，一次只問一顆。
              metadata: { [CONCURRENCY_SAFE_METADATA_KEY]: true },
            }),
          );
        }
        registry.approvals.gate((exec, next) =>
          names.includes(exec.name) ? { kind: 'ask', reason: `${exec.name} 要人看過` } : next(),
        );
      },
    },
  };
}

/** `names` 空的就是一輪直接回話、不叫工具。一條 thread 一份：模型的腳本是逐輪吃掉的。 */
async function build(names: readonly string[]) {
  return createNexusAgent({
    model: new ScriptedChatModel({
      turns:
        names.length === 0
          ? [{ content: '好。' }, { content: '又好。' }]
          : [
              { content: '都動。', toolCalls: names.map((name) => ({ name, args: {} })) },
              { content: '收工。' },
              { content: '再收一次工。' },
            ],
    }),
    checkpointer: new MemorySaver(),
    plugins: names.length === 0 ? [] : [gated(names)],
  });
}

async function watchedPump(threadId: string, names: readonly string[]) {
  const built = await build(names);
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, threadId);
  const detach = built.attachSession(pump.sessions);
  const told: PumpActivity[] = [];
  const unwatch = pump.watch((activity) => told.push(activity));
  return {
    pump,
    told,
    close: async () => {
      unwatch();
      pump.close();
      detach();
      await built.dispose();
    },
  };
}

/** 把講過的話壓成好比的樣子：中斷只留 id。 */
function brief(activity: PumpActivity | ThreadFeedFrame): string {
  const thread = 'threadId' in activity ? `${activity.threadId} ` : '';
  switch (activity.type) {
    case 'status':
      return `${thread}${activity.running ? 'running' : 'idle'}`;
    case 'input-requested':
      return `${thread}requested ${interruptIdOf(activity.event)}`;
    case 'input-withdrawn':
      return `${thread}withdrawn ${activity.interruptId}`;
  }
}

function interruptIdOf(event: Event): string {
  return (event.params.data as { interrupt_id: string }).interrupt_id;
}

describe('pump 對全域下行講的話', () => {
  it('停在核准點算在跑：講在跑、兩題，不講閒著；答完兩題才講閒著', async () => {
    const run = await watchedPump('status-parked', ['alpha', 'beta']);
    try {
      await run.pump.submit({ kind: 'message', text: '動手' });
      await run.pump.whenIdle();
      const [alpha, beta] = run.pump.pendings;
      if (alpha === undefined || beta === undefined) throw new Error('沒有兩顆掛著');
      // 前提：這一輪已經收了——舊的 `running` 是假的，是掛著的中斷讓它算在跑。
      expect(run.pump.running).toBe(false);
      expect(run.pump.agentRunning).toBe(true);
      expect(run.told.map(brief)).toEqual([
        'running',
        `requested ${alpha.interruptId}`,
        `requested ${beta.interruptId}`,
      ]);
      // 補送與即時講的是同一顆，號一起。
      expect(run.told.slice(1)).toEqual([
        { type: 'input-requested', event: alpha.request },
        { type: 'input-requested', event: beta.request },
      ]);

      run.told.length = 0;
      await run.pump.submit({
        kind: 'resume',
        interruptId: alpha.interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      await run.pump.whenIdle();
      // 沒答到的 beta 帶原 id 再中斷一次：再講一次，後到的蓋過先到的。
      expect(run.told.map(brief)).toEqual([
        `withdrawn ${alpha.interruptId}`,
        `requested ${beta.interruptId}`,
      ]);

      run.told.length = 0;
      await run.pump.submit({
        kind: 'resume',
        interruptId: beta.interruptId,
        response: { decisions: [{ type: 'approve' }] },
      });
      await run.pump.whenIdle();
      expect(run.told.map(brief)).toEqual([`withdrawn ${beta.interruptId}`, 'idle']);
      expect(run.pump.agentRunning).toBe(false);
    } finally {
      await run.close();
    }
  }, 20000);

  it('停止（收回）：兩題各撤回一次，收完講閒著', async () => {
    const run = await watchedPump('status-withdrawn', ['alpha', 'beta']);
    try {
      await run.pump.submit({ kind: 'message', text: '動手' });
      await run.pump.whenIdle();
      const ids = run.pump.pendings.map((pending) => pending.interruptId);
      expect(ids).toHaveLength(2);

      run.told.length = 0;
      expect(run.pump.cancel()).toBe('withdrawn');
      await run.pump.whenIdle();
      expect(run.told.map(brief)).toEqual([...ids.map((id) => `withdrawn ${id}`), 'idle']);
    } finally {
      await run.close();
    }
  }, 20000);

  it('排著的兩句連著跑：中間不講閒著', async () => {
    const run = await watchedPump('status-queued', []);
    try {
      const first = run.pump.submit({ kind: 'message', text: '一' });
      const second = run.pump.submit({ kind: 'message', text: '二' });
      await Promise.all([first, second]);
      await run.pump.whenIdle();
      expect(run.told.map(brief)).toEqual(['running', 'idle']);
    } finally {
      await run.close();
    }
  }, 20000);

  it('送出之後、開跑之前就刪掉：講在跑，再講閒著', async () => {
    const run = await watchedPump('status-removed', []);
    try {
      const sent = run.pump.submit({ kind: 'message', text: '算了', id: 'item-1' });
      expect(run.pump.updateQueue('item-1', { kind: 'remove' })).toBe('updated');
      await sent;
      await run.pump.whenIdle();
      expect(run.told.map(brief)).toEqual(['running', 'idle']);
    } finally {
      await run.close();
    }
  }, 20000);
});

describe('集線器', () => {
  it('中止之後線收掉、訂閱數歸零；已經中止的訊號當場收', async () => {
    const feed = new ThreadFeed();
    const line = new AbortController();
    const stream = feed.subscribe(line.signal);
    expect(feed.subscriberCount).toBe(1);
    const pulling = (async () => {
      for await (const frame of stream) void frame;
    })();
    line.abort();
    await pulling;
    expect(feed.subscriberCount).toBe(0);

    const aborted = AbortSignal.abort();
    const late: ThreadFeedFrame[] = [];
    for await (const frame of feed.subscribe(aborted)) late.push(frame);
    expect(late).toEqual([]);
    expect(feed.subscriberCount).toBe(0);
  });

  it('收掉之後：掛著的線結束，之後接上的直接結束', async () => {
    const feed = new ThreadFeed();
    const stream = feed.subscribe();
    const pulling = (async () => {
      for await (const frame of stream) void frame;
    })();
    feed.close();
    await pulling;
    const after: ThreadFeedFrame[] = [];
    for await (const frame of feed.subscribe()) after.push(frame);
    expect(after).toEqual([]);
  });
});

/** 一條全域線：一直抽，抽到的放進 `frames`。 */
function drain(stream: AsyncGenerator<ThreadFeedFrame, void, undefined>) {
  const frames: ThreadFeedFrame[] = [];
  let wake: (() => void) | undefined;
  const done = (async () => {
    for await (const frame of stream) {
      frames.push(frame);
      wake?.();
    }
  })();
  return {
    frames,
    done,
    /** 等到抽到的東西滿足條件。 */
    async until(ok: (frames: readonly ThreadFeedFrame[]) => boolean): Promise<void> {
      while (!ok(frames)) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/** 抽一條 thread 的下行，抽到那一題之後的 root 收尾為止：那一輪停在核准點、收完了。 */
async function settledAtApproval(line: AsyncGenerator<Event, void, undefined>): Promise<Event> {
  let request: Event | undefined;
  for await (const frame of line) {
    if (frame.method === 'input.requested') request = frame;
    const data = frame.params.data as { event?: string; graph_name?: string } | null;
    if (
      request !== undefined &&
      frame.method === 'lifecycle' &&
      frame.params.namespace.length === 0 &&
      data?.graph_name === 'root' &&
      data.event !== 'running'
    ) {
      return request;
    }
  }
  throw new Error('下行在那一輪收完之前就斷了');
}

/** 真的 handler 與 client。`gatedThreads` 裡的 thread 叫一個要核准的 `alpha`，其餘直接回話。 */
async function wire(gatedThreads: readonly string[]) {
  const disposers: (() => Promise<void>)[] = [];
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async (threadId) => {
      const built = await build(gatedThreads.includes(threadId) ? ['alpha'] : []);
      disposers.push(built.dispose);
      return {
        agent: built.agent as unknown as PumpAgent,
        commands: emptyCommandPoint(),
        attachSessions: composeAttachSessions(built),
        dispose: built.dispose,
      };
    },
    listThreads: async () => ({
      unreadable: 0,
      items: ['parked', 'plain'].map((threadId) => ({ threadId, updatedAt: 1, blank: false })),
    }),
  });
  const client = createWireClient({
    baseUrl: BASE_URL,
    fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
  });
  return { client, handler };
}

describe('走真的線', () => {
  it('停下之後才接上：補送那一題、列表說它在跑；答掉之後撤回、講閒著', async () => {
    const { client, handler } = await wire(['parked']);
    try {
      // 兩條 thread 各跑一輪：一條停在核准點，一條跑完。
      const parkedLine = await client.openEvents('parked');
      await client.runStart('parked', '動手');
      const request = await settledAtApproval(parkedLine);
      const plainLine = await client.openEvents('plain');
      await client.runStart('plain', '你好');
      for await (const frame of plainLine) {
        const data = frame.params.data as { event?: string } | undefined;
        if (frame.method === 'lifecycle' && frame.params.namespace.length === 0) {
          if (data?.event === 'completed') break;
        }
      }

      const feed = drain(await client.openThreadFeed());
      // 列表當起點：停在核准點的算在跑，跑完的閒著。
      const listed = await client.listThreads();
      if (listed.kind !== 'ok') throw new Error(listed.message);
      expect(
        Object.fromEntries(listed.result.items.map((item) => [item.threadId, item.running])),
      ).toEqual({ parked: true, plain: false });

      await feed.until((frames) => frames.length >= 1);
      // 補送的是那條 thread 下行上的同一顆，號一起；狀態不補送。
      expect(feed.frames).toEqual([
        { type: 'input-requested', threadId: 'parked', event: request },
      ]);

      const answered = await client.inputRespond('parked', {
        namespace: [...request.params.namespace],
        interrupt_id: interruptIdOf(request),
        response: { decisions: [{ type: 'approve' }] },
      });
      expect(answered.type).toBe('success');
      await feed.until((frames) => frames.some((frame) => frame.type === 'status'));
      expect(feed.frames.slice(1).map(brief)).toEqual([
        `parked withdrawn ${interruptIdOf(request)}`,
        'parked idle',
      ]);
      await parkedLine.return(undefined);
      await plainLine.return(undefined);
    } finally {
      await handler.close();
    }
  }, 20000);

  it('先接上：兩條 thread 的切換都看得到；停止收回也撤回；關機時線收掉', async () => {
    const { client, handler } = await wire(['parked']);
    let feed: ReturnType<typeof drain> | undefined;
    try {
      feed = drain(await client.openThreadFeed());
      await client.runStart('plain', '你好');
      await feed.until((frames) => frames.map(brief).includes('plain idle'));

      const parkedLine = await client.openEvents('parked');
      await client.runStart('parked', '動手');
      // **等那一輪收完才按停止**：還在收尾時按的話，那一輪照常停在核准點、不收回（`ThreadPump.cancel`）。
      await settledAtApproval(parkedLine);
      await client.runCancel('parked');
      await feed.until((frames) => frames.map(brief).includes('parked idle'));

      const requested = feed.frames.find((frame) => frame.type === 'input-requested');
      if (requested?.type !== 'input-requested') throw new Error('那一題沒來');
      const id = interruptIdOf(requested.event);
      expect(feed.frames.map(brief)).toEqual([
        'plain running',
        'plain idle',
        'parked running',
        `parked requested ${id}`,
        `parked withdrawn ${id}`,
        'parked idle',
      ]);
    } finally {
      await handler.close();
    }
    // 關機收掉全域線：不收的話這一行永遠等不到。
    await feed?.done;
  }, 20000);

  it('沒帶 content-type 的 GET 回 415，不是一條線', async () => {
    const { handler } = await wire([]);
    try {
      const response = await handler.handle(
        loopbackRequest(`${BASE_URL}/threads/feed`, { method: 'GET' }),
      );
      expect(response.status).toBe(415);
    } finally {
      await handler.close();
    }
  });
});
