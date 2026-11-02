/**
 * **送往模型端點的請求：`User-Agent` 與空的工具結果**（[#1562](https://github.com/DemianLi/nexus-agent/issues/1562)）。
 *
 * - 每個請求的 `User-Agent` 是 `nexus-agent/<版號> (+https://github.com/DemianLi/nexus-agent)`，不是基座的 `langchainjs-openai/…`
 *   （帶著 Node 版本、作業系統與 CPU 架構）。`withAttribution` 的輸入形狀（`Request`、物件、`Headers`、陣列、大小寫）在最上面；
 *   接線從 `createLiveModel` 與真的 `runServe --live` 量。
 * - MCP 工具回了空結果，下一個模型請求裡那則工具訊息是 `(no output)`：接線走 `runServe --live`，工具是
 *   [`mcp-fixture-server.ts`](./mcp-fixture-server.ts) 的 `empty_result`（回 `content: []`），端點是 loopback 假端點，記下每個請求的標頭與 body。
 *
 * **零憑證、零外部連線**：key 是假值，端點在 loopback。
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { publicToolName } from '@nexus/plugin-mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { APP_IDENTITY, userAgent } from './attribution.js';
import { runCli } from './cli.js';
import { bodyLog, foldTurn, serveClient } from './fixtures.js';
import { HARNESS_VERSION } from './harness-version.js';
import { HARNESS_HOME_ENV } from './harness-home.js';
import {
  createLiveModel,
  DEFAULT_LIVE_MODEL_ENTRY,
  LIVE_API_KEY_ENV,
  withAttribution,
} from './live-model.js';
import { EMPTY_RESULT } from './mcp-fixture-server.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { liveModelConfigSchema } from './settings/live-model.js';

const SERVER = fileURLToPath(new URL('./mcp-fixture-server.ts', import.meta.url));
const HARNESS = fileURLToPath(new URL('..', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../package.json', import.meta.url));
const EXPECTED_UA = `nexus-agent/${(JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version: string }).version} (+https://github.com/DemianLi/nexus-agent)`;
const A = 'model-a';
const B = 'model-b';
const EMPTY_TOOL = publicToolName('empty', EMPTY_RESULT);

interface Seen {
  readonly userAgent: string | undefined;
  readonly model: string;
  readonly title: boolean;
  readonly messages: readonly Record<string, unknown>[];
}

const temporary: string[] = [];
let upstream: { baseUrl: string; seen: Seen[]; close(): Promise<void> } | undefined;
let running: RunningServe | undefined;

/**
 * loopback 的假端點。每個請求記一筆；**主請求的第一次回一個工具呼叫**（`callTool` 有給的話），其餘回一句話。
 * 標題請求（系統訊息以 `Create a concise title` 開頭）永遠回一句話。
 */
