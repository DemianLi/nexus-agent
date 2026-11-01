import type { ConversationState } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RightSidebarToggle } from '@/components/sidebar/right-sidebar';
import { createConversationStore } from '@/lib/conversation-store';
import { LAYOUT_KEY_PREFIX } from '@/lib/right-sidebar';
import type { SidebarLayout } from '@/lib/right-sidebar';
import { ENDING_LABEL, traceModel } from '@/lib/trace-view';
import { Script } from '@/test/conversation-frames';
import { memoryStorage, WithRightSidebar } from '@/test/right-sidebar';
import { call, digest, tool, turn, view, withTrajectory } from '@/test/trajectory-fixtures';

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const open: SidebarLayout = { open: true, tabs: [{ kind: 'trace' }], active: 'trace' };

type TurnSpec = Parameters<typeof turn>[1];
type ViewExtra = Parameters<typeof view>[1];

/** 每輪一次呼叫、一顆工具（對話裡有對應的工具卡，投影的輪才歸得進去）；對話最後收在 `completed`。 */
function conversation(specs: TurnSpec[], extra?: ViewExtra): ConversationState {
  const script = new Script();
  const frames = [script.running()];
  const turns = specs.map((spec, i) => {
    frames.push(...script.human(`inbox:r${i}`, `第 ${i} 句`));
    frames.push(script.started(`c${i}`, 'echo', {}));
    frames.push(script.finished(`c${i}`, 'ok'));
    return turn(i, {
      calls: [call(5 + i * 10, { tools: [tool(`c${i}`, { name: 'echo' })] })],
      ...spec,
    });
  });
  frames.push(script.completed());
  return withTrajectory(reduceAll(emptyConversation(), frames), script, view(turns, extra));
}

function mount(state: ConversationState) {
  localStorage.setItem(LAYOUT_KEY_PREFIX + 't', JSON.stringify(open));
  return render(
    <WithRightSidebar sources={{ conversation: createConversationStore(state) }}>
      <RightSidebarToggle />
    </WithRightSidebar>,
  );
}

const head = () => screen.getAllByTestId('trace-turn-head').at(-1)!;

describe('觀測分頁：被中止的那一輪標頭分開講時間到與停止（#1847）', () => {
  it('時鐘到點：寫超過時間上限', async () => {
    mount(conversation([{ end: 'aborted', endCause: { kind: 'hook', reason: 'turn-timeout' } }]));
    await act(async () => {});
    expect(screen.getByTestId('trace-head-status').textContent).toBe('超過時間上限，已停止');
  });

  it.each([
    [{ kind: 'user' }],
    [{ kind: 'parent' }],
    [{ kind: 'hook', reason: 'some-other-hook' }],
    [undefined],
  ] as const)('其餘的停法（%o）寫已停止，不印原因字串', async (endCause) => {
    mount(conversation([{ end: 'aborted', ...(endCause === undefined ? {} : { endCause }) }]));
    await act(async () => {});
    expect(screen.getByTestId('trace-head-status').textContent).toBe('已停止');
  });
});

