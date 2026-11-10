/**
 * `BaseChatOpenAI` 對 `@langchain/openai@1.5.10` 的 `ChatOpenAI` 的差分測試（[#2361](https://github.com/DemianLi/nexus-agent/issues/2361)）。
 *
 * 兩顆用 `createLiveModel` 組出來的**同一份欄位**（同一疊 fetch、同一個 `onFailedAttempt`），輪流打同一個 loopback 假端點、
 * 收同一份腳本回應。比兩樣：端點收到的請求（本文逐位元組、標頭）相同；模型交出來的東西（callback 收到的每一則、回傳值或拋出的錯）
 * 相同。換錯（`translateFailure`）在子類上、不在這兩顆裡，所以錯誤比的是轉接器自己交出來的那一顆。
 *
 * @module
 */

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { LLM_STREAM_CONFIG_KEY, SessionLog, toLoggedMessage } from '@nexus/core';
import type { ModelStreamAround, ModelStreamChunk } from '@nexus/core';
import { openModelCall, reportedAttemptUsage } from '@nexus/core/src/model-call-scope.js';
import { ChatOpenAI } from '@langchain/openai';
import type { ChatOpenAIFields } from '@langchain/openai';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import { BaseChatOpenAI } from './base-chat-openai.js';
import { GatedChatOpenAI } from './gated-chat-openai.js';
import { ReplayChatModel } from './llm-replay.js';
import { ScriptedChatModel } from './scripted-model.js';
import { RequestGate } from './request-gate.js';
import type { BaseChatOpenAIFields } from './base-chat-openai.js';
import { classifyTurnFailure, createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { MEASURED_MODELS } from './eval/tiers.js';
import { liveModelConfigSchema } from './settings/live-model.js';

type Script = (response: ServerResponse) => void;

interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

let server: Server;
let baseUrl: string;
let received: Received[] = [];
let script: Script = (response) => response.end();
let savedKey: string | undefined;

beforeEach(async () => {
  received = [];
  savedKey = process.env[LIVE_API_KEY_ENV];
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on('data', (part: Buffer) => parts.push(part));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(parts).toString('utf8') });
      script(response);
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('拿不到 loopback 埠');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env[LIVE_API_KEY_ENV];
  else process.env[LIVE_API_KEY_ENV] = savedKey;
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
});

const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
  sse({
    id: 'c1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    system_fingerprint: 'fp',
    service_tier: 'default',
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
const usage = sse({
  id: 'c1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'fake',
  choices: [],
  usage: {
    prompt_tokens: 11,
    completion_tokens: 7,
    total_tokens: 18,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 3 },
  },
});
const DONE = 'data: [DONE]\n\n';

const streamOf =
  (...frames: string[]): Script =>
  (response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const frame of frames) response.write(frame);
    response.end();
  };

const jsonOf =
  (status: number, body: unknown): Script =>
  (response) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

const TEXT_STREAM = streamOf(
  chunk({ role: 'assistant', content: '', reasoning_content: '先想' }),
  chunk({ reasoning_content: '一下' }),
  chunk({ content: '報表要' }),
  chunk({ content: '按部門' }, 'stop'),
  usage,
  DONE,
);

const TOOL_STREAM = streamOf(
  chunk({
    role: 'assistant',
    content: null,
    tool_calls: [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '' } },
    ],
  }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
  chunk({ tool_calls: [{ index: 0, function: { arguments: '"/a.txt"}' } }] }),
  chunk({
    tool_calls: [
      { index: 1, id: 'call_2', type: 'function', function: { name: 'ls', arguments: '{}' } },
    ],
  }),
  chunk({}, 'tool_calls'),
  usage,
  DONE,
);

const readFile = tool(async () => '', {
  name: 'read_file',
  description: '讀檔',
  schema: z.object({ path: z.string().describe('路徑'), limit: z.number().optional() }),
});
const LS_TOOL = {
  type: 'function',
  function: { name: 'ls', description: '列目錄', parameters: { type: 'object', properties: {} } },
} as const;

const HISTORY: BaseMessage[] = [
  new SystemMessage('你是助理。'),
  new HumanMessage('幫我看 /a.txt'),
  new AIMessage({
    content: [
      { type: 'reasoning', reasoning: '要讀檔' },
      { type: 'text', text: '我先讀。' },
    ],
    tool_calls: [{ id: 'call_0', name: 'read_file', args: { path: '/a.txt' }, type: 'tool_call' }],
    additional_kwargs: { reasoning_content: '要讀檔' },
  }),
  new ToolMessage({ tool_call_id: 'call_0', content: '內容' }),
  new AIMessage({ content: '', tool_calls: [{ id: 'call_9', name: 'ls', args: {} }] }),
  new ToolMessage({ tool_call_id: 'call_9', content: [] }),
  new AIMessage({
    content: [{ type: 'text', text: 'v1 那一則' }],
    response_metadata: { output_version: 'v1' },
  }),
  new HumanMessage({
    content: [
      { type: 'text', text: '看這些附件' },
      { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'iVBORw0KGgo=' },
      { type: 'image', source_type: 'url', url: 'https://example.invalid/a.png' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'low' } },
      {
        type: 'file',
        source_type: 'base64',
        mime_type: 'application/pdf',
        data: 'JVBERi0=',
        metadata: { filename: '報告.pdf' },
      },
      {
        type: 'file',
        source_type: 'url',
        url: 'data:text/plain;base64,5aSn',
        metadata: { name: '說明.txt' },
      },
      { type: 'audio', source_type: 'base64', mime_type: 'audio/wav', data: 'UklGRg==' },
    ],
  }),
];

