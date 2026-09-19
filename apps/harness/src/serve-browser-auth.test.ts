/**
 * 真的 serve、真的 HTTP：瀏覽器會話認證在產品路徑上（#424）。
 *
 * 形狀照 dsh 決策筆記「验证」一節的真 CLI 測試：在暫存的 home 上用同一個 port 兩次啟動，
 * 證明偽造 `Host: localhost` 仍然沒有認證、用交換來的 cookie 打得到 API、token 每個行程換一個、
 * 舊 cookie 在重啟之後照樣有效。**零設定的組裝**（沒給 `--plugins`）：能力要在產品路徑上，
 * 不是掛著某個 plugin 才有。
 */

import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { THREADS_PATH } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';
import { BROWSER_SESSION_SECRET_FILE } from './browser-session-secret.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';

const POSIX = process.platform !== 'win32';
const INDEX = '<!doctype html><title>nexus web</title>';

let running: RunningServe | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function builtDist(): Promise<string> {
  const dist = join(await tmp('nexus-serve-dist-'), 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), INDEX);
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1);');
  return dist;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function start(
  options: { readonly home?: string; readonly port?: number; readonly webDist?: string },
  lines: string[] = [],
): Promise<RunningServe> {
  running = await runServe({
    argv: ['--port', String(options.port ?? 0)],
    log: (line) => void lines.push(line),
    env: options.home === undefined ? {} : { [HARNESS_HOME_ENV]: options.home },
    ...(options.webDist === undefined ? {} : { webDist: options.webDist }),
  });
  return running as RunningServe;
}

