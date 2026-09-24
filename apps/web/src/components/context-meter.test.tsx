import type { WireContextPressure } from '@nexus/wire';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextMeter } from '@/components/context-meter';
import { axeViolations } from '@/test/axe';

/**
 * 輸入框底列的用量表（#528）。比例怎麼算驗在 `lib/context-meter-view.test.ts`；這裡只驗畫出來的。
 */

afterEach(cleanup);

const measure = {
  approxTokens: 5,
  messageCount: 3,
  thresholds: [
    { type: 'tokens', value: 10 },
    { type: 'messages', value: 4 },
  ],
} as const;

function meter() {
  return screen.getByTestId('context-meter');
}

describe('用量表（#528）', () => {
  it.each<[string, WireContextPressure | null]>([
    ['一顆都還沒收到', null],
    ['只有 inputTokens（摘要被關掉）', { inputTokens: 7 }],
  ])('%s：不畫', (_name, pressure) => {
    render(<ContextMeter pressure={pressure} />);
    expect(screen.queryByTestId('context-meter')).toBeNull();
  });

  it('收著：環加「約 N%」，名稱原樣帶著畫面上那串字', () => {
    render(<ContextMeter pressure={{ measure }} />);
    expect(meter().textContent).toBe('約 75%');
    const label = meter().getAttribute('aria-label') ?? '';
    expect(label).toBe('對話用量：約 75%，點開看明細');
    expect(label).toContain(meter().textContent);
    // 環填到 75%：剩下的 25% 是 offset。
    const arc = screen.getByTestId('context-meter-arc');
    const circumference = Number(arc.getAttribute('stroke-dasharray'));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.25);
    expect(arc.classList.contains('motion-progress')).toBe(true);
  });

  it('點開：兩種來源分開寫，每道門檻一行，最近那一行加粗並另有一句給報讀', () => {
    render(<ContextMeter pressure={{ measure, inputTokens: 12345 }} />);
    fireEvent.click(meter());
    const dialog = screen.getByRole('dialog', { name: '對話用量明細' });
    expect(dialog.textContent).toContain('目前大小');
    expect(screen.getByTestId('context-meter-input').textContent).toBe('12,345 token');
    expect(
      screen
        .getAllByTestId('context-meter-row')
        .map((row) => [row.textContent, row.getAttribute('data-nearest')]),
    ).toEqual([
      ['約 5／10 token', 'false'],
      ['3／4 則（最近）', 'true'],
    ]);
    const nearest = screen.getAllByTestId('context-meter-row')[1];
    expect(nearest?.classList.contains('font-medium')).toBe(true);
    expect(dialog.textContent).toContain('較早的訊息會被摘要');
  });

  it('沒收過 model/usage：沒有「目前大小」那一行', () => {
    render(<ContextMeter pressure={{ measure }} />);
    fireEvent.click(meter());
    const dialog = screen.getByRole('dialog', { name: '對話用量明細' });
    expect(screen.queryByTestId('context-meter-input')).toBeNull();
    expect(dialog.textContent).not.toContain('目前大小');
    expect(dialog.textContent).not.toContain('undefined');
  });

  it('80% 以上變警示色，以下是中性色', () => {
    const at = (messageCount: number) =>
      ({
        measure: { approxTokens: 0, messageCount, thresholds: [{ type: 'messages', value: 10 }] },
      }) satisfies WireContextPressure;
    const { rerender } = render(<ContextMeter pressure={at(7)} />);
    expect(meter().classList.contains('text-warning')).toBe(false);
    expect(meter().classList.contains('text-muted-foreground')).toBe(true);
    rerender(<ContextMeter pressure={at(8)} />);
    expect(meter().classList.contains('text-warning')).toBe(true);
    expect(meter().classList.contains('text-muted-foreground')).toBe(false);
  });

  it('更新時不唸：沒有 role="status"，也沒有 aria-live', () => {
    const { baseElement } = render(<ContextMeter pressure={{ measure, inputTokens: 1 }} />);
    fireEvent.click(meter());
    expect(baseElement.querySelector('[role="status"]')).toBeNull();
    expect(baseElement.querySelector('[aria-live]')).toBeNull();
  });

  it('hidden 時明細跟著關，回來時不自己打開', () => {
    const { rerender } = render(<ContextMeter pressure={{ measure }} />);
    fireEvent.click(meter());
    expect(screen.queryByRole('dialog')).not.toBeNull();
    rerender(<ContextMeter pressure={{ measure }} hidden />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<ContextMeter pressure={{ measure }} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('axe：收著與點開都沒有違規', async () => {
    const { baseElement } = render(<ContextMeter pressure={{ measure, inputTokens: 1 }} />);
    expect(await axeViolations(baseElement)).toEqual([]);
    fireEvent.click(meter());
    expect(await axeViolations(baseElement)).toEqual([]);
  });
});
