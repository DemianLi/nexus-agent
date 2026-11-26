import { act, cleanup, render } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, expect, test } from 'vitest';

import { Toaster } from '@/components/ui/sonner';

afterEach(() => {
  act(() => toast.dismiss());
  cleanup();
});

/** 有 toast 才畫出清單；回傳 sonner 的容器（`section`）與清單（`ol`）。 */
async function show(theme: 'light' | 'dark' | 'system') {
  const view = render(<Toaster theme={theme} />);
  act(() => {
    toast('存好了');
  });
  const list = await view
    .findByText('存好了')
    .then(() => view.container.ownerDocument.querySelector<HTMLElement>('[data-sonner-toaster]'));
  const section = list?.closest('section') ?? null;
  return { list, section };
}

/**
 * 第 49 條（`patches/0010-sonner-theme-prop.patch`）：vendor 版的主題吃 `theme` prop，不靠 `next-themes`。拿掉 patch 時 vendor 檔
 * import `next-themes`（沒有這個相依），這個檔整個載不起來。
 */
test('主題照呼叫端給的畫：dark 就是 dark', async () => {
  const { list } = await show('dark');
  expect(list?.getAttribute('data-sonner-theme')).toBe('dark');
});

/** 第 50 條（包裝層）：jsdom 沒有 `matchMedia`，`system` 當成淺色，不拋。 */
test('沒有 matchMedia 的環境，system 當成淺色', async () => {
  expect(typeof window.matchMedia).not.toBe('function');
  const { list } = await show('system');
  expect(list?.getAttribute('data-sonner-theme')).toBe('light');
});

/** 第 50 條（包裝層）：容器的報讀名稱是「通知」（§8）。sonner 會在後面接上快捷鍵說明。 */
test('通知容器的名稱是「通知」', async () => {
  const { section } = await show('light');
  expect(section?.getAttribute('aria-label')).toMatch(/^通知 /);
});

/** 照 SG：每則 toast 帶 `cn-toast`（#1680 PM 決定第 1 題）。 */
test('toast 帶 SG 的 cn-toast', async () => {
  const { list } = await show('light');
  expect(list?.querySelector('[data-sonner-toast]')?.classList.contains('cn-toast')).toBe(true);
});
