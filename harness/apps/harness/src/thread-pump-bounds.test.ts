/**
 * 每條 thread 下行的位元組上限（[#1504](https://github.com/DemianLi/nexus-agent/issues/1504) 驗收 5，`ThreadPump` 這一邊），
 * 與補充 (i) 的序列化拋錯：算位元組的 `JSON.stringify` 拋了，收掉那些本來會收這顆的線、記一行，**錯誤不打回產生事件的路徑**。
 *
 * 做法同 `pump-reply-baseline.test.ts`：假 agent，frame 由測試一顆一顆餵進去，所以「接上的那一刻」是確定的。
 *
 * **零憑證、零外部連線**。
 */

import type { Event } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

const CHANNELS = ['messages', 'tools', 'lifecycle', 'input', 'custom'] as const;
type Channel = (typeof CHANNELS)[number];

const raw = (method: string, data: unknown, node?: string) => ({
  type: 'event',
  seq: 0,
  method,
  params: {
    namespace: [] as string[],
    timestamp: 0,
    ...(node === undefined ? {} : { node }),
    data,
  },
});

const start = (runId: string, id: string) =>
  raw('messages', { event: 'message-start', role: 'ai', run_id: runId, id });
const text = (runId: string, value: string, extra: Record<string, unknown> = {}) =>
  raw('messages', {
    event: 'content-block-delta',
    run_id: runId,
    index: 0,
    delta: { type: 'text-delta', text: value, ...extra },
  });
const STATUS = raw('lifecycle', { event: 'started', graph_name: 'root' });

function fedAgent() {
  const pending: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  const agent = {
    streamEvents: async (_input: unknown, config: { configurable: Record<string, unknown> }) => {
      const signal = Object.values(config.configurable).find(
        (value): value is AbortSignal => value instanceof AbortSignal,
      );
      signal?.addEventListener('abort', () => wake?.(), { once: true });
      return (async function* () {
        for (;;) {
          while (pending.length > 0) yield pending.shift();
          if (signal?.aborted === true) throw new Error('被切斷了');
          if (ended) return;
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
        }
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  };
  return {
    agent: agent as unknown as PumpAgent,
    feed: (frame: unknown) => {
      pending.push(frame);
      wake?.();
    },
    end: () => {
      ended = true;
      wake?.();
    },
  };
}

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) await item.close();
});

/** 一條一開始就掛著的觀察線（用來知道 pump 抽到哪了），與開跑的一輪。 */
async function running(maxBytes: number) {
  const fed = fedAgent();
  const warned: string[] = [];
  const pump = new ThreadPump(
    fed.agent,
    'bounds-root',
    undefined,
    undefined,
    undefined,
    undefined,
    (message) => warned.push(message),
    false,
    undefined,
    [],
    undefined,
    undefined,
    undefined,
    maxBytes,
  );
  const observer = join(pump, CHANNELS);
  const outcome: { rejected?: unknown } = {};
  open.push({
    close: async () => {
      fed.end();
      pump.close();
      await observer.close();
    },
  });
  pump.submit({ kind: 'message', text: '嗨', id: 'item-1' }).catch((error: unknown) => {
    outcome.rejected = error;
  });
  await until(() => pump.sessionLog.events.some((event) => event.type === 'turn/start'));
  return {
    pump,
    warned,
    outcome,
    observer,
    /** 餵一顆、等觀察線收到它。 */
    async send(frame: ReturnType<typeof raw>) {
      const before = observer.frames.length;
      fed.feed(frame);
      await until(() => observer.frames.length > before);
    },
    /** 餵一顆、不等：給觀察線收不到的那幾顆。 */
    feed: fed.feed,
  };
}

/** 開一條下行並在背景抽：註冊是同步的。 */
function join(pump: ThreadPump, channels: readonly Channel[]) {
  const frames: Event[] = [];
  const line = new AbortController();
  const draining = (async () => {
    for await (const frame of pump.subscribe(channels, line.signal)) frames.push(frame);
  })();
  return {
    frames,
    close: async () => {
      line.abort();
      await draining;
    },
  };
}

const BIG = 'z'.repeat(1200);