/** 收下 callback 交給 handler 的每一則；帶 `lc_prefer_chat_model_stream_events` 時 core 走 `_streamChatModelEvents`。 */
class Recorder extends BaseCallbackHandler {
  name = 'differential-recorder';
  readonly calls: unknown[] = [];
  lc_prefer_chat_model_stream_events: boolean;
  lc_prefer_streaming: boolean;

  constructor(mode: 'events' | 'tokens' | 'none') {
    super();
    this.lc_prefer_chat_model_stream_events = mode === 'events';
    this.lc_prefer_streaming = mode === 'tokens';
  }

  override handleChatModelStart(...args: unknown[]): void {
    this.calls.push(['start', ...args]);
  }

  handleChatModelStreamEvent(event: unknown): void {
    this.calls.push(['event', event]);
  }

  override handleLLMNewToken(...args: unknown[]): void {
    this.calls.push(['token', ...args]);
  }

  override handleLLMEnd(...args: unknown[]): void {
    this.calls.push(['end', ...args]);
  }

  override handleLLMError(error: unknown): void {
    this.calls.push(['error', errorShape(error)]);
  }
}

function errorShape(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const fields = error as Error & Record<string, unknown>;
  return {
    constructor: error.constructor.name,
    name: error.name,
    message: error.message,
    lc_error_code: fields['lc_error_code'],
    status: fields['status'],
    code: classifyTurnFailure(error).code,
    cause: errorShape(fields['cause']),
  };
}

/** JSON 來回一次：比的是 handler 與線上看得到的東西，類別實例照它們自己的 `toJSON`。 */
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));

interface Outcome {
  readonly requests: readonly {
    readonly headers: Record<string, unknown>;
    readonly body: string;
  }[];
  readonly calls: unknown;
  /** fetch 層回報給這次呼叫範圍的用量（`withStreamUsageReport`）。 */
  readonly usage: unknown;
  readonly result: unknown;
  readonly thrown: unknown;
}

type Call = (model: BaseChatModel, config: Record<string, unknown>) => Promise<unknown>;

async function outcomeOf(
  model: BaseChatModel,
  call: Call,
  mode: 'events' | 'tokens' | 'none',
  runId: string,
): Promise<Outcome> {
  received = [];
  const recorder = new Recorder(mode);
  let result: unknown;
  let thrown: unknown;
  let usage: unknown;
  // 包在一次模型呼叫的範圍裡，fetch 層的用量回報才有地方交（範圍外 `beginAttemptReport` 回 `undefined`、整條不走）。
  const log = new SessionLog('differential');
  await openModelCall(log, () => 1).run(async () => {
    try {
      result = await call(model, { callbacks: [recorder], runId });
    } catch (error: unknown) {
      thrown = errorShape(error);
    }
    usage = reportedAttemptUsage(log);
  });
  return {
    requests: received.map(({ headers, body }) => ({
      headers: { ...headers, host: undefined },
      body,
    })),
    calls: plain(recorder.calls),
    usage: plain(usage),
    result: plain(result),
    thrown,
  };
}

/**
 * 比對前一律剝掉的一格：`ChatOpenAI` 在 callback 的 `metadata.versions` 記了 `@langchain/openai` 的版號，`BaseChatOpenAI` 不經那個套件、不記。
 * repo 裡沒有程式讀它；選用的 LangSmith tracer（`tracing.ts` 開的）會把 metadata 整包送出。剝掉之前先確定它真的在，免得這一格靜靜變成別的差異。
 */
function withoutOpenAIVersion(outcome: Outcome): Outcome {
  const calls = outcome.calls as unknown[][];
  for (const call of calls) {
    if (call[0] !== 'start') continue;
    const versions = (call[7] as { versions?: Record<string, unknown> } | undefined)?.versions;
    expect(versions?.['@langchain/openai']).toBe('1.5.10');
    delete versions!['@langchain/openai'];
  }
  return outcome;
}

