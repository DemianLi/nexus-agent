import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionUsage } from '@/features/cost/session-usage';
import { axeViolations } from '@/test/axe';
import { WithRightSidebar, memoryStorage } from '@/test/right-sidebar';

/**
 * 頂列那顆「這條對話的用量」（#574）。什麼時候畫、字怎麼寫驗在 `shared/lib/usage-view.test.ts`；這裡只驗畫出來的。
 */

beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const usage = { inputTokens: 412_380, outputTokens: 9_815 };
const stats = { turns: 4, steps: 17, llmMs: 133_000, toolMs: 38_400 };

function chip() {
  return screen.getByTestId('session-usage');
}

describe('會話累計用量（#574）', () => {
  it('兩格都是 null：不畫', () => {
    render(<SessionUsage tokenUsage={null} sessionStats={null} />);
    expect(screen.queryByTestId('session-usage')).toBeNull();
  });

  it('收著只寫總量；名稱帶著畫面上那串字', () => {
    render(<SessionUsage tokenUsage={usage} sessionStats={stats} />);
    expect(chip().textContent).toBe('422k token');
    expect(chip().getAttribute('aria-label')).toBe('這條對話的用量：422k token，點開看明細');
  });

  it('點開：只有精確總數與成本分頁入口，逐項明細與時間不在這裡', () => {
    render(<SessionUsage tokenUsage={usage} sessionStats={stats} />);
    fireEvent.click(chip());
    const dialog = screen.getByRole('dialog', { name: '這條對話的用量明細' });
    expect(screen.getByTestId('session-usage-total').textContent).toBe('累計422,195 token');
    expect(dialog.textContent).not.toContain('輸入');
    expect(dialog.textContent).not.toContain('快取');
    expect(dialog.textContent).not.toContain('模型時間');
  });

  it('沒有 token：總數那格退成次數', () => {
    render(<SessionUsage tokenUsage={null} sessionStats={stats} />);
    expect(chip().textContent).toBe('4 輪／17 次');
    fireEvent.click(chip());
    expect(screen.getByTestId('session-usage-total').textContent).toBe('累計4 輪／17 次');
  });

  it('更新時不唸：沒有 role="status"，也沒有 aria-live', () => {
    const { baseElement } = render(<SessionUsage tokenUsage={usage} sessionStats={stats} />);
    fireEvent.click(chip());
    expect(baseElement.querySelector('[role="status"]')).toBeNull();
    expect(baseElement.querySelector('[aria-live]')).toBeNull();
  });

  it('axe：收著與點開都沒有違規', async () => {
    const { baseElement } = render(<SessionUsage tokenUsage={usage} sessionStats={stats} />);
    expect(await axeViolations(baseElement)).toEqual([]);
    fireEvent.click(chip());
    expect(await axeViolations(baseElement)).toEqual([]);
  });
});

describe('到成本分頁（#1031）', () => {
  it('沒有右側欄時不畫：一顆按了沒反應的鈕比不給更糟', () => {
    render(<SessionUsage tokenUsage={usage} sessionStats={stats} />);
    fireEvent.click(chip());
    expect(screen.queryByTestId('session-usage-detail')).toBeNull();
  });

  it('按下去關掉 popover、打開右側欄的成本分頁，焦點進那個分頁而不是被還給用量鈕', async () => {
    render(
      <WithRightSidebar sources={{}}>
        <SessionUsage tokenUsage={usage} sessionStats={stats} />
      </WithRightSidebar>,
    );
    fireEvent.click(chip());
    fireEvent.click(screen.getByTestId('session-usage-detail'));
    await act(async () => {});
    expect(screen.queryByRole('dialog', { name: '這條對話的用量明細' })).toBeNull();
    const tab = screen.getByRole('tab', { name: '成本' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab);
    expect(screen.getByTestId('right-sidebar-panel-cost').textContent).toBe('尚無資料');
  });
});
