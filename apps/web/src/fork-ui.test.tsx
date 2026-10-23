import type {
  CommandOutcome,
  Event,
  ThreadForkResult,
  ThreadListResult,
  ThreadRenameResult,
  WireClient,
} from '@nexus/wire';
import { THREAD_AT_CAPACITY, TITLE } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/App';
import { REMEMBERED_THREAD_KEY } from '@/lib/remembered-thread';
import { THREAD_AT_CAPACITY_TEXT } from '@/lib/thread-capacity';
import {
  FORK_FAILED_TEXT,
  FORK_LABEL,
  FORK_RENAME_FAILED_TEXT,
  FORK_UNAVAILABLE_TEXT,
  FORKED_THREAD_NOTICE,
} from '@/lib/thread-fork';
import { UNWIRED_WIRE_CONTRACT } from '@/test/wire-contract';

/**
 * 回覆下面的分支鈕（[#1581](https://github.com/DemianLi/nexus-agent/issues/1581) 刀 2）。
 *
 * **server 怎麼分、切點換算對不對驗在 `@nexus/harness`**（#1580）；「失敗收尾」那一格怎麼標驗在 `@nexus/wire` 的
 * `turn-tail.test.ts`；佔位與晚到的清單驗在 `lib/thread-status.test.ts`。這裡驗點下去之後送了什麼、照什麼順序、畫面變成什麼，
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
  localStorage.setItem(REMEMBERED_THREAD_KEY, JSON.stringify({ threadId: '來源' }));
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

function turn(id: string, text: string, end: 'completed' | 'failed' = 'completed'): Event[] {
  const namespace = ['model_request:1'];
  return [
    frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    frame('messages', namespace, { event: 'message-start', id: `run-${id}`, run_id: id }),
    frame('messages', namespace, {
      event: 'content-block-delta',
      index: 0,
      delta: { type: 'text-delta', text },
      run_id: id,
    }),
    frame('messages', namespace, { event: 'message-finish', reason: 'stop', run_id: id }),
    end === 'completed'
      ? frame('lifecycle', [], { event: 'completed', graph_name: 'root' })
      : frame('lifecycle', [], { event: 'failed', graph_name: 'root', error: '模型斷線（#1581）' }),
  ];
}

/** 三輪的來源，標題「計劃（1）」；`failedSecond` 讓第二輪失敗收尾。frame 當場建，seq 才會照順序。 */
function source(options: { readonly failedSecond?: boolean; readonly title?: string } = {}) {
  seq = 0;
  return [
    ...(options.title === undefined
      ? []
      : [frame('custom', [], { name: TITLE, payload: { title: options.title } })]),
    ...turn('t1', '第一輪收尾。'),
    ...turn('t2', '第二輪收尾。', options.failedSecond === true ? 'failed' : 'completed'),
    ...turn('t3', '第三輪收尾。'),
  ];
}

const ok = <V,>(value: V) => ({ kind: 'ok' as const, result: { ok: true as const, value } });

