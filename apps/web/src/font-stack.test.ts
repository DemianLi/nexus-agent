// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

/** `--font-mono:` 宣告的字型清單，一個家族一項、去掉引號。 */
function monoStack(): string[] {
  const match = /--font-mono:\s*([^;]+);/.exec(css);
  if (match?.[1] === undefined) throw new Error('index.css 裡找不到 --font-mono');
  return match[1].split(',').map((family) => family.trim().replace(/^'|'$/g, ''));
}

describe('--font-mono 的 emoji 字型（#979）', () => {
  it('三個平台的 emoji 字型明寫在堆疊最尾', () => {
    // 堆疊裡沒有字型涵蓋的符號（旗、☺、❤…）走系統回退：每個新頁面第一次約 40ms，裸旗 U+1F3F3
    // 每含它的一列還要約 1.6ms。明寫之後兩項都回到地板。拿掉的話沒有任何畫面會變，只有點開變慢。
    expect(monoStack().slice(-3)).toEqual([
      'Apple Color Emoji',
      'Segoe UI Emoji',
      'Noto Color Emoji',
    ]);
  });

  it('emoji 字型只在尾端，前面的字型涵蓋的字不受影響', () => {
    const stack = monoStack();
    expect(stack.indexOf('monospace')).toBe(stack.length - 4);
    expect(stack.slice(0, 2)).toEqual(['Google Sans Code Variable', 'Noto Sans TC Variable']);
  });
});
