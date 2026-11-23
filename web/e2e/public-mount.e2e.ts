/**
 * 掛在反向代理的子路徑底下（#2426）：前面一台代理把 `/nexus/*` 剝掉前綴轉給 serve，serve 不認前綴。獨立頁面開 `/nexus/`，嵌入版的 Vue 測試頁載 `/nexus/embed.js`，兩邊都講完一輪，
 * 而且瀏覽器打出去的每個請求都帶著前綴：沒帶的代理不轉，記在 `stray` 裡。
 *
 * 代理是測試自己的 Node 伺服器，`Host` 原樣轉送（代理的 authority 是 loopback，serve 的圍欄放行）。登入網址 303 回 `/`
 * 是 serve 那一側的事（#2369），這裡用 `page.request` 換 cookie、不跟轉址。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser, type Page } from 'playwright-core';
import { build } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';

import { startE2eServe, type E2eServe } from './serve';

const MOUNT = '/nexus';
/** 頁面沒宣告圖示時，瀏覽器自己打 origin 根上的這一支，跟頁面的網址怎麼算無關。 */
const BROWSER_FAVICON = '/favicon.ico';
const DEMO = '/vue-demo/';
const DEMO_CONFIG = fileURLToPath(new URL('../embed-demo/vite.config.ts', import.meta.url));
const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

interface MountProxy {
  readonly origin: string;
  /** 沒帶前綴、也不是測試頁的請求（方法與路徑）。 */
  readonly stray: string[];
  close(): Promise<void>;
}

/** 前綴底下的路徑剝掉前綴；不在前綴底下是 `undefined`。 */
function unmounted(url: string): string | undefined {
  return url.startsWith(`${MOUNT}/`) ? url.slice(MOUNT.length) : undefined;
}

function demoFile(demo: string, url: string): string | undefined {
  const path = new URL(url, 'http://x').pathname.slice(DEMO.length);
  const file = normalize(join(demo, path === '' ? 'index.html' : decodeURIComponent(path)));
  return file.startsWith(demo + sep) ? file : undefined;
}

async function startMountProxy(target: URL, demo: string): Promise<MountProxy> {
  const stray: string[] = [];
  const tunnels = new Set<Duplex>();
  const port = Number(target.port);
  const server: Server = createServer((req: IncomingMessage, res) => {
    const url = req.url ?? '/';
    const path = unmounted(url);
    if (path !== undefined) {
      const upstream = request(
        { host: target.hostname, port, method: req.method, path, headers: req.headers },
        (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
        },
      );
      upstream.on('error', () => res.destroy());
      req.pipe(upstream);
      return;
    }
    if (url.startsWith(DEMO)) {
      const file = demoFile(demo, url);
      void (file === undefined ? Promise.reject(new Error('outside')) : readFile(file)).then(
        (body) => {
          res.writeHead(200, {
            'content-type': TYPES[extname(file!)] ?? 'application/octet-stream',
          });
          res.end(body);
        },
        () => {
          stray.push(`${req.method} ${url}`);
          res.writeHead(404).end();
        },
      );
      return;
    }
    if (url !== BROWSER_FAVICON) stray.push(`${req.method} ${url}`);
    res.writeHead(404).end();
  });
  server.on('upgrade', (req: IncomingMessage, socket, head) => {
    const path = unmounted(req.url ?? '/');
    if (path === undefined) {
      stray.push(`UPGRADE ${req.url}`);
      socket.destroy();
      return;
    }
    const upstream = connect(port, target.hostname, () => {
      const lines = [`${req.method} ${path} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    tunnels.add(socket);
    tunnels.add(upstream);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('代理沒有 port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stray,
    close: () =>
      new Promise((resolve) => {
        for (const tunnel of tunnels) tunnel.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let browser: Browser;
let demo: string;
let serve: E2eServe | undefined;
let proxy: MountProxy | undefined;

beforeAll(async () => {
  demo = await mkdtemp(join(tmpdir(), 'nexus-mount-demo-'));
  await build({ configFile: DEMO_CONFIG, logLevel: 'warn', build: { outDir: demo } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

afterAll(async () => {
  await browser.close();
  await rm(demo, { recursive: true, force: true });
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await serve?.close();
  serve = undefined;
});

/** 起 serve 與代理，經代理換到 cookie。 */
async function mounted(reply: string): Promise<{ page: Page; proxy: MountProxy }> {
  serve = await startE2eServe([{ content: reply }]);
  const login = new URL(serve.url);
  proxy = await startMountProxy(login, demo);
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const exchanged = await page.request.get(`${proxy.origin}${MOUNT}/${login.search}`, {
    maxRedirects: 0,
  });
  expect(exchanged.status()).toBe(303);
  return { page, proxy };
}

describe('掛在 /nexus/ 底下', () => {
  test('獨立頁面：資源與 API 都帶前綴，一輪講完', async () => {
    const reply = '子路徑底下的獨立頁面回覆。';
    const { page, proxy } = await mounted(reply);
    await page.goto(`${proxy.origin}${MOUNT}/`);
    await page.getByRole('textbox', { name: '要說的話' }).fill('你好');
    await page.getByRole('button', { name: '送出', exact: true }).click();
    const log = page.getByRole('region', { name: '對話訊息' }).getByRole('log');
    await expect.poll(() => log.getByText(reply).count(), { timeout: 30_000 }).toBe(1);
    await expect
      .poll(() => page.getByRole('main').getByRole('status').textContent(), { timeout: 30_000 })
      .toBe('就緒');
    expect(proxy.stray).toEqual([]);
  });

  test('獨立頁面開關側欄，宿主頁的路徑看不到 nexus 寫的 cookie（#2438）', async () => {
    const { page, proxy } = await mounted('不會送出。');
    await page.goto(`${proxy.origin}${MOUNT}/`);
    const toggle = page.getByRole('button', { name: '開關側欄' });
    await toggle.click();
    await expect
      .poll(() => page.locator('[data-slot="sidebar"]').getAttribute('data-state'))
      .toBe('collapsed');
    await toggle.click();
    await expect
      .poll(() => page.locator('[data-slot="sidebar"]').getAttribute('data-state'))
      .toBe('expanded');
    await page.goto(`${proxy.origin}${DEMO}?embed=${encodeURIComponent(`${MOUNT}/embed.js`)}`);
    expect(await page.evaluate(() => document.cookie)).toBe('');
  });

  test('嵌入版：embed.js、/embed 的 API 與 mux 都帶前綴，一輪講完', async () => {
    const reply = '子路徑底下的嵌入版回覆。';
    const { page, proxy } = await mounted(reply);
    await page.goto(`${proxy.origin}${DEMO}?embed=${encodeURIComponent(`${MOUNT}/embed.js`)}`);
    const chat = page.locator('nexus-chat');
    await chat.getByRole('textbox', { name: '要說的話' }).fill('你好');
    await chat.getByRole('button', { name: '送出', exact: true }).click();
    await expect
      .poll(() => chat.getByRole('log').getByText(reply).count(), { timeout: 30_000 })
      .toBe(1);
    await expect
      .poll(() => chat.getByRole('status').first().textContent(), { timeout: 30_000 })
      .toBe('就緒');
    expect(proxy.stray).toEqual([]);
  });
});
