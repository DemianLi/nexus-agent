import type { WireLlmRetry } from '@nexus/wire';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RetryNotice } from '@/components/retry-notice';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const retry = (over: Partial<WireLlmRetry> = {}): WireLlmRetry => ({
  retryId: 'r1',
  retry: 1,
  maxRetries: 2,
  delayMs: 3000,
  code: 'TIMEOUT',
  ...over,
});

const visible = () => screen.getByTestId('llm-retry').querySelector('[aria-hidden=true]:not(svg)')!;
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('輪尾的倒數（#520）', () => {
  it('每秒往下數，走完寫「正在重試」，不倒成負的', () => {
    render(<RetryNotice retry={retry()} />);
    expect(visible().textContent).toBe('逾時，3 秒後重試（第 1／2 次）');
    advance(1000);
    expect(visible().textContent).toBe('逾時，2 秒後重試（第 1／2 次）');
    advance(1000);
    expect(visible().textContent).toBe('逾時，1 秒後重試（第 1／2 次）');
    advance(1000);
    expect(visible().textContent).toBe('逾時，正在重試（第 1／2 次）');
    advance(5000);
    expect(visible().textContent).toBe('逾時，正在重試（第 1／2 次）');
  });

  it('下一次嘗試（retry 加一）重新起算', () => {
    const view = render(<RetryNotice retry={retry()} />);
    advance(3500);
    view.rerender(<RetryNotice retry={retry({ retry: 2, delayMs: 2000 })} />);
    expect(visible().textContent).toBe('逾時，2 秒後重試（第 2／2 次）');
    advance(1000);
    expect(visible().textContent).toBe('逾時，1 秒後重試（第 2／2 次）');
  });

  it('螢幕閱讀器只唸一次不含倒數數字的那一句；倒數的字不唸', () => {
    render(<RetryNotice retry={retry()} />);
    const root = screen.getByTestId('llm-retry');
    expect(root.querySelector('.sr-only')?.textContent).toBe('逾時，正在重試（第 1／2 次）');
    advance(1000);
    expect(root.querySelector('.sr-only')?.textContent).toBe('逾時，正在重試（第 1／2 次）');
    expect(visible().getAttribute('aria-hidden')).toBe('true');
  });

  it('卸載後不再更新（沒有殘留的計時器）', () => {
    const view = render(<RetryNotice retry={retry()} />);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