describe('每條 thread 下行的位元組上限', () => {
  it('不抽的那條超限就被收掉（subscriberCount 立刻少一條），抽著的觀察線照常收到每一顆', async () => {
    const run = await running(2500);
    await run.send(start('r1', 'run-r1'));
    const stuck = run.pump.subscribe(CHANNELS); // 註冊是同步的，但不抽
    expect(run.pump.subscriberCount).toBe(2);
    const seen = run.observer.frames.length;

    await run.send(text('r1', BIG));
    expect(run.pump.subscriberCount).toBe(2);
    await run.send(text('r1', BIG)); // 不抽的那條累計超過 2500
    expect(run.pump.subscriberCount).toBe(1);
    await run.send(text('r1', 'tail'));

    // 觀察線一顆不缺。
    expect(run.observer.frames.length).toBe(seen + 3);
    expect(JSON.stringify(run.observer.frames.at(-1))).toContain('tail');
    // 被收掉的那條之後抽只會結束，排著的已經清空。
    expect(await stuck.next()).toEqual({ done: true, value: undefined });
    expect(run.warned).toHaveLength(1);
    expect(run.warned[0]).toContain('bounds-root');
    expect(run.warned[0]).toContain('2500');
    expect(run.outcome.rejected).toBeUndefined();
  });

  it('開線補送超過上限：線照樣開著、補送收得到；下一顆即時 frame 才超限', async () => {
    const run = await running(2500);
    await run.send(start('r1', 'run-r1'));
    for (let index = 0; index < 3; index += 1) await run.send(text('r1', BIG));

    // 還沒落盤的回覆補送約 3.6 KB，超過上限 2500，但補送不判上限。
    const joined = run.pump.subscribe(CHANNELS);
    expect(run.pump.subscriberCount).toBe(2);
    await run.send(text('r1', 'x'));
    // 補送已經占滿，這一顆即時 frame 超限。
    expect(run.pump.subscriberCount).toBe(1);
    expect(await joined.next()).toEqual({ done: true, value: undefined });

    // 補送本身完整：換一條立刻抽的，baseline 到手。
    const again = join(run.pump, CHANNELS);
    open.push(again);
    await until(() => again.frames.length >= 1);
    expect(JSON.stringify(again.frames)).toContain(BIG);
  });

  it('沒訂這個 channel 的線不算位元組、不被收', async () => {
    const run = await running(2500);
    await run.send(start('r1', 'run-r1'));
    const lifecycleOnly = run.pump.subscribe(['lifecycle']); // 不抽，但訂的不是 messages
    await run.send(text('r1', BIG));
    await run.send(text('r1', BIG));
    await run.send(text('r1', BIG));
    expect(run.pump.subscriberCount).toBe(2);
    void lifecycleOnly.return(undefined);
  });
});

