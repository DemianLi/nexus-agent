import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TurnHeader } from '@/components/trace/turn-head';
import type { TurnHead } from '@/lib/trace-view';

/** 一輪標頭的狀態膠囊（#1690 T8）：哪種收法上哪種色調、圓點畫不畫，以及事實那一行不再重複狀態字。整頁的行為驗在 `panel.*.test.tsx`。 */

const head = (patch: Partial<TurnHead> = {}): TurnHead => ({
  number: 7,
  kind: 'message',
  time: 0,
  durationMs: 2500,
  callCount: 2,
  toolCount: 3,
  toolErrors: 0,
  subagentCount: 0,
  retryCount: 0,
  inputTokens: 200,
  outputTokens: 20,
  ...patch,
});

afterEach(cleanup);

describe('一輪標頭的狀態膠囊', () => {
  it.each([
    ['完成', head({ end: 'completed' }), 'done', '完成'],
    ['停在核准點', head({ end: 'completed', waiting: 'approval' }), 'waiting', '停在核准點'],
    ['停在提問', head({ waiting: 'question' }), 'waiting', '停在提問'],
    ['失敗', head({ end: 'failed', failureCode: 'quota_exceeded' }), 'failed', '失敗（'],
    ['進行中', head(), 'running', '進行中'],
    ['已停止', head({ end: 'aborted' }), 'neutral', '已停止'],
    ['意外中斷', head({ end: 'interrupted' }), 'neutral', '意外中斷'],
    ['輸出上限', head({ end: 'max-tokens' }), 'neutral', '輸出上限'],
    ['已擋下', head({ end: 'blocked' }), 'neutral', '已擋下'],
  ] as const)('%s：色是 %s，膠囊上有字', (_name, value, tone, text) => {
    render(<TurnHeader head={value} />);
    const pill = screen.getByTestId('trace-head-status');
    expect(pill.getAttribute('data-tone')).toBe(tone);
    expect(pill.textContent).toContain(text);
  });

  it('狀態只寫在膠囊裡：事實那一行有耗時，沒有狀態字', () => {
    render(<TurnHeader head={head({ end: 'completed' })} />);
    const facts = screen.getByTestId('trace-turn-head').querySelector('p')!;
    expect(facts.textContent).toContain('耗時');
    expect(facts.textContent).not.toContain('完成');
  });

  it.each([
    ['完成', head({ end: 'completed' }), 'bg-status-done'],
    ['停在核准點', head({ waiting: 'approval' }), 'bg-status-interrupted'],
    ['停在提問', head({ waiting: 'question' }), 'bg-status-interrupted'],
  ] as const)('%s：色調畫在字前面的圓點上（%s）', (_name, value, color) => {
    render(<TurnHeader head={value} />);
    expect(screen.getByTestId('trace-head-dot').classList.contains(color)).toBe(true);
  });

  it.each([
    ['失敗', head({ end: 'failed' })],
    ['進行中', head()],
    ['已停止', head({ end: 'aborted' })],
  ] as const)('%s：沒有圓點', (_name, value) => {
    render(<TurnHeader head={value} />);
    expect(screen.queryByTestId('trace-head-dot')).toBeNull();
  });

  it('進行中的膠囊帶 DotLoader；其餘沒有', () => {
    const { unmount } = render(<TurnHeader head={head()} />);
    expect(
      screen.getByTestId('trace-head-status').querySelector('.animate-dot-flash'),
    ).not.toBeNull();
    unmount();
    render(<TurnHeader head={head({ end: 'completed' })} />);
    expect(screen.getByTestId('trace-head-status').querySelector('.animate-dot-flash')).toBeNull();
  });
});
