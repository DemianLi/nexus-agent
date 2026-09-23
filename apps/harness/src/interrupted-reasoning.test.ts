/**
 * **按了停止的那則，重新整理之後推理還在**——[#561](https://github.com/DemianLi/nexus-agent/issues/561)。
 *
 * 照 dsh：中止時把已送出的正文與推理一起收成那則 `assistant/message {interrupted: true}`，逐塊判、只有空白
 * 的那塊不留（`packages/llm/llm/src/assembler.ts:169`，`ddefc45`）。推理占串流的大半（#527 量過），所以
 * **停在推理階段**才是常見的那一種，而那時正文一個字都還沒有。
 *
 * 真的 `ChatOpenAI` 對著本機的假端點，端點照 vLLM 系的拼法在 `delta` 送 `reasoning_content`，每 40ms 一顆，
 * 慢到按得到停止。判準是兩條路折出同一份：即時的 frame 與 `historyFrames` 從日誌導出來的。
 *
 * **下一輪一定要送得出去**：只有推理的那則送回模型時是 `content: []`（`ChatOpenAI` 丟推理區塊）。這裡驗
 * 的是我們送得出去、假端點記到的正是那個形狀；真端點收不收是 #561 另外量的（NVIDIA 閘道收）。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { tool } from '@langchain/core/tools';
import { loggedMessageId } from '@nexus/core';
import type { PluginEntry, SessionEventMap } from '@nexus/core';
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

const THINK = '先想想看這一題到底要怎麼拆開來做才對';
const SAY = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉';

/**
 * 第 i 次請求照 `scripts[i]` 慢慢吐，腳本用完之後每一次都回「好。」；最後一顆帶工具呼叫的以
 * `tool_calls` 收尾。記下每一次請求裡**原樣**的助手訊息
 * ——`String([])` 是 `''`，照字串記的話「送出空陣列」跟「送出空字串」分不開。
 */
