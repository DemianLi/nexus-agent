/**
 * 全機模型請求並行閘的**接線**（[#1505](https://github.com/DemianLi/nexus-agent/issues/1505)）：閘本體與掛閘的模型類別各有自己的測試
 * （`request-gate.test.ts`、`gated-chat-openai.test.ts`），那些測試自己把閘傳進去，**拿掉組裝那一行不會紅**。這裡從 `runServe --live` 起量，
 * 對手方是本機假端點：它記每個請求是哪顆模型、是不是標題，並照測試的意思扣住不回。
 *
 * 每個「建模型的地方」各有一條，各自對應一個突變（拿掉那一處交閘的那一行 → 那一條紅）：
 *
 * | 地方 | 這裡的哪一條 |
 * | --- | --- |
 * | `serve.ts` 起動期建閘、交給 `assembly.create`（root 那一顆） | 對話請求 |
 * | `titleLlmFor` 預設的標題模型 | 標題請求 |
 * | `titleLlmFor` 跟隨主路由的標題模型 | 跟隨主路由的標題請求 |
 * | `createModelSelectionHost` 建的別顆實例 | 選了別顆的對話請求 |
 * | `liveSubagentModelFor`（背景子代理指定的模型） | 單獨一條，不經 serve；另有一條從 `runServe --live` 起量（呼叫點交不交閘） |
 *
 * 做法一致：上限 1，讓**一個**請求扣住那唯一的名額，再開另一條 thread 的請求，量它有沒有溜到端點。不掛閘的那一處，
 * 它發的請求不占名額，另一條 thread 的請求就會直接到端點。
 *
 * **零憑證、零外部連線。**
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HumanMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { liveSubagentModelFor } from './assembly-root.js';
import { bodyLog, serveClient, TIME_CONTEXT_OFF_PATCH_ROWS } from './fixtures.js';
import { DEFAULT_LIVE_MODEL_ENTRY, LIVE_API_KEY_ENV } from './live-model.js';
import { RequestGate } from './request-gate.js';
import { runServe } from './serve.js';
import type { RunningServe } from './serve.js';
import { liveModelConfigSchema } from './settings/live-model.js';

const FAKE_KEY = 'nvapi-fake-for-loopback-only';
const A = 'model-a';
const B = 'model-b';
/** 對話請求的最後一句帶這個：端點照劇本回一個 `subagent` 工具呼叫，指定用 B、背景跑。 */
const DELEGATE_MARK = 'DELEGATE-TO-B';
/** 子代理的任務描述帶這個：端點據此把子代理發的請求挑出來。 */
const SUBTASK_MARK = 'SUBTASK-MARK';

interface Seen {
  readonly model: string;
  readonly title: boolean;
  /** 背景子代理發的請求（任務描述帶 {@link SUBTASK_MARK}）。 */
  readonly sub: boolean;
  /** 最後一則訊息的文字（工具結果等非字串內容為空字串）。 */
  readonly last: string;
}

interface Endpoint {
  readonly baseUrl: string;
  readonly seen: Seen[];
  /** 之後到的、符合條件的請求一律扣住不回；回傳的函式放掉目前已經扣住的那些，並且之後的不再扣。 */
  hold(which: 'root' | 'title' | 'sub'): () => void;
  close(): Promise<void>;
}