describe('序列化拋錯（補充 (i)）', () => {
  it('收掉本來會收這顆的線、記一行；沒訂這個 channel 的不受影響；產生事件的路徑沒拋；之後的事件照常', async () => {
    const run = await running(1_000_000);
    await run.send(start('r1', 'run-r1'));
    const messagesLine = join(run.pump, ['messages']);
    open.push(messagesLine);
    const lifecycleLine = join(run.pump, ['lifecycle']);
    open.push(lifecycleLine);
    await settle();
    expect(run.pump.subscriberCount).toBe(3);

    // BigInt 進不了 JSON.stringify。觀察線也訂了 messages，所以它跟 messagesLine 都會被收掉。
    run.feed(text('r1', 'boom', { big: 10n }));
    await until(() => run.pump.subscriberCount === 1);
    expect(run.warned).toHaveLength(1);
    expect(run.warned[0]).toContain('無法序列化');
    expect(run.warned[0]).toContain('2 條');
    // 產生事件的路徑沒拋：這一輪的 submit 沒有 reject，pump 還能繼續收事件。
    expect(run.outcome.rejected).toBeUndefined();

    // 沒訂 messages 的線還活著、收得到之後的事件。
    run.feed(STATUS);
    await until(() => lifecycleLine.frames.length >= 1);
    expect(run.pump.subscriberCount).toBe(1);

    // 之後新接上的 messages 線照常收到之後的 frame。
    const later = join(run.pump, ['messages']);
    open.push(later);
    await settle();
    run.feed(text('r1', '之後的字'));
    await until(() => later.frames.some((frame) => JSON.stringify(frame).includes('之後的字')));
    expect(run.outcome.rejected).toBeUndefined();
  });

  it('沒有線在收這顆時連算都不算：不拋也不記', async () => {
    const run = await running(1_000_000);
    await run.send(start('r1', 'run-r1'));
    await run.observer.close();
    // 觀察線走了，沒有任何線。
    run.feed(text('r1', 'boom', { big: 10n }));
    await settle();
    await settle();
    expect(run.warned).toEqual([]);
    expect(run.outcome.rejected).toBeUndefined();
  });

  it('開線補送序列化不了：收掉這一條、記一行、不拋', async () => {
    const run = await running(1_000_000);
    await run.observer.close(); // 沒有線在收，廣播時不算位元組，所以這顆中斷會安然進到 pending
    run.feed(
      raw(
        'updates',
        {
          values: [
            { id: 'int-1', value: { actionRequests: [{ name: 'danger', args: { n: 1n } }] } },
          ],
        },
        '__interrupt__',
      ),
    );
    await until(() => run.pump.pendings.length > 0);

    const line = run.pump.subscribe(['input']);
    expect(await line.next()).toEqual({ done: true, value: undefined });
    expect(run.warned).toHaveLength(1);
    expect(run.warned[0]).toContain('補送');
    expect(run.outcome.rejected).toBeUndefined();
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

describe('巢狀太深的事件（偏離 D，#1560 N1384）', () => {
  // 兩萬層：Linux Node 22 上遞迴的 JSON.stringify 會爆（拿掉 `boundFrame` 就走 `#failSubscribers` 把線收掉）；macOS Node 25 不會爆，
  // 所以紅燈靠「副本含截斷佔位」，那一條不看平台。
  it('廣播：下行不斷，這一顆的副本被截斷、之後的事件照常，記一行且不含內容', async () => {
    const run = await running(10_000_000);
    await run.send(start('r1', 'run-r1'));
    const line = join(run.pump, ['messages']);
    open.push(line);
    await settle();
    expect(run.pump.subscriberCount).toBe(2);

    run.feed(text('r1', '深', { deep: chain(20_000) }));
    await until(() =>
      line.frames.some((frame) => JSON.stringify(frame).includes('[truncated: depth]')),
    );
    expect(run.pump.subscriberCount).toBe(2);
    expect(run.warned).toHaveLength(1);
    expect(run.warned[0]).toContain('截斷');
    expect(run.warned[0]).toContain('messages');
    expect(run.warned[0]).toContain('bounds-root');
    expect(run.warned[0]).not.toContain('深');
    expect(run.outcome.rejected).toBeUndefined();

    run.feed(text('r1', '之後的字'));
    await until(() => line.frames.some((frame) => JSON.stringify(frame).includes('之後的字')));
  });

  // 開線補送走另一條路（`subscribe` 裡的 `seed`），不經 `#broadcast`：不截的話，重連之後每一次開線都會再爆一次。
  it('開線補送：深的那顆也截斷，這條線不被收掉', async () => {
    const run = await running(10_000_000);
    await run.observer.close(); // 沒有線在收，廣播時不算，這顆中斷安然進到 pending
    run.feed(
      raw(
        'updates',
        {
          values: [
            {
              id: 'int-1',
              value: { actionRequests: [{ name: 'danger', args: { deep: chain(20_000) } }] },
            },
          ],
        },
        '__interrupt__',
      ),
    );
    await until(() => run.pump.pendings.length > 0);

    const line = run.pump.subscribe(['input']);
    const first = await line.next();
    expect(first.done).toBe(false);
    expect(JSON.stringify(first.value)).toContain('[truncated: depth]');
    expect(run.pump.subscriberCount).toBe(1);
    expect(run.warned).toHaveLength(1);
    expect(run.warned[0]).toContain('補送');
    expect(run.warned[0]).toContain('截斷');
    void line.return(undefined);
  });
});
