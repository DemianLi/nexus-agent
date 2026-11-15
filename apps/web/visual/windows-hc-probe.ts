/**
 * 一次性的探測：系統已經開了高對比的 Windows 上，不做任何模擬，逐頁看 `guard/` 測試頁。
 * 每頁記 `forced-colors` 有沒有生效、選取與面有沒有邊框或外框（判準同 `guard.test.ts`），並拍一張。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright-core';

import { startGuardServer } from '../guard/server.ts';

const out = resolve(process.argv[2] ?? 'hc');
mkdirSync(out, { recursive: true });

const SELECTED = [
  "[aria-selected='true']",
  "[data-selected='true']",
  "[aria-current]:not([aria-current='false'])",
  "[aria-pressed='true']",
  '[data-highlighted]',
  '[data-located]',
  "[data-popup-open]:not([data-slot='tooltip-trigger'])",
].join(',');
const PANES = '.bg-card,.bg-popover,.glass-panel';

const source = readFileSync(new URL('../guard/main.tsx', import.meta.url), 'utf8');
const names = [
  ...new Set(
    [...source.slice(source.indexOf('function OverlayPage')).matchAll(/case '([\w-]+)':/g)].map(
      (m) => m[1] ?? '',
    ),
  ),
];

const server = await startGuardServer();
/** 幾種開法各試一次，用第一個 `forced-colors` 真的生效的。 */
const ATTEMPTS = [
  { label: 'chrome 有頭', options: { channel: 'chrome', headless: false } },
  { label: 'edge 有頭', options: { channel: 'msedge', headless: false } },
  {
    label: 'chrome 有頭、不帶 Playwright 的預設參數',
    options: {
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: true,
      args: [
        '--remote-debugging-pipe',
        '--no-first-run',
        '--user-data-dir=' + join(out, 'profile'),
      ],
    },
  },
  { label: 'chrome 無頭', options: { channel: 'chrome', headless: true } },
  {
    label: 'chrome 有頭、強制高對比旗標',
    options: { channel: 'chrome', headless: false, args: ['--force-high-contrast'] },
  },
] as const;

let browser;
for (const attempt of ATTEMPTS) {
  try {
    const candidate = await chromium.launch({
      ...attempt.options,
      args: [...(('args' in attempt.options ? attempt.options.args : undefined) ?? [])],
    });
    // Playwright 預設把 forced-colors 模擬成 none；給 null 才是照系統的。
    const page = await candidate.newPage({ forcedColors: null });
    await page.goto('about:blank');
    const on = await page.evaluate(() => matchMedia('(forced-colors: active)').matches);
    await page.close();
    console.log(`${attempt.label}：forced-colors ${on ? '生效' : '沒生效'}`);
    if (on && browser === undefined && !attempt.label.includes('強制')) browser = candidate;
    else await candidate.close();
  } catch (error) {
    console.log(
      `${attempt.label}：開不起來（${error instanceof Error ? error.message.split('\n')[0] : String(error)}）`,
    );
  }
}
if (browser === undefined) {
  await server.close();
  console.log('沒有一種開法讓 forced-colors 生效');
  process.exit(1);
}
const results: Record<string, unknown> = {};
let active = 0;
try {
  for (const name of ['main', ...names]) {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 1000 },
      forcedColors: null,
    });
    try {
      await page.goto(`${server.url}?theme=light${name === 'main' ? '' : `&overlay=${name}`}`);
      await page.waitForFunction(
        () =>
          (document.getElementById('root')?.childElementCount ?? 0) > 0 ||
          document.body.querySelector(':scope > :not(#root):not(script)') !== null,
        undefined,
        { timeout: 15_000 },
      );
      await page.waitForTimeout(800);
      const result = await page.evaluate(
        ({ selected, panes }) => {
          const missing: string[] = [];
          const counts: Record<string, number> = {};
          for (const [kind, selector] of [
            ['選取', selected],
            ['面', panes],
          ] as const) {
            for (const el of document.querySelectorAll<HTMLElement>(selector)) {
              const box = el.getBoundingClientRect();
              const style = getComputedStyle(el);
              if (box.width === 0 || box.height === 0 || style.visibility === 'hidden') continue;
              const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
              const border = (['Top', 'Right', 'Bottom', 'Left'] as const).some(
                (side) =>
                  style[`border${side}Style`] !== 'none' &&
                  parseFloat(style[`border${side}Width`]) > 0,
              );
              counts[kind] = (counts[kind] ?? 0) + 1;
              if (!outline && !border) {
                missing.push(
                  `${kind} ${el.dataset['slot'] ?? el.getAttribute('role') ?? el.tagName.toLowerCase()}`,
                );
              }
            }
          }
          const body = getComputedStyle(document.body);
          return {
            forcedColors: matchMedia('(forced-colors: active)').matches,
            prefersContrast: matchMedia('(prefers-contrast: more)').matches,
            bodyColor: body.color,
            bodyBackground: body.backgroundColor,
            counts,
            missing,
          };
        },
        { selected: SELECTED, panes: PANES },
      );
      if (result.forcedColors) active += 1;
      results[name] = result;
      writeFileSync(join(out, `${name}.png`), await page.screenshot());
    } catch (error) {
      results[name] = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      await page.close();
    }
  }
} finally {
  writeFileSync(join(out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  await browser.close();
  await server.close();
}
const total = names.length + 1;
console.log(`${active}/${total} 頁的 forced-colors 生效`);
console.log(JSON.stringify(results, null, 2));
if (active !== total) process.exit(1);
