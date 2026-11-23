import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { StatusGlyph } from '@/components/ui/status-glyph';
import { drawnPose, openingPose, stubGlyphEnvironment } from '@/test/glyph-env';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * SG 的 StatusGlyph（#1684）。vendor 檔套了 strict-index 的 patch（第 71 條，拿掉時 `pnpm typecheck` 紅），
 * nexus 層在畫不出來的環境回 `null`（第 73 條）。動畫本身（平常在動、減少動態停在起始姿勢、換 activity）在 `guard/` 用真 Chrome 量。
 */

describe('nexus 層：沒有 matchMedia／IntersectionObserver 就不畫（第 73 條）', () => {
  test('jsdom 原樣：不拋錯、沒有 glyph', () => {
    expect(typeof window.matchMedia).toBe('undefined');
    const { container } = render(<StatusGlyph activity="running" />);
    expect(container.querySelector('[data-slot="status-glyph"]')).toBeNull();
  });

  test('只有其中一個也不畫', () => {
    stubGlyphEnvironment();
    vi.stubGlobal('IntersectionObserver', undefined);
    const { container } = render(<StatusGlyph activity="running" />);
    expect(container.querySelector('[data-slot="status-glyph"]')).toBeNull();
  });

  test('兩個都在：畫出 vendor 的 glyph，aria-hidden，停在起始姿勢（替身回報減少動態）', () => {
    stubGlyphEnvironment();
    const { container } = render(<StatusGlyph activity="running" />);
    const svg = container.querySelector('[data-slot="status-glyph"]');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(drawnPose(container)).toEqual(openingPose('running'));
  });
});
