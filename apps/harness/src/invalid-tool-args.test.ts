/**
 * **解不開的工具參數：同一輪拿到 `INVALID_ARGS`、thread 不再壞死**——
 * [#281](https://github.com/DemianLi/nexus-agent/issues/281) 的驗收。規則本身在
 * `packages/nexus-core/src/invalid-tool-args.test.ts`。
 *
 * ## 為什麼一定要真的 `ChatOpenAI`
 *
 * 壞的形狀是供應商轉接器產的：`ScriptedChatModel` 給的永遠是合法 JSON，**產不出
 * `invalid_tool_calls`，也產不出 `invalid_tool_call` content block**，拿它測的話這一份永遠綠。
 * 兩條產品路徑的形狀還不一樣（非串流 `_generate` 與 v3 串流），所以兩條各跑一次，而且先斷言
 * 請求真的走了那一條（`stream` 旗標）。
 *
 * **零憑證**：對手方是本機的假 Chat Completions 端點，照 NVIDIA 對歷史裡解不開的參數回 400
 * （#269 實測的那句）——所以「下一輪沒有壞死」是伺服器那一側判的，不是我們自己說的。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI, convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import {
  createInvalidArgumentsCarrier,
  INVALID_ARGS,
  INVALID_ARGUMENTS_REFUSAL,
  repairInvalidToolCalls,
  SessionRegistry,
} from '@nexus/core';
import type { InvariantError, NexusPlugin, SessionEvent } from '@nexus/core';
import { createCoreInvariantPlugin } from '@nexus/core/invariant';
import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNexusAgent } from './agent-factory.js';
import { toAgentInvocation } from './messages.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

/** 連 JSON 都不是：值沒有引號。 */
const BROKEN = '{"text": 嗨}';
/** 串到一半斷掉。 */
const TRUNCATED = '{"text": "嗨';

/** 假端點每一次回什麼：叫一顆工具（`arguments` 原樣吐出），或講一句話。 */
interface Reply {
  readonly toolCall?: { readonly id: string; readonly name: string; readonly arguments: string };
  readonly text?: string;
}

interface WireToolCall {
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

interface WireMessage {
  readonly role: string;
  readonly content: unknown;
  readonly tool_calls?: readonly WireToolCall[];
  readonly tool_call_id?: string;
}

interface Recorded {
  readonly stream: boolean;
  readonly messages: readonly WireMessage[];
}

function isJsonObjectString(raw: string): boolean {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/**
 * 照腳本回答的 Chat Completions 端點。`stream` 為真時吐 SSE，否則吐一整份 JSON——兩條產品路徑
 * 各走一種。**歷史裡任何一顆工具參數不是 JSON 物件字串就回 400**，措辭照 #269 量到的 NVIDIA。
 */
async function fakeOpenAi(replies: readonly Reply[]) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { stream?: boolean; messages?: WireMessage[] };
      const messages = parsed.messages ?? [];
      requests.push({ stream: parsed.stream === true, messages });
      const broken = messages.findIndex((message) =>
        (message.tool_calls ?? []).some((call) => !isJsonObjectString(call.function.arguments)),
      );
      if (broken >= 0) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: {
              message: `\`messages[${broken}].tool_calls[0].function.arguments\` must be a valid JSON object string`,
            },
          }),
        );
        return;
      }
      // **每次回覆的 id 要不同**：同一個 id 的兩則 AI 訊息會被 reducer 當成同一則取代掉，
      // 下一輪的歷史就少了那顆呼叫（實測）。
      const completionId = `chatcmpl-${requests.length}`;
      const reply = replies[requests.length - 1];
      if (reply === undefined) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `腳本只有 ${replies.length} 次` } }));
        return;
      }
      const call = reply.toolCall;
      const wireCall =
        call === undefined
          ? undefined
          : {
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            };
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
                message:
                  wireCall === undefined
                    ? { role: 'assistant', content: reply.text ?? '' }
                    : { role: 'assistant', content: null, tool_calls: [wireCall] },
                finish_reason: wireCall === undefined ? 'stop' : 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: completionId,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (wireCall === undefined) {
        res.write(chunk({ role: 'assistant', content: reply.text ?? '' }));
        res.write(chunk({}, 'stop'));
      } else {
        res.write(
          chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, ...wireCall }] }),
        );
        res.write(chunk({}, 'tool_calls'));
      }
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
    configuration: { baseURL },
  });
}

