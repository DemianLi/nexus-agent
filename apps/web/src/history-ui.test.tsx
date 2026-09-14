import type { Event, ThreadHistoryQuery, ThreadHistoryResult, WireClient } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App, LEGACY_THREAD_NOTICE, LOAD_EARLIER_LABEL } from '@/App';

/**
 * 切回以前的 thread，畫面照日誌重播（[#306](https://github.com/DemianLi/nexus-agent/issues/306) 的畫面那一刀）。
 *
 * **日誌轉 frame 對不對不在這裡驗**——那在 `@nexus/harness`（`conversation-history.test.ts` 與產品路徑的
 * `serve-history.test.ts`）。這裡只驗畫面這一層：歷史畫出來了、之後的即時回覆接得上、送出等歷史、兩句披露、往前翻。
 */

/** 同 `App.test.tsx` 那一份：Node 25 的全域 `localStorage` 蓋住 jsdom 的。 */
function memoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, String(value)),
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 歷史的 frame：**不帶 seq**，同 server 那側。 */
function historyFrame(method: string, data: unknown): Event {
  return { type: 'event', method, params: { namespace: [], timestamp: 0, data } } as Event;
}

function said(role: 'human' | 'ai', id: string, text: string): Event[] {
  return [
    historyFrame('messages', { event: 'message-start', role, id }),
    historyFrame('messages', {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      id,
    }),
    historyFrame('messages', { event: 'message-finish', reason: 'stop', id }),
  ];
}

function turn(id: number, human: string, ai: string): Event[] {
  return [
    historyFrame('lifecycle', { event: 'running', graph_name: 'root' }),
    ...said('human', `history-${id}`, human),
    historyFrame('tools', {
      event: 'tool-started',
      tool_call_id: `call-${id}`,
      tool_name: 'echo',
      input: '{"message":"藍鯨"}',
    }),
    historyFrame('tools', { event: 'tool-finished', tool_call_id: `call-${id}`, failed: false }),
    ...said('ai', `history-${id + 1}`, ai),
    historyFrame('lifecycle', { event: 'completed', graph_name: 'root' }),
  ];
}

function page(
  events: readonly Event[],
  rest: Partial<ThreadHistoryResult> = {},
): ThreadHistoryResult {
  return { events, firstSeq: 0, throughSeq: 20, hasMore: false, legacy: false, ...rest };
}

/** 即時的一則回覆：傳輸 seq 從 0 起，同行程重開之後的第一輪。 */
const LIVE_REPLY: readonly Event[] = [
  {
    type: 'event',
    seq: 0,
    method: 'lifecycle',
    params: { namespace: [], timestamp: 0, data: { event: 'running', graph_name: 'root' } },
  },
  {
    type: 'event',
    seq: 1,
    method: 'messages',
    params: {
      namespace: [],
      timestamp: 0,
      data: { event: 'message-start', role: 'ai', id: 'run-a', run_id: 'a' },
    },
  },
  {
    type: 'event',
    seq: 2,
    method: 'messages',
    params: {
      namespace: [],
      timestamp: 0,
      data: {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '即時的回覆' },
        run_id: 'a',
      },
    },
  },
  {
    type: 'event',
    seq: 3,
    method: 'messages',
    params: {
      namespace: [],
      timestamp: 0,
      data: { event: 'message-finish', reason: 'stop', run_id: 'a' },
    },
  },
  {
    type: 'event',
    seq: 4,
    method: 'lifecycle',
    params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
  },
] as Event[];

