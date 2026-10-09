// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * 全站的焦點外框（#1279）：外框本身要寫在 **layer 外**，registry 元件自帶的 `outline-none` 才擋不掉它。
 * 放回 `@layer base` 時，`Button`、`Input`、`Textarea`、側欄選單鈕的鍵盤焦點會整個看不到（2026-10-09 實機量到 67 個裡 34 個），
 * 而 jsdom 不算 cascade layer，元件測試看不出來，所以直接量樣式表的原始碼。
 */
const css = readFileSync(new URL('./theme.css', import.meta.url), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** 去掉所有 `@layer … { … }` 區塊（含巢狀大括號）後剩下的。 */
function unlayered(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const start = source.indexOf('@layer', i);
    if (start < 0) return out + source.slice(i);
    out += source.slice(i, start);
    let j = source.indexOf('{', start);
    let depth = 1;
    while (depth > 0 && ++j < source.length) {
      if (source[j] === '{') depth++;
      else if (source[j] === '}') depth--;
    }
    i = j + 1;
  }
  return out;
}

describe('焦點外框', () => {
  test('外框寫在 layer 外，元件的 outline-none 擋不掉', () => {
    const outside = unlayered(css);
    expect(outside).toMatch(/:focus-visible[^{]*\{\s*outline:\s*2px solid var\(--ring\);?\s*\}/);
  });

  test('只排除程式搬焦點的容器、輸入框群組裡的輸入框、自己畫焦點樣子的', () => {
    const selector = /(:focus-visible:not\(([^)]*)\))\s*\{\s*outline:/.exec(unlayered(css))?.[2];
    expect(selector?.split(',').map((s) => s.trim())).toEqual([
      "[tabindex='-1']",
      "[data-slot='input-group-control']",
      "[data-focus='custom']",
    ]);
  });

  test('offset 留在 base layer，讓 -outline-offset-* 這類 utility 改得動', () => {
    expect(unlayered(css)).not.toMatch(/outline-offset/);
    expect(css).toMatch(/@layer base\s*\{\s*:focus-visible\s*\{\s*outline-offset:\s*2px;?\s*\}/);
  });

  test('registry 自帶的 ring 仍在 layer 外清掉，兩圈不會疊在一起', () => {
    expect(unlayered(css)).toMatch(/:focus-visible\s*\{\s*--tw-ring-shadow:\s*0 0 #0000;?\s*\}/);
  });
});
