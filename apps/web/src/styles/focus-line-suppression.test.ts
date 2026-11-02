// @vitest-environment node
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { readCascade } from './css-cascade';

/**
 * 焦點只用字色（#1468 Q5，#1512 PM 定 (b)）：SG 用 `--focus-line`（灰）畫的焦點——欄位聚焦的邊框、一次性密碼格的內側線、
 * 把 ring 帶回來的那條（D′）——都要在 `solid-glass.overrides.css` 被同一段選擇器蓋掉。
 *
 * 列舉 vendor 檔裡**每一條**值裡用到 `var(--focus-line)` 的宣告：條數釘死（SG 升版多了或少了都紅，要回來看），
 * 每一條在 `index.css` 疊出來的結果裡都不能再用 `--focus-line`，蓋掉它的那條要在覆寫檔、layer 外。
 * 瀏覽器那一層（`guard/`）量欄位聚焦後的 `border-color` 等於字色。
 */
const VENDOR = fileURLToPath(new URL('../vendor/solid-glass/solid-glass.css', import.meta.url));
const vendor = readCascade(VENDOR);
const cascade = readCascade();

const USES = vendor.declarations.filter((d) => d.value.includes('var(--focus-line)'));

describe('SG 用 --focus-line 畫的焦點都換成字色', () => {
  test('vendor 檔裡用到 --focus-line 的宣告：ring 2 條（:859-862）、欄位邊框 3 條（:946-950）、一次性密碼格 1 條（:953-957）', () => {
    expect(USES.map((d) => `${d.property} @ ${d.selector}`)).toEqual([
      '--tw-ring-shadow @ :is([class*="focus-visible:ring-3"], [class*="focus-visible:ring-[3px]"]):focus-visible:not([data-slot="input"]):not([data-slot="textarea"]):not([data-slot="select-trigger"]):not([data-slot="native-select"]):not([data-slot="sidebar-input"]):not([aria-invalid="true"])',
      '--tw-ring-shadow @ [data-slot="calendar"] [data-focused="true"] > :is(button, [data-slot="button"])',
      'border-color @ :is([data-slot="input"], [data-slot="questionnaire-input"], [data-slot="textarea"], [data-slot="select-trigger"], [data-slot="native-select"], [data-slot="sidebar-input"]):focus-visible:not([aria-invalid="true"])',
      'border-color @ [data-slot="input-group"]:has([data-slot="input-group-control"]:focus-visible):not(:has([aria-invalid="true"]))',
      'border-color @ [data-slot="combobox-chips"]:focus-within',
      'box-shadow @ [data-slot="input-otp-slot"][data-active="true"]',
    ]);
  });

  test.each(USES.map((d) => [`${d.property} @ ${d.selector}`, d] as const))(
    '%s：疊完不再用 --focus-line，蓋掉它的那條在覆寫檔、layer 外',
    (_label, use) => {
      const winner = cascade.winner([use.selector], use.property, { conditions: use.conditions });
      expect(winner).toMatchObject({ layer: null, file: 'styles/solid-glass.overrides.css' });
      expect(winner?.value).not.toContain('--focus-line');
    },
  );
});
