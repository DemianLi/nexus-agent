# 橋接原型：`zz-bridge-1341.test.ts`（拋棄式，不進測試樹）

這是 [`wrapmodelcall-bridge-gaps-2026-10-11.md`](wrapmodelcall-bridge-gaps-2026-10-11.md) 量測用的原型，整份原樣收在這裡，
讓每一列的「最小重現」有地方可跑。它**不是**產品碼、也不該進 `apps/harness/src`：每個實驗只把觀察寫進 JSON，斷言只守「原型跑得起來」。

## 怎麼跑

基準是 develop `58c69808`（2026-10-11）。把下面整段程式存成 `apps/harness/src/zz-bridge-1341.test.ts`，然後：

```bash
cd apps/harness
ZZ_OUT=/tmp/zz-bridge-1341.json npx vitest run src/zz-bridge-1341.test.ts
```

單跑某一列用 `-t`，例如 `-t "P5d"`。結果在 `ZZ_OUT` 指的 JSON，每個實驗一個鍵。零憑證：對手方是本機假端點，金鑰是假的。

用完請刪掉那個檔，不要提交。

## 原型內容

```ts
/**
 * #1341 的拋棄式原型：把 `wrapModelCall` 橋接成 `agent/request`／`llm/stream`／`agent/request-error`，
 * 在假端點上量語意落差。**不合進 develop**；每個實驗把觀察到的東西寫進 `OUT`（JSON），斷言只守
 * 「原型本身跑得起來」，結論看 JSON 與 `.docs/wrapmodelcall-bridge-gaps-2026-10-11.md`。
 */

import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { AIMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import type { ChatOpenAIFields } from '@langchain/openai';
import { MemorySaver } from '@langchain/langgraph';
import { createMiddleware } from 'langchain';
import type { SessionEventMap } from '@nexus/core';
import { turnCancelSignalOf } from '@nexus/core';
import { emptyConversation, reduceConversation } from '@nexus/wire';
import type { AiEntry, Event } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { classifyLlmFailure, createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const OUT = process.env['ZZ_OUT'] ?? '/tmp/zz-bridge-1341.json';
const results: Record<string, unknown> = {};
const record = (id: string, observed: unknown): void => {
  results[id] = observed;
  writeFileSync(OUT, JSON.stringify(results, null, 2));
};

// ───────────────────────────── 假端點 ─────────────────────────────

type Act = 'ok' | 'mid503' | 'http503' | 'first503' | 'length' | 'hang' | 'stall' | 'slow';

const chunk = (id: string, delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'fake',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish === 'stop' || finish === 'length'
      ? { usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }
      : {}),
  })}\n\n`;

const envelope = (code: number): string =>
  `data: ${JSON.stringify({ error: { message: '上游出事了', type: 'upstream', code } })}\n\n`;

