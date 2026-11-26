// @vitest-environment node
import { fileURLToPath } from 'node:url';

import Color from 'colorjs.io';
import { describe, expect, test } from 'vitest';

import { SG, SG_REDUCED_TRANSPARENCY } from '../../tokengen/sg-input.mjs';
import { parseColor } from './color-math';
import { readCascade } from './css-cascade';

/**
 * 產生器產物（`tokens.generated.css`）的結構與疊上去之後的結果（#1512）。對比度另見 `tokens-contrast.test.ts`。
 *
 * 1. **亮暗成對**：`.dark` 掛在 `<html>` 上，跟 `:root` 落在同一個元素、同 specificity。產物只寫 `:root` 的 token，
 *    暗色會吃到亮色的值（c5 型陷阱）；反過來只寫 `.dark` 的，亮色沒有覆寫、暗色卻有，也是漏。
 * 2. **解出來的值都在 sRGB 內**：demian 選 B 案的理由是「畫的就是量的」（#1512，2026-10-17）。原樣搬來的 SG 值不解，
 *    只有 {@link OUT_OF_SRGB} 列名的那幾格可以例外，而且要一字不差等於 SG 原值——SG 升版帶進新的超色域值，這裡會紅。
 * 3. **reduced-transparency 底下面是不透明的**：產物覆寫了 `--card`，排在 SG 後面的無條件值會蓋掉 SG 在那個條件下給的不透明值，
 *    產物要照樣重寫那一段。量的是 `index.css` 疊出來的結果。
 * 4. **`data-glass="opaque"` 底下也是**（#1468 Q7）：SG 在那裡只拿掉 blur，面還是半透明的；產物照 reduced-transparency 那一組值補上。
 *    兩種不透明的退路都要過亮暗鑑別度，過不了的格子由產生器重解，列在 {@link OPAQUE_OVERRIDES}。
 */

const GENERATED = fileURLToPath(new URL('./tokens.generated.css', import.meta.url));
const generated = readCascade(GENERATED);
const cascade = readCascade();

type Theme = 'light' | 'dark';
const SELECTORS: Record<Theme, readonly string[]> = { light: [':root'], dark: [':root', '.dark'] };
const REDUCED = { conditions: [SG_REDUCED_TRANSPARENCY.condition] };

/**
 * 解出來的值不在 sRGB 內、仍允許出現在產物裡的格子：只認 token 加值。
 * 目前沒有。原本有暗色 `--destructive` 的 SG 原值（P3 內、已達標所以不碰，PM，#1512）；#1523 起它還要過「自己的淡色底」
 * （SG 的 destructive 按鈕與 badge 是 `bg-destructive/20` 配 `text-destructive`），SG 原值疊在卡片上的那幾疊不到 4.5，改由產生器重解，落在 sRGB 內。
 */
const OUT_OF_SRGB: { theme: Theme; name: string; value: string }[] = [];

/** 產物裡某個選擇器底下（沒有條件）的自訂屬性。 */
function declared(selector: string): Map<string, string> {
  return new Map(
    generated.declarations
      .filter(
        (d) => d.selector === selector && d.conditions.length === 0 && d.property.startsWith('--'),
      )
      .map((d) => [d.property.slice(2), d.value]),
  );
}

const light = declared(':root');
const dark = declared('.dark');

describe('產生器產物', () => {
  test('亮暗成對：:root 與 .dark 寫的是同一組 token', () => {
    expect([...dark.keys()].sort()).toEqual([...light.keys()].sort());
  });

  test('量具有讀到東西：產物有 token，也有 reduced-transparency 那一段', () => {
    expect(light.size).toBeGreaterThan(10);
    expect(
      generated.declarations.some((d) => d.conditions.includes(SG_REDUCED_TRANSPARENCY.condition)),
    ).toBe(true);
  });

  test('解出來的值都在 sRGB 內；例外只有列名的那幾格，而且一字不差等於 SG 原值', () => {
    const outside = (['light', 'dark'] as const).flatMap((theme) =>
      [...(theme === 'light' ? light : dark)]
        .filter(([, value]) => !new Color(value).inGamut('srgb'))
        .map(([name, value]) => ({ theme, name, value })),
    );
    expect(outside).toEqual(OUT_OF_SRGB);
    for (const { theme, name, value } of OUT_OF_SRGB) expect(SG[theme][name]).toBe(value);
  });

  test('判準：sRGB 的判斷分得出內外（B 案的值在內、SG 的亮色 destructive 在外）', () => {
    expect(new Color('oklch(0.492 0.2 27.325)').inGamut('srgb')).toBe(true);
    expect(new Color('oklch(0.577 0.245 27.325)').inGamut('srgb')).toBe(false);
  });
});

