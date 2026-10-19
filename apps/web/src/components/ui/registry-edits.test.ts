// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

import { GLYPH_RADIUS } from '@/test/glyph-env';

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

  test('message-scroller 的 item 由覆寫檔壓掉 content-visibility（會把陰影與光暈切成直角，§9；#1638 Q6，README 本地修改第 42 條）', () => {
    expect(read('../../styles/solid-glass.overrides.css')).toContain(
      '[data-slot="message-scroller-item"] {\n  content-visibility: visible;\n  contain-intrinsic-size: none;\n}',
    );
    // vendor 原文仍然是 auto。上游哪天自己拿掉，這條紅，提醒把本地修改拿掉。
    const vendor = code(read('../../vendor/solid-glass/components/ui/message-scroller.tsx'));
    expect(vendor).toMatch(
      /data-slot="message-scroller-item"[\s\S]{0,300}\[content-visibility:auto\]/,
    );
    // nexus 層沒有自己再寫一次（壓制只在覆寫檔一處）。
    expect(code(read('./message-scroller.tsx'))).not.toMatch(/content-visibility/);
  });

  test('不支援 scroll-driven 動畫時對話區不淡出：覆寫檔歸 0（#1638 PR B，README 本地修改第 43 條）', () => {
    expect(read('../../styles/solid-glass.overrides.css')).toContain(
      '@supports not (animation-timeline: scroll()) {\n  [data-slot="message-scroller-viewport"] {\n    --scroll-fade-t: 0px;\n    --scroll-fade-b: 0px;\n  }\n}',
    );
    // vendor 的 viewport 仍用 `scroll-fade-b`，它的退路仍是把淡出設成整段（常駐）。上游哪天改成不遮字，這條紅，提醒把本地修改拿掉。
    const vendor = code(read('../../vendor/solid-glass/components/ui/message-scroller.tsx'));
    expect(vendor).toMatch(/data-slot="message-scroller-viewport"[\s\S]{0,300}\bscroll-fade-b\b/);
    const utility = read('../../vendor/solid-glass/shadcn/tailwind.css');
    const fadeB = utility.slice(utility.indexOf('@utility scroll-fade-b {'));
    expect(fadeB.slice(0, fadeB.indexOf('\n}\n'))).toContain(
      '@supports not (animation-timeline: scroll()) {\n    --scroll-fade-b: var(--_scroll-fade-size-b);\n  }',
    );
  });

  test('問答選項的焦點外框畫在選項上：寫在覆寫檔、layer 外（#1638 PR C，README 本地修改第 46 條）', () => {
    expect(read('../../styles/solid-glass.overrides.css')).toContain(
      '[data-slot="questionnaire-choice"]:has(> input:focus-visible) {\n  outline: 2px solid var(--ring);\n}',
    );
    // vendor 原文仍然是 input 鋪滿、`opacity-0`，選項聚焦只有邊框與 ring（都被 SG 的玻璃規則蓋掉）。上游哪天自己畫了外框，這條紅。
    const vendor = code(read('../../vendor/solid-glass/components/ui/questionnaire.tsx'));
    expect(vendor).toContain(
      'has-[>input:focus-visible]:border-ring has-[>input:focus-visible]:ring-3',
    );
    expect(vendor).not.toMatch(/has-\[>input:focus-visible\]:outline-(?!none)/);
    expect(vendor).toMatch(/data-slot="questionnaire-choice-input"[\s\S]{0,200}\bopacity-0\b/);
  });

  describe('一排附件與上傳中的標題（#1638 PR C）', () => {
    const vendor = () => code(read('../../vendor/solid-glass/components/ui/attachment.tsx'));
    const utility = (name: string) => {
      const css = read('../../vendor/solid-glass/shadcn/tailwind.css');
      const from = css.slice(css.indexOf(`@utility ${name} {`));
      return from.slice(0, from.indexOf('\n}\n'));
    };

    test('第 47 條：不支援 scroll-driven 動畫時一排附件不淡出，覆寫檔歸 0；vendor 仍用 `scroll-fade-x`、退路仍是整段淡出', () => {
      expect(read('../../styles/solid-glass.overrides.css')).toContain(
        '@supports not (animation-timeline: scroll()) {\n  [data-slot="attachment-group"] {\n    --scroll-fade-s: 0px;\n    --scroll-fade-e: 0px;\n  }\n}',
      );
      // 上游哪天把退路改成不遮字，這條紅，提醒把本地修改拿掉。
      expect(vendor()).toMatch(/data-slot="attachment-group"[\s\S]{0,300}\bscroll-fade-x\b/);
      expect(utility('scroll-fade-x')).toContain(
        '@supports not (animation-timeline: scroll()) {\n    --scroll-fade-s: var(--_scroll-fade-size-s);\n    --scroll-fade-e: var(--_scroll-fade-size-e);\n  }',
      );
    });

    test('第 48 條：亮色的 shimmer 亮面換成次要字色；vendor 的標題仍用 `shimmer`、亮色亮面仍是字色的 20%', () => {
      expect(read('../../styles/solid-glass.overrides.css')).toContain(
        '[data-slot="attachment-title"]:not(.dark *) {\n  --shimmer-color: var(--muted-foreground);\n}',
      );
      expect(vendor()).toMatch(
        /data-slot="attachment-title"[\s\S]{0,300}group-data-\[state=uploading\]\/attachment:shimmer\b/,
      );
      // 上游哪天把亮面調到過門檻，這條紅，提醒把本地修改拿掉。
      expect(utility('shimmer')).toContain('oklch(from currentColor l c h / calc(alpha* 0.2))');
      expect(utility('shimmer')).toContain(
        '-webkit-text-fill-color: var(--shimmer-text-fill, transparent);',
      );
    });
  });

  test('message-scroller 自動捲動時只把捲軸變透明，不改捲軸寬（#1363；#1638 起讀 vendor 原文）', () => {
    // 寬度不變靠 vendor 原文：`scrollbar-thumb-*`／`scrollbar-track-*` 只設 `scrollbar-color`（Tailwind 4.3），上游哪天改成會動寬度的
    // 寫法，這條紅。`scrollbar-none`／`scrollbar-thin`／`scrollbar-auto` 與 `[scrollbar-width:…]`、`[scrollbar-gutter:…]` 都會改內容寬度。
    const width =
      /data-autoscrolling:(?:scrollbar-(?:none|thin|auto|gutter)|\[scrollbar-(?:width|gutter))/;
    const vendor = code(read('../../vendor/solid-glass/components/ui/message-scroller.tsx'));
    expect(vendor).not.toMatch(width);
    expect(vendor).toContain(
      'data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent',
    );
    expect(vendor).toContain('scrollbar-gutter-stable');
    // nexus 層也不加會動寬度的寫法。產物另由 `scripts/check-built-css.mjs` 掃。
    expect(code(read('./message-scroller.tsx'))).not.toMatch(width);
  });

  // SG 版 import `next-themes` 的 `useTheme`；第 49 條（`patches/0010-sonner-theme-prop.patch`）把它換成 `theme` prop（#1680）。
  test('sonner 不靠 next-themes（主題由呼叫端給，§6）', () => {
    expect(code(read('./sonner.tsx'))).not.toMatch(/next-themes/);
    expect(code(read('../../vendor/solid-glass/components/ui/sonner.tsx'))).not.toMatch(
      /next-themes/,
    );
    const pkg = JSON.parse(read('../../../package.json')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect({ ...pkg.dependencies, ...pkg.devDependencies }).not.toHaveProperty('next-themes');
  });

  // tool-steps 的覆寫檔五條（#1682 PR A，README 本地修改第 61–65 條）：覆寫檔那一段還在，vendor 原文仍是要蓋掉的那個樣子。
  // 上游哪天自己改掉，這裡紅，提醒把本地修改拿掉。畫出來的計算值在 `guard/`（`?overlay=tool-steps`）量。
  describe('tool-steps 的覆寫（#1682）', () => {
    const overrides = () => read('../../styles/solid-glass.overrides.css');
    const vendor = () => code(read('../../vendor/solid-glass/components/ui/tool-steps.tsx'));
    const reasoning = () => code(read('../../vendor/solid-glass/components/ui/reasoning.tsx'));

    test('第 61 條：執行中那一列不閃；vendor 仍在 running 時給按鈕 `animate-pulse`', () => {
      expect(overrides()).toContain(
        '[data-slot="step-row"] > button.animate-pulse {\n  animation-name: none;\n}',
      );
      expect(vendor()).toContain('step.status === "running" && "animate-pulse"');
    });

    test('第 62 條：結果框的 pre 聚焦時外框畫在外層；vendor 外層仍是 `overflow-hidden`', () => {
      expect(overrides()).toContain(
        '[data-slot="output-block"]:has(> pre:focus-visible) {\n  outline: 2px solid var(--ring);\n}',
      );
      expect(vendor()).toMatch(/data-slot="output-block"[\s\S]{0,120}\boverflow-hidden\b/);
    });

    test('第 63 條：1024 以下按鈕至少 44px；vendor 的按鈕仍沒有最小高度', () => {
      expect(overrides()).toContain(
        '@media (width < 64rem) {\n  [data-slot="step-row"] > button,\n  [data-slot="step-group"] > button,\n  [data-slot="reasoning"] > summary {\n    min-height: 2.75rem;\n  }\n}',
      );
      expect(vendor()).not.toMatch(/\bmin-h-/);
      // #1683 擴到思考過程的 summary：vendor 的 summary 同樣沒有最小高度。
      expect(reasoning()).not.toMatch(/\bmin-h-/);
    });

    test('第 64 條：減少動態時箭頭不轉場；vendor 的箭頭仍是 `transition-transform`、沒有 motion-reduce', () => {
      expect(overrides()).toContain(
        '@media (prefers-reduced-motion: reduce) {\n  [data-slot="step-row"] > button > svg,\n  [data-slot="step-group"] > button > svg,\n  [data-slot="reasoning"] > summary > svg {\n    transition-duration: 0s;\n  }\n}',
      );
      expect(vendor()).toContain('size-3.5 shrink-0 transition-transform');
      expect(vendor()).not.toMatch(/motion-reduce:/);
      // #1683 擴到思考過程 summary 裡的箭頭：vendor 同樣是 `transition-transform`、沒有 motion-reduce。
      expect(reasoning()).toContain('size-3.5 transition-transform group-open/reasoning:rotate-90');
      expect(reasoning()).not.toMatch(/motion-reduce:/);
    });

    test('第 65 條：疊在清單裡的結果框與 DiffView 不 blur；vendor 的清單、結果框、DiffView 仍都是 `glass-panel`', () => {
      expect(overrides()).toContain(
        '[data-slot="step-list"] [data-slot="output-block"],\n[data-slot="step-list"] [data-slot="diff-view"] {\n  -webkit-backdrop-filter: none;\n  backdrop-filter: none;\n}',
      );
      // #1685 B 擴到 DiffView：vendor 的 DiffView 是 `glass-panel`（patch 0024 把 tabIndex 插在 data-slot 與 className 之間）。
      expect(read('../../vendor/solid-glass/components/ui/diff-view.tsx')).toMatch(
        /data-slot="diff-view"[\s\S]{0,80}className=\{cn\("glass-panel\b/,
      );
      expect(vendor()).toMatch(/data-slot="output-block" className=\{cn\("glass-panel\b/);
      expect(vendor()).toMatch(/data-slot="step-list" className=\{cn\("glass-panel\b/);
    });

    test('第 66 條：段裡空的那一則連 SG 包的那層一起藏；vendor 仍替每個 child 包一層有 padding 的 div', () => {
      expect(overrides()).toContain(
        '[data-slot="step-list"] > div:has(> [data-slot="message-scroller-item"]:empty) {\n  display: none;\n}',
      );
      expect(vendor()).toContain(
        'React.Children.map(children, (child) => <div className="px-2.5 py-1.5">{child}</div>)',
      );
    });
  });

  // 思考過程的覆寫（#1683，README 本地修改第 70 條）：覆寫檔那一段還在，vendor 的 summary 仍是 `w-fit`。畫出來的寬度在 `guard/` 量。
  describe('reasoning 的覆寫（#1683）', () => {
    test('第 70 條：summary 不超出欄寬、標題不被擠；vendor 的 summary 仍是 `w-fit`、沒有 max-width，標題是第一個 span、沒有 shrink-0', () => {
      const reasoning = code(read('../../vendor/solid-glass/components/ui/reasoning.tsx'));
      expect(read('../../styles/solid-glass.overrides.css')).toContain(
        '[data-slot="reasoning"] > summary {\n  max-width: 100%;\n}',
      );
      expect(read('../../styles/solid-glass.overrides.css')).toContain(
        '[data-slot="reasoning"] > summary > span:first-child {\n  flex-shrink: 0;\n}',
      );
      expect(reasoning).toMatch(/<summary className="flex w-fit\b/);
      expect(reasoning).not.toMatch(/\bmax-w-/);
      // 標題是 summary 裡第一個 span、沒有 shrink-0（覆寫檔用 `span:first-child` 錨它）。
      expect(reasoning).toMatch(
        /<summary [^>]*>\s*<span className=\{cn\(thinking && "status-shimmer"\)\}>/,
      );
      expect(reasoning).not.toMatch(/\bshrink-0\b/);
    });
  });

  // 狀態列靠 vendor 原文的三件事（#1684）：glyph 是裝飾（狀態列的字已經講了，§8:284），label 帶 SG 的 shimmer，glyph 的半徑與畫法。
  // vendor 升版改了任一件，這裡紅：第一件會讓報讀器多唸、非文字對比的豁免不成立，第二件會讓 guard 的 shimmer 那條量錯對象，
  // 第三件會讓測試輔助（`src/test/glyph-env.ts`）與 guard 頁算出來的起始姿勢跟 vendor 畫的對不上。
  describe('turn-status 與 status-glyph 的 vendor 原文（#1684）', () => {
    test('glyph 的 svg 是 aria-hidden="true"', () => {
      const glyph = code(read('../../vendor/solid-glass/components/ui/status-glyph.tsx'));
      expect(glyph).toMatch(/<svg\s+ref=\{svg\}\s+data-slot="status-glyph"[^>]*aria-hidden="true"/);
    });

    test('glyph 的半徑是 1.7、`draw` 照四個屬性的寫法畫（測試輔助與 guard 頁的起始姿勢照抄這幾行）', () => {
      const glyph = code(read('../../vendor/solid-glass/components/ui/status-glyph.tsx'));
      expect(glyph).toContain(`const RADIUS = ${GLYPH_RADIUS}`);
      for (const line of [
        'circle.setAttribute("cx", dot.x.toFixed(2))',
        'circle.setAttribute("cy", dot.y.toFixed(2))',
        'circle.setAttribute("r", (RADIUS * dot.s).toFixed(2))',
        'circle.setAttribute("opacity", Math.max(0, Math.min(1, dot.o)).toFixed(2))',
      ])
        expect(glyph).toContain(line);
    });

    test('label 包在 status-shimmer 的 span 裡', () => {
      const status = code(read('../../vendor/solid-glass/components/ui/turn-status.tsx'));
      expect(status).toContain(
        '{label && <span className="status-shimmer truncate">{label}</span>}',
      );
    });
  });

  // 增刪行數的兩色（#1685 PR A，README 本地修改第 75 條）：覆寫檔那兩段還在，vendor 的 `DiffStats` 仍是兩個子 span、各自寫死
  // emerald／rose。vendor 升版改了結構（多一層、換順序），`span:first-child`／`:last-child` 就錨錯；畫出來的對比在 `guard/` 量。
  describe('diff-view 的覆寫（#1685）', () => {
    test('第 75 條：`+N` 是第一個子 span、`−M` 是最後一個，vendor 原色是 emerald-600／rose-600', () => {
      const diff = code(read('../../vendor/solid-glass/components/ui/diff-view.tsx'));
      expect(read('../../styles/solid-glass.overrides.css')).toContain(
        '[data-slot="diff-stats"] > span:first-child {\n  color: var(--success);\n}',
      );
      expect(read('../../styles/solid-glass.overrides.css')).toContain(
        '[data-slot="diff-stats"] > span:last-child {\n  color: var(--destructive);\n}',
      );
      expect(diff).toContain(
        '<span data-slot="diff-stats" className={cn("shrink-0 text-[12px] tabular-nums", className)}>\n' +
          '      <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}\n' +
          '      <span className="text-rose-600 dark:text-rose-400">−{removed}</span>\n' +
          '    </span>',
      );
    });

    test('第 80 條：DiffView 的 @@／...、新增、刪除行換成 token 字色；vendor 的行仍寫死這幾個 class', () => {
      const diff = code(read('../../vendor/solid-glass/components/ui/diff-view.tsx'));
      const overrides = read('../../styles/solid-glass.overrides.css');
      for (const [cls, token] of [
        ['text-muted-foreground/70', 'muted-foreground'],
        ['text-emerald-700', 'success'],
        ['text-rose-700', 'destructive'],
      ])
        expect(overrides).toContain(
          `[data-slot="diff-view"] > [class~="${cls}"] {\n  color: var(--${token});\n}`,
        );
      for (const line of [
        'line.startsWith("+") && "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"',
        'line.startsWith("-") && "bg-rose-500/10 text-rose-700 dark:text-rose-300"',
        'line.startsWith("@@") && "mt-1 text-muted-foreground/70 first:mt-0"',
        'line.startsWith("...") && "text-muted-foreground/70 italic"',
      ])
        expect(diff).toContain(line);
    });
  });

  // #1281 的三條（側欄、dropdown-menu、cmdk 的 text-ui）照 #1468 Q19 拿掉：dropdown-menu 與 cmdk 隨 #1583、側欄隨 #1680 換成 vendor 版。
});
