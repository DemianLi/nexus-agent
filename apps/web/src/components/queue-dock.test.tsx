import type { ConversationStatus, QueueUpdateAction, WireQueuedInput } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueueDock } from '@/components/queue-dock';
import type { QueueUpdateRejected } from '@/hooks/use-conversation';
import {
  QUEUE_GONE_TEXT,
  QUEUE_LEAVE_MS,
  QUEUE_PARKED_TEXT,
  QUEUE_SETTLE_MS,
} from '@/lib/queue-view';
import { axeViolations } from '@/test/axe';

const toastSpy = vi.hoisted(() => {
  const spy = vi.fn() as ReturnType<typeof vi.fn> & { error: ReturnType<typeof vi.fn> };
  spy.error = vi.fn();
  return spy;
});
vi.mock('sonner', () => ({ toast: toastSpy }));

/**
 * 送出佇列（#645）。清單由 harness 推（`ConversationState.inbox`），這裡手餵；改、刪的回條由 `onUpdate` 決定，
 * 清單的新樣子照伺服器那樣另外推進來——不拿回條改畫面。
 */

function item(id: string, text: string): WireQueuedInput {
  return { id, text, source: { kind: 'user' } };
}

type Update = (id: string, action: QueueUpdateAction) => Promise<QueueUpdateRejected | undefined>;

function mount(
  items: readonly WireQueuedInput[],
  {
    status = 'running' as ConversationStatus,
    onUpdate = vi.fn<Update>(async () => undefined),
    onFocusFallback = vi.fn(),
  } = {},
) {
  const view = render(
    <div>
      <QueueDock
        items={items}
        status={status}
        connected
        onUpdate={onUpdate}
        onFocusFallback={onFocusFallback}
      />
      <textarea aria-label="輸入框" />
    </div>,
  );
  const rerender = (next: readonly WireQueuedInput[], nextStatus: ConversationStatus = status) =>
    view.rerender(
      <div>
        <QueueDock
          items={next}
          status={nextStatus}
          connected
          onUpdate={onUpdate}
          onFocusFallback={onFocusFallback}
        />
        <textarea aria-label="輸入框" />
      </div>,
    );
  return { ...view, rerender, onUpdate, onFocusFallback };
}

/** 讓新進來的撐過延遲、淡出的走完、rAF 跑掉。 */
function settle(ms = QUEUE_SETTLE_MS) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** 等 `onUpdate` 的 promise 收掉。 */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  toastSpy.mockReset();
  toastSpy.error.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('出現與消失', () => {
  it('空的不畫', () => {
    mount([]);
    expect(screen.queryByTestId('queue-dock')).toBeNull();
  });

  it('新的一件撐過延遲才畫（Q5）', () => {
    mount([item('a', '第一句')]);
    act(() => vi.advanceTimersByTime(QUEUE_SETTLE_MS - 1));
    expect(screen.queryByTestId('queue-dock')).toBeNull();
    settle(1);
    expect(within(screen.getByTestId('queue-dock')).getByText('第一句')).toBeTruthy();
  });

  it('閒著時收下又當場領走：一次都不畫', () => {
    const { rerender } = mount([item('a', '第一句')], { status: 'idle' });
    act(() => vi.advanceTimersByTime(QUEUE_SETTLE_MS / 2));
    rerender([]);
    settle(QUEUE_SETTLE_MS * 2);
    expect(screen.queryByTestId('queue-dock')).toBeNull();
  });

  it('畫出來之後被領走：先淡出，再拿掉', () => {
    const { rerender } = mount([item('a', '第一句'), item('b', '第二句')]);
    settle();
    fireEvent.click(screen.getByRole('button', { name: '2 則排著的訊息' }));
    rerender([item('b', '第二句')]);
    const leaving = document.querySelector('[data-queue-item="a"]');
    expect(leaving?.hasAttribute('data-leaving')).toBe(true);
    settle(QUEUE_LEAVE_MS);
    expect(document.querySelector('[data-queue-item="a"]')).toBeNull();
    expect(document.querySelector('[data-queue-item="b"]')).not.toBeNull();
  });

  it('同一件改了文字：立刻換字，不重算延遲', () => {
    const { rerender } = mount([item('a', '原本')]);
    settle();
    rerender([item('a', '改過')]);
    expect(within(screen.getByTestId('queue-dock')).getByText('改過')).toBeTruthy();
  });

  it('預覽攤成一行', () => {
    mount([item('a', '第一行\n\n第二行')]);
    settle();
    expect(within(screen.getByTestId('queue-dock')).getByText('第一行 第二行')).toBeTruthy();
  });
});

