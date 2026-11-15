import type { Event, WireClient, WireFeedbackItem } from '@nexus/wire';
import { act, cleanup, configure, renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FEEDBACK_COPY } from '@/features/feedback/feedback';
import { useFeedback } from '@/features/feedback/use-feedback';
import { useConversation } from '@/shared/connection/use-conversation';

/**
 * 回饋 hook 接在連線核心上的行為：重連時補讀評分（#772）、收回評分失敗與送出之後的謝謝講在狀態列、`/feedback` 開對話框。
 * 評分控制器本身驗在 `features/feedback/ratings.test.ts`。
 */

/** 一條下行：測試推 frame、正常收掉、或讓它出錯。 */
interface Line {
  push(...events: Event[]): void;
  end(): void;
  fail(failure: string | Error): void;
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
      fail: (failure) => {
        error = typeof failure === 'string' ? new Error(failure) : failure;
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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // 亂數固定在 0：第 n 次重試等的就是上限的一半，250、500、1000…
  vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** 跟組裝層（`app/App.tsx`）同一種接法：核心的 `/feedback` 回呼用 ref 指向回饋 hook。 */
function renderFeedback(client: WireClient) {
  return renderHook(() => {
    const openDialog = useRef<() => void>(() => undefined);
    const conversation = useConversation({
      client,
      threadId: 't',
      onFeedbackCommand: () => openDialog.current(),
    });
    const feedback = useFeedback({
      client,
      threadId: 't',
      connections: conversation.connections,
      setStatusLine: conversation.setStatusLine,
    });
    openDialog.current = feedback.openSessionDialog;
    return { conversation, feedback };
  });
}

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
      const { result } = renderFeedback(client);
      await tick();
      act(() => result.current.feedback.seedRatings());
      await tick();
      expect(result.current.feedback.ratings.get('m1')?.rating).toBe('negative');

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
      expect(result.current.conversation.connected).toBe(false);
      await tick(250);
      expect(result.current.conversation.connected).toBe(true);
      expect(server.feedbackList).toHaveBeenCalledTimes(2);
      expect(result.current.feedback.ratings.get('m1')).toMatchObject({
        rating: 'positive',
        version: 'v2',
      });
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
      const { result } = renderFeedback(client);
      await tick();
      act(() => result.current.feedback.seedRatings());
      await tick();
      expect(result.current.feedback.ratingsUnsupported).toBe(true);
      expect(result.current.feedback.ratingsLoadFailed).toBe(false);
      // 不收評分的不再試：再滑過也不打。
      act(() => result.current.feedback.seedRatings());
      await tick();
      expect(feedbackList).toHaveBeenCalledTimes(1);

      // 伺服器重開、改成落盤開著。
      unsupported = false;
      latest().fail('network error');
      await tick();
      await tick(250);
      expect(result.current.conversation.connected).toBe(true);
      expect(feedbackList).toHaveBeenCalledTimes(2);
      expect(result.current.feedback.ratingsUnsupported).toBe(false);
      expect(result.current.feedback.ratings.get('m1')?.rating).toBe('positive');
    });

    it('沒讀過的不讀：冷的等人滑過再讀', async () => {
      const server = ratingsServer();
      const { client, latest } = scriptedClient({ feedbackList: server.feedbackList });
      const { result } = renderFeedback(client);
      await tick();
      latest().fail('network error');
      await tick();
      expect(result.current.conversation.connected).toBe(false);
      await tick(250);
      expect(result.current.conversation.connected).toBe(true);
      expect(server.feedbackList).not.toHaveBeenCalled();
    });

    it('重讀排在路上的修改後面：重接前送出的評分不會被舊清單蓋掉', async () => {
      const server = ratingsServer();
      const { client, latest } = scriptedClient({
        feedbackList: server.feedbackList,
        feedbackPut: server.feedbackPut,
      });
      const { result } = renderFeedback(client);
      await tick();
      // 還沒評過的按讚：先開對話框，送出之後才寫；寫的那一次卡在路上。
      await act(() => result.current.feedback.rate('m1', 'positive'));
      let submitted: Promise<void> | undefined;
      act(() => {
        submitted = result.current.feedback.submitFeedback({ text: '' });
      });
      await tick();
      expect(server.feedbackPut).toHaveBeenCalledTimes(1);

      // 重接那一刻要是直接讀，送出去的清單照下的是還沒寫進去的那份，而且比寫的那一次晚回來。
      server.holdLists();
      latest().fail('network error');
      await tick();
      expect(result.current.conversation.connected).toBe(false);
      await tick(250);
      expect(result.current.conversation.connected).toBe(true);
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
      expect(result.current.feedback.ratings.get('m1')).toMatchObject({
        rating: 'positive',
        version: 'v-put',
      });
    });
  },
);

