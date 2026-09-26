/**
 * `live-model` 那一列（[#545](https://github.com/DemianLi/nexus-agent/issues/545)）：schema 的邊界、
 * `createLiveModel` 的接線，以及「在設定裡覆寫會生效」的產品路徑驗收。
 *
 * **產品路徑那兩條真的跑 `--live`**，但端點由 patch 換成這個檔自己開的 loopback 假端點——
 * 零憑證、零外部連線。key 用 `vi.stubEnv` 給一把假的：`loadLiveEnvIfNeeded` 看到環境變數已經
 * 有值就不讀專案根目錄的 `.env`，而每一條都當場斷言請求帶的是這把假 key，不是真的那把。
 *
 * **覆寫值一律跟預設不同**（#541 的教訓）：出貨那一列、schema 預設、`live-model.ts` 的常數
 * 今天是同一組數字，拿預設值去驗量不出「那一列有沒有在講話」。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import type { ChatOpenAI } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCliAgent, runCli } from '../cli.js';
import { foldTurn, serveClient } from '../fixtures.js';
import {
  DEFAULT_LIVE_BASE_URL,
  DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
  DEFAULT_LIVE_MAX_RETRIES,
  DEFAULT_LIVE_MODEL_ID,
  DEFAULT_LIVE_THINKING_OFF_BODY,
  DEFAULT_LIVE_TIMEOUT_MS,
  LIVE_API_KEY_ENV,
  createLiveModel,
} from '../live-model.js';
import { loadDefaultPlugins } from '../plugin-config.js';
import { runServe } from '../serve.js';
import type { RunningServe } from '../serve.js';
import {
  liveModelConfigSchema,
  liveModelPlugin,
  MAX_LIVE_RETRIES,
  MAX_LIVE_TIMEOUT_MS,
} from './live-model.js';
import type { LiveModelConfig } from './live-model.js';
import { startupSetting } from './startup.js';

/** 一把明顯是假的 key。每一條產品路徑測試都斷言請求帶的是它。 */
const FAKE_KEY = 'nvapi-fake-for-loopback-only';

/** 覆寫用的那一組，六格都跟預設不同。`baseUrl` 在測試裡換成 loopback 的位址。 */
const OVERRIDE: Omit<LiveModelConfig, 'baseUrl'> = {
  modelId: 'nexus-test/override-model',
  maxOutputTokens: 1234,
  timeoutMs: 4321,
  maxRetries: 2,
  thinkingOffBody: { chat_template_kwargs: { enable_thinking: false, nexus_override: true } },
};

/** 主模型身上讀得回的那幾格：五個連線值。`thinkingOffBody` 只到標題那顆，由請求本身驗。 */
function connectionOf(config: LiveModelConfig): Omit<LiveModelConfig, 'thinkingOffBody'> {
  const { thinkingOffBody: _unused, ...connection } = config;
  return connection;
}