async function scriptedOpenAi(script: readonly Act[]) {
  let hits = 0;
  const bodies: Record<string, unknown>[] = [];
  const server = createServer((req, res: ServerResponse) => {
    const act = script[hits] ?? 'ok';
    hits += 1;
    const id = `chatcmpl-${hits}`;
    const parts: Buffer[] = [];
    req.on('data', (part: Buffer) => parts.push(part));
    req.on('end', () => {
      try {
        bodies.push(JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>);
      } catch {
        bodies.push({});
      }
      if (act === 'hang') return;
      const parsed = bodies[bodies.length - 1] ?? {};
      if (parsed['stream'] !== true && act === 'ok') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 0,
            model: 'fake',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '甲乙丙丁' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          }),
        );
        return;
      }
      if (act === 'http503') {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'overloaded', type: 'overloaded' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (act === 'first503') {
        res.write(envelope(503));
        res.end('data: [DONE]\n\n');
        return;
      }
      res.write(chunk(id, { role: 'assistant', content: '' }));
      const say = (text: string, ms: number, then: () => void): void => {
        setTimeout(() => {
          res.write(chunk(id, { content: text }));
          then();
        }, ms);
      };
      if (act === 'length') {
        res.write(chunk(id, { content: '先說一句' }));
        res.write(
          chunk(id, {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"file_pa' },
              },
            ],
          }),
        );
        res.write(chunk(id, {}, 'length'));
        res.end('data: [DONE]\n\n');
        return;
      }
      if (act === 'slow') {
        // 慢慢吐，給中止留時間。
        say('甲', 5, () =>
          say('乙', 150, () => say('丙', 150, () => say('丁', 150, () => finishOk(res, id)))),
        );
        return;
      }
      say('甲', 5, () =>
        say('乙', 5, () => {
          if (act === 'stall') return;
          if (act === 'mid503') {
            setTimeout(() => {
              res.write(envelope(503));
              res.end('data: [DONE]\n\n');
            }, 20);
            return;
          }
          say('丙', 5, () => say('丁', 5, () => finishOk(res, id)));
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    hits: () => hits,
    bodies,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function finishOk(res: ServerResponse, id: string): void {
  res.write(chunk(id, {}, 'stop'));
  res.end('data: [DONE]\n\n');
}

// ───────────────────────────── 極小的匯流排 ─────────────────────────────

type AnyFn = (payload: never, next: () => unknown) => unknown;

/** 照 dsh `events.ts:234-243`：監聽者由外而內，最後一個參數當最內層的 `next`；沒叫 `next()` 就是否決。 */
class Bus {
  private readonly listeners = new Map<string, AnyFn[]>();
  on(name: string, fn: AnyFn): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  waterfall<R>(name: string, payload: unknown, terminal: () => R): R {
    const fns = this.listeners.get(name) ?? [];
    const run = (index: number): R =>
      index >= fns.length ? terminal() : (fns[index]!(payload as never, () => run(index + 1)) as R);
    return run(0);
  }
}

// ───────────────────────────── 橋接 A：wrapModelCall ─────────────────────────────

interface BridgeOptions {
  /** `agent/request` 的 deadline：listener 回 `modelSettings` 就套上去。 */
  readonly applyConfig?: boolean;
  /** 預設照 dsh 先檢查中止；`false` 是第一版原型（中止時也派）。 */
  readonly checkAbort?: boolean;
}

/** 一則回覆：LangChain 的 `wrapModelCall` 只拿得到整則，所以橋接的「串流」只有一個元素。 */
interface WholeMessageChunk {
  readonly type: 'message';
  readonly message: AIMessage;
}

function bridgeA(bus: Bus, options: BridgeOptions = {}) {
  return createMiddleware({
    name: 'bridgeA1341',
    wrapModelCall: async (request, handler) => {
      const configurable = (request as { runtime?: { configurable?: unknown } }).runtime
        ?.configurable;
      const signal = turnCancelSignalOf({ configurable });
      const proposal = await bus.waterfall<Promise<{ modelSettings?: Record<string, unknown> }>>(
        'agent/request',
        { signal },
        () => Promise.resolve({}),
      );
      const req =
        options.applyConfig === true && proposal.modelSettings !== undefined
          ? {
              ...request,
              modelSettings: { ...request.modelSettings, ...proposal.modelSettings },
            }
          : request;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const stream = bus.waterfall<AsyncIterable<WholeMessageChunk>>(
            'llm/stream',
            { messages: request.messages, signal },
            () =>
              (async function* () {
                const message = (await handler(req as never)) as AIMessage;
                yield { type: 'message', message } satisfies WholeMessageChunk;
              })(),
          );
          let message: AIMessage | undefined;
          for await (const part of stream) message = part.message;
          if (message === undefined) throw new Error('llm/stream 沒有產出任何東西');
          return message;
        } catch (error) {
          // dsh：串流之後先 `signal.throwIfAborted()`，使用者按停止時不派 `agent/request-error`。
          if (options.checkAbort !== false && signal?.aborted === true) throw error;
          const action = await bus.waterfall<Promise<{ kind: 'retry' } | undefined>>(
            'agent/request-error',
            { error, attempt, signal, failure: classifyLlmFailure(error) },
            () => Promise.resolve(undefined),
          );
          if (action?.kind === 'retry') continue;
          throw error;
        }
      }
    },
  });
}

// ───────────────────────────── 橋接 B：model 層（ChatOpenAI 子類） ─────────────────────────────

/** 各入口被叫的次數：量「LangChain 到底走哪一條」。 */
const entry = { generate: 0, events: 0, chunks: 0 };
/** 第一次 `_streamChatModelEvents` 真的吐出來的事件，給短路實驗重播用。 */
const captured: unknown[] = [];

/**
 * `llm/stream` 的另一種接法：不當 middleware，而是在 model 這一層包 `_streamChatModelEvents`（web 的 v3 串流走的那一條）。
 * 事件在 LangChain 自己的 callback 通道的**上游**被攔到，變形後再往下流，畫面與最後的訊息看到同一份。
 * 樣式照 `attachment-chat-openai.ts`：三個入口都覆寫，`withConfig` 也要覆寫（基座是 `new ChatOpenAI(this.fields)`）。
 */
class BridgedChatOpenAI extends ChatOpenAI {
  readonly #bus: Bus;
  constructor(fields: ChatOpenAIFields, bus: Bus) {
    super(fields);
    this.#bus = bus;
  }
  override async _generate(...args: Parameters<ChatOpenAI['_generate']>) {
    entry.generate += 1;
    return super._generate(...args);
  }
  override async *_streamResponseChunks(...args: Parameters<ChatOpenAI['_streamResponseChunks']>) {
    entry.chunks += 1;
    yield* super._streamResponseChunks(...args);
  }
  override async *_streamChatModelEvents(
    ...args: Parameters<ChatOpenAI['_streamChatModelEvents']>
  ) {
    entry.events += 1;
    const [messages, options, runManager] = args;
    const real = (): AsyncIterable<unknown> => {
      const inner = super._streamChatModelEvents(messages, options, runManager);
      return (async function* () {
        for await (const event of inner) {
          captured.push(event);
          yield event;
        }
      })();
    };
    const stream = this.#bus.waterfall<AsyncIterable<unknown>>(
      'llm/stream',
      { messages, signal: options?.signal },
      real,
    );
    for await (const event of stream) yield event as never;
  }
  override withConfig(config: Parameters<ChatOpenAI['withConfig']>[0]) {
    const next = new BridgedChatOpenAI(this.fields ?? {}, this.#bus);
    next.defaultOptions = { ...this.defaultOptions, ...config };
    return next as never;
  }
}

function bridgeModel(base: ChatOpenAI, bus: Bus): ChatOpenAI {
  const next = new BridgedChatOpenAI(base.fields ?? {}, bus);
  next.defaultOptions = { ...base.defaultOptions };
  return next;
}

// ───────────────────────────── 跑一輪 ─────────────────────────────

interface RunOptions {
  readonly script: readonly Act[];
  readonly bus?: Bus;
  /** `A`：wrapModelCall 橋接；`B`：model 裝飾；省略＝基準。 */
  readonly bridge?: 'A' | 'B';
  readonly position?: 'prepend' | 'rest';
  readonly bridgeOptions?: BridgeOptions;
  readonly streamRetry?: { maxRetries: number; baseDelayMs: number };
  readonly sdkRetries?: number;
  readonly timeoutMs?: number;
  readonly idleMs?: number;
  readonly during?: (pump: ThreadPump) => Promise<void>;
  /** 第一句收完再送一句：量第二次請求帶出去的歷史。 */
  readonly second?: boolean;
}

const allRuns: { label: string; run: Awaited<ReturnType<typeof runTurn>> }[] = [];

async function runTurn(options: RunOptions) {
  const upstream = await scriptedOpenAi(options.script);
  const bus = options.bus ?? new Bus();
  const base = createLiveModel(
    liveModelConfigSchema.parse({
      baseUrl: upstream.baseUrl,
      timeoutMs: options.timeoutMs ?? 400,
      streamIdleTimeoutMs: options.idleMs ?? 400,
      maxRetries: options.sdkRetries ?? 0,
    }),
  );
  const model = options.bridge === 'B' ? bridgeModel(base, bus) : base;
  const plugins =
    options.bridge === 'A'
      ? [
          {
            plugin: {
              name: 'bridge-a-1341',
              apply: (registry: { middleware: { use: (m: never, o?: object) => unknown } }) =>
                void registry.middleware.use(
                  bridgeA(bus, options.bridgeOptions) as never,
                  options.position === 'prepend' ? { prepend: true } : {},
                ),
            },
          },
        ]
      : [];
  const built = await createNexusAgent({
    model,
    checkpointer: new MemorySaver(),
    plugins: plugins as never,
    ...(options.streamRetry !== undefined && { streamRetry: options.streamRetry }),
  });
  const pump = new ThreadPump(built.agent as PumpAgent, 'bridge-1341');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const draining = (async () => {
    for await (const frame of pump.subscribe(['messages', 'lifecycle', 'custom'], line.signal))
      frames.push(frame);
  })();
  try {
    const turn = pump
      .submit({ kind: 'message', text: '說點什麼' })
      .then(() =>
        options.second === true ? pump.submit({ kind: 'message', text: '再說一次' }) : undefined,
      )
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    const [thrown] = await Promise.all([turn, options.during?.(pump)]);
    const result = {
      thrown,
      frames,
      events: pump.sessions.root.events,
      hits: upstream.hits(),
      bodies: upstream.bodies,
    };
    allRuns.push({
      label: `${options.bridge ?? 'base'}/${options.position ?? '-'}/${options.script.join(',')}${options.streamRetry === undefined ? '' : '/sr'}`,
      run: result,
    });
    return result;
  } finally {
    line.abort();
    await draining;
    detach();
    await upstream.close();
  }
}

type Run = Awaited<ReturnType<typeof runTurn>>;

/** 配對與識別：`model/end`、`model/usage`、`assistant/message` 的 `modelCall` 是否都指向某顆 `model/start` 的 `seq`。 */
function pairing(run: Run) {
  const starts = run.events.filter((event) => event.type === 'model/start');
  const seqs = new Set(starts.map((event) => event.seq));
  const ref = (type: string) =>
    run.events
      .filter((event) => event.type === type)
      .map((event) => (event.data as { modelCall?: number }).modelCall);
  const ends = ref('model/end');
  const usage = ref('model/usage');
  const replies = ref('assistant/message');
  const attempts = ref('assistant/attempt');
  const dangling = (refs: (number | undefined)[]) =>
    refs.filter((value) => value === undefined || !seqs.has(value)).length;
  return {
    starts: starts.length,
    ends: ends.length,
    usage: usage.length,
    replies: replies.length,
    attempts: attempts.length,
    dangling: {
      ends: dangling(ends),
      usage: dangling(usage),
      replies: dangling(replies),
      attempts: dangling(attempts),
    },
  };
}

function replies(frames: readonly Event[]): string[] {
  let state = emptyConversation();
  for (const frame of frames) state = reduceConversation(state, frame);
  return state.entries
    .filter((entry): entry is AiEntry => entry.kind === 'ai')
    .map(
      (entry) =>
        JSON.stringify(entry)
          .match(/[甲乙丙丁先說一句罐頭回覆變形<>]+/g)
          ?.join('') ?? '',
    );
}

/** 日誌上與模型呼叫有關的事件，依序，附上我們關心的欄位。 */
function modelLog(run: Run): string[] {
  const interesting = new Set([
    'model/start',
    'model/end',
    'model/usage',
    'assistant/message',
    'assistant/attempt',
    'llm/retry',
    'llm/retry-started',
    'turn/failed',
    'turn/end',
  ]);
  return run.events
    .filter((event) => interesting.has(event.type))
    .map((event) => {
      const data = event.data as Record<string, unknown>;
      if (event.type === 'model/end') return `model/end(${String(data['outcome'] ?? 'ok')})`;
      if (event.type === 'turn/end') {
        return `turn/end(${JSON.stringify((data as { reason?: unknown }).reason)})`;
      }
      return event.type;
    });
}

function methodCounts(run: Run): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const frame of run.frames) {
    const data = frame.params?.data as { event?: string } | undefined;
    const key = `${frame.method}${data?.event === undefined ? '' : `:${data.event}`}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function assistantTexts(run: Run): string[] {
  return run.events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => {
      const message = (event.data as SessionEventMap['assistant/message']).message as unknown;
      const joined =
        JSON.stringify(message)
          .match(/[甲乙丙丁先說一句罐頭回覆變形<>]+/g)
          ?.join('') ?? '';
      const half = joined.length / 2;
      return joined.length % 2 === 0 && joined.slice(0, half) === joined.slice(half)
        ? joined.slice(0, half)
        : joined;
    });
}

describe('#1341 橋接語意落差（拋棄式原型）', () => {
  const original = process.env[LIVE_API_KEY_ENV];
  beforeEach(() => {
    process.env[LIVE_API_KEY_ENV] = 'nvapi-test-value-not-a-real-key';
  });
  afterEach(() => {
    if (original === undefined) delete process.env[LIVE_API_KEY_ENV];
    else process.env[LIVE_API_KEY_ENV] = original;
  });

  it('P0／P1 基準與穿透橋接：事件與串流是否變形', async () => {
    const base = await runTurn({ script: ['ok'] });
    const a = await runTurn({ script: ['ok'], bridge: 'A', position: 'rest' });
    const b = await runTurn({ script: ['ok'], bridge: 'B' });
    record('P0_baseline', {
      log: modelLog(base),
      frames: methodCounts(base),
      shown: replies(base.frames),
      logged: assistantTexts(base),
    });
    record('P1_passthrough_A', {
      log: modelLog(a),
      frames: methodCounts(a),
      shown: replies(a.frames),
      logged: assistantTexts(a),
    });
    record('P1_passthrough_B', {
      entryCounters: { ...entry },
      sampleEvents: captured.slice(0, 14),
      log: modelLog(b),
      frames: methodCounts(b),
      shown: replies(b.frames),
      logged: assistantTexts(b),
    });
    expect(base.hits).toBe(1);
  }, 60_000);

  it('P3 短路（不呼叫 next、自己給回覆）：A 在兩個位置、B', async () => {
    const canned = (): Bus => {
      const bus = new Bus();
      bus.on('llm/stream', (() =>
        (async function* () {
          yield {
            type: 'message',
            message: new AIMessage({ content: '罐頭回覆' }),
          } satisfies WholeMessageChunk;
        })()) as AnyFn);
      return bus;
    };
    const rest = await runTurn({ script: ['ok'], bridge: 'A', position: 'rest', bus: canned() });
    const prepend = await runTurn({
      script: ['ok'],
      bridge: 'A',
      position: 'prepend',
      bus: canned(),
    });
    record('P3_shortcircuit_A_rest', {
      hits: rest.hits,
      log: modelLog(rest),
      frames: methodCounts(rest),
      thrown: String(rest.thrown ?? ''),
    });
    record('P3_shortcircuit_A_prepend', {
      hits: prepend.hits,
      log: modelLog(prepend),
      frames: methodCounts(prepend),
      thrown: String(prepend.thrown ?? ''),
    });
    // B：自己產事件，不呼叫 next。事件來自上一個實驗真的吐過的那一串，換掉字。
    if (captured.length === 0) await runTurn({ script: ['ok'], bridge: 'B' });
    const swap: Record<string, string> = { 甲: '罐', 乙: '頭', 丙: '回', 丁: '覆' };
    const replay = captured.slice(0, 10).map((raw) => {
      const event = JSON.parse(JSON.stringify(raw)) as Record<string, any>;
      if (event['event'] === 'content-block-delta') {
        event['delta'].text = swap[event['delta'].text as string] ?? event['delta'].text;
      }
      if (event['event'] === 'content-block-finish') event['content'].text = '罐頭回覆';
      return event;
    });
    const busB = new Bus();
    busB.on('llm/stream', (() =>
      (async function* () {
        for (const event of replay) yield event;
      })()) as AnyFn);
    const b = await runTurn({ script: ['ok'], bridge: 'B', bus: busB });
    record('P3_shortcircuit_B', {
      hits: b.hits,
      log: modelLog(b),
      frames: methodCounts(b),
      thrown: String(b.thrown ?? ''),
      shown: replies(b.frames),
      logged: assistantTexts(b),
    });
    expect(true).toBe(true);
  }, 60_000);

  it('P4 變形（把回覆字都轉成大寫標記）：A 的畫面與日誌是否分叉，B 是否一致', async () => {
    const busA = new Bus();
    busA.on('llm/stream', ((_payload: unknown, next: () => AsyncIterable<WholeMessageChunk>) =>
      (async function* () {
        for await (const part of next()) {
          yield {
            type: 'message',
            message: new AIMessage({
              content: 'A變形',
              id: part.message.id as string,
              response_metadata: part.message.response_metadata,
              usage_metadata: part.message.usage_metadata,
            }),
          } satisfies WholeMessageChunk;
        }
      })()) as AnyFn);
    const a = await runTurn({ script: ['ok'], bridge: 'A', position: 'rest', bus: busA });
    record('P4_transform_A', {
      shown: replies(a.frames),
      logged: assistantTexts(a),
      frames: methodCounts(a),
    });
    const busB = new Bus();
    busB.on('llm/stream', ((_payload: unknown, next: () => AsyncIterable<unknown>) =>
      (async function* () {
        let acc = '';
        for await (const raw of next()) {
          const event = JSON.parse(JSON.stringify(raw)) as Record<string, any>;
          if (event['event'] === 'content-block-delta') {
            event['delta'].text = `<${event['delta'].text as string}>`;
            acc += event['delta'].text as string;
          }
          if (event['event'] === 'content-block-finish') event['content'].text = acc;
          yield event;
        }
      })()) as AnyFn);
    const b = await runTurn({ script: ['ok'], bridge: 'B', bus: busB });
    record('P4_transform_B', {
      shown: replies(b.frames),
      logged: assistantTexts(b),
      frames: methodCounts(b),
      thrown: String(b.thrown ?? ''),
      hits: b.hits,
    });
    expect(true).toBe(true);
  }, 60_000);

  it('P5 重試層疊：全部 http503 時一共打幾次；request-error 的 retry 與 SDK／stream-retry 相乘', async () => {
    const mkBus = (limit: number): Bus => {
      const bus = new Bus();
      let used = 0;
      bus.on('agent/request-error', (async (_payload: unknown, next: () => unknown) => {
        if (used < limit) {
          used += 1;
          return { kind: 'retry' };
        }
        return next();
      }) as AnyFn);
      return bus;
    };
    const sdkOnly = await runTurn({
      script: Array<Act>(40).fill('http503'),
      sdkRetries: 2,
      timeoutMs: 2000,
    });
    record('P5_sdk_only', { hits: sdkOnly.hits, thrown: String(sdkOnly.thrown ?? '') });
    const bridged = await runTurn({
      script: Array<Act>(40).fill('http503'),
      sdkRetries: 2,
      timeoutMs: 2000,
      bridge: 'A',
      position: 'rest',
      bus: mkBus(2),
    });
    record('P5_sdk_x_request_error_retry2', {
      hits: bridged.hits,
      thrown: String(bridged.thrown ?? ''),
      log: modelLog(bridged),
    });
    expect(true).toBe(true);
  }, 120_000);

  it('P5b 串流中段 503：橋接內側自己重試 vs stream-retry；畫面是否留下半段', async () => {
    const bus = new Bus();
    let used = 0;
    bus.on('agent/request-error', (async (_payload: unknown, next: () => unknown) => {
      if (used < 1) {
        used += 1;
        return { kind: 'retry' };
      }
      return next();
    }) as AnyFn);
    const bridgeOnly = await runTurn({
      script: ['mid503', 'ok'],
      bridge: 'A',
      position: 'rest',
      bus,
    });
    record('P5b_bridge_retry_inside_streamretry_absent', {
      hits: bridgeOnly.hits,
      log: modelLog(bridgeOnly),
      shown: replies(bridgeOnly.frames),
      logged: assistantTexts(bridgeOnly),
      thrown: String(bridgeOnly.thrown ?? ''),
    });
    used = 0;
    const both = await runTurn({
      script: ['mid503', 'ok'],
      bridge: 'A',
      position: 'rest',
      bus,
      streamRetry: { maxRetries: 2, baseDelayMs: 20 },
    });
    record('P5b_bridge_retry_with_streamretry', {
      hits: both.hits,
      log: modelLog(both),
      shown: replies(both.frames),
      logged: assistantTexts(both),
      thrown: String(both.thrown ?? ''),
    });
    const streamRetryOnly = await runTurn({
      script: ['mid503', 'ok'],
      streamRetry: { maxRetries: 2, baseDelayMs: 20 },
    });
    record('P5b_streamretry_only_baseline', {
      hits: streamRetryOnly.hits,
      log: modelLog(streamRetryOnly),
      shown: replies(streamRetryOnly.frames),
      logged: assistantTexts(streamRetryOnly),
    });
    expect(true).toBe(true);
  }, 60_000);

  it('P6 中止：穿透橋接在串流中按停止，配對與收尾是否變形', async () => {
    const stopMidStream = async (pump: ThreadPump): Promise<void> => {
      for (let waited = 0; waited < 5000; waited += 20) {
        if (pump.sessions.root.events.some((event) => event.type === 'model/start')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      pump.cancel();
    };
    const base = await runTurn({ script: ['slow'], during: stopMidStream });
    const a = await runTurn({
      script: ['slow'],
      bridge: 'A',
      position: 'rest',
      during: stopMidStream,
    });
    const aSeen: string[] = [];
    const busWatch = new Bus();
    busWatch.on('agent/request-error', (async (
      payload: { error: unknown; signal?: AbortSignal },
      next: () => unknown,
    ) => {
      aSeen.push(
        `aborted=${String(payload.signal?.aborted)} err=${String((payload.error as Error)?.name)}`,
      );
      return next();
    }) as unknown as AnyFn);
    const aWatched = await runTurn({
      script: ['slow'],
      bridge: 'A',
      position: 'rest',
      bus: busWatch,
      during: stopMidStream,
    });
    record('P6_abort', {
      baseline: { log: modelLog(base), hits: base.hits },
      bridgeA: { log: modelLog(a), hits: a.hits },
      bridgeA_requestErrorListenerSaw: { calls: aSeen, log: modelLog(aWatched) },
    });
    expect(true).toBe(true);
  }, 60_000);

  it('P7 逾時：首事件前掛住（SDK timeout）與吐了字之後停住（idle）各自的分類', async () => {
    const seen: unknown[] = [];
    const mk = (): Bus => {
      const bus = new Bus();
      bus.on('agent/request-error', (async (
        payload: { error: unknown; failure: unknown },
        next: () => unknown,
      ) => {
        const error = payload.error as Error & { cause?: unknown };
        seen.push({
          name: error.name,
          causeName: (error.cause as Error | undefined)?.name,
          failure: payload.failure,
        });
        return next();
      }) as unknown as AnyFn);
      return bus;
    };
    const hang = await runTurn({
      script: ['hang'],
      bridge: 'A',
      position: 'rest',
      bus: mk(),
      timeoutMs: 300,
    });
    const stall = await runTurn({
      script: ['stall'],
      bridge: 'A',
      position: 'rest',
      bus: mk(),
      idleMs: 300,
      timeoutMs: 5000,
    });
    record('P7_timeouts', { seen, hangLog: modelLog(hang), stallLog: modelLog(stall) });
    expect(true).toBe(true);
  }, 60_000);

  it('P8 max-tokens：橋接在 maxTokens 外側看到的回覆是原始的還是清過的', async () => {
    const seenByListener: unknown[] = [];
    const bus = new Bus();
    bus.on('llm/stream', ((_payload: unknown, next: () => AsyncIterable<WholeMessageChunk>) =>
      (async function* () {
        for await (const part of next()) {
          seenByListener.push({
            toolCalls: part.message.tool_calls?.length ?? 0,
            invalid: part.message.invalid_tool_calls?.length ?? 0,
            finish: (part.message.response_metadata as { finish_reason?: string }).finish_reason,
          });
          yield part;
        }
      })()) as AnyFn);
    const run = await runTurn({ script: ['length'], bridge: 'A', position: 'rest', bus });
    record('P8_max_tokens', {
      listenerSaw: seenByListener,
      log: modelLog(run),
      logged: assistantTexts(run),
      toolCallEvents: run.events.filter((event) => event.type === 'tool/call').length,
    });
    expect(true).toBe(true);
  }, 60_000);

  it('P5c B 層自己重打：listener 抓到串流中的錯誤、再叫一次 next()', async () => {
    const bus = new Bus();
    bus.on('llm/stream', ((_payload: unknown, next: () => AsyncIterable<unknown>) =>
      (async function* () {
        let first = true;
        for (;;) {
          try {
            for await (const event of next()) yield event;
            return;
          } catch (error) {
            if (!first) throw error;
            first = false;
          }
        }
      })()) as AnyFn);
    const run = await runTurn({ script: ['mid503', 'ok'], bridge: 'B', bus });
    record('P5c_B_retry_inside_llm_stream', {
      hits: run.hits,
      log: modelLog(run),
      shown: replies(run.frames),
      logged: assistantTexts(run),
      thrown: String(run.thrown ?? ''),
    });
    expect(true).toBe(true);
  }, 60_000);

  it('P5d A 排在 stream-retry／起訖外面（prepend）時的 request-error retry', async () => {
    const mk = (limit: number): Bus => {
      const bus = new Bus();
      let used = 0;
      bus.on('agent/request-error', (async (_payload: unknown, next: () => unknown) => {
        if (used < limit) {
          used += 1;
          return { kind: 'retry' };
        }
        return next();
      }) as AnyFn);
      return bus;
    };
    const noSr = await runTurn({
      script: ['mid503', 'ok'],
      bridge: 'A',
      position: 'prepend',
      bus: mk(1),
    });
    record('P5d_outer_bridge_retry_no_streamretry', {
      hits: noSr.hits,
      log: modelLog(noSr),
      shown: replies(noSr.frames),
      logged: assistantTexts(noSr),
      thrown: String(noSr.thrown ?? ''),
    });
    const withSr = await runTurn({
      script: ['mid503', 'mid503', 'mid503', 'ok'],
      bridge: 'A',
      position: 'prepend',
      bus: mk(1),
      streamRetry: { maxRetries: 2, baseDelayMs: 20 },
    });
    record('P5d_outer_bridge_retry_with_streamretry', {
      hits: withSr.hits,
      log: modelLog(withSr),
      shown: replies(withSr.frames),
      logged: assistantTexts(withSr),
      thrown: String(withSr.thrown ?? ''),
    });
    expect(true).toBe(true);
  }, 60_000);

  it('P6b／P8b B 層：中止時的配對、max-tokens 時 listener 看到的事件', async () => {
    const stopMidStream = async (pump: ThreadPump): Promise<void> => {
      for (let waited = 0; waited < 5000; waited += 20) {
        if (pump.sessions.root.events.some((event) => event.type === 'model/start')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      pump.cancel();
    };
    const closed: string[] = [];
    const watch = new Bus();
    watch.on('llm/stream', ((_p: unknown, next: () => AsyncIterable<unknown>) =>
      (async function* () {
        try {
          for await (const event of next()) yield event;
          closed.push('completed');
        } finally {
          closed.push('finally');
        }
      })()) as AnyFn);
    const aborted = await runTurn({
      script: ['slow'],
      bridge: 'B',
      bus: watch,
      during: stopMidStream,
    });
    record('P6b_abort_B', { log: modelLog(aborted), listenerSaw: closed, hits: aborted.hits });

    const seen: unknown[] = [];
    const tap = new Bus();
    tap.on('llm/stream', ((_p: unknown, next: () => AsyncIterable<Record<string, any>>) =>
      (async function* () {
        for await (const event of next()) {
          seen.push(
            event['event'] === 'message-finish'
              ? { event: 'message-finish', reason: event['reason'] }
              : event['event'] === 'content-block-start'
                ? { event: 'content-block-start', type: event['content']?.type }
                : event['event'],
          );
          yield event;
        }
      })()) as AnyFn);
    const length = await runTurn({ script: ['length'], bridge: 'B', bus: tap });
    record('P8b_max_tokens_B', {
      listenerSaw: seen,
      log: modelLog(length),
      toolCallEvents: length.events.filter((event) => event.type === 'tool/call').length,
    });
    expect(true).toBe(true);
  }, 60_000);

  it('P11 第二句帶出去的歷史對日誌：模型看得到的有沒有記下來', async () => {
    const once = (make: () => AnyFn): Bus => {
      const bus = new Bus();
      let calls = 0;
      const impl = make();
      bus.on('llm/stream', ((payload: never, next: () => unknown) => {
        calls += 1;
        return calls === 1 ? impl(payload, next) : next();
      }) as AnyFn);
      return bus;
    };
    const canned = (): AnyFn =>
      (() =>
        (async function* () {
          yield {
            type: 'message',
            message: new AIMessage({ content: '罐頭回覆' }),
          } satisfies WholeMessageChunk;
        })()) as AnyFn;
    const transformed = (): AnyFn =>
      ((_p: unknown, next: () => AsyncIterable<WholeMessageChunk>) =>
        (async function* () {
          for await (const part of next()) {
            yield {
              type: 'message',
              message: new AIMessage({
                content: '變形',
                id: part.message.id as string,
                response_metadata: part.message.response_metadata,
                usage_metadata: part.message.usage_metadata,
              }),
            } satisfies WholeMessageChunk;
          }
        })()) as AnyFn;
    const wire = (run: Run): string[] => {
      const last = run.bodies[run.bodies.length - 1] as
        { messages?: { role: string; content: unknown }[] } | undefined;
      return (last?.messages ?? [])
        .filter((message) => message.role === 'assistant')
        .map((message) => JSON.stringify(message.content).replace(/[^甲乙丙丁罐頭回覆變形]/g, ''));
    };
    const rows: Record<string, unknown> = {};
    const cases: [string, RunOptions][] = [
      ['baseline', { script: ['ok', 'ok'], second: true }],
      [
        'A_rest_shortcircuit_first',
        { script: ['ok', 'ok'], bridge: 'A', position: 'rest', bus: once(canned), second: true },
      ],
      [
        'A_prepend_shortcircuit_first',
        { script: ['ok', 'ok'], bridge: 'A', position: 'prepend', bus: once(canned), second: true },
      ],
      [
        'A_rest_transform_first',
        {
          script: ['ok', 'ok'],
          bridge: 'A',
          position: 'rest',
          bus: once(transformed),
          second: true,
        },
      ],
    ];
    for (const [name, options] of cases) {
      const run = await runTurn(options);
      rows[name] = {
        hits: run.hits,
        log: modelLog(run),
        loggedAssistant: assistantTexts(run),
        wireAssistantInLastRequest: wire(run),
        shown: replies(run.frames),
      };
    }
    record('P11_second_turn_history', rows);
    expect(true).toBe(true);
  }, 120_000);

  it('P6c 中止時 request-error 有沒有被派（先檢查中止 vs 第一版沒檢查）', async () => {
    const stopMidStream = async (pump: ThreadPump): Promise<void> => {
      for (let waited = 0; waited < 5000; waited += 20) {
        if (pump.sessions.root.events.some((event) => event.type === 'model/start')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      pump.cancel();
    };
    const out: Record<string, unknown> = {};
    for (const checkAbort of [true, false]) {
      const calls: string[] = [];
      const bus = new Bus();
      bus.on('agent/request-error', (async (_p: unknown, next: () => unknown) => {
        calls.push('dispatched');
        return next();
      }) as AnyFn);
      const run = await runTurn({
        script: ['slow'],
        bridge: 'A',
        position: 'rest',
        bus,
        bridgeOptions: { checkAbort },
        during: stopMidStream,
      });
      out[`checkAbort_${String(checkAbort)}`] = { dispatched: calls.length, log: modelLog(run) };
    }
    record('P6c_abort_request_error_dispatch', out);
    expect(true).toBe(true);
  }, 60_000);

  it('P9 非串流入口：agent.invoke 時 B 的哪個入口被走到、線上請求有沒有 stream', async () => {
    const upstream = await scriptedOpenAi(['ok']);
    try {
      const base = createLiveModel(
        liveModelConfigSchema.parse({ baseUrl: upstream.baseUrl, timeoutMs: 2000, maxRetries: 0 }),
      );
      entry.generate = 0;
      entry.events = 0;
      entry.chunks = 0;
      const built = await createNexusAgent({
        model: bridgeModel(base, new Bus()),
        checkpointer: new MemorySaver(),
        plugins: [],
      });
      const out = (await (
        built.agent as unknown as {
          invoke: (input: unknown, config: unknown) => Promise<{ messages: unknown[] }>;
        }
      ).invoke(
        { messages: [{ role: 'user', content: '說點什麼' }] },
        { configurable: { thread_id: 'p9' } },
      )) as { messages: unknown[] };
      record('P9_invoke_entry', {
        entry: { ...entry },
        wireStream: upstream.bodies[0]?.['stream'],
        replied: out.messages.length,
      });
    } finally {
      await upstream.close();
    }
    expect(true).toBe(true);
  }, 60_000);

  it('P10 agent/request：modelSettings 能帶到線上的有哪幾個鍵', async () => {
    const sets: Record<string, unknown>[] = [
      { max_tokens: 123 },
      { maxTokens: 123 },
      { max_completion_tokens: 123 },
      { reasoning_effort: 'low' },
      { reasoning: { effort: 'low' } },
      { stop: ['END'] },
      { verbosity: 'low' },
      { temperature: 0.25 },
      { seed: 7 },
    ];
    const rows: unknown[] = [];
    for (const settings of sets) {
      const bus = new Bus();
      bus.on('agent/request', (async () => ({ modelSettings: settings })) as AnyFn);
      const run = await runTurn({
        script: ['ok'],
        bridge: 'A',
        position: 'rest',
        bus,
        bridgeOptions: { applyConfig: true },
      });
      const body = run.bodies[0] ?? {};
      rows.push({
        settings,
        wire: {
          max_tokens: body['max_tokens'],
          max_completion_tokens: body['max_completion_tokens'],
          temperature: body['temperature'],
          reasoning_effort: body['reasoning_effort'],
          stop: body['stop'],
          verbosity: body['verbosity'],
          seed: body['seed'],
        },
      });
    }
    record('P10_agent_request_config', rows);
    expect(true).toBe(true);
  }, 120_000);

  it('Z 配對與識別總表', () => {
    record(
      'Z_pairing',
      allRuns.map(({ label, run }) => ({ label, ...pairing(run) })),
    );
    expect(true).toBe(true);
  });
});
```
