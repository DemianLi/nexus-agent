/**
 * 兩個分頁開同一台 serve（[#2990](https://github.com/DemianLi/nexus-agent/issues/2990)）：A 封存、釘選、刪除，B 的側欄不重抓清單就跟上。
 * 跟上靠的是全域下行推來的 `archived`、`pinned`、`removed`；per-thread 時這三種由前台自己廣播，所以 CI 的 per-thread job 跑這支
 * 才驗得到那一條。跑法見 `package.json` 的 `test:e2e`（要先 build）。
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { commandPath, THREADS_PATH } from '@nexus/wire';

import { startE2eServe, type E2eServe } from './serve';

let browser: Browser;
let context: BrowserContext | undefined;
let serve: E2eServe | undefined;

beforeAll(async () => {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

afterAll(async () => {
  await browser.close();
});

afterEach(async () => {
  await context?.close();
  context = undefined;
  await serve?.close();
  serve = undefined;
});

const TITLES = ['第一條會話', '第二條會話', '第三條會話'] as const;
/** 腳本每條會話各自從第一輪吃起，所以三條都回這一句。 */
const REPLY = '收到。';

function currentThreadId(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('nexus.threads.current') ?? '{}') as { threadId?: string })
        .threadId,
  );
}

function transcript(page: Page) {
  return page.getByRole('region', { name: '對話訊息' }).getByRole('log');
}

/**
 * 在 A 送一句話、等回覆，回這一條的 thread id。`fresh` 時先按「新對話」：輸入框會換一個，等上一條的回覆從畫面上消失再填字，
 * 不然填進舊的那個就被清掉了。
 */
async function startThread(page: Page, text: string, fresh: boolean): Promise<string> {
  const before = await currentThreadId(page);
  if (fresh) {
    await page.getByRole('button', { name: '新對話', exact: true }).click();
    await expect.poll(() => transcript(page).getByText(REPLY).count(), { timeout: 30_000 }).toBe(0);
  }
  await page.getByRole('textbox', { name: '要說的話' }).fill(text);
  await page.getByRole('button', { name: '送出', exact: true }).click();
  await expect.poll(() => transcript(page).getByText(REPLY).count(), { timeout: 30_000 }).toBe(1);
  const threadId = await currentThreadId(page);
  // 第一條是載入時就有的空白會話，送出之前就記了 id；之後每一條都要換一個。
  if (threadId === undefined || (fresh && threadId === before)) {
    throw new Error(`「${text}」沒有開成新的一條`);
  }
  return threadId;
}

/** 從 A 對某一條送整理或刪除命令（同源、帶著 cookie），要它回 `ok`。 */
async function command(
  page: Page,
  threadId: string,
  method: 'thread.archive' | 'thread.pin' | 'thread.delete',
): Promise<void> {
  const body = await page.evaluate(
    async ({ path, payload }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return response.json() as Promise<unknown>;
    },
    { path: commandPath(threadId, method), payload: { id: 1, method, params: {} } },
  );
  expect(body, method).toMatchObject({ result: { ok: true } });
}

function sidebarRow(page: Page, title: string) {
  return page
    .getByRole('navigation', { name: '對話' })
    .getByTestId('thread-title-text')
    .getByText(title, { exact: true });
}

describe('另一個分頁的側欄跟上（#2990）', () => {
  test('A 封存、釘選、刪除，B 不重抓清單就跟上', async () => {
    serve = await startE2eServe([{ content: REPLY }]);
    context = await browser.newContext();
    const a = await context.newPage();
    await a.goto(serve.url);
    const ids: string[] = [];
    for (const [index, title] of TITLES.entries()) ids.push(await startThread(a, title, index > 0));
    const [archived, pinned, deleted] = ids as [string, string, string];

    // 同一個 context 共用 A 換到的 cookie；開在根路徑，不再用一次登入網址。
    const b = await context.newPage();
    await b.goto(new URL('/', a.url()).href);
    for (const title of TITLES) {
      await expect.poll(() => sidebarRow(b, title).count(), { timeout: 30_000 }).toBe(1);
    }
    const listings: string[] = [];
    b.on('request', (request) => {
      if (new URL(request.url()).pathname === THREADS_PATH) listings.push(request.url());
    });

    await command(a, archived, 'thread.archive');
    await expect
      .poll(() => b.getByTestId('thread-archived').textContent(), { timeout: 10_000 })
      .toContain('已封存（1）');
    expect(await sidebarRow(b, TITLES[0]).count()).toBe(0);

    await command(a, pinned, 'thread.pin');
    await expect
      .poll(() => b.getByTestId('thread-pinned').getByText(TITLES[1], { exact: true }).count(), {
        timeout: 10_000,
      })
      .toBe(1);

    await command(a, deleted, 'thread.delete');
    await expect
      .poll(() => b.getByTestId('thread-deleted').textContent(), { timeout: 10_000 })
      .toContain('最近刪除（1）');
    expect(await sidebarRow(b, TITLES[2]).count()).toBe(0);

    expect(listings, 'B 重抓了清單').toEqual([]);
  });
});
