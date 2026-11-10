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
import { SessionLog } from '@nexus/core';
import { openModelCall, reportedAttemptUsage } from '@nexus/core/src/model-call-scope.js';
import { ChatOpenAI } from '@langchain/openai';
import type { ChatOpenAIFields } from '@langchain/openai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { BaseChatOpenAI } from './base-chat-openai.js';
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
 * 唯一刻意不同的一格：`ChatOpenAI` 在 callback 的 `metadata.versions` 記了 `@langchain/openai` 的版號，新殼不經那個套件、不記。
 * 讀它的只有選用的 LangSmith 追蹤（`tracing.ts`）。拿掉之前先確定它真的在，免得這一格靜靜變成別的差異。
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
      // 沒有 handler 時 core 走 `_generate`，送的是非串流請求；串流回應那幾條只在兩種串流模式跑，非串流另有一條。
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

  it('非串流的回應（沒有 handler：走 _generate）', async () => {
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
