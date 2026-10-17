// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

/**
 * 瀏覽器護欄的測試頁（`guard/`，#1512）不准寫 class：`index.css` 用 `@source not '../guard'` 排除了它，
 * 它寫的 class 不會出現在出貨的 CSS 裡，元素量到的會是「沒有樣式」，護欄照樣綠——結果說謊。版面一律 inline style。
 *
 * 擋的是原始碼裡 `className`／`class=` 這兩種寫法（JSX 的屬性、HTML 的屬性、`createElement` 的 props 都是這兩個字）。
 * 元件從 `src/` import，元件自己的 class 都在出貨的 CSS 裡，不受影響。
 */

const GUARD = fileURLToPath(new URL('../guard', import.meta.url));

/** guard/ 底下的原始碼（不含 build 產物）。 */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'dist' ? [] : sources(path);
    return /\.(tsx?|html)$/.test(entry.name) ? [path] : [];
  });
}

const CLASS_ATTRIBUTE = /\bclass(?:Name)?\s*[=:]/;

/** 有寫 class 的那幾行，`檔名:行號`。 */
function classUses(file: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) => (CLASS_ATTRIBUTE.test(line) ? [`${file}:${i + 1}`] : []));
}

describe('瀏覽器護欄的測試頁不寫 class', () => {
  const files = sources(GUARD);

  test('guard/ 底下沒有 className／class=', () => {
    expect(
      files.flatMap((file) => classUses(file.slice(GUARD.length + 1), readFileSync(file, 'utf8'))),
    ).toEqual([]);
  });

  test('量具有掃到東西：測試頁本體都在', () => {
    const names = files.map((file) => file.slice(GUARD.length + 1));
    expect(names).toEqual(expect.arrayContaining(['index.html', 'main.tsx', 'guard.test.ts']));
  });

  test('判準：JSX 屬性、HTML 屬性、props 物件都抓得到；說明文字裡的 class 一詞不算', () => {
    expect(classUses('a', '<Button className="p-2" />')).toEqual(['a:1']);
    expect(classUses('a', '\n<div class="x">')).toEqual(['a:2']);
    expect(classUses('a', "createElement('div', { className: 'x' })")).toEqual(['a:1']);
    expect(classUses('a', '// 本頁不寫任何 class，版面只用 inline style')).toEqual([]);
  });
});