/** 兩顆工具，本體被叫到就記下名字——「本體零次」看的就是這一份。 */
function toolsPlugin(bodies: string[]): NexusPlugin {
  return {
    name: 'invalid-args-tools',
    apply(registry) {
      registry.tools.register(
        tool(
          ({ text }: { text: string }) => {
            bodies.push('echo');
            return `回聲：${text}`;
          },
          { name: 'echo', description: '原樣回聲。', schema: z.object({ text: z.string() }) },
        ),
      );
      registry.tools.register(
        tool(
          () => {
            bodies.push('danger');
            return '危險的事做完了';
          },
          { name: 'danger', description: '要核准。', schema: z.object({ target: z.string() }) },
        ),
      );
    },
  };
}

const gatePlugin: NexusPlugin = {
  name: 'invalid-args-gate',
  apply(registry) {
    registry.approvals.gate((exec, next) =>
      exec.name === 'danger' ? { kind: 'ask', reason: '危險' } : next(),
    );
  },
};

const workerPlugin: NexusPlugin = {
  name: 'invalid-args-worker',
  apply(registry) {
    registry.subagents.register({ name: 'worker', description: '幹活的。' });
  },
};

function toolEvents(events: readonly SessionEvent[]): { type: string; data: unknown }[] {
  return events
    .filter((event) => event.type === 'tool/call' || event.type === 'tool/result')
    .map((event) => ({ type: event.type, data: event.data }));
}

/** 解不開的那一顆在日誌上該長的樣子：原字串一對、碼 `INVALID_ARGS`。 */
function refusedPair(callId: string, name: string, raw: string) {
  return [
    { type: 'tool/call', data: { callId, name, arguments: raw } },
    {
      type: 'tool/result',
      data: { callId, isError: true, error: { name: 'ToolArgsError', code: INVALID_ARGS } },
    },
  ];
}

/** 這一次請求裡，那顆呼叫與緊跟在它後面的那則 tool 訊息。 */
function replayOf(request: Recorded | undefined, callId: string) {
  const messages = request?.messages ?? [];
  const at = messages.findIndex((message) =>
    (message.tool_calls ?? []).some((call) => call.id === callId),
  );
  const call = messages[at]?.tool_calls?.find((candidate) => candidate.id === callId);
  return { arguments: call?.function.arguments, next: messages[at + 1] };
}

/** tool 訊息的內容，字串或 content block 陣列都攤平成字串。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (part as { text?: string }).text ?? '').join('');
  }
  return '';
}

const ROOT_ID = 'invalid-args-root';

/** CLI 那條：`agent.stream`，串流模式同 `cli.ts`（`updates`／`values`，不串逐字）。 */
async function assembleCli(replies: readonly Reply[], plugins: readonly NexusPlugin[]) {
  const upstream = await fakeOpenAi(replies);
  // **日誌的不變量也跑一遍**：核准那條一個 callId 有兩顆 `tool/call`、一顆 `tool/result`，
  // 只看日誌內容的斷言看不出它配不配得起來。
  const violations: InvariantError[] = [];
  const built = await createNexusAgent({
    model: openAi(upstream.baseURL),
    checkpointer: new MemorySaver(),
    plugins: [...plugins, createCoreInvariantPlugin()],
    onInvariantViolation: (error) => violations.push(error),
  });
  const sessions = new SessionRegistry(ROOT_ID);
  const detach = built.attachSession(sessions);
  const unwatch = built.attachInvariants(sessions);
  // 沒接上的話 `violations` 永遠是空的，下面那條斷言就是假綠。
  if (unwatch === undefined) throw new Error('不變量沒接上：配套入口是空的');
  const config = { configurable: { thread_id: ROOT_ID } };
  const logOf = (kind: 'root' | 'subagent'): (readonly SessionEvent[])[] =>
    sessions
      .list()
      .filter((entry) => entry.address.kind === kind)
      .map((entry) => entry.log.events);
  return {
    ...built,
    upstream,
    config,
    say: async (text: string): Promise<void> => {
      for await (const _chunk of await built.agent.stream(toAgentInvocation(text), {
        ...config,
        streamMode: ['updates', 'values'],
      })) {
        // 只要跑完；日誌與請求才是判準。
      }
    },
    root: (): readonly SessionEvent[] => logOf('root')[0] ?? [],
    subagents: (): (readonly SessionEvent[])[] => logOf('subagent'),
    close: async () => {
      unwatch?.();
      detach();
      await built.dispose();
      await upstream.close();
      expect(violations.map((error) => error.message)).toEqual([]);
    },
  };
}

