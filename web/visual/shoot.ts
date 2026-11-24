/**
 * 視覺回歸的拍照（#2766）：把 `guard/` 測試頁的總覽與每個子頁，亮暗各拍一張。
 *
 * 用法：`node visual/shoot.ts <web 目錄> <輸出目錄>`。`<web 目錄>` 要先 build 好出貨的 `dist/` 與 `guard/dist/`。
 * 伺服器與子頁清單都讀 `<web 目錄>` 自己的（`guard/server.ts`、`guard/main.tsx`），所以同一支腳本可以拍另一個 commit 的工作樹。
 * 單頁拍不成不中斷，記在 `errors.json`。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';

interface GuardServerModule {
  startGuardServer(): Promise<{ url: string; close(): Promise<void> }>;
}

const THEMES = ['light', 'dark'] as const;
const MAIN = 'main';
/** 同時開幾頁。 */
const BATCH = 4;
/** 頁面的時鐘釘在這裡，畫出來的日期時間不跟著拍的當下變。 */
const CLOCK = new Date('2026-01-15T03:00:00Z');

const [webArg, outArg] = process.argv.slice(2);
if (webArg === undefined || outArg === undefined) {
  throw new Error('用法：node visual/shoot.ts <web 目錄> <輸出目錄>');
}
const web = resolve(webArg);
const out = resolve(outArg);

function overlayNames(): string[] {
  const source = readFileSync(join(web, 'guard', 'main.tsx'), 'utf8');
  const body = source.slice(source.indexOf('function OverlayPage'));
  return [...new Set([...body.matchAll(/case '([\w-]+)':/g)].map((m) => m[1] ?? ''))];
}

/** 有限長度的動畫與轉場跑完（同 `guard/harness.ts` 的 `settle`）。 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter(
        (a) =>
          a.timeline instanceof DocumentTimeline &&
          a.effect?.getComputedTiming().endTime !== Infinity,
      );
    await Promise.all(finite.map((a) => a.finished.catch(() => undefined)));
  });
}

/** 等焦點落定：會自動聚焦的畫面（command）拍早了，焦點樣子時有時無。連續三次看到同一個元素才算。 */
async function focusSettled(page: Page): Promise<void> {
  await page.evaluate(async () => {
    let last: Element | null = null;
    let same = 0;
    for (let i = 0; i < 30 && same < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const now = document.activeElement;
      same = now === last ? same + 1 : 0;
      last = now;
    }
  });
}

async function shoot(browser: Browser, url: string, name: string, theme: string): Promise<void> {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    timezoneId: 'Asia/Taipei',
    reducedMotion: 'reduce',
  });
  try {
    await page.clock.setFixedTime(CLOCK);
    await page.goto(`${url}?theme=${theme}${name === MAIN ? '' : `&overlay=${name}`}`);
    // 只有浮層的子頁 `#root` 是空的，內容 portal 到 body 底下。
    await page.waitForFunction(
      () =>
        (document.getElementById('root')?.childElementCount ?? 0) > 0 ||
        document.body.querySelector(':scope > :not(#root):not(script)') !== null,
      undefined,
      { timeout: 15_000 },
    );
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await settle(page);
    await focusSettled(page);
    await settle(page);
    writeFileSync(
      join(out, `${theme}-${name}.png`),
      await page.screenshot({ animations: 'disabled', caret: 'hide' }),
    );
  } finally {
    await page.close();
  }
}

mkdirSync(out, { recursive: true });
const { startGuardServer } = (await import(
  pathToFileURL(join(web, 'guard', 'server.ts')).href
)) as GuardServerModule;
const server = await startGuardServer();
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors: Record<string, string> = {};
try {
  const jobs = [MAIN, ...overlayNames()].flatMap((name) =>
    THEMES.map((theme) => ({ name, theme })),
  );
  for (let i = 0; i < jobs.length; i += BATCH) {
    await Promise.all(
      jobs.slice(i, i + BATCH).map(({ name, theme }) =>
        shoot(browser, server.url, name, theme).catch((error: unknown) => {
          errors[`${theme}-${name}`] = error instanceof Error ? error.message : String(error);
        }),
      ),
    );
  }
  writeFileSync(join(out, 'errors.json'), `${JSON.stringify(errors, null, 2)}\n`);
  console.log(
    `拍了 ${jobs.length - Object.keys(errors).length} 張，${Object.keys(errors).length} 張沒拍成 → ${out}`,
  );
} finally {
  await browser.close();
  await server.close();
}
