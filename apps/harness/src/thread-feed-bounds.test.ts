import { MemorySaver } from '@langchain/langgraph';
import { createWireClient } from '@nexus/wire';
import type { ThreadFeedFrame } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { ThreadFeed } from './thread-feed.js';
import type { PumpActivity, PumpAgent, ThreadPump } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

/**
 * 全域下行每條線的位元組上限（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504) 驗收 5，`ThreadFeed` 這一邊）。
 * pump 用一顆只有 feed 看得到的那幾個成員的假的，活動由測試直接餵。
 */

interface FakePump {
  readonly threadId: string;
  pendings: { request: unknown }[];
  emit: (activity: PumpActivity) => void;
}

function fakePump(threadId: string): { pump: FakePump; asPump: ThreadPump } {
  let watcher: ((activity: PumpActivity) => void) | undefined;
  const pump: FakePump = {
    threadId,
    pendings: [],
    emit: (activity) => watcher?.(activity),
  };
  const asPump = {
    threadId,
    get pendings() {
      return pump.pendings;
    },
    watch(callback: (activity: PumpActivity) => void) {
      watcher = callback;
      return () => {
        watcher = undefined;
      };
    },
  } as unknown as ThreadPump;
  return { pump, asPump };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const activity = (pad: string): PumpActivity => ({ type: 'status', running: true, pad }) as never;

/** 在背景抽一條線，收進 `frames`。 */
function pullInBackground(feed: ThreadFeed) {
  const frames: ThreadFeedFrame[] = [];
  const line = new AbortController();
  const done = (async () => {
    for await (const frame of feed.subscribe(line.signal)) frames.push(frame);
  })();
  return {
    frames,
    stop: async () => {
      line.abort();
      await done;
    },
  };
}

describe('全域下行的位元組上限', () => {
  it('不抽的那條超限就被收掉，其他線照常收到每一顆；它之後抽只會結束', async () => {
    const warned: string[] = [];
    const feed = new ThreadFeed({ maxQueuedBytes: 300, warn: (message) => warned.push(message) });
    const { pump, asPump } = fakePump('t1');
    feed.attach(asPump);

    const healthy = pullInBackground(feed);
    const stuck = feed.subscribe(); // 註冊是同步的，但不抽
    await settle(); // 讓健康那條停在「等下一顆」
    expect(feed.subscriberCount).toBe(2);

    pump.emit(activity('a'.repeat(150)));
    await settle(); // 健康那條抽走；不抽的那條照舊積著
    expect(feed.subscriberCount).toBe(2);
    pump.emit(activity('b'.repeat(150))); // 不抽的那條累計超過 300
    // 超限那一顆之後立刻少一條：同步拿掉，不等 drain 醒來。
    expect(feed.subscriberCount).toBe(1);
    await settle();
    pump.emit(activity('c'.repeat(10)));

    await settle();
    expect(healthy.frames).toHaveLength(3);
    expect(await stuck.next()).toEqual({ done: true, value: undefined });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('300');
    await healthy.stop();
  });

  it('開線補送超過上限：線照樣開著、補送照樣收得到；下一顆即時事件才超限', async () => {
    const feed = new ThreadFeed({ maxQueuedBytes: 300 });
    const { pump, asPump } = fakePump('t1');
    feed.attach(asPump);
    pump.pendings = [{ request: { pad: 'p'.repeat(500), seq: 1 } }];

    const line = feed.subscribe(); // 不抽
    expect(feed.subscriberCount).toBe(1);
    pump.emit(activity('x'));
    // 補送已經占滿，這一顆即時事件超限。
    expect(feed.subscriberCount).toBe(0);
    expect(await line.next()).toEqual({ done: true, value: undefined });

    // 另一條：補送後立刻抽，補送完整到手。
    const again = pullInBackground(feed);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(again.frames).toHaveLength(1);
    expect(again.frames[0]).toMatchObject({ type: 'input-requested', threadId: 't1' });
    await again.stop();
  });

  it('序列化不了的事件：收掉所有在收的線、記一行，廣播不拋，之後的事件照常', async () => {
    const warned: string[] = [];
    const feed = new ThreadFeed({ warn: (message) => warned.push(message) });
    const { pump, asPump } = fakePump('t1');
    feed.attach(asPump);

    const a = feed.subscribe();
    const b = feed.subscribe();
    expect(() => pump.emit({ type: 'status', running: true, n: 1n } as never)).not.toThrow();
    expect(feed.subscriberCount).toBe(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('2 條');
    expect(await a.next()).toEqual({ done: true, value: undefined });
    expect(await b.next()).toEqual({ done: true, value: undefined });

    // 之後接上的線不受影響。
    const later = pullInBackground(feed);
    pump.emit(activity('ok'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(later.frames).toHaveLength(1);
    await later.stop();
  });

  it('沒有線在收的時候，序列化不了的事件連算都不算：不拋也不記', () => {
    const warned: string[] = [];
    const feed = new ThreadFeed({ warn: (message) => warned.push(message) });
    const { pump, asPump } = fakePump('t1');
    feed.attach(asPump);
    expect(() => pump.emit({ type: 'status', running: true, n: 1n } as never)).not.toThrow();
    expect(warned).toEqual([]);
  });

  it('開線補送序列化不了：收掉這一條、記一行、不拋', async () => {
    const warned: string[] = [];
    const feed = new ThreadFeed({ warn: (message) => warned.push(message) });
    const { pump, asPump } = fakePump('t1');
    feed.attach(asPump);
    pump.pendings = [{ request: { n: 1n } }];
    const line = feed.subscribe();
    expect(await line.next()).toEqual({ done: true, value: undefined });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('補送');
  });
});

/** 迭代造一條 `n` 層的陣列鏈。 */
function chain(n: number): unknown[] {
  const root: unknown[] = [];
  let tail = root;
  for (let level = 1; level < n; level++) {
    const next: unknown[] = [];
    tail.push(next);
    tail = next;
  }
  return root;
}

describe('巢狀太深的 frame（偏離 D，#1560 N1384）', () => {
  it('廣播：兩萬層的活動，線不被收掉，副本被截斷，記一行不含內容', async () => {
    const warned: string[] = [];
    const feed = new ThreadFeed({ warn: (message) => warned.push(message) });
    const { pump, asPump } = fakePump('t1');
    feed.attach(asPump);
    const line = pullInBackground(feed);

    pump.emit({ type: 'status', running: true, deep: chain(20_000) } as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(feed.subscriberCount).toBe(1);
    expect(line.frames).toHaveLength(1);
    expect(JSON.stringify(line.frames[0])).toContain('[truncated: depth]');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('截斷');
    expect(warned[0]).toContain('t1');
    await line.stop();
  });

  it('開線補送：深的那顆也截斷，這條線不被收掉', async () => {
    const warned: string[] = [];
    const feed = new ThreadFeed({ warn: (message) => warned.push(message) });
    const { pump, asPump } = fakePump('t1');
    feed.attach(asPump);
    pump.pendings = [{ request: { deep: chain(20_000) } }];
    const line = pullInBackground(feed);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(feed.subscriberCount).toBe(1);
    expect(JSON.stringify(line.frames[0])).toContain('[truncated: depth]');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('補送');
    await line.stop();
  });
});

describe('createWireHandler 把上限交給全域下行', () => {
  it('downlinkMaxBytes 調到 20：全域下行第一顆狀態 frame 就超限被收，warn 經 handler 的 warn 出去', async () => {
    const warned: string[] = [];
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      downlinkMaxBytes: 20,
      warn: (message) => warned.push(message),
      createAgent: async () => {
        const built = await createNexusAgent({
          model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
          checkpointer: new MemorySaver(),
          plugins: [],
        });
        return {
          agent: built.agent as unknown as PumpAgent,
          commands: emptyCommandPoint(),
          attachSessions: composeAttachSessions(built),
          dispose: built.dispose,
        };
      },
    });
    try {
      const client = createWireClient({
        baseUrl: 'http://feed-bounds.test',
        fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
      });
      const feed = await client.openThreadFeed();
      await client.runStart('t1', '嗨');
      // 沒調上限的話這裡會拿到一顆 `status`；超限被收，線直接結束。
      expect(await feed.next()).toEqual({ done: true, value: undefined });
      expect(warned.filter((message) => message.includes('全域下行'))).not.toEqual([]);
    } finally {
      await handler.close();
    }
  });
});
