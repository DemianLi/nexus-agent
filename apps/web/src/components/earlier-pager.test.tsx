import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EarlierPager, LOAD_EARLIER_LABEL } from '@/components/earlier-pager';

afterEach(cleanup);

describe('往前翻的鈕（#2009）', () => {
  it('讀取中再按不會再拉一次（瀏覽器把 Enter、Space 轉成 click，所以只驗 click）', () => {
    const onLoad = vi.fn();
    const onArm = vi.fn();
    render(<EarlierPager earlier={{ hasMore: true, loading: true, onLoad }} onArm={onArm} />);
    const button = screen.getByRole('button', { name: LOAD_EARLIER_LABEL });
    fireEvent.click(button);
    expect(onLoad).not.toHaveBeenCalled();
  });

  it('待命時按一次拉一次；聚焦時把鈕交給呼叫端', () => {
    const onLoad = vi.fn();
    const onArm = vi.fn();
    render(<EarlierPager earlier={{ hasMore: true, loading: false, onLoad }} onArm={onArm} />);
    const button = screen.getByRole('button', { name: LOAD_EARLIER_LABEL });
    fireEvent.click(button);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onArm).not.toHaveBeenCalled();
    button.focus();
    expect(onArm).toHaveBeenCalledExactlyOnceWith(button);
  });
});
