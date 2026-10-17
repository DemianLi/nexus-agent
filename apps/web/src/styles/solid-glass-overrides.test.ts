// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DESTRUCTIVE_HOVER, DESTRUCTIVE_REST } from '../../tokengen/destructive-tint.mjs';
import { VENDOR_UPSTREAM_FILES } from '@/test/vendor-upstream';

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

  test('destructive 按鈕 hover 的淡紅底：覆寫檔在 (hover: hover) 裡、layer 外，百分比跟 tokengen 解色用的同一份（#1523，第 17 條）', () => {
    const HOVER = { conditions: ['@media (hover: hover)'] };
    const light = '[data-slot="button"][data-variant="destructive"]:hover';
    const dark = `.dark ${light}`;
    const mix = (percent: number) =>
      `color-mix(in oklab, var(--destructive) ${percent}%, transparent)`;
    expect(cascade.winner([light], 'background-color', HOVER)).toMatchObject({
      value: mix(Math.round(DESTRUCTIVE_HOVER.light * 100)),
      layer: null,
      file: OVERRIDES,
    });
    expect(cascade.winner([dark], 'background-color', HOVER)).toMatchObject({
      value: mix(Math.round(DESTRUCTIVE_HOVER.dark * 100)),
      layer: null,
      file: OVERRIDES,
    });
    // 沒有 hover 能力的裝置不套（跟 Tailwind 的 `hover:` 一樣）。
    expect(cascade.winner([light], 'background-color')).toBeUndefined();
  });

  test('vendor 原文的 destructive hover 仍是 /20、/30，平常仍是 /10、/20：上游改了，這條紅，回頭重解 tokengen 與第 17 條', () => {
    const file = [...VENDOR_UPSTREAM_FILES].find((f) => f.endsWith('/components/ui/button.tsx'));
    expect(file).toBeDefined();
    const source = readFileSync(
      fileURLToPath(new URL(`../${file ?? ''}`, import.meta.url)),
      'utf8',
    );
    const destructive = /destructive:\s*"([^"]*)"/.exec(source)?.[1] ?? '';
    const pct = (alpha: number) => Math.round(alpha * 100);
    expect(destructive.split(/\s+/)).toEqual(
      expect.arrayContaining([
        // 平常那一格：tokengen 解色用的就是這兩個值。
        `bg-destructive/${pct(DESTRUCTIVE_REST.light)}`,
        `dark:bg-destructive/${pct(DESTRUCTIVE_REST.dark)}`,
        // hover：被第 17 條蓋掉的原值。
        'hover:bg-destructive/20',
        'dark:hover:bg-destructive/30',
      ]),
    );
  });
});
