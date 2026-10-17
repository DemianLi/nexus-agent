// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { guardHtml } from '../guard/server';

/**
 * 瀏覽器護欄的測試頁（`guard/`，#1512）只能畫元件、不能帶自己的樣式，否則量到的不是出貨的 CSS，護欄照樣綠——結果說謊。
 *
 * 1. **不准寫 class**：`index.css` 用 `@source not '../guard'` 排除了它，它寫的 class 不會出現在出貨的 CSS 裡，
 *    元素量到的會是「沒有樣式」。擋的是原始碼裡 `className`／`class=` 這兩種寫法（JSX 的屬性、HTML 的屬性、`createElement` 的 props 與簡寫 `{ className }`，不分大小寫）。
 *    元件從 `src/` import，元件自己的 class 都在出貨的 CSS 裡，不受影響。
 * 2. **行內樣式只放版面**：寬高、間距、flex 這類放行；會改到量測值的一律不准——顏色與底色、陰影、外框、透明度、濾鏡、
 *    混色、`color-scheme`、CSS 自訂屬性（在祖先上改 `--foreground` 等於改了整棵子樹的 token），不論寫在量測元素還是它的祖先上。
 *    同理不准在頁面裡注入樣式（`<style>`、`insertRule`、`adoptedStyleSheets`、`setProperty`、`cssText`、`.style.x =`）。
 *    唯一的例外是 {@link THEME_LINE}：出貨的 `index.html` 也這樣寫，測試頁照抄才是在量出貨的樣子。
 * 3. **HTML 不准帶樣式表或 `<style>`**：`guard/server.ts` 的 `guardHtml` 在插入出貨 CSS 前檢查（判準見下面的測試）。
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

/** `class=`／`className:`（不分大小寫），以及 props 的簡寫 `{ className }`。 */
const CLASS_ATTRIBUTE = /\bclass(?:Name)?\s*[=:]|\bclassName\b(?=\s*[,}])/i;

/** 會改到量測值的樣式屬性（JSX 的 camelCase 與 CSS 的 kebab-case 都算），以及 CSS 自訂屬性。 */
const STYLE_PROPERTY =
  /(?<![\w-])(?:color|background(?:-?\w+)?|box-?shadow|outline(?:-?\w+)?|opacity|filter|backdrop-?filter|mix-?blend-?mode|color-?scheme|text-?shadow|border(?:-?\w+)?-?color|fill|stroke|accent-?color)\s*:|['"]?--[\w-]+['"]?\s*:/i;
/** 在頁面裡注入或改寫樣式的寫法。 */
const STYLE_INJECTION =
  /<style\b|\binsertRule\b|\badoptedStyleSheets\b|\bCSSStyleSheet\b|\bsetProperty\b|\bcssText\b|\.style\s*(?:\.\w+|\[[^\]]*\])\s*=/i;

/** 照抄出貨 `index.html` 的主題腳本（`classList.toggle('dark')` 之後的那一行）。 */
const THEME_LINE = "document.documentElement.style.colorScheme = dark ? 'dark' : 'light';";

/** 符合規則的那幾行，`檔名:行號`。 */
function linesMatching(file: string, text: string, rule: (line: string) => boolean): string[] {
  return text.split('\n').flatMap((line, i) => (rule(line) ? [`${file}:${i + 1}`] : []));
}

const classUses = (file: string, text: string) =>
  linesMatching(file, text, (line) => CLASS_ATTRIBUTE.test(line));

const styleUses = (file: string, text: string) =>
  linesMatching(
    file,
    text,
    (line) =>
      line.trim() !== THEME_LINE && (STYLE_PROPERTY.test(line) || STYLE_INJECTION.test(line)),
  );

/** 測試頁本體：會進到頁面裡的檔（`.tsx` 與 HTML）。伺服器、build 設定與量測的測試檔不在頁面裡。 */
const pageSources = (files: string[]) => files.filter((file) => /\.(tsx|html)$/.test(file));

