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

import { runCli } from '../cli.js';
import { createCliAgent } from '../assembly-root.js';
import { foldTurn, serveClient } from '../fixtures.js';
import {
  DEFAULT_LIVE_BASE_URL,
  DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
  DEFAULT_LIVE_MAX_RETRIES,
  DEFAULT_LIVE_MODEL_ENTRY,
  DEFAULT_LIVE_MODEL_ID,
  DEFAULT_LIVE_TIMEOUT_MS,
  LIVE_API_KEY_ENV,
  createLiveModel,
} from '../live-model.js';
import { acceptsImages, findModelEntry, thinkingOffBody } from '../model-catalog.js';
import type { ModelEntry } from '../model-catalog.js';
import { loadDefaultPlugins } from '../plugin-config.js';
import { runServe } from '../serve.js';
import type { RunningServe } from '../serve.js';
import {
  liveModelConfigForModel,
  liveModelConfigSchema,
  liveModelPlugin,
  MAX_LIVE_RETRIES,
  MAX_LIVE_TIMEOUT_MS,
} from './live-model.js';
import type { LiveModelConfig } from './live-model.js';
import { startupSetting } from './startup.js';

/** 一把明顯是假的 key。每一條產品路徑測試都斷言請求帶的是它。 */
const FAKE_KEY = 'nvapi-fake-for-loopback-only';

/** 覆寫用的那一筆型錄條目：跟預設每一格都不同（id、輸出上限、關推理多一格）。 */
const OVERRIDE_ENTRY: ModelEntry = {
  id: 'nexus-test/override-model',
  contextWindow: 4321,
  maxTokens: 1234,
  input: ['text', 'image'],
  reasoningEfforts: { off: null },
  compat: {
    chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' }, nexus_override: true },
  },
};

/** 覆寫用的那一組，每一格都跟預設不同。`baseUrl` 在測試裡換成 loopback 的位址。 */
const OVERRIDE: Omit<LiveModelConfig, 'baseUrl'> = {
  modelId: OVERRIDE_ENTRY.id,
  models: [OVERRIDE_ENTRY],
  timeoutMs: 4321,
  maxRetries: 2,
};

/** 覆寫那一筆在標題請求上關推理的 body。 */
const OVERRIDE_OFF_KWARGS = { enable_thinking: false, nexus_override: true };

/** 主模型身上讀得回的那幾格：連線值與輸出上限（輸出上限來自型錄條目）。 */
function connectionOf(config: LiveModelConfig): Record<string, unknown> {
  return {
    baseUrl: config.baseUrl,
    modelId: config.modelId,
    maxOutputTokens: config.models.find((entry) => entry.id === config.modelId)?.maxTokens,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  };
}

