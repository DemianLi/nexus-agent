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
  test('input-group 的焦點外框畫在群組上：寫在覆寫檔、layer 外（#1279，README 本地修改第 15 條）', () => {
    // 本地修改所在的那一層：覆寫檔照抄 vendor 用的屬性選擇器，外框 2px 字色寫在 layer 外（offset 2px 在 base layer，`focus-outline.test.ts`）。
    const overrides = read('../../styles/solid-glass.overrides.css');
    expect(overrides).toContain(
      '[data-slot="input-group"]:has(:is([data-slot="input-group-control"], [data-slot="command-input"]):focus-visible) {\n  outline: 2px solid var(--ring);\n}',
    );
    // vendor 原文仍然是那樣：群組只有 `outline-none` 加 ring、沒有外框。上游哪天自己畫了外框，這條紅，提醒把本地修改拿掉。
    const vendor = code(read('../../vendor/solid-glass/components/ui/input-group.tsx'));
    expect(vendor).toMatch(/data-slot="input-group"[\s\S]{0,400}\boutline-none\b/);
    expect(vendor).toContain('has-[[data-slot=input-group-control]:focus-visible]:ring-3');
    expect(vendor).not.toMatch(
      /has-\[\[data-slot=input-group-control\]:focus-visible\]:outline-(?!none)/,
    );
  });

  test('input-group 只在欄位停用時變淡：按鈕停用不算，寫在覆寫檔、layer 外（#1523，README 本地修改第 18 條）', () => {
    const overrides = read('../../styles/solid-glass.overrides.css');
    expect(overrides).toContain(
      '[data-slot="input-group"]:has(:disabled):not(:has([data-slot="input-group-control"]:disabled)) {\n  opacity: 1;\n}',
    );
    // vendor 原文仍然是任何後代停用就整組變淡（`:has(:disabled)`）。上游改成只看欄位時這條紅，提醒把本地修改拿掉。
    const vendor = code(read('../../vendor/solid-glass/components/ui/input-group.tsx'));
    expect(vendor).toMatch(/data-slot="input-group"[\s\S]{0,1200}\bhas-disabled:opacity-50\b/);
  });

  test('command 的搜尋框在 vendor 原文仍是 InputGroup 包 `data-slot="command-input"`（#1583，README 本地修改第 15 條的擴充）', () => {
    // 覆寫檔第 15 條靠這個結構把外框畫在群組上；上游哪天換成 `input-group-control` 或拿掉群組，這條紅，提醒回頭看那條還要不要。
    const vendor = code(read('../../vendor/solid-glass/components/ui/command.tsx'));
    expect(vendor).toMatch(
      /<InputGroup\b[\s\S]{0,300}<CommandPrimitive\.Input\s+data-slot="command-input"/,
    );
  });

  test('command 的選項在 vendor 原文仍是 children 後面附一顆 CheckIcon（#1583，README 本地修改第 27 條）', () => {
    // 覆寫檔用 `> svg.lucide-check:last-child` 把它設成 display: none；上游哪天換位置或換圖示，這條紅。
    const overrides = read('../../styles/solid-glass.overrides.css');
    expect(overrides).toContain(
      '[data-slot="command-item"] > svg.lucide-check:last-child {\n  display: none;\n}',
    );
    const vendor = code(read('../../vendor/solid-glass/components/ui/command.tsx'));
    expect(vendor).toMatch(
      /data-slot="command-item"[\s\S]{0,800}\{children\}\s*<CheckIcon\b[^>]*\/>\s*<\/CommandPrimitive\.Item>/,
    );
  });

  describe('輸入框底列的 Pick 與用量環（#1591，README 本地修改第 35–39 條）', () => {
    const overrides = () => read('../../styles/solid-glass.overrides.css');
    const pick = () => code(read('../../vendor/solid-glass/components/ui/composer.tsx'));
    const ring = () => code(read('../../vendor/solid-glass/components/ui/context-ring.tsx'));

    test('第 35 條：「全開」的警示色寫在覆寫檔；vendor 的 Pick 仍沒有危險狀態、移上去換成字色', () => {
      expect(overrides()).toContain(
        '[data-slot="permission-pick"][data-danger="true"] [data-slot="dropdown-menu-trigger"]:not([aria-expanded="true"]) {\n  color: var(--warning);\n}',
      );
      // 上游哪天給 Pick 加了危險或警示的樣子，這條紅，提醒回頭看那條還要不要。
      expect(pick()).toMatch(/<DropdownMenuTrigger\b[\s\S]{0,400}\bhover:text-foreground\b/);
      expect(pick()).not.toMatch(/\b(?:danger|warning|destructive)\b/);
    });

    test('第 36 條：vendor 的 Pick 仍是 h-6、用量環仍是 size-6（24px，1024 以下由覆寫檔撐到 44px）', () => {
      expect(pick()).toMatch(/<DropdownMenuTrigger\b[\s\S]{0,400}\bh-6\b/);
      expect(ring()).toMatch(/data-slot="context-ring"[\s\S]{0,300}\bsize-6\b/);
    });

    test('第 37 條：用量環在 vendor 原文仍寫死 text-blue-500 與 text-amber-500（覆寫檔的選擇器錨在這兩個 class 上）', () => {
      expect(ring()).toContain('"text-amber-500" : "text-blue-500"');
      expect(overrides()).toContain(
        '[data-slot="context-ring"] svg.text-blue-500 {\n  color: var(--info);\n}',
      );
      expect(overrides()).toContain(
        '[data-slot="context-ring"] svg.text-amber-500 {\n  color: var(--warning);\n}',
      );
    });

    test('第 38 條：用量環的弧長在 vendor 原文仍走 500ms 的 transition', () => {
      expect(ring()).toContain('transition-[stroke-dasharray] duration-500');
    });

    test('第 39 條：vendor 的 Pick 沒有 aria-disabled 的樣子（鎖住的外觀由覆寫檔補）', () => {
      expect(pick()).not.toMatch(/aria-disabled:/);
      expect(overrides()).toContain('[data-slot="dropdown-menu-trigger"][aria-disabled="true"] {');
    });
  });

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

  // dropdown-menu 與 cmdk 那一半照 #1468 Q19 隨 #1583 換成 vendor 版拿掉；sidebar 這一半留給 ③-4。
  test('側欄的群組標題與 sm 選單鈕是 text-ui（#1281：標題與可點的字不小於 13）', () => {
    const sidebar = code(read('./sidebar.tsx'));
    expect(sidebar).toMatch(/data-sidebar="group-label"[\s\S]{0,200}\btext-ui\b/);
    expect(sidebar).toContain("sm: 'h-7 text-ui'");
    expect(sidebar).toContain("size === 'sm' && 'text-ui'");
  });

  test('附件 sm／xs 的檔名是 text-ui，說明那一行是 text-tip（#1281）', () => {
    const source = code(read('./attachment.tsx'));
    expect(source).toMatch(/sm: 'gap-2\.5 text-ui /);
    expect(source).toMatch(/xs: 'gap-1\.5 rounded-lg text-ui /);
    expect(source).toMatch(/data-slot="attachment-description"[\s\S]{0,200}\btext-tip\b/);
  });
});
