/**
 * **模型回覆撞到輸出上限：這一步收掉、這一輪記成截斷**——[#433](https://github.com/DemianLi/nexus-agent/issues/433)
 * 的驗收。規則本身在 `packages/nexus-core/src/max-tokens.test.ts`。
 *
 * ## 為什麼一定要真的 `ChatOpenAI`
 *
 * 兩條產品路徑拿到的 `finish_reason` 不一樣：CLI（非串流 `_generate`）是供應商原字串，web（v3 串流）
 * 是 `@langchain/core` 對映過的值；被切斷的工具參數也各自由不同的轉換器變成 invalid 的那一種。
 * `ScriptedChatModel` 直接給 `response_metadata`，正好繞過這兩件事，所以兩條各跑一次，而且先斷言
 * 請求真的走了那一條（`stream` 旗標）。
 *
 * **零憑證**：對手方是本機的假 Chat Completions 端點。`fetch` 接的是產品路徑那一層
 * `withEmptyAssistantContent`，所以「下一輪送出去的歷史長什麼樣」量的是真的會送出去的那一份。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { SessionRegistry, SUBAGENT_MAX_TOKENS_REASON } from '@nexus/core';
import type { InvariantError, PluginEntry, SessionEvent } from '@nexus/core';
import { createCoreInvariantPlugin } from '@nexus/core/invariant';
import type { AiEntry, ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceConversation } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { runTurn } from './cli.js';
import { historyFrames } from './conversation-history.js';
import { withEmptyAssistantContent } from './live-model.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 串到一半被切掉的參數。 */
const CUT_ARGS = '{"text": "嗨';

interface WireCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

/** 假端點每一次回什麼。`finish` 省略時照內容推：有呼叫是 `tool_calls`，否則 `stop`。 */
interface Reply {
  readonly text?: string;
  readonly calls?: readonly WireCall[];
  readonly finish?: string;
}

interface WireMessage {
  readonly role: string;
  readonly content: unknown;
  readonly tool_calls?: readonly { readonly id: string }[];
  readonly tool_call_id?: string;
}

interface Recorded {
  readonly stream: boolean;
  readonly messages: readonly WireMessage[];
}