/** 用 node:http 打，才帶得了任意的 `Host`（fetch 會照網址自己填）。 */
function rawGet(
  url: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: string }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: target.hostname, port: target.port, path, method: 'GET', headers },
      (incoming) => {
        let body = '';
        incoming.setEncoding('utf8');
        incoming.on('data', (chunk: string) => {
          body += chunk;
        });
        incoming.on('end', () => resolve({ status: incoming.statusCode ?? 0, body }));
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

async function exchange(
  authenticatedUrl: string,
): Promise<{ readonly cookie: string; readonly setCookie: string }> {
  const response = await fetch(authenticatedUrl, { redirect: 'manual' });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/');
  const setCookie = response.headers.get('set-cookie') ?? '';
  return { cookie: setCookie.split(';', 1)[0]!, setCookie };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('serve 的瀏覽器會話', () => {
  it('印出來的網址是唯一的入口：偽造 loopback Host 沒用，換到 cookie 才打得到 API', async () => {
    const home = await tmp('nexus-serve-home-');
    const lines: string[] = [];
    const server = await start({ home, webDist: await builtDist() }, lines);

    expect(lines[0]).toBe(`nexus-agent 在 ${server.authenticatedUrl}`);
    expect(new URL(server.authenticatedUrl).searchParams.get('token')).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    // token 只出現在那一行。
    expect(lines.filter((line) => line.includes('token='))).toHaveLength(1);

    // 同機別的使用者：loopback 的 Host 過得了圍欄，過不了會話。
    for (const host of ['localhost', 'localhost:8787', new URL(server.url).host]) {
      const forged = await rawGet(server.url, THREADS_PATH, { host, ...JSON_HEADERS });
      expect({ host, status: forged.status }).toEqual({ host, status: 401 });
    }
    expect((await fetch(`${server.url}${THREADS_PATH}`, { headers: JSON_HEADERS })).status).toBe(
      401,
    );
    const index = await fetch(`${server.url}/`);
    expect(index.status).toBe(401);
    expect(await index.text()).toContain('重開 serve 啟動時印出的那個網址');
    // 資產公開，照 dsh。
    expect((await fetch(`${server.url}/assets/app.js`)).status).toBe(200);

    const { cookie, setCookie } = await exchange(server.authenticatedUrl);
    expect(setCookie).toMatch(
      /; Max-Age=2592000; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u,
    );
    expect(setCookie).not.toContain('Secure');

    const listed = await fetch(`${server.url}${THREADS_PATH}`, {
      headers: { ...JSON_HEADERS, cookie },
    });
    expect(listed.status).toBe(200);
    const page = await fetch(`${server.url}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe(INDEX);
    // cookie 綁 authority：同一顆拿去配別的 Host 不認。
    expect(
      (await rawGet(server.url, THREADS_PATH, { host: 'localhost', cookie, ...JSON_HEADERS }))
        .status,
    ).toBe(401);
  });

  it('同一個 home、同一個 port 重啟：舊 cookie 照樣有效，token 換了一個', async () => {
    const home = await tmp('nexus-serve-home-');
    const port = await freePort();
    const first = await start({ home, port });
    const { cookie } = await exchange(first.authenticatedUrl);
    const staleUrl = first.authenticatedUrl;
    await first.close();
    running = undefined;

    const second = await start({ home, port });
    expect(second.authenticatedUrl).not.toBe(staleUrl);
    expect(
      (await fetch(`${second.url}${THREADS_PATH}`, { headers: { ...JSON_HEADERS, cookie } }))
        .status,
    ).toBe(200);
    // 舊 token 沒有 cookie：401；配上有效 cookie：轉回乾淨的 `/`、不再發 cookie。
    expect((await fetch(staleUrl, { redirect: 'manual' })).status).toBe(401);
    const cleaned = await fetch(staleUrl, { redirect: 'manual', headers: { cookie } });
    expect(cleaned.status).toBe(303);
    expect(cleaned.headers.get('location')).toBe('/');
    expect(cleaned.headers.get('set-cookie')).toBeNull();
  });

  it('密鑰檔落在 home：目錄 0700、檔案 0600；沒設 home 就在家目錄底下', async () => {
    const home = join(await tmp('nexus-serve-home-'), 'nested', 'home');
    await start({ home });
    const file = join(home, BROWSER_SESSION_SECRET_FILE);
    if (POSIX) {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(home)).mode & 0o777).toBe(0o700);
    } else {
      expect((await stat(file)).isFile()).toBe(true);
    }
    await running?.close();
    running = undefined;

    // `env: {}`：退回 `~/.nexus-agent`。這裡的家目錄是 setup 換過的暫存目錄（`test-home.setup.ts`）。
    await start({});
    expect(
      (await stat(join(homedir(), '.nexus-agent', BROWSER_SESSION_SECRET_FILE))).isFile(),
    ).toBe(true);
  });

  it.skipIf(!POSIX)('密鑰檔別人讀得到或內容認不得：serve 起不來，也沒有在聽', async () => {
    const port = await freePort();
    const wide = await tmp('nexus-serve-home-');
    await writeFile(
      join(wide, BROWSER_SESSION_SECRET_FILE),
      JSON.stringify({ version: 1, secret: Buffer.alloc(32, 1).toString('base64url') }),
    );
    await chmod(join(wide, BROWSER_SESSION_SECRET_FILE), 0o644);
    await expect(start({ home: wide, port })).rejects.toThrow(/chmod 600/);

    const broken = await tmp('nexus-serve-home-');
    await writeFile(join(broken, BROWSER_SESSION_SECRET_FILE), '{壞的', { mode: 0o600 });
    await expect(start({ home: broken, port })).rejects.toThrow(/格式認不得/);

    // 兩次都在開 port 之前就停了：那個 port 還空著。
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('沒 build 過的 dist：照樣起得來，畫面上講得出要先 build', async () => {
    const home = await tmp('nexus-serve-home-');
    const lines: string[] = [];
    const server = await start({ home, webDist: join(await tmp('nexus-no-dist-'), 'dist') }, lines);
    expect(lines.some((line) => line.startsWith('網頁：') && line.includes('pnpm build'))).toBe(
      true,
    );
    const { cookie } = await exchange(server.authenticatedUrl);
    expect((await fetch(`${server.url}/`, { headers: { cookie } })).status).toBe(404);
  });
});
