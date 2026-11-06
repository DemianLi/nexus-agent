/**
 * 嵌入版 `<nexus-chat>` 的真瀏覽器 e2e（#2366）：Vue 測試頁（`embed-demo/`）放上元件，元件由 serve 供應（`dist/embed.js`），
 * 模型換成腳本（`serve.ts`）。一般回覆、核准、反問、新對話四個情境，外加情境標籤、樣式不外洩、焦點在 shadow root 裡，以及跟宿主頁的 3D 模型同時操作。
 * 元件打 `/embed` 底下的路徑、送出時附上選取，獨立頁面開的對話在元件裡打不開（#2382）。
 *
 * 測試頁不進 `dist`：`beforeAll` 建到暫存目錄，`page.route` 從 serve 同一個來源供應（`/vue-demo/`），跟宿主頁經同源反向代理
 * 接上 serve 的部署一樣同源（地圖 #2365 第 5 點）。設 `NEXUS_E2E_SHOTS=<目錄>` 時每個情境跑完存一張截圖。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/**
 * 起一台 serve，開登入網址換到 cookie，再開同源的 Vue 測試頁。
 *
 * @param beforeDemo - 登入之後、開測試頁之前在同一頁做的事（例如先在獨立頁面講一句）。
 * @param extraRows - 交給 `startE2eServe` 的額外 patch 列。
 */
async function openDemo(
  turns: readonly ScriptTurn[],
  viewport = { width: 1100, height: 760 },
  beforeDemo?: (page: Page) => Promise<void>,
  extraRows?: string,
): Promise<Page> {
  serve = await startE2eServe(turns, extraRows);
  const page = await browser.newPage({ viewport });
  await page.goto(serve.url);
  await beforeDemo?.(page);
  await gotoDemo(page, new URL(serve.url).origin);
  return page;
}

/** 從 serve 同一個來源供應 Vue 測試頁並開它，等到元件註冊好。 */
async function gotoDemo(page: Page, origin: string): Promise<void> {
  await page.route(`${origin}/vue-demo/**`, async (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/vue-demo\/?/u, '');
    const file = join(demo, path === '' ? 'index.html' : path);
    await route.fulfill({
      body: await readFile(file),
      contentType: TYPES[extname(file)] ?? 'application/octet-stream',
    });
  });
  await page.goto(`${origin}/vue-demo/`);
  await defined(page);
}