describe('live-model 的 schema', () => {
  it('空的 config 解出來就是 live-model.ts 那幾個預設值，型錄只有出廠那一筆', () => {
    expect(liveModelConfigSchema.parse({})).toEqual({
      baseUrl: DEFAULT_LIVE_BASE_URL,
      modelId: DEFAULT_LIVE_MODEL_ID,
      models: [DEFAULT_LIVE_MODEL_ENTRY],
      timeoutMs: DEFAULT_LIVE_TIMEOUT_MS,
      maxRetries: DEFAULT_LIVE_MAX_RETRIES,
    });
  });

  it('出廠那一筆是量過的字面值，關推理的寫法是 #650 量過的那一種', () => {
    // 字面值，不是讀常數：常數改掉的話兩邊一起動，這一條就量不到它。
    const [entry] = liveModelConfigSchema.parse({}).models;
    expect(entry).toEqual({
      id: 'nvidia/nemotron-3-super-120b-a12b',
      contextWindow: 700_045,
      maxTokens: 16_384,
      input: ['text'],
      reasoningEfforts: { off: null, default: 'default' },
      compat: { chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' } } },
    });
    expect(thinkingOffBody(entry!)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
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
  it('型錄條目的輸出上限必須是正整數', () => {
    const withMax = (maxTokens: number) =>
      liveModelConfigSchema.parse({ models: [{ ...DEFAULT_LIVE_MODEL_ENTRY, maxTokens }] });
    expect(withMax(1).models[0]?.maxTokens).toBe(1);
    for (const maxTokens of [0, -1, 1.5]) {
      expect(() => withMax(maxTokens), String(maxTokens)).toThrow();
    }
  });

  it('頂層不再有 maxOutputTokens 與 thinkingOffBody：輸出上限與關推理跟著型錄條目走', () => {
    expect(() => liveModelConfigSchema.parse({ maxOutputTokens: 8192 })).toThrow();
    expect(() => liveModelConfigSchema.parse({ thinkingOffBody: {} })).toThrow();
  });

  it('modelId 必須在 models 裡，不在就失敗，訊息指名那個 id 與型錄有什麼', () => {
    expect(() => liveModelConfigSchema.parse({ modelId: 'nexus-test/not-in-catalog' })).toThrow(
      /nexus-test\/not-in-catalog.*nvidia\/nemotron-3-super-120b-a12b/su,
    );
    // 型錄整份取代：換掉 models 卻沒留預設那一筆，預設的 modelId 就指到型錄外。
    expect(() => liveModelConfigSchema.parse({ models: [{ ...OVERRIDE_ENTRY }] })).toThrow(
      /nvidia\/nemotron-3-super-120b-a12b/u,
    );
    expect(
      liveModelConfigSchema.parse({ modelId: OVERRIDE_ENTRY.id, models: [OVERRIDE_ENTRY] }).modelId,
    ).toBe(OVERRIDE_ENTRY.id);
  });

  it('型錄裡的 id 不能重複；條目多寫一格是打錯字；窗口與輸出上限必填', () => {
    expect(() =>
      liveModelConfigSchema.parse({ models: [DEFAULT_LIVE_MODEL_ENTRY, DEFAULT_LIVE_MODEL_ENTRY] }),
    ).toThrow(/不只一次/u);
    expect(() =>
      liveModelConfigSchema.parse({ models: [{ ...DEFAULT_LIVE_MODEL_ENTRY, name: 'x' }] }),
    ).toThrow();
    const { contextWindow: _window, ...noWindow } = DEFAULT_LIVE_MODEL_ENTRY;
    const { maxTokens: _max, ...noMax } = DEFAULT_LIVE_MODEL_ENTRY;
    expect(() => liveModelConfigSchema.parse({ models: [noWindow] })).toThrow();
    expect(() => liveModelConfigSchema.parse({ models: [noMax] })).toThrow();
  });

  it('eval 用的入口：型錄外的 id 合成一筆，輸出上限沿用出廠那一筆', () => {
    const config = liveModelConfigForModel('openai/gpt-oss-20b');
    expect(config.modelId).toBe('openai/gpt-oss-20b');
    expect(findModelEntry(config.models, 'openai/gpt-oss-20b')?.maxTokens).toBe(
      DEFAULT_LIVE_MAX_OUTPUT_TOKENS,
    );
    // 出廠型錄裡有的 id 不合成。
    expect(liveModelConfigForModel(DEFAULT_LIVE_MODEL_ID).models).toEqual([
      DEFAULT_LIVE_MODEL_ENTRY,
    ]);
    // 而且真的建得出模型（eval 就是這樣用的）。
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
    expect(createLiveModel(config).model).toBe('openai/gpt-oss-20b');
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

describe('型錄的查詢（#729）', () => {
  it('收不收圖：宣告 image 的收、只宣告 text 的不收、沒宣告 input 的回「沒宣告」', () => {
    const base = { id: 'x', contextWindow: 1, maxTokens: 1 };
    expect(acceptsImages({ ...base, input: ['text', 'image'] })).toBe('accepts');
    expect(acceptsImages({ ...base, input: ['text'] })).toBe('rejects');
    expect(acceptsImages(base)).toBe('undeclared');
    // 出廠那一筆只宣告文字，不當成收圖。
    expect(acceptsImages(DEFAULT_LIVE_MODEL_ENTRY)).toBe('rejects');
  });

  it('關推理的寫法：要有 off 那一級與 chat template 參數；不推理或沒宣告的模型什麼都不加', () => {
    const base = { id: 'x', contextWindow: 1, maxTokens: 1 };
    const compat = {
      chatTemplateKwargs: { enable_thinking: { $var: 'thinking.enabled' as const } },
    };
    expect(thinkingOffBody({ ...base, reasoningEfforts: { off: null }, compat })).toEqual({
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(thinkingOffBody({ ...base, reasoningEfforts: false, compat })).toEqual({});
    expect(thinkingOffBody({ ...base, reasoningEfforts: { high: 'high' }, compat })).toEqual({});
    expect(thinkingOffBody({ ...base, compat })).toEqual({});
    expect(thinkingOffBody({ ...base, reasoningEfforts: { off: null } })).toEqual({});
  });
});

describe('createLiveModel 的接線', () => {
  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('連線值與型錄條目的輸出上限都照傳進來的那一份建，不是照常數', () => {
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
    expect(createLiveModel(config, 'session-title').modelKwargs).toEqual({
      chat_template_kwargs: OVERRIDE_OFF_KWARGS,
    });
    // 這顆沒宣告 `off` 那一級（或沒有 chat template 參數）：標題那顆也不帶任何東西。
    const { compat: _compat, ...plain } = OVERRIDE_ENTRY;
    expect(createLiveModel({ ...config, models: [plain] }, 'session-title').modelKwargs).toEqual(
      {},
    );
  });

  it('標題那顆的輸出上限是明著傳進來的，不看型錄條目', () => {
    const config: LiveModelConfig = { ...OVERRIDE, baseUrl: 'http://127.0.0.1:9/v1' };
    expect(
      createLiveModel(config, 'session-title', undefined, { maxOutputTokens: 64 }).maxTokens,
    ).toBe(64);
    expect(createLiveModel(config, 'session-title').maxTokens).toBe(OVERRIDE_ENTRY.maxTokens);
  });

  it('型錄裡沒有 modelId 的手搭設定：建構當場拋，訊息指名 id', () => {
    const config: LiveModelConfig = {
      ...OVERRIDE,
      modelId: 'nexus-test/ghost',
      baseUrl: 'http://127.0.0.1:9/v1',
    };
    expect(() => createLiveModel(config)).toThrow('nexus-test/ghost');
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
      `    timeoutMs: ${String(OVERRIDE.timeoutMs)}`,
      `    maxRetries: ${String(OVERRIDE.maxRetries)}`,
      // YAML 是 JSON 的超集，`models` 整份取代出廠那一筆。
      `    models: ${JSON.stringify(OVERRIDE.models)}`,
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
      maxTokens: OVERRIDE_ENTRY.maxTokens,
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
      chatTemplateKwargs: OVERRIDE_OFF_KWARGS,
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

  /** 一份把 `live-model` 寫壞的 patch。 */
  async function writeBadPatch(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-live-model-'));
    const patch = join(dir, 'bad.patch.yml');
    await writeFile(patch, "- id: live-model\n  config:\n    baseUrl: 'ftp://nope'\n", 'utf8');
    return patch;
  }

  /**
   * 沒帶 `--live`：那份值沒人用（#751），`live-model` 是可少掛的，所以起得來、啟動時的警告指名它——不是等到第一條
   * thread 才講。
   */
  it('serve：那一列寫壞了、沒帶 --live：起得來，啟動時的警告指名它', async () => {
    const logged: string[] = [];
    running = (await runServe({
      argv: ['--port', '0', '--patch', await writeBadPatch()],
      log: (line: string) => void logged.push(line),
      env: {},
    })) as RunningServe;
    expect(
      logged.filter((line) => /^ {2}live-model（#settings\/live-model）設定驗不過：/u.test(line)),
    ).toHaveLength(1);
    expect(logged).toContain('模型：假模型（ScriptedChatModel）');
  });

  /**
   * 帶 `--live`：**兩個入口都起不來，不退回設定格式的預設值**（#751）。那份預設的網址是對外的公開端點，退回去就連同金鑰
   * 一起送出去；照 dsh 的連鎖，使用方（帶 `--live` 的組裝）硬要這一份，提供方掉了使用方起不來。
   *
   * CLI 那條不給題目、輸入一開始就結束：萬一檢查被拿掉，它也只會進對話迴圈就收，不會真的對外送請求。
   */
  it('帶 --live：serve 與 CLI 都起不來，訊息標出 live-model 是必掛的', async () => {
    const patch = await writeBadPatch();
    const required = /live-model（#settings\/live-model）〔必掛〕設定驗不過/u;
    await expect(
      runServe({
        argv: ['--port', '0', '--live', '--patch', patch],
        log: () => undefined,
        env: {},
      }),
    ).rejects.toThrow(required);
    const input = new PassThrough();
    input.end();
    await expect(
      runCli({
        argv: ['--live', '--patch', patch],
        input,
        output: new PassThrough(),
        printer: { log: () => undefined, error: () => undefined },
        env: {},
      }),
    ).rejects.toThrow(required);
  });

  /** 一份只改 `live-model` 型錄的 patch；`models` 是整份取代，所以連預設那一筆都要自己寫。 */
  async function writeCatalogPatch(
    baseUrl: string,
    modelId: string,
    models: unknown,
  ): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'nexus-live-model-'));
    const patch = join(dir, 'catalog.patch.yml');
    await writeFile(
      patch,
      [
        '- id: live-model',
        '  config:',
        `    baseUrl: '${baseUrl}'`,
        `    modelId: '${modelId}'`,
        `    models: ${JSON.stringify(models)}`,
        '',
      ].join('\n'),
      'utf8',
    );
    return patch;
  }

  async function runOnce(patch: string): Promise<void> {
    await runCli({
      argv: ['--live', '--patch', patch, '說一句話。'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
      env: {},
    });
  }

  it('patch 把預設那一筆的輸出上限改成 8192：主請求送 8192，標題請求仍是標題那一列的 64', async () => {
    const patch = await writeCatalogPatch(fake.baseUrl, DEFAULT_LIVE_MODEL_ID, [
      { ...DEFAULT_LIVE_MODEL_ENTRY, maxTokens: 8192 },
    ]);
    await runOnce(patch);

    const main = fake.seen.filter((request) => !request.title);
    expect(main.length).toBeGreaterThan(0);
    for (const request of main) {
      expect(request.model).toBe(DEFAULT_LIVE_MODEL_ID);
      expect(request.maxTokens).toBe(8192);
      expect(request.chatTemplateKwargs).toBeUndefined();
    }
    for (const request of fake.seen.filter((each) => each.title)) {
      expect(request.maxTokens).toBe(64);
      expect(request.chatTemplateKwargs).toEqual({ enable_thinking: false });
    }
  });

  it('patch 把預設指到型錄沒有的 id：啟動失敗，訊息含那一列的名字與那個 id，沒有請求送出去', async () => {
    const patch = await writeCatalogPatch(fake.baseUrl, 'nexus-test/not-in-catalog', [
      DEFAULT_LIVE_MODEL_ENTRY,
    ]);
    await expect(runOnce(patch)).rejects.toThrow(
      /live-model（#settings\/live-model）〔必掛〕設定驗不過.*nexus-test\/not-in-catalog/su,
    );
    expect(fake.seen).toEqual([]);
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
  function readBack(model: unknown): Record<string, unknown> {
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
    const { plugins } = await loadDefaultPlugins({
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
    const { plugins } = await loadDefaultPlugins({ env: {} });
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
