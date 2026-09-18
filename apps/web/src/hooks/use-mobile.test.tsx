import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { useIsMobile } from '@/hooks/use-mobile';

/**
 * 斷點 1024（`.docs/web-ui-spec.md` §9）。registry 是 768，而 768 剛好是驗收寬度：改錯時 768 會顯示成桌面側欄。
 * 截圖不會讓 CI 紅，這裡釘住。
 */

/** 照寬度回答 `(max-width: Npx)` 的 `matchMedia`。 */
function atWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const max = /\(max-width:\s*(\d+)px\)/.exec(query)?.[1];
    return {
      matches: max !== undefined && width <= Number(max),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('手機與桌面的分界在 1024', () => {
  test.each([
    [375, true],
    [768, true],
    [1023, true],
    [1024, false],
    [1280, false],
  ])('寬 %i → 手機 %s', (width, mobile) => {
    atWidth(width);
    expect(renderHook(() => useIsMobile()).result.current).toBe(mobile);
  });

  test('沒有 matchMedia（jsdom）時當成桌面，不拋錯', () => {
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });

  test('sidebar.tsx 不用 md:（768）：斷點改了，CSS 那半要一起換成 lg:', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/ui/sidebar.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source.match(/(?<![\w-])md:/g) ?? []).toEqual([]);
  });
});
