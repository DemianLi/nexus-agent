import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Composer } from '@/components/composer';

/** 輸入框底列的兩個槽（#723、#437；#1591 照 SG demo 分左右）：沒給就什麼都沒有。 */

afterEach(cleanup);

function Host({ footerStart, footerEnd }: { footerStart?: ReactNode; footerEnd?: ReactNode }) {
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
      {...(footerStart === undefined ? {} : { footerStart })}
      {...(footerEnd === undefined ? {} : { footerEnd })}
    />
  );
}

describe('底列的槽', () => {
  it('沒給：沒有底列', () => {
    render(<Host />);
    expect(screen.queryByTestId('seat')).toBeNull();
    expect(document.querySelector('[data-slot="composer-footer"]')).toBeNull();
  });

  // SG 的 `ComposerFooter`（#1591）：座位是送出時的設定，不是寫的內容，放在輸入框底下、框外面。左邊是助理怎麼做事（模式），
  // 右邊（`ComposerFooterEnd`）是這則訊息用什麼送（模型、推理強度、用量環）。375 寬放不放得下由 `guard/` 在真的瀏覽器裡量。
  it('給了：左右兩個槽都畫在輸入框外面的底列，右邊那個在 ComposerFooterEnd 裡', () => {
    render(
      <Host
        footerStart={<button data-testid="seat">座</button>}
        footerEnd={<button data-testid="end">尾</button>}
      />,
    );
    const seat = screen.getByTestId('seat');
    const end = screen.getByTestId('end');
    expect(seat.closest('[data-slot="composer-footer"]')).not.toBeNull();
    expect(seat.closest('[data-slot="composer"]')).toBeNull();
    expect(seat.closest('[data-slot="composer-footer-end"]')).toBeNull();
    expect(end.closest('[data-slot="composer-footer-end"]')).not.toBeNull();
  });

  it('只給右邊：照樣有底列，左邊不留空位', () => {
    render(<Host footerEnd={<button data-testid="end">尾</button>} />);
    const footer = document.querySelector('[data-slot="composer-footer"]');
    expect(footer?.children).toHaveLength(1);
    expect(footer?.firstElementChild?.getAttribute('data-slot')).toBe('composer-footer-end');
  });
});