async function endpoint(callTool?: string) {
  const seen: Seen[] = [];
  let mainRequests = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        stream?: boolean;
        messages?: Record<string, unknown>[];
      };
      const first = body.messages?.[0];
      const title =
        first?.['role'] === 'system' &&
        typeof first['content'] === 'string' &&
        first['content'].startsWith('Create a concise title');
      seen.push({
        userAgent: request.headers['user-agent'],
        model: body.model,
        title,
        messages: body.messages ?? [],
      });
      const id = `chatcmpl-${String(seen.length)}`;
      const toolCall =
        !title && callTool !== undefined && (mainRequests += 1) === 1
          ? {
              id: 'call-empty-1',
              type: 'function',
              function: { name: callTool, arguments: '{}' },
            }
          : undefined;
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: 'fake',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: toolCall === undefined ? '好' : null,
                  ...(toolCall !== undefined && { tool_calls: [toolCall] }),
                },
                finish_reason: toolCall === undefined ? 'stop' : 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const piece = (delta: Record<string, unknown>, reason: string | null): string =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: reason }],
        })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (toolCall === undefined) {
        response.write(piece({ role: 'assistant', content: '好' }, null));
        response.write(piece({}, 'stop'));
      } else {
        response.write(
          piece(
            { role: 'assistant', content: null, tool_calls: [{ index: 0, ...toolCall }] },
            null,
          ),
        );
        response.write(piece({}, 'tool_calls'));
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

/** 一個 home、一個專案資料夾、一份指到假端點的 patch（可選：多插一列 MCP，連 `empty_result` 那支夾具）。 */
function layout(options: { readonly mcp?: boolean } = {}) {
  const base = scratch('nexus-attribution-');
  const home = join(base, 'home');
  const cwd = join(base, 'project');
  const root = join(base, 'log');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(cwd);
  mkdirSync(root);
  const entry = (id: string) => ({ ...structuredClone(DEFAULT_LIVE_MODEL_ENTRY), id });
  const patch = join(base, 'patch.yml');
  // JSON 是合法的 YAML。
  writeFileSync(
    patch,
    JSON.stringify([
      {
        id: 'live-model',
        config: {
          baseUrl: upstream!.baseUrl,
          retryPolicy: { mode: 'normal', maxRetries: 0 },
          modelId: A,
          models: [entry(A), entry(B)],
        },
      },
      ...(options.mcp === true
        ? [
            {
              insert: [
                {
                  id: 'mcp-empty',
                  name: '@nexus/plugin-mcp',
                  config: {
                    serverName: 'empty',
                    connection: {
                      transport: 'stdio',
                      command: process.execPath,
                      args: ['--import', 'tsx', SERVER],
                      cwd: HARNESS,
                    },
                    approval: { exempt: [EMPTY_RESULT] },
                  },
                },
              ],
            },
          ]
        : []),
    ]),
  );
  return { home, cwd, root, patch, env: { [HARNESS_HOME_ENV]: home } };
}

async function serve(where: ReturnType<typeof layout>): Promise<RunningServe> {
  return (await runServe({
    argv: ['--port', '0', '--live', '--session-log', where.root, '--patch', where.patch],
    log: bodyLog([]),
    env: where.env,
    cwd: where.cwd,
  })) as RunningServe;
}

/** 在一條 thread 上送一句，等這一輪結束、標題請求出現（標題沒關的話它會跟著送）。 */
async function oneTurn(server: RunningServe, select?: string): Promise<void> {
  const client = await serveClient(server);
  const events = await client.openEvents('t');
  if (select !== undefined) await client.selectModel('t', { modelId: select });
  await client.runStart('t', '做個空的');
  await foldTurn(events);
  for (let tries = 0; tries < 400 && !upstream!.seen.some((entry) => entry.title); tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await events.return?.(undefined);
}

beforeEach(() => {
  vi.stubEnv(LIVE_API_KEY_ENV, 'zq9attr-fake-0123456789');
});
afterEach(async () => {
  await running?.close();
  running = undefined;
  await upstream?.close();
  upstream = undefined;
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('./harness-version.js');
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('withAttribution：輸入的形狀', () => {
  /** 底層 fetch 換成記下「收到什麼」的替身。 */
  function recording() {
    const calls: { input: Parameters<typeof fetch>[0]; init: RequestInit | undefined }[] = [];
    const base = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as typeof fetch;
    return { calls, base };
  }
  const sentHeaders = (init: RequestInit | undefined): Headers => new Headers(init?.headers);

  it('物件形狀的 init.headers：User-Agent 換成產品的，其餘標頭原樣', async () => {
    const { calls, base } = recording();
    await withAttribution(base)('http://h/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer x', 'x-stainless-os': 'MacOS' },
    });
    const headers = sentHeaders(calls[0]!.init);
    expect(headers.get('user-agent')).toBe(userAgent());
    expect(headers.get('authorization')).toBe('Bearer x');
    expect(headers.get('x-stainless-os')).toBe('MacOS');
  });

  it('已經帶了 User-Agent（大寫、小寫）：換掉，不是補上也不是留兩個', async () => {
    for (const name of ['User-Agent', 'user-agent', 'USER-AGENT']) {
      const { calls, base } = recording();
      await withAttribution(base)('http://h/v1/x', {
        headers: { [name]: 'langchainjs-openai/1.0.0 (node/v25; darwin; arm64)' },
      });
      const headers = sentHeaders(calls[0]!.init);
      expect(headers.get('user-agent')).toBe(userAgent());
      expect([...headers.keys()].filter((key) => key === 'user-agent')).toHaveLength(1);
    }
  });

  it('Headers 物件與 [名, 值] 陣列：同樣換掉、其餘照舊', async () => {
    const forms: NonNullable<ConstructorParameters<typeof Headers>[0]>[] = [
      new Headers({ 'User-Agent': 'old', 'x-keep': '1' }),
      [
        ['User-Agent', 'old'],
        ['x-keep', '1'],
      ],
    ];
    for (const form of forms) {
      const { calls, base } = recording();
      await withAttribution(base)('http://h/v1/x', { headers: form });
      const headers = sentHeaders(calls[0]!.init);
      expect(headers.get('user-agent')).toBe(userAgent());
      expect(headers.get('x-keep')).toBe('1');
    }
  });

  it('沒有 init：輸入是 Request 時沿用它自己的標頭再換 User-Agent；init 的其他欄位原樣', async () => {
    const { calls, base } = recording();
    const request = new Request('http://h/v1/x', {
      method: 'POST',
      headers: { 'User-Agent': 'old', 'x-keep': '1' },
      body: '{}',
    });
    await withAttribution(base)(request);
    expect(calls[0]!.input).toBe(request);
    const headers = sentHeaders(calls[0]!.init);
    expect(headers.get('user-agent')).toBe(userAgent());
    expect(headers.get('x-keep')).toBe('1');

    const withInit = recording();
    const signal = new AbortController().signal;
    await withAttribution(withInit.base)('http://h/v1/x', { method: 'POST', body: '{}', signal });
    expect(withInit.calls[0]!.init).toMatchObject({ method: 'POST', body: '{}', signal });
  });

  it('什麼標頭都沒帶：也補上 User-Agent', async () => {
    const { calls, base } = recording();
    await withAttribution(base)('http://h/v1/x');
    expect(sentHeaders(calls[0]!.init).get('user-agent')).toBe(userAgent());
  });
});

describe('身分的內容與來源', () => {
  it('userAgent() 是 product/version (+url)，只讀 APP_IDENTITY 三格', () => {
    expect(Object.keys(APP_IDENTITY).sort()).toEqual(['product', 'url', 'version']);
    expect(userAgent()).toBe(
      `${APP_IDENTITY.product}/${APP_IDENTITY.version} (+${APP_IDENTITY.url})`,
    );
    expect(userAgent()).toBe(EXPECTED_UA);
    expect(APP_IDENTITY.version).toBe(HARNESS_VERSION);
  });

  it('不含 Node 版本、作業系統、CPU 架構、主機名、home 路徑', () => {
    const ua = userAgent();
    for (const secret of [process.version, process.platform, process.arch, hostname(), homedir()]) {
      expect(ua).not.toContain(secret);
    }
    expect(ua).not.toContain('langchainjs');
  });

  it('版號跟著 harness-version 走：換掉那一份，UA 跟著變（寫死字串就紅）', async () => {
    vi.resetModules();
    vi.doMock('./harness-version.js', () => ({ HARNESS_VERSION: '9.8.7' }));
    const fresh = await import('./attribution.js');
    expect(fresh.userAgent()).toBe('nexus-agent/9.8.7 (+https://github.com/DemianLi/nexus-agent)');
  });
});

describe('createLiveModel：每個請求都帶產品的 User-Agent', () => {
  it('createLiveModel 建的模型送一次請求：端點收到的 user-agent 恰好是 nexus-agent/<package.json 的版號> (+repo 網址)', async () => {
    upstream = await endpoint();
    const model = createLiveModel(liveModelConfigSchema.parse({ baseUrl: upstream.baseUrl }));
    await model.invoke('嗨');

    // 先證明端點確實收到了請求，再比 UA。
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]!.userAgent).toBe(EXPECTED_UA);
  }, 30000);

  it('串流請求也一樣（`createLiveModel` 的串流走同一個 fetch）', async () => {
    upstream = await endpoint();
    const model = createLiveModel(liveModelConfigSchema.parse({ baseUrl: upstream.baseUrl }));
    const chunks = [];
    for await (const chunk of await model.stream('嗨')) chunks.push(chunk);

    expect(chunks.length).toBeGreaterThan(0);
    expect(upstream.seen).toHaveLength(1);
    expect(upstream.seen[0]!.userAgent).toBe(EXPECTED_UA);
  }, 30000);

  it('真的 `runServe --live`：主模型、標題、換模型建的別顆，端點收到的 user-agent 都相同', async () => {
    upstream = await endpoint();
    const where = layout();
    running = await serve(where);
    await oneTurn(running, B);

    // 先證明三種請求都真的到了端點：主請求（A 與換過之後的 B）與標題請求。
    const main = upstream.seen.filter((entry) => !entry.title);
    expect(main.length).toBeGreaterThan(0);
    expect(upstream.seen.some((entry) => entry.title)).toBe(true);
    expect(main.some((entry) => entry.model === B)).toBe(true);
    for (const entry of upstream.seen) expect(entry.userAgent).toBe(EXPECTED_UA);
  }, 60000);

  it('一次性入口（`runCli --live`）：同一個 user-agent', async () => {
    upstream = await endpoint();
    const where = layout();
    await runCli({
      argv: ['--live', '--patch', where.patch, '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
      env: where.env,
      cwd: where.cwd,
    });

    expect(upstream.seen.length).toBeGreaterThan(0);
    for (const entry of upstream.seen) expect(entry.userAgent).toBe(EXPECTED_UA);
  }, 60000);
});

describe('空的 MCP 工具結果：下一個模型請求裡是 (no output)', () => {
  it('`runServe --live`＋夾具的 empty_result：端點收到的工具訊息 content 是 `(no output)`，tool_call_id 不變', async () => {
    upstream = await endpoint(EMPTY_TOOL);
    const where = layout({ mcp: true });
    running = await serve(where);
    await oneTurn(running);

    // 先證明模型真的叫了工具、又被問了第二次（第二個主請求）。
    const main = upstream.seen.filter((entry) => !entry.title);
    expect(main.length).toBeGreaterThanOrEqual(2);
    const toolMessages = main[1]!.messages.filter((message) => message['role'] === 'tool');
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]).toMatchObject({ tool_call_id: 'call-empty-1', content: '(no output)' });
  }, 90000);
});
