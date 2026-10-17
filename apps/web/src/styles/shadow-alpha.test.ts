// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { parseColor, shadowLayers } from './color-math';
import { readCascade } from './css-cascade';

/**
 * 亮色陰影不刺眼（#1307；`COMPONENTS.md`「陰影很淡」）：亮色時 `:root` 上**實際生效**的每個 `--*-shadow`，每一層**投影**的
 * 透明度不超過 {@link MAX_ALPHA}。陰影分層疊，單層要淡；想更明顯就多一層，不是把一層調濃。
 *
 * - **量疊出來的結果**：`index.css` 照 import 順序展開、算過 cascade 的值（`css-cascade.ts`，#1498），不是只讀 `theme.css`。
 * - **只管亮色**：暗底上投影要更濃才看得到（`.dark` 的 menu 外層 0.24），不套這個數字。
 * - **只管寫死透明度的投影**：只有 `var()` 的那一層（`0 0 0 1px var(--card-hairline)`）與邊緣那一層（offset、blur 都是 0）
 *   畫的是邊緣（邊緣畫在陰影裡，`border-shadow.test.ts`），顏色由產生器對著對比度解，不在這裡管。量具自檢：抓不到任何一層就紅，不讓格式一變就空過。
 * - **顏色寫法都認得**：`rgb()`、`rgba()`、`hsl()`、`oklch(… / 28%)`……透明度交給 colorjs.io 解（`color-math.ts`，#1512）。
 * - **陰影的顏色也可以是 token**：投影寫成 `var(--x)` 時，透明度在那個 token 上，列進 {@link ALPHA_TOKENS} 逐個給上限。
 *
 * 量的是 token；元素上實際的 `box-shadow` 由瀏覽器那一層（`guard/`）量。
 */

const MAX_ALPHA = 0.06;

/** 當作陰影顏色用的 token 與各自的透明度上限（亮色）。之後誰把它調深就紅。 */
const ALPHA_TOKENS: Record<string, number> = {};

/** 亮色時 `<html>` 只符合 `:root`。 */
const LIGHT = [':root'];

/** 每個 `--*-shadow` 宣告裡，各層投影寫死的透明度。 */
function shadowAlphas(properties: Map<string, string>): { name: string; alpha: number }[] {
  const found: { name: string; alpha: number }[] = [];
  for (const [property, value] of properties) {
    const name = /^--([\w-]*shadow[\w-]*)$/.exec(property)?.[1];
    if (name === undefined) continue;
    for (const layer of shadowLayers(value)) {
      if (layer.edge || layer.color === undefined) continue;
      found.push({ name, alpha: parseColor(layer.color).alpha });
    }
  }
  return found;
}

/** {@link ALPHA_TOKENS} 裡超過上限或根本不存在的 token。 */
function alphaTokenViolations(
  properties: Map<string, string>,
  limits: Record<string, number>,
): string[] {
  return Object.entries(limits).flatMap(([name, max]) => {
    const value = properties.get(name);
    if (value === undefined) return [`${name} 不存在`];
    const { alpha } = parseColor(value);
    return alpha <= max ? [] : [`${name} ${alpha} > ${max}`];
  });
}

describe('亮色陰影每層透明度', () => {
  const properties = readCascade().customProperties(LIGHT);
  const layers = shadowAlphas(properties);

  test(`每一層 ≤ ${MAX_ALPHA}`, () => {
    expect(
      layers.filter((l) => !(l.alpha <= MAX_ALPHA)).map((l) => `${l.name} ${l.alpha}`),
    ).toEqual([]);
  });

  test('當作陰影顏色的 token 都在、都不超過各自的上限', () => {
    expect(alphaTokenViolations(properties, ALPHA_TOKENS)).toEqual([]);
  });

  test('量具有抓到東西：三個陰影 token、五層投影', () => {
    expect(new Set(layers.map((l) => l.name))).toEqual(
      new Set(['card-shadow', 'material-shadow', 'menu-shadow']),
    );
    expect(layers).toHaveLength(5);
  });

  test('判準：斜線與逗號兩種寫法都讀得到；暗色區塊不算', () => {
    expect(
      shadowAlphas(
        new Map([['--a-shadow', '0 1px 2px rgb(0 0 0 / 0.2), 0 0 1px rgba(0, 0, 0, 0.05)']]),
      ),
    ).toEqual([
      { name: 'a-shadow', alpha: 0.2 },
      { name: 'a-shadow', alpha: 0.05 },
    ]);
    const css =
      ':root {\n--x-shadow: rgb(0 0 0 / 0.01);\n}\n.dark {\n--x-shadow: rgb(0 0 0 / 0.5);\n}';
    expect(
      readCascade('/v/index.css', () => css)
        .customProperties(LIGHT)
        .get('--x-shadow'),
    ).not.toContain('0.5');
  });

  test('判準：oklch 的百分比與小數、瀏覽器計算值的寫法都讀得到；邊緣那一層與只有 var() 的那一層不算', () => {
    expect(
      shadowAlphas(
        new Map([
          [
            '--b-shadow',
            '0 8px 24px oklch(0.2 0.02 260 / 28%), 0 1px 2px oklch(0 0 0 / 0.05), 0 0 0 1px oklch(0 0 0 / 0.5), 0 0 0 1px var(--card-hairline)',
          ],
          ['--c-shadow', 'rgba(0, 0, 0, 0.04) 0px 1px 3px 0px'],
        ]),
      ),
    ).toEqual([
      { name: 'b-shadow', alpha: 0.28 },
      { name: 'b-shadow', alpha: 0.05 },
      { name: 'c-shadow', alpha: 0.04 },
    ]);
  });

  test('判準：token 超過上限、或改了名找不到，都紅', () => {
    const properties = new Map([
      ['--glass-shade', 'oklch(0.2 0.02 260 / 28%)'],
      ['--glass-lift', 'oklch(1 0 0 / 0.5)'],
    ]);
    expect(
      alphaTokenViolations(properties, {
        '--glass-shade': 0.28,
        '--glass-lift': 0.4,
        '--glass-contact': 0.1,
      }),
    ).toEqual(['--glass-lift 0.5 > 0.4', '--glass-contact 不存在']);
  });
});
