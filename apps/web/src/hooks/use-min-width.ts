/**
 * 視窗至少多寬（`matchMedia` 的 `min-width`）。給 CSS 表達不出來的地方用：`placeholder` 是屬性，不能像
 * 底列的快捷鍵提示那樣用 `hidden sm:inline` 藏起來（#710）。
 *
 * 沒有 `matchMedia`（jsdom）時當成夠寬，不拋錯；有的話第一次 render 就讀，不先畫一格寬版。
 */
import * as React from 'react';

/** Tailwind 的 `sm`：底列「⌘Enter 插話」那一段從這裡起才畫（`components/composer.tsx` 的 `sm:inline`）。 */
export const SM_BREAKPOINT = 640;

function query(width: number): MediaQueryList | undefined {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(`(min-width: ${width}px)`)
    : undefined;
}

export function useMinWidth(width: number): boolean {
  const [wide, setWide] = React.useState(() => query(width)?.matches !== false);

  React.useEffect(() => {
    const mql = query(width);
    if (mql === undefined) return;
    const onChange = () => setWide(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, [width]);

  return wide;
}
