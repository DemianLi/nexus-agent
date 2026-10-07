import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Surface } from '@/components/surface';

afterEach(cleanup);

const classes = (el: Element | null) => (el?.className ?? '').split(/\s+/).filter(Boolean).sort();

describe('Surface（卡片與內層 stage 的共用底）', () => {
  it('stage：內層底；呼叫端補的 class 接在後面，其餘屬性照傳', () => {
    const { container } = render(
      <Surface tone="stage" className="p-3 text-body" data-testid="s" aria-label="清單">
        內容
      </Surface>,
    );
    const el = container.firstElementChild;
    expect(classes(el)).toEqual(
      ['bg-stage', 'shadow-stage', 'rounded-xl', 'p-3', 'text-body'].sort(),
    );
    expect(el?.tagName).toBe('DIV');
    expect(el?.getAttribute('data-testid')).toBe('s');
    expect(el?.getAttribute('aria-label')).toBe('清單');
  });

  it('raised：浮起來的卡片，圓角 3xl、內距 1', () => {
    const { container } = render(
      <Surface tone="raised" className="border-beam">
        內容
      </Surface>,
    );
    expect(classes(container.firstElementChild)).toEqual(
      ['bg-card', 'shadow-material', 'rounded-3xl', 'p-1', 'border-beam'].sort(),
    );
  });

  it('as 選元素：ul／li／section／pre', () => {
    for (const tag of ['ul', 'ol', 'li', 'section', 'p', 'pre'] as const) {
      const { container, unmount } = render(
        <Surface as={tag} tone="stage">
          x
        </Surface>,
      );
      expect(container.firstElementChild?.tagName).toBe(tag.toUpperCase());
      unmount();
    }
  });

  it('呼叫端的 class 與底撞到時呼叫端贏（用 cn 合併）', () => {
    const { container } = render(
      <Surface tone="raised" className="p-3 rounded-2xl">
        x
      </Surface>,
    );
    const c = classes(container.firstElementChild);
    expect(c).toContain('p-3');
    expect(c).not.toContain('p-1');
    expect(c).toContain('rounded-2xl');
    expect(c).not.toContain('rounded-3xl');
  });
});
