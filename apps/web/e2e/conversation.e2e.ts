/**
 * 真瀏覽器跑一整段對話（#1602）：真的 serve（模型換成腳本，見 `serve.ts`）、serve 供應的出貨網頁、本機 Chrome。
 * 斷言 ARIA 的角色與名稱，不綁 class 或元件實作。跑法見 `package.json` 的 `test:e2e`（要先 build）。
 * 核准卡的四種收法（核准、拒絕、停止、停在卡上重啟 serve，#2358）在 langgraph＋single、native＋single、langgraph＋per-thread
 * 三種組合下都跑（CI 的三個 e2e job）。設 `NEXUS_E2E_SHOTS=<目錄>` 時，這四種存截圖，檔名前綴是 `NEXUS_E2E_AGENT_LOOP`（沒設是 `langgraph`）。
 */
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { commandPath } from '@nexus/wire';

import { startE2eServe, type E2eServe, type ScriptTurn } from './serve';
import { shot } from './shot';

const LOOP = process.env.NEXUS_E2E_AGENT_LOOP || 'langgraph';

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

/**
 * 起一台 serve、開它的登入網址，送出一句話。
 *
 * @param watch - 開網址之前掛上的監聽：載入頁面就可能開下行，晚掛會漏掉前面的 frame。
 */
async function sendFirstMessage(
  turns: readonly ScriptTurn[],
  text: string,
  watch?: (page: Page) => void,
): Promise<Page> {
  serve = await startE2eServe(turns);
  const page = await browser.newPage();
  watch?.(page);
  await page.goto(serve.url);
  await send(page, text);
  return page;
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '要說的話' }).fill(text);
  await page.getByRole('button', { name: '送出', exact: true }).click();
}

/** 對話訊息那一條 log。主區塊另有一份給報讀的回覆副本，回覆文字只在這裡數。 */
function transcript(page: Page) {
  return page.getByRole('region', { name: '對話訊息' }).getByRole('log');
}

function approvalCard(page: Page) {
  return page.getByRole('main').getByRole('region', { name: '等待核准：submit_record' });
}

async function expectStatus(page: Page, text: string): Promise<void> {
  await expect
    .poll(() => page.getByRole('main').getByRole('status').textContent(), { timeout: 30_000 })
    .toBe(text);
}

function expectIdle(page: Page): Promise<void> {
  return expectStatus(page, '就緒');
}

/** 第一輪要寫一筆、停在核准卡上；第二輪是卡被答了（核准或拒絕）之後模型接著回的那句。 */
function recordTurns(after: string): ScriptTurn[] {
  return [
    {
      content: '我把這一筆寫進去。',
      toolCalls: [
        { name: 'submit_record', args: { file_path: '/visitors.csv', record: { 姓名: '阿明' } } },
      ],
    },
    { content: after },
  ];
}

const ASK = '幫我登記阿明';

async function stopAtApproval(
  turns: readonly ScriptTurn[],
  watch?: (page: Page) => void,
): Promise<Page> {
  const page = await sendFirstMessage(turns, ASK, watch);
  await expect
    .poll(() => approvalCard(page).getByRole('button', { name: '全部核准' }).count(), {
      timeout: 30_000,
    })
    .toBe(1);
  return page;
}

interface InputRequested {
  readonly method: string;
  readonly params: {
    readonly namespace: string[];
    readonly data: { readonly interrupt_id: string };
  };
}

interface PendingInterrupt {
  readonly namespace: string[];
  readonly interrupt_id: string;
}

/**
 * 回一個監聽：把下行送來的 `input.requested` 要答的那兩格（`namespace`、`interrupt_id`）收進 `found`。從 socket 的 frame 裡撈：
 * mux 的一顆 frame 是 `{t:'data', text}`，`text` 是一段 SSE，`data:` 那行是 thread 自己的事件，或 thread feed 包著它的
 * `{type:'input-requested', event}`。
 */
function captureInterrupts(found: PendingInterrupt[]): (page: Page) => void {
  return (page) =>
    page.on('websocket', (socket) => {
      socket.on('framereceived', ({ payload }) => {
        if (typeof payload !== 'string' || !payload.includes('input.requested')) return;
        const frame = JSON.parse(payload) as { t?: string; text?: string };
        if (frame.t !== 'data' || frame.text === undefined) return;
        for (const line of frame.text.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const data = JSON.parse(line.slice('data: '.length)) as Partial<InputRequested> & {
            event?: InputRequested;
          };
          const event = data.method === 'input.requested' ? (data as InputRequested) : data.event;
          if (event?.method !== 'input.requested') continue;
          found.push({
            namespace: event.params.namespace,
            interrupt_id: event.params.data.interrupt_id,
          });
        }
      });
    });
}

/**
 * 從頁面上直接對目前這一條送一個命令（同源、帶著登入換到的 cookie），回 server 的回應本體。
 * 停在核准卡上時畫面沒有停止鈕（只在跑著時出現），停止就從這裡送 `run.cancel`。路徑用 `@nexus/wire` 的 `commandPath`
 * （頁面開在根路徑，沒有 mount 前綴）；header 與本體照它的 `postJson`：`content-type: application/json`、`{id, method, params?}`，
 * 只有 `id` 的值跟停止鈕送的不同。
 */
