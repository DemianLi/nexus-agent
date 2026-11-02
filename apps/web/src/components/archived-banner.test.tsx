import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ArchivedBanner } from '@/components/archived-banner';

afterEach(cleanup);

describe('ArchivedBanner（#633）', () => {
  it('講「此會話已封存」，按「取消封存」呼叫一次、等回來之前按鈕停用', async () => {
    let resolve!: (value: string | undefined) => void;
    const onRestore = vi.fn(() => new Promise<string | undefined>((r) => (resolve = r)));
    render(<ArchivedBanner onRestore={onRestore} />);
    expect(screen.getByText('此會話已封存')).toBeTruthy();
    const button = screen.getByRole('button', { name: '取消封存' }) as HTMLButtonElement;
    fireEvent.click(button);
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    resolve(undefined);
    await waitFor(() => expect(button.disabled).toBe(false));
  });

  it('失敗時講出原因（toast 之外按鈕恢復可再按）', async () => {
    const onRestore = vi.fn(async () => '找不到這條會話（可能已經被刪掉）。');
    render(<ArchivedBanner onRestore={onRestore} />);
    const button = screen.getByRole('button', { name: '取消封存' }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });
});
