import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COLLAPSED_COUNT,
  DeliverablesCard,
  fallbackDescription,
} from '@/components/deliverables-card';
import type { PresentedFile } from '@/lib/present-view';
import { axeViolations } from '@/test/axe';

const toastSpy = vi.hoisted(() => {
  const spy = vi.fn() as ReturnType<typeof vi.fn> & { error: ReturnType<typeof vi.fn> };
  spy.error = vi.fn();
  return spy;
});
vi.mock('sonner', () => ({ toast: toastSpy }));

/** 交付卡片（#441 第二刀）：檔名、說明、完整路徑、複製路徑；超過四個先收起。 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastSpy.mockReset();
  toastSpy.error.mockReset();
  document.documentElement.classList.remove('dark');
});

const REPORT: PresentedFile = { path: 'out/report.pdf', description: '季報' };
const NOTES: PresentedFile = { path: 'notes/README' };

const rows = () => screen.getAllByTestId('deliverable');

describe('交付卡片', () => {
  it('沒有檔案就不畫', () => {
    const { container } = render(<DeliverablesCard files={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('每列是檔名、說明（沒給退回副檔名）、完整路徑', () => {
    render(<DeliverablesCard files={[REPORT, { path: 'src/a.ts' }, NOTES]} />);
    expect(screen.getByRole('region', { name: '這一輪交付的檔案，共 3 個' })).toBeTruthy();
    expect(rows().map((row) => row.textContent)).toEqual([
      'report.pdf季報out/report.pdf',
      'a.tsTS 檔src/a.ts',
      'README檔案notes/README',
    ]);
  });

  it('副檔名的退路：點開頭的隱藏檔、結尾的點都不算副檔名', () => {
    expect(fallbackDescription('a/b/.env')).toBe('檔案');
    expect(fallbackDescription('dist/build.')).toBe('檔案');
    expect(fallbackDescription('C:\\x\\data.csv')).toBe('CSV 檔');
  });

  it('按「複製路徑」寫進剪貼簿的是完整路徑，勾勾 1.5 秒後退回', async () => {
    vi.useFakeTimers();
    try {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
      vi.stubGlobal('isSecureContext', true);
      render(<DeliverablesCard files={[REPORT]} />);
      const button = screen.getByRole('button', { name: '複製路徑：out/report.pdf' });
      await act(async () => {
        fireEvent.click(button);
      });
      expect(writeText).toHaveBeenCalledWith('out/report.pdf');
      expect(toastSpy).toHaveBeenCalledWith('已複製路徑', { description: 'out/report.pdf' });
      expect(button.querySelector('.lucide-check')).not.toBeNull();
      act(() => vi.advanceTimersByTime(1500));
      expect(button.querySelector('.lucide-copy')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('非安全來源沒有 clipboard 時退回 execCommand；也失敗就講一聲', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    const exec = vi.fn().mockReturnValue(false);
    document.execCommand = exec;
    render(<DeliverablesCard files={[REPORT]} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '複製路徑：out/report.pdf' }));
    });
    expect(exec).toHaveBeenCalledWith('copy');
    expect(toastSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledOnce();
  });

  it(`超過 ${COLLAPSED_COUNT} 個先收起，展開再收回`, () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.txt` }));
    render(<DeliverablesCard files={files} />);
    expect(rows()).toHaveLength(COLLAPSED_COUNT);
    const toggle = screen.getByRole('button', { name: /顯示全部 6 個/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(rows()).toHaveLength(6);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: /收起/ }));
    expect(rows()).toHaveLength(COLLAPSED_COUNT);
  });

  it(`剛好 ${COLLAPSED_COUNT} 個不給切換鈕`, () => {
    const files = Array.from({ length: COLLAPSED_COUNT }, (_, i) => ({ path: `f${i}.txt` }));
    render(<DeliverablesCard files={files} />);
    const region = screen.getByRole('region');
    expect(within(region).queryByRole('button', { name: /顯示全部/ })).toBeNull();
  });

  it('axe：亮與暗', async () => {
    render(<DeliverablesCard files={[REPORT, NOTES]} />);
    expect(await axeViolations(document.body)).toEqual([]);
    document.documentElement.classList.add('dark');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
