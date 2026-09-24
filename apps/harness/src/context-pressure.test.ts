/**
 * **用量表的資料**——[#528](https://github.com/DemianLi/nexus-agent/issues/528) 的 harness 那一半。
 *
 * 兩件事，各一組：
 *
 * 1. **分子跟摘要判準同源**，用門檻夾擠驗，不是驗「有值」：同一段對話先量出第二次呼叫的 `approxTokens = A`，
 *    再各跑一次門檻 `A` 與 `A + 1`。基座在 `A` 摘要、在 `A + 1` 不摘要，才證明我們記的就是它拿去比門檻的那個數
 *    ——少算 system、少算工具，翻轉點就不在 `A`。`messages` 那道同法再夾一次。另外驗摘要的那一次記下的數字當場
 *    掉下來：量的是交下去的那份，不是進來的那份。
 * 2. **即時與重新整理拿到同一份**，只算 root：真的 `ChatOpenAI` **串流**（serve 那條路）對本機假端點，最後一顆
 *    chunk 帶 usage，所以 `model/usage` 也走的是產品那條。有一個子代理的呼叫，它的數字不能上線；最後一輪在第一次
 *    模型呼叫就失敗，歷史那一頁自己沒有用量表的事件，要從切點之前補。
 *
 * **零憑證**：對手方是本機的假端點。每次回應的 id 都不一樣——同 id 的 AI 訊息會被 reducer 取代。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import type { PluginEntry, SessionEvent, SessionEventMap } from '@nexus/core';
import type { Event, WireContextPressure } from '@nexus/wire';
import { CONTEXT_MEASURE, MODEL_USAGE, emptyConversation, reduceAll } from '@nexus/wire';
import { describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import type { CreateNexusAgentOptions } from './agent-factory.js';
import { historyPage } from './conversation-history.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 一次請求怎麼回：正文、或一顆工具呼叫、或整個請求失敗。 */
type Reply =
  | { readonly text: string }
  | { readonly call: { readonly name: string; readonly args: Record<string, unknown> } }
  | { readonly status: number };

/**
 * 本機的 OpenAI 相容端點。串流與非串流都接（摘要那一次模型呼叫不一定串流）。**每一次的 `prompt_tokens` 都不同**
 * （`1000 + 第幾次`），所以上線的是哪一次呼叫的用量，一眼分得出來。
 *
 * `sized` 換成**跟 body 大小成正比**的數（一個字元一個，中文大約就是這個密度）：門檻比的是錨在實數上的估算（#588），實數跟內容
 * 無關的話，第二次呼叫會錨在一個比第一次的純估算還小的數上，夾擠的前提不成立。
 *
 * @param script - 第幾次請求回什麼；超出的一律回「ok」。
 * @param sized - `prompt_tokens` 跟著 body 大小走。
 */
