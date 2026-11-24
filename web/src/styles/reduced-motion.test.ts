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
      value: 'motion-fade-in 150ms cubic-bezier(0.22, 1, 0.36, 1)',
      layer: null,
      file: 'styles/solid-glass.overrides.css',
    });
  });

  test('淡入只動透明度', () => {
    const keyframes = /@keyframes motion-fade-in\s*\{([\s\S]*?)\n\}/.exec(motionCss)?.[1];
    expect(keyframes).toBeDefined();
    const properties = [...(keyframes ?? '').matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    expect(properties).toEqual(['opacity']);
  });

  test.each(CONTINUOUS)('%s：reduced-motion 下停掉', (selector) => {
    expect(cascade.value([selector], 'animation', REDUCED)).toBe('none');
  });
});

/**
 * 進出場的 `--animate-in`／`--animate-out`（#1687）：時長與曲線讀元件自己的 `duration-*`／`ease-*`，所以值要逐元素宣告在 `*` 上
 * （`motion.css` 的「進出場」那段）。fill-mode 是機制（規格 §7）：進場 `backwards`、退場 `both`。實際量到的時長由 `guard/` 量。
 */
describe('進出場的 --animate-in／--animate-out', () => {
  /** 原始檔裡值會折行，比之前把空白收成一格。 */
  const value = (selector: string, property: string, query?: typeof REDUCED) =>
    cascade.value([selector], property, query)?.replace(/\s+/g, ' ');
  const EVERY = ['*', '::before', '::after'];
  const REDUCED_EVERY = [':root:root *', ':root:root ::before', ':root:root ::after'];

  test.each(EVERY)(
    '%s 上的值讀 --tw-duration／--tw-ease，fill-mode 是 backwards／both',
    (selector) => {
      expect(value(selector, '--animate-in')).toBe(
        'enter var(--tw-animation-duration, var(--tw-duration, 150ms)) var(--tw-ease, ease) var(--tw-animation-delay, 0s) 1 normal backwards',
      );
      expect(value(selector, '--animate-out')).toBe(
        'exit var(--tw-animation-duration, var(--tw-duration, 150ms)) var(--tw-ease, ease) var(--tw-animation-delay, 0s) 1 normal both',
      );
    },
  );

  test('@theme 留同一份值（只為了讓 Tailwind 產出 var(--animate-in)）', () => {
    expect(value('@theme', '--animate-in')).toBe(value('*', '--animate-in'));
    expect(value('@theme', '--animate-out')).toBe(value('*', '--animate-out'));
  });

  test.each([':root:root', ...REDUCED_EVERY])(
    'reduced-motion 下 %s 換成只有透明度的淡入淡出，fill-mode 不變',
    (selector) => {
      expect(value(selector, '--animate-in', REDUCED)).toBe('motion-fade-in 150ms ease backwards');
      expect(value(selector, '--animate-out', REDUCED)).toBe('motion-fade-out 150ms ease both');
    },
  );
});
