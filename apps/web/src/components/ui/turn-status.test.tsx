import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { TurnStatus } from '@/components/ui/turn-status';
import { TurnStatus as VendorTurnStatus } from '@/vendor/solid-glass/components/ui/turn-status';

afterEach(cleanup);

/**
 * SG 的 TurnStatus（#1684）。vendor 檔套了一個 patch（README「本地修改」第 72 條），包裝層擋掉三個 props（第 74 條）。
 * 接到狀態列之後的行為在 `components/status-line.test.tsx`，畫出來的樣子（glyph 在動、shimmer、對比、高度）在 `guard/` 量。
 */

describe('0023：vendor 檔不掛 role="status"', () => {
  test('沒有 children（一個 div）：DOM 裡沒有 role="status"', () => {
    const { container } = render(<VendorTurnStatus label="執行中…" />);
    expect(container.querySelector('[data-slot="turn-status"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  // 包裝層型別上拿掉了 children，這一條直接畫 vendor 那份：patch 拿掉的是兩處，按鈕那處只有給 children 才畫得到。
  test('有 children（一顆按鈕）：DOM 裡沒有 role="status"，按鈕照樣帶 aria-expanded、打得開', () => {
    const { container, getByRole } = render(
      <VendorTurnStatus label="執行中…">
        <p>這一步的呼叫</p>
      </VendorTurnStatus>,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    const button = getByRole('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('這一步的呼叫');
  });
});

describe('包裝層：型別上沒有 since、tokens、children（第 74 條）', () => {
  test('三個都傳不進去（拿掉 Omit，這三行的 @ts-expect-error 就沒有錯可等、typecheck 紅）', () => {
    const { container } = render(
      <>
        {/* @ts-expect-error 經過時間由狀態列的 RunningElapsed 畫（live region 外、server 時鐘、中文） */}
        <TurnStatus label="執行中…" since={0} />
        {/* @ts-expect-error tokenUsage 是整條對話的累計，不是這一輪的 */}
        <TurnStatus label="執行中…" tokens={1} />
        {/* @ts-expect-error 有 children 就變成按鈕，nexus 沒有要放進去的東西 */}
        <TurnStatus label="執行中…">x</TurnStatus>
      </>,
    );
    expect(container.querySelectorAll('[data-slot="turn-status"]')).toHaveLength(3);
  });

  test('其他照 vendor：label 包在 status-shimmer 裡', () => {
    const { container } = render(<TurnStatus activity="running" label="執行中…" />);
    expect(container.querySelector('.status-shimmer')?.textContent).toBe('執行中…');
  });
});
