import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from 'playwright-core';
import { expect, test } from 'vitest';

import { browser, server, settle, type Theme } from '../guard/harness';
import { SHIPPED_DIST } from '../guard/server';

import { CATALOG_GROUPS, MAIN } from './pages';

/**
 * 給人看的元件目錄（`.docs/web-ui-spec.md` §13.5）：把 `guard/` 測試頁的每一個子頁在亮、暗各開一次，連同出貨的 CSS 與
 * token 的計算值寫成**一個**自足的 HTML（`catalog/dist/index.html`，不進版控）。跑法是 `pnpm --filter @nexus/web run catalog`。
 *
 * - 內容跟護欄量的是同一份：同一個測試頁、同一份出貨 CSS（`guard/server.ts`）。目錄自己不畫元件。
 * - 每一頁存的是畫完之後的 DOM，不帶 JS：看得到樣子、滑上去與聚焦的樣式照常，點了不會有反應。
 * - 字型不嵌：`@font-face` 拿掉，退回 CSS 字型堆疊裡的系統字。字寬會跟出貨的略有出入。
 * - 檔頭印 commit 與它的時間；工作樹有沒提交的改動時標「有未提交的改動」。
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OUT = join(HERE, 'dist', 'index.html');
const THEMES: Theme[] = ['light', 'dark'];
/** 同時開幾頁。 */
const BATCH = 6;

/** 子頁的名字照 `guard/main.tsx` 的 `OverlayPage` 列出來：那裡加了一頁，目錄就多一頁。 */
function overlayNames(): string[] {
  const source = readFileSync(join(HERE, '..', 'guard', 'main.tsx'), 'utf8');
  const body = source.slice(source.indexOf('function OverlayPage'));
  return [...new Set([...body.matchAll(/case '([\w-]+)':/g)].map((m) => m[1] ?? ''))];
}

interface Snapshot {
  htmlClass: string;
  colorScheme: string;
  bodyAttributes: string;
  body: string;
}

async function snapshot(name: string, theme: Theme): Promise<Snapshot> {
  if (browser === undefined || server === undefined) throw new Error('瀏覽器或伺服器沒起來');
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${server.url}?theme=${theme}${name === MAIN ? '' : `&overlay=${name}`}`);
    // 只有浮層的子頁畫在 portal 裡，`#root` 是空的。
    await page.waitForFunction(
      () =>
        (document.getElementById('root')?.childElementCount ?? 0) > 0 ||
        document.body.querySelector(':scope > :not(#root):not(script)') !== null,
    );
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await settle(page);
    return await page.evaluate(() => {
      // 欄位裡打的字是屬性不是 DOM，寫回去才存得下來。
      for (const input of document.querySelectorAll('input')) {
        input.setAttribute('value', input.value);
      }
      for (const area of document.querySelectorAll('textarea')) area.textContent = area.value;
      const body = document.body.cloneNode(true) as HTMLElement;
      for (const script of body.querySelectorAll('script')) script.remove();
      const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      return {
        htmlClass: document.documentElement.className,
        colorScheme: document.documentElement.style.colorScheme,
        bodyAttributes: [...document.body.attributes]
          .map((a) => ` ${a.name}="${escape(a.value)}"`)
          .join(''),
        body: body.innerHTML,
      };
    });
  } finally {
    await page.close();
  }
}

/** `:root`／`.dark`／`:host` 上宣告的自訂屬性，以及它們在這個主題下的值。 */
async function tokens(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const names = new Set<string>();
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule && /:root|\.dark|:host/.test(rule.selectorText)) {
          for (const property of rule.style) if (property.startsWith('--')) names.add(property);
        }
        if ('cssRules' in rule) walk(rule.cssRules as CSSRuleList);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    const style = getComputedStyle(document.documentElement);
    return Object.fromEntries(
      [...names].sort().map((name) => [name, style.getPropertyValue(name).trim()]),
    );
  });
}

