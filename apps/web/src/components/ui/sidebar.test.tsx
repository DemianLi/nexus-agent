import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function State() {
  return <output data-testid="state">{useSidebar().state}</output>;
}

/**
 * 第 51 條（`patches/0011-sidebar-chinese-strings.patch`）：Rail 的名稱與 title 是中文（§8）。產品沒有用 Rail，`App*.test.tsx`
 * 量不到它；Trigger 的「開關側欄」、抽屜的「側欄」由 `App.threads.test.tsx` 的手機抽屜那幾條量。
 */
test('Rail 的報讀名稱與 title 是「開關側欄」', () => {
  render(
    <SidebarProvider>
      <Sidebar>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>,
  );
  const rail = document.querySelector('[data-slot="sidebar-rail"]');
  expect(rail?.getAttribute('aria-label')).toBe('開關側欄');
  expect(rail?.getAttribute('title')).toBe('開關側欄');
});

/** 第 51 條：手機抽屜的說明是中文（§8）。 */
test('手機抽屜的說明是「對話列表與新對話。」', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width'),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  render(
    <SidebarProvider>
      <SidebarTrigger />
      <Sidebar>側欄內容</Sidebar>
    </SidebarProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: '開關側欄' }));
  const drawer = await screen.findByRole('dialog', { name: '側欄' });
  const describedBy = drawer.getAttribute('aria-describedby') ?? '';
  expect(document.getElementById(describedBy)?.textContent).toBe('對話列表與新對話。');
});

/**
 * 第 53 條（`patches/0013-sidebar-cookie-try-catch.patch`）：沙盒 iframe 裡寫 cookie 會拋 SecurityError，開關照樣能切（§9）。
 * state 在寫 cookie 之前就切了，事件處理器裡拋的錯由 React 交給 `reportError`（window 的 `error` 事件），不從 `fireEvent` 拋出來：
 * 所以除了看 state，還要數 window 收到幾個錯。
 */
test('寫 cookie 拋錯時，開關照樣切得動、沒有錯誤冒出來', () => {
  vi.spyOn(document, 'cookie', 'set').mockImplementation(() => {
    throw new DOMException('blocked', 'SecurityError');
  });
  const errors: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    errors.push(event.error);
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  onTestFinished(() => window.removeEventListener('error', onError));
  render(
    <SidebarProvider>
      <SidebarTrigger />
      <State />
    </SidebarProvider>,
  );
  expect(screen.getByTestId('state').textContent).toBe('expanded');
  fireEvent.click(screen.getByRole('button', { name: '開關側欄' }));
  expect(screen.getByTestId('state').textContent).toBe('collapsed');
  expect(errors).toEqual([]);
});
