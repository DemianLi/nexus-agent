import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { EmptyHero } from '@/components/empty-hero';

afterEach(cleanup);

describe('空白畫面（#1695 E1-C）', () => {
  it('是 SG 的 Empty，標題仍是二級標題', () => {
    const { container } = render(<EmptyHero />);
    expect(container.querySelector('[data-slot="empty"]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: '今天要做什麼？' })).toBeTruthy();
  });

  it('圖示不唸、不會動', () => {
    const { container } = render(<EmptyHero />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(
      container.querySelector('[data-slot="empty-icon"] svg')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(container.querySelector('[class*="animate-"]')).toBeNull();
  });
});
