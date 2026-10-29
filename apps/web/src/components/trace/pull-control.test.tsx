import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PullControl, TRACE_PULL_LABEL } from '@/components/trace/pull-control';

afterEach(cleanup);

describe('「載入這一輪的細節」的鈕（#2009）', () => {
  it('讀取中再按（點擊、Enter、Space 都送成 click）不會再拉一次', () => {
    const onPull = vi.fn();
    render(<PullControl status={{ kind: 'loading' }} onPull={onPull} />);
    const button = screen.getByRole('button', { name: TRACE_PULL_LABEL });
    fireEvent.click(button);
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyUp(button, { key: ' ' });
    expect(onPull).not.toHaveBeenCalled();
  });

  it('待命時按一次拉一次，並把鈕交給呼叫端', () => {
    const onPull = vi.fn();
    render(<PullControl status={{ kind: 'idle' }} onPull={onPull} />);
    const button = screen.getByRole('button', { name: TRACE_PULL_LABEL });
    fireEvent.click(button);
    expect(onPull).toHaveBeenCalledExactlyOnceWith(button);
  });
});
