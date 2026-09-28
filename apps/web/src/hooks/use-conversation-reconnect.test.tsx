import type { Event, WireClient, WireFeedbackItem } from '@nexus/wire';
import { act, cleanup, configure, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversation } from '@/hooks/use-conversation';
import { RECOVERED_NOTICE_MS } from '@/lib/reconnect';

/**
 * 斷線與重接（#593）。退避公式本身驗在 `lib/reconnect.test.ts`；這裡驗 hook 真的在斷線時翻回沒連上、照退避排
 * 重試、接回時整份重建——少了最後一步，serve 重開後 seq 從 0 重算的 frame 會全被折疊器當成重複丟掉。
 */

const ROOT = ['model_request:1'];
function frame(seq: number, runId: string): Event {
  return {
    type: 'event',
    seq,
    event_id: `t:${seq}`,
    method: 'messages',
    params: {
      namespace: ROOT,
      timestamp: 0,
      data: { event: 'message-start', role: 'ai', id: `m-${runId}`, run_id: runId },
    },
  } as Event;
}

/** 一條下行：測試推 frame、正常收掉、或讓它出錯。 */
interface Line {
  push(...events: Event[]): void;
  end(): void;
  fail(message: string): void;
}

/**
 * 每次 `openEvents` 開一條新的 `Line`；`failOpen` 為真時那一次開線直接拋。`extra` 補上其他用得到的 method。
 */
