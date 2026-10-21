/**
 * **「模型呼叫的失敗」的記號只標在真的是模型呼叫失敗的錯上**（[#1778](https://github.com/DemianLi/nexus-agent/issues/1778)，接 #1763）。
 *
 * 記號決定失敗分類器敢不敢套「只看結構」的連線規則（`ECONNREFUSED`、串流中段的 in-band 錯誤…）。#1763 之後記號在剝 `MiddlewareError`
 * 包裝時保留，而當時的標記點（`emptyResponse` 那一層）在 plugin 的 `wrapModelCall` 外面——插件自己拋的錯也被標成模型的 `TRANSPORT`。
 * 現在標在最內層（`turn-cancel.ts` 的 `createTurnCancelModelSignal`），插件的錯碰不到。
 *
 * 走 serve 的路（真的 `createLiveModel`＋`createNexusAgent`＋`ThreadPump`＋loopback 端點，同 `invalid-credential-wiring.test.ts`），
 * 讀 `turn/failed.error`。每一格都配一個反例，不然「一律回 UNKNOWN」也會綠：
 *
 * | 誰拋的錯 | 形狀 | 期望 |
 * | --- | --- | --- |
 * | 插件 `wrapModelCall`，叫 handler 之前 | cause 帶 `ECONNREFUSED` | `UNKNOWN` |
 * | 插件 `wrapModelCall`，叫完 handler 之後 | 同上 | `UNKNOWN` |
 * | 模型（端點在回應中途斷線），有插件包著 | 先吐內容再斷 | `TRANSPORT` |
 * | 模型（端點在回應中途斷線），沒有插件 | 同上 | `TRANSPORT` |
 * | 模型（開頭就 502） | | `SERVER`／502 |
 *
 * 串流中段的 in-band 503 仍是 `SERVER`／503，由 `serve-inband-mid-failed.test.ts` 守著（不改）。
 *
 * **零憑證、零外部連線**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { createMiddleware } from 'langchain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { LIVE_API_KEY_ENV, createLiveModel } from './live-model.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type Behavior = 'ok' | 'head-502' | 'mid-disconnect';

let root: string;
let server: Server;
let baseUrl: string;
let behavior: Behavior;
let requests: number;

const chunk = (delta: Record<string, unknown>, reason: string | null): string =>
  `data: ${JSON.stringify({
    id: 'chatcmpl-x',
    object: 'chat.completion.chunk',
    created: 1_790_000_000,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: reason }],
  })}\n\n`;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'model-failure-mark-'));
  behavior = 'ok';
  requests = 0;
  vi.stubEnv(LIVE_API_KEY_ENV, 'nvapi-fake-for-loopback-only');
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests += 1;
    request.resume();
    request.on('end', () => {
      if (behavior === 'head-502') {
        response.writeHead(502, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'bad gateway', type: 'x' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk({ role: 'assistant', content: '好' }, null));
      if (behavior === 'mid-disconnect') {
        // 先吐內容、不收尾就把連線掐掉：`end` 是正常結束，不是斷線。
        setTimeout(() => request.socket.destroy(), 20);
        return;
      }
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

/** cause 帶 `ECONNREFUSED` 的錯：MCP 伺服器連不上那種形狀。 */
const refused = (): Error =>
  new Error('插件自己連不上外面', {
    cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
  });

/** 掛一顆 `wrapModelCall` 的插件；`when` 決定它在叫 handler 之前還是之後拋，`pass` 是只包不拋（錯誤原樣穿過）。 */
function wrapPlugin(when: 'before' | 'after' | 'pass'): PluginEntry {
  return {
    plugin: {
      name: `probe-wrap-model-${when}`,
      apply(registry) {
        registry.middleware.use(
          createMiddleware({
            name: `probe-wrap-model-${when}`,
            wrapModelCall: async (request, handler) => {
              if (when === 'before') throw refused();
              const response = await handler(request);
              if (when === 'after') throw refused();
              return response;
            },
          }),
        );
      },
    },
  };
}

async function failure(
  plugins: PluginEntry[],
): Promise<{ code: string; status?: number; retries: number }> {
  const config = liveModelConfigSchema.parse({
    baseUrl,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 1,
      backoff: { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
    },
  });
  const built = await createNexusAgent({
    model: createLiveModel(config),
    checkpointer: new MemorySaver(),
    plugins,
    streamRetry: streamRetryOptionsOf(config.retryPolicy),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'model-failure-mark');
  const detach = built.attachSession(pump.sessions);
  try {
    await pump.submit({ kind: 'message', text: '嗨' }).then(
      () => undefined,
      () => undefined,
    );
    const events = [...pump.sessions.root.events] as SessionEvent[];
    const failed = events.filter((event) => event.type === 'turn/failed');
    expect(failed).toHaveLength(1);
    const error = (failed[0]!.data as { error: { code: string; status?: number } }).error;
    return {
      code: error.code,
      ...(error.status !== undefined && { status: error.status }),
      retries: events.filter((event) => event.type === 'llm/retry').length,
    };
  } finally {
    detach();
    await built.dispose();
  }
}

describe('插件 wrapModelCall 自己拋的錯不是模型的失敗', () => {
  it.each(['before', 'after'] as const)(
    '叫 handler 之%s拋、cause 帶 ECONNREFUSED → UNKNOWN，不是 TRANSPORT',
    async (when) => {
      const result = await failure([wrapPlugin(when)]);
      expect(result.code).toBe('UNKNOWN');
      // 前提：「之前」那一格端點一個請求都沒收到，「之後」那一格端點被叫過——拋的真的是插件，不是模型。
      expect(requests).toBe(when === 'before' ? 0 : 1);
    },
    60_000,
  );
});

describe('模型自己的失敗照舊分得出來（反例：不是一律 UNKNOWN）', () => {
  it('回應中途斷線、沒有插件 → TRANSPORT', async () => {
    behavior = 'mid-disconnect';
    expect((await failure([])).code).toBe('TRANSPORT');
  }, 60_000);

  it('回應中途斷線、有一顆只包不拋的插件 wrapModelCall → 仍是 TRANSPORT', async () => {
    behavior = 'mid-disconnect';
    expect((await failure([wrapPlugin('pass')])).code).toBe('TRANSPORT');
  }, 60_000);

  it('開頭就 502 → SERVER／502', async () => {
    behavior = 'head-502';
    const result = await failure([]);
    expect(result).toMatchObject({ code: 'SERVER', status: 502 });
  }, 60_000);
});
