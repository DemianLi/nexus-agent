import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  COLLAPSED_COUNT,
  DELIVERABLE_ACTIONS,
  DELIVERABLE_ROW,
  DeliverablesCard,
  fallbackDescription,
} from '@/components/deliverable/card';
import { Control, type RightSidebarControl } from '@/components/sidebar/right-sidebar-context';
import type { LocatedFile } from '@/lib/deliverables-view';
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

/**
 * **座標由這裡補，呼叫點不寫**（#452）：這幾條測的是卡片怎麼畫，跟讀檔路由無關。同一份清單裡 `index`
 * 遞增、`seq` 固定，剛好是「一顆事件宣告了這幾個檔」的形狀。要驗座標本身的是
 * `lib/deliverables-view.test.tsx`（合併之後每群檔案帶回自己那顆事件的 `seq`）。
 */
function located(files: readonly { path: string; description?: string }[]): LocatedFile[] {
  return files.map((file, index) => ({ ...file, seq: 0, index }));
}

const REPORT = { path: 'out/report.pdf', description: '季報' };
const NOTES = { path: 'notes/README' };

const rows = () => screen.getAllByTestId('deliverable');

describe('交付卡片', () => {
  it('沒有檔案就不畫', () => {
    const { container } = render(<DeliverablesCard files={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('每列是檔名、說明（沒給退回副檔名）、完整路徑', () => {
    render(<DeliverablesCard files={located([REPORT, { path: 'src/a.ts' }, NOTES])} />);
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
      render(<DeliverablesCard files={located([REPORT])} />);
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
    render(<DeliverablesCard files={located([REPORT])} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '複製路徑：out/report.pdf' }));
    });
    expect(exec).toHaveBeenCalledWith('copy');
    expect(toastSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledOnce();
  });

  it('只有一個檔不切兩欄，兩個以上才切（#1364）', () => {
    const list = () => screen.getByRole('region').querySelector('ul')!.className.split(/\s+/);
    render(<DeliverablesCard files={located([REPORT])} />);
    expect(list()).toContain('grid');
    expect(list()).not.toContain('@xl:grid-cols-2');
    cleanup();
    render(<DeliverablesCard files={located([REPORT, NOTES])} />);
    expect(list()).toContain('@xl:grid-cols-2');
  });

  it('窄列把三顆鈕移到檔名下面，寬列才放右邊；DOM 順序不跟著換（#1367）', () => {
    const classes = (s: string) => s.split(/\s+/);
    // 量的是列自己的寬，不是視窗：兩欄、375 寬時列都窄，單檔的 1024 才寬。具名容器免得被外層的 @container 截走。
    expect(classes(DELIVERABLE_ROW)).toEqual(
      expect.arrayContaining([
        'grid-cols-[auto_minmax(0,1fr)]',
        '@sm/deliverable:grid-cols-[auto_minmax(0,1fr)_auto]',
      ]),
    );
    expect(classes(DELIVERABLE_ACTIONS)).toEqual(
      expect.arrayContaining([
        'col-start-2',
        '@sm/deliverable:col-start-3',
        '@sm/deliverable:row-start-1',
      ]),
    );
    // 預覽鈕要有右側欄才畫；這裡只需要 `api.openDeliverable` 在。
    const control = { api: { openDeliverable: () => {} } } as unknown as RightSidebarControl;
    render(
      <Control.Provider value={control}>
        <DeliverablesCard files={located([REPORT])} download={{ download: vi.fn() }} />
      </Control.Provider>,
    );
    const [row] = rows();
    expect(classes(row!.className)).toContain('@container/deliverable');
    const grid = row!.firstElementChild!;
    expect(grid.className).toBe(DELIVERABLE_ROW);
    const actions = grid.lastElementChild!;
    expect(actions.className).toBe(DELIVERABLE_ACTIONS);
    // 鈕在文字後面、順序是預覽 → 下載 → 複製：Tab 走的就是這個順序。
    expect(
      within(row!)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['預覽：out/report.pdf', '下載：out/report.pdf', '複製路徑：out/report.pdf']);
    expect(within(actions as HTMLElement).getAllByRole('button')).toHaveLength(3);
  });

  it(`超過 ${COLLAPSED_COUNT} 個先收起，展開再收回`, () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.txt` }));
    render(<DeliverablesCard files={located(files)} />);
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
    render(<DeliverablesCard files={located(files)} />);
    const region = screen.getByRole('region');
    expect(within(region).queryByRole('button', { name: /顯示全部/ })).toBeNull();
  });

  it('axe：亮與暗', async () => {
    render(<DeliverablesCard files={located([REPORT, NOTES])} />);
    expect(await axeViolations(document.body)).toEqual([]);
    document.documentElement.classList.add('dark');
    expect(await axeViolations(document.body)).toEqual([]);
  });
});