describe('瀏覽器護欄的測試頁不帶自己的樣式', () => {
  const files = sources(GUARD);
  const rel = (file: string) => file.slice(GUARD.length + 1);

  test('guard/ 底下沒有 className／class=', () => {
    expect(files.flatMap((file) => classUses(rel(file), readFileSync(file, 'utf8')))).toEqual([]);
  });

  test('測試頁的行內樣式只放版面，也不注入樣式', () => {
    expect(
      pageSources(files).flatMap((file) => styleUses(rel(file), readFileSync(file, 'utf8'))),
    ).toEqual([]);
  });

  test('量具有掃到東西：測試頁本體都在，主題那一行也還在', () => {
    expect(files.map(rel)).toEqual(
      expect.arrayContaining(['index.html', 'main.tsx', 'guard.test.ts']),
    );
    expect(pageSources(files).map(rel)).toEqual(expect.arrayContaining(['index.html', 'main.tsx']));
    // 例外只給這一行：它要是改寫成別的樣子，就該被上面那條擋下，而不是例外悄悄失效。
    expect(readFileSync(join(GUARD, 'main.tsx'), 'utf8')).toContain(THEME_LINE);
  });

  test('判準：class 的 JSX 屬性、HTML 屬性（不分大小寫）、props 物件與簡寫都抓得到；說明文字裡的 class 一詞不算', () => {
    expect(classUses('a', '<Button className="p-2" />')).toEqual(['a:1']);
    expect(classUses('a', '\n<div class="x">')).toEqual(['a:2']);
    expect(classUses('a', "createElement('div', { className: 'x' })")).toEqual(['a:1']);
    expect(classUses('a', "createElement('div', { className })")).toEqual(['a:1']);
    expect(classUses('a', '<div CLASS="x">')).toEqual(['a:1']);
    expect(classUses('a', '// 本頁不寫任何 class，版面只用 inline style')).toEqual([]);
  });

  test('判準：會改到量測值的行內樣式與注入都抓得到；版面與說明文字不算', () => {
    const caught = [
      "<p style={{ color: 'black' }}>",
      "<div style={{ backgroundColor: 'white' }}>",
      "<div style={{ background: 'white' }}>",
      "<div style={{ boxShadow: 'none' }}>",
      "<div style={{ outlineColor: 'red' }}>",
      '<div style={{ opacity: 0.5 }}>',
      "<div style={{ borderTopColor: 'red' }}>",
      "<div style={{ '--foreground': 'black' }}>",
      '<div style="color: black">',
      '<div style="box-shadow: none">',
      '<style>{`p { color: black }`}</style>',
      "el.style.setProperty('--card', 'red')",
      "el.style.color = 'red'",
      "el.style['color'] = 'red'",
      'document.adoptedStyleSheets = [sheet]',
    ];
    expect(caught.filter((line) => styleUses('a', line).length === 0)).toEqual([]);
    const allowed = [
      "const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 } as const;",
      "<main style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 24 }}>",
      '<div style={{ width: 360 }}>',
      "<SidebarProvider style={{ minHeight: 0, height: '100%' }}>",
      ' * - `data-guard-shadow`：亮色時量 `box-shadow` 每層投影的透明度。',
      `  ${THEME_LINE}`,
    ];
    expect(allowed.flatMap((line) => styleUses('a', line))).toEqual([]);
  });
});

describe('guardHtml：測試頁的 HTML 不准帶樣式表或 <style>', () => {
  const shipped = '<head><link rel="stylesheet" crossorigin href="/assets/index-abc.css"></head>';
  const page = (head: string) => `<html><head>${head}</head><body></body></html>`;

  test.each([
    ['雙引號的樣式表', '<link rel="stylesheet" href="x.css">'],
    ['單引號的樣式表', "<link rel='stylesheet' href='x.css'>"],
    ['不加引號的樣式表', '<link rel=stylesheet href=x.css>'],
    ['大寫的樣式表', '<LINK REL="STYLESHEET" HREF="x.css">'],
    ['<style>', '<style>[data-guard-text]{color:black !important}</style>'],
    ['大寫的 <STYLE>', '<STYLE>p{}</STYLE>'],
  ])('%s會拋', (_, head) => {
    expect(() => guardHtml(shipped, page(head))).toThrow(/自己帶了樣式/);
  });

  test('乾淨的頁面不拋，出貨的樣式表插在 </head> 前；註解裡提到的字樣不算', () => {
    const html = guardHtml(
      shipped,
      page('<title>t</title><!-- 出貨的 <link rel="stylesheet"> 與 <style> 插在這裡 -->'),
    );
    expect(html).toContain(
      '<link rel="stylesheet" crossorigin href="/assets/index-abc.css">\n</head>',
    );
  });

  test('出貨的 HTML 沒有樣式表就拋（還沒 build）', () => {
    expect(() => guardHtml('<head></head>', page(''))).toThrow(/先跑 build/);
  });
});