describe('收合', () => {
  it('一件直接畫；兩件以上預設收合，表頭寫件數', () => {
    const { rerender } = mount([item('a', '第一句')]);
    settle();
    expect(screen.queryByRole('button', { name: /則排著的訊息/ })).toBeNull();
    expect(screen.getByRole('button', { name: '編輯：第一句' })).toBeTruthy();

    rerender([item('a', '第一句'), item('b', '第二句')]);
    settle();
    const header = screen.getByRole('button', { name: '2 則排著的訊息' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(header);
    expect(screen.getByRole('button', { name: '編輯：第二句' })).toBeTruthy();
  });

  it('清空之後下一次出現回到收合', () => {
    const { rerender } = mount([item('a', '一'), item('b', '二')]);
    settle();
    fireEvent.click(screen.getByRole('button', { name: '2 則排著的訊息' }));
    rerender([]);
    settle(QUEUE_LEAVE_MS);
    rerender([item('c', '三'), item('d', '四')]);
    settle();
    expect(
      screen.getByRole('button', { name: '2 則排著的訊息' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });
});

describe('停住（Q6）', () => {
  it.each<[ConversationStatus, boolean]>([
    ['running', false],
    ['awaiting-input', false],
    ['stopped', true],
    ['idle', true],
  ])('%s：提示%s', (status, shown) => {
    mount([item('a', '第一句')], { status });
    settle();
    expect(screen.queryByText(QUEUE_PARKED_TEXT) !== null).toBe(shown);
  });
});

describe('編輯', () => {
  function startEditing(onUpdate = vi.fn<Update>(async () => undefined)) {
    const view = mount([item('a', '原本'), item('b', '另一句')], { onUpdate });
    settle();
    fireEvent.click(screen.getByRole('button', { name: '2 則排著的訊息' }));
    fireEvent.click(screen.getByRole('button', { name: '編輯：原本' }));
    const editor = screen.getByRole('textbox', { name: '改這一則排著的訊息' });
    return { ...view, editor };
  }

  it('Enter 存：送出改過的文字；Shift+Enter 不存', async () => {
    const { editor, onUpdate } = startEditing();
    fireEvent.change(editor, { target: { value: '改過\n第二行' } });
    fireEvent.keyDown(editor, { key: 'Enter', shiftKey: true });
    expect(onUpdate).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter' });
    await flush();
    expect(onUpdate).toHaveBeenCalledWith('a', { kind: 'edit', text: '改過\n第二行' });
    expect(screen.queryByRole('textbox', { name: '改這一則排著的訊息' })).toBeNull();
  });

  it('組字中按 Enter 不存', () => {
    const { editor, onUpdate } = startEditing();
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(editor, { key: 'Enter', keyCode: 229 });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('空白不能存', () => {
    const { editor, onUpdate } = startEditing();
    fireEvent.change(editor, { target: { value: '   ' } });
    expect(
      (screen.getByRole('button', { name: '存下改過的這一則' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('Esc 取消：不動佇列、不往外冒，焦點回到那一列的編輯鈕', () => {
    const outside = vi.fn();
    document.addEventListener('keydown', outside);
    try {
      const { editor, onUpdate } = startEditing();
      fireEvent.keyDown(editor, { key: 'Escape' });
      expect(onUpdate).not.toHaveBeenCalled();
      expect(outside).not.toHaveBeenCalled();
      settle(16);
      expect(document.activeElement).toBe(screen.getByRole('button', { name: '編輯：原本' }));
    } finally {
      document.removeEventListener('keydown', outside);
    }
  });

  it('編輯時其他列的鈕鎖住，表頭收不起來', () => {
    startEditing();
    expect(
      (screen.getByRole('button', { name: '刪除：另一句' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: '2 則排著的訊息' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('編輯中那一件開跑了：編輯器收掉，說一次；存的回條再說「不在隊裡」也不重複', async () => {
    let answer: (value: QueueUpdateRejected) => void = () => undefined;
    const onUpdate = vi.fn<Update>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    const { editor, rerender } = startEditing(onUpdate);
    fireEvent.change(editor, { target: { value: '改過' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    rerender([item('b', '另一句')]);
    answer({ gone: true, message: '這一件已經不在隊裡' });
    await flush();
    expect(screen.queryByRole('textbox', { name: '改這一則排著的訊息' })).toBeNull();
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(QUEUE_GONE_TEXT);
  });
});

describe('刪除與錯誤', () => {
  it('刪除送 remove；清單的新樣子等伺服器推', async () => {
    const { onUpdate } = mount([item('a', '第一句')]);
    settle();
    fireEvent.click(screen.getByRole('button', { name: '刪除：第一句' }));
    await flush();
    expect(onUpdate).toHaveBeenCalledWith('a', { kind: 'remove' });
    expect(screen.getByText('第一句')).toBeTruthy();
  });

  it('不在隊裡：講「可能已經開始跑了」，不是紅字錯誤', async () => {
    mount([item('a', '第一句')], {
      onUpdate: vi.fn<Update>(async () => ({ gone: true, message: '不在隊裡' })),
    });
    settle();
    fireEvent.click(screen.getByRole('button', { name: '刪除：第一句' }));
    await flush();
    expect(toastSpy).toHaveBeenCalledWith(QUEUE_GONE_TEXT);
    expect(toastSpy.error).not.toHaveBeenCalled();
  });

  it('別的失敗：toast.error 帶原因', async () => {
    mount([item('a', '第一句')], {
      onUpdate: vi.fn<Update>(async () => ({ gone: false, message: 'fetch failed' })),
    });
    settle();
    fireEvent.click(screen.getByRole('button', { name: '刪除：第一句' }));
    await flush();
    expect(toastSpy.error).toHaveBeenCalledWith('刪不掉這一則', { description: 'fetch failed' });
  });
});

describe('焦點', () => {
  it('焦點所在那一列淡出：交給旁邊那一列', () => {
    const { rerender } = mount([item('a', '一'), item('b', '二')]);
    settle();
    fireEvent.click(screen.getByRole('button', { name: '2 則排著的訊息' }));
    screen.getByRole('button', { name: '刪除：一' }).focus();
    rerender([item('b', '二')]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '刪除：二' }));
  });

  it('最後一列淡出：交出去，不掉到 body', () => {
    const { rerender, onFocusFallback } = mount([item('a', '一')]);
    settle();
    screen.getByRole('button', { name: '刪除：一' }).focus();
    rerender([]);
    expect(onFocusFallback).toHaveBeenCalledTimes(1);
  });

  it('焦點不在佇列裡：不搶', () => {
    const { rerender, onFocusFallback } = mount([item('a', '一')]);
    settle();
    screen.getByRole('textbox', { name: '輸入框' }).focus();
    rerender([]);
    expect(onFocusFallback).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '輸入框' }));
  });
});

it('可近用：展開的兩件與編輯中都沒有 axe 違規', async () => {
  vi.useRealTimers();
  const { container } = mount([item('a', '一'), item('b', '二')]);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, QUEUE_SETTLE_MS + 20));
  });
  fireEvent.click(screen.getByRole('button', { name: '2 則排著的訊息' }));
  expect(await axeViolations(container)).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: '編輯：一' }));
  expect(await axeViolations(container)).toEqual([]);
});