/** 照腳本回答的 Chat Completions 端點。`stream` 為真時吐 SSE，否則一整份 JSON。 */
async function fakeOpenAi(replies: readonly Reply[]) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { stream?: boolean; messages?: WireMessage[] };
      requests.push({ stream: parsed.stream === true, messages: parsed.messages ?? [] });
      // 每次回覆的 id 要不同：同 id 的兩則 AI 訊息會被 reducer 當成同一則取代掉。
      const completionId = `chatcmpl-${requests.length}`;
      const reply = replies[requests.length - 1];
      if (reply === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `腳本只有 ${replies.length} 次` } }));
        return;
      }
      const calls = (reply.calls ?? []).map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      }));
      const finish = reply.finish ?? (calls.length > 0 ? 'tool_calls' : 'stop');
      if (parsed.stream !== true) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: completionId,
            object: 'chat.completion',
            created: 0,
            model: 'fake',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: reply.text ?? null,
                  ...(calls.length > 0 ? { tool_calls: calls } : {}),
                },
                finish_reason: finish,
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 16, total_tokens: 17 },
          }),
        );
        return;
      }
      const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
        `data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: reply.text ?? '' }));
      for (const [index, call] of calls.entries()) {
        res.write(chunk({ tool_calls: [{ index, ...call }] }));
      }
      res.write(chunk({}, finish));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function openAi(baseURL: string): ChatOpenAI {
  return new ChatOpenAI({
    model: 'fake',
    apiKey: 'sk-loopback',
    maxRetries: 0,
    configuration: { baseURL, fetch: withEmptyAssistantContent() },
  });
}

/** 一顆工具，本體被叫到就記下來——「本體零次」看的就是這一份。 */
function echoPlugin(bodies: string[]): PluginEntry {
  return {
    plugin: {
      name: 'max-tokens-tools',
      apply(registry) {
        registry.tools.register(
          tool(
            ({ text }: { text: string }) => {
              bodies.push(text);
              return `回聲：${text}`;
            },
            { name: 'echo', description: '原樣回聲。', schema: z.object({ text: z.string() }) },
          ),
        );
      },
    },
  };
}

const workerPlugin: PluginEntry = {
  plugin: {
    name: 'max-tokens-worker',
    apply(registry) {
      registry.subagents.register({ name: 'worker', description: '幹活的。' });
    },
  },
};

const quiet = { log: () => {}, error: () => {} };

function turnEnds(events: readonly SessionEvent[]): unknown[] {
  return events.filter((event) => event.type === 'turn/end').map((event) => event.data);
}

function toolEventTypes(events: readonly SessionEvent[]): string[] {
  return events
    .filter((event) => event.type === 'tool/call' || event.type === 'tool/result')
    .map((event) => event.type);
}

/** 那一則助手訊息在請求裡：`role` 之外只留判別的兩格。 */
function roles(request: Recorded | undefined): string[] {
  return (request?.messages ?? []).map((message) =>
    message.role === 'assistant' && (message.tool_calls ?? []).length > 0
      ? 'assistant+calls'
      : message.role,
  );
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? '').join('');
  }
  return '';
}

/** CLI 那條：`runTurn` 本身，串流模式、`turn/end` 都是它寫的。 */
async function assembleCli(replies: readonly Reply[], plugins: readonly PluginEntry[]) {
  const upstream = await fakeOpenAi(replies);
  const violations: InvariantError[] = [];
  const built = await createNexusAgent({
    model: openAi(upstream.baseURL),
    checkpointer: new MemorySaver(),
    plugins: [...plugins, createCoreInvariantPlugin()],
    onInvariantViolation: (error) => violations.push(error),
  });
  const sessions = new SessionRegistry('max-tokens-cli');
  const detach = built.attachSession(sessions);
  const unwatch = built.attachInvariants(sessions);
  if (unwatch === undefined) throw new Error('不變量沒接上：配套入口是空的');
  return {
    upstream,
    sessions,
    say: (text: string) => runTurn(built.agent, text, quiet, sessions.root),
    close: async () => {
      unwatch();
      detach();
      await built.dispose();
      await upstream.close();
      expect(violations.map((error) => error.message)).toEqual([]);
    },
  };
}

describe('CLI（非串流）', () => {
  /**
   * 同一則裡**已經完整的那顆也不派發**：dsh 的 assembler 丟掉這一則的每一個呼叫。模型被切在第二顆
   * 的參數中間，第一顆看起來好好的——正是最容易被「只丟壞的那顆」誤修的形狀。
   */
  it('這一步的呼叫全丟、本體零次、這一輪不再叫模型；turn/end 帶 max-tokens；下一輪歷史沒有呼叫', async () => {
    const bodies: string[] = [];
    const run = await assembleCli(
      [
        {
          text: '我先查兩個地方。',
          calls: [
            { id: 'call_ok', name: 'echo', arguments: '{"text":"a"}' },
            { id: 'call_cut', name: 'echo', arguments: CUT_ARGS },
          ],
          finish: 'length',
        },
        { text: '好。' },
      ],
      [echoPlugin(bodies)],
    );
    try {
      await run.say('查一下');
      // 前提：走的是非串流那條。
      expect(run.upstream.requests.map((request) => request.stream)).toEqual([false]);
      expect(bodies).toEqual([]);
      const root = run.sessions.root.events;
      expect(toolEventTypes(root)).toEqual([]);
      expect(turnEnds(root)).toEqual([{ reason: { kind: 'max-tokens' } }]);
      // 日誌記的那一則：原字串 `length`、沒有呼叫、文字還在。
      const logged = root.filter((event) => event.type === 'assistant/message');
      expect(logged).toHaveLength(1);
      const data = logged[0]!.data.message.data as {
        content: unknown;
        tool_calls?: unknown[];
        response_metadata?: { finish_reason?: string };
      };
      expect(data.response_metadata?.finish_reason).toBe('length');
      expect(data.tool_calls ?? []).toEqual([]);
      expect(textOf(data.content)).toBe('我先查兩個地方。');

      await run.say('再一句');
      expect(turnEnds(run.sessions.root.events)).toEqual([{ reason: { kind: 'max-tokens' } }, {}]);
      // 下一輪送出去的歷史：那一則照樣在（有字），沒有呼叫、後面也沒有 tool 訊息。
      expect(roles(run.upstream.requests[1])).toEqual(['system', 'user', 'assistant', 'user']);
    } finally {
      await run.close();
    }
  });

  /** 撞到上限時只在寫參數、一個字都沒吐：清掉呼叫之後什麼都不剩，下一輪整則不送（同 dsh）。 */
  it('清完一個字都不剩的那一則，下一輪整則不送', async () => {
    const run = await assembleCli(
      [
        { calls: [{ id: 'call_cut', name: 'echo', arguments: CUT_ARGS }], finish: 'length' },
        { text: '好。' },
      ],
      [echoPlugin([])],
    );
    try {
      await run.say('查一下');
      await run.say('再一句');
      expect(roles(run.upstream.requests[1])).toEqual(['system', 'user', 'user']);
    } finally {
      await run.close();
    }
  });

  /** 對照組：同一個形狀、`finish_reason` 正常，走的是 #281 那條——拿到 INVALID_ARGS、同一輪再叫一次。 */
  it('對照：finish_reason 不是 length 就照舊當成壞參數，這一輪繼續', async () => {
    const run = await assembleCli(
      [{ calls: [{ id: 'call_cut', name: 'echo', arguments: CUT_ARGS }] }, { text: '參數壞了。' }],
      [echoPlugin([])],
    );
    try {
      await run.say('查一下');
      expect(run.upstream.requests).toHaveLength(2);
      expect(turnEnds(run.sessions.root.events)).toEqual([{}]);
    } finally {
      await run.close();
    }
  });
});

/** web 那條：真的 pump、訂 `messages`／`tools`／`lifecycle`，同瀏覽器那一端。 */
async function assembleWeb(replies: readonly Reply[], bodies: string[]) {
  const upstream = await fakeOpenAi(replies);
  const violations: InvariantError[] = [];
  const built = await createNexusAgent({
    model: openAi(upstream.baseURL),
    checkpointer: new MemorySaver(),
    plugins: [echoPlugin(bodies), createCoreInvariantPlugin()],
    onInvariantViolation: (error) => violations.push(error),
  });
  const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'max-tokens-web');
  const detach = built.attachSession(pump.sessions);
  const unwatch = built.attachInvariants(pump.sessions);
  if (unwatch === undefined) throw new Error('不變量沒接上：配套入口是空的');
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'tools', 'lifecycle'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  return {
    upstream,
    pump,
    frames,
    close: async () => {
      line.abort();
      await draining;
      unwatch();
      detach();
      await built.dispose();
      await upstream.close();
      expect(violations.map((error) => error.message)).toEqual([]);
    },
  };
}

/** 每一則回覆的字與截斷標記。 */
function marks(state: ConversationState): [string, boolean][] {
  return state.entries
    .filter((entry): entry is AiEntry => entry.kind === 'ai')
    .map((entry) => [entry.text, entry.maxTokens ?? false]);
}

describe('web（pump、v3 串流）', () => {
  it('收尾 frame 帶 maxTokens、最後一則 root 回覆標上；turn/end 帶 max-tokens；本體零次', async () => {
    const bodies: string[] = [];
    const run = await assembleWeb(
      [
        {
          text: '我先查兩個地方。',
          calls: [
            { id: 'call_ok', name: 'echo', arguments: '{"text":"a"}' },
            { id: 'call_cut', name: 'echo', arguments: CUT_ARGS },
          ],
          finish: 'length',
        },
        { text: '好。' },
      ],
      bodies,
    );
    try {
      await run.pump.submit({ kind: 'message', text: '查一下' });
      // 前提：走的是 v3 串流那條。
      expect(run.upstream.requests.map((request) => request.stream)).toEqual([true]);
      expect(bodies).toEqual([]);
      const root = run.pump.sessions.root.events;
      expect(toolEventTypes(root)).toEqual([]);
      expect(turnEnds(root)).toEqual([{ reason: { kind: 'max-tokens' } }]);
      const logged = root.find((event) => event.type === 'assistant/message');
      // web 這條拿到的是對映過的值——供應商原字串是什麼都一樣。
      expect(
        (logged?.data.message.data as { response_metadata?: { finish_reason?: string } })
          .response_metadata?.finish_reason,
      ).toBe('length');

      const closing = run.frames.filter(
        (frame) =>
          frame.method === 'lifecycle' &&
          (frame.params.data as { graph_name?: string }).graph_name === 'root' &&
          frame.params.namespace.length === 0 &&
          (frame.params.data as { event?: string }).event === 'completed',
      );
      expect(
        closing.map((frame) => (frame.params.data as { maxTokens?: boolean }).maxTokens),
      ).toEqual([true]);
      const state = run.frames.reduce(reduceConversation, emptyConversation());
      expect(state.status).toBe('idle');
      expect(marks(state)).toEqual([['我先查兩個地方。', true]]);

      await run.pump.submit({ kind: 'message', text: '再一句' });
      expect(turnEnds(run.pump.sessions.root.events)).toEqual([
        { reason: { kind: 'max-tokens' } },
        {},
      ]);
      expect(roles(run.upstream.requests[1])).toEqual(['system', 'user', 'assistant', 'user']);
    } finally {
      await run.close();
    }
  });

  /**
   * 一個字都沒吐、只在寫參數時被切斷：即時那條為它長一則空的，**重新整理之後的歷史也要標在同一則**
   * ——歷史平常略過沒字的回覆，略過的話標記會落到別處或無處可標。下一輪那則整則不送，同 CLI。
   */
  it('沒吐字的那一則：即時與重新整理之後標在同一則；下一輪整則不送', async () => {
    const run = await assembleWeb(
      [
        { calls: [{ id: 'call_cut', name: 'echo', arguments: CUT_ARGS }], finish: 'length' },
        { text: '好。' },
      ],
      [],
    );
    try {
      await run.pump.submit({ kind: 'message', text: '查一下' });
      const live = marks(run.frames.reduce(reduceConversation, emptyConversation()));
      const replayed = marks(
        historyFrames(run.pump.sessions.root.events, DEFAULT_TOOL_TEXT_MAX_BYTES).reduce(
          reduceConversation,
          emptyConversation(),
        ),
      );
      expect(live).toEqual([['', true]]);
      expect(replayed).toEqual(live);

      await run.pump.submit({ kind: 'message', text: '再一句' });
      expect(roles(run.upstream.requests[1])).toEqual(['system', 'user', 'user']);
    } finally {
      await run.close();
    }
  });
});

describe('子代理撞到上限', () => {
  /**
   * 修之前：基座的 `task` 把寫到一半的那段當成功結果交回去，父代理看不出來沒做完。dsh 回一則錯誤、
   * 後面接那一段。root 自己沒撞到，它那一輪照常收尾。
   */
  it('父代理拿到 dsh 那句錯誤加上寫出的那段；root 那一輪照常收尾', async () => {
    const run = await assembleCli(
      [
        {
          calls: [
            {
              id: 'call_task',
              name: 'task',
              arguments: JSON.stringify({ description: '寫報告', subagent_type: 'worker' }),
            },
          ],
        },
        { text: '報告寫到一半', finish: 'length' },
        { text: '子代理沒寫完，我接手。' },
      ],
      [workerPlugin],
    );
    try {
      await run.say('派人寫報告');
      expect(run.upstream.requests).toHaveLength(3);
      const back = run.upstream.requests[2]?.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === 'call_task',
      );
      expect(textOf(back?.content)).toBe(
        `Error: ${SUBAGENT_MAX_TOKENS_REASON}\nPartial output before the run ended:\n報告寫到一半`,
      );
      const result = run.sessions.root.events.find((event) => event.type === 'tool/result');
      expect(result?.type === 'tool/result' && result.data.isError).toBe(true);
      expect(turnEnds(run.sessions.root.events)).toEqual([{}]);
    } finally {
      await run.close();
    }
  });

  /** 對照組：子代理正常收，`task` 的結果原樣是它寫的那段。 */
  it('對照：子代理正常收，結果原樣', async () => {
    const run = await assembleCli(
      [
        {
          calls: [
            {
              id: 'call_task',
              name: 'task',
              arguments: JSON.stringify({ description: '寫報告', subagent_type: 'worker' }),
            },
          ],
        },
        { text: '報告寫完了' },
        { text: '好。' },
      ],
      [workerPlugin],
    );
    try {
      await run.say('派人寫報告');
      const back = run.upstream.requests[2]?.messages.find(
        (message) => message.role === 'tool' && message.tool_call_id === 'call_task',
      );
      expect(textOf(back?.content)).toBe('報告寫完了');
    } finally {
      await run.close();
    }
  });
});
