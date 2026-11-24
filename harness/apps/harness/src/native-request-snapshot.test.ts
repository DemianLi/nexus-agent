/**
 * **native 在推導之前先寫請求快照，callback 只比對**（[#2361](https://github.com/DemianLi/nexus-agent/issues/2361)）。
 *
 * 做法是對照：同一組裝、同一段對話，`langgraph`（快照在模型被叫的那一刻抄）與 `native`（推導前預先算、callback 只比對）跑兩遍，
 * 日誌上的 `request/system`、`request/header`、事件型別順序與端點收到的 body（JSON 解析後）必須深度相等。`native` 的 callback 比對不一致會拋、
 * 這次請求不送，所以這一組全綠同時證明預先算的與 callback 那一刻的相同。每個場景各一筆，另與固定預期值（`native-request-snapshot.baseline.json`）比，兩條 loop 一起漂移也量得出來。
 *
 * 反向：預先算之後 callback 看到的參數變了（模型被問供應商層參數，第二次起多一格 `top_p`、或多一顆工具），這次請求不送，端點收到 0 個請求，
 * 錯誤只帶欄位名與摘要，不印系統提示全文。
 *
 * **零憑證、零外部連線**。
 */

import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ChatOpenAI } from '@langchain/openai';
import { SessionRegistry } from '@nexus/core';
import type { PluginEntry, SessionEvent } from '@nexus/core';
import { createMemoryPlugin } from '@nexus/plugin-memory';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { runRepl } from './cli.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { createEchoPlugin } from './echo.fixture.js';
import { testPlanModePlugin } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';

/** 一次請求的 body 裡我們關心的那幾格。 */
interface Body {
  readonly model?: string;
  readonly temperature?: number;
  readonly messages: readonly { role: string; content: unknown }[];
  readonly tools?: readonly {
    function: { name: string; description?: string; parameters?: unknown };
  }[];
}

