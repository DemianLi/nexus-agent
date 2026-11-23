/**
 * 一輪失敗的錯誤碼（[#1844](https://github.com/DemianLi/nexus-agent/issues/1844)）與 `AUTH` 的原文只留伺服器日誌：
 * 真的 401 端點，訊息裡放一段假金鑰，走真的 `createLiveModel`＋`createNexusAgent`＋wire handler，
 * 即時下行與冷讀歷史拿到同一個碼。**零憑證、零外部連線**。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MemorySaver } from '@langchain/langgraph';
import { OpenAIClient } from '@langchain/openai';
import type { PluginEntry } from '@nexus/core';
import {
  AUTH_FAILURE_MESSAGE,
  createWireClient,
  emptyConversation,
  reduceAll,
  reduceConversation,
} from '@nexus/wire';
import type { ConversationState, Event } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { runCli } from './cli.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { ambientCredentials } from './credentials.js';
import type { CredentialService } from './credentials.js';
import {
  createLiveModel,
  CredentialRejectedError,
  LIVE_API_KEY_ENV,
  turnFailureOf,
} from './live-model.js';
import { createRequestGate } from './request-gate.js';
import { ScriptedChatModel } from './scripted-model.js';
import { composeAttachSessions } from './session-attach.js';
import { sessionEventsOf } from './session-files.fixture.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const LEAK = 'sk-FAKE-LEAK-1234567890';

let server: Server;
let baseUrl: string;
let status = 401;
let midStream = false;
let hits = 0;
let dir: string;

beforeEach(async () => {
  status = 401;
  midStream = false;
  hits = 0;
  vi.stubEnv(LIVE_API_KEY_ENV, 'fake-key-for-loopback');
  dir = await mkdtemp(join(tmpdir(), 'nexus-turn-failure-'));
  server = createServer((request, response) => {
    hits += 1;
    request.resume();
    if (midStream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = { id: 'x', choices: [{ index: 0, delta: { content: '先講' } }] };
      const failure = { error: { code: 401, message: `Incorrect API key: ${LEAK}`, type: 'x' } };
      response.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(failure)}\n\n`);
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `Incorrect API key: ${LEAK}`, type: 'x' } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${String(address.port)}/v1`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dir, { recursive: true, force: true });
});

const live = (credentials: CredentialService = ambientCredentials()) =>
  createLiveModel(
    liveModelConfigSchema.parse({ baseUrl, retryPolicy: { mode: 'normal', maxRetries: 0 } }),
    undefined,
    credentials,
  );

const FOREGROUND_TASK = { description: '幹活', subagent_type: 'worker' };

const workerPlugin = (model: unknown): PluginEntry => ({
  plugin: {
    name: 'worker-host',
    apply(registry) {
      registry.subagents.register({
        name: 'worker',
        description: '幹活的。',
        systemPrompt: '你是 worker。',
        model: model as never,
      });
    },
  },
});

async function until(predicate: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 真的組裝跑一輪到 `done` 成立，回即時下行、冷讀歷史（含背景子代理各自的）與伺服器日誌。 */
async function runThroughWire(
  model: unknown,
  done: (state: ConversationState, warnings: readonly string[]) => boolean,
  extra: { plugins?: PluginEntry[]; backgroundSubagents?: Record<string, never> } = {},
) {
  const built = await createNexusAgent({
    model: model as never,
    checkpointer: new MemorySaver(),
    plugins: [],
    backend: new ContainedFilesystemBackend({ rootDir: dir, mode: 'workspace-write' }),
    ...extra,
  });
  const warnings: string[] = [];
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    warn: (message) => warnings.push(message),
    createAgent: async () => ({
      agent: built.agent as unknown as PumpAgent,
      commands: emptyCommandPoint(),
      dispose: () => built.dispose(),
      attachSessions: composeAttachSessions(built),
    }),
  });
  try {
    const client = createWireClient({
      baseUrl: 'http://failure.test',
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = await client.openEvents('t1', { signal: line.signal });
    void (async () => {
      try {
        for await (const frame of stream) frames.push(frame);
      } catch {
        // 中止收線。
      }
    })();
    await client.runStart('t1', '嗨');
    await until(() => done(reduceAll(emptyConversation(), frames), warnings));
    line.abort();
    const cold = await client.threadHistory('t1');
    if (cold.kind !== 'ok') throw new Error(cold.message);
    const subagents = await Promise.all(
      [...new Set(JSON.stringify(frames).match(/bg-[0-9a-f]+/g) ?? [])].map(async (runId) => {
        const outcome = await client.subagentHistory('t1', runId);
        if (outcome.kind !== 'ok') throw new Error(outcome.message);
        return reduceAll(emptyConversation(), outcome.result.events);
      }),
    );
    return {
      subagents,
      frames,
      warnings,
      coldFrames: cold.result.events,
      live: reduceAll(emptyConversation(), frames),
      history: reduceAll(emptyConversation(), cold.result.events),
    };
  } finally {
    await handler.close();
  }
}

const failed = (state: ConversationState) => state.status === 'failed';

describe('一輪失敗的錯誤碼', () => {
  it('真的 401：下行與冷讀歷史同碼同一句，都不含原文；伺服器日誌含', async () => {
    const run = await runThroughWire(live(), failed);
    for (const state of [run.live, run.history]) {
      expect(state).toMatchObject({ error: AUTH_FAILURE_MESSAGE, errorCode: 'AUTH' });
    }
    expect(JSON.stringify(run.frames)).not.toContain(LEAK);
    expect(JSON.stringify(run.coldFrames)).not.toContain(LEAK);
    expect(run.warnings.join('\n')).toContain(LEAK);
  }, 20000);

  it('一般失敗（真的 400）：下行與冷讀歷史同碼，原文留著，伺服器日誌不多寫', async () => {
    status = 400;
    const run = await runThroughWire(live(), failed);
    expect(run.live.errorCode).toBe('INVALID_REQUEST');
    expect(run.history.errorCode).toBe('INVALID_REQUEST');
    expect(run.live.error).toContain(LEAK);
    expect(run.warnings.join('\n')).not.toContain(LEAK);
  }, 20000);

  it('前景子代理的真 401：下行、冷讀歷史、回給父模型的結果都是固定句，伺服器日誌含', async () => {
    const rejected: string[] = [];
    const credentials = ambientCredentials();
    credentials.onRejected((line) => rejected.push(line));
    const root = new ScriptedChatModel({
      turns: [
        { content: '委派。', toolCalls: [{ name: 'task', id: 'c1', args: FOREGROUND_TASK }] },
        { content: '子代理失敗了。' },
      ],
    });
    const run = await runThroughWire(
      root,
      (state) => root.prompts.length >= 2 && state.status === 'idle',
      {
        plugins: [workerPlugin(live(credentials))],
      },
    );
    expect(hits).toBeGreaterThan(0);
    expect(JSON.stringify(run.frames)).not.toContain(LEAK);
    expect(JSON.stringify(run.coldFrames)).not.toContain(LEAK);
    const fixed = `工具 task 執行失敗：${AUTH_FAILURE_MESSAGE}`;
    expect(JSON.stringify(run.coldFrames)).toContain(fixed);
    expect(JSON.stringify(root.lastPrompt)).toContain(fixed);
    expect(JSON.stringify(root.lastPrompt)).not.toContain(LEAK);
    expect(rejected.join('\n')).toContain(LEAK);
  }, 20000);

  it('前景子代理串流中段的憑證失敗：同樣只有固定句', async () => {
    midStream = true;
    const rejected: string[] = [];
    const credentials = ambientCredentials();
    credentials.onRejected((line) => rejected.push(line));
    const root = new ScriptedChatModel({
      turns: [
        { content: '委派。', toolCalls: [{ name: 'task', id: 'c1', args: FOREGROUND_TASK }] },
        { content: '子代理失敗了。' },
      ],
    });
    const run = await runThroughWire(
      root,
      (state) => root.prompts.length >= 2 && state.status === 'idle',
      {
        plugins: [workerPlugin(live(credentials))],
      },
    );
    expect(hits).toBeGreaterThan(0);
    expect(JSON.stringify(run.frames)).not.toContain(LEAK);
    expect(JSON.stringify(run.coldFrames)).not.toContain(LEAK);
    expect(JSON.stringify(root.lastPrompt)).toContain(AUTH_FAILURE_MESSAGE);
    expect(rejected.join('\n')).toContain(LEAK);
  }, 20000);

  it('serve 那顆帶閘的模型 bindTools 之後一樣換，重試開著也只打一次', async () => {
    const rejected: string[] = [];
    const credentials = ambientCredentials();
    credentials.onRejected((line) => rejected.push(line));
    const model = createLiveModel(
      liveModelConfigSchema.parse({ baseUrl }),
      undefined,
      credentials,
      { requestGate: createRequestGate({ maxConcurrentRequests: 1, maxWaitMs: 1000 })! },
    );
    const bound = model.bindTools([]);
    await expect(bound.invoke('嗨')).rejects.toThrow(AUTH_FAILURE_MESSAGE);
    await expect(bound.invoke('嗨')).rejects.toMatchObject({
      name: 'CredentialRejectedError',
      cause: expect.objectContaining({ status: 401 }) as unknown,
    });
    expect(hits).toBe(2);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toContain(LEAK);
  }, 20000);

  it('沒有閘的模型：串流與 bindTools 之後一樣換', async () => {
    const model = live();
    await expect(
      (async () => {
        for await (const _chunk of await model.stream('嗨')) void _chunk;
      })(),
    ).rejects.toThrow(AUTH_FAILURE_MESSAGE);
    await expect(model.bindTools([]).invoke('嗨')).rejects.toThrow(AUTH_FAILURE_MESSAGE);
  }, 20000);

  it('root 串流中段的真 401：下行、turn/failed、冷讀歷史都是固定句', async () => {
    midStream = true;
    const rejected: string[] = [];
    const credentials = ambientCredentials();
    credentials.onRejected((line) => rejected.push(line));
    const run = await runThroughWire(live(credentials), failed);
    for (const state of [run.live, run.history]) {
      expect(state).toMatchObject({ error: AUTH_FAILURE_MESSAGE, errorCode: 'AUTH' });
    }
    expect(JSON.stringify(run.frames)).not.toContain(LEAK);
    expect(JSON.stringify(run.coldFrames)).not.toContain(LEAK);
    expect(rejected.join('\n')).toContain(LEAK);
  }, 20000);

  it('沒被基座包過的串流中段憑證錯誤：照樣是 AUTH 與固定句，原文不進 turn/failed', () => {
    const inband = new OpenAIClient.APIError(
      undefined,
      { code: 401, message: LEAK },
      undefined,
      undefined as never,
    );
    const failure = turnFailureOf(new CredentialRejectedError(inband));
    expect(failure.error.code).toBe('AUTH');
    expect(failure.message).toBe(AUTH_FAILURE_MESSAGE);
    expect(JSON.stringify(failure)).not.toContain(LEAK);
  });

  it('前景子代理的其他失敗（真的 400）：文字照舊，憑證那條不寫', async () => {
    status = 400;
    const rejected: string[] = [];
    const credentials = ambientCredentials();
    credentials.onRejected((line) => rejected.push(line));
    const root = new ScriptedChatModel({
      turns: [
        { content: '委派。', toolCalls: [{ name: 'task', id: 'c1', args: FOREGROUND_TASK }] },
        { content: '子代理失敗了。' },
      ],
    });
    const run = await runThroughWire(
      root,
      (state) => root.prompts.length >= 2 && state.status === 'idle',
      {
        plugins: [workerPlugin(live(credentials))],
      },
    );
    expect(JSON.stringify(run.coldFrames)).toContain(LEAK);
    expect(rejected).toEqual([]);
  }, 20000);

  it('背景子代理的真 401：它自己的歷史與結算都不含原文，伺服器日誌含', async () => {
    const worker: PluginEntry = {
      plugin: {
        name: 'worker-host',
        apply(registry) {
          registry.subagents.register({
            name: 'worker',
            description: '幹活的。',
            systemPrompt: '你是 worker。',
            model: live() as never,
          });
        },
      },
    };
    const root = new ScriptedChatModel({
      turns: [
        {
          content: '委派。',
          toolCalls: [
            {
              name: 'subagent',
              id: 'c1',
              args: { description: '幹活', subagent_type: 'worker', run_in_background: true },
            },
          ],
        },
        { content: '派了。' },
        { content: '收到。' },
      ],
    });
    const run = await runThroughWire(
      root,
      (_state, warnings) => warnings.join('\n').includes(LEAK),
      { plugins: [worker], backgroundSubagents: {} },
    );
    expect(hits).toBeGreaterThan(0);
    expect(JSON.stringify(run.frames)).not.toContain(LEAK);
    expect(run.subagents).toHaveLength(1);
    expect(run.subagents[0]).toMatchObject({ error: AUTH_FAILURE_MESSAGE, errorCode: 'AUTH' });
    expect(JSON.stringify(run.subagents)).not.toContain(LEAK);
  }, 20000);
});

describe('pump 的邊界', () => {
  it('補結果也失敗（AggregateError）：frame 與 turn/failed 同一個碼，原文照樣進伺服器日誌', async () => {
    const auth = Object.assign(new Error(`401 ${LEAK}`), { status: 401 });
    const agent = {
      streamEvents: async () =>
        (async function* () {
          pump.sessionLog.append('tool/call', { callId: 'c', name: 'x', arguments: '{}' });
          yield {
            type: 'event',
            seq: 0,
            method: 'lifecycle',
            params: {
              namespace: [],
              timestamp: 0,
              data: { event: 'failed', graph_name: 'root', error: auth.message },
            },
          };
          throw auth;
        })(),
      getState: async () => {
        throw new Error('存檔點讀不到');
      },
      updateState: async () => ({}),
    } as unknown as PumpAgent;
    const warnings: string[] = [];
    const pump: ThreadPump = new ThreadPump(
      agent,
      'boundary',
      undefined,
      undefined,
      undefined,
      undefined,
      (message) => warnings.push(message),
    );
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['lifecycle'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    await pump.submit({ kind: 'message', text: 'A' }).catch(() => undefined);
    await pump.whenIdle();
    pump.close();
    line.abort();
    await draining;
    const state = frames.reduce(reduceConversation, emptyConversation());
    const turn = pump.sessionLog.events.findLast((event) => event.type === 'turn/failed');
    expect(state.errorCode).toBe('AUTH');
    expect(turn?.data).toMatchObject({
      message: AUTH_FAILURE_MESSAGE,
      error: { code: 'AUTH', message: AUTH_FAILURE_MESSAGE },
    });
    expect(warnings.join('\n')).toContain(LEAK);
    expect(warnings.join('\n')).toContain('補不進去');
  });
});

describe('取消', () => {
  it('中止時基座發的 failed frame 不帶碼，畫面是已停止', async () => {
    const auth = Object.assign(new Error(`401 ${LEAK}`), { status: 401 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = {
      streamEvents: async () =>
        (async function* () {
          await held;
          yield {
            type: 'event',
            seq: 0,
            method: 'lifecycle',
            params: {
              namespace: [],
              timestamp: 0,
              data: { event: 'failed', graph_name: 'root', error: auth.message },
            },
          };
          throw auth;
        })(),
      getState: async () => ({ values: {} }),
      updateState: async () => ({}),
    } as unknown as PumpAgent;
    const pump = new ThreadPump(agent, 'cancel');
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['lifecycle'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    const running = pump.submit({ kind: 'message', text: 'A' }).catch(() => undefined);
    await until(() => pump.cancel() === 'run');
    release();
    await running;
    await pump.whenIdle();
    pump.close();
    line.abort();
    await draining;
    const state = frames.reduce(reduceConversation, emptyConversation());
    expect(state.status).toBe('stopped');
    expect(state.errorCode).toBeUndefined();
    expect(JSON.stringify(frames)).not.toContain('"code"');
  });
});

describe('cli', () => {
  it('真的 401：stderr 帶原文，行程拋出的錯與 cli.jsonl 不帶', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const root = await mkdtemp(join(dir, 'log-'));
    const patch = join(dir, 'patch.yml');
    await writeFile(
      patch,
      [
        '- id: live-model',
        '  config:',
        `    baseUrl: '${baseUrl}'`,
        '- id: thread-title-llm',
        '  disabled: true',
        '',
      ].join('\n'),
      'utf8',
    );
    const thrown = await runCli({
      argv: ['--live', '--session-log', root, '--patch', patch, '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
      env: {},
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(stderr.mock.calls.join('\n')).toContain(LEAK);
    expect((thrown as Error).message).toBe(AUTH_FAILURE_MESSAGE);
    const [runDir] = await readdir(root);
    const events = await sessionEventsOf(join(root, runDir!), 'cli');
    expect(JSON.stringify(events)).not.toContain(LEAK);
    expect(events.find((event) => event.type === 'turn/failed')?.data).toMatchObject({
      message: AUTH_FAILURE_MESSAGE,
      error: { code: 'AUTH' },
    });
  }, 20000);
});
