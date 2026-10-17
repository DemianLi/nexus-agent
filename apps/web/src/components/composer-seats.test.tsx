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
  it('沒給：沒有底列', () => {
    render(<Host />);
    expect(screen.queryByTestId('seat')).toBeNull();
    expect(document.querySelector('[data-slot="composer-footer"]')).toBeNull();
  });

  // SG 的 `ComposerFooter`（#1591）：座位是送出時的設定，不是寫的內容，放在輸入框底下、框外面。375 寬放不放得下由
  // `guard/` 在真的瀏覽器裡量。
  it('給了：座位畫在輸入框外面的底列，不在輸入框裡', () => {
    render(<Host seats={<button data-testid="seat">座</button>} />);
    const seat = screen.getByTestId('seat');
    expect(seat.closest('[data-slot="composer-footer"]')).not.toBeNull();
    expect(seat.closest('[data-slot="composer"]')).toBeNull();
  });
});