async function defined(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => customElements.get('nexus-chat') !== undefined))
    .toBe(true);
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

  test('在模型上點選設備後發問：請求走 /embed、run.start 帶著選取；清掉選取之後送的不帶', async () => {
    const page = await openDemo(
      [
        { content: 'B-07 壓縮機目前負載 91 %，屬於高負載。', tokenDelayMs: 20 },
        { content: '目前沒有未處理的告警。', tokenDelayMs: 20 },
      ],
      { width: 1280, height: 800 },
    );
    const paths: string[] = [];
    const starts: { readonly params: Record<string, unknown> }[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      paths.push(pathname);
      const body = request.postData();
      if (request.method() === 'POST' && body !== null && body.includes('"run.start"')) {
        starts.push(JSON.parse(body) as { params: Record<string, unknown> });
      }
    });
    const sockets: string[] = [];
    page.on('websocket', (socket) => sockets.push(new URL(socket.url()).pathname));
    // 監聽掛上之前元件已經開過線：重新整理一次，從頭記。
    await page.reload();
    await expect.poll(() => sockets).toEqual(['/embed/threads/mux']);

    const b07 = await devicePoint(page, 'B-07');
    await page.mouse.click(b07.x, b07.y);
    await expect.poll(() => chat(page).getByText('目前選取：B-07 壓縮機').count()).toBe(1);
    await send(page, '它現在的負載多少？');
    await expect
      .poll(
        () =>
          transcript(page)
            .getByText(/負載 91 %/u)
            .count(),
        { timeout: 30_000 },
      )
      .toBe(1);
    await settled(page);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.params.context).toEqual({ label: 'B-07 壓縮機' });
    // 畫面上的那一句只有使用者打的字，情境不混進對話紀錄。
    expect(await transcript(page).getByText('它現在的負載多少？', { exact: true }).count()).toBe(1);
    // 截圖時把抓到的請求本文疊在宿主頁左下角（只在這張截圖裡，不是測試頁的功能）。
    await page.evaluate(
      (body) => {
        const pre = document.createElement('pre');
        pre.textContent = `e2e 擷取的 run.start 請求：\n${body}`;
        pre.style.cssText =
          'position:fixed;left:12px;bottom:12px;max-width:560px;margin:0;padding:8px 10px;font:12px/1.4 monospace;white-space:pre-wrap;background:#0f172a;color:#e2e8f0;border-radius:6px;z-index:10';
        document.body.append(pre);
      },
      JSON.stringify(starts[0]?.params, null, 1),
    );
    await shot(page, 'context-sent');
    await page.evaluate(() => document.querySelector('body > pre')?.remove());

    const box = (await page.getByRole('img', { name: /設備 3D 模型/u }).boundingBox())!;
    await page.mouse.click(box.x + 12, box.y + 12);
    await expect
      .poll(() =>
        chat(page)
          .getByText(/^目前選取：/u)
          .count(),
      )
      .toBe(0);
    await send(page, '今天有哪些告警？');
    await expect
      .poll(() => transcript(page).getByText('目前沒有未處理的告警。').count(), {
        timeout: 30_000,
      })
      .toBe(1);
    expect(starts).toHaveLength(2);
    expect(starts[1]?.params).not.toHaveProperty('context');
    // thread 那一族全在 `/embed` 底下，沒有一條打到獨立頁面的 `/threads`。
    expect(paths.filter((path) => path.startsWith('/threads'))).toEqual([]);
    expect(paths.some((path) => path.startsWith('/embed/threads/'))).toBe(true);
  });

  test('空白畫面：元件不提拖檔，獨立頁面會提（#2384）', async () => {
    const page = await openDemo([{ content: '不會用到。' }], undefined, async (standalone) => {
      await expect.poll(() => standalone.getByText('在下面打字，或把檔案拖進來。').count()).toBe(1);
      await expect
        .poll(() => standalone.getByRole('status').first().textContent(), { timeout: 30_000 })
        .toBe('就緒');
      await shot(standalone, 'empty-standalone');
    });
    await expect.poll(() => chat(page).getByText('在下面打字。', { exact: true }).count()).toBe(1);
    expect(await chat(page).getByText(/拖/u).count()).toBe(0);
    await settled(page);
    await shot(page, 'empty-embedded');
  });

  test('獨立頁面開的對話：元件打開時講專用的那一句，按「新對話」就能接著用', async () => {
    const reply = '這是獨立頁面的回覆。';
    const page = await openDemo([{ content: reply }], undefined, async (standalone) => {
      await standalone.getByRole('textbox', { name: '要說的話' }).fill('你好');
      await standalone.getByRole('button', { name: '送出', exact: true }).click();
      // 獨立頁面上這一句出現不只一處，只看有沒有出現。
      await expect
        .poll(() => standalone.getByText(reply).count(), { timeout: 30_000 })
        .toBeGreaterThan(0);
      // 讓元件記住的那一條換成獨立頁面這一條（同一個網域上兩邊的鍵被換過）。
      await standalone.evaluate(() =>
        localStorage.setItem(
          'nexus.embed.threads.current',
          localStorage.getItem('nexus.threads.current') ?? '',
        ),
      );
    });
    const status = chat(page).getByRole('status').first();
    await expect
      .poll(() => status.textContent(), { timeout: 30_000 })
      .toMatch(/^這條對話是在完整的對話頁開的.*請按「新對話」開一條新的。$/u);
    // 不畫成一般的錯誤：沒有 server 的原文，也沒有錯誤列（`alert`）。
    expect(
      await chat(page)
        .getByText(/不是從嵌入的對話框開的/u)
        .count(),
    ).toBe(0);
    expect(await chat(page).getByRole('alert').count()).toBe(0);
    expect(await transcript(page).getByText(reply).count()).toBe(0);
    await shot(page, 'thread-not-embedded');

    await chat(page).getByRole('button', { name: '新對話' }).click();
    await settled(page);
    await send(page, '換一條');
    // 腳本每條 thread 從第一輪開始吃：新的這一條拿到的也是第一輪那句。
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
  });

  test('元件開的對話：獨立頁面的歷史清單裡看得到，點開看得到那一輪（#2365 第 6 點）', async () => {
    const question = '嵌入版開的這一條';
    const reply = '這是元件裡的回覆。';
    const page = await openDemo([{ content: reply }], { width: 1280, height: 800 });
    await send(page, question);
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await settled(page);

    await page.goto(`${new URL(serve!.url).origin}/`);
    const row = page.getByTestId('thread-title-text').getByText(question, { exact: true });
    await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
    await row.click();
    // 獨立頁面上這一句出現不只一處，只看有沒有出現。
    await expect
      .poll(() => page.getByRole('log').getByText(reply).count(), { timeout: 30_000 })
      .toBeGreaterThan(0);
    await shot(page, 'embed-thread-in-standalone-history');
  });
});