async function slowOpenAi(scripts: readonly (readonly Record<string, unknown>[])[]) {
  const assistants: unknown[][] = [];
  const sent: number[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages?: { role: string }[] };
      const index = assistants.length;
      assistants.push((parsed.messages ?? []).filter((message) => message.role === 'assistant'));
      sent.push(0);
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: `chatcmpl-${index}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }));
      const deltas = scripts[index] ?? [{ content: '好。' }];
      const finish = 'tool_calls' in (deltas.at(-1) ?? {}) ? 'tool_calls' : 'stop';
      let at = 0;
      const tick = setInterval(() => {
        if (res.destroyed) return clearInterval(tick);
        if (at < deltas.length) {
          res.write(chunk(deltas[at]!));
          at += 1;
          sent[index] = at;
          return;
        }
        clearInterval(tick);
        res.write(chunk({}, finish));
        res.end('data: [DONE]\n\n');
      }, 40);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    assistants,
    sent,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error('等太久了');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** root 那一層已經上了線的某一種片段，照順序接起來——就是瀏覽器畫出來的那些。 */
function onWire(frames: readonly Event[], type: 'text-delta' | 'reasoning-delta'): string {
  return frames
    .filter((frame) => frame.method === 'messages' && frame.params.namespace.length <= 1)
    .map(
      (frame) =>
        frame.params.data as {
          event?: string;
          delta?: { type?: string; text?: string; reasoning?: string };
        },
    )
    .filter((data) => data.event === 'content-block-delta' && data.delta?.type === type)
    .map((data) => (type === 'text-delta' ? data.delta?.text : data.delta?.reasoning) ?? '')
    .join('');
}

/**
 * 畫面上看得到的那幾格。`messageId` 不比：日誌裡那半段是新建的一則、沒有 id（#382，
 * `turn-cancel-openai.test.ts` 釘著），即時那則手上的是串流那次呼叫的。
 */
function aiView(frames: readonly Event[]) {
  return frames
    .reduce(reduceConversation, emptyConversation())
    .entries.filter((entry): entry is AiEntry => entry.kind === 'ai')
    .map(({ text, reasoning, streaming, stopped, turnTail }) => ({
      text,
      reasoning,
      streaming,
      stopped,
      turnTail,
    }));
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

const CALL_NOOP = {
  tool_calls: [
    { index: 0, id: 'call-noop', type: 'function', function: { name: 'noop', arguments: '{}' } },
  ],
};

/** 串到 `ready` 成立就按停止，回傳收尾之後的現場。 */
async function stopWhen(
  scripts: readonly (readonly Record<string, unknown>[])[],
  ready: (frames: readonly Event[]) => boolean,
) {
  const upstream = await slowOpenAi(scripts);
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
  const agent = built.agent as unknown as PumpAgent;
  const pump = new ThreadPump(agent, 'interrupted-reasoning');
  const detach = built.attachSession(pump.sessions);
  const frames: Event[] = [];
  const line = new AbortController();
  const stream = pump.subscribe(['messages', 'lifecycle'], line.signal);
  const draining = (async () => {
    for await (const frame of stream) frames.push(frame);
  })();
  const turn = pump.submit({ kind: 'message', text: '想一想再說' });
  await until(() => ready(frames));
  expect(pump.cancel()).toBe('run');
  await turn;
  const interrupted = pump.sessions.root.events
    .filter((event) => event.type === 'assistant/message')
    .map((event) => event.data as SessionEventMap['assistant/message'])
    .filter((data) => data.interrupted === true);
  return {
    upstream,
    agent,
    pump,
    frames,
    interrupted,
    history: () => historyFrames(pump.sessions.root.events, DEFAULT_TOOL_TEXT_MAX_BYTES),
    async close() {
      line.abort();
      await draining;
      detach();
      await built.dispose();
      await upstream.close();
    },
  };
}

const blocksOf = (data: SessionEventMap['assistant/message']) => data.message.data.content;

describe('按了停止的那則，推理在重新整理之後還在（#561）', () => {
  it('停在推理階段：那則留下來、只有推理；下一輪以 content: [] 送出去照常收尾', async () => {
    const run = await stopWhen(
      [[...THINK].map((reasoning_content) => ({ reasoning_content }))],
      (frames) => onWire(frames, 'reasoning-delta').length >= 3,
    );
    try {
      // 前提：停的時候線上有推理、沒有正文，上游也還沒吐完。
      const shown = onWire(run.frames, 'reasoning-delta');
      expect(shown.length).toBeGreaterThanOrEqual(3);
      expect(onWire(run.frames, 'text-delta')).toBe('');
      expect(run.upstream.sent[0]).toBeLessThan(THINK.length);

      // 日誌那顆真的帶著推理——少了這一句，兩邊都沒有推理也會相等。
      expect(run.interrupted).toHaveLength(1);
      expect(blocksOf(run.interrupted[0]!)).toEqual([{ type: 'reasoning', reasoning: shown }]);
      expect(loggedMessageId(run.interrupted[0]!.message)).toBeUndefined();

      // 不是 `turnTail`：那格判的是「正文非空的最後一則」（`@nexus/wire`），兩條路判得一樣。
      const live = aiView(run.frames);
      expect(live).toEqual([
        { text: '', reasoning: shown, streaming: false, stopped: true, turnTail: undefined },
      ]);
      expect(aiView(run.history())).toEqual(live);

      // 下一輪：那則以 `content: []` 送出去（`ChatOpenAI` 丟推理區塊），這一輪照常收尾。
      await run.pump.submit({ kind: 'message', text: '繼續' });
      expect(run.upstream.assistants[1]).toEqual([{ role: 'assistant', content: [] }]);
      const state = await run.agent.getState({
        configurable: { thread_id: 'interrupted-reasoning' },
      });
      const last = ((state.values as { messages: unknown[] }).messages ?? []).at(-1);
      expect(AIMessage.isInstance(last) && last.text).toBe('好。');
    } finally {
      await run.close();
    }
  });

  it('停在正文階段：正文與推理都留下來', async () => {
    const run = await stopWhen(
      [
        [
          { reasoning_content: '先想' },
          { reasoning_content: '一下' },
          ...[...SAY].map((content) => ({ content })),
        ],
      ],
      (frames) => onWire(frames, 'text-delta').length >= 3,
    );
    try {
      const said = onWire(run.frames, 'text-delta');
      expect(onWire(run.frames, 'reasoning-delta')).toBe('先想一下');
      expect(said.length).toBeGreaterThanOrEqual(3);
      expect(run.upstream.sent[0]).toBeLessThan(2 + SAY.length);

      expect(run.interrupted).toHaveLength(1);
      expect(blocksOf(run.interrupted[0]!)).toEqual([
        { type: 'reasoning', reasoning: '先想一下' },
        { type: 'text', text: said },
      ]);

      const live = aiView(run.frames);
      expect(live).toEqual([
        { text: said, reasoning: '先想一下', streaming: false, stopped: true, turnTail: true },
      ]);
      expect(aiView(run.history())).toEqual(live);
    } finally {
      await run.close();
    }
  });

  it('多步之後才停：上一步講完的推理不會混進被停下的這一則', async () => {
    // 我們預設的模型每一步都是「推理加工具呼叫」（#527），所以被停下的那則前面通常已經有講完的幾則。
    const run = await stopWhen(
      [
        [{ reasoning_content: '上一步' }, CALL_NOOP],
        [...THINK].map((reasoning_content) => ({ reasoning_content })),
      ],
      (frames) => onWire(frames, 'reasoning-delta').length >= '上一步'.length + 3,
    );
    try {
      const shown = onWire(run.frames, 'reasoning-delta').slice('上一步'.length);
      expect(onWire(run.frames, 'reasoning-delta').startsWith('上一步')).toBe(true);
      expect(shown.length).toBeGreaterThanOrEqual(3);
      expect(run.upstream.sent[1]).toBeLessThan(THINK.length);

      expect(run.interrupted).toHaveLength(1);
      expect(blocksOf(run.interrupted[0]!)).toEqual([{ type: 'reasoning', reasoning: shown }]);

      const live = aiView(run.frames);
      expect(live.map(({ reasoning, stopped }) => ({ reasoning, stopped }))).toEqual([
        { reasoning: '上一步', stopped: undefined },
        { reasoning: shown, stopped: true },
      ]);
      expect(aiView(run.history())).toEqual(live);
    } finally {
      await run.close();
    }
  });

  it('只送出空白：推理與正文都只有空白時整則不留（同 dsh 逐塊 trim）', async () => {
    const run = await stopWhen(
      [
        [
          { reasoning_content: ' ' },
          { reasoning_content: '\n' },
          ...Array.from({ length: 20 }, () => ({ content: ' ' })),
        ],
      ],
      (frames) => onWire(frames, 'text-delta').length >= 2,
    );
    try {
      expect(onWire(run.frames, 'reasoning-delta')).toBe(' \n');
      expect(onWire(run.frames, 'text-delta').length).toBeGreaterThanOrEqual(2);
      expect(run.upstream.sent[0]).toBeLessThan(22);

      expect(run.interrupted).toEqual([]);
      const state = await run.agent.getState({
        configurable: { thread_id: 'interrupted-reasoning' },
      });
      const messages = (state.values as { messages: unknown[] }).messages ?? [];
      expect(messages.filter((message) => AIMessage.isInstance(message))).toEqual([]);
    } finally {
      await run.close();
    }
  });
});