async function tokensOf(theme: Theme): Promise<Record<string, string>> {
  if (browser === undefined || server === undefined) throw new Error('瀏覽器或伺服器沒起來');
  const page = await browser.newPage();
  try {
    await page.goto(`${server.url}?theme=${theme}&overlay=buttons`);
    await page.waitForSelector('[data-guard-button]');
    return await tokens(page);
  } finally {
    await page.close();
  }
}

/** 出貨的 CSS，拿掉 `@font-face`（字型檔不跟著走）。 */
function shippedCss(): string {
  const html = readFileSync(join(SHIPPED_DIST, 'index.html'), 'utf8');
  const hrefs = [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)].map(
    (m) => /\bhref="([^"]+)"/.exec(m[0])?.[1] ?? '',
  );
  const css = hrefs
    .map((href) => readFileSync(join(SHIPPED_DIST, href.replace(/^\.?\//, '')), 'utf8'))
    .join('\n')
    .replace(/@font-face\s*\{[^}]*\}/g, '');
  if (/<\/style/i.test(css)) throw new Error('出貨的 CSS 裡有 </style，內嵌會壞');
  return css;
}

function stamp(): { commit: string; date: string; dirty: boolean } {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: HERE }).toString().trim();
  return {
    commit: git('rev-parse', '--short=12', 'HEAD'),
    date: git('show', '-s', '--format=%cI', 'HEAD'),
    dirty: git('status', '--porcelain', '--', join(HERE, '..')) !== '',
  };
}

/** 目錄自己的殼：左邊選頁、上面切亮暗，右邊用 `iframe srcdoc` 畫存下來的那一頁。 */
const SHELL_STYLE = `
:root { color-scheme: light dark; font: 13px/1.5 system-ui, sans-serif; }
body { margin: 0; display: grid; grid-template: auto 1fr / 220px 1fr; height: 100vh; }
header { grid-column: 1 / -1; display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); }
header strong { font-size: 14px; }
header code { opacity: 0.7; }
header .dirty { color: #b45309; }
header .spacer { flex: 1; }
nav { overflow: auto; padding: 8px; border-right: 1px solid color-mix(in srgb, CanvasText 20%, Canvas); }
nav button, header button { font: inherit; }
nav button { display: block; width: 100%; text-align: left; padding: 4px 8px; border: 0; border-radius: 6px; background: none; color: inherit; cursor: pointer; }
nav button[aria-current='page'] { background: color-mix(in srgb, CanvasText 12%, Canvas); }
nav h2 { font-size: 11px; opacity: 0.6; margin: 12px 8px 4px; font-weight: 600; }
main { min-width: 0; min-height: 0; overflow: auto; }
iframe { width: 100%; height: 100%; border: 0; display: block; }
[hidden] { display: none; }
table { border-collapse: collapse; margin: 12px; }
td, th { text-align: left; padding: 3px 12px 3px 0; border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, Canvas); font-family: ui-monospace, monospace; font-size: 12px; vertical-align: middle; }
i.swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; margin-right: 6px; vertical-align: -2px; border: 1px solid color-mix(in srgb, CanvasText 25%, Canvas); }
`;

const SHELL_SCRIPT = `
const data = JSON.parse(document.getElementById('data').textContent);
const frame = document.getElementById('frame');
const table = document.getElementById('tokens');
const list = document.getElementById('list');
let theme = 'light';
let current = data.groups[0].pages[0][0];
const TOKENS = '#tokens';
const attr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const text = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function show() {
  for (const b of list.querySelectorAll('button')) {
    if (b.dataset.name === current) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  document.getElementById('theme').textContent = theme === 'light' ? '亮色' : '暗色';
  const tokens = current === TOKENS;
  frame.hidden = tokens;
  table.hidden = !tokens;
  if (tokens) {
    const rows = Object.keys(data.tokens.light).map((name) => {
      const cell = (value) =>
        '<td>' + (CSS.supports('color', value) ? '<i class="swatch" style="background:' + attr(value) + '"></i>' : '') + text(value) + '</td>';
      return '<tr><td>' + text(name) + '</td>' + cell(data.tokens.light[name]) + cell(data.tokens.dark[name] ?? '') + '</tr>';
    });
    table.innerHTML = '<tr><th>token</th><th>亮色</th><th>暗色</th></tr>' + rows.join('');
    return;
  }
  const p = data.pages[current][theme];
  frame.srcdoc =
    '<!doctype html><html lang="zh-Hant" class="' + attr(p.htmlClass) + '" style="color-scheme:' + attr(p.colorScheme) + '">' +
    '<head><meta charset="utf-8"><style>' + data.css + '</style></head>' +
    '<body' + p.bodyAttributes + '>' + p.body + '</body></html>';
}
const add = (name, label) => {
  const b = document.createElement('button');
  b.dataset.name = name;
  b.textContent = label;
  b.onclick = () => { current = name; show(); };
  list.append(b);
};
const heading = (label) => { const h = document.createElement('h2'); h.textContent = label; list.append(h); };
heading('token');
add(TOKENS, '全部 token');
for (const group of data.groups) {
  heading(group.label);
  for (const [name, label] of group.pages) add(name, label);
}
document.getElementById('theme').onclick = () => { theme = theme === 'light' ? 'dark' : 'light'; show(); };
show();
`;