/** 用 `createLiveModel` 組出來的欄位建兩顆，跑同一個呼叫，回兩邊的結果。 */
async function both(
  call: Call,
  mode: 'events' | 'tokens' | 'none',
  tweak: (fields: BaseChatOpenAIFields) => BaseChatOpenAIFields = (fields) => fields,
  config: Record<string, unknown> = {},
): Promise<{ readonly next: Outcome; readonly old: Outcome }> {
  const fields = tweak(createLiveModel(liveModelConfigSchema.parse({ baseUrl, ...config })).fields);
  const runId = randomUUID();
  const next = await outcomeOf(new BaseChatOpenAI(fields), call, mode, runId);
  const old = await outcomeOf(
    new ChatOpenAI(fields as ChatOpenAIFields) as never,
    call,
    mode,
    runId,
  );
  return { next, old: withoutOpenAIVersion(old) };
}

const invoke =
  (messages: BaseMessage[], options: Record<string, unknown> = {}): Call =>
  (model, config) =>
    model.invoke(messages, { ...options, ...config });

const invokeWithTools =
  (messages: BaseMessage[], options: Record<string, unknown> = {}): Call =>
  (model, config) =>
    model.bindTools!([readFile, LS_TOOL], { tool_choice: 'auto', ...options }).invoke(
      messages,
      config,
    );

const MODES = ['events', 'tokens', 'none'] as const;

const HTTP_FAILURES = [
  [
    400,
    {
      error: {
        message: "This model's maximum context length is 1000 tokens.",
        type: 'BadRequestError',
      },
    },
  ],
  [
    400,
    {
      error: {
        message: 'max_tokens must be at least 1, got -5. (parameter=max_tokens, value=-5)',
        param: 'max_tokens',
      },
    },
  ],
  [
    400,
    {
      error: {
        message: 'messages with role tool must follow tool_calls',
        type: 'invalid_request_error',
      },
    },
  ],
  [401, { error: { message: 'bad key', type: 'authentication_error' } }],
  [404, { error: { message: 'no such model' } }],
  [410, { error: { message: 'model gone' } }],
  [429, { error: { message: 'slow down' } }],
  [500, { error: { message: 'boom' } }],
] as const;

/** 串流回應的那幾條：文字、工具呼叫、附件、串流內錯誤、閒置逾時、沒有結束原因。 */
function defineStreamCases(mode: 'events' | 'tokens'): void {
  it('文字串流（含推理與用量）', async () => {
    script = TEXT_STREAM;
    const { next, old } = await both(invoke([new HumanMessage('嗨')]), mode);
    expect(next.requests).toHaveLength(1);
    expect(next.thrown).toBeUndefined();
    expect(next.usage).toMatchObject({ inputTokens: 11, cacheReadTokens: 4 });
    expect(next).toEqual(old);
  });

  it('工具呼叫：bindTools、分段的參數、兩顆並行', async () => {
    script = TOOL_STREAM;
    const { next, old } = await both(invokeWithTools(HISTORY), mode);
    expect(next.requests).toHaveLength(1);
    expect(next.thrown).toBeUndefined();
    expect(next).toEqual(old);
  });

  it('歷史裡的工具結果、v1 訊息與各種附件區塊', async () => {
    script = TEXT_STREAM;
    const { next, old } = await both(invoke(HISTORY, { stop: ['。'] }), mode);
    expect(next.requests).toHaveLength(1);
    expect(next).toEqual(old);
  });

  it('串流內的錯誤信封（第一則就是）', async () => {
    script = streamOf(sse({ error: { message: '上游忙', code: 503 } }));
    const { next, old } = await both(invoke([new HumanMessage('嗨')]), mode);
    expect(next.thrown).toBeDefined();
    expect(next).toEqual(old);
  });

  it('串流內的錯誤信封（吐了內容之後）', async () => {
    script = streamOf(
      chunk({ role: 'assistant', content: '報表' }),
      sse({ error: { message: '上游忙', code: 503 } }),
    );
    const { next, old } = await both(invoke([new HumanMessage('嗨')]), mode);
    expect(next.thrown).toBeDefined();
    expect(next).toEqual(old);
  });

  it('第一則之後停住：閒置逾時', async () => {
    script = (response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(chunk({ role: 'assistant', content: '報表' }));
    };
    const { next, old } = await both(invoke([new HumanMessage('嗨')]), mode, undefined, {
      streamIdleTimeoutMs: 300,
    });
    expect(next.thrown).toBeDefined();
    expect(next).toEqual(old);
  });

  it('沒有 finish_reason 就 EOF', async () => {
    script = streamOf(chunk({ role: 'assistant', content: '報表' }));
    const { next, old } = await both(invoke([new HumanMessage('嗨')]), mode);
    expect(next.thrown).toBeDefined();
    expect(next).toEqual(old);
  });
}