async function startEndpoint(): Promise<Endpoint> {
  const seen: Seen[] = [];
  const held: Record<'root' | 'title' | 'sub', { active: boolean; waiting: (() => void)[] }> = {
    root: { active: false, waiting: [] },
    title: { active: false, waiting: [] },
    sub: { active: false, waiting: [] },
  };
  const sockets = new Set<ServerResponse>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model?: string;
        stream?: boolean;
        messages: { role: string; content: unknown }[];
      };
      const first = body.messages[0];
      const title =
        first?.role === 'system' &&
        typeof first.content === 'string' &&
        first.content.startsWith('Create a concise title');
      const lastMessage = body.messages.at(-1);
      const last = typeof lastMessage?.content === 'string' ? lastMessage.content : '';
      const sub =
        !title && body.messages.some((m) => JSON.stringify(m.content).includes(SUBTASK_MARK));
      seen.push({ model: body.model ?? '', title, sub, last });
      // 劇本：對話請求的最後一句要它派子代理，就回一個 `subagent` 工具呼叫（背景、指定 B）。
      const delegate =
        !title && !sub && lastMessage?.role === 'user' && last.includes(DELEGATE_MARK);
      sockets.add(response);
      response.on('close', () => sockets.delete(response));
      const id = `chatcmpl-${String(seen.length)}`;
      const reply = (): void => {
        const text = title ? '標題' : '好';
        if (delegate) {
          const call = {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'subagent',
              arguments: JSON.stringify({
                description: SUBTASK_MARK,
                subagent_type: 'general-purpose',
                run_in_background: true,
                model: B,
              }),
            },
          };
          const piece = (delta: Record<string, unknown>, reason: string | null): string =>
            `data: ${JSON.stringify({
              id,
              object: 'chat.completion.chunk',
              created: 0,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: reason }],
            })}\n\n`;
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(piece({ role: 'assistant', content: '' }, null));
          response.write(piece({ tool_calls: [{ index: 0, ...call }] }, null));
          response.write(piece({}, 'tool_calls'));
          response.end('data: [DONE]\n\n');
          return;
        }
        if (body.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id,
              object: 'chat.completion',
              created: 0,
              model: body.model,
              choices: [
                { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
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
            created: 0,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(chunk({ role: 'assistant', content: text }, null));
        response.write(chunk({}, 'stop'));
        response.end('data: [DONE]\n\n');
      };
      const slot = held[title ? 'title' : sub ? 'sub' : 'root'];
      if (slot.active) slot.waiting.push(reply);
      else reply();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    seen,
    hold(which) {
      held[which].active = true;
      return () => {
        held[which].active = false;
        for (const reply of held[which].waiting.splice(0)) reply();
      };
    },
    async close() {
      for (const response of sockets) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 給「不會發生」的斷言一點時間：這段時間內端點沒有收到那個請求。 */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400));

const entry = (id: string): Record<string, unknown> => ({
  ...structuredClone(DEFAULT_LIVE_MODEL_ENTRY),
  id,
});

/** `live-model` 指向假端點、上限 1、兩顆模型（A 預設、B 可選）；標題那一列按需關掉。 */
async function patchFor(
  baseUrl: string,
  options: {
    title: boolean;
    cap?: number | undefined;
    maxWaitMs?: number | undefined;
    /** 打開子代理選模型，授權清單只有 B（背景子代理才能被指定 B）。 */
    selection?: boolean | undefined;
  },
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'nexus-gate-wiring-'));
  const path = join(dir, 'patch.yml');
  const lines = [
    '- id: live-model',
    '  config:',
    `    baseUrl: '${baseUrl}'`,
    '    retryPolicy: { mode: normal, maxRetries: 0 }',
    `    modelId: '${A}'`,
    ...(options.cap === undefined ? [] : [`    maxConcurrentRequests: ${String(options.cap)}`]),
    `    maxWaitMs: ${String(options.maxWaitMs ?? 60_000)}`,
    `    models: ${JSON.stringify([entry(A), entry(B)])}`,
  ];
  if (!options.title) lines.push('- id: thread-title-llm', '  disabled: true');
  if (options.selection === true) {
    lines.push(
      '- id: subagent-model-selection',
      '  config:',
      '    enabled: true',
      '    allowedModels:',
      `      - ${B}`,
    );
  }
  // 數的是端點收到的請求；`time-context`（#1625）不相干，關掉。
  await writeFile(path, lines.join('\n') + '\n' + TIME_CONTEXT_OFF_PATCH_ROWS, 'utf8');
  return path;
}

