// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { readCascade } from './css-cascade';

/** 虛擬檔案：路徑一律在 `/v` 底下，入口 `/v/index.css`。 */
function cascadeOf(files: Record<string, string>) {
  return readCascade('/v/index.css', (path) => {
    const text = files[path];
    if (text === undefined) throw new Error(`讀了不該讀的檔：${path}`);
    return text;
  });
}

describe('css-cascade：誰贏', () => {
  test('(c1) 後 import 的本地檔蓋過前面的值', () => {
    const cascade = cascadeOf({
      '/v/index.css': "@import './a.css';\n@import './b.css';",
      '/v/a.css': ':root { --x: a; }',
      '/v/b.css': ':root { --x: b; }',
    });
    expect(cascade.files).toEqual(['index.css', 'a.css', 'b.css']);
    expect(cascade.value([':root'], '--x')).toBe('b');
  });

  test('(c2) 前面 layer 外的值，不會被後面 layer 裡的值蓋掉', () => {
    const cascade = cascadeOf({
      '/v/index.css': "@import './a.css';\n@import './b.css';",
      '/v/a.css': ':root { --x: outside; }',
      '/v/b.css': '@layer base { :root { --x: layered; } }',
    });
    expect(cascade.winner([':root'], '--x')).toMatchObject({
      value: 'outside',
      layer: null,
      file: 'a.css',
    });
  });

  test('(c3) 同一層裡後者贏', () => {
    const cascade = cascadeOf({
      '/v/index.css': "@import './a.css';\n@import './b.css';",
      '/v/a.css': '@layer base { :root { --x: first; } }',
      '/v/b.css': '@layer base { :root { --x: second; } }',
    });
    expect(cascade.winner([':root'], '--x')).toMatchObject({ value: 'second', layer: 'base' });
  });

  test('(c4) 被排除的套件 CSS 不展開', () => {
    const cascade = cascadeOf({
      '/v/index.css':
        "@import 'tailwindcss';\n@import '@fontsource-variable/x';\n:root { --x: ours; }",
      // 真的去讀的話，這兩份會蓋過我們的值。
      '/v/tailwindcss': ':root { --x: package; }',
      '/v/@fontsource-variable/x': ':root { --x: package; }',
    });
    expect(cascade.files).toEqual(['index.css']);
    expect(cascade.value([':root'], '--x')).toBe('ours');
  });

  test('(c5) 暗色時 `:root` 與 `.dark` 落在同一個元素：後面只寫 `:root` 的覆寫，也蓋過前面的 `.dark`', () => {
    const cascade = cascadeOf({
      '/v/index.css': "@import './vendor.css';\n@import './override.css';",
      '/v/vendor.css': ':root { --x: light; }\n.dark { --x: dark; }',
      '/v/override.css': ':root { --x: override; }',
    });
    expect(cascade.value([':root', '.dark'], '--x')).toBe('override');
  });

  test('(c6) layer 的先後照套件宣告的順序，不照我們的檔先寫到哪一層', () => {
    const cascade = cascadeOf({
      '/v/index.css':
        "@import 'tailwindcss';\n@layer components { :root { --x: components; } }\n@layer base { :root { --x: base; } }",
    });
    expect(cascade.layerOrder).toEqual(['theme', 'base', 'components', 'utilities']);
    expect(cascade.value([':root'], '--x')).toBe('components');
  });
});

describe('css-cascade：記法', () => {
  test('條件式的宣告預設不算，指定條件才算', () => {
    const cascade = cascadeOf({
      '/v/index.css':
        ':root { --x: base; }\n@media (prefers-reduced-transparency: reduce) { :root { --x: opaque; } }',
    });
    expect(cascade.value([':root'], '--x')).toBe('base');
    expect(
      cascade.value([':root'], '--x', {
        conditions: ['@media (prefers-reduced-transparency: reduce)'],
      }),
    ).toBe('opaque');
  });

  test('`@theme` 記在自己的選擇器底下，後面的贏；裡面的 @keyframes 略過', () => {
    const cascade = cascadeOf({
      '/v/index.css':
        '@theme { --font-mono: a; @keyframes k { from { opacity: 0; } } }\n@theme inline { --font-mono: b; }',
    });
    expect(cascade.winner(['@theme'], '--font-mono')).toMatchObject({ value: 'b', layer: 'theme' });
    expect(cascade.declarations.map((d) => d.property)).toEqual(['--font-mono', '--font-mono']);
  });

  test('選擇器清單拆開，括號裡的逗號不拆；空白收成一格', () => {
    const cascade = cascadeOf({
      '/v/index.css': ':root,\n  .x:is(a, b) { color: red; }',
    });
    expect(cascade.declarations.map((d) => d.selector)).toEqual([':root', '.x:is(a, b)']);
  });

  test('字串與括號裡的分號、大括號不算', () => {
    const cascade = cascadeOf({
      '/v/index.css': ".a { content: '; } {'; background: url(data:image/svg+xml;base64,AAAA); }",
    });
    expect(cascade.value(['.a'], 'content')).toBe("'; } {'");
    expect(cascade.value(['.a'], 'background')).toBe('url(data:image/svg+xml;base64,AAAA)');
  });

  test('computed 依同一組選擇器代換 var()，沒有值就用後備值', () => {
    const cascade = cascadeOf({
      '/v/index.css':
        ':root { --a: red; --b: var(--a); --c: var(--missing, var(--b)); }\n.dark { --a: blue; }',
    });
    expect(cascade.computed([':root'], '--c')).toBe('red');
    expect(cascade.computed([':root', '.dark'], '--c')).toBe('blue');
  });

  test('不支援的寫法直接拋錯，不靜默算錯', () => {
    expect(() => cascadeOf({ '/v/index.css': ':root { --x: a !important; }' })).toThrow(
      '!important',
    );
    expect(() => cascadeOf({ '/v/index.css': "@import 'unknown-package';" })).toThrow(
      '不認得的套件',
    );
    expect(() =>
      cascadeOf({ '/v/index.css': '@layer a { @layer b { :root { --x: a; } } }' }),
    ).toThrow('巢狀');
    expect(() =>
      cascadeOf({ '/v/index.css': "@import './a.css' layer(x);", '/v/a.css': '' }),
    ).toThrow('不支援這種 @import');
  });
});

describe('css-cascade：真的樹', () => {
  test('從 index.css 展開本地檔，套件不展開', () => {
    const cascade = readCascade();
    expect(cascade.files[0]).toBe('index.css');
    expect(cascade.files).toContain('styles/tokens.generated.css');
    expect(cascade.files).toContain('styles/theme.css');
    expect(cascade.files.some((f) => f.includes('node_modules') || !f.endsWith('.css'))).toBe(
      false,
    );
    expect(cascade.layerOrder.slice(0, 4)).toEqual(['theme', 'base', 'components', 'utilities']);
  });
});
