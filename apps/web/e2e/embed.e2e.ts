/**
 * 嵌入版 `<nexus-chat>` 的真瀏覽器 e2e（#2366）：Vue 測試頁（`embed-demo/`）放上元件，元件由 serve 供應（`dist/embed.js`），
 * 模型換成腳本（`serve.ts`）。一般回覆、核准、反問、新對話四個情境，外加情境標籤、樣式不外洩、焦點在 shadow root 裡。
 *
 * 測試頁不進 `dist`：`beforeAll` 建到暫存目錄，`page.route` 從 serve 同一個來源供應（`/vue-demo/`），跟宿主頁經同源反向代理
 * 接上 serve 的部署一樣同源（地圖 #2365 第 5 點）。設 `NEXUS_E2E_SHOTS=<目錄>` 時每個情境跑完存一張截圖。
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { startE2eServe, type E2eServe, type ScriptTurn } from './serve';

const DEMO_CONFIG = fileURLToPath(new URL('../embed-demo/vite.config.ts', import.meta.url));
const SHOTS = process.env.NEXUS_E2E_SHOTS;
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

let browser: Browser;
let demo: string;
let serve: E2eServe | undefined;

beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'nexus-embed-demo-'));
  await build({ configFile: DEMO_CONFIG, logLevel: 'warn', build: { outDir: demo } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

afterAll(async () => {
  await browser.close();
  await rm(demo, { recursive: true, force: true });
});

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

/** 起一台 serve，開登入網址換到 cookie，再開同源的 Vue 測試頁。 */
async function openDemo(
  turns: readonly ScriptTurn[],
  viewport = { width: 1100, height: 760 },
): Promise<Page> {
  serve = await startE2eServe(turns);
  const page = await browser.newPage({ viewport });
  await page.goto(serve.url);
  const origin = new URL(serve.url).origin;
  await page.route(`${origin}/vue-demo/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/vue-demo\/?/u, '');
    const file = join(demo, path === '' ? 'index.html' : path);
    await route.fulfill({
      body: await readFile(file),
      contentType: TYPES[extname(file)] ?? 'application/octet-stream',
    });
  });
  await page.goto(`${origin}/vue-demo/`);
  await expect
    .poll(() => page.evaluate(() => customElements.get('nexus-chat') !== undefined))
    .toBe(true);
  return page;
}

function chat(page: Page) {
  return page.locator('nexus-chat');
}

function transcript(page: Page) {
  return chat(page).getByRole('log');
}

async function send(page: Page, text: string): Promise<void> {
  await chat(page).getByRole('textbox', { name: '要說的話' }).fill(text);
  await chat(page).getByRole('button', { name: '送出', exact: true }).click();
}

async function settled(page: Page): Promise<void> {
  await expect
    .poll(() => chat(page).getByRole('status').first().textContent(), { timeout: 30_000 })
    .toBe('就緒');
}

/** shadow root 裡聚焦的那個元素：`data-slot`，沒有就是標籤名。焦點不在 shadow root 裡是 `null`。 */
function focused(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const active = document.querySelector('nexus-chat')?.shadowRoot?.activeElement;
    return active === null || active === undefined
      ? null
      : (active.getAttribute('data-slot') ?? active.tagName.toLowerCase());
  });
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS === undefined) return;
  await mkdir(SHOTS, { recursive: true });
  // 等亮暗切換、面板進場這些轉場跑完，不截到中間那一格。無限循環的（shimmer、轉圈）與跟著捲動走的（捲動區邊緣的淡出）永遠不會結束，不算。
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (document.querySelector('nexus-chat')?.shadowRoot?.getAnimations() ?? []).filter(
            (animation) =>
              animation.playState === 'running' &&
              animation.timeline instanceof DocumentTimeline &&
              animation.effect?.getTiming().iterations !== Infinity,
          ).length,
      ),
    )
    .toBe(0);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

describe('Vue 頁面裡的 <nexus-chat>', () => {
  test('一般回覆串完；情境標籤跟著宿主頁的選取；宿主頁的樣式進不來', async () => {
    const reply = '這是從 serve 串過來的腳本回覆。';
    const page = await openDemo([{ content: reply, tokenDelayMs: 20 }]);
    await page.getByRole('button', { name: 'A-12 冷卻泵' }).click();
    await expect.poll(() => chat(page).getByText('目前選取：A-12 冷卻泵').count()).toBe(1);
    await send(page, '這台現在的溫度？');
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await settled(page);
    // 宿主頁把所有 button 塗成橘底、所有 p 寫成橘字；元件裡的不受影響。
    const colors = await page.evaluate(() => {
      const root = document.querySelector('nexus-chat')?.shadowRoot;
      const button = root?.querySelector('button');
      const paragraph = root?.querySelector('p');
      return [
        button === null || button === undefined ? null : getComputedStyle(button).backgroundColor,
        paragraph === null || paragraph === undefined ? null : getComputedStyle(paragraph).color,
      ];
    });
    expect(colors).not.toContain('rgb(194, 65, 12)');
    expect(colors).not.toContain(null);
    // 字型在 document 層註冊（shadow root 裡的 `@font-face` 不生效）：介面字型真的載入了。
    await expect
      .poll(() => page.evaluate(() => document.fonts.check('13px "Geist Variable"')))
      .toBe(true);
    await shot(page, 'reply-light');
    await page.getByRole('combobox', { name: '主題' }).selectOption('dark');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document
              .querySelector('nexus-chat')
              ?.shadowRoot?.querySelector('.nexus-root')
              ?.classList.contains('dark') ?? false,
        ),
      )
      .toBe(true);
    // 亮暗只掛在元件裡，不改宿主頁的 `<html>`。
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      false,
    );
    await shot(page, 'reply-dark');
  });

  test('核准中斷，按核准後這一輪結束，焦點回到輸入框', async () => {
    const page = await openDemo([
      {
        content: '我把這一筆寫進去。',
        toolCalls: [
          { name: 'submit_record', args: { file_path: '/visitors.csv', record: { 姓名: '阿明' } } },
        ],
      },
      { content: '已經寫進 /visitors.csv。' },
    ]);
    await send(page, '幫我登記阿明');
    const approval = chat(page).getByRole('region', { name: '等待核准：submit_record' });
    const approve = approval.getByRole('button', { name: '全部核准' });
    await expect.poll(() => approve.count(), { timeout: 30_000 }).toBe(1);
    await shot(page, 'approval-pending');
    await approve.click();
    await expect
      .poll(() => transcript(page).getByText('已經寫進 /visitors.csv。').count(), {
        timeout: 30_000,
      })
      .toBe(1);
    await expect.poll(() => approval.count(), { timeout: 30_000 }).toBe(0);
    await settled(page);
    await expect.poll(() => focused(page)).toBe('textarea');
    await shot(page, 'approval-done');
  });

  test('反問：選了答案送出，模型接著回', async () => {
    const page = await openDemo(
      [
        {
          content: '先確認一下。',
          toolCalls: [
            {
              name: 'ask_user_question',
              args: {
                questions: [
                  {
                    id: 'device',
                    question: '你問的是哪一台？',
                    options: [{ label: 'A-12 冷卻泵' }, { label: 'B-07 壓縮機' }],
                  },
                ],
              },
            },
          ],
        },
        { content: '好，查 B-07 壓縮機。' },
      ],
      { width: 420, height: 760 },
    );
    await send(page, '那台的狀態？');
    const panel = chat(page).getByRole('region', { name: '有 1 個問題要你回答' });
    await expect.poll(() => panel.count(), { timeout: 30_000 }).toBe(1);
    // 輸入框被面板換掉，焦點交給面板宣告的位置（第一題）。
    await expect.poll(() => focused(page)).toBe('questionnaire-item');
    await shot(page, 'question-narrow');
    await panel.getByRole('radio', { name: /B-07 壓縮機/u }).click();
    await panel.getByRole('button', { name: '送出答案' }).click();
    await expect
      .poll(() => transcript(page).getByText('好，查 B-07 壓縮機。').count(), { timeout: 30_000 })
      .toBe(1);
    await settled(page);
    await shot(page, 'question-done');
  });

  test('新對話開一條空的；重新整理接著那一條', async () => {
    const page = await openDemo([{ content: '第一條的回覆。' }]);
    await send(page, '你好');
    await expect
      .poll(() => transcript(page).getByText('第一條的回覆。').count(), { timeout: 30_000 })
      .toBe(1);
    await settled(page);
    const keys = () =>
      page.evaluate(() => [
        localStorage.getItem('nexus.embed.threads.current'),
        localStorage.getItem('nexus.threads.current'),
      ]);
    const [embedBefore, standaloneBefore] = await keys();
    await chat(page).getByRole('button', { name: '新對話' }).click();
    await expect.poll(() => transcript(page).count()).toBe(0);
    const [embedAfter, standaloneAfter] = await keys();
    expect(embedAfter).not.toBe(embedBefore);
    // 登入網址開過的獨立頁面記的那一條不動。
    expect(standaloneAfter).toBe(standaloneBefore);
    await send(page, '換一條');
    await expect
      .poll(() => transcript(page).getByText('第一條的回覆。').count(), { timeout: 30_000 })
      .toBe(1);
    await settled(page);
    await page.reload();
    await expect
      .poll(() => transcript(page).getByText('換一條').count(), { timeout: 30_000 })
      .toBe(1);
    await shot(page, 'new-conversation');
  });
});