describe('BaseChatOpenAI 跟 ChatOpenAI 送出與交出的東西逐一相同', () => {
  for (const mode of MODES) {
    describe(`callback 模式：${mode}`, () => {
      // 沒有偏好串流的 handler 時 core 走 `_generate`，送的是非串流請求；串流回應那幾條只在兩種串流模式跑，非串流另有一條。
      if (mode !== 'none') defineStreamCases(mode);

      for (const [status, body] of HTTP_FAILURES) {
        it(`HTTP ${status}：${body.error.message.slice(0, 24)}`, async () => {
          script = jsonOf(status, body);
          const { next, old } = await both(invoke([new HumanMessage('嗨')]), mode);
          expect(next.thrown).toBeDefined();
          expect(next).toEqual(old);
        });
      }
    });
  }

  it('非串流的回應（沒有偏好串流的 handler：走 _generate）', async () => {
    script = jsonOf(200, {
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'fake',
      system_fingerprint: 'fp',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '我來讀',
            reasoning_content: '想',
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"/a"}' },
              },
              { id: 'call_2', type: 'function', function: { name: 'ls', arguments: '{壞' } },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 18,
        prompt_tokens_details: { cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    });
    const { next, old } = await both(invokeWithTools(HISTORY), 'none');
    expect(next.requests).toHaveLength(1);
    expect(next.thrown).toBeUndefined();
    expect(next).toEqual(old);
  });

  it('modelKwargs（標題那一顆的關推理）與推理模型的參數', async () => {
    script = TEXT_STREAM;
    const { next, old } = await both(
      invoke([new SystemMessage('系統'), new HumanMessage('嗨')], { reasoning: { effort: 'low' } }),
      'events',
      (fields) => ({
        ...fields,
        model: 'o3-mini',
        modelKwargs: { chat_template_kwargs: { thinking: false } },
      }),
    );
    expect(next.requests).toHaveLength(1);
    expect(next).toEqual(old);
  });

  it('withConfig 帶的預設與 tool_choice 指名', async () => {
    script = TOOL_STREAM;
    const call: Call = (model, config) =>
      model.bindTools!([readFile], { tool_choice: 'read_file', strict: true } as never)
        .withConfig({ stop: ['停'] })
        .invoke([new HumanMessage('讀')], config);
    const { next, old } = await both(call, 'events');
    expect(next.requests).toHaveLength(1);
    expect(next).toEqual(old);
  });

  it('stream()：消費者拿到的片段相同', async () => {
    script = TOOL_STREAM;
    const call: Call = async (model, config) => {
      const parts: unknown[] = [];
      for await (const part of await model.bindTools!([readFile, LS_TOOL]).stream(
        [new HumanMessage('讀')],
        config,
      ))
        parts.push(part);
      return parts;
    };
    const { next, old } = await both(call, 'none');
    expect(next.requests).toHaveLength(1);
    expect(next).toEqual(old);
  });

  it('呼叫前就中止', async () => {
    script = TEXT_STREAM;
    const call: Call = (model, config) =>
      model.invoke([new HumanMessage('嗨')], { ...config, signal: AbortSignal.abort() });
    const { next, old } = await both(call, 'events');
    expect(next.thrown).toBeDefined();
    expect(next).toEqual(old);
  });

  it('設了 OPENAI_ORGANIZATION：兩邊都送 OpenAI-Organization，序列化也相同', async () => {
    const saved = process.env['OPENAI_ORGANIZATION'];
    process.env['OPENAI_ORGANIZATION'] = 'org-loopback';
    try {
      script = TEXT_STREAM;
      const { next, old } = await both(invoke([new HumanMessage('嗨')]), 'events');
      expect(next.requests[0]?.headers['openai-organization']).toBe('org-loopback');
      expect(next).toEqual(old);
    } finally {
      if (saved === undefined) delete process.env['OPENAI_ORGANIZATION'];
      else process.env['OPENAI_ORGANIZATION'] = saved;
    }
  });

  it('模型物件上被讀的那幾格：出貨型錄與量過的每一顆都相同', () => {
    const shipped = liveModelConfigSchema.parse({ baseUrl }).models.map((entry) => entry.id);
    for (const id of new Set([...shipped, ...MEASURED_MODELS.map((tier) => tier.modelId)])) {
      const fields = {
        ...createLiveModel(liveModelConfigSchema.parse({ baseUrl })).fields,
        model: id,
      };
      const surface = (model: BaseChatModel) => ({
        profile: model.profile,
        llmType: model._llmType(),
        name: model.getName(),
        id: model.toJSON().id,
        model: (model as unknown as { model: unknown }).model,
      });
      expect(surface(new BaseChatOpenAI(fields))).toEqual(
        surface(new ChatOpenAI(fields as ChatOpenAIFields) as never),
      );
    }
  });
});

