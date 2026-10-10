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

  test.each(['./dialog.tsx', './alert-dialog.tsx', './sheet.tsx', './tooltip.tsx'])(
    '%s 的進出場時長走 motion.css 的 token，不寫數字（#1280）',
    (path) => {
      const source = code(read(path));
      expect(source).toMatch(/animation-duration-\(--duration-[a-z-]+\)/);
      expect(source).not.toMatch(/(?<![-\w])(?:animation-)?duration-\d/);
    },
  );

  test('message-scroller 的 item 沒有 content-visibility（會把陰影與光暈切成直角，§9）', () => {
    expect(code(read('./message-scroller.tsx'))).not.toMatch(/content-visibility/);
  });

  test('message-scroller 自動捲動時只把捲軸變透明，不改捲軸寬（#1363）', () => {
    const source = code(read('./message-scroller.tsx'));
    // `scrollbar-none`／`scrollbar-thin`／`scrollbar-auto` 與 `[scrollbar-width:…]`、`[scrollbar-gutter:…]` 都會改內容寬度。
    expect(source).not.toMatch(
      /data-autoscrolling:(?:scrollbar-(?:none|thin|auto|gutter)|\[scrollbar-(?:width|gutter))/,
    );
    expect(source).toContain('data-autoscrolling:[scrollbar-color:transparent_transparent]');
    expect(source).toContain('scrollbar-gutter-stable');
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

  test('按鈕與下拉選單沒有小字，xs 按鈕是 text-ui（#1281：可點的字不小於 13）', () => {
    for (const path of ['./button.tsx', './dropdown-menu.tsx']) {
      expect(code(read(path)), path).not.toMatch(/text-(?:tip|micro)\b/);
    }
    expect(code(read('./button.tsx'))).toMatch(/xs: "h-6 [^"]*\btext-ui\b/);
  });

  test('側欄的群組標題與 sm 選單鈕、cmdk 的群組標題是 text-ui（#1281：標題與可點的字不小於 13）', () => {
    const sidebar = code(read('./sidebar.tsx'));
    expect(sidebar).toMatch(/data-sidebar="group-label"[\s\S]{0,200}\btext-ui\b/);
    expect(sidebar).toContain("sm: 'h-7 text-ui'");
    expect(sidebar).toContain("size === 'sm' && 'text-ui'");
    expect(code(read('./command.tsx'))).toContain('[&_[cmdk-group-heading]]:text-ui');
  });

  test('附件 sm／xs 的檔名是 text-ui，說明那一行是 text-tip（#1281）', () => {
    const source = code(read('./attachment.tsx'));
    expect(source).toMatch(/sm: 'gap-2\.5 text-ui /);
    expect(source).toMatch(/xs: 'gap-1\.5 rounded-lg text-ui /);
    expect(source).toMatch(/data-slot="attachment-description"[\s\S]{0,200}\btext-tip\b/);
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