/** serve 的 `host-tools` 那一列（`apps/harness/cordis.serve.yml`）：免核准的名單與宿主頁幾毫秒沒回就當逾時。 */
function hostToolsRow(config: { readonly exempt: readonly string[]; readonly timeoutMs?: number }) {
  return `- id: host-tools\n  config: ${JSON.stringify({
    approval: { exempt: config.exempt },
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
  })}\n`;
}

/**
 * 讓測試頁收不到 `nexus-host-tool`：在 window 的捕獲階段攔下來、留著 `detail`，模擬宿主頁沒掛監聽或一直不回。事件不 bubble，但捕獲階段照樣經過 window。
 */
async function silenceHost(page: Page): Promise<void> {
  await page.evaluate(() => {
    const held: unknown[] = [];
    (window as unknown as { __held: unknown[] }).__held = held;
    window.addEventListener(
      'nexus-host-tool',
      (event) => {
        event.stopImmediatePropagation();
        held.push((event as CustomEvent).detail);
      },
      { capture: true },
    );
  });
}

function heldCalls(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __held: unknown[] }).__held.length);
}

/** 設備在畫面上的水平位置離 3D 模型正中間多遠（像素）。 */
async function offCenter(page: Page, id: string): Promise<number> {
  const box = await page.locator('canvas.model').boundingBox();
  if (box === null) throw new Error('找不到 3D 模型');
  const point = await devicePoint(page, id);
  return Math.abs(point.x - (box.x + box.width / 2));
}