/** `BaseChatOpenAI` 刻意跟 `ChatOpenAI` 不同的地方：每一格先確認 `ChatOpenAI` 那邊真的是那樣，免得它靜靜變成別的差異。 */
describe('已知的差異', () => {
  const RESPONSES_ONLY: readonly [string, Record<string, unknown>][] = [
    ['previous_response_id', { previous_response_id: 'resp_1' }],
    ['text', { text: { format: { type: 'text' } } }],
    ['truncation', { truncation: 'auto' }],
    ['include', { include: ['reasoning.encrypted_content'] }],
    ['reasoning.summary', { reasoning: { summary: 'auto' } }],
  ];
  for (const [name, options] of RESPONSES_ONLY) {
    it(`只有 Responses 收的呼叫選項（${name}）：舊的改打 Responses，新殼拋、不送`, async () => {
      script = jsonOf(400, { error: { message: 'loopback', type: 'invalid_request_error' } });
      const { next, old } = await both(invoke([new HumanMessage('嗨')], options), 'none');
      expect(Object.keys(JSON.parse(old.requests[0]!.body) as object)).toContain('input');
      expect(next.requests).toHaveLength(0);
      expect((next.thrown as { message: string }).message).toContain(name);
    });
  }

  it('json_schema 的 response_format：舊的改走 chat.completions.parse，新殼拋、不送', async () => {
    script = jsonOf(400, { error: { message: 'loopback', type: 'invalid_request_error' } });
    const responseFormat = {
      type: 'json_schema',
      json_schema: { name: 'answer', schema: { type: 'object', properties: {} } },
    };
    const { next, old } = await both(
      invoke([new HumanMessage('嗨')], { response_format: responseFormat }),
      'none',
    );
    expect(old.requests[0]!.headers['x-stainless-helper-method']).toBe('chat.completions.parse');
    expect(next.requests).toHaveLength(0);
    expect((next.thrown as { message: string }).message).toContain('json_schema');
  });

  it('型號名偏好 Responses（含 codex、gpt-5.x-pro）：舊的改打 Responses，新殼照打 Chat Completions', async () => {
    for (const model of ['gpt-5.5-pro', 'my-codex']) {
      script = TEXT_STREAM;
      const { next, old } = await both(invoke([new HumanMessage('嗨')]), 'events', (fields) => ({
        ...fields,
        model,
      }));
      expect(Object.keys(JSON.parse(old.requests[0]!.body) as object)).toContain('input');
      expect(Object.keys(JSON.parse(next.requests[0]!.body) as object)).toContain('messages');
    }
  });

  it('generate() 合併的 llmOutput：舊的有 tokenUsage，新殼沒有', async () => {
    const fields = createLiveModel(liveModelConfigSchema.parse({ baseUrl })).fields;
    const llmOutputOf = async (model: BaseChatModel) => {
      script = jsonOf(200, {
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: 'fake',
        choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '好' } },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      });
      return (await model.generate([[new HumanMessage('嗨')]])).llmOutput;
    };
    expect(await llmOutputOf(new ChatOpenAI(fields as ChatOpenAIFields) as never)).toEqual({
      tokenUsage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
    });
    expect(await llmOutputOf(new BaseChatOpenAI(fields))).toBeUndefined();
  });

  it('profile：OpenAI 自家型號舊的查得到 maxInputTokens，新殼是 {}', () => {
    const fields = {
      ...createLiveModel(liveModelConfigSchema.parse({ baseUrl })).fields,
      model: 'gpt-4o',
    };
    expect(
      (new ChatOpenAI(fields as ChatOpenAIFields) as unknown as BaseChatModel).profile
        .maxInputTokens,
    ).toBeTypeOf('number');
    expect(new BaseChatOpenAI(fields).profile).toEqual({});
  });
});

/** 帶 `llm/stream` 環繞函式的 config，同 `model-node.ts` 放的位置。 */
const aroundConfig = (around: ModelStreamAround, config: Record<string, unknown> = {}) => ({
  ...config,
  configurable: {
    ...(config['configurable'] as object | undefined),
    [LLM_STREAM_CONFIG_KEY]: around,
  },
});

/** 轉交的環繞函式：記下每一顆 chunk 與被叫了幾次。 */
function passThrough(): { around: ModelStreamAround; chunks: ModelStreamChunk[]; calls: number } {
  const seen = { chunks: [] as ModelStreamChunk[], calls: 0 };
  const around: ModelStreamAround = (next) => {
    seen.calls += 1;
    return (async function* () {
      for await (const part of next()) {
        seen.chunks.push(part);
        yield part;
      }
    })();
  };
  return Object.assign(seen, { around });
}

/** 深度走訪：找得到那顆函式或內部鍵就回真。 */
function holdsAround(value: unknown, around: unknown, seen = new Set<object>()): boolean {
  if (value === around) return true;
  if (typeof value === 'string') return value === LLM_STREAM_CONFIG_KEY;
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Reflect.ownKeys(value).some(
    (key) =>
      key === LLM_STREAM_CONFIG_KEY ||
      holdsAround((value as Record<PropertyKey, unknown>)[key], around, seen),
  );
}

