import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EarlierPager, LOAD_EARLIER_LABEL } from '@/components/earlier-pager';

afterEach(cleanup);

describe('往前翻的鈕（#2009）', () => {
  it('讀取中再按（點擊、Enter、Space 都送成 click）不會再拉一次', () => {
    const onLoad = vi.fn();
    const onPress = vi.fn();
    render(<EarlierPager earlier={{ hasMore: true, loading: true, onLoad }} onPress={onPress} />);
    const button = screen.getByRole('button', { name: LOAD_EARLIER_LABEL });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyUp(button, { key: ' ' });
    expect(onLoad).not.toHaveBeenCalled();
    expect(onPress).not.toHaveBeenCalled();
  });

  it('待命時按一次拉一次，並把鈕交給呼叫端', () => {
    const onLoad = vi.fn();
    const onPress = vi.fn();
    render(<EarlierPager earlier={{ hasMore: true, loading: false, onLoad }} onPress={onPress} />);
    const button = screen.getByRole('button', { name: LOAD_EARLIER_LABEL });
    fireEvent.click(button);
    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledWith(button);
  });
});
