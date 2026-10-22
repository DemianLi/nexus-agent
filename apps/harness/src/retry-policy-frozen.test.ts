/**
 * **解出來的重試政策是凍結的，而且凍結一路走到組裝點**（[#1603](https://github.com/DemianLi/nexus-agent/issues/1603)，N0470）。
 *
 * 這一份政策由 `startupSetting` 在起動期解一次、全行程的對話共用（主模型的 `streamRetry`、標題的 `retry`）。
 * 凍結照 dsh `retry-policy.ts:149-195`：誰在執行期對它寫東西，當場拋 `TypeError`，不是靜靜改到所有對話。
 *
 * **前三條從組裝點拿，不在測試裡自己呼叫 `streamRetryOptionsOf`**：`createNexusAgent` 收到的 `streamRetry` 與
 * `createSessionTitleLlm` 收到的 `retry` 是 `assembly-root.ts` 交出去的那一份。設定在路上若被複製一份（外掛列的
 * config 被深複製之類），凍結就沒了，只有從組裝點拿才看得出來。走的是真的 `runCli --live`＋loopback 假端點。
 *
 * **每一條都先證明走的是它要測的那條路**（不然預設值照樣凍結、拿掉 transform 也不會紅）：
 * - 「寫了 `retryPolicy`」：`--patch` 給一組跟出廠不同的 `retryableCodes`，斷言截到的陣列內容剛好是那一組——
 *   設定若退回預設，內容就不是那一組。
 * - 「整格不寫」：`--patch` 把 `live-model` 的 `config` 整份取代成只有 `baseUrl`（patch 是淺層覆寫），
 *   斷言標題模型的路由指到 loopback 端點，證明這一列真的載入了；預設碼是出廠那五個。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { DEFAULT_STREAM_RETRYABLE_CODES } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({
  streamRetry: [] as unknown[],
  titleRetry: [] as unknown[],
  titleRoute: [] as unknown[],
}));

vi.mock('./agent-factory.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./agent-factory.js')>();
  return {
    ...original,
    createNexusAgent: (...args: Parameters<typeof original.createNexusAgent>) => {
      seen.streamRetry.push((args[0] as { streamRetry?: unknown }).streamRetry);
      return original.createNexusAgent(...args);
    },
  };
});

vi.mock('./session-title-llm.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./session-title-llm.js')>();
  return {
    ...original,
    createSessionTitleLlm: (...args: Parameters<typeof original.createSessionTitleLlm>) => {
      const options = args[0] as { retry?: unknown; route?: unknown };
      seen.titleRetry.push(options.retry);
      seen.titleRoute.push(options.route);
      return original.createSessionTitleLlm(...args);
    },
  };
});

import { runCli } from './cli.js';
import { LIVE_API_KEY_ENV } from './live-model.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';

const FAKE_KEY = 'nvapi-fake-for-loopback-only';
/** 出廠沒有的一組碼：只寫一個，截到的陣列內容剛好是它，就證明走的是「寫了 `retryPolicy`」那條。 */
const WRITTEN_CODES = ['RATE_LIMIT'];

