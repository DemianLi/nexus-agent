// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import { readCascade } from './css-cascade';

/**
 * reduced-motion 下 SG 的動畫（#1512，#1468 Q5：保留 ≤ 150ms 的透明度動畫）。SG 在 reduced-motion 下把進場
 * （`.animate-float-in`／`.animate-fade-in`）整個設成 `animation: none`，我們在 `solid-glass.overrides.css` 改回只有淡入；
 * 持續動畫照 SG 停掉。量的是 `index.css` 疊出來實際勝出的那一條：覆寫被搬進 layer、被後面的樣式表蓋掉、SG 升版改了選擇器，這裡會紅。
 */
const cascade = readCascade();

const REDUCED = { conditions: ['@media (prefers-reduced-motion: reduce)'] };

const ENTRANCES = ['.animate-float-in', '.animate-fade-in'];

/** SG 的持續動畫：reduced-motion 下要停。 */
const CONTINUOUS = ['.animate-dot-flash', '.status-shimmer', '.progress-glow::after'];

const motionCss = readFileSync(new URL('./motion.css', import.meta.url), 'utf8');

describe('reduced-motion 下的 SG 動畫', () => {
  test.each(ENTRANCES)('%s：沒有 reduced-motion 時是 SG 自己的進場', (selector) => {
    expect(cascade.value([selector], 'animation')).toMatch(/^sg-(float|fade)-in /);
  });

  test.each(ENTRANCES)('%s：reduced-motion 下改成短的淡入，不是 SG 的 none', (selector) => {
    expect(cascade.winner([selector], 'animation', REDUCED)).toMatchObject({
      value: 'motion-fade-in var(--duration-quick) var(--ease-smooth-out)',
      layer: null,
      file: 'styles/solid-glass.overrides.css',
    });
  });

  test('淡入只動透明度、不超過 150ms', () => {
    expect(cascade.value([':root'], '--duration-quick')).toBe('150ms');
    const keyframes = /@keyframes motion-fade-in\s*\{([\s\S]*?)\n\}/.exec(motionCss)?.[1];
    expect(keyframes).toBeDefined();
    const properties = [...(keyframes ?? '').matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(properties).toEqual(['opacity']);
  });

  test.each(CONTINUOUS)('%s：reduced-motion 下停掉', (selector) => {
    expect(cascade.value([selector], 'animation', REDUCED)).toBe('none');
  });
});
