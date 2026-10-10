// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * 亮色陰影不刺眼（#1307；`COMPONENTS.md`「陰影很淡」）：`theme.css` 的 `:root` 裡，每個 `--*-shadow` 的每一層**投影**，
 * 透明度不超過 {@link MAX_ALPHA}。陰影分層疊，單層要淡；想更明顯就多一層，不是把一層調濃。
 *
 * - **只管亮色**：暗底上投影要更濃才看得到（`.dark` 的 menu 外層 0.24），不套這個數字。
 * - **只管寫死透明度的那幾層**：`0 0 0 1px var(--card-hairline)` 那一層是邊緣（邊緣畫在陰影裡，`border-shadow.test.ts`），
 *   顏色由產生器對著對比度解，不在這裡管。量具自檢：抓不到任何一層就紅，不讓格式一變就空過。
 */

const MAX_ALPHA = 0.06;

const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8');

/** `:root { … }` 的內容（第一個 `:root {` 到它的 `}`）。 */
function rootBlock(text: string): string {
  const start = text.indexOf(':root {');
  if (start < 0) throw new Error('theme.css 找不到 `:root {`');
  return text.slice(start, text.indexOf('}', start));
}

/** 每個 `--*-shadow` 宣告裡寫死的透明度：`rgb(… / a)`、`rgba(…, a)`、`hsl(… / a)`。 */
function shadowAlphas(block: string): { name: string; alpha: number }[] {
  const found: { name: string; alpha: number }[] = [];
  for (const [, name, value] of block.matchAll(/--([\w-]*shadow[\w-]*):\s*([^;]+);/g)) {
    for (const match of (value ?? '').matchAll(/\b(?:rgba?|hsla?)\(([^)]*)\)/g)) {
      const args = match[1] ?? '';
      const alpha = args.includes('/') ? args.split('/')[1] : args.split(',')[3];
      if (alpha !== undefined) found.push({ name: name ?? '', alpha: Number.parseFloat(alpha) });
    }
  }
  return found;
}

describe('亮色陰影每層透明度', () => {
  const layers = shadowAlphas(rootBlock(css));

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
      shadowAlphas('--a-shadow: 0 1px 2px rgb(0 0 0 / 0.2), 0 0 1px rgba(0, 0, 0, 0.05);'),
    ).toEqual([
      { name: 'a-shadow', alpha: 0.2 },
      { name: 'a-shadow', alpha: 0.05 },
    ]);
    expect(
      rootBlock(
        ':root {\n--x-shadow: rgb(0 0 0 / 0.01);\n}\n.dark {\n--x-shadow: rgb(0 0 0 / 0.5);\n}',
      ),
    ).not.toContain('0.5');
  });
});
