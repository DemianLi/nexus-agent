/**
 * 真瀏覽器跑一整段對話（#1602）：真的 serve（模型換成腳本，見 `serve.ts`）、serve 供應的出貨網頁、本機 Chrome。
 * 斷言 ARIA 的角色與名稱，不綁 class 或元件實作。跑法見 `package.json` 的 `test:e2e`（要先 build）。
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { startE2eServe, type E2eServe, type ScriptTurn } from './serve';

let browser: Browser;
let serve: E2eServe | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await serve?.close();
  serve = undefined;
});

/** 起一台 serve、開它的登入網址，送出一句話。 */
async function sendFirstMessage(turns: readonly ScriptTurn[], text: string): Promise<Page> {
  serve = await startE2eServe(turns);
  const page = await browser.newPage();
  await page.goto(serve.url);
  await page.getByRole('textbox', { name: '要說的話' }).fill(text);
  await page.getByRole('button', { name: '送出', exact: true }).click();
  return page;
}

/** 對話訊息那一條 log。主區塊另有一份給報讀的回覆副本，回覆文字只在這裡數。 */
function transcript(page: Page) {
  return page.getByRole('region', { name: '對話訊息' }).getByRole('log');
}

describe('真瀏覽器的對話', () => {
  test('一般回覆串完', async () => {
    const reply = '這是一段分好幾塊串過來的腳本回覆。';
    // 每個字隔 20 毫秒吐出，讓回覆分多塊串流，不是一次到齊。
    const page = await sendFirstMessage([{ content: reply, tokenDelayMs: 20 }], '你好');
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await expect
      .poll(() => page.getByRole('main').getByRole('status').textContent(), { timeout: 30_000 })
      .toBe('就緒');
  });

  test('核准中斷，按核准後這一輪結束', async () => {
    const page = await sendFirstMessage(
      [
        {
          content: '我把這一筆寫進去。',
          toolCalls: [
            {
              name: 'submit_record',
              args: { file_path: '/visitors.csv', record: { 姓名: '阿明' } },
            },
          ],
        },
        { content: '已經寫進 /visitors.csv。' },
      ],
      '幫我登記阿明',
    );
    const main = page.getByRole('main');
    const approval = main.getByRole('region', { name: '等待核准：submit_record' });
    const approve = approval.getByRole('button', { name: '全部核准' });
    await expect.poll(() => approve.count(), { timeout: 30_000 }).toBe(1);
    await approve.click();
    const log = transcript(page);
    await expect
      .poll(() => log.getByText('已經寫進 /visitors.csv。').count(), { timeout: 30_000 })
      .toBe(1);
    expect(await log.getByRole('button', { name: /submit_record 完成$/ }).count()).toBe(1);
    await expect.poll(() => approval.count(), { timeout: 30_000 }).toBe(0);
    await expect
      .poll(() => main.getByRole('status').textContent(), { timeout: 30_000 })
      .toBe('就緒');
  });
});
