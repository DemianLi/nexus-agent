// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { readCascade, type Cascade } from './styles/css-cascade';

/**
 * `--font-mono` 有兩個讀者，兩個都要量（#1512）：
 *
 * - **`font-mono` 這類 utility**：Tailwind 編譯時就把 `@theme` 疊出來的最後一條寫進規則，執行期的覆寫改不到它。
 * - **`var(--font-mono)`**（`markdown.css` 的程式碼）：執行期讀 `<html>` 上的自訂屬性。`@theme` 編出來的那條在 theme layer，
 *   layer 外的 `:root { --font-mono }` 會蓋過它，只查 `@theme` 就看不到。暗色時 `.dark` 也落在同一個元素。
 */
const READERS: [string, readonly string[]][] = [
  ['font-mono utility', ['@theme']],
  ['var(--font-mono)，亮色', ['@theme', ':root']],
  ['var(--font-mono)，暗色', ['@theme', ':root', '.dark']],
];

/** 那個讀者看到的 `--font-mono` 字型清單，一個家族一項、去掉引號。 */
function monoStack(selectors: readonly string[], cascade: Cascade = readCascade()): string[] {
  const value = cascade.value(selectors, '--font-mono');
  if (value === undefined) throw new Error(`${selectors.join(' ')} 都沒有 --font-mono`);
  return value.split(',').map((family) => family.trim().replace(/^['"]|['"]$/g, ''));
}

describe.each(READERS)('--font-mono 的 emoji 字型（#979）：%s', (_reader, selectors) => {
  it('三個平台的 emoji 字型明寫在堆疊最尾', () => {
    // 堆疊裡沒有字型涵蓋的符號（旗、☺、❤…）走系統回退：每個新頁面第一次約 40ms，裸旗 U+1F3F3
    // 每含它的一列還要約 1.6ms。明寫之後兩項都回到地板。拿掉的話沒有任何畫面會變，只有點開變慢。
    expect(monoStack(selectors).slice(-3)).toEqual([
      'Apple Color Emoji',
      'Segoe UI Emoji',
      'Noto Color Emoji',
    ]);
  });

  it('emoji 字型只在尾端，前面的字型涵蓋的字不受影響', () => {
    const stack = monoStack(selectors);
    expect(stack.indexOf('monospace')).toBe(stack.length - 4);
    expect(stack.slice(0, 2)).toEqual(['Google Sans Code Variable', 'Noto Sans TC Variable']);
  });
});

describe('判準', () => {
  it('layer 外的 `:root` 覆寫改到 var() 讀到的，改不到 utility 讀到的', () => {
    const cascade = readCascade('/v/index.css', () =>
      ["@theme { --font-mono: 'A', monospace; }", ":root { --font-mono: 'B', monospace; }"].join(
        '\n',
      ),
    );
    expect(monoStack(['@theme'], cascade)).toEqual(['A', 'monospace']);
    expect(monoStack(['@theme', ':root'], cascade)).toEqual(['B', 'monospace']);
  });
});