describe('回饋對話框與狀態列', () => {
  it('只打 /feedback：核心清掉狀態列、不送出，對話框由回饋 hook 開；帶了文字的不是這一條', async () => {
    const feedbackRecord = vi.fn(async () => ({ kind: 'ok' }));
    const { client } = scriptedClient({ feedbackRecord });
    const { result } = renderFeedback(client);
    await tick();
    act(() => result.current.conversation.setStatusLine({ error: '舊的錯', notice: '舊的話' }));
    let sent: unknown = 'unset';
    await act(async () => {
      sent = await result.current.conversation.send(' /feedback ');
    });
    expect(sent).toBeUndefined();
    expect(result.current.conversation.slashError).toBeUndefined();
    expect(result.current.conversation.slashNotice).toBeUndefined();
    expect(result.current.feedback.feedbackDialog).toEqual({
      target: { kind: 'session' },
      submitting: false,
    });
    expect(feedbackRecord).not.toHaveBeenCalled();
  });

  it('送出成功：框關掉，狀態列說謝謝，原本的錯誤清掉', async () => {
    const feedbackRecord = vi.fn(async () => ({ kind: 'ok' }));
    const { client } = scriptedClient({ feedbackRecord });
    const { result } = renderFeedback(client);
    await tick();
    act(() => result.current.conversation.setStatusLine({ error: '舊的錯' }));
    await act(async () => {
      await result.current.conversation.send('/feedback');
    });
    await act(async () => {
      await result.current.feedback.submitFeedback({ text: ' 很慢 ' });
    });
    expect(feedbackRecord).toHaveBeenCalledWith('t', { text: '很慢' });
    expect(result.current.feedback.feedbackDialog).toBeUndefined();
    expect(result.current.conversation.slashNotice).toBe(FEEDBACK_COPY.recorded);
    expect(result.current.conversation.slashError).toBeUndefined();
  });

  it('再點已選的那顆收回，失敗的話講在狀態列的錯誤那一格', async () => {
    const stored: WireFeedbackItem = {
      messageId: 'm1',
      rating: 'positive',
      version: 'v1',
      createdAt: 0,
      updatedAt: 0,
    };
    const feedbackList = vi.fn(async () => ({
      kind: 'ok',
      result: { ok: true, value: { items: [stored] } },
    }));
    const feedbackDelete = vi.fn(async () => ({
      kind: 'rejected',
      code: 'version-conflict',
      message: '別處改過了',
    }));
    const { client } = scriptedClient({ feedbackList, feedbackDelete });
    const { result } = renderFeedback(client);
    await tick();
    act(() => result.current.conversation.setStatusLine({ notice: '舊的話' }));
    await act(async () => {
      await result.current.feedback.rate('m1', 'positive');
    });
    expect(feedbackDelete).toHaveBeenCalledTimes(1);
    expect(result.current.feedback.feedbackDialog).toBeUndefined();
    expect(result.current.conversation.slashNotice).toBeUndefined();
    expect(result.current.conversation.slashError).toBe(`${FEEDBACK_COPY.generic}：別處改過了`);
  });
});
