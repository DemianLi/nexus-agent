/**
 * nexus 層（#1684）：轉出 vendor 的 solid-glass 版（`vendor/solid-glass/components/ui/status-glyph.tsx`），外觀照 SG（#1468 Q8）。
 * 它是 `turn-status.tsx` 的依賴（vendor 那份 import `@/components/ui/status-glyph`，解析到這一層），所以一起 vendor 進來。
 * 本地修改登記在 `vendor/solid-glass/README.md` 的「本地修改」：
 *
 * - vendor 檔有一條 patch（第 71 條，`0022` strict-index）：nexus 的 `noUncheckedIndexedAccess` 下補非空斷言。
 * - 這一層（第 73 條）：沒有 `window.matchMedia` 或 `IntersectionObserver` 的環境（jsdom）不畫 glyph、回 `null`。vendor 的 effect
 *   直接呼叫這兩個，沒有就拋。glyph 是 `aria-hidden` 的裝飾、旁邊有字，不畫不丟資訊（同第 50 條 sonner、`sent-attachments.tsx`）。
 *   要量真 glyph 的測試自己 `vi.stubGlobal`，不加全域 setupFiles（`sonner.test.tsx` 斷言 jsdom 沒有 `matchMedia`）。
 */
import type * as React from 'react';

import { StatusGlyph as VendorStatusGlyph } from '@/vendor/solid-glass/components/ui/status-glyph';

export {
  type Activity,
  type Dot,
  type Figure,
  RollingNumber,
  STATUS_FIGURES,
} from '@/vendor/solid-glass/components/ui/status-glyph';

/** 這個環境畫得出 glyph：vendor 的 effect 要用到的兩個 API 都在。 */
function canAnimate(): boolean {
  return typeof window.matchMedia === 'function' && typeof IntersectionObserver !== 'undefined';
}

function StatusGlyph(props: React.ComponentProps<typeof VendorStatusGlyph>) {
  if (!canAnimate()) return null;
  return <VendorStatusGlyph {...props} />;
}

export { StatusGlyph };