describe('serve --live：每個建模型的地方都從全機那一份閘取名額', () => {
  let endpoint: Endpoint | undefined;
  let running: RunningServe | undefined;
  const logged: string[] = [];

  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
    logged.length = 0;
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    await endpoint?.close();
    endpoint = undefined;
    vi.unstubAllEnvs();
  });

  async function boot(options: {
    title: boolean;
    cap?: number | undefined;
    maxWaitMs?: number | undefined;
    selection?: boolean | undefined;
  }) {
    endpoint = await startEndpoint();
    running = (await runServe({
      argv: ['--port', '0', '--live', '--patch', await patchFor(endpoint.baseUrl, options)],
      log: bodyLog(logged),
      env: {},
    })) as RunningServe;
    const client = await serveClient(running);
    return { client, endpoint };
  }

  const roots = (seen: readonly Seen[]): Seen[] =>
    seen.filter((request) => !request.title && !request.sub);

  it('起動時講出上限：印一行，寫明整台共用與逾時的碼', async () => {
    await boot({ title: false, cap: 1 });
    const line = logged.find((entry) => entry.includes('模型請求並行上限'));
    expect(line).toBeDefined();
    expect(line).toContain('1');
    expect(line).toContain('LOCAL_CAPACITY');
  });

  it('沒設 maxConcurrentRequests：起動印「不限」，兩條 thread 的請求同時到端點（與今天一樣，不排隊）', async () => {
    const { client, endpoint: fake } = await boot({ title: false });
    expect(logged).toContain('模型請求並行上限：不限');
    const release = fake.hold('root');
    await client.runStart('gate-a', '第一條');
    await client.runStart('gate-b', '第二條');
    await until(() => roots(fake.seen).length === 2, '兩個請求都到端點（沒有閘）');
    release();
  }, 60_000);

  it('對話請求（root 那一顆）：一條 thread 的請求占著名額，另一條 thread 的請求排隊，放掉才到端點', async () => {
    const { client, endpoint: fake } = await boot({ title: false, cap: 1 });
    const release = fake.hold('root');
    await client.runStart('gate-a', '第一條');
    await until(() => roots(fake.seen).length === 1, 'A 的請求到端點（被扣住）');
    await client.runStart('gate-b', '第二條');
    await quiet();
    // B 的請求排在閘外面，沒有到端點。
    expect(roots(fake.seen)).toHaveLength(1);
    release();
    await until(() => roots(fake.seen).length === 2, 'A 的名額還了之後 B 的請求才到端點');
  }, 60_000);

  it('排隊等超過 maxWaitMs：serve 日誌寫一行（含上限與下一步），那一條 thread 的請求從沒到端點', async () => {
    const { client, endpoint: fake } = await boot({ title: false, cap: 1, maxWaitMs: 300 });
    const release = fake.hold('root');
    await client.runStart('gate-a', '第一條');
    await until(() => roots(fake.seen).length === 1, 'A 的請求到端點（被扣住）');
    await client.runStart('gate-b', '第二條');
    await until(
      () => logged.some((line) => line.includes('[模型請求]') && line.includes('排隊')),
      'serve 日誌出現排隊逾時那一行',
    );
    const line = logged.find((entry) => entry.includes('[模型請求]'))!;
    expect(line).toContain('上限 1');
    expect(line).toContain('maxConcurrentRequests');
    // 這一行不是借「處理失敗，回 400」那條 warn 寫的。
    expect(line).not.toContain('回 400');
    expect(roots(fake.seen)).toHaveLength(1);
    release();
  }, 60_000);

  it('標題請求（預設的標題模型）：它占著名額時，兩條 thread 的對話請求都排隊', async () => {
    const { client, endpoint: fake } = await boot({ title: true, cap: 1 });
    const release = fake.hold('title');
    await client.runStart('gate-a', '第一條');
    // 標題請求跟第一句話一起發，先到的拿走唯一的名額；它被扣住，對話請求排在閘外面。
    await until(() => fake.seen.some((request) => request.title), 'A 的標題請求到端點（被扣住）');
    await client.runStart('gate-b', '第二條');
    await quiet();
    expect(roots(fake.seen)).toHaveLength(0);
    release();
    await until(() => roots(fake.seen).length === 2, '標題還了名額之後兩條對話請求才到端點');
  }, 60_000);

  it('標題請求（跟隨主路由的那一顆）：選了 B 再說話，標題走 B，同樣占名額', async () => {
    const { client, endpoint: fake } = await boot({ title: true, cap: 1 });
    const select = await client.selectModel('gate-a', { modelId: B });
    expect(select.kind).toBe('ok');
    const release = fake.hold('title');
    await client.runStart('gate-a', '第一條');
    await until(() => fake.seen.some((request) => request.title), 'A 的標題請求到端點（被扣住）');
    // 標題跟著主請求走的模型：是 B，不是預設的 A，所以走的是「跟隨主路由」那一顆實例。
    expect(fake.seen.find((request) => request.title)!.model).toBe(B);
    await client.runStart('gate-b', '第二條');
    await quiet();
    expect(roots(fake.seen)).toHaveLength(0);
    release();
    await until(() => roots(fake.seen).length === 2, '標題還了名額之後兩條對話請求才到端點');
  }, 60_000);

  it('選了別顆的對話請求（模型選擇建的別顆實例）也占名額', async () => {
    const { client, endpoint: fake } = await boot({ title: false, cap: 1 });
    const select = await client.selectModel('gate-a', { modelId: B });
    expect(select.kind).toBe('ok');
    const release = fake.hold('root');
    await client.runStart('gate-a', '第一條');
    await until(() => roots(fake.seen).length === 1, 'A 的請求到端點（被扣住）');
    expect(roots(fake.seen)[0]!.model).toBe(B);
    await client.runStart('gate-b', '第二條');
    await quiet();
    expect(roots(fake.seen)).toHaveLength(1);
    release();
    await until(() => roots(fake.seen).length === 2, 'A 的名額還了之後 B 的請求才到端點');
  }, 60_000);
});

