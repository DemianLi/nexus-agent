// @vitest-environment node
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { SG, SG_REDUCED_TRANSPARENCY } from '../../tokengen/sg-input.mjs';
import { readCascade } from './css-cascade';

/**
 * 產生器的 SG 輸入表（`tokengen/sg-input.mjs`）跟 vendor 檔逐值一致（#1512）。產生器以這張表為起點解值、把沒調的暗色原樣寫進產物；
 * SG 升版改了值而這張表沒跟上，產物就會用舊值，這裡紅。讀的是 vendor 檔本身（不是 `index.css` 疊出來的結果，那裡已被產物蓋掉）。
 */

const VENDOR = fileURLToPath(new URL('../vendor/solid-glass/solid-glass.css', import.meta.url));
const vendor = readCascade(VENDOR);

/** `.dark` 掛在 `<html>` 上，跟 `:root` 落在同一個元素。 */
const SELECTORS = { light: [':root'], dark: [':root', '.dark'] } as const;

describe('SG 輸入表跟 vendor 檔一致', () => {
  for (const theme of ['light', 'dark'] as const) {
    test.each(Object.entries(SG[theme]))(`${theme}：--%s`, (name, value) => {
      expect(vendor.value(SELECTORS[theme], `--${name}`)).toBe(value);
    });

    test.each(Object.entries(SG_REDUCED_TRANSPARENCY[theme]))(
      `${theme}，reduced-transparency：--%s`,
      (name, value) => {
        expect(
          vendor.value(SELECTORS[theme], `--${name}`, {
            conditions: [SG_REDUCED_TRANSPARENCY.condition],
          }),
        ).toBe(value);
      },
    );
  }

  test('量具有讀到東西：表不是空的，亮暗列的 token 一樣', () => {
    expect(Object.keys(SG.light).length).toBeGreaterThan(10);
    expect(Object.keys(SG.dark)).toEqual(Object.keys(SG.light));
    expect(Object.keys(SG_REDUCED_TRANSPARENCY.dark)).toEqual(
      Object.keys(SG_REDUCED_TRANSPARENCY.light),
    );
  });
});