describe('live-model 的 schema', () => {
  it('空的 config 解出來就是 live-model.ts 那六個預設值', () => {
    expect(liveModelConfigSchema.parse({})).toEqual({
      baseUrl: DEFAULT_LIVE_BASE_URL,
      modelId: DEFAULT_LIVE_MODEL_ID,
      maxOutputTokens: DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
      timeoutMs: DEFAULT_LIVE_TIMEOUT_MS,
      maxRetries: DEFAULT_LIVE_MAX_RETRIES,
      thinkingOffBody: DEFAULT_LIVE_THINKING_OFF_BODY,
    });
  });

  it('關推理那一格的預設值是 #650 量過的那一種寫法', () => {
    // 字面值，不是讀常數：常數改掉的話兩邊一起動，這一條就量不到它。
    expect(liveModelConfigSchema.parse({}).thinkingOffBody).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    // 空物件是「這顆模型不必關」：合法。
    expect(liveModelConfigSchema.parse({ thinkingOffBody: {} }).thinkingOffBody).toEqual({});
  });

  it.each([
    ['https 的根', 'https://integrate.api.nvidia.com/v1'],
    ['http 也放行（照 dsh）', 'http://10.0.0.5:8000/v1'],
    ['沒有路徑', 'https://gateway.internal'],
  ])('端點合格：%s', (_label, baseUrl) => {
    expect(liveModelConfigSchema.parse({ baseUrl }).baseUrl).toBe(baseUrl);
  });

  it.each([
    ['不是 http(s)', 'ftp://gateway.internal/v1'],
    ['帶帳密——等於把 key 寫進設定', 'https://user:secret@gateway.internal/v1'],
    ['只帶帳號也不行', 'https://user@gateway.internal/v1'],
    ['帶 query', 'https://gateway.internal/v1?key=abc'],
    ['帶 fragment', 'https://gateway.internal/v1#frag'],
    ['不是網址', 'integrate.api.nvidia.com/v1'],
    ['空字串', ''],
  ])('端點不合格：%s', (_label, baseUrl) => {
    expect(() => liveModelConfigSchema.parse({ baseUrl })).toThrow();
  });

  /**
   * **下限 1 是承重的**：`isDerivedContextOverflow` 唯一的前提是送出去的 `max_tokens` 恆為正數。
   * 放行 0 或負數的話，伺服器回來的負值就不再只可能是它自己導出來的。
   */
  it('輸出上限必須是正整數', () => {
    expect(liveModelConfigSchema.parse({ maxOutputTokens: 1 }).maxOutputTokens).toBe(1);
    for (const maxOutputTokens of [0, -1, 1.5]) {
      expect(
        () => liveModelConfigSchema.parse({ maxOutputTokens }),
        String(maxOutputTokens),
      ).toThrow();
    }
  });

  it('逾時的上限是計時器收得住的最大延遲', () => {
    // 字面值，不是讀常數：常數改掉的話兩邊一起動，這一條就量不到它。
    expect(MAX_LIVE_TIMEOUT_MS).toBe(2_147_483_647);
    expect(liveModelConfigSchema.parse({ timeoutMs: 2_147_483_647 }).timeoutMs).toBe(2_147_483_647);
    expect(() => liveModelConfigSchema.parse({ timeoutMs: 2_147_483_648 })).toThrow();
    expect(() => liveModelConfigSchema.parse({ timeoutMs: 0 })).toThrow();
  });

  it('重試次數 0 到 10——退避沒有上限，所以次數要有', () => {
    expect(MAX_LIVE_RETRIES).toBe(10);
    expect(liveModelConfigSchema.parse({ maxRetries: 0 }).maxRetries).toBe(0);
    expect(liveModelConfigSchema.parse({ maxRetries: 10 }).maxRetries).toBe(10);
    expect(() => liveModelConfigSchema.parse({ maxRetries: 11 })).toThrow();
    expect(() => liveModelConfigSchema.parse({ maxRetries: -1 })).toThrow();
  });

  it('模型 id 不能是空的；多寫一格是打錯字', () => {
    expect(() => liveModelConfigSchema.parse({ modelId: '' })).toThrow();
    expect(() => liveModelConfigSchema.parse({ model: 'x' })).toThrow();
  });
});

describe('createLiveModel 的接線', () => {
  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('五個連線值都照傳進來的那一份建，不是照常數', () => {
    const config: LiveModelConfig = { ...OVERRIDE, baseUrl: 'http://127.0.0.1:9/v1' };
    const model = createLiveModel(config);
    // `maxRetries` 不是公開屬性，它被拿去建 `AsyncCaller`——問那個 caller，理由同
    // `live-model.test.ts` 的「重試設定到得了 AsyncCaller」。
    const { caller } = model as unknown as { caller: { maxRetries: number } };

    expect({
      baseUrl: model.clientConfig.baseURL,
      modelId: model.model,
      maxOutputTokens: model.maxTokens,
      timeoutMs: model.timeout,
      maxRetries: caller.maxRetries,
    }).toEqual(connectionOf(config));
  });

  it('關推理那一格只給標題用途的那一顆（#650）', () => {
    const config: LiveModelConfig = { ...OVERRIDE, baseUrl: 'http://127.0.0.1:9/v1' };

    // 沒給的時候 `ChatOpenAI` 自己補成空物件。
    expect(createLiveModel(config).modelKwargs).toEqual({});
    expect(createLiveModel(config, 'session-title').modelKwargs).toEqual(OVERRIDE.thinkingOffBody);
    // 空物件是「這顆模型不必關」：標題那顆也不帶任何東西。
    expect(
      createLiveModel({ ...config, thinkingOffBody: {} }, 'session-title').modelKwargs,
    ).toEqual({});
  });
});