function fakeClient(
  history: WireClient['threadHistory'],
  live: readonly Event[] = [],
): { readonly client: WireClient; readonly sent: string[] } {
  const sent: string[] = [];
  const rejected = async () => ({ kind: 'rejected' as const, message: '這一檔沒有接' });
  const client: WireClient = {
    openEvents: async () =>
      (async function* stream() {
        for (const event of live) yield event;
        await new Promise(() => undefined);
      })(),
    runStart: async (_threadId, text) => {
      sent.push(text);
      return { type: 'success', id: 1, result: {} };
    },
    inputRespond: async () => ({ type: 'success', id: 2, result: {} }),
    runCancel: async () => ({ type: 'success', id: 3, result: { accepted: true } }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
    slashRun: async () => ({ kind: 'unknown' }),
    feedbackPut: rejected,
    feedbackDelete: rejected,
    feedbackRecord: rejected,
    listThreads: rejected,
    threadHistory: history,
  };
  return { client, sent };
}

/** 畫面上對話那一段的字，照順序。 */
function transcript(): string[] {
  return screen
    .getAllByRole('listitem')
    .map((item) => item.textContent ?? '')
    .filter((text) => text !== '');
}

describe('畫面照日誌重播', () => {
  it('人話、工具卡、回覆依序畫出來；之後傳輸 seq 從 0 起的即時回覆接在下面', async () => {
    const { client } = fakeClient(
      async () => ({ kind: 'ok', result: page(turn(0, '記住暗號是藍鯨', '記住了。')) }),
      LIVE_REPLY,
    );
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('即時的回覆')).toBeTruthy());
    const lines = transcript();
    expect(lines[0]).toBe('記住暗號是藍鯨');
    expect(lines[1]).toContain('echo');
    expect(lines[1]).toContain('完成');
    expect(lines[2]).toBe('記住了。');
    expect(lines.at(-1)).toContain('即時的回覆');
  });

  it('歷史回來之前送不出去；回來之後照常送，話接在歷史下面', async () => {
    let resolve: (result: ThreadHistoryResult) => void = () => undefined;
    const { client, sent } = fakeClient(
      () =>
        new Promise((settle) => {
          resolve = (result) => settle({ kind: 'ok', result });
        }),
    );
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByPlaceholderText('連線中…')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '太早的一句' } });
    expect((screen.getByRole('button', { name: '送出' }) as HTMLButtonElement).disabled).toBe(true);

    resolve(page(turn(0, '之前那句', '之前的回覆')));
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '送出' }));

    await waitFor(() => expect(sent).toEqual(['太早的一句']));
    expect(transcript().at(-1)).toBe('太早的一句');
    expect(transcript()[0]).toBe('之前那句');
  });

  it('舊格式：講明模型的回覆沒有保存', async () => {
    const { client } = fakeClient(async () => ({
      kind: 'ok',
      result: page(turn(0, '舊的一句', ''), { legacy: true }),
    }));
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText(LEGACY_THREAD_NOTICE)).toBeTruthy());
  });

  it('對照：格式 9 的不講', async () => {
    const { client } = fakeClient(async () => ({
      kind: 'ok',
      result: page(turn(0, '一句', '回覆')),
    }));
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText('回覆')).toBeTruthy());
    expect(screen.queryByText(LEGACY_THREAD_NOTICE)).toBeNull();
  });

  it('歷史拿不回來：講原因，對話照樣接得下去', async () => {
    const { client } = fakeClient(async () => ({
      kind: 'rejected',
      message: '這條 thread 建不起來：日誌壞了',
    }));
    render(<App client={client} />);

    await waitFor(() => expect(screen.getByText(/之前說過的話拿不回來/)).toBeTruthy());
    expect(screen.getByText(/日誌壞了/)).toBeTruthy();
    await waitFor(() => expect(screen.getByPlaceholderText('說點什麼…')).toBeTruthy());
  });

  it('往前翻：帶上一頁的位置與第一頁的上界，更早的接在最上面，翻到底按鈕就收掉', async () => {
    const queries: (ThreadHistoryQuery | undefined)[] = [];
    const { client } = fakeClient(async (_threadId, query) => {
      queries.push(query);
      return query?.beforeSeq === undefined
        ? {
            kind: 'ok',
            result: page(turn(10, '後來那句', '後來的回覆'), { firstSeq: 10, hasMore: true }),
          }
        : {
            kind: 'ok',
            result: page(turn(0, '最早那句', '最早的回覆'), { firstSeq: 0, hasMore: false }),
          };
    });
    render(<App client={client} />);
    await waitFor(() => expect(screen.getByText('後來的回覆')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: LOAD_EARLIER_LABEL }));

    await waitFor(() => expect(screen.getByText('最早的回覆')).toBeTruthy());
    expect(queries[1]).toEqual({ beforeSeq: 10, throughSeq: 20 });
    expect(transcript()[0]).toBe('最早那句');
    expect(screen.queryByRole('button', { name: LOAD_EARLIER_LABEL })).toBeNull();
  });
});