function fakeClient(
  options: {
    readonly events?: readonly Event[];
    readonly fork?: () => Promise<CommandOutcome<ThreadForkResult>>;
    readonly rename?: (title: string) => Promise<CommandOutcome<ThreadRenameResult>>;
  } = {},
) {
  const calls: string[] = [];
  const events = options.events ?? source({ title: '計劃（1）' });
  const listed: ThreadListResult = {
    unreadable: 0,
    items: [
      { threadId: '來源', updatedAt: 1_000, running: false, blank: false, title: '計劃（1）' },
      { threadId: '別條', updatedAt: 500, running: false, blank: false, title: '別條對話' },
    ],
  };
  const client: WireClient = {
    ...UNWIRED_WIRE_CONTRACT,
    fileReferences: async () => ({ kind: 'rejected', message: '這一檔沒有接列檔' }),
    sessionReferences: async () => ({ kind: 'rejected', message: '這一檔沒有接列會話' }),
    openThreadFeed: () => new Promise<never>(() => undefined),
    searchThreads: () => new Promise<never>(() => undefined),
    openEvents: async (threadId) => {
      calls.push(`open ${threadId}`);
      return (async function* stream() {
        if (threadId === '來源') for (const event of events) yield event;
        await new Promise(() => undefined);
      })();
    },
    runStart: async () => ({ type: 'success', id: 1, result: {} }),
    inputRespond: async () => ({ type: 'success', id: 2, result: {} }),
    runCancel: async () => ({ type: 'success', id: 3, result: { accepted: true } }),
    queueUpdate: async () => ({ type: 'success', id: 4, result: { accepted: true } }),
    subagentSend: async () => ({ type: 'success', id: 5, result: { accepted: true } }),
    subagentInterrupt: async () => ({ type: 'success', id: 6, result: { accepted: true } }),
    subagentHistory: async () => ({ kind: 'rejected', message: '這一檔沒有接背景子代理' }),
    trajectoryTurn: async () => ({ kind: 'rejected', code: 'not_supported', message: '沒有接' }),
    slashList: async () => ({ kind: 'ok', commands: [] }),
    slashRun: async () => ({ kind: 'unknown' }),
    feedbackPut: async () => ({ kind: 'rejected', code: 'not_supported', message: '沒有接' }),
    feedbackDelete: async () => ({ kind: 'rejected', code: 'not_supported', message: '沒有接' }),
    feedbackList: async () => ({ kind: 'rejected', code: 'not_supported', message: '沒有接' }),
    feedbackRecord: async () => ({ kind: 'rejected', code: 'not_supported', message: '沒有接' }),
    listThreads: async () => {
      calls.push('list');
      return { kind: 'ok', result: listed };
    },
    threadHistory: async () => ({
      kind: 'ok',
      result: { events: [], firstSeq: 0, throughSeq: -1, hasMore: false, legacy: false },
    }),
    threadFork: async (threadId, messageId) => {
      calls.push(`fork ${threadId} ${messageId}`);
      return options.fork === undefined ? ok({ threadId: '子' }) : options.fork();
    },
    threadRename: async (threadId, title) => {
      calls.push(`rename ${threadId} ${title}`);
      return options.rename === undefined ? ok({ title, seq: 9 }) : options.rename(title);
    },
  } as WireClient;
  return { client, calls };
}