describe('宿主頁工具（#2374）', () => {
  test('模型轉到 B-07（免核准）、核准後高亮 C-03，結果交回，模型接著回', async () => {
    const reply = '已經轉到 B-07，C-03 也標出來了。';
    const page = await openDemo(
      [
        {
          content: '先轉過去。',
          toolCalls: [{ name: 'page__focus_device', args: { id: 'B-07' } }],
        },
        {
          content: '再把 C-03 標出來。',
          toolCalls: [{ name: 'page__highlight_device', args: { id: 'C-03' } }],
        },
        { content: reply },
      ],
      undefined,
      undefined,
      hostToolsRow({ exempt: ['focus_device'] }),
    );
    await settled(page);
    expect(await offCenter(page, 'B-07')).toBeGreaterThan(20);
    await send(page, '轉到 B-07，再把 C-03 標出來');
    const approval = chat(page).getByRole('region', { name: '等待核准：page__highlight_device' });
    const approve = approval.getByRole('button', { name: '全部核准' });
    await expect.poll(() => approve.count(), { timeout: 30_000 }).toBe(1);
    // 轉鏡頭在名單上，沒問就執行了：B-07 已經在正中間。
    expect(await offCenter(page, 'B-07')).toBeLessThan(1);
    expect(await chat(page).getByText('目前選取：C-03 感測器').count()).toBe(0);
    await shot(page, 'host-tool-approval');
    await approve.click();
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await settled(page);
    expect(
      await page.getByRole('region', { name: '選取的設備' }).getByRole('heading').textContent(),
    ).toBe('C-03 感測器');
    expect(await chat(page).getByText('目前選取：C-03 感測器').count()).toBe(1);
    expect(await transcript(page).getByText('頁面工具：focus_device').count()).toBeGreaterThan(0);
    expect(await chat(page).getByRole('alert').count()).toBe(0);
    await shot(page, 'host-tool-done');
  });

  test('宿主頁不回：逾時交回模型，這一輪接著跑，畫面不動', async () => {
    const reply = '頁面沒有回應，畫面沒有轉過去。';
    const page = await openDemo(
      [
        {
          content: '先轉過去。',
          toolCalls: [{ name: 'page__focus_device', args: { id: 'B-07' } }],
        },
        { content: reply },
      ],
      undefined,
      undefined,
      hostToolsRow({ exempt: ['focus_device'], timeoutMs: 2_000 }),
    );
    await settled(page);
    await silenceHost(page);
    const before = await view(page);
    await send(page, '轉到 B-07');
    await expect.poll(() => heldCalls(page), { timeout: 30_000 }).toBe(1);
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await settled(page);
    expect(await view(page)).toEqual(before);
    await shot(page, 'host-tool-timeout');
  });

  test('按停止：等宿主頁的那一支收回，之後才交回的結果丟掉、模型不再接著回', async () => {
    const reply = '這一句不該出現。';
    const page = await openDemo(
      [
        {
          content: '先轉過去。',
          toolCalls: [{ name: 'page__focus_device', args: { id: 'B-07' } }],
        },
        { content: reply },
      ],
      undefined,
      undefined,
      hostToolsRow({ exempt: ['focus_device'] }),
    );
    await settled(page);
    await silenceHost(page);
    await send(page, '轉到 B-07');
    await expect.poll(() => heldCalls(page), { timeout: 30_000 }).toBe(1);
    const stop = chat(page).getByRole('button', { name: '停止' });
    await expect.poll(() => stop.count(), { timeout: 30_000 }).toBe(1);
    await stop.click();
    await expect.poll(() => stop.count(), { timeout: 30_000 }).toBe(0);
    // 停止之後才交回：server 回 no_such_interrupt，元件不寫狀態列，模型也不再被叫。
    await page.evaluate(() =>
      (window as unknown as { __held: { respond(result: unknown): void }[] }).__held[0]?.respond({
        focused: 'B-07',
      }),
    );
    await page.waitForTimeout(1_000);
    expect(await transcript(page).getByText(reply).count()).toBe(0);
    expect(await chat(page).getByRole('alert').count()).toBe(0);
    await shot(page, 'host-tool-stopped');
  });
});

/** 先講一句拿到回覆，再講一句停在核准點：核准卡比輸入框高，第一則回覆被往上推、捲出捲動區頂端（#2407）。 */
const APPROVAL_AFTER_REPLY: readonly ScriptTurn[] = [
  { content: '收到，這是 serve 經代理回的腳本回覆。' },
  {
    content: '我把這一筆寫進去。',
    toolCalls: [
      { name: 'submit_record', args: { file_path: '/visitors.csv', record: { 姓名: '阿明' } } },
    ],
  },
];

/** 嵌入版或獨立頁面上的對話捲動區；嵌入版在 `nexus-chat` 的 shadow root 裡。 */
type Surface = { readonly page: Page; readonly embedded: boolean };

/** 捲動區的淡出：`mask-image` 的色標（頂層逗號切開），與頂端淡出那條捲動驅動動畫的進度（沒有這條是 `null`）。 */
interface Fade {
  readonly stops: readonly string[];
  readonly topProgress: number | null;
}

/**
 * 捲動區的捲動位置設成 `scrollTop`（`'straddle'`：讓第一則回覆的第一行跨在頂端的切邊上），等捲動驅動的動畫跟上，
 * 回傳那時的淡出。
 */
