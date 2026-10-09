// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * registry 檔裝進來之後改過、而且改回去時**畫面不會報錯**的地方（#404）。重跑 `shadcn add` 或手滑貼回
 * registry 原文時在這裡紅。
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('registry 檔的改動還在', () => {
  test('input-group 的焦點外框明寫 outline-solid：自帶的 outline-none 會把樣式記成 none（#1279）', () => {
    expect(code(read('./input-group.tsx'))).toContain(
      'has-[[data-slot=input-group-control]:focus-visible]:outline-solid',
    );
  });

  test('message-scroller 的 item 沒有 content-visibility（會把陰影與光暈切成直角，§9）', () => {
    expect(code(read('./message-scroller.tsx'))).not.toMatch(/content-visibility/);
  });

  test('sonner 不靠 next-themes（主題由呼叫端給，§6）', () => {
    expect(code(read('./sonner.tsx'))).not.toMatch(/next-themes/);
    const pkg = JSON.parse(read('../../../package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty('next-themes');
  });

  test('attachment 不用我們沒有的工具類，字級走階梯（#733）', () => {
    const source = code(read('./attachment.tsx'));
    // `scrollbar-none`、`scroll-fade-x`、`shimmer`：registry 的 CSS 才有，我們沒有——寫了不會報錯，只是靜靜沒有樣式。
    expect(source).not.toMatch(/scrollbar-none|scroll-fade-x/);
    expect(source).not.toMatch(/(?<![-\w])shimmer/);
    expect(source).not.toMatch(/\btext-(xs|sm|base|lg)\b/);
    expect(source).toContain('text-shimmer');
    expect(source).toContain("from '@/lib/utils'");
  });

  test('dropdown-menu 字級走階梯、浮層用 shadow-menu 不用 registry 原文的 border＋shadow-md（#633）', () => {
    const source = code(read('./dropdown-menu.tsx'));
    expect(source).not.toMatch(/\btext-(xs|sm|base|lg)\b/);
    expect(source).toContain('shadow-menu');
    expect(source).not.toMatch(/shadow-md|(?<![-\w])border(?![-\w])/);
    expect(source).toContain("from '@/lib/utils'");
  });

  test('alert-dialog 字級走階梯、按鈕走我們的 buttonVariants（#437）', () => {
    const source = code(read('./alert-dialog.tsx'));
    expect(source).not.toMatch(/\btext-(xs|sm|base|lg)\b/);
    expect(source).toContain('buttonVariants');
    expect(source).toContain("from '@/lib/utils'");
    // 原型 tag 的 dialog 改法：`bg-card`＋`shadow-menu`，不用 registry 原文的 border＋shadow-lg。
    expect(source).toContain('shadow-menu');
    expect(source).not.toMatch(/shadow-lg/);
  });
});
