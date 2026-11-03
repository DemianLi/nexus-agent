/**
 * 模型請求的計數轉接器（[#2367](https://github.com/DemianLi/nexus-agent/issues/2367)）：serve 的 `live-model` 指到這裡，這裡原樣轉給上游，
 * 數每一個請求。**到上限或上游回了不是 200，就停**：之後的請求一律回 503、不轉出去，呼叫端看 {@link CountingProxy.stopped} 收手。
 *
 * 不記 header、不記 body：金鑰在 `authorization` 裡，由 serve 自己帶，經手但不落地。
 */

import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';

export interface CountingProxy {
  /** 給 `live-model.baseUrl` 用的網址（含上游的路徑前綴，例如 `/v1`）。 */
  readonly baseUrl: string;
  /** 已經轉出去的請求數。 */
  readonly count: () => number;
  /** 停下的原因；還沒停是 `undefined`。 */
  readonly stopped: () => string | undefined;
  readonly close: () => Promise<void>;
}

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding']);

function forwardable(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return out;
}

/**
 * @param upstream - 上游的 base URL，例如 `https://integrate.api.nvidia.com/v1`。
 * @param limit - 最多轉出幾個請求。
 */
export async function startCountingProxy(upstream: string, limit: number): Promise<CountingProxy> {
  const base = new URL(upstream);
  const prefix = base.pathname.replace(/\/$/u, '');
  let count = 0;
  let stopped: string | undefined;
  const server = createServer((req, res) => {
    const refuse = (): void => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: `計數轉接器已停：${stopped ?? ''}` }));
    };
    if (stopped !== undefined) return refuse();
    if (count >= limit) {
      stopped = `到上限 ${String(limit)} 個請求`;
      return refuse();
    }
    count += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').startsWith(prefix)
        ? (req.url ?? '/').slice(prefix.length)
        : (req.url ?? '/');
      fetch(new URL(`${prefix}${path}`, base.origin), {
        method: req.method ?? 'POST',
        headers: forwardable(req.headers),
        ...(chunks.length > 0 && { body: Buffer.concat(chunks) }),
      }).then(
        (response) => {
          if (response.status !== 200) stopped = `上游回 ${String(response.status)}`;
          const headers: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            if (!HOP_BY_HOP.has(name) && name !== 'content-encoding') headers[name] = value;
          });
          res.writeHead(response.status, headers);
          if (response.body === null) return res.end();
          Readable.fromWeb(response.body as never).pipe(res);
        },
        (error: unknown) => {
          stopped = `連不上上游：${error instanceof Error ? error.message : String(error)}`;
          refuse();
        },
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}${prefix}`,
    count: () => count,
    stopped: () => stopped,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
