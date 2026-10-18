import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/**
 * tooltip 的延遲（#1583）：nexus 要 0（develop 的 Radix Provider `delayDuration={0}`）。Base UI 的 Trigger 取
 * `delay ?? Provider 的 delay ?? 600`，SG 的 `TooltipProvider` 預設 `delay=0`（vendor `tooltip.tsx:7`），所以 Provider 底下就是 0。
 * 產品裡唯一的 tooltip（`App.tsx` 的停止鈕）自己包一層 Provider。#1680 之前 `ui/sidebar.tsx` 的 SidebarProvider 也包一層，SG 版沒有。
 */

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const popup = () => document.querySelector('[data-slot="tooltip-content"]');

function hover() {
  const trigger = screen.getByRole('button', { name: '設定' });
  fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
  fireEvent.mouseEnter(trigger);
  fireEvent.mouseMove(trigger);
}

function Tip() {
  return (
    <Tooltip>
      <TooltipTrigger render={<button aria-label="設定" />} />
      <TooltipContent>設定</TooltipContent>
    </Tooltip>
  );
}

describe('tooltip 的延遲', () => {
  test('Provider 底下：滑鼠移上去不用等就出提示', () => {
    render(
      <TooltipProvider>
        <Tip />
      </TooltipProvider>,
    );
    hover();
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(popup()?.textContent).toBe('設定');
  });

  test('量具自檢：沒有 Provider 時是 Base UI 的 600ms，0ms 時還沒出來', () => {
    render(<Tip />);
    hover();
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(popup()).toBeNull();
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(popup()?.textContent).toBe('設定');
  });
});
