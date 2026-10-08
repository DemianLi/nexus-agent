import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Composer } from '@/components/composer';

/** 輸入框底列的選擇座位槽（#723、#437）：沒給就什麼都沒有。 */

afterEach(cleanup);

function Host({ seats }: { seats?: ReactNode }) {
  return (
    <Composer
      draft=""
      onDraftChange={() => {}}
      placeholder="說點什麼…"
      canSend={false}
      onSubmit={() => {}}
      commands={[]}
      onRunCommand={() => true}
      stoppable={false}
      stopDisabled={false}
      onStop={() => {}}
      {...(seats === undefined ? {} : { seats })}
    />
  );
}

describe('seats 槽', () => {
  it('沒給：底列沒有座位，送出提示照舊整寬顯示', () => {
    render(<Host />);
    expect(screen.queryByTestId('seat')).toBeNull();
    expect(screen.getByTestId('send-hint').className).not.toContain('max-sm:hidden');
  });

  it('有座位時底列放不下就換行，沒座位時不動（375 寬最壞情況會超出框）', () => {
    const bar = () => screen.getByTestId('send-hint').parentElement!;
    const { unmount } = render(<Host />);
    expect(bar().className).not.toContain('flex-wrap');
    unmount();
    render(<Host seats={<button>座</button>} />);
    expect(bar().className).toContain('flex-wrap');
  });

  it('給了：座位畫在底列裡，窄螢幕不寫送出提示（底列塞不下）', () => {
    render(<Host seats={<button data-testid="seat">座</button>} />);
    const bar = screen.getByTestId('seat').parentElement!;
    expect(bar.contains(screen.getByTestId('send-hint'))).toBe(true);
    expect(screen.getByTestId('send-hint').className).toContain('max-sm:hidden');
  });
});
