import type {
  Event,
  FeedbackDeleteCommand,
  FeedbackDeleteResult,
  FeedbackPutCommand,
  FeedbackPutResult,
  FeedbackRecordCommand,
  WireClient,
  WireFeedbackItem,
} from '@nexus/wire';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { FEEDBACK_COPY } from '@/lib/feedback';

/**
 * 評分與 `/feedback` 的畫面（[#278](https://github.com/DemianLi/nexus-agent/issues/278)）。
 *
 * **按鈕放哪一則的判法驗在 `lib/feedback.test.ts`**，對著真的折疊器；host 那側的規則與 run id 對到
 * 輪，驗在 `@nexus/harness` 的 `feedback-wire.test.ts`。這裡驗的是點下去之後送出了什麼、畫面變成什麼，
 * 所以 client 是假的、frame 是手餵的。
 */

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
});

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

function reply(id: string, text: string): Event[] {
  const namespace = ['model_request:1'];
  return [
    frame('messages', namespace, { event: 'message-start', id: `run-${id}`, run_id: id }),
    frame('messages', namespace, {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      run_id: id,
    }),
    frame('messages', namespace, { event: 'message-finish', reason: 'stop', run_id: id }),
  ];
}

/** 一輪兩則回覆：`a` 講到一半、`b` 收尾。 */
const ONE_RUN: readonly Event[] = [
  frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
  ...reply('a', '先說一句。'),
  ...reply('b', '收工了。'),
  frame('lifecycle', [], { event: 'completed', graph_name: 'root' }),
];

function item(overrides: Partial<WireFeedbackItem> = {}): WireFeedbackItem {
  return { turn: 0, rating: 'negative', version: 'v1', createdAt: 0, updatedAt: 0, ...overrides };
}

function fakeClient(
  options: {
    readonly put?: (params: FeedbackPutCommand['params']) => FeedbackPutResult;
    readonly del?: (params: FeedbackDeleteCommand['params']) => FeedbackDeleteResult;
  } = {},
) {
  const puts: FeedbackPutCommand['params'][] = [];
  const deletes: FeedbackDeleteCommand['params'][] = [];
  const records: FeedbackRecordCommand['params'][] = [];
  const slashed: string[] = [];
  const client: WireClient = {
    openEvents: async () =>
      (async function* stream() {
        for (const event of ONE_RUN) yield event;
        await new Promise(() => undefined);
      })(),
    runStart: async () => ({ type: 'success', id: 1, result: {} }),
    inputRespond: async () => ({ type: 'success', id: 2, result: {} }),
    runCancel: async () => ({ type: 'success', id: 3, result: { accepted: true } }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
    slashRun: async (_threadId, line) => {
      slashed.push(line);
      return { kind: 'unknown' };
    },
    feedbackPut: async (_threadId, params) => {
      puts.push(params);
      return {
        kind: 'ok',
        result: options.put?.(params) ?? {
          ok: true,
          value: item({
            rating: params.rating,
            ...(params.note === undefined ? {} : { note: params.note }),
            ...(params.category === undefined ? {} : { category: params.category }),
          }),
        },
      };
    },
    feedbackDelete: async (_threadId, params) => {
      deletes.push(params);
      return { kind: 'ok', result: options.del?.(params) ?? { ok: true, value: { absent: true } } };
    },
    feedbackRecord: async (_threadId, params) => {
      records.push(params);
      return { kind: 'ok', result: { ok: true, value: { recorded: true } } };
    },
  };
  return { client, puts, deletes, records, slashed };
}

/** 那則回覆所在的條目。 */
function entryOf(text: string): HTMLElement {
  const node = screen.getByText(text).closest('li');
  if (node === null) throw new Error(`找不到「${text}」那一則`);
  return node;
}

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByText('收工了。')).toBeTruthy());
}

