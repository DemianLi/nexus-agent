/**
 * 由 serve 服務 `apps/web` 建置好的 `dist`（[#424](https://github.com/DemianLi/nexus-agent/issues/424)）。
 *
 * **照 dsh 的形狀**：dsh 的網頁從來不由 Vite 服務（它的 `apps/web/vite.config.ts` 用
 * `rejectStandaloneServe` 擋掉 `vite` 與 `vite preview`），而由 host 的 `frontend-static` 服務
 * `dist`。這裡逐條照 `packages/host/frontend-static/src/index.ts` 的 `serveStatic` 與 fallback
 * （`ddefc45`）：
 *
 * - 不是 `GET`／`HEAD` 回 405；
 * - 解出來的路徑跑出 `dist` 回 403；
 * - `/` 與 `/index.html` 先過 `BrowserAuth.authorizeIndex`——換 token、驗 cookie，都在讀 index 之前；
 * - 其他檔案公開，依副檔名給 content-type；不存在、是目錄、路徑中間不是目錄回 404。
 *
 * **dist 存不存在在請求當下才判**，同 dsh：沒 build 的時候 serve 照樣起得來，index 回 404。
 *
 * **其他失敗照 dsh 往外拋**：百分比編碼解不開、「找不到」以外的檔案系統錯誤，交給 `wire-server.ts`
 * 那道最後防線記一筆、回 400（dsh 的 webserver 同一個位置同一種處置）。
 */

import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { BrowserAuth } from './browser-auth.js';

const HTML_MIME = 'text/html; charset=utf-8';

/** 照 dsh 的對照表，再補上 `dist` 裡實際會出現的字型與圖檔。 */
const MIME: Readonly<Record<string, string>> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** 只有這幾種算「找不到」；其他檔案系統失敗照拋（見檔頭）。 */
const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set(['ENOENT', 'EISDIR', 'ENOTDIR']);

export interface WebStaticOptions {
  /** `dist` 的目錄。 */
  readonly distRoot: string;
  /** 只用到 index 那一格的認證。 */
  readonly auth: Pick<BrowserAuth, 'authorizeIndex'>;
}

function isStaticMiss(error: unknown): boolean {
  return STATIC_MISS_CODES.has((error as NodeJS.ErrnoException | null)?.code);
}

/**
 * 建一個服務 `dist` 的 handler。
 *
 * @param options - `dist` 的位置與 index 的認證。
 * @returns `(Request) => Response`。解不開的網址與「找不到」以外的讀檔失敗會拋，交給 `wire-server.ts`。
 */
export function createWebStaticHandler(
  options: WebStaticOptions,
): (request: Request) => Promise<Response> {
  const distRoot = resolve(options.distRoot);
  const distIndex = join(distRoot, 'index.html');

  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405 });
    }
    // 解不開的百分比編碼（例如孤立的 `%`）在這裡拋：見檔頭最後一段。
    const pathname = decodeURIComponent(new URL(request.url).pathname);
    const target = resolve(normalize(join(distRoot, pathname)));
    // `sep` 而不是 '/'：Windows 上 resolve() 給的是反斜線。
    if (target !== distRoot && !target.startsWith(distRoot + sep)) {
      return new Response(null, { status: 403 });
    }
    const isIndex = target === distRoot || target === distIndex;
    if (isIndex) {
      const denied = options.auth.authorizeIndex(request);
      if (denied !== undefined) return denied;
    }
    let body: Buffer;
    try {
      body = await readFile(isIndex ? distIndex : target);
    } catch (error) {
      if (isStaticMiss(error)) return new Response(null, { status: 404 });
      throw error;
    }
    const type = isIndex ? HTML_MIME : (MIME[extname(target)] ?? 'application/octet-stream');
    return new Response(request.method === 'HEAD' ? null : body, {
      status: 200,
      headers: { 'content-type': type },
    });
  };
}
