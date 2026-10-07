import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { RowTrigger } from '@/components/row-trigger';
import { Collapsible } from '@/components/ui/collapsible';

afterEach(cleanup);

function renderRow(props: { className?: string; disabled?: boolean }) {
  render(
    <Collapsible>
      <RowTrigger {...props}>列</RowTrigger>
    </Collapsible>,
  );
  return screen.getByRole('button', { name: '列' });
}

describe('RowTrigger（可展開列的共用觸發鈕）', () => {
  it('帶著共通的底色、最小高度、圓角與過渡；呼叫端補的 class 接在後面', () => {
    const el = renderRow({ className: 'gap-2 text-tip' });
    const classes = el.className.split(/\s+/);
    for (const c of [
      'group',
      'hover:bg-chip-hover',
      'min-h-11',
      'rounded-row',
      'gap-2',
      'text-tip',
    ]) {
      expect(classes).toContain(c);
    }
  });

  it('沒補 class 也不會多出 "undefined"，其餘屬性（disabled）照傳給 Collapsible 觸發鈕', () => {
    const el = renderRow({ disabled: true }) as HTMLButtonElement;
    expect(el.className).not.toMatch(/undefined/);
    expect(el.disabled).toBe(true);
    expect(el.getAttribute('data-slot')).toBe('collapsible-trigger');
  });
});
