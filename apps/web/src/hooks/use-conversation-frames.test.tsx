import type { Event, WireClient } from '@nexus/wire';
import { act, cleanup, configure, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useConversation } from '@/hooks/use-conversation';

/**
 * 串流片段按幀交給 React（#527 Q8）。排程本身驗在 `frame-publisher.test.ts`；這裡驗 hook 真的把每顆事件的
 * 分類交給它——少了這一步，所有片段照舊逐顆發布，排程器的測試照樣全綠。
 */

afterEach(cleanup);

const ROOT = ['model_request:1'];
let seq = 0;
function frame(method: string, namespace: readonly string[], data: unknown): Event {
  const current = seq++;
  return {
    type: 'event',
    seq: current,
    event_id: `t:${current}`,
    method,
    params: { namespace, timestamp: 0, data },
  } as Event;
}

/** 下行由測試一顆一顆推。 */
function pushedClient() {
  const queue: Event[] = [];
  let wake: (() => void) | undefined;
  const client = {
    openEvents: async () =>
      (async function* stream() {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          await new Promise<void>((resolve) => (wake = resolve));
        }
      })(),
    threadHistory: async () => ({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false },
    }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
  } as unknown as WireClient;
  const push = async (...events: Event[]) => {
    await act(async () => {
      queue.push(...events);
      wake?.();
      // 讓下行的迴圈把它們折完；不推進計時器，所以動畫幀不會在這裡跑。
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  };
  return { client, push };
}

function aiText(state: ReturnType<typeof useConversation>['state']) {
  const entry = state.entries.find((candidate) => candidate.kind === 'ai');
  return entry?.kind === 'ai' ? entry : undefined;
}

// `main.tsx` 開著 StrictMode：dev 模式先掛上、卸載、再掛上，卸載時的 `cancel` 不能讓排程器從此不發布。
// **要用 `reactStrictMode` 選項**：把 `<StrictMode>` 當 wrapper 包，React 19.2 在這裡不會重跑 effect（實測）。
describe.each([false, true])('useConversation 按幀交出串流片段（StrictMode：%s）', (strict) => {
  beforeEach(() => configure({ reactStrictMode: strict }));
  afterEach(() => configure({ reactStrictMode: false }));

  it('逐字片段不當場交給 React，幾幀之後一次交；收尾當場交', async () => {
    const { client, push } = pushedClient();
    const { result } = renderHook(() => useConversation({ client, threadId: 't' }));
    await waitFor(() => expect(result.current.connected).toBe(true));

    await push(
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      frame('messages', ROOT, { event: 'message-start', id: 'run-a', run_id: 'a' }),
    );
    // 結構事件當場交：那一則已經在。
    expect(aiText(result.current.state)).toMatchObject({ text: '', streaming: true });

    await push(
      frame('messages', ROOT, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'reasoning-delta', reasoning: '想' },
        run_id: 'a',
      }),
      frame('messages', ROOT, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '答' },
        run_id: 'a',
      }),
    );
    // 片段還沒交出去。
    expect(aiText(result.current.state)?.text).toBe('');
    // 幾幀之後一次交。
    await waitFor(() => expect(aiText(result.current.state)?.text).toBe('答'));
    expect(aiText(result.current.state)?.reasoning).toBe('想');

    await push(
      frame('messages', ROOT, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '案' },
        run_id: 'a',
      }),
      frame('messages', ROOT, { event: 'message-finish', reason: 'stop', run_id: 'a' }),
    );
    // 收尾當場交，把還在排的片段一起帶出來。
    expect(aiText(result.current.state)).toMatchObject({ text: '答案', streaming: false });
  });
});
