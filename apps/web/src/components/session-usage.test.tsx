import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SessionUsage } from '@/components/session-usage';
import { axeViolations } from '@/test/axe';

/**
 * 頂列那顆「這條對話的用量」（#574）。什麼時候畫、字怎麼寫驗在 `lib/session-usage-view.test.ts`；這裡只驗畫出來的。
 */

afterEach(cleanup);

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

  it('點開：累計三格加一句說明，時間三列；沒有首字延遲與輸出速度', () => {
    render(<SessionUsage tokenUsage={usage} sessionStats={stats} />);
    fireEvent.click(chip());
    const dialog = screen.getByRole('dialog', { name: '這條對話的用量明細' });
    const tokens = screen.getByTestId('session-usage-tokens');
    expect(tokens.textContent).toContain('422,195 token');
    expect(tokens.textContent).toContain('輸入412,380 token');
    expect(tokens.textContent).toContain('輸出9,815 token');
    expect(tokens.textContent).toContain('不含子代理與自動摘要');
    expect(screen.getByTestId('session-usage-time').textContent).toBe(
      '時間輪／模型呼叫4 輪／17 次模型時間2 分 13 秒工具時間38.4 秒',
    );
    expect(dialog.textContent).not.toContain('首字');
    expect(dialog.textContent).not.toContain('token/秒');
  });

  it('沒有 token：只有時間那一段，也沒有分隔線', () => {
    const { baseElement } = render(<SessionUsage tokenUsage={null} sessionStats={stats} />);
    expect(chip().textContent).toBe('4 輪／17 次');
    fireEvent.click(chip());
    expect(screen.queryByTestId('session-usage-tokens')).toBeNull();
    expect(screen.getByTestId('session-usage-time')).not.toBeNull();
    expect(baseElement.querySelector('hr')).toBeNull();
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
