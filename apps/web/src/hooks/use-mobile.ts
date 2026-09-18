/**
 * 來源：shadcn registry `sidebar` 帶進來的 `use-mobile`（style new-york，
 * https://ui.shadcn.com/r/styles/new-york-v4/sidebar.json），shadcn CLI 4.21.0。裝進來就是我們的原始碼。
 * 改過的地方：
 * - 斷點 768 → **1024**（`.docs/web-ui-spec.md` §9）：768 是驗收寬度，不改會顯示成桌面側欄。
 *   `components/ui/sidebar.tsx` 的 `md:` 也跟著換成 `lg:`，兩邊要一起改。
 * - 沒有 `matchMedia`（jsdom）時當成桌面，不拋錯；有的話第一次 render 就讀，不先畫一格桌面版。
 */
import * as React from 'react';

export const MOBILE_BREAKPOINT = 1024;

const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function query(): MediaQueryList | undefined {
  return typeof window.matchMedia === 'function' ? window.matchMedia(QUERY) : undefined;
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(() => query()?.matches === true);

  React.useEffect(() => {
    const mql = query();
    if (mql === undefined) {
      return;
    }
    const onChange = () => setIsMobile(mql.matches);
    mql.addEventListener('change', onChange);
    onChange();
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