/** 一次打進假端點的請求，只記斷言要用的幾格。 */
interface SeenRequest {
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly model: unknown;
  readonly maxTokens: unknown;
  /** 關推理那一格；主請求不該有。 */
  readonly chatTemplateKwargs: unknown;
  /** 標題請求（#650）：系統提示是標題那一段。它什麼時候打進來看時序，所以另外判。 */
  readonly title: boolean;
}

/**
 * 一個會回話的 OpenAI 相容假端點：串流與非串流都回一句「好」。
 *
 * **兩種都要會**：CLI 走非串流、serve 走串流（2026-09-23 量過：這個檔的兩條產品路徑各打一次，
 * CLI 那次請求的 `stream` 是 false、serve 那次是 true）。
 * **每次回應的 id 都不同**：同 id 的 AI 訊息會被 reducer 取代，歷史少一截看起來像產品 bug。
 */
async function startFakeEndpoint(): Promise<{
  server: Server;
  baseUrl: string;
  seen: SeenRequest[];
}> {
  const seen: SeenRequest[] = [];
  let next = 0;
  const server = createServer((request: IncomingMessage, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: unknown;
        max_tokens?: unknown;
        stream?: unknown;
        chat_template_kwargs?: unknown;
        messages?: readonly { role?: unknown; content?: unknown }[];
      };
      const system = body.messages?.[0];
      seen.push({
        path: request.url,
        authorization: request.headers.authorization,
        model: body.model,
        maxTokens: body.max_tokens,
        chatTemplateKwargs: body.chat_template_kwargs,
        title:
          system?.role === 'system' &&
          typeof system.content === 'string' &&
          system.content.startsWith('Create a concise title'),
      });
      next += 1;
      const id = `chatcmpl-fake-${String(next)}`;
      const model = typeof body.model === 'string' ? body.model : 'unknown';
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 1_790_000_000,
            model,
            choices: [
              { index: 0, message: { role: 'assistant', content: '好' }, finish_reason: 'stop' },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1_790_000_000,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk({ role: 'assistant', content: '' }, null));
      response.write(chunk({ content: '好' }, null));
      response.write(chunk({}, 'stop'));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(port)}/v1`, seen };
}

/** 把那一列換成指向假端點的覆寫值，寫成一份 `--patch` 檔。 */
async function writeOverridePatch(baseUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-live-model-'));
  const path = join(dir, 'live-model.patch.yml');
  await writeFile(
    path,
    [
      '- id: live-model',
      '  config:',
      `    baseUrl: '${baseUrl}'`,
      `    modelId: '${OVERRIDE.modelId}'`,
      `    maxOutputTokens: ${String(OVERRIDE.maxOutputTokens)}`,
      `    timeoutMs: ${String(OVERRIDE.timeoutMs)}`,
      `    maxRetries: ${String(OVERRIDE.maxRetries)}`,
      `    thinkingOffBody: ${JSON.stringify(OVERRIDE.thinkingOffBody)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  return path;
}

/**
 * 每一條打進來的請求都帶著覆寫值與那把假 key。
 *
 * **標題請求（#650）另外判**：它的輸出上限是標題那一列的，而且帶關推理那一格。它打不打得進來看時序（主回覆先
 * 收完的話它會在收尾時被中止），所以這裡只驗「進來了就對」；一定進來的那一條在 `session-title-llm.test.ts`。
 */
function expectOverrideOnEveryRequest(seen: readonly SeenRequest[]): void {
  const main = seen.filter((request) => !request.title);
  // 前提：真的有主請求打進來。少了這一行，零個請求會讓下面的迴圈空轉成綠。
  expect(main.length).toBeGreaterThan(0);
  for (const request of main) {
    expect(request).toEqual({
      path: '/v1/chat/completions',
      authorization: `Bearer ${FAKE_KEY}`,
      model: OVERRIDE.modelId,
      maxTokens: OVERRIDE.maxOutputTokens,
      chatTemplateKwargs: undefined,
      title: false,
    });
  }
  for (const request of seen.filter((each) => each.title)) {
    expect(request).toEqual({
      path: '/v1/chat/completions',
      authorization: `Bearer ${FAKE_KEY}`,
      model: OVERRIDE.modelId,
      maxTokens: 64,
      chatTemplateKwargs: OVERRIDE.thinkingOffBody.chat_template_kwargs,
      title: true,
    });
  }
}

describe('在設定裡覆寫會生效——產品路徑（#545）', () => {
  let fake: Awaited<ReturnType<typeof startFakeEndpoint>>;
  let running: RunningServe | undefined;

  beforeEach(async () => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
    fake = await startFakeEndpoint();
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    vi.unstubAllEnvs();
  });

  it('CLI --live：請求打到 patch 講的端點、帶 patch 講的模型與輸出上限，印的也是那顆模型', async () => {
    const patch = await writeOverridePatch(fake.baseUrl);
    const out: string[] = [];

    await runCli({
      argv: ['--live', '--patch', patch, '說一句話。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: (line: string) => void out.push(line), error: () => undefined },
      env: {},
    });

    expectOverrideOnEveryRequest(fake.seen);
    // **印的是這一次真的用的那一顆**，不是預設值——部署換了模型，印預設就是一句謊話。
    expect(out).toContain(`模型：${OVERRIDE.modelId}`);
  });

  it('serve --live：同上，而且是在 thread 裡建的那顆 model 上', async () => {
    const patch = await writeOverridePatch(fake.baseUrl);
    const logged: string[] = [];
    running = (await runServe({
      argv: ['--port', '0', '--live', '--patch', patch],
      log: (line: string) => void logged.push(line),
      env: {},
    })) as RunningServe;
    expect(logged).toContain(`模型：${OVERRIDE.modelId}`);

    const client = await serveClient(running);
    const threadId = 'live-model-override';
    const events = await client.openEvents(threadId);
    const prompt = '說一句話。';
    await client.runStart(threadId, prompt);
    await foldTurn(events);
    await events.return?.(undefined);

    expectOverrideOnEveryRequest(fake.seen);
  });

  it('serve：那一列寫壞了，server 起不來——不是等到第一條 thread 才炸', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-live-model-'));
    const patch = join(dir, 'bad.patch.yml');
    await writeFile(patch, "- id: live-model\n  config:\n    baseUrl: 'ftp://nope'\n", 'utf8');

    await expect(
      runServe({ argv: ['--port', '0', '--patch', patch], log: () => undefined, env: {} }),
    ).rejects.toThrow(/live-model/u);
  });
});

