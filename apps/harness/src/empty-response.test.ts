/**
 * **空回覆算失敗、整次重打**（[#1437](https://github.com/DemianLi/nexus-agent/issues/1437)，驗收 G）。
 *
 * 走真的組裝路徑（CLI `--live`＋loopback 端點，同 `retry-policy-wiring.test.ts`），讀 `cli.jsonl`：
 *
 * | 端點回什麼 | 期望 |
 * | --- | --- |
 * | `finish_reason: stop`、什麼都沒有（一次，之後正常） | 重打一次，日誌有一顆 `llm/retry`（`EMPTY_RESPONSE`），這一輪成功；空的那次**沒有** `assistant/message`、`model/end` 標 `error` |
 * | 同上，每次都空 | 打滿 `1 + maxRetries` 次，`turn/failed.error.code` 是 `EMPTY_RESPONSE` |
 * | 只有推理（`reasoning_content`），沒有答案 | 不重打（Q3 (a)：這一版只處理完全空的那種） |
 * | 只有工具呼叫 | 不重打 |
 * | 有文字 | 不重打 |
 *
 * **串流與非串流各一份**：CLI 的 `finish_reason` 是供應商原字串，serve 那條在我們拿到之前被 `@langchain/core` 對映過
 * （不認得的一律變 `stop`）。producer 認的是 `stop`，兩條都要紅燈。
 *
 * **零憑證、零外部連線**。
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { MemorySaver } from '@langchain/langgraph';
import type { SessionEvent } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { runCli } from './cli.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { sessionEventsOf } from './session-files.fixture.js';
import { liveModelConfigSchema, streamRetryOptionsOf } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const FAKE_KEY = 'nvapi-fake-for-loopback-only';
const RETRIES = 2;
const POLICY =
  `    retryPolicy: { mode: normal, maxRetries: ${String(RETRIES)}, ` +
  'backoff: { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 } }';

/** 一次主請求的回法。 */
type Shape = 'empty' | 'reasoning-only' | 'tool-only' | 'text';

async function endpoint(shapeOf: (nth: number) => Shape) {
  const counts = { main: 0, streamed: 0 };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (piece: Buffer) => chunks.push(piece));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        stream?: boolean;
        messages: { role: string; content: unknown }[];
      };
      const first = body.messages[0];
      const title =
        first?.role === 'system' &&
        typeof first.content === 'string' &&
        first.content.startsWith('Create a concise title');
      const id = `chatcmpl-empty-${String(counts.main)}`;
      if (title) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 1_790_000_000,
            model: 'fake',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '一個標題' },
                finish_reason: 'stop',
              },
            ],
          }),
        );
        return;
      }
      counts.main += 1;
      const shape = shapeOf(counts.main);
      const message: Record<string, unknown> = { role: 'assistant', content: '' };
      let finish = 'stop';
      if (shape === 'reasoning-only') message.reasoning_content = '想了很久，沒有答案。';
      if (shape === 'text') message.content = '好';
      if (shape === 'tool-only') {
        finish = 'tool_calls';
        message.tool_calls = [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'no_such_tool', arguments: '{}' },
          },
        ];
      }
      if (body.stream === true) counts.streamed += 1;
      if (body.stream !== true) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 1_790_000_000,
            model: 'fake',
            choices: [{ index: 0, message, finish_reason: finish }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const piece = (delta: Record<string, unknown>, reason: string | null): string =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 1_790_000_000,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: reason }],
        })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(piece({ role: 'assistant', content: '' }, null));
      if (shape === 'reasoning-only') {
        response.write(piece({ reasoning_content: message.reasoning_content }, null));
      }
      if (shape === 'text') response.write(piece({ content: '好' }, null));
      if (shape === 'tool-only') {
        response.write(
          piece({ tool_calls: [{ index: 0, ...(message.tool_calls as object[])[0]! }] }, null),
        );
      }
      response.write(piece({}, finish));
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    counts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function cliEvents(root: string): Promise<SessionEvent[]> {
  const [runDir] = await readdir(root);
  return sessionEventsOf(join(root, runDir!), 'cli');
}

