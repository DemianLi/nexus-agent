// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { embedShadowCss, toShadowCss } from '../../embed-shadow-css';

describe('toShadowCss', () => {
  it('@font-face 與 @property 拿到 document 那份，連 @layer 裡的也拿', () => {
    const css =
      '@font-face{font-family:G;src:url(a.woff2)}' +
      '@layer base{@property --tw-x{syntax:"*";inherits:false}.a{color:red}}' +
      '.b{color:blue}';
    const { shadow, document } = toShadowCss(css);
    expect(document).toContain('@font-face{font-family:G;src:url(a.woff2)}');
    expect(document).toContain('@property --tw-x{syntax:"*";inherits:false}');
    expect(shadow).not.toMatch(/@font-face|@property/u);
    expect(shadow).toContain('@layer base{.a{color:red}}');
    expect(shadow).toContain('.b{color:blue}');
  });

  it(':root、html、body 換成 wrapper，:root:root 保留兩倍', () => {
    const { shadow } = toShadowCss(
      ':root{--a:1}:root,:host{--b:2}html,:host{x:1}body{y:1}:root:root *{z:1}' +
        '.markdown tbody tr{w:1}.x>body{v:1}',
    );
    expect(shadow).toBe(
      '.nexus-root{--a:1}.nexus-root,:host{--b:2}.nexus-root,:host{x:1}.nexus-root{y:1}' +
        '.nexus-root.nexus-root *{z:1}.markdown tbody tr{w:1}.x>.nexus-root{v:1}',
    );
  });

  it('只看寬度的 @media 換成 @container，其餘不換', () => {
    const { shadow } = toShadowCss(
      '@media (width>=64rem){.a{b:1}}' +
        '@media (min-width:768px) and (max-width:1024px){.c{d:1}}' +
        '@media (hover:hover){.e{f:1}}' +
        '@media (prefers-reduced-motion:reduce){.g{h:1}}' +
        '@media (width>=40rem) and (hover:hover){.i{j:1}}',
    );
    expect(shadow).toContain('@container nexus (width>=64rem){.a{b:1}}');
    expect(shadow).toContain('@container nexus (min-width:768px) and (max-width:1024px){');
    expect(shadow).toContain('@media (hover:hover){.e{f:1}}');
    expect(shadow).toContain('@media (prefers-reduced-motion:reduce){');
    expect(shadow).toContain('@media (width>=40rem) and (hover:hover){');
  });
});

describe('embedShadowCss 外掛', () => {
  const [drop, rewrite] = embedShadowCss();

  it('元件裡直接 import 的 KaTeX 樣式換成空模組，?inline 的不換', () => {
    const resolveId = drop?.resolveId as (source: string) => string | undefined;
    const load = drop?.load as (id: string) => string | undefined;
    const empty = resolveId('katex/dist/katex.min.css');
    expect(empty).toBeDefined();
    expect(load(empty ?? '')).toBe('export {};');
    expect(resolveId('katex/dist/katex.min.css?inline')).toBeUndefined();
    expect(resolveId('./a.css')).toBeUndefined();
  });

  it('?inline 的模組改寫成兩份匯出', () => {
    const transform = rewrite?.transform as (
      code: string,
      id: string,
    ) => { code: string } | undefined;
    const out = transform(
      `export default ${JSON.stringify(':root{--a:1}@font-face{font-family:G}')}`,
      '/x/index.css?inline',
    );
    expect(out?.code).toBe(
      'export default ".nexus-root{--a:1}";\nexport const documentCss = "@font-face{font-family:G}";\n',
    );
    expect(transform('export default 1', '/x/a.ts')).toBeUndefined();
  });

  it('產物裡有 .css 檔就讓建置失敗', () => {
    const generateBundle = rewrite?.generateBundle as unknown as (
      this: { error(message: string): never },
      options: unknown,
      bundle: Record<string, unknown>,
    ) => void;
    const context = {
      error(message: string): never {
        throw new Error(message);
      },
    };
    expect(() => generateBundle.call(context, {}, { 'embed.js': {}, 'assets/a.css': {} })).toThrow(
      /assets\/a\.css/u,
    );
    expect(() => generateBundle.call(context, {}, { 'embed.js': {} })).not.toThrow();
  });
});