describe('前提與絆索：真的轉換器產出的形狀', () => {
  it('非串流那條：壞的那顆在 invalid_tool_calls；不改寫就原字串回送，改寫後回送 {}', async () => {
    const upstream = await fakeOpenAi([
      { toolCall: { id: 'call_bad', name: 'echo', arguments: BROKEN } },
    ]);
    try {
      const message = await openAi(upstream.baseURL).invoke('叫一次');
      // 前提：這就是 #269 量到的形狀，不是轉換器幫忙修好了的。
      expect(message.tool_calls).toEqual([]);
      expect(message.invalid_tool_calls?.map((call) => call.args)).toEqual([BROKEN]);

      // 絆索：拿掉改寫，下一輪原字串照樣回送——就是 NVIDIA 回 400 的那一格。
      const unrepaired = convertMessagesToCompletionsMessageParams({ messages: [message] });
      expect(
        (unrepaired[0] as { tool_calls?: WireToolCall[] }).tool_calls?.[0]?.function.arguments,
      ).toBe(BROKEN);

      const repaired = convertMessagesToCompletionsMessageParams({
        messages: [repairInvalidToolCalls(message, createInvalidArgumentsCarrier())],
      });
      expect(
        (repaired[0] as { tool_calls?: WireToolCall[] }).tool_calls?.[0]?.function.arguments,
      ).toBe('{}');
    } finally {
      await upstream.close();
    }
  });
});