function scrollAndReadFade(
  { page, embedded }: Surface,
  scrollTop: number | 'straddle',
): Promise<Fade> {
  return page.evaluate(
    async ({ embedded, scrollTop }) => {
      const root: ParentNode = embedded
        ? document.querySelector('nexus-chat')!.shadowRoot!
        : document;
      const viewport = root.querySelector<HTMLElement>('[data-slot="message-scroller-viewport"]')!;
      if (scrollTop === 'straddle') {
        const reply = [...root.querySelectorAll('p')].find((element) =>
          element.textContent?.startsWith('收到'),
        )!;
        const range = document.createRange();
        range.selectNodeContents(reply);
        const line = range.getClientRects()[0]!;
        viewport.scrollTop -= viewport.getBoundingClientRect().top - line.top - line.height / 2;
      } else {
        viewport.scrollTop = scrollTop;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      const mask = getComputedStyle(viewport).maskImage;
      const body = mask.slice(mask.indexOf('(') + 1, mask.lastIndexOf(')'));
      const stops: string[] = [];
      let depth = 0;
      let current = '';
      for (const char of body) {
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === ',' && depth === 0) {
          stops.push(current.trim());
          current = '';
        } else {
          current += char;
        }
      }
      stops.push(current.trim());
      const reveal = viewport
        .getAnimations()
        .find(
          (animation) =>
            animation instanceof CSSAnimation && animation.animationName === 'scroll-fade-reveal-t',
        );
      const progress = reveal?.effect?.getComputedTiming().progress;
      return { stops, topProgress: progress ?? null };
    },
    { embedded, scrollTop },
  );
}

const TRANSPARENT = 'rgba(0, 0, 0, 0)';

/** 頂端有淡出：漸層從透明開始，而且頂端淡出的動畫已經往前走（捲在最上面時進度是 0，淡出寬 0）。 */
function fadesAtTop({ stops, topProgress }: Fade): boolean {
  return stops[0]?.startsWith(TRANSPARENT) === true && topProgress !== null && topProgress > 0;
}

async function stopAtApproval(surface: Surface): Promise<void> {
  const scope = surface.embedded ? chat(surface.page) : surface.page;
  const say = async (text: string) => {
    await scope.getByRole('textbox', { name: '要說的話' }).fill(text);
    await scope.getByRole('button', { name: '送出', exact: true }).click();
  };
  await say('你好');
  // 送出前狀態列就是「就緒」：先等第一則回覆出現，不然第二句會按在這一輪剛長出來的「停止」上。
  await expect
    .poll(() => scope.getByRole('button', { name: '複製回覆' }).count(), { timeout: 30_000 })
    .toBe(1);
  await expect
    .poll(() => scope.getByRole('status').first().textContent(), { timeout: 30_000 })
    .toBe('就緒');
  await say('幫我登記阿明');
  await expect
    .poll(() => scope.getByRole('button', { name: '全部核准' }).count(), { timeout: 30_000 })
    .toBe(1);
}

describe('核准卡把對話往上推：捲動區頂端淡出（#2407）', () => {
  test('嵌入版窄欄：捲到一行跨在頂端時那一行淡出，捲到最上面不淡出；底部淡出照舊', async () => {
    const page = await openDemo(APPROVAL_AFTER_REPLY, { width: 1400, height: 724 });
    const surface = { page, embedded: true };
    await stopAtApproval(surface);
    const straddled = await scrollAndReadFade(surface, 'straddle');
    expect(fadesAtTop(straddled), JSON.stringify(straddled)).toBe(true);
    expect(straddled.stops.at(-1)).toBe(`${TRANSPARENT} 100%`);
    await shot(page, 'approval-top-fade-embedded');
    const top = await scrollAndReadFade(surface, 0);
    expect(fadesAtTop(top), JSON.stringify(top)).toBe(false);
  });

  test('獨立頁面：捲到一行跨在頂端時那一行淡出', async () => {
    serve = await startE2eServe(APPROVAL_AFTER_REPLY);
    const page = await browser.newPage({ viewport: { width: 1100, height: 560 } });
    await page.goto(serve.url);
    const surface = { page, embedded: false };
    await stopAtApproval(surface);
    const straddled = await scrollAndReadFade(surface, 'straddle');
    expect(fadesAtTop(straddled), JSON.stringify(straddled)).toBe(true);
    await shot(page, 'approval-top-fade-standalone');
    expect(fadesAtTop(await scrollAndReadFade(surface, 0))).toBe(false);
  });
});