describe('createCliAgent 拿到的是哪一份', () => {
  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** 從組好的 agent 身上讀回那五個連線值。主模型不帶關推理那一格，見 {@link connectionOf}。 */
  function readBack(model: unknown): Omit<LiveModelConfig, 'thinkingOffBody'> {
    const live = model as ChatOpenAI;
    const { caller } = model as unknown as { caller: { maxRetries: number } };
    // 沒給的時候 `ChatOpenAI` 自己補成空物件。
    expect(live.modelKwargs).toEqual({});
    return {
      baseUrl: live.clientConfig.baseURL ?? '',
      modelId: live.model,
      maxOutputTokens: live.maxTokens ?? Number.NaN,
      timeoutMs: live.timeout ?? Number.NaN,
      maxRetries: caller.maxRetries,
    };
  }

  it('沒傳 liveModel 的呼叫端：從同一份清單解，拿到的跟產品路徑一樣', async () => {
    const baseUrl = 'http://127.0.0.1:9/v1';
    const plugins = await loadDefaultPlugins({
      env: {},
      patches: [await writeOverridePatch(baseUrl)],
    });
    const built = await createCliAgent({ live: true }, plugins);
    try {
      expect(readBack(built.model)).toEqual(connectionOf({ ...OVERRIDE, baseUrl }));
      // 前提：清單上那一列真的是覆寫值——不然上面那句可能只是「跟某個東西相等」。
      expect(startupSetting(plugins, liveModelPlugin)).toEqual({ ...OVERRIDE, baseUrl });
    } finally {
      await built.dispose();
    }
  });

  it('傳了 liveModel：用傳進來的那一份，不再讀清單', async () => {
    const plugins = await loadDefaultPlugins({ env: {} });
    const passed: LiveModelConfig = { ...OVERRIDE, baseUrl: 'http://127.0.0.1:9/v1' };
    const built = await createCliAgent({ live: true, liveModel: passed }, plugins);
    try {
      // 清單上是出貨值，所以讀回覆寫值只可能是傳進來的那一份。
      expect(startupSetting(plugins, liveModelPlugin).modelId).toBe(DEFAULT_LIVE_MODEL_ID);
      expect(readBack(built.model)).toEqual(connectionOf(passed));
    } finally {
      await built.dispose();
    }
  });
});
