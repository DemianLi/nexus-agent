import type { Event, WireClient } from '@nexus/wire';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useConversation } from '@/hooks/use-conversation';
import { CLIENT_TIME_ZONE_UNAVAILABLE } from '@/lib/client-time-zone';

/**
 * `send` 帶上瀏覽器時區（[#1630](https://github.com/DemianLi/nexus-agent/issues/1630)，照 dsh 的 `resolvedClientTimeZone`）：
 * 每一次 `run.start` 都在送出當下取 `Intl.DateTimeFormat().resolvedOptions().timeZone`；拿不到就不送、這一句退回；
 * 斜線命令不帶。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** 讓不帶參數的 `new Intl.DateTimeFormat()` 回報 `zone`；帶參數的照真的走（別處的日期格式不受影響）。 */
function stubBrowserZone(zone: () => unknown) {
  const Real = Intl.DateTimeFormat;
  // `function`，不是箭頭函式：呼叫端用 `new`，箭頭函式一 `new` 就拋 TypeError。
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (...args: unknown[]) {
    if (args.length > 0) return new Real(...(args as ConstructorParameters<typeof Real>));
    return { resolvedOptions: () => ({ timeZone: zone() }) } as Intl.DateTimeFormat;
  } as unknown as typeof Intl.DateTimeFormat);
}

function setup() {
  const started: { text: string; options: unknown }[] = [];
  const slashed: unknown[][] = [];
  const events: Event[] = [
    {
      type: 'event',
      seq: 0,
      event_id: 't:0',
      method: 'lifecycle',
      params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
    } as Event,
  ];
  const client = {
    openEvents: async () =>
      (async function* stream() {
        yield* events;
        await new Promise<void>(() => {});
      })(),
    threadHistory: async () => ({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false },
    }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
    slashRun: async (...args: unknown[]) => {
      slashed.push(args);
      return { kind: 'ok', result: { type: 'message', text: '好' } };
    },
    runStart: async (_threadId: string, text: string, options?: unknown) => {
      started.push({ text, options });
      return { type: 'success', id: 1, result: { run_id: `run-${started.length}` } };
    },
  } as unknown as WireClient;
  return { client, started, slashed };
}

async function mounted(client: WireClient) {
  const hook = renderHook(() => useConversation({ client, threadId: 't' }));
  await waitFor(() => expect(hook.result.current.connected).toBe(true));
  return hook.result;
}

describe('send 帶上瀏覽器時區（#1630）', () => {
  it('run.start 的 clientTimeZone 是瀏覽器報的那一個', async () => {
    stubBrowserZone(() => 'Asia/Taipei');
    const { client, started } = setup();
    const result = await mounted(client);
    await act(async () => {
      await result.current.send('一句話', undefined, undefined, undefined, 'req-1');
    });
    expect(started).toEqual([
      { text: '一句話', options: { requestId: 'req-1', clientTimeZone: 'Asia/Taipei' } },
    ]);
  });

  it('每一次送出當下取：中途換了時區，下一句就是新的', async () => {
    let zone = 'Asia/Taipei';
    stubBrowserZone(() => zone);
    const { client, started } = setup();
    const result = await mounted(client);
    await act(async () => {
      await result.current.send('第一句');
    });
    zone = 'Europe/Berlin';
    await act(async () => {
      await result.current.send('第二句', 'steer');
    });
    expect(
      started.map(({ options }) => (options as { clientTimeZone?: string }).clientTimeZone),
    ).toEqual(['Asia/Taipei', 'Europe/Berlin']);
  });

  it.each([
    ['undefined', undefined],
    ['空字串', ''],
    ['不是字串', 8],
  ])('拿不到（%s）：不送出，這一句退回、不標 uncertain', async (_case, zone) => {
    stubBrowserZone(() => zone);
    const { client, started } = setup();
    const result = await mounted(client);
    let rejected: Awaited<ReturnType<typeof result.current.send>>;
    await act(async () => {
      rejected = await result.current.send('一句話');
    });
    expect(started).toEqual([]);
    expect(rejected!).toEqual({ message: CLIENT_TIME_ZONE_UNAVAILABLE });
  });

  it('斜線命令不帶時區（照 dsh 的 commands.execute）', async () => {
    stubBrowserZone(() => 'Asia/Taipei');
    const { client, started, slashed } = setup();
    const result = await mounted(client);
    await act(async () => {
      await result.current.send('/help');
    });
    expect(started).toEqual([]);
    expect(slashed).toEqual([['t', '/help', undefined]]);
  });
});
