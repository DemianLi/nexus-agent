import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page } from 'playwright-core';
import { expect } from 'vitest';

/**
 * 設了 `NEXUS_E2E_SHOTS=<目錄>` 才存截圖，存成 `<目錄>/<name>.png`；沒設就什麼都不做。
 * 設了的時候，會結束的動畫 1 秒內（`expect.poll` 預設）沒跑完就拋；沒設的那一輪不會因此紅。
 *
 * @param host - 等哪裡的動畫跑完：給元素的選擇器就看它的 shadow root（例如 `nexus-chat`），找不到元素就不等；
 *   不給就看 `document.getAnimations()`（不含任何 shadow root 裡的）。
 */
export async function shot(page: Page, name: string, host?: string): Promise<void> {
  const dir = process.env.NEXUS_E2E_SHOTS;
  if (dir === undefined) return;
  await mkdir(dir, { recursive: true });
  // 等亮暗切換、面板進場這些轉場跑完，不截到中間那一格。無限循環的（shimmer、轉圈）與跟著捲動走的（捲動區邊緣的淡出）永遠不會結束，不算。
  await expect
    .poll(() =>
      page.evaluate(
        (selector) =>
          (
            (selector === undefined
              ? document
              : document.querySelector(selector)?.shadowRoot
            )?.getAnimations() ?? []
          ).filter(
            (animation) =>
              animation.playState === 'running' &&
              animation.timeline instanceof DocumentTimeline &&
              animation.effect?.getTiming().iterations !== Infinity,
          ).length,
        host,
      ),
    )
    .toBe(0);
  await page.screenshot({ path: join(dir, `${name}.png`) });
}
