import type { Event, WireClient, WireFeedbackItem } from '@nexus/wire';
import {
  createWireClient,
  historyPath,
  streamPath,
  THREAD_AT_CAPACITY,
  THREAD_HISTORY_TOO_DEEP,
  THREAD_LOG_BUSY,
  THREAD_LOG_TOO_LARGE,
  THREAD_IS_SUBAGENT,
  WireProtocolError,
  WireRejectedError,
} from '@nexus/wire';
import { act, cleanup, configure, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useConversation } from '@/hooks/use-conversation';
import { RECONNECT_MAX_MS, RECOVERED_NOTICE_MS } from '@/lib/reconnect';
import { THREAD_AT_CAPACITY_TEXT } from '@/lib/thread-capacity';
import { THREAD_HISTORY_TOO_DEEP_TEXT } from '@/lib/thread-history-too-deep';
import { THREAD_PROTOCOL_ERROR_TEXT } from '@/lib/thread-protocol-error';
import { THREAD_LOG_BUSY_TEXT, THREAD_LOG_TOO_LARGE_TEXT } from '@/lib/thread-log-budget';
import { THREAD_IS_SUBAGENT_TEXT } from '@/lib/thread-subagent';

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
  let failOpen: string | Error | undefined;
  const openEvents = vi.fn(async () => {
    if (failOpen !== undefined) throw typeof failOpen === 'string' ? new Error(failOpen) : failOpen;
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
    setFailOpen: (failure: string | Error | undefined) => (failOpen = failure),
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

/** serve 拒收下行時 `openEvents` 拋的型別錯誤（#1481）：message 用 serve 的原文，測試要看它沒上畫面。 */
function rejected(code: string, serverMessage: string) {
  const body = JSON.stringify({ type: 'error', id: null, error: code, message: serverMessage });
  return new WireRejectedError(code, serverMessage, `下行被拒：${body}`);
}

describe('useConversation 下行被拒：永久的不重試，暫時的照試（#1708）', () => {
  it('子代理的會話：講那一句、不排重試；推過最長的退避、按「立刻重連」、網路回來都不再開', async () => {
    const { client, openEvents, setFailOpen } = scriptedClient();
    setFailOpen(
      rejected(
        THREAD_IS_SUBAGENT,
        '"t/1" 是子代理的會話，不能當一條 thread 開；要對它說話，請從它的主對話用 subagent.send。',
      ),
    );
    const { result } = renderHook(() => useConversation({ client, threadId: 't/1' }));
    await tick();
    expect(result.current.connected).toBe(false);
    expect(result.current.refusal).toBe(THREAD_IS_SUBAGENT_TEXT);
    expect(result.current.connectionError).toBeUndefined();
    expect(result.current.reconnecting).toBeUndefined();

    await tick(60_000);
    act(() => result.current.reconnectNow());
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await tick(60_000);
    expect(openEvents).toHaveBeenCalledOnce();
    expect(result.current.refusal).toBe(THREAD_IS_SUBAGENT_TEXT);
  });

  it('歷史太深（#1753）：講那一句、不接原文、不排重試；推過最長的退避、按「立刻重連」、網路回來都不再開', async () => {
    const { client, openEvents, setFailOpen } = scriptedClient();
    setFailOpen(
      rejected(
        THREAD_HISTORY_TOO_DEEP,
        '這條 thread 建不起來：日誌第 3 顆事件巢狀 3000 層，超過上限 600',
      ),
    );
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    expect(result.current.connected).toBe(false);
    expect(result.current.refusal).toBe(THREAD_HISTORY_TOO_DEEP_TEXT);
    expect(result.current.connectionError).toBeUndefined();
    expect(result.current.reconnecting).toBeUndefined();

    await tick(60_000);
    act(() => result.current.reconnectNow());
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await tick(60_000);
    expect(openEvents).toHaveBeenCalledOnce();
    expect(result.current.refusal).toBe(THREAD_HISTORY_TOO_DEEP_TEXT);
  });

  it('紀錄太大（#2203）：永久的，講那一句、不排重試，立刻重連與 online 也不再開', async () => {
    const { client, openEvents, setFailOpen } = scriptedClient();
    setFailOpen(rejected(THREAD_LOG_TOO_LARGE, '會話日誌 115 MiB 超過額度 109 MiB'));
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    expect(result.current.refusal).toBe(THREAD_LOG_TOO_LARGE_TEXT);
    expect(result.current.connectionError).toBeUndefined();
    expect(result.current.reconnecting).toBeUndefined();

    await tick(60_000);
    act(() => result.current.reconnectNow());
    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });
    await tick(60_000);
    expect(openEvents).toHaveBeenCalledOnce();
  });

  it('額度被佔滿（#2203）：暫時的，照退避重試，講那一句、不接 server 的原文', async () => {
    const { client, openEvents, setFailOpen } = scriptedClient();
    setFailOpen(rejected(THREAD_LOG_BUSY, '額度已佔 100 MiB，上限 109 MiB'));
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    expect(result.current.refusal).toBe(THREAD_LOG_BUSY_TEXT);
    expect(result.current.connectionError).toBeUndefined();
    expect(result.current.reconnecting).toEqual({ wasConnected: false, offline: false });

    await tick(60_000);
    expect(openEvents.mock.calls.length).toBeGreaterThan(1);
  });

  it('對照組：thread 數滿了是暫時的，照退避重試，refusal 是另一句', async () => {
    const { client, openEvents, setFailOpen } = scriptedClient();
    setFailOpen(rejected(THREAD_AT_CAPACITY, 'thread 數已到上限 2／2'));
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await tick();
    expect(result.current.refusal).toBe(THREAD_AT_CAPACITY_TEXT);
    expect(result.current.reconnecting).toEqual({ wasConnected: false, offline: false });

    await tick(250);
    expect(openEvents).toHaveBeenCalledTimes(2);
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

    it('伺服器不收評分（#1849）：停用；重接之後重讀，伺服器改成收評分就恢復', async () => {
      let unsupported = true;
      const feedbackList = vi.fn(async () =>
        unsupported
          ? { kind: 'rejected', code: 'not_supported', message: '這個組裝沒有掛落盤，評分存不住' }
          : {
              kind: 'ok',
              result: {
                ok: true,
                value: {
                  items: [
                    {
                      messageId: 'm1',
                      rating: 'positive',
                      version: 'v1',
                      createdAt: 0,
                      updatedAt: 0,
                    },
                  ],
                },
              },
            },
      );
      const { client, latest } = scriptedClient({ feedbackList });
      const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
      await tick();
      act(() => result.current.seedRatings());
      await tick();
      expect(result.current.ratingsUnsupported).toBe(true);
      expect(result.current.ratingsLoadFailed).toBe(false);
      // 不收評分的不再試：再滑過也不打。
      act(() => result.current.seedRatings());
      await tick();
      expect(feedbackList).toHaveBeenCalledTimes(1);

      // 伺服器重開、改成落盤開著。
      unsupported = false;
      latest().fail('network error');
      await tick();
      await tick(250);
      expect(result.current.connected).toBe(true);
      expect(feedbackList).toHaveBeenCalledTimes(2);
      expect(result.current.ratingsUnsupported).toBe(false);
      expect(result.current.ratings.get('m1')?.rating).toBe('positive');
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

/**
 * **真的 `createWireClient`**，只注入 `fetch`（#1601 `N0758`）：下行是測試推進去的 SSE 位元組，歷史是測試給的 JSON。壞資料由
 * client 自己的驗證（`decodeSseStream` 的 `assertWireEvent`、`readHistory` 的頁欄位與每一筆）認出來、拋 `WireProtocolError`，
 * 測試不自己丟替身：拿掉 nexus-wire 那一側的接線，這裡也會紅。`slashList` 不在這條路上，換成固定的回答。thread 認 `t` 與 `u`。
 */
function wiredClient() {
  const encoder = new TextEncoder();
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const goodPage = { events: [], firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false };
  let page: unknown = goodPage;
  let holdNext = false;
  const held: ((page: unknown) => void)[] = [];
  let failNext: string | undefined;
  const opened = vi.fn();
  const threads = ['t', 'u'];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    if (threads.some((id) => path === historyPath(id))) {
      let result = page;
      if (holdNext) {
        holdNext = false;
        result = await new Promise((resolve) => held.push(resolve));
      }
      return new Response(JSON.stringify({ type: 'success', result }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (!threads.some((id) => path === streamPath(id))) throw new Error(`沒預期的請求：${path}`);
    opened();
    if (failNext !== undefined) {
      const message = failNext;
      failNext = undefined;
      throw new TypeError(message);
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    streams.push(controller);
    init?.signal?.addEventListener('abort', () => {
      try {
        controller.close();
      } catch {
        // 已經收掉或被 client 取消了。
      }
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const real = createWireClient({ baseUrl: 'http://wire.test', fetch });
  const client: WireClient = { ...real, slashList: async () => ({ kind: 'ok', commands: [] }) };
  const latest = () => streams[streams.length - 1]!;
  return {
    client,
    opened,
    /** 往最新那條下行推一顆 `data:`（原樣的 JSON 值）。 */
    send: (data: unknown) => latest().enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)),
    /** 最新那條下行正常收掉（伺服器收線、網路斷）。 */
    end: () => latest().close(),
    /** 最新那條下行在網路層出錯：一般的斷線，`connectionError` 是這一句。 */
    fail: (message: string) => latest().error(new TypeError(message)),
    /** 下一次開線在網路層失敗（`fetch` 拋）。 */
    failNextOpen: (message: string) => (failNext = message),
    /** 扣住下一次的歷史頁：開線停在路上，等 {@link release} 交出那一頁。 */
    hold: () => (holdNext = true),
    release: (next: unknown) => held.shift()!(next),
    setPage: (next: unknown) => (page = next),
    goodPage,
  };
}

/** 少了 `params`：`assertWireEvent` 認得出來的壞幀，折疊器碰到會丟 `TypeError`（#1555 的重現）。 */
const BROKEN_FRAME = { type: 'event', seq: 1, event_id: 't:1', method: 'messages' };

describe.each([false, true])(
  '伺服器送來看不懂的資料：停止自動重連，等人按（#1601 N0758，StrictMode：%s）',
  (strict) => {
    beforeEach(() => configure({ reactStrictMode: strict }));
    afterEach(() => configure({ reactStrictMode: false }));

    it('下行一顆壞幀：講那一句、原文只進 console.warn；退避跑完也不重開，按「立刻重連」才開', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      const { result } = renderHook(() => useConversation({ client: wire.client, threadId: 't' }));
      await tick();
      expect(result.current.connected).toBe(true);
      const opened = wire.opened.mock.calls.length;

      wire.send(BROKEN_FRAME);
      await tick();
      expect(result.current.connected).toBe(false);
      expect(result.current.refusal).toBe(THREAD_PROTOCOL_ERROR_TEXT);
      expect(result.current.connectionError).toBeUndefined();
      expect(result.current.reconnecting).toEqual({ wasConnected: true, offline: false });
      expect(warn.mock.calls.some(([error]) => error instanceof WireProtocolError)).toBe(true);

      await tick(RECONNECT_MAX_MS * 4);
      expect(wire.opened).toHaveBeenCalledTimes(opened);

      act(() => result.current.reconnectNow());
      await tick();
      expect(wire.opened).toHaveBeenCalledTimes(opened + 1);
      expect(result.current.connected).toBe(true);
      expect(result.current.refusal).toBeUndefined();
      expect(result.current.reconnecting).toBeUndefined();
    });

    it('歷史頁裡一筆壞事件（readHistory 驗出來）：同一個判斷，第一次開線就停住', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      wire.setPage({ ...wire.goodPage, events: [BROKEN_FRAME] });
      const { result } = renderHook(() => useConversation({ client: wire.client, threadId: 't' }));
      await tick();
      expect(result.current.connected).toBe(false);
      expect(result.current.refusal).toBe(THREAD_PROTOCOL_ERROR_TEXT);
      expect(result.current.reconnecting).toEqual({ wasConnected: false, offline: false });
      const opened = wire.opened.mock.calls.length;

      await tick(RECONNECT_MAX_MS * 4);
      expect(wire.opened).toHaveBeenCalledTimes(opened);

      wire.setPage(wire.goodPage);
      act(() => result.current.reconnectNow());
      await tick();
      expect(result.current.connected).toBe(true);
      expect(result.current.refusal).toBeUndefined();
    });

    it('停住之後網路斷了又回來：不重連（不是載體的問題）', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      const { result } = renderHook(() => useConversation({ client: wire.client, threadId: 't' }));
      await tick();
      const opened = wire.opened.mock.calls.length;
      wire.send(BROKEN_FRAME);
      await tick();

      online = false;
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });
      online = true;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await tick(RECONNECT_MAX_MS * 4);
      expect(wire.opened).toHaveBeenCalledTimes(opened);
      expect(result.current.refusal).toBe(THREAD_PROTOCOL_ERROR_TEXT);
      expect(result.current.reconnecting).toEqual({ wasConnected: true, offline: false });
    });

    it('按「立刻重連」接回之後，下一次一般的斷線照舊：網路回來就自動重連', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      const { result } = renderHook(() => useConversation({ client: wire.client, threadId: 't' }));
      await tick();
      wire.send(BROKEN_FRAME);
      await tick();
      act(() => result.current.reconnectNow());
      await tick();
      expect(result.current.connected).toBe(true);
      const opened = wire.opened.mock.calls.length;

      online = false;
      wire.end();
      await tick();
      expect(result.current.reconnecting).toEqual({ wasConnected: true, offline: true });
      online = true;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await tick(RECONNECT_MAX_MS);
      expect(wire.opened).toHaveBeenCalledTimes(opened + 1);
      expect(result.current.connected).toBe(true);
    });

    it('競態：排著的那次到點、還沒換上時，在路上那次才停住；接著那次接上，之後一般的斷線照舊自動重連', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      const { result } = renderHook(() => useConversation({ client: wire.client, threadId: 't' }));
      await tick();
      wire.fail('network error');
      await tick();
      wire.hold();
      await tick(250);
      const opened = wire.opened.mock.calls.length;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      // 同一個 act：計時器到點（新的一輪排著、還沒換上），在路上那次這時才拿到壞的那一頁。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(250);
        wire.release({ ...wire.goodPage, events: [BROKEN_FRAME] });
        for (let i = 0; i < 20; i++) await Promise.resolve();
      });
      await tick();
      // 在路上那次真的停住過：沒有這一條，競態沒做出來，這一格白綠。
      expect(warn.mock.calls.some(([error]) => error instanceof WireProtocolError)).toBe(true);
      expect(wire.opened).toHaveBeenCalledTimes(opened + 1);
      expect(result.current.connected).toBe(true);
      expect(result.current.refusal).toBeUndefined();

      online = false;
      wire.end();
      await tick();
      online = true;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await tick(RECONNECT_MAX_MS);
      expect(wire.opened).toHaveBeenCalledTimes(opened + 2);
      expect(result.current.connected).toBe(true);
    });

    it('換 thread：前一條停住，新的一條第一次開線在網路層失敗，網路回來照常自動重連', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      const { result, rerender } = renderHook(
        ({ threadId }) => useConversation({ client: wire.client, threadId }),
        { initialProps: { threadId: 't' } },
      );
      await tick();
      wire.send(BROKEN_FRAME);
      await tick();
      expect(result.current.refusal).toBe(THREAD_PROTOCOL_ERROR_TEXT);
      const opened = wire.opened.mock.calls.length;

      online = false;
      wire.failNextOpen('network error');
      rerender({ threadId: 'u' });
      await tick();
      expect(wire.opened).toHaveBeenCalledTimes(opened + 1);
      expect(result.current.refusal).toBeUndefined();
      expect(result.current.reconnecting?.offline).toBe(true);

      online = true;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });
      await tick(RECONNECT_MAX_MS);
      expect(wire.opened).toHaveBeenCalledTimes(opened + 2);
      expect(result.current.connected).toBe(true);
    });

    it('停住時收掉排著的那一次：開線在路上時網路回來排了重試，這次拿到壞資料，退避跑完也不再開', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      const { result } = renderHook(() => useConversation({ client: wire.client, threadId: 't' }));
      await tick();
      wire.fail('network error');
      await tick();
      wire.hold();
      await tick(250);
      const opened = wire.opened.mock.calls.length;
      act(() => {
        window.dispatchEvent(new Event('online'));
      });

      wire.release({ ...wire.goodPage, events: [BROKEN_FRAME] });
      await tick();
      expect(result.current.refusal).toBe(THREAD_PROTOCOL_ERROR_TEXT);
      await tick(RECONNECT_MAX_MS * 4);
      expect(wire.opened).toHaveBeenCalledTimes(opened);
    });

    it('上一次一般失敗的原因不留：重試時碰到壞資料，畫面只有那一句', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      const { result } = renderHook(() => useConversation({ client: wire.client, threadId: 't' }));
      await tick();
      wire.fail('network error');
      await tick();
      expect(result.current.connectionError).toBe('network error');

      wire.setPage({ ...wire.goodPage, events: [BROKEN_FRAME] });
      await tick(250);
      expect(result.current.refusal).toBe(THREAD_PROTOCOL_ERROR_TEXT);
      expect(result.current.connectionError).toBeUndefined();
    });

    it('按「立刻重連」那次還在路上時網路斷了：狀態列改講離線，不再是停住的那一種', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const wire = wiredClient();
      const { result } = renderHook(() => useConversation({ client: wire.client, threadId: 't' }));
      await tick();
      wire.send(BROKEN_FRAME);
      await tick();
      wire.hold();
      act(() => result.current.reconnectNow());
      await tick();

      online = false;
      act(() => {
        window.dispatchEvent(new Event('offline'));
      });
      expect(result.current.reconnecting).toEqual({ wasConnected: true, offline: true });

      online = true;
      wire.release(wire.goodPage);
      await tick();
      expect(result.current.connected).toBe(true);
    });
  },
);
