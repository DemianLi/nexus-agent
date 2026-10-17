// @vitest-environment node
import { readFileSync } from 'node:fs';

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

/** 那個讀者看到的字型清單，一個家族一項、去掉引號。 */
function stack(
  property: string,
  selectors: readonly string[],
  cascade: Cascade = readCascade(),
): string[] {
  const value = cascade.value(selectors, property);
  if (value === undefined) throw new Error(`${selectors.join(' ')} 都沒有 ${property}`);
  return value.split(',').map((family) => family.trim().replace(/^['"]|['"]$/g, ''));
}

function monoStack(selectors: readonly string[], cascade?: Cascade): string[] {
  return stack('--font-mono', selectors, cascade);
}

/** SG 堆疊裡的簡體中文字型（`solid-glass.css` 的 `--font-sans`），#1468 Q6 拿掉。 */
const SIMPLIFIED = ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei'];

describe.each(READERS)('字型堆疊（#1468 Q6）：%s', (_reader, selectors) => {
  it('介面 Geist，中文接 Noto Sans TC', () => {
    expect(stack('--font-sans', selectors).slice(0, 2)).toEqual([
      'Geist Variable',
      'Noto Sans TC Variable',
    ]);
  });

  it('等寬 Geist Mono → 系統等寬（Consolas、Menlo）→ Noto Sans TC：系統等寬接住兩個子集都沒有的字，排在中文字型前面', () => {
    expect(monoStack(selectors).slice(0, 4)).toEqual([
      'Geist Mono Variable',
      'Consolas',
      'Menlo',
      'Noto Sans TC Variable',
    ]);
  });

  it('系統後備是繁中的 PingFang TC、Microsoft JhengHei，沒有 SG 的簡體字型', () => {
    for (const property of ['--font-sans', '--font-mono']) {
      const families = stack(property, selectors);
      expect(families).toEqual(expect.arrayContaining(['PingFang TC', 'Microsoft JhengHei']));
      expect(families.filter((family) => SIMPLIFIED.includes(family))).toEqual([]);
    }
  });
});

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
    const families = monoStack(selectors);
    expect(families.indexOf('monospace')).toBe(families.length - 4);
  });
});

/** `fonts.css` 打包的字型：家族、檔案、unicode-range。 */
const FACES = [
  ...readFileSync(new URL('./styles/fonts.css', import.meta.url), 'utf8').matchAll(
    /@font-face\s*\{([\s\S]*?)\}/g,
  ),
].map(([, body = '']) => ({
  family: /font-family:\s*'([^']+)'/.exec(body)?.[1],
  file: /url\('([^']+)'\)/.exec(body)?.[1],
  range: /unicode-range:\s*([^;]+);/.exec(body)?.[1]?.replace(/\s+/g, ' ').trim(),
}));

describe('打包的字型子集（#1468 Q6，#1512 demian 拍板加 symbols2）', () => {
  it('只有 Geist latin、Geist Mono symbols2 與 latin 三條，都從本地的 fontsource 套件打包', () => {
    expect(FACES.map((face) => [face.family, face.file])).toEqual([
      ['Geist Variable', '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'],
      [
        'Geist Mono Variable',
        '@fontsource-variable/geist-mono/files/geist-mono-symbols2-wght-normal.woff2',
      ],
      [
        'Geist Mono Variable',
        '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2',
      ],
    ]);
  });

  it('symbols2 涵蓋方框字元 U+2500–259F（程式碼的樹狀圖與框線）', () => {
    expect(FACES[1]?.range).toBe('U+2000-2001, U+2004-2008, U+200A, U+23B8-23BD, U+2500-259F');
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
