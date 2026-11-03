/**
 * 嵌入版 `<nexus-chat>` 的真瀏覽器 e2e（#2366）：Vue 測試頁（`embed-demo/`）放上元件，元件由 serve 供應（`dist/embed.js`），
 * 模型換成腳本（`serve.ts`）。一般回覆、核准、反問、新對話四個情境，外加情境標籤、樣式不外洩、焦點在 shadow root 裡，以及跟宿主頁的 3D 模型同時操作。
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

/** 測試頁的 3D 模型（`embed-demo/ModelView.vue`）目前的視角。 */
function view(page: Page): Promise<{ yaw: number; pitch: number; distance: number }> {
  return page.evaluate(() => window.__model!.view());
}

/** 設備在模型上的位置（頂面中心，視窗座標）。 */
function devicePoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  return page.evaluate((device) => window.__model!.point(device), id);
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
    const page = await openDemo([{ content: '收到，這是 serve 的腳本回覆。' }]);
    await send(page, '你好');
    await expect
      .poll(() => transcript(page).getByText('收到，這是 serve 的腳本回覆。').count(), {
        timeout: 30_000,
      })
      .toBe(1);
    await settled(page);
    const keys = () =>
      page.evaluate(() => [
        localStorage.getItem('nexus.embed.threads.current'),
        localStorage.getItem('nexus.threads.current'),
      ]);
    await shot(page, 'new-conversation-before');
    const [embedBefore, standaloneBefore] = await keys();
    await chat(page).getByRole('button', { name: '新對話' }).click();
    await expect.poll(() => transcript(page).count()).toBe(0);
    const [embedAfter, standaloneAfter] = await keys();
    expect(embedAfter).not.toBe(embedBefore);
    // 登入網址開過的獨立頁面記的那一條不動。
    expect(standaloneAfter).toBe(standaloneBefore);
    await send(page, '換一條');
    await expect
      .poll(() => transcript(page).getByText('收到，這是 serve 的腳本回覆。').count(), {
        timeout: 30_000,
      })
      .toBe(1);
    await settled(page);
    await page.reload();
    await expect
      .poll(() => transcript(page).getByText('換一條').count(), { timeout: 30_000 })
      .toBe(1);
    await expect.poll(() => transcript(page).getByText('你好').count()).toBe(0);
    await shot(page, 'new-conversation');
  });

  test('跟 3D 模型互動：點選帶出情境、拖曳與滾輪各管各的、打字不觸發宿主頁的快捷鍵', async () => {
    const reply = '收到，這是 serve 的腳本回覆。';
    const page = await openDemo([{ content: reply, tokenDelayMs: 120 }], {
      width: 1280,
      height: 800,
    });
    const label = (text: string) => chat(page).getByText(`目前選取：${text}`);

    // 在模型上點一台：宿主頁的選取、左邊清單、元件的情境標籤一起變。
    const b07 = await devicePoint(page, 'B-07');
    await page.mouse.click(b07.x, b07.y);
    await expect.poll(() => label('B-07 壓縮機').count()).toBe(1);
    expect(
      await page.getByRole('button', { name: /B-07 壓縮機/u }).getAttribute('aria-pressed'),
    ).toBe('true');

    // 拖曳是轉視角，不是點選。
    const before = await view(page);
    const stage = page.getByRole('img', { name: /設備 3D 模型/u });
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + box.height - 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + box.height - 60, { steps: 8 });
    await page.mouse.up();
    expect((await view(page)).yaw).not.toBe(before.yaw);
    expect(await label('B-07 壓縮機').count()).toBe(1);

    // 對話框裡打字（含 w、a、s、d）不會轉動或縮放模型；焦點在模型上時按 d 照常轉。
    const rotated = await view(page);
    const textbox = chat(page).getByRole('textbox', { name: '要說的話' });
    await textbox.click();
    await page.keyboard.type('wasd 這台現在怎樣');
    expect(await textbox.inputValue()).toBe('wasd 這台現在怎樣');
    expect(await view(page)).toEqual(rotated);
    await stage.focus();
    await page.keyboard.press('d');
    expect((await view(page)).yaw).toBeGreaterThan(rotated.yaw);

    // 滾輪：在對話框上不縮放模型，在模型上才縮放。
    const zoomed = await view(page);
    const panel = (await chat(page).boundingBox())!;
    await page.mouse.move(panel.x + panel.width / 2, panel.y + panel.height / 3);
    await page.mouse.wheel(0, 400);
    expect((await view(page)).distance).toBe(zoomed.distance);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    expect((await view(page)).distance).toBeLessThan(zoomed.distance);

    // 回覆還沒串完時照樣能轉模型、換選取（轉之前、轉之後都確認回覆還沒完整出現）；回覆照常串完。
    await chat(page).getByRole('button', { name: '送出', exact: true }).click();
    await expect.poll(() => transcript(page).getByText('wasd 這台現在怎樣').count()).toBe(1);
    expect(await transcript(page).getByText(reply).count()).toBe(0);
    const streaming = await view(page);
    await page.mouse.move(box.x + 60, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(box.x + 160, box.y + 90, { steps: 6 });
    await page.mouse.up();
    expect((await view(page)).yaw).not.toBe(streaming.yaw);
    expect(await transcript(page).getByText(reply).count()).toBe(0);
    const a12 = await devicePoint(page, 'A-12');
    await page.mouse.click(a12.x, a12.y);
    await expect.poll(() => label('A-12 冷卻泵').count()).toBe(1);
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await settled(page);
    await shot(page, 'model-interaction');

    // 點模型上的空地清掉選取，情境標籤跟著拿掉。
    await page.mouse.click(box.x + 12, box.y + 12);
    await expect
      .poll(() =>
        chat(page)
          .getByText(/^目前選取：/u)
          .count(),
      )
      .toBe(0);
  });
});