async function commandFromPage(
  page: Page,
  method: 'run.cancel' | 'input.respond',
  params?: Record<string, unknown>,
): Promise<unknown> {
  const threadId = await page.evaluate(
    () =>
      (JSON.parse(localStorage.getItem('nexus.threads.current') ?? '{}') as { threadId?: string })
        .threadId,
  );
  if (threadId === undefined) throw new Error('頁面沒記住目前這一條');
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.json();
    },
    {
      path: commandPath(threadId, method),
      body: { id: 9_999, method, ...(params === undefined ? {} : { params }) },
    },
  );
}

describe('真瀏覽器的對話', () => {
  test('一般回覆串完', async () => {
    const reply = '這是一段分好幾塊串過來的腳本回覆。';
    // 每個字隔 20 毫秒吐出，讓回覆分多塊串流，不是一次到齊。
    const page = await sendFirstMessage([{ content: reply, tokenDelayMs: 20 }], '你好');
    await expect.poll(() => transcript(page).getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await expectIdle(page);
  });
});

describe('核准卡的四種收法（#2358）', () => {
  test('核准：這一輪結束、工具完成', async () => {
    const page = await stopAtApproval(recordTurns('已經寫進 /visitors.csv。'));
    await shot(page, `${LOOP}-approve-1-card`);
    await approvalCard(page).getByRole('button', { name: '全部核准' }).click();
    const log = transcript(page);
    await expect
      .poll(() => log.getByText('已經寫進 /visitors.csv。').count(), { timeout: 30_000 })
      .toBe(1);
    expect(await log.getByRole('button', { name: /submit_record 完成$/ }).count()).toBe(1);
    await expect.poll(() => approvalCard(page).count(), { timeout: 30_000 }).toBe(0);
    await expectIdle(page);
    await shot(page, `${LOOP}-approve-2-done`);
  });

  test('拒絕：卡收掉、工具沒做、模型接著回', async () => {
    const page = await stopAtApproval(recordTurns('好，這一筆不寫。'));
    await approvalCard(page).getByRole('button', { name: '全部拒絕' }).click();
    const log = transcript(page);
    await expect.poll(() => log.getByText('好，這一筆不寫。').count(), { timeout: 30_000 }).toBe(1);
    expect(await log.getByRole('button', { name: /submit_record 完成$/ }).count()).toBe(0);
    await expect.poll(() => approvalCard(page).count(), { timeout: 30_000 }).toBe(0);
    await expectIdle(page);
    await shot(page, `${LOOP}-reject-1-done`);
  });

  test('停止：卡收掉、模型不再接著回、之後才送的答覆是 no_such_interrupt', async () => {
    const after = '停止之後不該出現的回覆。';
    const interrupts: PendingInterrupt[] = [];
    const page = await stopAtApproval(recordTurns(after), captureInterrupts(interrupts));
    expect(interrupts.length, '下行沒撈到 input.requested').toBeGreaterThan(0);

    expect(await page.getByRole('button', { name: '停止', exact: true }).count()).toBe(0);
    await commandFromPage(page, 'run.cancel');
    await expect.poll(() => approvalCard(page).count(), { timeout: 30_000 }).toBe(0);
    await expectStatus(page, '已停止');
    await shot(page, `${LOOP}-stop-1-stopped`);

    const pending = interrupts.at(-1)!;
    expect(
      await commandFromPage(page, 'input.respond', {
        ...pending,
        response: { decisions: [{ type: 'approve' }] },
      }),
    ).toMatchObject({
      type: 'error',
      error: 'no_such_interrupt',
    });
    // 腳本的第二輪要這張卡被答了（核准或拒絕）才會被要；停止之後答覆被拒，等 2 秒確定它沒有出現。
    await page.waitForTimeout(2_000);
    expect(await transcript(page).getByText(after).count()).toBe(0);
    await expectStatus(page, '已停止');
  });

  test('停在核准卡上重啟 serve：卡收成失敗、這一條還講得下去', async () => {
    const page = await stopAtApproval(recordTurns('重啟前不該出現的回覆。'));
    await shot(page, `${LOOP}-restart-1-card`);

    const after = '重啟之後接著回。';
    const url = await serve!.restart([{ content: after }]);
    await page.goto(url);
    const row = page.getByTestId('thread-title-text').getByText(ASK, { exact: true });
    await expect.poll(() => row.count(), { timeout: 30_000 }).toBe(1);
    await row.click();
    const log = transcript(page);
    await expect
      .poll(() => log.getByRole('button', { name: /submit_record 失敗/ }).count(), {
        timeout: 30_000,
      })
      .toBe(1);
    await expectIdle(page);
    // 重播完、狀態列也就緒了，再等一下才看卡：一進頁面就數，卡還沒畫出來也會是 0。
    await page.waitForTimeout(1_500);
    expect(await approvalCard(page).count()).toBe(0);
    await shot(page, `${LOOP}-restart-2-closed`);

    await send(page, '剛才那筆呢？');
    await expect.poll(() => log.getByText(after).count(), { timeout: 30_000 }).toBe(1);
    await expectIdle(page);
  });
});