/**
 * 不透明的退路裡跟 SG 不同的格子（PM，#1512）：SG 的不透明亮色 sidebar 跟暗色的鑑別度差 0.159，過不了 Q5 的亮暗鑑別度，
 * 產生器照「只調亮色、停在第一個達標的值」重解。只認 token 加值；其他格要一字不差等於 SG 原檔（`sg-input.test.ts` 釘 vendor）。
 */
const OPAQUE_OVERRIDES: { theme: Theme; name: string; value: string }[] = [
  { theme: 'light', name: 'sidebar', value: 'oklch(0.952 0 0)' },
];

/** 不透明的退路該有的值：SG 原值，具名覆寫的換成覆寫值。 */
function expectedOpaque(theme: Theme): [string, string][] {
  return Object.entries(SG_REDUCED_TRANSPARENCY[theme]).map(([name, value]) => [
    name,
    OPAQUE_OVERRIDES.find((o) => o.theme === theme && o.name === name)?.value ?? value,
  ]);
}

/** 不透明的面（`primary-solid` 是百分比，不是顏色）。 */
const opaqueSurfaces = (theme: Theme) =>
  expectedOpaque(theme).filter(([name]) => name !== 'primary-solid');

describe('reduced-transparency 底下（index.css 疊出來的結果）', () => {
  for (const theme of ['light', 'dark'] as const) {
    test.each(opaqueSurfaces(theme))(
      `${theme}：--%s 不透明，而且等於 SG 原檔在那個條件下的值（具名覆寫的除外）`,
      (name, value) => {
        const actual = cascade.computed(SELECTORS[theme], `--${name}`, REDUCED);
        expect(actual).toBe(value);
        expect(parseColor(actual ?? '').alpha).toBe(1);
      },
    );

    test(`${theme}：--primary-solid 是 100%`, () => {
      expect(cascade.computed(SELECTORS[theme], '--primary-solid', REDUCED)).toBe('100%');
    });
  }

  test('判準：沒有條件時 --card 仍是半透明的（條件真的有分開量）', () => {
    expect(parseColor(cascade.computed([':root'], '--card') ?? '').alpha).toBeLessThan(1);
  });

  test('具名覆寫的格子真的跟 SG 不同（沒有留著過期的條目）', () => {
    for (const { theme, name, value } of OPAQUE_OVERRIDES)
      expect(SG_REDUCED_TRANSPARENCY[theme][name]).not.toBe(value);
  });
});

/**
 * `data-glass` 掛在哪都要成立：掛在 `<html>` 上（跟 `:root`、`.dark` 同一個元素），或掛在裡面某一塊。
 * 量具只看 layer 與先後、不算 specificity：產物裡暗色那段排在亮色後面，所以這裡也分得出來。
 */
const OPAQUE_ELEMENTS: [string, Theme, readonly string[]][] = [
  ['亮色，掛在 <html>', 'light', [':root', "[data-glass='opaque']"]],
  ['亮色，掛在裡面一塊', 'light', ["[data-glass='opaque']"]],
  [
    '暗色，掛在 <html>',
    'dark',
    [':root', '.dark', "[data-glass='opaque']", ".dark[data-glass='opaque']"],
  ],
  ['暗色，掛在裡面一塊', 'dark', ["[data-glass='opaque']", ".dark [data-glass='opaque']"]],
];

describe('data-glass="opaque" 底下（#1468 Q7）', () => {
  test.each(OPAQUE_ELEMENTS)(
    '%s：面不透明，等於 reduced-transparency 那一組',
    (_where, theme, selectors) => {
      for (const [name, value] of expectedOpaque(theme)) {
        expect(cascade.computed(selectors, `--${name}`), name).toBe(value);
      }
    },
  );
});
