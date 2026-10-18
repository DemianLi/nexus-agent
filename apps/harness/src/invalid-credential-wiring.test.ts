/**
 * **受管檔在兩個請求之間被改壞：這一輪明講金鑰不能用，不是一句 `Headers.append`**
 * （[#1541](https://github.com/DemianLi/nexus-agent/issues/1541)）。
 *
 * 走 serve 的路（真的 `createLiveModel`＋`createNexusAgent`＋`ThreadPump`＋loopback 串流端點，同 `empty-response.test.ts`），
 * 第一輪用好的 key，之後把受管檔換成含換行的值（`|` 區塊寫法貼出來的樣子），第二輪：
 *
 * - `turn/failed.error.code` 是 `INVALID_CREDENTIAL`，訊息指名 `NVIDIA_API_KEY` 與受管檔路徑；
 * - 日誌（含 `turn/failed`）與錯誤訊息都沒有 key 的任何片段；
 * - 端點只收到壞掉之前的那個請求；
 * - 沒有 `llm/retry`（同一把壞 key 重打幾次都一樣）。
 *
 * 紅燈（拿掉 `apiKey` 函式裡的檢查）：key 原樣進標頭，`fetch` 丟的 `TypeError` 訊息就是整把 key，
 * 分類成 `UNKNOWN`、訊息帶著 key 進了日誌。
 *
 * **零憑證、零外部連線**。
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { CREDENTIALS_FILE, createCredentialService } from './credentials.js';
import { loadLaunchEnv } from './launch-env.js';
import { LIVE_API_KEY_ENV, createLiveModel } from './live-model.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const GOOD_KEY = 'nvapi-good-for-loopback-only';
const RETRIES = 2;

let root: string;
let home: string;
let server: Server;
let requests: number;
let baseUrl: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'invalid-credential-'));
  home = join(root, 'home');
  mkdirSync(home);
  requests = 0;
  vi.stubEnv(LIVE_API_KEY_ENV, undefined as unknown as string);
  delete process.env[LIVE_API_KEY_ENV];
  server = createServer((request, response) => {
    requests += 1;
    request.resume();
    request.on('end', () => {
      const chunk = (delta: Record<string, unknown>, reason: string | null): string =>
        `data: ${JSON.stringify({
          id: `chatcmpl-${String(requests)}`,
          object: 'chat.completion.chunk',
          created: 1_790_000_000,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: reason }],
        })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk({ role: 'assistant', content: '好' }, null));
      response.write(chunk({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

function managedRaw(yamlValue: string): void {
  const file = join(home, CREDENTIALS_FILE);
  writeFileSync(file, `version: 1\nrefs:\n  ${LIVE_API_KEY_ENV}: ${yamlValue}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

describe('運行中受管檔被改壞（serve 的路）', () => {
  it('第二輪 turn/failed 是 INVALID_CREDENTIAL：不送出、不重打、日誌沒有 key 片段', async () => {
    managedRaw(GOOD_KEY);
    const launchEnv = loadLaunchEnv({ cwd: root, home, target: {}, warn: () => undefined });
    const credentials = createCredentialService({ home, launchEnv, warn: () => undefined });
    const config = liveModelConfigSchema.parse({
      baseUrl,
      retryPolicy: {
        mode: 'normal',
        maxRetries: RETRIES,
        backoff: { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
      },
    });
    const built = await createNexusAgent({
      model: createLiveModel(config, undefined, credentials),
      checkpointer: new MemorySaver(),
      plugins: [],
      streamRetry: streamRetryOptionsOf(config.retryPolicy),
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'invalid-credential');
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '第一句' });
      expect(requests).toBe(1);

      // 兩個請求之間，有人用 `|` 區塊貼進一把帶換行的 key。
      managedRaw('"nvapi-SECRETPIECE\\nnvapi-SECRETPIECE"');
      await pump.submit({ kind: 'message', text: '第二句' }).then(
        () => undefined,
        () => undefined,
      );

      const events = [...pump.sessions.root.events] as SessionEvent[];
      const failed = events.filter((event) => event.type === 'turn/failed');
      expect(failed).toHaveLength(1);
      const error = (failed[0]!.data as { error: { code: string; message: string } }).error;
      expect(error.code).toBe('INVALID_CREDENTIAL');
      expect(error.message).toContain(LIVE_API_KEY_ENV);
      expect(error.message).toContain(join(home, CREDENTIALS_FILE));
      expect(JSON.stringify(events)).not.toContain('SECRETPIECE');
      expect(JSON.stringify(events)).not.toContain('Headers.append');
      expect(events.filter((event) => event.type === 'llm/retry')).toHaveLength(0);
      expect(requests).toBe(1);
    } finally {
      detach();
      await built.dispose();
    }
  }, 30_000);
});
