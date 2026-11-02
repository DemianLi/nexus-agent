// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { readCascade } from './css-cascade';

/**
 * 全站的焦點外框（#1279）：外框本身要寫在 **layer 外**，registry 元件自帶的 `outline-none` 才擋不掉它。
 * 放回 `@layer base` 時，`Button`、`Input`、`Textarea`、側欄選單鈕的鍵盤焦點會整個看不到（2026-10-09 實機量到 67 個裡 34 個），
 * 而 jsdom 不算 cascade layer，元件測試看不出來，所以直接量樣式表。
 *
 * 量的是 `index.css` 照 import 順序疊出來、**實際勝出**的那一條（`css-cascade.ts`，#1498），不是某一個檔：
 * 後面疊上來的樣式表用同一段選擇器改掉外框或把 ring 開回來，這裡會紅。選擇器不同、specificity 更高的規則量不到，見量具的檔頭。
 */
const cascade = readCascade();

/** 全站外框那一條的選擇器：layer 外、`:focus-visible:not(…)`、宣告了 `outline`。 */
const outlineSelector = cascade.declarations.find(
  (d) => d.layer === null && d.property === 'outline' && /^:focus-visible:not\(/.test(d.selector),
)?.selector;

describe('焦點外框', () => {
  test('外框寫在 layer 外，元件的 outline-none 擋不掉', () => {
    expect(outlineSelector).toBeDefined();
    expect(cascade.winner([outlineSelector ?? ''], 'outline')).toMatchObject({
      value: '2px solid var(--ring)',
      layer: null,
    });
  });

  test('只排除程式搬焦點的容器、文字輸入框（自己有焦點樣子，滑鼠點也算 focus-visible）、自己畫焦點樣子的', () => {
    const excluded = /^:focus-visible:not\((.*)\)$/.exec(outlineSelector ?? '')?.[1];
    expect(excluded?.split(',').map((s) => s.trim())).toEqual([
      "[tabindex='-1']",
      'input',
      'textarea',
      "[data-focus='custom']",
    ]);
  });

  test('offset 留在 base layer，讓 -outline-offset-* 這類 utility 改得動', () => {
    expect(
      cascade.declarations
        .filter((d) => d.layer === null && d.property === 'outline-offset')
        .map((d) => `${d.file} ${d.selector}`),
    ).toEqual([]);
    expect(cascade.winner([':focus-visible'], 'outline-offset')).toMatchObject({
      value: '2px',
      layer: 'base',
    });
  });

  test('registry 自帶的 ring 仍在 layer 外清掉，兩圈不會疊在一起', () => {
    expect(cascade.winner([':focus-visible'], '--tw-ring-shadow')).toMatchObject({
      value: '0 0 #0000',
      layer: null,
    });
  });

  test('被排除的在 base layer 各自給值，不掉回瀏覽器預設的藍框：容器不畫、文字輸入框照舊畫（utility 的 outline-none 蓋得掉）', () => {
    expect(cascade.winner(["[tabindex='-1']:focus-visible"], 'outline')).toMatchObject({
      value: 'none',
      layer: 'base',
    });
    expect(cascade.winner([':is(input, textarea):focus-visible'], 'outline')).toMatchObject({
      value: '2px solid var(--ring)',
      layer: 'base',
    });
  });

  test('「看這一輪」的高亮是 layer 外的外框：摘要那一則被程式聚焦時，清 ring 那條與 tabindex=-1 不畫外框那條都吃不掉它', () => {
    expect(cascade.winner(['[data-revealed]'], 'outline')).toMatchObject({
      value: '2px solid var(--ring)',
      layer: null,
    });
  });
});
