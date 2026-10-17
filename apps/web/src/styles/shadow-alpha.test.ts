// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { readCascade } from './css-cascade';

/**
 * 亮色陰影不刺眼（#1307；`COMPONENTS.md`「陰影很淡」）：亮色時 `:root` 上**實際生效**的每個 `--*-shadow`，每一層**投影**的
 * 透明度不超過 {@link MAX_ALPHA}。陰影分層疊，單層要淡；想更明顯就多一層，不是把一層調濃。
 *
 * - **量疊出來的結果**：`index.css` 照 import 順序展開、算過 cascade 的值（`css-cascade.ts`，#1498），不是只讀 `theme.css`。
 * - **只管亮色**：暗底上投影要更濃才看得到（`.dark` 的 menu 外層 0.24），不套這個數字。
 * - **只管寫死透明度的那幾層**：`0 0 0 1px var(--card-hairline)` 那一層是邊緣（邊緣畫在陰影裡，`border-shadow.test.ts`），
 *   顏色由產生器對著對比度解，不在這裡管。量具自檢：抓不到任何一層就紅，不讓格式一變就空過。
 */

const MAX_ALPHA = 0.06;

/** 亮色時 `<html>` 只符合 `:root`。 */
const LIGHT = [':root'];

/** 每個 `--*-shadow` 宣告裡寫死的透明度：`rgb(… / a)`、`rgba(…, a)`、`hsl(… / a)`。 */
function shadowAlphas(properties: Map<string, string>): { name: string; alpha: number }[] {
  const found: { name: string; alpha: number }[] = [];
  for (const [property, value] of properties) {
    const name = /^--([\w-]*shadow[\w-]*)$/.exec(property)?.[1];
    if (name === undefined) continue;
    for (const match of value.matchAll(/\b(?:rgba?|hsla?)\(([^)]*)\)/g)) {
      const args = match[1] ?? '';
      const alpha = args.includes('/') ? args.split('/')[1] : args.split(',')[3];
      if (alpha !== undefined) found.push({ name, alpha: Number.parseFloat(alpha) });
    }
  }
  return found;
}

describe('亮色陰影每層透明度', () => {
  const layers = shadowAlphas(readCascade().customProperties(LIGHT));

  test(`每一層 ≤ ${MAX_ALPHA}`, () => {
    expect(
      layers.filter((l) => !(l.alpha <= MAX_ALPHA)).map((l) => `${l.name} ${l.alpha}`),
    ).toEqual([]);
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
});
