import type { Event, ThreadHistoryOutcome, ThreadHistoryQuery, WireClient } from '@nexus/wire';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JUMP_PAGE_MESSAGES, useConversation } from '@/hooks/use-conversation';

/**
 * 畫面上那段歷史碰上重連時怎麼辦（#1601）：重連時歷史被拒保留畫面（`N1345`）、「載入更早的」碰上換代整份丟掉（`N1372`）、
 * `loadThrough` 一頁一頁載到指定位置、一次接上（`N1356`）。退避與重接的主線在 `use-conversation-reconnect.test.tsx`。
 */

const ROOT = ['model_request:1'];
/** 一則模型回覆的開頭；`seq` 省略就是歷史裡的那種（歷史一顆都不帶號）。 */
function reply(runId: string, seq?: number): Event {
  return {
    type: 'event',
    ...(seq === undefined ? {} : { seq, event_id: `t:${seq}` }),
    method: 'messages',
    params: {
      namespace: ROOT,
      timestamp: 0,
      data: { event: 'message-start', role: 'ai', id: `m-${runId}`, run_id: runId },
    },
  } as Event;
}

function page(
  runIds: readonly string[],
  firstSeq: number,
  hasMore: boolean,
  throughSeq = 999,
): ThreadHistoryOutcome {
  return {
    kind: 'ok',
    result: { events: runIds.map((id) => reply(id)), firstSeq, throughSeq, hasMore, legacy: false },
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

/**
 * 下行一次一條、測試推 frame 或收線；歷史照 `answers` 的順序回（值或還沒放行的 `Deferred`），用完了就掛著不回。
 */
function scriptedClient(answers: (ThreadHistoryOutcome | Deferred<ThreadHistoryOutcome>)[]) {
  const lines: { push(...events: Event[]): void; end(): void }[] = [];
  const openEvents = vi.fn(async () => {
    const queue: Event[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    lines.push({
      push: (...events) => {
        queue.push(...events);
        wake?.();
      },
      end: () => {
        ended = true;
        wake?.();
      },
    });
    return (async function* stream() {
      for (;;) {
        while (queue.length > 0) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    })();
  });
  const threadHistory = vi.fn(async (_threadId: string, _query?: ThreadHistoryQuery) => {
    const next = answers.shift();
    if (next === undefined) return new Promise<never>(() => undefined);
    return 'promise' in next ? next.promise : next;
  });
  const client = {
    openEvents,
    threadHistory,
    slashList: async () => ({ kind: 'ok', commands: [] }),
  } as unknown as WireClient;
  return { client, openEvents, threadHistory, latest: () => lines[lines.length - 1]! };
}

async function tick(ms = 0) {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

/** 亂數固定在 0，第 1 次重試等 250ms（見 `use-conversation-reconnect.test.tsx`）。 */
const FIRST_RETRY_MS = 250;

/** 畫面上的回覆，依序。 */
function replies(result: { current: ReturnType<typeof useConversation> }): string[] {
  return result.current.state.entries.flatMap((entry) =>
    entry.kind === 'ai' && entry.messageId !== undefined ? [entry.messageId] : [],
  );
}

/** 往前翻帶的 `beforeSeq`，依序（第一頁那一次不帶查詢）。 */
function beforeSeqs(threadHistory: ReturnType<typeof scriptedClient>['threadHistory']) {
  return threadHistory.mock.calls.flatMap(([, query]) =>
    query?.beforeSeq === undefined ? [] : [query.beforeSeq],
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('重連時歷史被拒：保留畫面（#1601 `N1345`）', () => {
  /** 開線、折進一則即時回覆（號 50），收線；重連時歷史被拒。 */
  async function rejectedOnReconnect() {
    const rejected: ThreadHistoryOutcome = { kind: 'rejected', message: '這個組裝沒有落盤' };
    const harness = scriptedClient([page([], 0, false), rejected]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    harness.latest().push(reply('live', 50));
    await tick();
    expect(replies(result)).toEqual(['m-live']);
    harness.latest().end();
    await tick(FIRST_RETRY_MS);
    expect(harness.openEvents).toHaveBeenCalledTimes(2);
    expect(result.current.connected).toBe(true);
    return { ...harness, result };
  }

  it('剛才看得到的回覆還在，歷史錯誤那一句也在', async () => {
    const { result } = await rejectedOnReconnect();
    expect(replies(result)).toEqual(['m-live']);
    expect(result.current.historyError?.message).toBe('這個組裝沒有落盤');
    expect(result.current.history).toBeUndefined();
  });

  it('去重水位歸零：serve 重開後號從 0 起算的即時回覆照樣折進來', async () => {
    const { result, latest } = await rejectedOnReconnect();
    latest().push(reply('after-restart', 0));
    await tick();
    expect(replies(result)).toEqual(['m-live', 'm-after-restart']);
  });

  it('第一次開線歷史就被拒：照舊從空的開始', async () => {
    const harness = scriptedClient([{ kind: 'rejected', message: '這個組裝沒有落盤' }]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    expect(result.current.state.entries).toEqual([]);
    expect(result.current.historyError?.message).toBe('這個組裝沒有落盤');
  });
});

describe('「載入更早的」碰上重連：整份丟掉（#1601 `N1372`）', () => {
  it('請求還在路上時重連換上最新一頁：晚回來的舊頁不接上，游標是新的那一頁', async () => {
    const stale = deferred<ThreadHistoryOutcome>();
    const harness = scriptedClient([
      page(['first'], 100, true),
      stale,
      page(['fresh'], 200, true),
      page(['next'], 150, false),
    ]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    act(() => {
      void result.current.loadEarlier();
    });
    await tick();
    expect(result.current.history?.loading).toBe(true);
    harness.latest().end();
    await tick(FIRST_RETRY_MS);
    expect(replies(result)).toEqual(['m-fresh']);
    stale.resolve(page(['old'], 50, true));
    await tick();
    expect(replies(result)).toEqual(['m-fresh']);
    expect(result.current.history?.loading).toBe(false);
    // 游標沒被改回舊值：下一次往前翻從新的那一頁往前。
    await act(() => result.current.loadEarlier());
    expect(beforeSeqs(harness.threadHistory)).toEqual([100, 200]);
    expect(replies(result)).toEqual(['m-next', 'm-fresh']);
  });

  it('斷線之後、新的一頁到之前按下去（帶的是舊游標）：新的一頁換上之後回來，同樣丟掉', async () => {
    const reconnectPage = deferred<ThreadHistoryOutcome>();
    const stale = deferred<ThreadHistoryOutcome>();
    const harness = scriptedClient([page(['first'], 100, true), reconnectPage, stale]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    harness.latest().end();
    await tick(FIRST_RETRY_MS);
    // 重連已經開線、正在等歷史：畫面上還是舊的那一頁，「載入更早的」按得動。
    expect(harness.openEvents).toHaveBeenCalledTimes(2);
    act(() => {
      void result.current.loadEarlier();
    });
    await tick();
    expect(beforeSeqs(harness.threadHistory)).toEqual([100]);
    reconnectPage.resolve(page(['fresh'], 200, true));
    await tick();
    stale.resolve(page(['old'], 50, true));
    await tick();
    expect(replies(result)).toEqual(['m-fresh']);
  });
  it.each([
    [
      '被拒',
      (stale: Deferred<ThreadHistoryOutcome>) =>
        stale.resolve({ kind: 'rejected', message: '舊的那一次' }),
    ],
    [
      '拋錯',
      (stale: Deferred<ThreadHistoryOutcome>) =>
        stale.resolve(Promise.reject(new Error('舊的那一次')) as unknown as ThreadHistoryOutcome),
    ],
  ])('晚回來的舊請求%s：不把錯誤與舊游標寫回新的那一頁', async (_case, settle) => {
    const stale = deferred<ThreadHistoryOutcome>();
    const harness = scriptedClient([page(['first'], 100, true), stale, page(['fresh'], 200, true)]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    act(() => {
      void result.current.loadEarlier();
    });
    await tick();
    harness.latest().end();
    await tick(FIRST_RETRY_MS);
    settle(stale);
    await tick();
    expect(result.current.history).toEqual({ hasMore: true, legacy: false, loading: false });
    act(() => {
      void result.current.loadEarlier();
    });
    expect(beforeSeqs(harness.threadHistory)).toEqual([100, 200]);
  });
});

describe('loadThrough：往前載到指定位置為止（#1601 `N1356`）', () => {
  it('三頁、目標在第三頁：每頁 200 則一頁一頁往前，畫面只在最後變一次', async () => {
    const pages = [
      deferred<ThreadHistoryOutcome>(),
      deferred<ThreadHistoryOutcome>(),
      deferred<ThreadHistoryOutcome>(),
    ];
    const harness = scriptedClient([page(['tail'], 300, true, 350), ...pages]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    let done = false;
    act(() => {
      void result.current.loadThrough(50).then(() => (done = true));
    });
    await tick();
    expect(result.current.history?.loading).toBe(true);
    pages[0]!.resolve(page(['p1'], 200, true));
    await tick();
    pages[1]!.resolve(page(['p2'], 100, true));
    await tick();
    // 前兩頁私下留著：畫面還是原樣。
    expect(replies(result)).toEqual(['m-tail']);
    pages[2]!.resolve(page(['p3'], 40, true));
    await tick();
    expect(done).toBe(true);
    expect(replies(result)).toEqual(['m-p3', 'm-p2', 'm-p1', 'm-tail']);
    expect(result.current.history).toMatchObject({ loading: false, hasMore: true, loaded: 3 });
    const queries = harness.threadHistory.mock.calls.slice(1).map(([, query]) => query);
    expect(queries).toEqual([
      { beforeSeq: 300, throughSeq: 350, maxMessages: JUMP_PAGE_MESSAGES },
      { beforeSeq: 200, throughSeq: 350, maxMessages: JUMP_PAGE_MESSAGES },
      { beforeSeq: 100, throughSeq: 350, maxMessages: JUMP_PAGE_MESSAGES },
    ]);
    expect(JUMP_PAGE_MESSAGES).toBe(200);
  });

  it('某一頁沒有進展（`firstSeq` 沒變小、卻說還有更早的）：只叫一次就停', async () => {
    // harness 的切點不會落在游標之後：沒有進展的那一頁裡沒有訊息。
    const harness = scriptedClient([page(['tail'], 300, true), page([], 300, true)]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    await act(() => result.current.loadThrough(10));
    expect(harness.threadHistory).toHaveBeenCalledTimes(2);
    expect(replies(result)).toEqual(['m-tail']);
    expect(result.current.history?.loading).toBe(false);
  });

  it('跑著的時候再叫：目標壓到最低、回同一個 promise，不另開一條', async () => {
    const first = deferred<ThreadHistoryOutcome>();
    const harness = scriptedClient([
      page(['tail'], 300, true),
      first,
      page(['p2'], 100, true),
      page(['p3'], 40, false),
    ]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => {
      a = result.current.loadThrough(250);
      b = result.current.loadThrough(50);
    });
    expect(b).toBe(a);
    first.resolve(page(['p1'], 200, true));
    await act(() => a);
    expect(beforeSeqs(harness.threadHistory)).toEqual([300, 200, 100]);
    expect(replies(result)).toEqual(['m-p3', 'm-p2', 'm-p1', 'm-tail']);
    expect(result.current.history?.hasMore).toBe(false);
  });

  it('中途被拒：已經拿到的頁照樣接上，原因寫在往前翻那一格', async () => {
    const harness = scriptedClient([
      page(['tail'], 300, true),
      page(['p1'], 200, true),
      { kind: 'rejected', message: '讀檔失敗' },
    ]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    await act(() => result.current.loadThrough(50));
    expect(replies(result)).toEqual(['m-p1', 'm-tail']);
    expect(result.current.history).toMatchObject({ loading: false, error: '讀檔失敗' });
  });

  it('跑到一半重連換上新的一頁：整份丟掉、不再往前叫', async () => {
    const first = deferred<ThreadHistoryOutcome>();
    const harness = scriptedClient([page(['tail'], 300, true), first, page(['fresh'], 400, true)]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    act(() => {
      void result.current.loadThrough(50);
    });
    await tick();
    harness.latest().end();
    await tick(FIRST_RETRY_MS);
    first.resolve(page(['p1'], 200, true));
    await tick();
    expect(replies(result)).toEqual(['m-fresh']);
    expect(harness.threadHistory).toHaveBeenCalledTimes(3);
    expect(result.current.history?.loading).toBe(false);
  });

  it('「載入更早的」正在跑：直接回，不排在它後面', async () => {
    const earlier = deferred<ThreadHistoryOutcome>();
    const harness = scriptedClient([page(['tail'], 300, true), earlier]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    act(() => {
      void result.current.loadEarlier();
    });
    await tick();
    await act(() => result.current.loadThrough(50));
    expect(harness.threadHistory).toHaveBeenCalledTimes(2);
    earlier.resolve(page(['p1'], 200, true));
    await tick();
    expect(replies(result)).toEqual(['m-p1', 'm-tail']);
  });

  it('目標已經載入：什麼都不叫', async () => {
    const harness = scriptedClient([page(['tail'], 300, true)]);
    const { result } = renderHook(() => useConversation({ client: harness.client, threadId: 't' }));
    await tick();
    await act(() => result.current.loadThrough(300));
    expect(harness.threadHistory).toHaveBeenCalledTimes(1);
  });
});
