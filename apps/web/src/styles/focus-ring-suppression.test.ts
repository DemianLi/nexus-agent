// @vitest-environment node
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { readCascade } from './css-cascade';

/**
 * D′（#1512）：SG 會在幾個選擇器上把 shadcn 的焦點 ring 帶回來（`--tw-ring-shadow` 設成看得到的值），而焦點的樣子只能是
 * 那一圈文字色的外框（#1468 Q5、#1279）。`solid-glass.overrides.css` 照抄同一段選擇器壓回去。
 *
 * 列舉 vendor 檔裡**每一條**把 `--tw-ring-*` 設成非透明的宣告（今天只有 `--tw-ring-shadow`；比對整個前綴，上游升版多出
 * `--tw-ring-color`、`--tw-ring-offset-*` 之類也會被列進來）：條數釘死（SG 升版多了或少了都紅，要回來看），
 * 每一條在 `index.css` 疊出來的結果裡都要被壓回透明，壓的那條要在覆寫檔、layer 外。瀏覽器那一層（`guard/`）量聚焦後的 `box-shadow`。
 */
const VENDOR = fileURLToPath(new URL('../vendor/solid-glass/solid-glass.css', import.meta.url));
const vendor = readCascade(VENDOR);
const cascade = readCascade();

const NONE = '0 0 #0000';

const RING_RESTORED = vendor.declarations.filter(
  (d) => /^--tw-ring/.test(d.property) && d.value !== NONE,
);

describe('SG 帶回來的焦點 ring 都被壓掉（D′）', () => {
  test('vendor 檔裡把 ring 帶回來的宣告：2 條（solid-glass.css:859-862 的兩個選擇器）', () => {
    expect(RING_RESTORED.map((d) => d.selector)).toEqual([
      ':is([class*="focus-visible:ring-3"], [class*="focus-visible:ring-[3px]"]):focus-visible:not([data-slot="input"]):not([data-slot="textarea"]):not([data-slot="select-trigger"]):not([data-slot="native-select"]):not([data-slot="sidebar-input"]):not([aria-invalid="true"])',
      '[data-slot="calendar"] [data-focused="true"] > :is(button, [data-slot="button"])',
    ]);
  });

  test.each(RING_RESTORED.map((d) => [d.selector, d] as const))(
    '%s：疊完是透明，壓的那條在覆寫檔、layer 外',
    (selector, restored) => {
      expect(
        cascade.winner([selector], restored.property, { conditions: restored.conditions }),
      ).toMatchObject({ value: NONE, layer: null, file: 'styles/solid-glass.overrides.css' });
    },
  );
});
