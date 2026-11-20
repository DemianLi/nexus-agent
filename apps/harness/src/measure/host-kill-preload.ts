/**
 * 殺宿主量測的記時預載（#3032 補充段三）：`node --import` 載入，只在對話行程（`argv[1]` 是 `conversation-process.js`）裡動作。
 * 在對話行程載入產品碼之前，對 `@nexus/host-bridge` 的 `HostClient` 包兩處，把時間點（`process.hrtime.bigint()`，全系統共用的單調時鐘）
 * 逐行寫到 `HOSTKILL_LOG`；包的是同一個模組實例，產品碼一個字都不改：
 *
 * - `onReady(listener)`：包住 listener，每次叫用記一行 `onReady`（帶登記序號）。
 * - `call(…, 'open', …, { onChunk })`（產品碼裡只有 host-pool 對 `mcp/client` 這樣叫）：包住 `onChunk`，收到 `ready` 塊記一行 `openReady`（帶 `server`）。
 *
 * 起來時另記一行 `loaded`：被包的模組 URL、實際檔案路徑與 sha256，結果據此對到產物檔。
 *
 * @module
 */

import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const log = process.env.HOSTKILL_LOG;
const isConversation = basename(process.argv[1] ?? '') === 'conversation-process.js';

if (log !== undefined && isConversation) {
  const write = (o: Record<string, unknown>): void => {
    appendFileSync(
      log,
      `${JSON.stringify({ ...o, t: process.hrtime.bigint().toString(), pid: process.pid })}\n`,
    );
  };
  const url = import.meta.resolve('@nexus/host-bridge', `file://${process.cwd()}/package.json`);
  const file = realpathSync(fileURLToPath(url));
  const mod = (await import(url)) as { HostClient: { prototype: Record<string, unknown> } };
  const proto = mod.HostClient.prototype as {
    onReady: (this: unknown, listener: () => void) => () => void;
    call: (
      this: unknown,
      service: string,
      method: string,
      payload: unknown,
      options?: { onChunk?: (p: unknown) => void },
    ) => Promise<unknown>;
  };
  const origOnReady = proto.onReady;
  const origCall = proto.call;
  let listeners = 0;
  proto.onReady = function (this: unknown, listener: () => void): () => void {
    const seq = ++listeners;
    return origOnReady.call(this, () => {
      write({ ev: 'onReady', seq });
      listener();
    });
  };
  proto.call = function (this: unknown, service, method, payload, options) {
    if (method === 'open' && options?.onChunk !== undefined) {
      const orig = options.onChunk;
      const server = (payload as { server?: unknown } | null)?.server;
      return origCall.call(this, service, method, payload, {
        ...options,
        onChunk: (chunk: unknown) => {
          if (typeof chunk === 'object' && chunk !== null && 'ready' in chunk)
            write({ ev: 'openReady', server });
          orig(chunk);
        },
      });
    }
    return origCall.call(this, service, method, payload, options);
  };
  write({
    ev: 'loaded',
    url,
    file,
    sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    entry: process.argv[1],
  });
}