const liveFields = (config: Record<string, unknown> = {}) =>
  createLiveModel(liveModelConfigSchema.parse({ baseUrl, ...config })).fields;

/** 跑一次、收 callback 原物件（不經 JSON），回 recorder 與結果。 */
async function runRaw(
  model: BaseChatModel,
  call: Call,
  mode: 'events' | 'tokens' | 'none',
): Promise<{ recorder: Recorder; result: unknown; thrown: unknown }> {
  const recorder = new Recorder(mode);
  let result: unknown;
  let thrown: unknown;
  const log = new SessionLog('around');
  await openModelCall(log, () => 1).run(async () => {
    try {
      result = await call(model, { callbacks: [recorder] });
    } catch (error: unknown) {
      thrown = error;
    }
  });
  return { recorder, result, thrown };
}

const framesOf = (...frames: string[]): unknown[] =>
  frames
    .filter((frame) => frame !== DONE)
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as unknown);

const TEXT_FRAMES = [
  chunk({ role: 'assistant', content: '', reasoning_content: '先想' }),
  chunk({ reasoning_content: '一下' }),
  chunk({ content: '報表要' }),
  chunk({ content: '按部門' }, 'stop'),
  usage,
];

describe('llm/stream 的環繞函式（native 經 configurable 交進來）', () => {
  for (const mode of MODES) {
    for (const [label, respond] of [
      ['成功', TEXT_STREAM],
      ['失敗', jsonOf(500, { error: { message: 'boom' } })],
    ] as const) {
      it(`callback 收到的參數裡找不到環繞函式與內部鍵（${mode}，${label}）`, async () => {
        script = respond;
        const { around } = passThrough();
        const { recorder, thrown } = await runRaw(
          new BaseChatOpenAI(liveFields()),
          (model, config) => model.invoke([new HumanMessage('嗨')], aroundConfig(around, config)),
          mode,
        );
        expect(thrown === undefined).toBe(label === '成功');
        const kinds = recorder.calls.map((call) => (call as unknown[])[0]);
        expect(kinds).toContain('start');
        expect(kinds).toContain(label === '成功' ? 'end' : 'error');
        if (label === '成功' && mode === 'tokens') expect(kinds).toContain('token');
        expect(holdsAround(recorder.calls, around)).toBe(false);
      });
    }
  }

  it('三條路各打一次，環繞函式各被叫一次', async () => {
    script = TEXT_STREAM;
    const paths: [string, 'events' | 'tokens' | 'none', Call][] = [
      ['invoke → _generate', 'none', invoke([new HumanMessage('嗨')])],
      ['invoke → _streamChatModelEvents', 'events', invoke([new HumanMessage('嗨')])],
      [
        'stream() → _streamResponseChunks',
        'none',
        async (model, config) => {
          for await (const _ of await model.stream([new HumanMessage('嗨')], config)) continue;
        },
      ],
    ];
    for (const [label, mode, call] of paths) {
      received = [];
      const seen = passThrough();
      const { thrown } = await runRaw(
        new BaseChatOpenAI(liveFields()),
        (model, config) => call(model, aroundConfig(seen.around, config)),
        mode,
      );
      expect(thrown, label).toBeUndefined();
      expect(seen.calls, label).toBe(1);
      expect(received, label).toHaveLength(1);
    }
  });

  it('環繞函式拿到的就是 SDK 的原始 chunk，跟端點送的逐顆相等', async () => {
    script = TEXT_STREAM;
    const seen = passThrough();
    await runRaw(
      new BaseChatOpenAI(liveFields()),
      invoke([new HumanMessage('嗨')], aroundConfig(seen.around)),
      'events',
    );
    expect(plain(seen.chunks)).toEqual(framesOf(...TEXT_FRAMES));
  });

  it('監聽者短路（不叫 next、自己 yield）：端點收到 0 個請求，回覆來自監聽者', async () => {
    script = TEXT_STREAM;
    const around: ModelStreamAround = () =>
      (async function* () {
        yield { choices: [{ index: 0, delta: { role: 'assistant', content: '快取的' } }] };
        yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      })();
    for (const mode of MODES) {
      received = [];
      // 數 fetch 的呼叫，再等一個 macrotask 才看端點：沒等到的請求（例如沒人等它的那一次）也算得到。
      const fields = liveFields();
      const inner = fields.configuration?.fetch ?? fetch;
      let fetched = 0;
      const counted: typeof fetch = (...args) => {
        fetched += 1;
        return inner(...args);
      };
      const { result, thrown } = await runRaw(
        new BaseChatOpenAI({
          ...fields,
          configuration: { ...fields.configuration, fetch: counted },
        }),
        invoke([new HumanMessage('嗨')], aroundConfig(around)),
        mode,
      );
      await new Promise((settled) => setTimeout(settled, 50));
      expect(thrown, mode).toBeUndefined();
      expect(fetched, mode).toBe(0);
      expect(received, mode).toHaveLength(0);
      expect((result as AIMessage).text, mode).toBe('快取的');
    }
  });

  it('逐顆轉交的監聽者：callback 收到的與結果跟沒有監聽者時相同', async () => {
    // `none` 沒有監聽者時打非串流，跟帶監聽者的比法見「native 一律打串流請求」那幾條。
    for (const mode of ['events', 'tokens'] as const) {
      for (const respond of [TEXT_STREAM, TOOL_STREAM]) {
        script = respond;
        const runId = randomUUID();
        const fields = liveFields();
        const without = await outcomeOf(
          new BaseChatOpenAI(fields),
          invokeWithTools(HISTORY),
          mode,
          runId,
        );
        const { around } = passThrough();
        const withAround = await outcomeOf(
          new BaseChatOpenAI(fields),
          (model, config) => invokeWithTools(HISTORY)(model, aroundConfig(around, config)),
          mode,
          runId,
        );
        expect(withAround, mode).toEqual(without);
      }
    }
  });

  it('內部鍵不出現在 toJSON() 與 invocationParams()', () => {
    const { around } = passThrough();
    const model = new BaseChatOpenAI(liveFields());
    const options = { [LLM_STREAM_CONFIG_KEY]: around } as never;
    expect(holdsAround(model.toJSON(), around)).toBe(false);
    expect(holdsAround(model.invocationParams(options), around)).toBe(false);
    expect(holdsAround(model._getCallOptionsForTracing(options, {} as never), around)).toBe(false);
  });

  it('監聽者是 async 函式（回 Promise）也收', async () => {
    script = TEXT_STREAM;
    const around = (async (next: () => AsyncIterable<ModelStreamChunk>) => {
      await Promise.resolve();
      return next();
    }) as unknown as ModelStreamAround;
    const { result, thrown } = await runRaw(
      new BaseChatOpenAI(liveFields()),
      invoke([new HumanMessage('嗨')], aroundConfig(around)),
      'none',
    );
    expect(thrown).toBeUndefined();
    expect((result as AIMessage).text).toBe('報表要按部門');
  });

  it('監聽者回的不是串流：拋 TypeError、講明要回什麼', async () => {
    script = TEXT_STREAM;
    const around = (() => ({ content: '整則' })) as unknown as ModelStreamAround;
    const { thrown } = await runRaw(
      new BaseChatOpenAI(liveFields()),
      invoke([new HumanMessage('嗨')], aroundConfig(around)),
      'none',
    );
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain('AsyncIterable');
  });

  it('呼叫前就中止：拋中止、不送請求、不叫環繞函式', async () => {
    script = TEXT_STREAM;
    const seen = passThrough();
    const { thrown } = await runRaw(
      new BaseChatOpenAI(liveFields()),
      (model, config) =>
        model.invoke([new HumanMessage('嗨')], {
          ...aroundConfig(seen.around, config),
          signal: AbortSignal.abort(),
        }),
      'none',
    );
    expect(thrown).toBeDefined();
    expect(received).toHaveLength(0);
    expect(seen.calls).toBe(0);
  });

  it('帶閘的子類：_generate 改走串流也只取一次名額（上限 1 不會自己等自己）', async () => {
    script = TEXT_STREAM;
    const seen = passThrough();
    const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 200 });
    const { result, thrown } = await runRaw(
      new GatedChatOpenAI(liveFields(), gate),
      invoke([new HumanMessage('嗨')], aroundConfig(seen.around)),
      'none',
    );
    expect(thrown).toBeUndefined();
    expect((result as AIMessage).text).toBe('報表要按部門');
    expect(seen.calls).toBe(1);
  });

  describe('native 一律打串流請求', () => {
    for (const [label, call] of [
      ['純文字', invoke([new HumanMessage('嗨')])],
      ['工具', invokeWithTools(HISTORY)],
    ] as const) {
      it(`請求本文只多 stream 與 stream_options（${label}）`, async () => {
        script = jsonOf(500, { error: { message: 'boom' } });
        const plainRun = await runRaw(new BaseChatOpenAI(liveFields()), call, 'none');
        expect(plainRun.thrown).toBeDefined();
        const before = JSON.parse(received[0]!.body) as Record<string, unknown>;
        received = [];
        const { around } = passThrough();
        await runRaw(
          new BaseChatOpenAI(liveFields()),
          (model, config) => call(model, aroundConfig(around, config)),
          'none',
        );
        const after = JSON.parse(received[0]!.body) as Record<string, unknown>;
        expect(before['stream']).toBe(false);
        expect(after).toEqual({ ...before, stream: true, stream_options: { include_usage: true } });
        const { stream: _s, stream_options: _o, ...restAfter } = after;
        const { stream: _b, ...restBefore } = before;
        expect(JSON.stringify(restAfter)).toBe(JSON.stringify(restBefore));
      });
    }

    it('聚合出來的訊息跟 serve（stream-event handler 走事件）逐格相同', async () => {
      for (const respond of [TEXT_STREAM, TOOL_STREAM]) {
        script = respond;
        const runId = randomUUID();
        const serve = await outcomeOf(
          new BaseChatOpenAI(liveFields()),
          invokeWithTools(HISTORY),
          'events',
          runId,
        );
        const { around } = passThrough();
        const cli = await outcomeOf(
          new BaseChatOpenAI(liveFields()),
          (model, config) => invokeWithTools(HISTORY)(model, aroundConfig(around, config)),
          'none',
          runId,
        );
        expect(cli.result).toEqual(serve.result);
        expect(cli.usage).toEqual(serve.usage);
      }
    });

    it('usage_metadata 三條路相同，取自最後一顆 chunk', async () => {
      const usages: unknown[] = [];
      for (const mode of ['none', 'events'] as const) {
        script = TEXT_STREAM;
        const { around } = passThrough();
        const { result } = await runRaw(
          new BaseChatOpenAI(liveFields()),
          invoke([new HumanMessage('嗨')], aroundConfig(around)),
          mode,
        );
        usages.push(plain((result as AIMessage).usage_metadata));
      }
      script = TEXT_STREAM;
      const { around } = passThrough();
      const { result } = await runRaw(
        new BaseChatOpenAI(liveFields()),
        async (model, config) => {
          let total: AIMessage | undefined;
          for await (const part of await model.stream(
            [new HumanMessage('嗨')],
            aroundConfig(around, config),
          ))
            total =
              total === undefined
                ? (part as never)
                : (total as never as { concat(p: unknown): AIMessage }).concat(part);
          return total;
        },
        'none',
      );
      usages.push(plain((result as AIMessage).usage_metadata));
      expect(usages[0]).toMatchObject({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
      expect(usages[1]).toEqual(usages[0]);
      expect(usages[2]).toEqual(usages[0]);
    });
  });
});

