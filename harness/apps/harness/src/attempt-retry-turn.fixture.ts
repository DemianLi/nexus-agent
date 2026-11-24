/**
 * 「串流中段失敗、整次重打」跑一輪的夾具：假的 SSE 端點 → `createLiveModel` → `createNexusAgent` → `ThreadPump`。
 * 兩個 loop 共用，所以 `assistant/attempt` 的位置與內容可以逐格對照。
 *
 * **零憑證**：對手方是本機的假端點；金鑰是假的，只為了過工廠的「缺 key 當場失敗」。
 */

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemorySaver } from '@langchain/langgraph';
import type { SessionEvent, StreamRetryOptions } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { vi } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { createLiveModel } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 第 n 次請求端點演哪一齣：`ok` 吐完整回覆；`task` 叫一次前景子代理；其餘吐兩個字（甲乙）之後各自失敗。 */
export type RetryAct = 'ok' | 'mid503' | 'cut' | 'stall' | 'task';

const chunk = (id: string, delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const envelope = (code: number): string =>
  `data: ${JSON.stringify({ error: { message: '上游出事了', type: 'upstream', code } })}\n\n`;

/** 照劇本演的假 OpenAI 端點。劇本用完之後的請求一律演 `ok`。 */
async function scriptedOpenAi(script: readonly RetryAct[]) {
  let hits = 0;
  const server = createServer((req, res: ServerResponse) => {
    const act = script[hits] ?? 'ok';
    hits += 1;
    const id = `chatcmpl-${hits}`;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (act === 'task') {
      res.write(
        chunk(id, {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: 'call_task',
              type: 'function',
              function: {
                name: 'task',
                arguments: JSON.stringify({
                  description: '回報一句話',
                  subagent_type: 'general-purpose',
                }),
              },
            },
          ],
        }),
      );
      res.write(chunk(id, {}, 'tool_calls'));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.write(chunk(id, { role: 'assistant', content: '' }));
    if (act === 'ok') {
      res.write(chunk(id, { content: '丙' }));
      res.write(chunk(id, { content: '丁' }));
      res.write(chunk(id, {}, 'stop'));
      res.end('data: [DONE]\n\n');
      return;
    }
    res.write(chunk(id, { content: '甲' }));
    res.write(chunk(id, { content: '乙' }));
    if (act === 'stall') return;
    if (act === 'cut') {
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    setTimeout(() => {
      res.write(envelope(503));
      res.end('data: [DONE]\n\n');
    }, 30);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface RetryTurnOptions {
  readonly loop: 'native' | 'langgraph';
  /** 這幾種事件寫進 root 日誌時拋這個錯。 */
  readonly reject?: { readonly types: readonly string[]; readonly error: Error };
  readonly streamRetry?: StreamRetryOptions;
}

/** 重試預算：兩次、退避 20ms。 */
export const RETRY_BUDGET = { maxRetries: 2, initialDelayMs: 20 } as const;

/** 跑一輪，交回日誌（root 與子代理）、線上 frame、`submit` 拋出的東西與端點被打的次數。 */
export async function runRetryTurn(script: readonly RetryAct[], options: RetryTurnOptions) {
  const upstream = await scriptedOpenAi(script);
  const built = await createNexusAgent({
    model: createLiveModel(
      liveModelConfigSchema.parse({
        baseUrl: upstream.baseUrl,
        timeoutMs: 400,
        streamIdleTimeoutMs: 400,
      }),
    ),
    checkpointer: new MemorySaver(),
    plugins: [],
    agentLoop: options.loop,
    streamRetry: options.streamRetry ?? RETRY_BUDGET,
  });
  const warnings: string[] = [];
  const pump = new ThreadPump(
    built.agent as PumpAgent,
    'attempt-retry',
    undefined,
    undefined,
    undefined,
    undefined,
    (message) => warnings.push(message),
  );
  if (options.reject !== undefined) {
    const { types, error } = options.reject;
    const root = pump.sessions.root;
    const real = root.append.bind(root);
    vi.spyOn(root, 'append').mockImplementation(((type: never, data: never, opts: never) => {
      if (types.includes(type)) throw error;
      return real(type, data, opts);
    }) as typeof root.append);
  }
  const detach = built.attachSession(pump.sessions);
  const line = new AbortController();
  const frames: Event[] = [];
  const draining = (async () => {
    for await (const frame of pump.subscribe(['messages', 'lifecycle', 'custom'], line.signal)) {
      frames.push(frame);
    }
  })();
  try {
    const thrown = await pump.submit({ kind: 'message', text: '說點什麼' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    return {
      thrown,
      frames,
      events: pump.sessions.root.events as readonly SessionEvent[],
      /** root 以外每一份日誌的事件（子代理）。 */
      children: pump.sessions
        .list()
        .filter((entry) => entry.address.kind !== 'root')
        .map((entry) => entry.log.events as readonly SessionEvent[]),
      hits: upstream.hits(),
      warnings,
    };
  } finally {
    line.abort();
    await draining;
    detach();
    await upstream.close();
    vi.restoreAllMocks();
  }
}

/** 隨機的 UUID（`retryId`、run id）：同一個值在一份日誌裡換成同一個編號，所以「兩顆事件指同一個 id」這件事還在。 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** 日誌存成 jsonl：只把 `time`、退避的實測毫秒（`delayMs` 有抖動、`waitedMs` 是實測）與隨機 UUID 正規化，其餘逐位元組。 */
export function normalizedJsonl(events: readonly SessionEvent[]): string {
  const seen = new Map<string, string>();
  return (
    events
      .map((event) =>
        JSON.stringify({ ...event, time: '<time>' }, (key, value: unknown) =>
          key === 'delayMs' || key === 'waitedMs' ? '<ms>' : value,
        ).replace(UUID, (id) => {
          if (!seen.has(id)) seen.set(id, `<uuid-${String(seen.size + 1)}>`);
          return seen.get(id)!;
        }),
      )
      .join('\n') + '\n'
  );
}