function scriptedClient(extra: Record<string, unknown> = {}) {
  const lines: Line[] = [];
  let failOpen: string | undefined;
  const openEvents = vi.fn(async () => {
    if (failOpen !== undefined) throw new Error(failOpen);
    const queue: Event[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let error: Error | undefined;
    lines.push({
      push: (...events) => {
        queue.push(...events);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
      fail: (message) => {
        error = new Error(message);
        wake?.();
      },
    });
    return (async function* stream() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (error !== undefined) throw error;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    })();
  });
  const client = {
    openEvents,
    threadHistory: async () => ({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false },
    }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
    ...extra,
  } as unknown as WireClient;
  return {
    client,
    openEvents,
    line: (index: number) => lines[index]!,
    latest: () => lines[lines.length - 1]!,
    setFailOpen: (message: string | undefined) => (failOpen = message),
  };
}

/** 讓 promise 鏈跑完、再推進假時鐘。 */
async function tick(ms = 0) {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

let online = true;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // 亂數固定在 0：第 n 次重試等的就是上限的一半，250、500、1000…
  vi.spyOn(Math, 'random').mockReturnValue(0);
  online = true;
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// `main.tsx` 開著 StrictMode：dev 模式先掛上、卸載、再掛上。卸載時收計時器的那個 effect 不能讓之後的重接失效。
describe.each([false, true])('useConversation 斷線與重接的主線（StrictMode：%s）', (strict) => {
  beforeEach(() => configure({ reactStrictMode: strict }));
  afterEach(() => configure({ reactStrictMode: false }));

  it('下行出錯：翻回沒連上、講原因，照退避重接，接回來短暫報「已重新連線」', async () => {
    const { client, openEvents, latest } = scriptedClient();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    expect(result.current.connected).toBe(true);
    expect(result.current.reconnecting).toBeUndefined();
    // StrictMode 下先開的那一條已經被收掉，動的一律是最新那一條；開線次數也從這裡算起。
    const opened = openEvents.mock.calls.length;

    latest().fail('network error');
    await tick();
    expect(result.current.connected).toBe(false);
    expect(result.current.connectionError).toBe('network error');
    expect(result.current.reconnecting).toEqual({ wasConnected: true, offline: false });
    expect(openEvents).toHaveBeenCalledTimes(opened);

    // 第 1 次重試等 250ms（上限 500 的一半）。
    await tick(249);
    expect(openEvents).toHaveBeenCalledTimes(opened);
    await tick(1);
    expect(openEvents).toHaveBeenCalledTimes(opened + 1);
    expect(result.current.connected).toBe(true);
    expect(result.current.connectionError).toBeUndefined();
    expect(result.current.reconnecting).toBeUndefined();
    expect(result.current.recovered).toBe(true);

    await tick(RECOVERED_NOTICE_MS);
    expect(result.current.recovered).toBe(false);
  });
});

describe('useConversation 斷線與重接（#593）', () => {
  it('下行正常收掉也算斷線（server 不會無故收線）', async () => {
    const { client, line } = scriptedClient();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    line(0).end();
    await tick();
    expect(result.current.connected).toBe(false);
    expect(result.current.connectionError).toBeUndefined();
    expect(result.current.reconnecting).toEqual({ wasConnected: true, offline: false });
  });

  it('一直連不上就一直試，間隔照退避加倍、封頂 10 秒；從沒連上過要分得出來', async () => {
    const { client, openEvents, setFailOpen } = scriptedClient();
    setFailOpen('connection refused');
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    expect(result.current.reconnecting).toEqual({ wasConnected: false, offline: false });
    expect(result.current.connectionError).toBe('connection refused');

    const waits = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000];
    for (const [index, wait] of waits.entries()) {
      await tick(wait - 1);
      expect(openEvents).toHaveBeenCalledTimes(index + 1);
      await tick(1);
      expect(openEvents).toHaveBeenCalledTimes(index + 2);
    }
    expect(result.current.connected).toBe(false);
  });

  it('接回來時整份重建：serve 重開後 seq 從 0 重算的 frame 照樣折得進去', async () => {
    const { client, line } = scriptedClient();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    line(0).push(frame(40, 'a'), frame(41, 'b'));
    await tick();
    expect(result.current.state.entries).toHaveLength(2);

    line(0).fail('network error');
    await tick(250);
    expect(result.current.connected).toBe(true);
    // 歷史是空的：重建之後舊的那兩則不在了（本地狀態跟重新整理一樣不留）。
    expect(result.current.state.entries).toHaveLength(0);

    line(1).push(frame(0, 'c'));
    await tick();
    expect(result.current.state.entries).toHaveLength(1);
  });

  it('重接時補送的那顆中斷照樣折得進去：號比斷線前看到的小也收得下（#728）', async () => {
    // serve 沒重開，伺服器接上時補送的是**同一顆**、原本的號（`ThreadPump.subscribe`）。沿用舊的 `lastSeq`
    // 的話它比斷線前看到的最後一顆小，會被當成重複丟掉——面板在重接的那一刻不見，而且再也回不來。
    const approval = {
      type: 'event',
      seq: 40,
      event_id: 't:40',
      method: 'input.requested',
      params: {
        namespace: ['tools:a'],
        timestamp: 0,
        data: {
          interrupt_id: 'int-1',
          payload: {
            actionRequests: [{ name: 'alpha', args: {} }],
            reviewConfigs: [{ actionName: 'alpha', allowedDecisions: ['approve', 'reject'] }],
          },
        },
      },
    } as Event;
    const { client, line } = scriptedClient();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    line(0).push(approval, frame(41, 'a'));
    await tick();
    expect(result.current.state.pendings).toHaveLength(1);

    line(0).fail('network error');
    await tick(250);
    expect(result.current.connected).toBe(true);
    // 前提：重建之後面板跟著不見——歷史折不出它，回來全靠補送。
    expect(result.current.state.pendings).toHaveLength(0);

    line(1).push(approval);
    await tick();
    expect(result.current.state.pendings.map((pending) => pending.interruptId)).toEqual(['int-1']);
  });

  it('「立刻重連」不等退避，退避也從頭算', async () => {
    const { client, openEvents, setFailOpen } = scriptedClient();
    setFailOpen('connection refused');
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    await tick(250);
    await tick(500);
    expect(openEvents).toHaveBeenCalledTimes(3);

    act(() => result.current.reconnectNow());
    await tick();
    expect(openEvents).toHaveBeenCalledTimes(4);
    // 從頭算：下一次又是 250ms，不是 2 秒。
    await tick(250);
    expect(openEvents).toHaveBeenCalledTimes(5);
  });

  it('沒在重接時「立刻重連」什麼都不做', async () => {
    const { client, openEvents } = scriptedClient();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    act(() => result.current.reconnectNow());
    await tick();
    expect(openEvents).toHaveBeenCalledTimes(1);
    expect(result.current.connected).toBe(true);
  });

  it('瀏覽器離線時不排重試；回到線上從第 1 次的退避重算', async () => {
    const { client, openEvents, line } = scriptedClient();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    online = false;
    line(0).fail('network error');
    await tick();
    expect(result.current.reconnecting).toEqual({ wasConnected: true, offline: true });

    await tick(60_000);
    expect(openEvents).toHaveBeenCalledTimes(1);

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await tick();
    expect(result.current.reconnecting).toEqual({ wasConnected: true, offline: false });
    await tick(250);
    expect(openEvents).toHaveBeenCalledTimes(2);
    expect(result.current.connected).toBe(true);
  });

  it('卸載之後排著的重試不再開線', async () => {
    const { client, openEvents, line } = scriptedClient();
    const { unmount } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    line(0).fail('network error');
    await tick();
    unmount();
    await tick(60_000);
    expect(openEvents).toHaveBeenCalledTimes(1);
  });
});

/**
 * 伺服器那一側的評分。`list` 在**送出那一刻**照下存著的那份；`holdLists()` 之後要等 `releaseLists()` 才回，
 * 用來做出「送得早、回得晚」的舊清單。`put` 等 `releasePut()` 才寫進去。
 */
function ratingsServer() {
  const stored = new Map<string, WireFeedbackItem>();
  let holding = false;
  const held: (() => void)[] = [];
  let openPut: (() => void) | undefined;
  const feedbackList = vi.fn(async () => {
    const items = [...stored.values()];
    if (holding) await new Promise<void>((resolve) => held.push(resolve));
    return { kind: 'ok', result: { ok: true, value: { items } } };
  });
  const feedbackPut = vi.fn(
    async (
      _threadId: string,
      params: { messageId: string; rating: WireFeedbackItem['rating'] },
    ) => {
      await new Promise<void>((resolve) => (openPut = resolve));
      const item: WireFeedbackItem = {
        messageId: params.messageId,
        rating: params.rating,
        version: 'v-put',
        createdAt: 0,
        updatedAt: 0,
      };
      stored.set(item.messageId, item);
      return { kind: 'ok', result: { ok: true, value: item } };
    },
  );
  return {
    stored,
    feedbackList,
    feedbackPut,
    holdLists: () => (holding = true),
    releaseLists: () => {
      holding = false;
      for (const resolve of held.splice(0)) resolve();
    },
    releasePut: () => openPut?.(),
  };
}

// StrictMode 下先掛上的那一份會被收掉：重讀要跟著最後那條線走，不能漏也不能多讀一次。
describe.each([false, true])(
  'useConversation 重接之後重讀評分（#772，照 dsh 的 connection/reset；StrictMode：%s）',
  (strict) => {
    beforeEach(() => configure({ reactStrictMode: strict }));
    afterEach(() => configure({ reactStrictMode: false }));

    it('讀過的重讀一次：斷線期間別處改過的評分畫得出來', async () => {
      const server = ratingsServer();
      server.stored.set('m1', {
        messageId: 'm1',
        rating: 'negative',
        version: 'v1',
        createdAt: 0,
        updatedAt: 0,
      });
      const { client, latest } = scriptedClient({ feedbackList: server.feedbackList });
      const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
      await tick();
      act(() => result.current.seedRatings());
      await tick();
      expect(result.current.ratings.get('m1')?.rating).toBe('negative');

      // 斷線期間別的分頁改成讚。
      server.stored.set('m1', {
        messageId: 'm1',
        rating: 'positive',
        version: 'v2',
        createdAt: 0,
        updatedAt: 1,
      });
      latest().fail('network error');
      await tick();
      expect(result.current.connected).toBe(false);
      await tick(250);
      expect(result.current.connected).toBe(true);
      expect(server.feedbackList).toHaveBeenCalledTimes(2);
      expect(result.current.ratings.get('m1')).toMatchObject({ rating: 'positive', version: 'v2' });
    });

    it('沒讀過的不讀：冷的等人滑過再讀', async () => {
      const server = ratingsServer();
      const { client, latest } = scriptedClient({ feedbackList: server.feedbackList });
      const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
      await tick();
      latest().fail('network error');
      await tick();
      expect(result.current.connected).toBe(false);
      await tick(250);
      expect(result.current.connected).toBe(true);
      expect(server.feedbackList).not.toHaveBeenCalled();
    });

    it('重讀排在路上的修改後面：重接前送出的評分不會被舊清單蓋掉', async () => {
      const server = ratingsServer();
      const { client, latest } = scriptedClient({
        feedbackList: server.feedbackList,
        feedbackPut: server.feedbackPut,
      });
      const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
      await tick();
      // 還沒評過的按讚：先開對話框，送出之後才寫；寫的那一次卡在路上。
      await act(() => result.current.rate('m1', 'positive'));
      let submitted: Promise<void> | undefined;
      act(() => {
        submitted = result.current.submitFeedback({ text: '' });
      });
      await tick();
      expect(server.feedbackPut).toHaveBeenCalledTimes(1);

      // 重接那一刻要是直接讀，送出去的清單照下的是還沒寫進去的那份，而且比寫的那一次晚回來。
      server.holdLists();
      latest().fail('network error');
      await tick();
      expect(result.current.connected).toBe(false);
      await tick(250);
      expect(result.current.connected).toBe(true);
      // 重讀還沒送出去：它排在那一次寫後面。
      expect(server.feedbackList).toHaveBeenCalledTimes(1);

      server.releasePut();
      await tick();
      server.releaseLists();
      await act(async () => {
        await submitted;
      });
      await tick();
      expect(server.feedbackList).toHaveBeenCalledTimes(2);
      expect(result.current.ratings.get('m1')).toMatchObject({
        rating: 'positive',
        version: 'v-put',
      });
    });
  },
);
