/**
 * 由 serve 服務 `dist`（#424）：分面照 dsh `frontend-static` 的 `serveStatic`。
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { BrowserAuth } from './browser-auth.js';
import { createWebStaticHandler } from './web-static.js';

const AUTHORITY = 'localhost:8787';
const INDEX = '<!doctype html><title>nexus</title>';

let dist: string;
let auth: BrowserAuth;
let cookie: string;
let handle: (request: Request) => Promise<Response>;

function get(
  path: string,
  init: { readonly cookie?: string; readonly method?: string } = {},
): Request {
  return new Request(`http://${AUTHORITY}${path}`, {
    method: init.method ?? 'GET',
    headers: { host: AUTHORITY, ...(init.cookie === undefined ? {} : { cookie: init.cookie }) },
  });
}

beforeAll(async () => {
  dist = join(await mkdtemp(join(tmpdir(), 'nexus-dist-')), 'dist');
  await mkdir(join(dist, 'assets', 'fonts'), { recursive: true });
  await writeFile(join(dist, 'index.html'), INDEX);
  await writeFile(join(dist, 'assets', 'app.js'), 'console.log(1);');
  await writeFile(join(dist, 'assets', 'app.css'), 'body{}');
  await writeFile(join(dist, 'assets', 'fonts', 'inter.woff2'), 'font');
  await writeFile(join(dist, 'assets', 'data.bin'), 'bin');
  await writeFile(join(dist, '..', 'secret.txt'), 'outside');

  auth = new BrowserAuth(Buffer.alloc(32, 8));
  const launch = new URL(auth.authenticatedUrl(`http://${AUTHORITY}`));
  const exchanged = auth.authorizeIndex(get(`/${launch.search}`));
  cookie = (exchanged?.headers.get('set-cookie') ?? '').split(';', 1)[0]!;
  handle = createWebStaticHandler({ distRoot: dist, auth });
});

describe('createWebStaticHandler', () => {
  it('index 要會話：沒有是 401，有就給 index.html', async () => {
    for (const path of ['/', '/index.html']) {
      const denied = await handle(get(path));
      expect(denied.status).toBe(401);
      expect(await denied.text()).toContain('重開 serve 啟動時印出的那個網址');

      const served = await handle(get(path, { cookie }));
      expect(served.status).toBe(200);
      expect(served.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await served.text()).toBe(INDEX);
    }
  });

  it('帶 token 的根網址在讀 index 之前就換成 cookie', async () => {
    const launch = new URL(auth.authenticatedUrl(`http://${AUTHORITY}`));
    const response = await handle(get(`/${launch.search}`));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/');
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict$/);
    expect((await handle(get('/?token=wrong'))).status).toBe(401);
  });

  it('其他檔案公開，依副檔名給 content-type', async () => {
    const cases: readonly [string, string, string][] = [
      ['/assets/app.js', 'text/javascript; charset=utf-8', 'console.log(1);'],
      ['/assets/app.css', 'text/css; charset=utf-8', 'body{}'],
      ['/assets/fonts/inter.woff2', 'font/woff2', 'font'],
      ['/assets/data.bin', 'application/octet-stream', 'bin'],
    ];
    for (const [path, type, body] of cases) {
      const response = await handle(get(path));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(type);
      expect(await response.text()).toBe(body);
    }
  });

  it('找不到、是目錄、中間不是目錄：404', async () => {
    for (const path of ['/missing.js', '/assets', '/assets/app.js/child']) {
      expect((await handle(get(path))).status).toBe(404);
    }
  });

  it('解碼後跑出 dist：403，讀不到外面的檔', async () => {
    for (const path of [
      '/..%2Fsecret.txt',
      '/assets/..%2F..%2Fsecret.txt',
      '/%2E%2E%2Fsecret.txt',
    ]) {
      const response = await handle(get(path));
      expect(response.status).toBe(403);
      expect(await response.text()).toBe('');
    }
  });

  it('不是 GET／HEAD 回 405；HEAD 只給標頭', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect((await handle(get('/assets/app.js', { method }))).status).toBe(405);
    }
    const head = await handle(get('/assets/app.js', { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(await head.text()).toBe('');
    const headIndex = await handle(get('/', { method: 'HEAD', cookie }));
    expect(headIndex.status).toBe(200);
    expect(await headIndex.text()).toBe('');
  });

  it('百分比編碼解不開：400，不拋', async () => {
    const response = await handle(get('/%E0%A4%A'));
    expect(response.status).toBe(400);
  });

  it('dist 還沒 build：index 與資產都是 404，不拋', async () => {
    const empty = createWebStaticHandler({ distRoot: join(dist, 'not-built'), auth });
    expect((await empty(get('/', { cookie }))).status).toBe(404);
    expect((await empty(get('/assets/app.js'))).status).toBe(404);
    // 認證仍然排在讀檔之前。
    expect((await empty(get('/'))).status).toBe(401);
  });
});
