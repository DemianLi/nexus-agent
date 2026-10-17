import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test('預設按鈕同時帶著字級與字色（cn 不能把其中一個吃掉）', () => {
  render(<Button>送出</Button>);
  const classes = screen.getByRole('button', { name: '送出' }).className.split(/\s+/);
  // 字級是 vendor 原文的 `text-sm`（#1523 起外觀照 SG）；顏色那個 class 不能被它吃掉（#1141，cn 別名見 `lib/cn-alias.test.tsx`）。
  expect(classes).toContain('text-sm');
  expect(classes).toContain('text-primary-foreground');
});

test('SG 的樣式靠的屬性都在：Button 的 data-slot／data-variant，Badge 經 useRender 的 state 輸出的同兩個（solid-glass.css:436、:482、:519-532、:640-677）', () => {
  render(
    <>
      <Button variant="outline">按鈕</Button>
      <Badge variant="destructive">標籤</Badge>
    </>,
  );
  const button = screen.getByRole('button', { name: '按鈕' });
  expect(button.getAttribute('data-slot')).toBe('button');
  expect(button.getAttribute('data-variant')).toBe('outline');
  const badge = screen.getByText('標籤');
  expect(badge.getAttribute('data-slot')).toBe('badge');
  expect(badge.getAttribute('data-variant')).toBe('destructive');
});

test('Base UI 的 Button 預設 type="button"：表單裡要送出的那顆要自己寫 type="submit"（裸 <button> 預設是 submit）', () => {
  render(
    <form>
      <Button>預設</Button>
      <Button type="submit">送出</Button>
    </form>,
  );
  expect(screen.getByRole('button', { name: '預設' }).getAttribute('type')).toBe('button');
  expect(screen.getByRole('button', { name: '送出' }).getAttribute('type')).toBe('submit');
});

/**
 * 混合期（#1523）：浮層還是 Radix（③-2 才換），Trigger／Close 用 `asChild` 包著 Base UI 的 Button。
 * Radix 的 Slot 把 ref 與事件併到子元素上，Base UI 的 Button 要把它們接到真的 `<button>`。
 */
describe('混合期：Radix 的 asChild 包 Base UI 的 Button', () => {
  test('PopoverTrigger：ref 拿到那顆 button，點下去開浮層、掛上 aria-expanded（App 的右側欄、changes/review 的用法）', () => {
    const ref = createRef<HTMLButtonElement>();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button ref={ref} variant="outline">
            開浮層
          </Button>
        </PopoverTrigger>
        <PopoverContent>浮層內容</PopoverContent>
      </Popover>,
    );
    const trigger = screen.getByRole('button', { name: '開浮層' });
    expect(ref.current).toBe(trigger);
    expect(trigger.getAttribute('data-slot')).toBe('popover-trigger');
    fireEvent.click(trigger);
    expect(screen.getByText('浮層內容')).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
  });

  test('TooltipTrigger：鍵盤聚焦就出提示（App.tsx 的用法）', () => {
    // Radix 的 tooltip 定位用到 jsdom 沒有的 ResizeObserver。
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="設定" />
          </TooltipTrigger>
          <TooltipContent>提示內容</TooltipContent>
        </Tooltip>
      </TooltipProvider>,
    );
    act(() => {
      screen.getByRole('button', { name: '設定' }).focus();
    });
    expect(screen.getByRole('tooltip').textContent).toBe('提示內容');
  });

  test('DialogClose：dialog footer 的關閉鈕點了就關（dialog.tsx 的 showCloseButton）', () => {
    render(
      <Dialog defaultOpen>
        <DialogContent showCloseButton={false} aria-describedby={undefined}>
          <DialogTitle>標題</DialogTitle>
          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
