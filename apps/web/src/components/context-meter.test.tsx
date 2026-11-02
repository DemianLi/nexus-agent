import type { WireContextPressure } from '@nexus/wire';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ContextMeter } from '@/components/context-meter';
import { BREAKDOWN_OVER_TEXT } from '@/lib/context-meter-view';
import { axeViolations } from '@/test/axe';

/**
 * 輸入框底列的用量環（#528；#1591 換成 SG 的 `ContextRing`）。比例怎麼算驗在 `lib/context-meter-view.test.ts`；這裡只驗
 * 畫出來的。SG 的環收著時沒有字，所以「約 N%」只在名稱與明細裡。
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

/** 環的 Trigger（SG 的 `data-slot="context-ring"`）。 */
function meter() {
  const ring = screen.getByTestId('context-meter').querySelector('[data-slot="context-ring"]');
  if (!(ring instanceof HTMLElement)) throw new Error('找不到環');
  return ring;
}

/** 弧：SG 畫兩個圓，第二個是填色的那段。 */
function arc() {
  const circles = meter().querySelectorAll('circle');
  return circles[circles.length - 1];
}

const AROUND = 2 * Math.PI * 6;

describe('組成三行（#1571 N1193）', () => {
  const parts = () => screen.getAllByTestId('context-meter-part').map((row) => row.textContent);

  it('有 breakdown：三行都在，順序是系統提示、工具定義、對話', () => {
    const breakdown = { systemTokens: 1200, toolsTokens: 3400, messageTokens: 900 };
    render(<ContextMeter pressure={{ measure: { ...measure, approxTokens: 5500, breakdown } }} />);
    fireEvent.click(meter());
    expect(parts()).toEqual(['系統提示約 1.2k', '工具定義約 3.4k', '對話約 900']);
    expect(screen.getByTestId('context-meter-breakdown').textContent).not.toContain(
      BREAKDOWN_OVER_TEXT,
    );
  });

  it('沒有 breakdown：整段不在（舊日誌），不是三個 0', () => {
    render(<ContextMeter pressure={{ measure }} />);
    fireEvent.click(meter());
    expect(screen.queryByTestId('context-meter-breakdown')).toBeNull();
  });

  it('系統加工具比總數大：對話是 0，說明三行相加不等於總數', () => {
    const breakdown = { systemTokens: 4, toolsTokens: 3, messageTokens: 0 };
    render(<ContextMeter pressure={{ measure: { ...measure, breakdown } }} />);
    fireEvent.click(meter());
    expect(parts()).toEqual(['系統提示約 4', '工具定義約 3', '對話約 0']);
    expect(screen.getByTestId('context-meter-breakdown').textContent).toContain(
      BREAKDOWN_OVER_TEXT,
    );
  });
});

