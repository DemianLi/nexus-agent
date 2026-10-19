import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';

import { DiffStats } from '@/components/ui/diff-view';

afterEach(cleanup);

/**
 * nexus 層的 `DiffStats`（#1685 PR A，README 本地修改第 76 條）：看得見的是 vendor 那顆「+N −M」，報讀器唸的是 sr-only 那一段。
 * 兩色（第 75 條）是覆寫檔的事，jsdom 不算樣式，交給 `guard/`。
 */
describe('DiffStats 的 nexus 層（第 76 條）', () => {
  test('看得見的「+12 −3」藏起來，報讀只唸一次「新增 12 行，刪除 3 行」', () => {
    render(
      <button type="button">
        改了一個檔
        <DiffStats added={12} removed={3} />
      </button>,
    );
    const button = screen.getByRole('button', { name: '改了一個檔新增 12 行，刪除 3 行' });
    const visible = button.querySelector('[data-slot="diff-stats"]')!;
    expect(visible.textContent).toBe('+12 −3');
    expect(visible.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  test('數字照 SG 不分位：1234 畫成 +1234，報讀也是 1234', () => {
    const { container } = render(<DiffStats added={1234} removed={0} />);
    expect(container.querySelector('[data-slot="diff-stats"]')!.textContent).toBe('+1234 −0');
    expect(screen.getByText('新增 1234 行，刪除 0 行').className).toBe('sr-only');
  });

  test('外層帶 shrink-0（在 flex 列裡不被擠），className 接在外層', () => {
    const { container } = render(<DiffStats added={1} removed={2} className="ml-auto" />);
    expect((container.firstElementChild as HTMLElement).className).toBe('shrink-0 ml-auto');
  });
});