describe.each([
  ['非串流（CLI 一輪，finish_reason 是供應商原字串）', false],
  ['串流（pump／serve 的路，finish_reason 經 @langchain/core 對映過）', true],
] as const)('空回覆算失敗：%s', (_name, stream) => {
  let upstream: Awaited<ReturnType<typeof endpoint>> | undefined;

  beforeEach(() => {
    vi.stubEnv(LIVE_API_KEY_ENV, FAKE_KEY);
  });
  afterEach(async () => {
    if (upstream !== undefined) await upstream.close();
    upstream = undefined;
    vi.unstubAllEnvs();
  });

  /** 非串流：真的 CLI（`--live`＋`--patch`），讀 `cli.jsonl`。 */
  async function runCliOnce() {
    const root = await mkdtemp(join(tmpdir(), 'nexus-empty-response-log-'));
    const dir = await mkdtemp(join(tmpdir(), 'nexus-empty-response-'));
    const patch = join(dir, 'patch.yml');
    await writeFile(
      patch,
      [
        '- id: live-model',
        '  config:',
        `    baseUrl: '${upstream!.baseUrl}'`,
        POLICY,
        '- id: thread-title-llm',
        '  disabled: true',
        '',
      ].join('\n'),
      'utf8',
    );
    await runCli({
      argv: ['--live', '--session-log', root, '--patch', patch, '說點什麼'],
      input: new PassThrough(),
      output: new PassThrough(),
      printer: { log: () => undefined, error: () => undefined },
      env: {},
    }).then(
      () => undefined,
      () => undefined,
    );
    return { events: await cliEvents(root) };
  }

  /** 串流：真的 `createLiveModel`＋真的 `createNexusAgent`＋真的 `ThreadPump`（serve 的路），讀 pump 的日誌。 */
  async function runPumpOnce() {
    const config = liveModelConfigSchema.parse({
      baseUrl: upstream!.baseUrl,
      retryPolicy: {
        mode: 'normal',
        maxRetries: RETRIES,
        backoff: { initialDelayMs: 1, maxDelayMs: 5, jitterRatio: 0 },
      },
    });
    const built = await createNexusAgent({
      model: createLiveModel(config),
      checkpointer: new MemorySaver(),
      plugins: [],
      streamRetry: streamRetryOptionsOf(config.retryPolicy),
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'empty-response');
    const detach = built.attachSession(pump.sessions);
    try {
      await pump.submit({ kind: 'message', text: '說點什麼' }).then(
        () => undefined,
        () => undefined,
      );
      return { events: [...pump.sessions.root.events] as SessionEvent[] };
    } finally {
      detach();
      await built.dispose();
    }
  }

  const runOnce = () => (stream ? runPumpOnce() : runCliOnce());

  const retries = (events: readonly SessionEvent[]) =>
    events.filter((event) => event.type === 'llm/retry');

  it('空一次、第二次正常：重打一次，llm/retry 是 EMPTY_RESPONSE，這一輪成功；空的那次沒有 assistant/message', async () => {
    upstream = await endpoint((nth) => (nth === 1 ? 'empty' : 'text'));
    const { events } = await runOnce();

    expect(upstream.counts.main).toBe(2);
    // 這一組真的走了它名字說的那條路：串流組每個請求都是 `stream: true`，非串流組一個都不是。
    expect(upstream.counts.streamed).toBe(stream ? 2 : 0);
    const rows = retries(events);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data).toMatchObject({ failure: { code: 'EMPTY_RESPONSE' } });
    // 空的那次是 `error` 收的（不是正常回覆），日誌上只有成功那次有 `assistant/message`。
    const ends = events.filter((event) => event.type === 'model/end');
    expect(ends.map((event) => (event.data as { outcome?: string }).outcome)).toEqual([
      'error',
      undefined,
    ]);
    expect(events.filter((event) => event.type === 'assistant/message')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'turn/failed')).toHaveLength(0);
  }, 30_000);

  it('每次都空：打滿 1 + maxRetries 次，turn/failed.error.code 是 EMPTY_RESPONSE，沒有任何 assistant/message', async () => {
    upstream = await endpoint(() => 'empty');
    const { events } = await runOnce();

    expect(upstream.counts.main).toBe(RETRIES + 1);
    expect(retries(events)).toHaveLength(RETRIES);
    for (const row of retries(events)) {
      expect(row.data).toMatchObject({ failure: { code: 'EMPTY_RESPONSE' } });
    }
    expect(events.filter((event) => event.type === 'assistant/message')).toHaveLength(0);
    const failed = events.filter((event) => event.type === 'turn/failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.data).toMatchObject({ error: { code: 'EMPTY_RESPONSE' } });
  }, 30_000);

  it('只有推理、沒有答案：不重打（這一版只處理完全空的那種）', async () => {
    upstream = await endpoint(() => 'reasoning-only');
    const { events } = await runOnce();

    expect(upstream.counts.main).toBe(1);
    expect(retries(events)).toHaveLength(0);
    expect(events.filter((event) => event.type === 'turn/failed')).toHaveLength(0);
  }, 30_000);

  it('只有工具呼叫（finish_reason: tool_calls）：不是空回覆，不重打', async () => {
    upstream = await endpoint((nth) => (nth === 1 ? 'tool-only' : 'text'));
    const { events } = await runOnce();

    expect(
      retries(events).filter((event) => JSON.stringify(event.data).includes('EMPTY_RESPONSE')),
    ).toHaveLength(0);
    expect(events.filter((event) => event.type === 'turn/failed')).toHaveLength(0);
  }, 30_000);

  it('有文字：不重打', async () => {
    upstream = await endpoint(() => 'text');
    const { events } = await runOnce();

    expect(upstream.counts.main).toBe(1);
    expect(retries(events)).toHaveLength(0);
  }, 30_000);
});