/** 假端點這一次要回的助手訊息。 */
type Reply = { readonly content: string } | { readonly toolCalls: readonly ToolCallReply[] };
interface ToolCallReply {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** 本機的 OpenAI 相容端點：預設每次都回「好。」；`respond` 可按第幾個請求回別的。請求 body 原樣留下，`stream: true` 的回 SSE。 */
async function fakeEndpoint(respond?: (n: number) => Reply, failFirst = 0) {
  const bodies: Body[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body & {
        stream?: boolean;
      };
      bodies.push(body);
      if (bodies.length <= failFirst) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Internal server error', code: 500 } }));
        return;
      }
      const reply: Reply = respond?.(bodies.length) ?? { content: '好。' };
      const calls = 'toolCalls' in reply ? reply.toolCalls : [];
      const message = {
        role: 'assistant',
        content: 'content' in reply ? reply.content : null,
        ...(calls.length > 0 && {
          tool_calls: calls.map((call, index) => ({
            id: `call_${bodies.length}_${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }),
      };
      const finish = calls.length > 0 ? 'tool_calls' : 'stop';
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const base = { id: `chatcmpl-${bodies.length}`, created: 0, model: 'fake' };
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
        send({
          ...base,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: message.content,
                ...(message.tool_calls !== undefined && {
                  tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })),
                }),
              },
              finish_reason: null,
            },
          ],
        });
        send({
          ...base,
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: finish }],
        });
        send({ ...base, object: 'chat.completion.chunk', choices: [], usage });
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [{ index: 0, message, finish_reason: finish }],
          usage,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const WORKER: PluginEntry = {
  plugin: {
    name: 'worker-source',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

const MEMORY_TEXT = '使用者的代號是胡桃。';

type Loop = 'langgraph' | 'native';

interface Scenario {
  readonly name: string;
  readonly lines: string;
  readonly plugins: () => PluginEntry[];
  readonly systemPrompt?: string;
  readonly temperature?: number;
  readonly modelKwargs?: Record<string, unknown>;
  /** 端點按第幾個請求回什麼；省略就每次回「好。」。 */
  readonly respond?: (n: number) => Reply;
  /** 模型走串流。 */
  readonly streaming?: boolean;
  /** 端點前幾個請求回 500，搭配真的 `createLiveModel` 與重試政策看重打。 */
  readonly failFirst?: number;
  /** 端點應該收到的請求數。 */
  readonly bodyCount?: number;
}

/** 重打用的政策：退避縮成毫秒。 */
function retryConfig(baseUrl: string) {
  return liveModelConfigSchema.parse({
    baseUrl,
    retryPolicy: {
      mode: 'normal',
      maxRetries: 2,
      backoff: { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
    },
  });
}

/** 真的 `createLiveModel`（重試分類住在它的 `retryPolicy`），打本機假端點。 */
function liveModelOf(baseUrl: string): BaseChatModel {
  process.env[LIVE_API_KEY_ENV] = 'fake-key-for-loopback';
  return createLiveModel(retryConfig(baseUrl)) as unknown as BaseChatModel;
}

/** 本機假端點加產品組裝，餵幾行進 REPL。 */
async function runOn(
  loop: Loop,
  scenario: Scenario,
  model?: (baseURL: string) => BaseChatModel,
): Promise<{ events: SessionEvent[]; bodies: Body[]; error?: unknown }> {
  const upstream = await fakeEndpoint(scenario.respond, scenario.failFirst ?? 0);
  const root = await mkdtemp(join(tmpdir(), 'nexus-native-snap-'));
  await writeFile(join(root, 'AGENTS.md'), MEMORY_TEXT);
  const { agent, commands, attachSession, dispose } = await createNexusAgent({
    model:
      model?.(upstream.baseURL) ??
      (scenario.failFirst !== undefined ? liveModelOf(upstream.baseURL) : undefined) ??
      new ChatOpenAI({
        model: 'fake',
        apiKey: 'sk-loopback',
        maxRetries: 0,
        temperature: scenario.temperature ?? 0.3,
        ...(scenario.streaming === true && { streaming: true }),
        ...(scenario.modelKwargs !== undefined && { modelKwargs: scenario.modelKwargs }),
        configuration: { baseURL: upstream.baseURL },
      }),
    backend: new ContainedFilesystemBackend({ rootDir: root }),
    systemPrompt: scenario.systemPrompt ?? '你是測試助手。',
    plugins: scenario.plugins(),
    checkpointer: new MemorySaver(),
    agentLoop: loop,
    historySource: 'log',
    ...(scenario.failFirst !== undefined && {
      streamRetry: streamRetryOptionsOf(retryConfig(upstream.baseURL).retryPolicy),
    }),
  });
  const sessions = new SessionRegistry('native-snapshot');
  const detach = attachSession(sessions);
  const input = new PassThrough();
  input.end(scenario.lines);
  let error: unknown;
  const errors: string[] = [];
  try {
    await runRepl(
      agent,
      { input, output: new PassThrough() },
      { log: () => {}, error: (message: string) => void errors.push(String(message)) },
      sessions.root,
      commands,
    );
  } catch (caught) {
    error = caught;
  } finally {
    detach();
    await dispose();
    await upstream.close();
  }
  return {
    events: [...sessions.root.events],
    bodies: upstream.bodies,
    ...(error !== undefined || errors.length > 0 ? { error: error ?? errors.join('\n') } : {}),
  };
}

/** 兩邊要深度相等的那幾樣：事件型別順序、兩顆快照的內容、端點收到的 body。 */
function comparable(result: { events: readonly SessionEvent[]; bodies: readonly Body[] }) {
  return {
    types: result.events.map((event) => event.type),
    snapshots: result.events
      .filter((event) => event.type === 'request/system' || event.type === 'request/header')
      .map((event) => ({ type: event.type, data: event.data })),
    bodies: result.bodies,
  };
}

/**
 * 固定的預期值：`langgraph` 在 `b9e67bd6` 跑這幾個場景的事件型別順序、兩顆快照與端點收到的 body，鍵是場景名。
 * 有它，兩條 loop 一起漂移也量得出來。重產：把本檔放到要當基準的 commit 上，`DUMP_NATIVE_SNAPSHOT_BASELINE=<目錄>` 跑本檔，
 * 每個場景寫一份 JSON；檔名裡的 `／` 換回 `/` 當鍵，併成本檔旁的 `native-request-snapshot.baseline.json`。
 * 場景或對話改了、或這些送出的內容有意改變時，由改它的人重產。
 */
function baselines(): Record<string, unknown> {
  if (process.env['DUMP_NATIVE_SNAPSHOT_BASELINE'] !== undefined) return {};
  return JSON.parse(
    readFileSync(new URL('./native-request-snapshot.baseline.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

const SCENARIOS: readonly Scenario[] = [
  { name: '沒有工具、沒有記憶', lines: '一\n/exit\n', plugins: () => [] },
  { name: '有工具', lines: '一\n/exit\n', plugins: () => [createEchoPlugin()] },
  {
    name: '有工具與記憶',
    lines: '一\n二\n/exit\n',
    plugins: () => [createEchoPlugin(), createMemoryPlugin()],
  },
  {
    name: '有記憶，/plan 之後系統提示詞變了',
    lines: '一\n/plan\n二\n/exit\n',
    plugins: () => [createEchoPlugin(), createMemoryPlugin(), testPlanModePlugin()],
  },
  {
    name: '有子代理與記憶',
    lines: '一\n/exit\n',
    plugins: () => [createEchoPlugin(), createMemoryPlugin(), WORKER],
  },
  { name: '系統提示詞是空的', lines: '一\n/exit\n', plugins: () => [], systemPrompt: '' },
  {
    name: '派子代理：根與子代理的 body 都對得上',
    lines: '一\n/exit\n',
    plugins: () => [createEchoPlugin(), createMemoryPlugin(), WORKER],
    bodyCount: 3,
    respond: (n) =>
      n === 1
        ? {
            toolCalls: [
              { name: 'task', args: { description: '做一件事', subagent_type: 'worker' } },
            ],
          }
        : { content: '好。' },
  },
  {
    name: '串流',
    lines: '一\n二\n/exit\n',
    plugins: () => [createEchoPlugin(), createMemoryPlugin()],
    streaming: true,
    bodyCount: 2,
  },
  {
    name: '多一輪、-0 的溫度與額外的 body 參數',
    lines: '一\n二\n三\n/exit\n',
    plugins: () => [createEchoPlugin(), createMemoryPlugin()],
    temperature: -0,
    modelKwargs: { thinking: { type: 'disabled' } },
  },
];

describe('native 預先寫快照 = langgraph 在 callback 抄的', () => {
  it.each(SCENARIOS)('$name', async (scenario) => {
    const reference = await runOn('langgraph', scenario);
    const native = await runOn('native', scenario);
    expect(reference.error).toBeUndefined();
    expect(native.error).toBeUndefined();
    expect(native.bodies.length).toBeGreaterThan(0);
    if (scenario.bodyCount !== undefined) {
      expect(native.bodies).toHaveLength(scenario.bodyCount);
      expect(reference.bodies).toHaveLength(scenario.bodyCount);
    }
    if (scenario.streaming === true) {
      for (const body of [...native.bodies, ...reference.bodies]) {
        expect((body as { stream?: boolean }).stream).toBe(true);
      }
    }
    expect(comparable(native)).toEqual(comparable(reference));
    const baseline = baselines()[scenario.name];
    if (process.env['DUMP_NATIVE_SNAPSHOT_BASELINE'] !== undefined) {
      writeFileSync(
        join(
          process.env['DUMP_NATIVE_SNAPSHOT_BASELINE'],
          `${scenario.name.replaceAll('/', '／')}.json`,
        ),
        JSON.stringify(comparable(reference)),
      );
    } else {
      expect(JSON.parse(JSON.stringify(comparable(reference)))).toEqual(baseline);
      expect(JSON.parse(JSON.stringify(comparable(native)))).toEqual(baseline);
    }
  });
});

/**
 * 讓「問供應商層參數」第二次起的回傳經 `drift` 改寫：預先算是第一次問，callback 那一刻是第二次問，等於快照寫好之後有東西改了請求。
 * `ChatOpenAI.withConfig` 會 `new ChatOpenAI(this.fields)` 重建，傳進去的子類會被丟掉，所以改在定義該方法的原型上換。
 *
 * @returns 還原。
 */
function driftAfterFirstAsk(
  drift: (params: Record<string, unknown>) => Record<string, unknown>,
): () => void {
  let owner: object | null = ChatOpenAI.prototype;
  while (owner !== null && !Object.hasOwn(owner, '_getInvocationParamsForTracing')) {
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  if (owner === null) throw new Error('找不到定義 _getInvocationParamsForTracing 的原型');
  const holder = owner as Record<string, (options: unknown) => Record<string, unknown>>;
  const original = holder['_getInvocationParamsForTracing']!;
  let asked = 0;
  holder['_getInvocationParamsForTracing'] = function (this: unknown, options: unknown) {
    const params = original.call(this, options);
    asked += 1;
    return asked >= 2 ? drift(params) : params;
  };
  return () => {
    holder['_getInvocationParamsForTracing'] = original;
  };
}

describe('重打', () => {
  it('第一個請求 500、重打一次成功：每次重進推導不多寫快照，筆數與順序同 langgraph', async () => {
    const scenario: Scenario = {
      name: 'retry',
      lines: '一\n/exit\n',
      plugins: () => [createEchoPlugin(), createMemoryPlugin()],
      failFirst: 1,
    };
    const saved = process.env[LIVE_API_KEY_ENV];
    try {
      const reference = await runOn('langgraph', scenario);
      const native = await runOn('native', scenario);
      expect(reference.error).toBeUndefined();
      expect(native.error).toBeUndefined();
      expect(native.bodies).toHaveLength(2);
      expect(reference.bodies).toHaveLength(2);
      const types = comparable(native).types;
      expect(types.filter((type) => type === 'llm/retry')).toHaveLength(1);
      expect(types.filter((type) => type === 'request/system')).toHaveLength(1);
      expect(types.filter((type) => type === 'request/header')).toHaveLength(1);
      // 這個場景 native 打串流請求、`langgraph` 照模型設定（#2684）：`stream`、`stream_options` 不在快照裡，其餘逐項相同。
      const withoutStream = (result: typeof native) => ({
        ...comparable(result),
        bodies: result.bodies.map((body) => {
          const {
            stream: _stream,
            stream_options: _options,
            ...rest
          } = body as Body & {
            stream?: unknown;
            stream_options?: unknown;
          };
          return rest;
        }),
      });
      expect(withoutStream(native)).toEqual(withoutStream(reference));
    } finally {
      if (saved === undefined) delete process.env[LIVE_API_KEY_ENV];
      else process.env[LIVE_API_KEY_ENV] = saved;
    }
  });
});

describe('不報呼叫參數與工具的模型', () => {
  it('腳本模型：兩邊的快照都是空設定，仍深度相等', async () => {
    const scenario: Scenario = {
      name: 'scripted',
      lines: '一\n二\n/exit\n',
      plugins: () => [createEchoPlugin(), createMemoryPlugin()],
    };
    const scripted = () =>
      new ScriptedChatModel({ turns: [{ content: '好。' }, { content: '好。' }] });
    const reference = await runOn('langgraph', scenario, scripted);
    const native = await runOn('native', scenario, scripted);
    expect(reference.error).toBeUndefined();
    expect(native.error).toBeUndefined();
    const header = comparable(native).snapshots.find((entry) => entry.type === 'request/header');
    expect(header).toBeDefined();
    expect(comparable(native)).toEqual(comparable(reference));
  });
});

describe('預先算的與 callback 那一刻的對不上', () => {
  it('這次請求不送，端點收到 0 個請求，錯誤只帶欄位名與摘要', async () => {
    const restore = driftAfterFirstAsk((params) => ({ ...params, top_p: 0.5 }));
    const result = await runOn('native', {
      name: 'drift',
      lines: '一\n/exit\n',
      plugins: () => [createMemoryPlugin()],
    }).finally(restore);
    expect(result.bodies).toHaveLength(0);
    const message = String(
      result.error instanceof Error ? result.error.message : (result.error ?? ''),
    );
    expect(message).toContain('請求快照與實際要送的對不上');
    expect(message).toContain('header.config');
    expect(message).toContain('topP');
    expect(message).not.toContain(MEMORY_TEXT);
    expect(message).not.toContain('你是測試助手');
  });

  it('工具清單漂移（多一顆工具）：同樣不送，講 header.tools，不印參數', async () => {
    const restore = driftAfterFirstAsk((params) => ({
      ...params,
      tools: [
        ...((params['tools'] as unknown[] | undefined) ?? []),
        {
          type: 'function',
          function: { name: 'sneaky', parameters: { type: 'object', secret: 'x' } },
        },
      ],
    }));
    const result = await runOn('native', {
      name: 'drift-tools',
      lines: '一\n/exit\n',
      plugins: () => [createEchoPlugin()],
    }).finally(restore);
    expect(result.bodies).toHaveLength(0);
    const message = String(
      result.error instanceof Error ? result.error.message : (result.error ?? ''),
    );
    expect(message).toContain('header.tools');
    expect(message).not.toContain('secret');
  });
});