describe('serve --live：背景子代理指定了模型也占全機的名額', () => {
  let endpoint: Endpoint | undefined;
  let running: RunningServe | undefined;

  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    await endpoint?.close();
    endpoint = undefined;
    vi.unstubAllEnvs();
  });

  it('一條 thread 派出指定 B 的背景子代理，子代理的請求占著唯一的名額：另一條 thread 的對話請求排隊，放掉才到端點', async () => {
    endpoint = await startEndpoint();
    running = (await runServe({
      argv: [
        '--port',
        '0',
        '--live',
        '--patch',
        await patchFor(endpoint.baseUrl, { title: false, cap: 1, selection: true }),
      ],
      log: () => undefined,
      env: {},
    })) as RunningServe;
    const client = await serveClient(running);
    const fake = endpoint;
    const release = fake.hold('sub');
    await client.runStart('gate-a', `請派子代理 ${DELEGATE_MARK}`);
    // 模型回了 `subagent` 工具呼叫，背景子代理用 B 發請求，被端點扣住——它拿著唯一的名額。
    await until(() => fake.seen.some((request) => request.sub), '子代理的請求到端點（被扣住）');
    expect(fake.seen.find((request) => request.sub)!.model).toBe(B);
    // 從 gate-a 的 root 請求（可能還有一個「工具結果之後」的續跑請求）都在這之前或之後處理完或排隊；
    // 這裡只看另一條 thread 的請求。
    await client.runStart('gate-b', '第二條 THREAD-B');
    await quiet();
    expect(fake.seen.some((request) => request.last.includes('THREAD-B'))).toBe(false);
    release();
    await until(
      () => fake.seen.some((request) => request.last.includes('THREAD-B')),
      '子代理的名額還了之後另一條 thread 的請求才到端點',
    );
  }, 60_000);
});

describe('liveSubagentModelFor：背景子代理指定的模型也受閘管', () => {
  let endpoint: Endpoint | undefined;

  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
  });
  afterEach(async () => {
    await endpoint?.close();
    endpoint = undefined;
    vi.unstubAllEnvs();
  });

  for (const effort of [undefined, 'off'] as const) {
    it(`名額被占著時請求不到端點，放掉才到（強度 ${effort ?? '預設'}）`, async () => {
      endpoint = await startEndpoint();
      const liveModel = liveModelConfigSchema.parse({
        baseUrl: endpoint.baseUrl,
        modelId: A,
        models: [entry(A), entry(B)],
      });
      const gate = new RequestGate({ maxConcurrent: 1, maxWaitMs: 60_000 });
      const make = liveSubagentModelFor(liveModel, undefined, gate);
      const model = make({ model: B, ...(effort !== undefined && { effort }) }) as unknown as {
        invoke(messages: HumanMessage[]): Promise<unknown>;
      };
      const occupied = await gate.acquire();
      const call = model.invoke([new HumanMessage('hi')]);
      await quiet();
      expect(endpoint.seen).toHaveLength(0);
      occupied();
      await call;
      expect(endpoint.seen).toEqual([expect.objectContaining({ model: B, title: false })]);
      expect(gate.active).toBe(0);
    });
  }

  it('不給閘（undefined）：不排隊，與今天一樣', async () => {
    endpoint = await startEndpoint();
    const liveModel = liveModelConfigSchema.parse({
      baseUrl: endpoint.baseUrl,
      modelId: A,
      models: [entry(A), entry(B)],
    });
    const model = liveSubagentModelFor(
      liveModel,
      undefined,
      undefined,
    )({ model: B }) as unknown as {
      invoke(messages: HumanMessage[]): Promise<unknown>;
    };
    await model.invoke([new HumanMessage('hi')]);
    expect(endpoint.seen).toHaveLength(1);
  });
});
