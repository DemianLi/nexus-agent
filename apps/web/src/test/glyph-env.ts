import { vi } from 'vitest';

import { type Activity, STATUS_FIGURES } from '@/components/ui/status-glyph';

/**
 * 讓 jsdom 畫得出 SG 的 `StatusGlyph`（#1684）：它的 effect 要 `window.matchMedia` 與 `IntersectionObserver`，jsdom 兩個都沒有，
 * nexus 層因此不畫（`components/ui/status-glyph.tsx`）。要量真 glyph 的測試呼叫這一支，`vi.unstubAllGlobals()` 收掉。
 *
 * - `matchMedia` 一律回「減少動態」：glyph 不排 rAF、直接畫每個圖形的起始姿勢，測試讀得到確定的 `cx`／`cy`／`r`／`opacity`。
 * - `IntersectionObserver` 在 `observe` 當下就回報「看得見」：glyph 看不見時什麼都不畫（`refresh` 直接 return），
 *   不回報的話 circle 停在 `CORNERS` 的初始值，比到的不是起始姿勢。
 * - vendor 卸載時會呼叫 `removeEventListener`、`disconnect`、`takeRecords`，替身都要有。
 */
export function stubGlyphEnvironment(): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.callback(
          [{ isIntersecting: true, target } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
      takeRecords() {
        return [];
      }
      unobserve() {}
    },
  );
}

/**
 * vendor 的 `RADIUS`（`status-glyph.tsx` 裡的 `const RADIUS = 1.7`，沒有 export）。vendor 升版改了它，
 * `registry-edits.test.ts` 那條紅；`guard/main.tsx` 的 `__openingPose` 也寫同一個數。
 */
export const GLYPH_RADIUS = 1.7;

/** glyph 每個 circle 畫的四個屬性（同 `scripts/measure-frames.mjs`）：只比 `cx`／`cy` 的話，`r` 與 `opacity` 畫錯也綠。 */
export const POSE_ATTRIBUTES = ['cx', 'cy', 'r', 'opacity'] as const;

/** 一種 activity 的起始姿勢，照 vendor `draw` 的寫法取到小數兩位：`[[cx, cy, r, opacity], …]`。 */
export function openingPose(activity: Activity): string[][] {
  const first = STATUS_FIGURES.find((entry) => entry.activity === activity);
  if (first === undefined) throw new Error(`STATUS_FIGURES 裡沒有 ${activity}`);
  return first
    .figure(0)
    .map((dot) => [
      dot.x.toFixed(2),
      dot.y.toFixed(2),
      (GLYPH_RADIUS * dot.s).toFixed(2),
      Math.max(0, Math.min(1, dot.o)).toFixed(2),
    ]);
}

/** 畫出來的三個 circle 的 `[[cx, cy, r, opacity], …]`。 */
export function drawnPose(root: ParentNode): string[][] {
  return [...root.querySelectorAll('[data-slot="status-glyph"] circle')].map((circle) =>
    POSE_ATTRIBUTES.map((name) => circle.getAttribute(name) ?? ''),
  );
}