/** 一台永遠回 200 的 loopback 假端點：非串流回 JSON，串流回 SSE。只為讓一次性的 CLI 收尾，斷言都在組裝點。 */
async function endpoint() {
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (piece: Buffer) => chunks.push(piece));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        stream?: boolean;
      };
      const base = { id: 'chatcmpl-frozen', created: 1_790_000_000, model: 'fake' };
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            ...base,
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '一個標題' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const piece = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(piece({ role: 'assistant', content: '' }, null));
      response.write(piece({ content: '好' }, null));
      response.write(piece({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function writePatch(lines: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-retry-frozen-'));
  const path = join(dir, 'patch.yml');
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

/** 在 loopback 端點上跑一次 `--live`，`configLines` 是 `live-model` 那一列 `config:` 底下的內容。 */
async function runLive(configLines: readonly string[]) {
  const upstream = await endpoint();
  try {
    const root = await mkdtemp(join(tmpdir(), 'nexus-retry-frozen-log-'));
    const patch = await writePatch([
      '- id: live-model',
      '  config:',
      `    baseUrl: '${upstream.baseUrl}'`,
      ...configLines,
    ]);
    await runCli({
      argv: ['--live', '--session-log', root, '--patch', patch, '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
      env: {},
    });
    return upstream.baseUrl;
  } finally {
    await upstream.close();
  }
}

/** 一份重試選項要同時是：整份凍結、`retryableCodes` 凍結、對陣列 `push` 拋 `TypeError`。 */
function expectFrozenOptions(options: unknown): void {
  const retry = options as { retryableCodes: string[] };
  expect(Object.isFrozen(options)).toBe(true);
  expect(Object.isFrozen(retry.retryableCodes)).toBe(true);
  expect(() => retry.retryableCodes.push('HTTP_422')).toThrow(TypeError);
}

describe('產品組裝：交給每個入口的重試選項是凍結的', () => {
  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
    seen.streamRetry.length = 0;
    seen.titleRetry.length = 0;
    seen.titleRoute.length = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('主模型與標題：寫了 retryPolicy（沒寫 retryableCodes 以外的格）', async () => {
    await runLive([
      '    retryPolicy:',
      '      mode: normal',
      `      retryableCodes: [${WRITTEN_CODES.join(', ')}]`,
    ]);
    // 先證明走的是「寫了 retryPolicy」：碼是我們寫的那一組，不是預設。
    const main = seen.streamRetry.filter((value) => value !== undefined);
    expect(main).toHaveLength(1);
    expect((main[0] as { retryableCodes: string[] }).retryableCodes).toEqual(WRITTEN_CODES);
    expectFrozenOptions(main[0]);

    expect(seen.titleRetry).toHaveLength(1);
    expect((seen.titleRetry[0] as { retryableCodes: string[] }).retryableCodes).toEqual(
      WRITTEN_CODES,
    );
    expectFrozenOptions(seen.titleRetry[0]);
  }, 30000);

  it('主模型與標題：整格不寫 retryPolicy（出廠那條路，zod 的 .default 不跑內層 transform）', async () => {
    const baseUrl = await runLive([]);
    // 先證明 `live-model` 那一列真的載入了（路由指到 loopback 端點）、而且吃的是預設碼。
    expect((seen.titleRoute[0] as { provider: string }).provider).toBe(baseUrl);
    const main = seen.streamRetry.filter((value) => value !== undefined);
    expect(main).toHaveLength(1);
    expect((main[0] as { retryableCodes: string[] }).retryableCodes).toEqual([
      ...DEFAULT_STREAM_RETRYABLE_CODES,
    ]);
    expectFrozenOptions(main[0]);

    expect(seen.titleRetry).toHaveLength(1);
    expectFrozenOptions(seen.titleRetry[0]);
  }, 30000);
});

describe('解析出來的重試政策', () => {
  it('使用者寫進設定的陣列不被凍結，解出來的是另一份、而且凍結', () => {
    const codes = ['RATE_LIMIT'];
    const parsed = liveModelConfigSchema.parse({
      retryPolicy: { mode: 'normal', retryableCodes: codes },
    });
    expect(Object.isFrozen(codes)).toBe(false);
    expect(parsed.retryPolicy.retryableCodes).not.toBe(codes);
    expect(parsed.retryPolicy.retryableCodes).toEqual(['RATE_LIMIT']);
    expect(Object.isFrozen(parsed.retryPolicy.retryableCodes)).toBe(true);
    // 使用者那一份之後改它，不會連動到解出來的政策。
    codes.push('SERVER');
    expect(parsed.retryPolicy.retryableCodes).toEqual(['RATE_LIMIT']);
  });

  it.each([
    ['寫了 retryPolicy', { retryPolicy: { mode: 'normal' } }],
    ['整格不寫', {}],
  ] as const)('%s：整份、retryableCodes、backoff 都凍結，寫入當場拋 TypeError', (_name, input) => {
    const { retryPolicy } = liveModelConfigSchema.parse(input);
    expect(Object.isFrozen(retryPolicy)).toBe(true);
    expect(Object.isFrozen(retryPolicy.retryableCodes)).toBe(true);
    expect(Object.isFrozen(retryPolicy.backoff)).toBe(true);
    const writable = retryPolicy as unknown as {
      maxRetries: number;
      retryableCodes: string[];
      backoff: { initialDelayMs: number };
    };
    expect(() => {
      writable.maxRetries = 99;
    }).toThrow(TypeError);
    expect(() => writable.retryableCodes.push('HTTP_422')).toThrow(TypeError);
    expect(() => {
      writable.backoff.initialDelayMs = 1;
    }).toThrow(TypeError);
  });

  it('streamRetryOptionsOf 回凍結的物件，retryableCodes 就是政策上那個凍結的陣列（不再複製）', () => {
    const { retryPolicy } = liveModelConfigSchema.parse({});
    const options = streamRetryOptionsOf(retryPolicy);
    expect(Object.isFrozen(options)).toBe(true);
    expect(options.retryableCodes).toBe(retryPolicy.retryableCodes);
  });

  it('兩次解析各是各的：出廠預設不共用同一個物件', () => {
    const a = liveModelConfigSchema.parse({}).retryPolicy;
    const b = liveModelConfigSchema.parse({}).retryPolicy;
    expect(a).not.toBe(b);
    expect(a.retryableCodes).not.toBe(b.retryableCodes);
    expect(a.retryableCodes).toEqual(b.retryableCodes);
  });
});
