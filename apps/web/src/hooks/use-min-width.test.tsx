import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { SM_BREAKPOINT, useMinWidth } from '@/hooks/use-min-width';

/** 照寬度回答 `(min-width: Npx)` 的 `matchMedia`。 */
function atWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query)?.[1];
    return {
      matches: min !== undefined && width >= Number(min),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useMinWidth', () => {
  test('Tailwind 的 sm 是 640：跟底列 `sm:inline` 的快捷鍵提示同一條線', () => {
    expect(SM_BREAKPOINT).toBe(640);
  });

  test.each([
    [375, false],
    [639, false],
    [640, true],
    [768, true],
    [1280, true],
  ])('寬 %i → 夠寬 %s', (width, wide) => {
    atWidth(width);
    expect(renderHook(() => useMinWidth(SM_BREAKPOINT)).result.current).toBe(wide);
  });

  test('第一次 render 就讀，窄視窗不先畫一格寬版', () => {
    atWidth(375);
    const seen: boolean[] = [];
    renderHook(() => {
      const wide = useMinWidth(SM_BREAKPOINT);
      seen.push(wide);
      return wide;
    });
    expect(seen[0]).toBe(false);
  });

  test('沒有 matchMedia（jsdom）時當成夠寬，不拋錯', () => {
    expect(renderHook(() => useMinWidth(SM_BREAKPOINT)).result.current).toBe(true);
  });
});
