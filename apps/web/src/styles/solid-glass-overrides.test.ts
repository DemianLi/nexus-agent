// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { readCascade } from './css-cascade';

/**
 * `solid-glass.overrides.css` 裡沒有別的測試釘住的幾條（#1512，#1468 Q8「機制類保留」）。每一條登記在
 * `vendor/solid-glass/README.md` 的「本地修改」。量的是 `index.css` 疊出來實際勝出的那一條：搬進 layer、被後面的樣式表蓋掉都會紅。
 */
const cascade = readCascade();
const OVERRIDES = 'styles/solid-glass.overrides.css';
const DOCKED = ".bg-card[data-surface='docked']";

describe('solid-glass 的本地修改：機制類', () => {
  test.each([
    ['background-color', 'var(--background)'],
    ['color', 'var(--foreground)'],
  ])(
    'body 的 %s 寫在 layer 外（SG 寫在 base layer，被帶 reset 的外殼一包就輸）',
    (property, value) => {
      expect(cascade.winner(['body'], property)).toMatchObject({
        value,
        layer: null,
        file: OVERRIDES,
      });
    },
  );

  test('color-scheme 亮暗都在 layer 外給值（SG 只給 .dark）', () => {
    expect(cascade.winner([':root'], 'color-scheme')).toMatchObject({
      value: 'light',
      layer: null,
      file: OVERRIDES,
    });
    expect(cascade.winner([':root', '.dark'], 'color-scheme')).toMatchObject({
      value: 'dark',
      layer: null,
      file: OVERRIDES,
    });
  });

  test.each([
    ['border-width', '1px'],
    ['border-color', 'var(--glass-edge)'],
    ['box-shadow', 'none'],
  ])(
    '貼在輸入框上方的卡片（docked）是平的：%s 由覆寫檔給（SG 的 .bg-card 會歸零 border、加上浮起的陰影）',
    (property, value) => {
      expect(cascade.winner(['.bg-card', DOCKED], property)).toMatchObject({
        value,
        layer: null,
        file: OVERRIDES,
      });
    },
  );

  test('「在對話裡定位」的高亮：chip 底色、跟泡泡同一階圓角', () => {
    const selector = "[data-slot='message-scroller-item'][data-located]";
    expect(cascade.value([selector], 'background-color')).toBe('var(--chip)');
    expect(cascade.value([selector], 'border-radius')).toBe('var(--radius-3xl)');
  });
});
