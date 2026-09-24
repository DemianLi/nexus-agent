import type { ConversationStatus, WireTodoItem } from '@nexus/wire';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TodoPanel } from '@/components/todo-panel';
import { axeViolations } from '@/test/axe';

/**
 * 輸入框上方的待辦清單（#575）。清單怎麼從日誌投影出來、什麼時候回到 `null`，驗在 `@nexus/wire` 與 harness 的
 * `todos-wire.test.ts`；這裡只驗畫出來的。
 */

afterEach(cleanup);

const todos: readonly WireTodoItem[] = [
  { content: '讀規格', status: 'completed' },
  { content: '寫測試', status: 'in_progress' },
  { content: '跑突變', status: 'in_progress' },
  { content: '開 PR', status: 'pending' },
];

function trigger() {
  return within(screen.getByTestId('todo-panel')).getByRole('button');
}

describe('待辦清單面板（#575）', () => {
  it('沒有清單（null）或清單是空的（[]）都不畫', () => {
    const { rerender } = render(<TodoPanel todos={null} status="idle" />);
    expect(screen.queryByTestId('todo-panel')).toBeNull();
    // 模型寫了一份空清單時是 `[]`，不是 `null`（#580）。
    rerender(<TodoPanel todos={[]} status="running" />);
    expect(screen.queryByTestId('todo-panel')).toBeNull();
  });

  it('預設收合，一行講「完成數/總數 · 進行中那一項」，其餘同時進行的另起一格', () => {
    render(<TodoPanel todos={todos} status="running" />);
    const button = trigger();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryAllByTestId('todo-item')).toHaveLength(0);
    expect(button.textContent).toBe('1/4 完成 · 寫測試+1');
    // 「+1」不接在會被截斷的那一格裡，吃掉剩下寬度的是外層（同工具卡，#577 在真 Chrome 上量過放錯的樣子）。
    const extra = within(button).getByTestId('todo-extra');
    expect(extra.previousElementSibling?.classList.contains('truncate')).toBe(true);
    expect(extra.classList.contains('shrink-0')).toBe(true);
    expect(extra.classList.contains('truncate')).toBe(false);
    expect(extra.parentElement?.classList.contains('flex-1')).toBe(true);
    expect(extra.previousElementSibling?.classList.contains('flex-1')).toBe(false);
  });

  it('按鈕名稱是「待辦清單：」接畫面上那一行，「+N」寫成一句話', () => {
    render(<TodoPanel todos={todos} status="running" />);
    expect(trigger().getAttribute('aria-label')).toBe(
      '待辦清單：1/4 完成 · 寫測試，另有 1 項進行中',
    );
    cleanup();
    render(
      <TodoPanel
        todos={[
          { content: '甲', status: 'completed' },
          { content: '乙', status: 'pending' },
        ]}
        status="idle"
      />,
    );
    expect(trigger().getAttribute('aria-label')).toBe('待辦清單：1/2 完成');
    expect(screen.queryByTestId('todo-extra')).toBeNull();
  });

  it('更新時不唸：沒有 role="status"，也沒有 aria-live（全站只有狀態列那一格）', () => {
    const { container } = render(<TodoPanel todos={todos} status="running" />);
    fireEvent.click(trigger());
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[aria-live]')).toBeNull();
  });

  it('展開逐項列出，完成的變淡；清單自己捲，不把對話擠掉', () => {
    render(<TodoPanel todos={todos} status="running" />);
    fireEvent.click(trigger());
    expect(
      screen
        .getAllByTestId('todo-item')
        .map((row) => [row.getAttribute('data-status'), row.textContent]),
    ).toEqual([
      ['completed', '已完成：讀規格'],
      ['in_progress', '進行中：寫測試'],
      ['in_progress', '進行中：跑突變'],
      ['pending', '待處理：開 PR'],
    ]);
    const scroll = screen.getByTestId('todo-panel-scroll');
    expect(scroll.classList.contains('overflow-y-auto')).toBe(true);
    expect([...scroll.classList].some((name) => name.startsWith('max-h-'))).toBe(true);
  });

  it.each<[ConversationStatus, boolean]>([
    ['running', true],
    ['awaiting-input', false],
    ['idle', false],
    ['failed', false],
    ['stopped', false],
  ])('status 是 %s：進行中那幾項閃不閃 → %s（只在這一輪執行中閃）', (status, shimmers) => {
    render(<TodoPanel todos={todos} status={status} />);
    fireEvent.click(trigger());
    const shimmering = screen
      .getAllByTestId('todo-item')
      .filter((row) => row.querySelector('.text-shimmer') !== null)
      .map((row) => row.getAttribute('data-status'));
    expect(shimmering).toEqual(shimmers ? ['in_progress', 'in_progress'] : []);
  });

  it('展開或收合跟著人：清單換一份、回到 null 再回來，都不會自己收起來', () => {
    const { rerender } = render(<TodoPanel todos={todos} status="running" />);
    fireEvent.click(trigger());
    expect(trigger().getAttribute('aria-expanded')).toBe('true');

    rerender(<TodoPanel todos={[{ content: '寫測試', status: 'completed' }]} status="running" />);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    // 每開一輪 pump 都送一顆 `null`：面板消失，但人選的展開要留到下一份清單。
    rerender(<TodoPanel todos={null} status="running" />);
    expect(screen.queryByTestId('todo-panel')).toBeNull();
    rerender(<TodoPanel todos={todos} status="running" />);
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByTestId('todo-item')).toHaveLength(4);
  });

  it('axe：收著與展開都沒有違規', async () => {
    const { container } = render(<TodoPanel todos={todos} status="running" />);
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(trigger());
    expect(await axeViolations(container)).toEqual([]);
  });
});