test('產出元件目錄', async () => {
  const names = [MAIN, ...overlayNames()];
  // `OverlayPage` 換了寫法、一個 case 都讀不到時要紅，不要靜靜產出只剩總覽的目錄。
  expect(names.length).toBeGreaterThan(10);
  const jobs = names.flatMap((name) => THEMES.map((theme) => ({ name, theme })));
  const pages: Record<string, Partial<Record<Theme, Snapshot>>> = {};
  for (let i = 0; i < jobs.length; i += BATCH) {
    await Promise.all(
      jobs.slice(i, i + BATCH).map(async ({ name, theme }) => {
        (pages[name] ??= {})[theme] = await snapshot(name, theme);
      }),
    );
  }
  const empty = jobs
    .filter(({ name, theme }) => (pages[name]?.[theme]?.body.length ?? 0) < 200)
    .map(({ name, theme }) => `${name}:${theme}`);
  expect(empty).toEqual([]);

  const [light, dark] = await Promise.all(THEMES.map(tokensOf));
  expect(Object.keys(light ?? {}).length).toBeGreaterThan(50);

  // 沒排進 `pages.ts` 的子頁放最後一組、用原名，不靜靜漏掉。
  const grouped = new Set(CATALOG_GROUPS.flatMap((group) => group.pages.map(([name]) => name)));
  const rest = names.filter((name) => !grouped.has(name));
  const groups = [
    ...CATALOG_GROUPS.map((group) => ({
      label: group.label,
      pages: group.pages.filter(([name]) => names.includes(name)),
    })),
    ...(rest.length > 0 ? [{ label: '未分組', pages: rest.map((name) => [name, name]) }] : []),
  ].filter((group) => group.pages.length > 0);

  const { commit, date, dirty } = stamp();
  // `<` 一律跳脫：資料裡的 `</script>` 不會提早關掉這個 script。
  const data = JSON.stringify({
    groups,
    pages,
    tokens: { light, dark },
    css: shippedCss(),
  }).replace(/</g, '\\u003c');
  const html = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nexus-agent 元件目錄 ${commit}</title>
<style>${SHELL_STYLE}</style>
</head>
<body>
<header>
<strong>nexus-agent 元件目錄</strong>
<code>${commit}</code><span>${date}</span>${dirty ? '<span class="dirty">有未提交的改動</span>' : ''}
<span class="spacer"></span>
<button id="theme" type="button"></button>
</header>
<nav id="list"></nav>
<main><iframe id="frame" title="預覽"></iframe><table id="tokens" hidden></table></main>
<script type="application/json" id="data">${data}</script>
<script>${SHELL_SCRIPT}</script>
</body>
</html>
`;
  mkdirSync(join(HERE, 'dist'), { recursive: true });
  writeFileSync(OUT, html);
  console.log(
    `元件目錄：${OUT}（${names.length} 頁 × 亮暗，${Object.keys(light ?? {}).length} 個 token，${(html.length / 1024 / 1024).toFixed(1)} MB）`,
  );
}, 600_000);
