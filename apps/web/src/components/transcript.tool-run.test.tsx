import type { Event } from '@nexus/wire';
import { emptyConversation, reduceAll } from '@nexus/wire';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Transcript } from '@/components/transcript';
import { findOrExpandTranscriptItem, findTranscriptItem } from '@/lib/transcript-locate';
import { axeViolations } from '@/test/axe';
import { Script } from '@/test/conversation-frames';

afterEach(cleanup);

/** 一輪：`steps` 步「思考、讀檔」，可選最後一顆還在跑，再加一句回覆。 */
function turn({
  steps,
  running = false,
  reply = true,
}: {
  steps: number;
  running?: boolean;
  reply?: boolean;
}) {
  const script = new Script();
  const events: Event[] = [script.running(), ...script.human('h1', '盤點各系統的筆記')];
  for (let n = 1; n <= steps; n += 1) {
    events.push(...script.ai(`r${n}`, { reasoning: `第 ${n} 步` }));
    events.push(
      script.started(`c${n}`, n === steps ? 'write_file' : 'read_file', {
        file_path: `/kb/${n}.md`,
      }),
    );
    events.push(script.finished(`c${n}`, 'ok'));
  }
  if (running) {
    events.push(...script.ai('rx', { reasoning: '再看一個' }));
    events.push(script.started('cx', 'read_file', { file_path: '/kb/x.md' }));
  }
  if (reply) events.push(...script.ai('rz', { reasoning: '收尾', text: '人事最久沒更新。' }));
  return reduceAll(emptyConversation(), events);
}

const show = (state: ReturnType<typeof turn>) =>
  render(<Transcript state={state} isFresh={() => false} />);
const runButton = () => screen.getByRole('button', { name: /個工具呼叫/ });

describe('連續完成的工具呼叫收成一列（#1309）', () => {
  it('預設收合：一顆按鈕講幾顆、哪些工具，帶 aria-expanded；工具卡與思考都不在畫面上，回覆照畫', () => {
    show(turn({ steps: 4 }));
    const button = runButton();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.textContent).toContain('4 個工具呼叫');
    expect(screen.getByTestId('tool-run-summary').textContent).toBe('讀取 ×3、寫入檔案');
    expect(screen.queryAllByTestId('tool-entry')).toHaveLength(0);
    expect(screen.queryAllByTestId('reasoning-row')).toHaveLength(1); // 只剩回覆那一則自己的
    expect(screen.getByText('人事最久沒更新。')).toBeTruthy();
    // 不開 live region：段長大時列上的數字會變，不唸。
    expect(button.closest('[role=status]')).toBeNull();
    expect(screen.getByTestId('tool-run').querySelector('[role=status]')).toBeNull();
  });

  it('點開：原本的工具卡與思考照順序畫在裡面，每一則還是一格可定位的 item', () => {
    show(turn({ steps: 4 }));
    fireEvent.click(runButton());
    expect(runButton().getAttribute('aria-expanded')).toBe('true');
    const run = screen.getByTestId('tool-run');
    const cards = within(run).getAllByTestId('tool-entry');
    expect(cards).toHaveLength(4);
    expect(within(run).getAllByTestId('reasoning-row')).toHaveLength(4);
    expect(
      cards[0]!.closest('[data-slot=message-scroller-item]')?.getAttribute('data-message-id'),
    ).toBe('tool-c1');
    fireEvent.click(runButton());
    expect(runButton().getAttribute('aria-expanded')).toBe('false');
  });

  it('單顆不收', () => {
    show(turn({ steps: 1 }));
    expect(screen.queryByRole('button', { name: /個工具呼叫/ })).toBeNull();
    expect(screen.getAllByTestId('tool-entry')).toHaveLength(1);
  });

  it('還在跑的那顆在段外、帶邊框光；前面完成的照收', () => {
    show(turn({ steps: 3, running: true, reply: false }));
    expect(runButton().textContent).toContain('3 個工具呼叫');
    const cards = screen.getAllByTestId('tool-entry');
    expect(cards).toHaveLength(1);
    expect(cards[0]!.getAttribute('data-status')).toBe('running');
    expect(cards[0]!.getAttribute('data-active')).toBe('true');
  });

  it('從觀測分頁定位到收起來的卡：先展開那一段（不做動畫），再找得到那一格', () => {
    show(turn({ steps: 4 }));
    expect(findTranscriptItem('tool-c3')).toBeUndefined();
    let item: HTMLElement | undefined;
    act(() => {
      item = findOrExpandTranscriptItem('tool-c3');
    });
    expect(item?.getAttribute('data-message-id')).toBe('tool-c3');
    expect(item?.querySelector('[data-testid=tool-entry]')).not.toBeNull();
    expect(runButton().getAttribute('aria-expanded')).toBe('true');
    const content = screen.getByTestId('tool-run').querySelector('[data-state=open]:not(button)');
    expect(content?.className).not.toContain('animate-collapsible');
    // 不在任何一段裡、也不在畫面上的：照舊找不到。
    expect(findOrExpandTranscriptItem('tool-nope')).toBeUndefined();
  });

  it('自己點開的照樣有展開收合的動效', () => {
    show(turn({ steps: 4 }));
    fireEvent.click(runButton());
    const content = screen.getByTestId('tool-run').querySelector('[data-state=open]:not(button)');
    expect(content?.className).toContain('animate-collapsible-down');
  });

  it('收合與展開都沒有 axe 違規', async () => {
    const { container } = show(turn({ steps: 4 }));
    expect(await axeViolations(container)).toEqual([]);
    fireEvent.click(runButton());
    expect(await axeViolations(container)).toEqual([]);
  });
});