async function fakeOpenAi(script: readonly Reply[] = [], sized = false) {
  let requests = 0;
  /** 每一次請求是不是串流、有沒有帶工具——摘要那一次沒有工具。 */
  const seen: { readonly stream: boolean; readonly tools: boolean }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const index = requests;
      requests += 1;
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = JSON.parse(raw) as {
        stream?: boolean;
        tools?: unknown;
      };
      seen.push({ stream: body.stream === true, tools: Array.isArray(body.tools) });
      const reply = script[index] ?? { text: 'ok' };
      if ('status' in reply) {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: '假端點掛了', type: 'server_error' } }));
        return;
      }
      const usage = {
        prompt_tokens: sized ? raw.length : 1000 + index,
        completion_tokens: 1,
        total_tokens: (sized ? raw.length : 1000 + index) + 1,
      };
      const toolCalls =
        'call' in reply
          ? [
              {
                index: 0,
                id: `call-${index}`,
                type: 'function',
                function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) },
              },
            ]
          : undefined;
      const finish = toolCalls === undefined ? 'stop' : 'tool_calls';
      const id = `chatcmpl-${index}`;
      if (body.stream !== true) {
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
                message: {
                  role: 'assistant',
                  content: 'text' in reply ? reply.text : '',
                  ...(toolCalls && { tool_calls: toolCalls.map(({ index: _, ...call }) => call) }),
                },
                finish_reason: finish,
              },
            ],
            usage,
          }),
        );
        return;
      }
      const chunk = (extra: Record<string, unknown>) =>
        `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 0, model: 'fake', ...extra })}\n\n`;
      const delta = (value: Record<string, unknown>, reason: string | null = null) =>
        chunk({ choices: [{ index: 0, delta: value, finish_reason: reason }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(delta({ role: 'assistant', content: '' }));
      res.write(delta('text' in reply ? { content: reply.text } : { tool_calls: toolCalls }));
      res.write(delta({}, finish));
      // `stream_options.include_usage` 的那一顆：`choices` 是空的，只帶 usage。
      res.write(chunk({ choices: [], usage }));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

async function until(predicate: () => boolean, ms = 15000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * 經 pump 講幾輪，一輪收工再送下一輪。
 *
 * @returns 即時的每一顆 frame、root 那一份日誌，與每一份日誌的位址。
 */
async function converse(
  texts: readonly string[],
  options: {
    readonly script?: readonly Reply[];
    readonly plugins?: PluginEntry[];
    readonly summarization?: CreateNexusAgentOptions['summarization'];
    readonly sized?: boolean;
  } = {},
) {
  const upstream = await fakeOpenAi(options.script, options.sized);
  const built = await createNexusAgent({
    model: new ChatOpenAI({
      model: 'fake',
      apiKey: 'sk-loopback',
      maxRetries: 0,
      configuration: { baseURL: upstream.baseURL },
    }),
    checkpointer: new MemorySaver(),
    // 產品的組裝點（`cli.ts`，serve 也走它）一定給 system prompt；不給的話摘要器那一層的 `systemMessage` 是空的，
    // 「算不算 system」量不出差別（量過：長度 0）。
    systemPrompt: SYSTEM_PROMPT,
    plugins: options.plugins ?? [],
    ...(options.summarization !== undefined && { summarization: options.summarization }),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'pressure');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const failures: unknown[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle', 'custom'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  try {
    for (const [index, text] of texts.entries()) {
      // 一輪失敗時 `submit` 會 reject；收起來，由案例自己斷言。
      await pump.submit({ kind: 'message', text }).catch((error: unknown) => failures.push(error));
      await until(() => frames.filter(isRootDone).length > index);
    }
    // 日誌訂閱者合成的 frame 跟 root 收工那一顆不在同一個 tick；讓尾巴的都進來。
    await new Promise((resolve) => setImmediate(resolve));
    return {
      frames,
      failures,
      requests: upstream.seen,
      root: pump.sessionLog.events,
      subagents: pump.sessions
        .list()
        .filter((entry) => entry.address.kind === 'subagent')
        .flatMap((entry) => entry.log.events),
    };
  } finally {
    line.abort();
    await draining;
    detach();
    await built.dispose();
    await upstream.close();
  }
}

function eventsOf<T extends keyof SessionEventMap>(
  events: readonly SessionEvent[],
  type: T,
): SessionEventMap[T][] {
  return events
    .filter((event) => event.type === type)
    .map((event) => event.data as SessionEventMap[T]);
}

const pressureOf = (frames: readonly Event[]): WireContextPressure | null =>
  reduceAll(emptyConversation(), frames).contextPressure;

/** 夠長，少算它的話翻轉點會差上百個 token。 */
const SYSTEM_PROMPT = '你是測試用的助手，照腳本回答。'.repeat(60);

/** 門檻遠到碰不到：量一段不會被摘要的對話用。 */
const NEVER = 1_000_000_000;

/** 第一句夠長，摘要掉它之後數字才會明顯掉下來（摘要本身只有「ok」加上基座的一句前言）。 */
const TURNS = ['很長的第一句。'.repeat(500), '第二句。'] as const;

function summarizeAt(trigger: { type: 'tokens' | 'messages'; value: number }[]) {
  // `keep` 留一則：第二次呼叫時訊息串是 [人, 模型, 人]，切點落在 2，前兩則被摘要掉。
  return { trigger, keep: { type: 'messages' as const, value: 1 } };
}

describe('分子跟摘要判準同源：門檻夾擠', () => {
  it('tokens 與 messages 兩道都在量到的那個數上翻轉，摘要那次記下的數字當場掉下來', async () => {
    const baseline = await converse(TURNS, {
      sized: true,
      summarization: summarizeAt([
        { type: 'tokens', value: NEVER },
        { type: 'messages', value: NEVER },
      ]),
    });
    const measured = eventsOf(baseline.root, 'context/measure');
    // 前提：一次呼叫一筆，而且帶的是那次生效的門檻。
    expect(measured).toHaveLength(2);
    expect(measured[1]!.thresholds).toEqual([
      { type: 'tokens', value: NEVER },
      { type: 'messages', value: NEVER },
    ]);
    const { approxTokens: A, messageCount: M } = measured[1]!;
    expect(M).toBe(3);
    // 前提：同一段對話量兩次是同一個數，夾擠才有意義。
    const again = eventsOf(
      (
        await converse(TURNS, {
          sized: true,
          summarization: summarizeAt([{ type: 'tokens', value: NEVER }]),
        })
      ).root,
      'context/measure',
    );
    expect(again[1]!.approxTokens).toBe(A);
    // 前提：第一次呼叫比第二次小，門檻設在 A 不會在第一次就翻。
    expect(measured[0]!.approxTokens).toBeLessThan(A);

    const run = async (trigger: { type: 'tokens' | 'messages'; value: number }) => {
      const { root } = await converse(TURNS, {
        sized: true,
        summarization: summarizeAt([trigger]),
      });
      return {
        summarized: eventsOf(root, 'compaction/summary').length,
        second: eventsOf(root, 'context/measure')[1]!,
      };
    };

    const atA = await run({ type: 'tokens', value: A });
    const aboveA = await run({ type: 'tokens', value: A + 1 });
    expect(atA.summarized).toBe(1);
    expect(aboveA.summarized).toBe(0);
    expect(aboveA.second).toMatchObject({ approxTokens: A, messageCount: M });
    // 摘要那一次：量的是交下去的 [摘要, 第二句]，不是進來的那三則。第一句是 3500 字的中文，換成的摘要只有十幾個
    // token；system 與工具定義那幾千個照舊在，所以掉的是那一截，不是掉到零。
    expect(atA.second.messageCount).toBe(2);
    expect(atA.second.approxTokens).toBeLessThan(A - 500);

    expect((await run({ type: 'messages', value: M })).summarized).toBe(1);
    expect((await run({ type: 'messages', value: M + 1 })).summarized).toBe(0);
  }, 60000);

  it('摘要關掉就不記', async () => {
    const { root, frames } = await converse(['一句。'], { summarization: false });
    expect(eventsOf(root, 'context/measure')).toEqual([]);
    // `model/usage` 照樣上線：web 要畫的條件是 `measure` 在，不是 `contextPressure` 不是 null。
    expect(pressureOf(frames)).toEqual({ inputTokens: 1000 });
  }, 30000);
});

describe('即時與重新整理拿到同一份，只算 root', () => {
  const WORKER: PluginEntry = {
    plugin: {
      name: 'worker-source',
      apply(registry) {
        registry.subagents.register({ name: 'worker', description: '幹活的。' });
      },
    },
  };

  it('串流的用量上線、子代理的不上線；最後一輪在第一次呼叫就失敗，歷史從切點之前補', async () => {
    const outcome = await converse(['委派一下。', '再來。'], {
      plugins: [WORKER],
      script: [
        { call: { name: 'task', args: { description: '做事', subagent_type: 'worker' } } },
        { text: '子代理做完了。' },
        { text: '根收工。' },
        { status: 500 },
      ],
    });
    const { frames, root, subagents, failures } = outcome;
    expect(failures).toHaveLength(1);

    // 前提：子代理那一份真的有自己的用量與量測，而 root 那一份的是第 0、2 次呼叫的。
    expect(eventsOf(subagents, 'model/usage').map((usage) => usage.inputTokens)).toEqual([1001]);
    expect(eventsOf(subagents, 'context/measure')).toHaveLength(1);
    expect(eventsOf(root, 'model/usage').map((usage) => usage.inputTokens)).toEqual([1000, 1002]);
    const rootMeasures = eventsOf(root, 'context/measure');
    expect(rootMeasures).toHaveLength(2);
    // 前提：最後一輪真的失敗了，而且沒有留下任何一筆。
    expect(root.at(-1)?.type).toBe('turn/failed');

    // 即時：只有 root 的那幾顆，照順序。
    const custom = frames
      .filter((frame) => frame.method === 'custom')
      .map((frame) => frame.params.data as { name: string; payload: unknown });
    expect(custom.filter((data) => data.name === MODEL_USAGE).map((data) => data.payload)).toEqual([
      { inputTokens: 1000 },
      { inputTokens: 1002 },
    ]);
    expect(
      custom.filter((data) => data.name === CONTEXT_MEASURE).map((data) => data.payload),
    ).toEqual(rootMeasures);

    const live = pressureOf(frames);
    expect(live).toEqual({ inputTokens: 1002, measure: rootMeasures[1] });

    // 重新整理：整份一頁，與只收最後一輪的那一頁，都拿到同一份。
    const whole = historyPage(root);
    expect(whole.firstSeq).toBe(0);
    expect(pressureOf(whole.events)).toEqual(live);
    const last = historyPage(root, { maxMessages: 1 });
    // 前提：這一頁真的只有最後那一輪，而那一輪自己沒有用量表的事件——補的那條規則被問到了。
    expect(last.firstSeq).toBeGreaterThan(0);
    const own = root.slice(last.firstSeq);
    expect(own.some((event) => event.type === 'model/usage')).toBe(false);
    expect(own.some((event) => event.type === 'context/measure')).toBe(false);
    expect(pressureOf(last.events)).toEqual(live);
  }, 30000);
});

describe('生摘要的那次模型呼叫不上線（#584）', () => {
  const SUMMARY = '（摘要）前面聊了幾件事。';
  const aiTexts = (frames: readonly Event[]) =>
    reduceAll(emptyConversation(), frames).entries.flatMap((entry) =>
      entry.kind === 'ai' ? [entry.text] : [],
    );

  it('摘要那一輪即時與重新整理一樣，摘要本身不在任何一顆 frame 裡', async () => {
    const { frames, root, requests } = await converse(TURNS, {
      summarization: summarizeAt([{ type: 'messages', value: 3 }]),
      script: [{ text: '第一輪回話' }, { text: SUMMARY }, { text: '第二輪回話' }],
    });
    // 前提：第二次請求是摘要（沒帶工具），而且是串流的——不串流的話它本來就不會逐段上線。
    expect(requests).toEqual([
      { stream: true, tools: true },
      { stream: true, tools: false },
      { stream: true, tools: true },
    ]);
    const summaries = eventsOf(root, 'compaction/summary');
    expect(summaries).toHaveLength(1);
    expect(JSON.stringify(summaries[0]!.summary)).toContain(SUMMARY);

    // 摘要之後那一輪真正的回話照常即時上線。
    expect(aiTexts(frames)).toEqual(['第一輪回話', '第二輪回話']);
    expect(aiTexts(historyPage(root).events)).toEqual(aiTexts(frames));
    expect(JSON.stringify(frames)).not.toContain(SUMMARY);
  }, 30000);
});

describe('會話總帳不含生摘要的那一次（#574）', () => {
  /**
   * 基座在自己的 `wrapModelCall` 裡直接 `request.model.invoke` 生摘要，不經過 `handler`，而 `model/usage` 只記
   * `handler` 回來的那一顆（`model-usage.ts`）。讀程式碼得出的結論，這裡打一次：假端點每次請求報的數都不同，摘要那次
   * 報的那個數不能出現在任何一條路上。
   */
  it('摘要那次的請求有打出去，它報的用量不在 root 日誌、即時、歷史的總帳裡', async () => {
    const run = await converse(TURNS, {
      summarization: summarizeAt([{ type: 'messages', value: 3 }]),
    });
    // 前提：真的摘要了——三次請求裡恰好一次不帶工具，日誌記了一顆摘要。
    expect(run.requests).toHaveLength(3);
    const summaryAt = run.requests.findIndex((request) => !request.tools);
    expect(run.requests.filter((request) => !request.tools)).toHaveLength(1);
    expect(eventsOf(run.root, 'compaction/summary')).toHaveLength(1);

    const inputs = eventsOf(run.root, 'model/usage').map((usage) => usage.inputTokens);
    expect(inputs).toHaveLength(2);
    expect(inputs).not.toContain(1000 + summaryAt);
    const expected = { inputTokens: inputs[0]! + inputs[1]!, outputTokens: 2 };
    expect(reduceAll(emptyConversation(), run.frames).tokenUsage).toEqual(expected);
    expect(reduceAll(emptyConversation(), historyPage(run.root).events).tokenUsage).toEqual(
      expected,
    );
  }, 30000);
});
