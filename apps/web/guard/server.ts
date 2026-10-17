import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 瀏覽器護欄的靜態伺服器（#1512）。**不用 `vite preview`**：網頁從來不由 Vite 服務（#426，`../vite.config.ts`）。
 *
 * - 綁 `127.0.0.1`、隨機埠（`listen(0)`），量完一定關（`close()`；測試在 `afterAll` 與例外路徑都會叫）。
 * - `/` 是測試頁：`guard/dist/index.html` 插上出貨 `dist/index.html` 的 `<link rel="stylesheet">`——量的就是出貨的那份 CSS。
 * - `/assets/*` 從出貨的 `dist/` 給（CSS 與它引用的字型），`/guard-assets/*` 從 `guard/dist/` 給（測試頁的 JS）。
 */

const WEB = fileURLToPath(new URL('..', import.meta.url));
export const SHIPPED_DIST = join(WEB, 'dist');
export const GUARD_DIST = join(WEB, 'guard', 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
};

const STYLESHEET = /<link\b[^>]*\brel="stylesheet"[^>]*>/g;

/** 出貨 HTML 裡的樣式表連結，原樣插進測試頁；測試頁自己的 HTML 不准帶樣式表（帶了就不是在量出貨的 CSS）。 */
export function guardHtml(shipped: string, guard: string): string {
  const links = shipped.match(STYLESHEET) ?? [];
  if (links.length === 0)
    throw new Error('出貨的 dist/index.html 沒有 <link rel="stylesheet">：先跑 build');
  if (/<link\b[^>]*\brel="stylesheet"/.test(guard.replace(/<!--[\s\S]*?-->/g, ''))) {
    throw new Error(
      '測試頁的 HTML 自己帶了樣式表：guard/ 裡有東西 import 了 CSS，量到的就不是出貨那份',
    );
  }
  if (!guard.includes('</head>')) throw new Error('測試頁的 HTML 沒有 </head>');
  return guard.replace('</head>', `${links.join('\n')}\n</head>`);
}

/** URL 路徑對到某個根目錄底下的檔；跳出根目錄的（`..`）一律不給。 */
function inside(root: string, urlPath: string): string | undefined {
  const file = normalize(join(root, decodeURIComponent(urlPath)));
  return file.startsWith(root + sep) ? file : undefined;
}

export interface GuardServer {
  url: string;
  close(): Promise<void>;
}

export async function startGuardServer(): Promise<GuardServer> {
  const page = guardHtml(
    readFileSync(join(SHIPPED_DIST, 'index.html'), 'utf8'),
    readFileSync(join(GUARD_DIST, 'index.html'), 'utf8'),
  );
  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const file = path.startsWith('/assets/')
      ? inside(SHIPPED_DIST, path)
      : path.startsWith('/guard-assets/')
        ? inside(GUARD_DIST, path)
        : undefined;
    try {
      if (path === '/') {
        res.writeHead(200, { 'content-type': TYPES['.html'] });
        res.end(page);
      } else if (file !== undefined) {
        const body = readFileSync(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } else {
        res.writeHead(404).end();
      }
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
