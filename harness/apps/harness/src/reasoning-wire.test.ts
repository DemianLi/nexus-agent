/**
 * **模型的推理即時看得到，重新整理之後也還在**——[#527](https://github.com/DemianLi/nexus-agent/issues/527)。
 *
 * 真的 `ChatOpenAI` 對著一台本機的假端點，端點照 vLLM 系的拼法在 `delta` 送 `reasoning_content`（我們預設
 * 那顆模型實際送的就是這一格，#527 量過）。`@langchain/core` 把它翻成 `reasoning-delta` 上線、把整則的
 * `reasoning` 區塊寫進日誌那則 `assistant/message` 的 content。兩條路各折一次，比同一份。
 *
 * **案例裡一定要有一則「只有推理加工具呼叫」的**：那正是我們預設模型每一步的樣子（#527 triage 那張表，
 * 六則的正文全是 0 字），而歷史那一側原本在正文是空的時候整則不送。
 *
 * **零憑證**：對手方是本機的假 SSE 端點。每次回應的 id 都不一樣——同 id 的 AI 訊息會被 reducer 取代，
 * 歷史少一截會像產品 bug。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import type { PluginEntry } from '@nexus/core';
import type { ConversationState, Event } from '@nexus/wire';
import { emptyConversation, reduceConversation } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createNexusAgent } from './agent-factory.js';
import { historyFrames } from './conversation-history.js';
import { DEFAULT_TOOL_TEXT_MAX_BYTES } from './settings/tool-text.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

type AiEntry = Extract<ConversationState['entries'][number], { kind: 'ai' }>;

/** 每一次請求送出的 `delta`，最後一顆帶 `finish_reason`。 */
const SCRIPT: readonly (readonly [Record<string, unknown>[], string])[] = [
  [
    [
      { reasoning_content: '先想' },
      { reasoning_content: '一下' },
      {
        tool_calls: [
          {
            index: 0,
            id: 'call-noop',
            type: 'function',
            function: { name: 'noop', arguments: '{}' },
          },
        ],
      },
    ],
    'tool_calls',
  ],
  [[{ reasoning_content: '再想' }, { content: '好了' }, { content: '。' }], 'stop'],
];

async function scriptedOpenAi() {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const index = requests;
      requests += 1;
      const [deltas, finish] = SCRIPT[index] ?? [[{ content: '腳本用完了' }], 'stop'];
      const chunk = (delta: Record<string, unknown>, reason: string | null = null) =>
        `data: ${JSON.stringify({
          id: `chatcmpl-${index}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: reason }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }));
      for (const delta of deltas) res.write(chunk(delta));
      res.write(chunk({}, finish));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const NOOP: PluginEntry = {
  plugin: {
    name: 'noop',
    apply(registry) {
      registry.tools.register(
        tool(() => '做完了', { name: 'noop', description: '什麼都不做。', schema: z.object({}) }),
      );
    },
  },
};

const isRootDone = (frame: Event): boolean =>
  frame.method === 'lifecycle' &&
  frame.params.namespace.length === 0 &&
  (frame.params.data as { graph_name?: unknown }).graph_name === 'root' &&
  ['completed', 'failed'].includes(String((frame.params.data as { event?: unknown }).event));

async function until(predicate: () => boolean, ms = 10000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 畫面上看得到的那幾格。entry 的 key 兩條路本來就不同（`run_id` 對 `history-<seq>`），不比。 */
function aiView(frames: readonly Event[]) {
  return frames
    .reduce(reduceConversation, emptyConversation())
    .entries.filter((entry): entry is AiEntry => entry.kind === 'ai')
    .map(({ text, reasoning, streaming, messageId }) => ({
      text,
      reasoning,
      streaming,
      messageId,
    }));
}

describe('推理在即時與重新整理之後都看得到', () => {
  it('真的 ChatOpenAI：兩條路折出同一份，含只有推理加工具呼叫的那一步', async () => {
    const upstream = await scriptedOpenAi();
    const built = await createNexusAgent({
      model: new ChatOpenAI({
        model: 'fake',
        apiKey: 'sk-loopback',
        maxRetries: 0,
        configuration: { baseURL: upstream.baseURL },
      }),
      checkpointer: new MemorySaver(),
      plugins: [NOOP],
    });
    const pump = new ThreadPump(built.agent as unknown as PumpAgent, 'reasoning');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['messages', 'tools', 'lifecycle'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    try {
      await pump.submit({ kind: 'message', text: '想一想再做' });
      await until(() => frames.some(isRootDone));
      expect(upstream.requests()).toBe(2);

      // 前提：推理真的落了盤，而且落在 content 區塊裡。少了這一句，兩邊都沒有推理也會相等。
      // 只看推理與正文兩種區塊：帶工具呼叫的那則另有一塊 `tool_call`。
      const replies = pump.sessionLog.events.filter((event) => event.type === 'assistant/message');
      const blocks = replies.map((event) =>
        (event.data.message.data.content as unknown as { type: string }[]).filter(
          (block) => block.type === 'reasoning' || block.type === 'text',
        ),
      );
      expect(blocks).toEqual([
        [{ type: 'reasoning', reasoning: '先想一下' }],
        [
          { type: 'reasoning', reasoning: '再想' },
          { type: 'text', text: '好了。' },
        ],
      ]);

      const live = aiView(frames);
      expect(live.map(({ text, reasoning }) => ({ text, reasoning }))).toEqual([
        { text: '', reasoning: '先想一下' },
        { text: '好了。', reasoning: '再想' },
      ]);
      expect(aiView(historyFrames(pump.sessionLog.events, DEFAULT_TOOL_TEXT_MAX_BYTES))).toEqual(
        live,
      );
    } finally {
      line.abort();
      await draining;
      detach();
      await built.dispose();
      await upstream.close();
    }
  }, 30000);
});
