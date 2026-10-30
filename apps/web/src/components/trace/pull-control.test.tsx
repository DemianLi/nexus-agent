import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PullControl, TRACE_PULL_LABEL } from '@/components/trace/pull-control';

afterEach(cleanup);

describe('「載入這一輪的細節」的鈕（#2009）', () => {
  it('讀取中再按不會再拉一次（瀏覽器把 Enter、Space 轉成 click，所以只驗 click）', () => {
    const onPull = vi.fn();
    render(<PullControl status={{ kind: 'loading' }} onPull={onPull} />);
    const button = screen.getByRole('button', { name: TRACE_PULL_LABEL });
    fireEvent.click(button);
    expect(onPull).not.toHaveBeenCalled();
  });

  it('待命時按一次拉一次；聚焦時把鈕交給呼叫端', () => {
    const onPull = vi.fn();
    const onArm = vi.fn();
    render(<PullControl status={{ kind: 'idle' }} onPull={onPull} onArm={onArm} />);
    const button = screen.getByRole('button', { name: TRACE_PULL_LABEL });
    fireEvent.click(button);
    expect(onPull).toHaveBeenCalledOnce();
    expect(onArm).not.toHaveBeenCalled();
    button.focus();
    expect(onArm).toHaveBeenCalledExactlyOnceWith(button);
  });
});