describe('觀測分頁：失敗的那一輪標頭寫它是哪一類失敗（#1121）', () => {
  it('帶了碼：寫「失敗（額度用盡）」，原碼放在 title 與 data-failure-code', async () => {
    mount(conversation([{ end: 'failed', failureCode: 'QUOTA' }]));
    await act(async () => {});
    const fact = screen.getByTestId('trace-head-failure');
    expect(fact.textContent).toBe('失敗（額度用盡）');
    expect(fact.getAttribute('data-failure-code')).toBe('QUOTA');
    expect(fact.getAttribute('title')).toBe('QUOTA');
    expect(head().textContent).toContain('耗時');
  });

  it('巢狀太深（NESTING_TOO_DEEP，#1753）：寫中文的那一句，英文碼只留在 title 與 data-failure-code', async () => {
    mount(conversation([{ end: 'failed', failureCode: 'NESTING_TOO_DEEP' }]));
    await act(async () => {});
    const fact = screen.getByTestId('trace-head-failure');
    expect(fact.textContent).toBe('失敗（這則訊息巢狀太深，這一輪沒有完成）');
    expect(fact.getAttribute('data-failure-code')).toBe('NESTING_TOO_DEEP');
    expect(head().textContent).not.toContain('NESTING_TOO_DEEP');
  });

  it('HTTP_<n> 帶狀態碼；不認得的碼原樣寫在括號裡', async () => {
    mount(conversation([{ end: 'failed', failureCode: 'HTTP_418' }]));
    await act(async () => {});
    expect(screen.getByTestId('trace-head-failure').textContent).toBe('失敗（HTTP 418）');
    cleanup();
    mount(conversation([{ end: 'failed', failureCode: 'FROM_THE_FUTURE' }]));
    await act(async () => {});
    expect(screen.getByTestId('trace-head-failure').textContent).toBe('失敗（FROM_THE_FUTURE）');
  });

  it('沒帶碼（舊日誌）：只寫「失敗」，不補「原因不明」，也沒有失敗碼的標記', async () => {
    mount(conversation([{ end: 'failed' }]));
    await act(async () => {});
    expect(screen.queryByTestId('trace-head-failure')).toBeNull();
    expect(head().textContent).toContain('失敗');
    expect(head().textContent).not.toContain('原因不明');
    expect(head().textContent).not.toContain('（');
  });

  it('只有收尾是 failed 才寫；其他收尾就算帶了碼也照常寫自己的收尾', async () => {
    mount(conversation([{ end: 'aborted', failureCode: 'QUOTA' }]));
    await act(async () => {});
    expect(screen.queryByTestId('trace-head-failure')).toBeNull();
    expect(head().textContent).toContain('已停止');
    expect(head().textContent).not.toContain('額度用盡');
  });

  it('更早的輪（窗口外的摘要）也寫', async () => {
    mount(
      conversation([{}], {
        digests: [digest(10, { end: 'failed', failureCode: 'RATE_LIMIT' }), digest(11)],
      }),
    );
    await act(async () => {});
    const block = screen.getByTestId('trace-digests');
    fireEvent.click(within(block).getByRole('button', { name: /更早的 2 輪/ }));
    const failed = within(block).getByTestId('trace-head-failure');
    expect(failed.textContent).toBe('失敗（被限流）');
    expect(within(block).getAllByTestId('trace-digest')).toHaveLength(2);
  });
});

describe('觀測分頁：時間到停下的收尾列（#1631）', () => {
  const stoppedWith = (cause: unknown) => {
    const script = new Script();
    return reduceAll(emptyConversation(), [
      script.running(),
      ...script.human('history-0', '跑久一點'),
      script.openAi('a'),
      script.delta('a', '講到一半'),
      script.stopped(cause),
    ]);
  };
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  it.each([
    ['時鐘到點', { kind: 'hook', reason: 'turn-timeout' }, ENDING_LABEL['timed-out']],
    ['人按了停止', { kind: 'user' }, ENDING_LABEL.stopped],
  ] as const)('%s：只寫一次標籤（摘要不重複），不畫紅', async (_name, cause, label) => {
    const view = mount(stoppedWith(cause));
    await act(async () => {});
    const text = view.container.textContent ?? '';
    expect(count(text, label)).toBe(1);
    expect(view.container.querySelector('.text-destructive')).toBeNull();
  });
});

describe('traceModel：失敗碼跟著收尾走', () => {
  it('完整輪與摘要都帶碼，沒帶的不出現這一格', () => {
    const model = traceModel(
      conversation([{ end: 'failed', failureCode: 'AUTH' }, { end: 'failed' }], {
        digests: [
          digest(10, { end: 'failed', failureCode: 'SERVER' }),
          digest(11, { end: 'failed' }),
        ],
      }),
    );
    expect(model.turns.map((t) => t.head?.failureCode)).toEqual(['AUTH', undefined]);
    expect(model.digests.map((d) => d.failureCode)).toEqual(['SERVER', undefined]);
    expect(Object.hasOwn(model.turns[1]!.head!, 'failureCode')).toBe(false);
    expect(Object.hasOwn(model.digests[1]!, 'failureCode')).toBe(false);
  });

  it('核准後續接：失敗發生在接上去的那一段，併回同一組後碼取最後一段的', () => {
    const model = traceModel(
      conversation([{}, { kind: 'resume', logical: false, end: 'failed', failureCode: 'TIMEOUT' }]),
    );
    expect(model.turns).toHaveLength(1);
    expect(model.turns[0]!.head?.end).toBe('failed');
    expect(model.turns[0]!.head?.failureCode).toBe('TIMEOUT');
  });

  it('核准後續接：時鐘到點在接上去的那一段，併回同一組後原因還在（#1847）', () => {
    const endCause = { kind: 'hook', reason: 'turn-timeout' } as const;
    const model = traceModel(
      conversation([{}, { kind: 'resume', logical: false, end: 'aborted', endCause }]),
    );
    expect(model.turns[0]!.head?.endCause).toEqual(endCause);
  });

  it('前一段已經收了（停在核准點）又接上一段沒失敗：不留前一段的碼', () => {
    const model = traceModel(
      conversation([{ end: 'completed' }, { kind: 'resume', logical: false, end: 'completed' }]),
    );
    expect(model.turns[0]!.head?.failureCode).toBeUndefined();
  });
});