describe('評分按鈕', () => {
  it('一輪兩則：只有收尾那則長按鈕', async () => {
    seq = 0;
    render(<App client={fakeClient().client} />);
    await ready();
    expect(screen.getAllByTestId('rating-buttons')).toHaveLength(1);
    expect(
      within(entryOf('收工了。')).getByRole('button', { name: FEEDBACK_COPY.dislike }),
    ).toBeTruthy();
    expect(within(entryOf('先說一句。')).queryByTestId('rating-buttons')).toBeNull();
  });

  it('點踩：先開對話框，選分類、寫備註、送出才記；再點一次是收回', async () => {
    seq = 0;
    const fake = fakeClient();
    render(<App client={fake.client} />);
    await ready();

    fireEvent.click(
      within(entryOf('收工了。')).getByRole('button', { name: FEEDBACK_COPY.dislike }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(fake.puts).toEqual([]);
    // 提示只留前半句：這裡不送日誌，不說會送（#267 的 Q11）。
    const detail = within(dialog).getByLabelText(FEEDBACK_COPY.detail);
    expect(detail.getAttribute('placeholder')).toBe('填寫詳情以幫助我們改善體驗');
    expect(dialog.textContent).not.toContain('日誌');

    fireEvent.click(within(dialog).getByRole('button', { name: '任務結果' }));
    fireEvent.change(detail, { target: { value: '  很慢  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: FEEDBACK_COPY.submit }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.puts).toEqual([
      { runId: 'b', rating: 'negative', note: '很慢', category: 'task-result', ifVersion: null },
    ]);
    expect(screen.getByRole('status').textContent).toBe(FEEDBACK_COPY.recorded);
    const pressed = within(entryOf('收工了。')).getByRole('button', {
      name: FEEDBACK_COPY.dislikeActive,
    });
    expect(pressed.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(pressed);
    await waitFor(() => expect(fake.deletes).toEqual([{ runId: 'b', ifVersion: 'v1' }]));
    await waitFor(() =>
      expect(
        within(entryOf('收工了。'))
          .getByRole('button', { name: FEEDBACK_COPY.dislike })
          .getAttribute('aria-pressed'),
      ).toBe('false'),
    );
    // 收回不開對話框。
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('別的分頁先改了：框留著、講衝突那一句，按鈕畫上目前那筆', async () => {
    seq = 0;
    const fake = fakeClient({
      put: () => ({
        ok: false,
        error: { code: 'version-conflict', current: item({ rating: 'positive' }) },
      }),
    });
    render(<App client={fake.client} />);
    await ready();

    fireEvent.click(
      within(entryOf('收工了。')).getByRole('button', { name: FEEDBACK_COPY.dislike }),
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: FEEDBACK_COPY.submit }));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert').textContent).toBe(FEEDBACK_COPY.conflict),
    );
    expect(
      within(entryOf('收工了。'))
        .getByRole('button', { name: FEEDBACK_COPY.likeActive })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('/feedback', () => {
  it('只打 /feedback 開同一個框、不走 slash.run；空著送也記一則', async () => {
    seq = 0;
    const fake = fakeClient();
    render(<App client={fake.client} />);
    await ready();

    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/feedback' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    const dialog = await screen.findByRole('dialog');
    expect(fake.slashed).toEqual([]);

    fireEvent.click(within(dialog).getByRole('button', { name: FEEDBACK_COPY.submit }));
    await waitFor(() => expect(fake.records).toEqual([{}]));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(fake.puts).toEqual([]);
  });

  it('帶文字的 /feedback 照舊走 slash.run', async () => {
    seq = 0;
    const fake = fakeClient();
    render(<App client={fake.client} />);
    await ready();

    fireEvent.change(screen.getByLabelText('要說的話'), { target: { value: '/feedback 很慢' } });
    fireEvent.click(screen.getByRole('button', { name: '送出' }));
    await waitFor(() => expect(fake.slashed).toEqual(['/feedback 很慢']));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