describe('ModelStreamChunk 跟 SDK 的 ChatCompletionChunk', () => {
  it('SDK 的 chunk 指派得給 core 的型別（core 不加 openai 相依）', () => {
    expectTypeOf<ChatCompletionChunk>().toExtend<ModelStreamChunk>();
  });

  it('reasoning_content 不在 SDK 型別裡：core 寫成選填，SDK 的 chunk 才指派得過去', () => {
    type Delta = NonNullable<ModelStreamChunk['choices'][number]['delta']>;
    expectTypeOf<Delta>().toHaveProperty('reasoning_content');
    expectTypeOf<undefined>().toExtend<Delta['reasoning_content']>();
  });

  it('反例：把一格改成 SDK 沒有的型別，指派就失敗', () => {
    type Choice = ModelStreamChunk['choices'][number];
    type Broken = Omit<ModelStreamChunk, 'choices'> & {
      readonly choices: readonly (Omit<Choice, 'finish_reason'> & {
        readonly finish_reason?: number;
      })[];
    };
    expectTypeOf<ChatCompletionChunk>().not.toExtend<Broken>();
    const sdk = {} as ChatCompletionChunk;
    // @ts-expect-error finish_reason 是字串，不是 number
    const broken: Broken = sdk;
    void broken;
  });
});