describe.each([
  ['JSON 不合格', BROKEN],
  ['截斷的 JSON', TRUNCATED],
])('%s', (_label, raw) => {
  it('CLI（非串流）：同一輪拿到 INVALID_ARGS 再被叫一次；日誌一對原字串；本體零次；下一輪不壞死', async () => {
    const bodies: string[] = [];
    const run = await assembleCli(
      [
        { toolCall: { id: 'call_bad', name: 'echo', arguments: raw } },
        { text: '參數壞了，不叫了。' },
        { text: '好。' },
      ],
      [toolsPlugin(bodies)],
    );
    try {
      await run.say('叫一次');
      // 前提：走的是非串流那條。
      expect(run.upstream.requests.map((request) => request.stream)).toEqual([false, false]);
      // 同一輪模型收到那句錯誤、再被叫一次；回送的參數是 {}，後面跟著那則 tool 訊息。
      const replay = replayOf(run.upstream.requests[1], 'call_bad');
      expect(replay.arguments).toBe('{}');
      expect(replay.next).toMatchObject({ role: 'tool', tool_call_id: 'call_bad' });
      expect(textOf(replay.next?.content)).toBe(INVALID_ARGUMENTS_REFUSAL);
      expect(toolEvents(run.root())).toEqual(refusedPair('call_bad', 'echo', raw));
      expect(bodies).toEqual([]);

      // 下一輪：伺服器對原字串回 400，這一輪跑得完就是 thread 沒壞死。
      await run.say('再一句');
      expect(run.upstream.requests).toHaveLength(3);
      expect(replayOf(run.upstream.requests[2], 'call_bad').arguments).toBe('{}');
    } finally {
      await run.close();
    }
  });

  it('web（pump、v3 串流）：工具卡的 input 是原字串、以失敗收尾；日誌同一對；下一輪不壞死', async () => {
    const bodies: string[] = [];
    const upstream = await fakeOpenAi([
      { toolCall: { id: 'call_bad', name: 'echo', arguments: raw } },
      { text: '參數壞了，不叫了。' },
      { text: '好。' },
    ]);
    const violations: InvariantError[] = [];
    const built = await createNexusAgent({
      model: openAi(upstream.baseURL),
      checkpointer: new MemorySaver(),
      plugins: [toolsPlugin(bodies), createCoreInvariantPlugin()],
      onInvariantViolation: (error) => violations.push(error),
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'invalid-args-web');
    const detach = built.attachSession(pump.sessions);
    const unwatch = built.attachInvariants(pump.sessions);
    if (unwatch === undefined) throw new Error('不變量沒接上：配套入口是空的');
    const frames: Event[] = [];
    const line = new AbortController();
    // **刻意不訂 `messages`**：pump 從那一條學原字串，但客戶端只訂工具卡時也要換得到。
    const stream = pump.subscribe(['tools', 'lifecycle'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    try {
      await pump.submit({ kind: 'message', text: '叫一次' });
      // 前提：走的是 v3 串流那條。
      expect(upstream.requests.map((request) => request.stream)).toEqual([true, true]);
      const replay = replayOf(upstream.requests[1], 'call_bad');
      expect(replay.arguments).toBe('{}');
      expect(textOf(replay.next?.content)).toBe(INVALID_ARGUMENTS_REFUSAL);

      const tools = frames
        .filter((frame) => frame.method === 'tools')
        .map((frame) => frame.params.data as Record<string, unknown>)
        .filter((data) => data.tool_call_id === 'call_bad');
      expect(tools.map((data) => data.event)).toEqual(['tool-started', 'tool-finished']);
      expect(tools[0]).toMatchObject({ tool_name: 'echo', input: raw });
      expect(tools[1]).toMatchObject({ failed: true, message: INVALID_ARGUMENTS_REFUSAL });

      expect(toolEvents(pump.sessions.root.events)).toEqual(refusedPair('call_bad', 'echo', raw));
      expect(bodies).toEqual([]);

      await pump.submit({ kind: 'message', text: '再一句' });
      expect(upstream.requests).toHaveLength(3);
      expect(replayOf(upstream.requests[2], 'call_bad').arguments).toBe('{}');
      expect(violations.map((error) => error.message)).toEqual([]);
    } finally {
      line.abort();
      await draining;
      unwatch?.();
      detach();
      await built.dispose();
      await upstream.close();
    }
  });
});

/**
 * 照 dsh 先問人：核准在驗參數之前。**核准卡上是原字串**（中斷酬載的 `args`），listener 看到的是
 * 歷史裡的 `{}`。
 */
describe('要核准的工具', () => {
  it.each([
    ['核准之後拿到 INVALID_ARGS', 'approve'],
    ['拒絕就是一般的拒絕', 'reject'],
  ])('%s', async (_label, decision) => {
    const bodies: string[] = [];
    const run = await assembleCli(
      [{ toolCall: { id: 'call_bad', name: 'danger', arguments: BROKEN } }, { text: '收到。' }],
      [toolsPlugin(bodies), gatePlugin],
    );
    try {
      const paused = (await run.agent.invoke(toAgentInvocation('動手'), run.config)) as {
        __interrupt__?: { value?: { actionRequests?: { name: string; args: unknown }[] } }[];
      };
      expect(paused.__interrupt__?.[0]?.value?.actionRequests).toEqual([
        expect.objectContaining({ name: 'danger', args: BROKEN }),
      ]);

      await run.agent.invoke(
        new Command({ resume: { decisions: [{ type: decision }] } }) as never,
        run.config,
      );
      const events = toolEvents(run.root());
      // 暫停那次一顆沒配對的呼叫，resume 那次再一對——兩顆 `tool/call` 都記原字串。
      expect(events.filter((event) => event.type === 'tool/call')).toEqual([
        { type: 'tool/call', data: { callId: 'call_bad', name: 'danger', arguments: BROKEN } },
        { type: 'tool/call', data: { callId: 'call_bad', name: 'danger', arguments: BROKEN } },
      ]);
      const result = events.at(-1);
      const replay = replayOf(run.upstream.requests[1], 'call_bad');
      expect(replay.arguments).toBe('{}');
      if (decision === 'approve') {
        expect(result?.data).toEqual({
          callId: 'call_bad',
          isError: true,
          error: { name: 'ToolArgsError', code: INVALID_ARGS },
        });
        expect(textOf(replay.next?.content)).toBe(INVALID_ARGUMENTS_REFUSAL);
      } else {
        // 被拒照 dsh 不帶碼，文字是閘門自己的那句。
        expect(result?.data).toEqual({ callId: 'call_bad', isError: true });
        expect(textOf(replay.next?.content)).toBe('有人看過並拒絕了 "danger"。');
      }
      expect(bodies).toEqual([]);
    } finally {
      await run.close();
    }
  });
});

/**
 * **載體落定就刪鍵**：有的供應商會重用 callId。沒刪的話，下一輪一顆合法的同 id 呼叫會被當成壞的拒掉。
 */
describe('落定之後', () => {
  it('同一個 callId 再來一顆合法的呼叫，照常執行', async () => {
    const bodies: string[] = [];
    const run = await assembleCli(
      [
        { toolCall: { id: 'call_same', name: 'echo', arguments: BROKEN } },
        { text: '參數壞了。' },
        { toolCall: { id: 'call_same', name: 'echo', arguments: '{"text":"好"}' } },
        { text: '叫到了。' },
      ],
      [toolsPlugin(bodies)],
    );
    try {
      await run.say('叫一次');
      await run.say('再叫一次');
      expect(bodies).toEqual(['echo']);
      const results = toolEvents(run.root()).filter((event) => event.type === 'tool/result');
      expect(results.map((event) => event.data)).toEqual([
        {
          callId: 'call_same',
          isError: true,
          error: { name: 'ToolArgsError', code: INVALID_ARGS },
        },
        { callId: 'call_same', isError: false },
      ]);
    } finally {
      await run.close();
    }
  });
});

describe('子代理那層', () => {
  it('子代理吐壞參數：記在子代理那份、拿到 INVALID_ARGS，下一次請求回送 {}', async () => {
    const bodies: string[] = [];
    const run = await assembleCli(
      [
        {
          toolCall: {
            id: 'call_task',
            name: 'task',
            arguments: JSON.stringify({ description: '幹活', subagent_type: 'worker' }),
          },
        },
        { toolCall: { id: 'call_bad', name: 'echo', arguments: BROKEN } },
        { text: '子代理收工。' },
        { text: '收工。' },
      ],
      [toolsPlugin(bodies), workerPlugin],
    );
    try {
      await run.say('委派');
      const subagents = run.subagents();
      expect(subagents).toHaveLength(1);
      expect(toolEvents(subagents[0]!)).toEqual(refusedPair('call_bad', 'echo', BROKEN));
      expect(toolEvents(run.root()).map((event) => event.type)).toEqual([
        'tool/call',
        'tool/result',
      ]);
      const replay = replayOf(run.upstream.requests[2], 'call_bad');
      expect(replay.arguments).toBe('{}');
      expect(textOf(replay.next?.content)).toBe(INVALID_ARGUMENTS_REFUSAL);
      expect(bodies).toEqual([]);
    } finally {
      await run.close();
    }
  });
});