/** 一個可以從外面兌現的 promise。 */
function deferred<V>() {
  let resolve!: (value: V) => void;
  const promise = new Promise<V>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function entryOf(text: string): HTMLElement {
  const node = screen.getByText(text).closest<HTMLElement>('[data-slot="message-scroller-item"]');
  if (node === null) throw new Error(`找不到「${text}」那一則`);
  return node;
}

const forkButtonOf = (text: string) => within(entryOf(text)).getByTestId('fork-button');

async function ready(): Promise<void> {
  await waitFor(() => expect(screen.getByText('第三輪收尾。')).toBeTruthy());
}

/** 說明是 `description` 的那張 toast（sonner 的 toast 跨測試留著，所以各條用自己的說明）。 */
async function toastWith(description: string): Promise<Element> {
  return waitFor(() => {
    const card = screen
      .getAllByText(description)
      .map((element) => element.closest('[data-sonner-toast]'))
      .find((found) => found !== null);
    if (card === undefined || card === null)
      throw new Error(`沒有說明是「${description}」的 toast`);
    return card;
  });
}

function remembered(): string | undefined {
  const raw = localStorage.getItem(REMEMBERED_THREAD_KEY);
  return raw === null ? undefined : (JSON.parse(raw) as { threadId: string }).threadId;
}

describe('分支鈕放哪、能不能按', () => {
  it('每一輪收尾那則一顆，名字是「在新對話中分支」；收了的輪都按得了', async () => {
    render(<App client={fakeClient().client} />);
    await ready();
    expect(screen.getAllByTestId('fork-button')).toHaveLength(3);
    const button = forkButtonOf('第二輪收尾。');
    expect(button.getAttribute('aria-label')).toBe(FORK_LABEL);
    expect(button.getAttribute('title')).toBe(FORK_LABEL);
    expect(button.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('失敗收尾的那一輪：按不了，tooltip 與描述講原因；按下去什麼都不送', async () => {
    const fake = fakeClient({ events: source({ failedSecond: true, title: '計劃' }) });
    render(<App client={fake.client} />);
    await ready();
    const button = forkButtonOf('第二輪收尾。');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe(FORK_UNAVAILABLE_TEXT.failed);
    const described = button.getAttribute('aria-describedby');
    expect(described === null ? null : document.getElementById(described)?.textContent).toBe(
      FORK_UNAVAILABLE_TEXT.failed,
    );
    fireEvent.click(button);
    // 其他兩輪照樣按得了：標的是那一輪，不是整條。
    expect(forkButtonOf('第三輪收尾。').getAttribute('aria-disabled')).not.toBe('true');
    expect(fake.calls.filter((call) => call.startsWith('fork'))).toEqual([]);
  });

  it('串流中：所有分支鈕都按不了，tooltip 講要等這一輪跑完', async () => {
    seq = 0;
    const events = [
      ...turn('t1', '第一輪收尾。'),
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
    ];
    render(<App client={fakeClient({ events }).client} />);
    await waitFor(() => expect(screen.getByText('第一輪收尾。')).toBeTruthy());
    const button = forkButtonOf('第一輪收尾。');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe(FORK_UNAVAILABLE_TEXT.running);
  });

  it('不是收尾的那一則沒有分支鈕', async () => {
    seq = 0;
    const namespace = ['model_request:1'];
    const events = [
      frame('lifecycle', [], { event: 'running', graph_name: 'root' }),
      frame('messages', namespace, { event: 'message-start', id: 'run-a', run_id: 'a' }),
      frame('messages', namespace, {
        event: 'content-block-delta',
        index: 0,
        delta: { type: 'text-delta', text: '先說一句。' },
        run_id: 'a',
      }),
      frame('messages', namespace, { event: 'message-finish', reason: 'stop', run_id: 'a' }),
      ...turn('b', '第三輪收尾。').slice(1),
    ];
    render(<App client={fakeClient({ events }).client} />);
    await ready();
    expect(within(entryOf('先說一句。')).queryByTestId('fork-button')).toBeNull();
    expect(screen.getAllByTestId('fork-button')).toHaveLength(1);
  });

  it('送出之後、回應之前：再按一次不會再送，按鈕講正在分', async () => {
    const answer = deferred<CommandOutcome<ThreadForkResult>>();
    const fake = fakeClient({ fork: () => answer.promise });
    render(<App client={fake.client} />);
    await ready();
    // 同一個 tick 連點兩下：React 還沒重畫，第二下碰到的還是按得了的那顆（擋它的是 `App` 的 ref，不是停用的外觀）。
    const button = forkButtonOf('第二輪收尾。');
    act(() => {
      button.click();
      button.click();
    });
    fireEvent.click(forkButtonOf('第二輪收尾。'));
    fireEvent.click(forkButtonOf('第三輪收尾。'));
    await waitFor(() =>
      expect(forkButtonOf('第三輪收尾。').getAttribute('title')).toBe(
        FORK_UNAVAILABLE_TEXT.forking,
      ),
    );
    expect(fake.calls.filter((call) => call.startsWith('fork'))).toEqual(['fork 來源 run-t2']);
    await act(async () => answer.resolve(ok({ threadId: '子' })));
    await waitFor(() => expect(remembered()).toBe('子'));
  });
});

describe('分出去之後', () => {
  it('依序：送分叉 → 清單先出現新的一列 → 改成遞增的名字 → 切到子對話，講是分出來的', async () => {
    const renamed = deferred<CommandOutcome<ThreadRenameResult>>();
    const fake = fakeClient({ rename: () => renamed.promise });
    render(<App client={fake.client} />);
    await ready();
    const list = await screen.findByRole('group', { name: '以前的會話' });
    await waitFor(() => expect(within(list).getByText('計劃（1）')).toBeTruthy());
    expect(within(list).queryByText('新會話')).toBeNull();

    fireEvent.click(forkButtonOf('第二輪收尾。'));
    await waitFor(() => expect(fake.calls).toContain('rename 子 計劃（2）'));
    // 改名還沒回：佔位已經在清單上（還沒有標題）、記著來源，畫面還在來源。
    const row = within(list).getByText('新會話').closest('[data-sidebar="menu-item"]');
    expect(row?.getAttribute('data-parent-thread-id')).toBe('來源');
    expect(fake.calls.filter((call) => call.startsWith('open'))).toEqual(['open 來源']);
    expect(fake.calls.filter((call) => /^(fork|rename)/u.test(call))).toEqual([
      'fork 來源 run-t2',
      'rename 子 計劃（2）',
    ]);

    await act(async () => renamed.resolve(ok({ title: '計劃（2）', seq: 9 })));
    await waitFor(() => expect(fake.calls).toContain('open 子'));
    expect(remembered()).toBe('子');
    expect(await screen.findByText(FORKED_THREAD_NOTICE)).toBeTruthy();
  });

  it('途中人自己從清單換到別條：佔位與改名照做，但不把人拉回子對話（後按的贏）', async () => {
    const renamed = deferred<CommandOutcome<ThreadRenameResult>>();
    const fake = fakeClient({ rename: () => renamed.promise });
    render(<App client={fake.client} />);
    await ready();
    const list = await screen.findByRole('group', { name: '以前的會話' });
    fireEvent.click(forkButtonOf('第二輪收尾。'));
    await waitFor(() => expect(fake.calls).toContain('rename 子 計劃（2）'));
    fireEvent.click(await within(list).findByText('別條對話'));
    await waitFor(() => expect(remembered()).toBe('別條'));
    await act(async () => renamed.resolve(ok({ title: '計劃（2）', seq: 9 })));
    expect(remembered()).toBe('別條');
    expect(fake.calls).not.toContain('open 子');
  });

  it('來源沒有標題：不改名，照樣切過去', async () => {
    const fake = fakeClient({ events: source() });
    render(
      <App
        client={{
          ...fake.client,
          listThreads: async () => ({ kind: 'rejected', message: '沒有清單' }),
        }}
      />,
    );
    await ready();
    fireEvent.click(forkButtonOf('第一輪收尾。'));
    await waitFor(() => expect(remembered()).toBe('子'));
    expect(fake.calls.filter((call) => call.startsWith('rename'))).toEqual([]);
    expect(fake.calls).toContain('fork 來源 run-t1');
  });

  it('改名失敗：子對話照樣切過去，toast 講已分出但改名失敗', async () => {
    const fake = fakeClient({
      rename: async () =>
        ({
          kind: 'ok',
          result: {
            ok: false,
            error: { code: 'title_invalid', message: '標題壞了（#1581 測試）。' },
          },
        }) as CommandOutcome<ThreadRenameResult>,
    });
    render(<App client={fake.client} />);
    await ready();
    fireEvent.click(forkButtonOf('第二輪收尾。'));
    const card = await toastWith('標題壞了（#1581 測試）。');
    expect(card.textContent).toContain(FORK_RENAME_FAILED_TEXT);
    await waitFor(() => expect(remembered()).toBe('子'));
    expect(fake.calls).toContain('open 子');
  });
});

describe('分不出去', () => {
  it.each([
    [
      'fork_unavailable',
      async () => ({ kind: 'ok', result: { ok: false, error: { code: 'fork_unavailable' } } }),
      '這一輪還不能分支。',
    ],
    [
      '名額滿了',
      async () => ({
        kind: 'rejected',
        code: THREAD_AT_CAPACITY,
        message: '上限 8／8，重啟 serve',
      }),
      THREAD_AT_CAPACITY_TEXT,
    ],
    [
      '其他錯誤（找不到來源）',
      async () => ({ kind: 'ok', result: { ok: false, error: { code: 'thread_not_found' } } }),
      '找不到這條會話（可能已經被刪掉）。',
    ],
  ] as const)('%s：畫面不切、輸入框的字不動，toast 講原因', async (_label, fork, reason) => {
    const fake = fakeClient({ fork: fork as () => Promise<CommandOutcome<ThreadForkResult>> });
    render(<App client={fake.client} />);
    await ready();
    const input = screen.getByLabelText('要說的話') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '還沒送的草稿（#1581）' } });

    fireEvent.click(forkButtonOf('第二輪收尾。'));
    const card = await toastWith(reason);
    expect(card.textContent).toContain(FORK_FAILED_TEXT);
    expect(remembered()).toBe('來源');
    expect(fake.calls.filter((call) => call.startsWith('open'))).toEqual(['open 來源']);
    expect(fake.calls.filter((call) => call.startsWith('rename'))).toEqual([]);
    expect((screen.getByLabelText('要說的話') as HTMLTextAreaElement).value).toBe(
      '還沒送的草稿（#1581）',
    );
    // 失敗之後按鈕放開，可以再按。
    await waitFor(() =>
      expect(forkButtonOf('第二輪收尾。').getAttribute('aria-disabled')).not.toBe('true'),
    );
  });
});