describe('不打端點的模型（腳本、重放）接上 llm/stream', () => {
  const SCRIPTED = '腳本這一輪';
  const models: [string, () => BaseChatModel][] = [
    ['ScriptedChatModel', () => new ScriptedChatModel({ turns: [{ content: SCRIPTED }] })],
    [
      'ReplayChatModel',
      () =>
        new ReplayChatModel({
          script: [toLoggedMessage(new AIMessage({ content: SCRIPTED, id: 'r1' }))],
        }),
    ],
  ];
  for (const [name, build] of models) {
    for (const mode of MODES) {
      it(`${name}（${mode}）：環繞函式拿到這一輪的 chunk，監聽者短路也照樣吐腳本那一輪`, async () => {
        const seen: ModelStreamChunk[] = [];
        let calls = 0;
        const around: ModelStreamAround = (next) => {
          calls += 1;
          return (async function* () {
            for await (const part of next()) seen.push(part);
            yield {
              choices: [{ index: 0, delta: { content: '監聽者的' }, finish_reason: 'stop' }],
            };
          })();
        };
        const { result, thrown, recorder } = await runRaw(
          build(),
          invoke([new HumanMessage('嗨')], aroundConfig(around)),
          mode,
        );
        expect(thrown).toBeUndefined();
        expect(calls).toBe(1);
        expect(seen.map((part) => part.choices[0]?.delta?.content)).toEqual([SCRIPTED]);
        expect((result as AIMessage).text).toBe(SCRIPTED);
        expect(holdsAround(recorder.calls, around)).toBe(false);
      });
    }
  }
});