describe('用量表（#528）', () => {
  it.each<[string, WireContextPressure | null]>([
    ['一顆都還沒收到', null],
    ['只有 inputTokens（摘要被關掉）', { inputTokens: 7 }],
  ])('%s：不畫', (_name, pressure) => {
    render(<ContextMeter pressure={pressure} />);
    expect(screen.queryByTestId('context-meter')).toBeNull();
  });

  it('收著：只有環，名稱是「對話用量：約 N%，點開看明細」（README 本地修改第 34 條，patch `0008` 的 `label`）', () => {
    render(<ContextMeter pressure={{ measure }} />);
    expect(screen.getByRole('button', { name: '對話用量：約 75%，點開看明細' })).toBe(meter());
    expect(meter().textContent).toBe('');
    // 環填到 75%：SG 的弧長寫成 dasharray 的第一段。
    const [filled] = (arc()?.getAttribute('stroke-dasharray') ?? '').split(' ');
    expect(Number(filled)).toBeCloseTo(AROUND * 0.75);
  });

  it('弧長照無條件捨去的百分比走：75.5% 畫成 75%，SG 的 Math.round 不出現在名稱裡', () => {
    render(
      <ContextMeter
        pressure={{
          measure: {
            approxTokens: 755,
            messageCount: 0,
            thresholds: [{ type: 'tokens', value: 1000 }],
          },
        }}
      />,
    );
    const [filled] = (arc()?.getAttribute('stroke-dasharray') ?? '').split(' ');
    expect(Number(filled)).toBeCloseTo(AROUND * 0.75);
    expect(meter().getAttribute('aria-label')).toBe('對話用量：約 75%，點開看明細');
  });

  it('點開：兩種來源分開寫，每道門檻一行，最近那一行加粗並另有一句給報讀', () => {
    render(<ContextMeter pressure={{ measure, inputTokens: 12345 }} />);
    fireEvent.click(meter());
    const dialog = screen.getByRole('dialog', { name: '對話用量' });
    expect(screen.getByTestId('context-meter-percent').textContent).toBe('約 75%');
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
    const dialog = screen.getByRole('dialog', { name: '對話用量' });
    expect(screen.queryByTestId('context-meter-input')).toBeNull();
    expect(dialog.textContent).not.toContain('目前大小');
    expect(dialog.textContent).not.toContain('undefined');
  });

  it('色階照 SG：70% 以下藍、70% 起琥珀、90% 起 destructive（顏色本身在覆寫檔壓回 token，guard 量）', () => {
    const at = (messageCount: number) =>
      ({
        measure: { approxTokens: 0, messageCount, thresholds: [{ type: 'messages', value: 100 }] },
      }) satisfies WireContextPressure;
    const tone = () => meter().querySelector('svg')?.getAttribute('class') ?? '';
    const { rerender } = render(<ContextMeter pressure={at(69)} />);
    expect(tone()).toContain('text-blue-500');
    rerender(<ContextMeter pressure={at(70)} />);
    expect(tone()).toContain('text-amber-500');
    rerender(<ContextMeter pressure={at(90)} />);
    expect(tone()).toContain('text-destructive');
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
    expect(screen.queryByTestId('context-meter')).toBeNull();
    rerender(<ContextMeter pressure={{ measure }} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('不會觸發的門檻（#1444）：照列、次要色、下面一行小字，不是最近；報讀兩句一起唸；底下那句改說法', () => {
    render(
      <ContextMeter
        pressure={{
          measure: {
            approxTokens: 30_000,
            messageCount: 70,
            thresholds: [
              { type: 'tokens', value: 100_000 },
              { type: 'messages', value: 60 },
            ],
            messagesCompactable: false,
          },
        }}
      />,
    );
    expect(meter().getAttribute('aria-label')).toBe('對話用量：約 30%，點開看明細');
    fireEvent.click(meter());
    const [tokens, messages] = screen.getAllByTestId('context-meter-row');
    expect(tokens?.getAttribute('data-nearest')).toBe('true');
    expect(messages?.getAttribute('data-nearest')).toBe('false');
    expect(messages?.getAttribute('data-dormant')).toBe('true');
    expect(messages?.classList.contains('text-muted-foreground')).toBe(true);
    expect(messages?.classList.contains('font-medium')).toBe(false);
    expect(messages?.classList.contains('line-through')).toBe(false);
    expect(messages?.textContent).toBe('70／60 則，整串都在原樣保留的範圍內，這道目前不會觸發');
    expect(screen.getByTestId('context-meter-dormant').classList.contains('text-tip')).toBe(true);
    expect(tokens?.querySelector('[data-testid="context-meter-dormant"]')).toBeNull();
    expect(screen.getByTestId('context-meter-note').textContent).toBe(
      '到了會觸發的門檻，較早的訊息會被摘要成一段。比例是估算的。',
    );
  });

  it('axe：收著與點開都沒有違規', async () => {
    const { baseElement, rerender } = render(
      <ContextMeter pressure={{ measure, inputTokens: 1 }} />,
    );
    expect(await axeViolations(baseElement)).toEqual([]);
    fireEvent.click(meter());
    expect(await axeViolations(baseElement)).toEqual([]);
    // 有不會觸發的那一行（#1444）。
    rerender(
      <ContextMeter
        pressure={{ measure: { ...measure, messagesCompactable: false }, inputTokens: 1 }}
      />,
    );
    expect(screen.getByTestId('context-meter-dormant')).not.toBeNull();
    expect(await axeViolations(baseElement)).toEqual([]);
  });
});