describe('換票登入（#2370）', () => {
  const EMBED_LOGIN = `- id: embed-login
  config:
    embedders:
      - id: crm
    ticketTtlSeconds: 60
    cookieMaxAgeSeconds: 900
`;

  /** 起一台開了換票的 serve，對應表上有 crm 的 alice 與 bob；回傳替其中一位換一張票的函式。 */
  async function startWithEmbedLogin(turns: readonly ScriptTurn[]) {
    serve = await startE2eServe(turns, EMBED_LOGIN, async (home) => {
      const mappings = [
        { embedder: 'crm', subject: 'alice', userId: 'alice' },
        { embedder: 'crm', subject: 'bob', userId: 'bob' },
      ];
      await writeFile(
        join(home, 'embed-identities.json'),
        JSON.stringify({ version: 1, mappings }),
        { mode: 0o600 },
      );
    });
    const origin = new URL(serve.url).origin;
    const credential = (await readFile(join(serve.home, 'embed-credential-crm'), 'utf8')).trim();
    const ticket = async (subject = 'alice'): Promise<string> => {
      const response = await fetch(`${origin}/embed/exchange`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ subject, sessionId: `crm-session-${subject}` }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { ticket: string }).ticket;
    };
    return { origin, ticket };
  }

  /**
   * 不經 `page.route` 的宿主頁：先開 serve 一個不用登入的路徑，在同一個來源上用 DOM 放進元件（`page.setContent` 放的元素不會升級）。
   * `gotoDemo` 那一頁是 `page.route` 供應的，那一頁上 WebSocket 升級失敗（帶主機擁有者的 cookie 也是 1006，serve 自己的頁面上同一個網址開得起來），
   * 下行全退回 SSE，看不到換票之後換 socket 這一步。
   */
  async function gotoBare(page: Page, origin: string): Promise<void> {
    await page.goto(`${origin}/livez`);
    await page.evaluate(() => {
      document.body.replaceChildren();
      const box = document.createElement('div');
      box.style.height = '600px';
      box.append(document.createElement('nexus-chat'));
      const script = document.createElement('script');
      script.type = 'module';
      script.src = '/embed.js';
      document.body.append(box, script);
    });
    await defined(page);
  }

  function signIn(page: Page, ticket: string): Promise<unknown> {
    return page.evaluate(async (value) => {
      const element = document.querySelector('nexus-chat') as unknown as {
        signIn(ticket: string): Promise<{ expiresAt: number }>;
      };
      return (await element.signIn(value)).expiresAt;
    }, ticket);
  }

  test('沒開登入網址、只拿票：講得了話，重新整理再換一張票接回這次登入開的那一條', async () => {
    const reply = '換票之後的回覆。';
    const { origin, ticket } = await startWithEmbedLogin([{ content: reply }]);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    await gotoBare(page, origin);
    expect(typeof (await signIn(page, await ticket()))).toBe('number');
    await send(page, '你好');
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await settled(page);

    await gotoBare(page, origin);
    await signIn(page, await ticket());
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    expect(
      await page.evaluate(() => localStorage.getItem('nexus.embed.threads.current')),
    ).toBeNull();
    await shot(page, 'embed-ticket-sign-in');
  });

  test('換人登入：下行改走新開的 socket，舊的關掉；換上來的人講得了話', async () => {
    // 腳本每條 thread 從第一輪開始吃：兩個人各一條，拿到的都是這一句。
    const { origin, ticket } = await startWithEmbedLogin([{ content: '收到。' }]);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    /** 每一條 mux socket，與它送出的 `open`（下行）各打開了哪些路徑。 */
    const sockets: { ws: import('playwright-core').WebSocket; opened: string[] }[] = [];
    page.on('websocket', (ws) => {
      if (!ws.url().endsWith('/embed/threads/mux')) return;
      const entry = { ws, opened: [] as string[] };
      sockets.push(entry);
      ws.on('framesent', ({ payload }) => {
        const frame = JSON.parse(String(payload)) as { t?: string; path?: string };
        if (frame.t === 'open' && frame.path !== undefined) entry.opened.push(frame.path);
      });
    });
    await gotoBare(page, origin);
    const talk = async (text: string) => {
      await send(page, text);
      await expect
        .poll(() => transcript(page).getByText('收到。').count(), { timeout: 30_000 })
        .toBe(1);
      await settled(page);
    };

    await signIn(page, await ticket('bob'));
    await expect.poll(() => sockets.some(({ opened }) => opened.length > 0)).toBe(true);
    await talk('我是 bob');
    const bobs = sockets.length;
    await signIn(page, await ticket('alice'));
    await expect.poll(() => transcript(page).count()).toBe(0);
    await expect.poll(() => sockets.length).toBeGreaterThan(bobs);
    const alices = sockets.at(-1)!;
    await expect.poll(() => alices.opened.some((path) => path.endsWith('/stream'))).toBe(true);
    await expect.poll(() => sockets.slice(0, bobs).every(({ ws }) => ws.isClosed())).toBe(true);
    await talk('我是 alice');
    expect(await transcript(page).getByText('我是 bob').count()).toBe(0);
  });

  test('同一個人續期：留在剛開、還沒講話的那一條，下行改走新開的 socket', async () => {
    const { origin, ticket } = await startWithEmbedLogin([{ content: '收到。' }]);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const sockets: import('playwright-core').WebSocket[] = [];
    page.on('websocket', (ws) => {
      if (ws.url().endsWith('/embed/threads/mux')) sockets.push(ws);
    });
    await gotoBare(page, origin);
    await signIn(page, await ticket());
    await send(page, '第一條');
    await expect
      .poll(() => transcript(page).getByText('收到。').count(), { timeout: 30_000 })
      .toBe(1);
    await settled(page);
    await chat(page).getByRole('button', { name: '新對話' }).click();
    await expect.poll(() => transcript(page).count()).toBe(0);
    const before = sockets.length;

    await signIn(page, await ticket());
    await expect.poll(() => sockets.length).toBeGreaterThan(before);
    await expect.poll(() => sockets.slice(0, before).every((ws) => ws.isClosed())).toBe(true);
    expect(await transcript(page).count()).toBe(0);
    await send(page, '第二條');
    await expect
      .poll(() => transcript(page).getByText('收到。').count(), { timeout: 30_000 })
      .toBe(1);
    expect(await transcript(page).getByText('第一條').count()).toBe(0);
  });

  test('沒換票被 401 擋下：發 unauthorized（不 bubble）；交回 signIn 之後講得了話', async () => {
    const { origin, ticket } = await startWithEmbedLogin([{ content: '收到。' }]);
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    // 不 bubble 的事件 capture 階段照樣經過 window：元件升級之前就聽著，第一下也錄得到。
    await page.addInitScript(() => {
      const seen: unknown[] = [];
      (window as unknown as { ticketNeeded: unknown[] }).ticketNeeded = seen;
      window.addEventListener(
        'nexus-ticket-needed',
        (event) => seen.push({ detail: (event as CustomEvent).detail, bubbles: event.bubbles }),
        true,
      );
    });
    const needed = () =>
      page.evaluate(() => (window as unknown as { ticketNeeded: unknown[] }).ticketNeeded);
    await gotoBare(page, origin);
    await expect
      .poll(needed, { timeout: 30_000 })
      .toEqual([{ detail: { reason: 'unauthorized' }, bubbles: false }]);

    await signIn(page, await ticket());
    await send(page, '你好');
    await expect
      .poll(() => transcript(page).getByText('收到。').count(), { timeout: 30_000 })
      .toBe(1);
    expect(await needed()).toHaveLength(1);
  });

  test('用過的票：signIn reject ticket_invalid', async () => {
    const { origin, ticket } = await startWithEmbedLogin([{ content: '用不到' }]);
    const page = await browser.newPage();
    await gotoBare(page, origin);
    const used = await ticket();
    await signIn(page, used);
    const failure = await page.evaluate(async (value) => {
      const element = document.querySelector('nexus-chat') as unknown as {
        signIn(ticket: string): Promise<unknown>;
      };
      return element.signIn(value).then(
        () => undefined,
        (error: { name: string; code: string }) => ({ name: error.name, code: error.code }),
      );
    }, used);
    expect(failure).toEqual({ name: 'NexusSignInError', code: 'ticket_invalid' });
  });
});
