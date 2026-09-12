/**
 * **真的 `ChatOpenAI` 串到一半按停止：上游請求真的被切斷，使用者看到的那半段回到對話。**
 * [#276](https://github.com/DemianLi/nexus-agent/issues/276)。
 *
 * ## 為什麼一定要真的 `ChatOpenAI`
 *
 * 綁中止訊號的那一格靠的是一個供應商 client 的 quirk：`ChatOpenAI.withConfig` 重建實例、把選項塞進
 * `defaultOptions`，而模型節點呼叫時明著傳的 `signal: undefined` 會把它蓋掉
 * （`@langchain/openai@1.5.10` `chat_models/index.js:605`，見 `@nexus/core` 的 `turn-cancel.ts`）。
 * **假模型重現不了這件事**：拿假模型測，哪天有人把包裝「簡化」回 `withConfig`，這一格照樣綠，
 * 中止在真的供應商上靜靜失效。所以判準量在 HTTP 那一層：按了停止之後，伺服器送出的字數停住不動。
 *
 * 半段文字那一半同理：產品路徑的 `streamEvents` v3 上，逐字片段不經過模型層的回呼，只有 pump
 * 看得到（實測），所以要走真的 pump。
 *
 * **零憑證**：對手方是本機的假 SSE 端點，照 OpenAI Chat Completions 的串流格式每 40ms 吐一個字。
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AIMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { INTERRUPTED_REPLY_MARKER } from '@nexus/core';
import type { SessionEvent } from '@nexus/core';
import type { Event } from '@nexus/wire';
import { describe, expect, it } from 'vitest';
import { createNexusAgent } from './agent-factory.js';
import { ThreadPump } from './thread-pump.js';
import type { PumpAgent } from './thread-pump.js';

const FULL = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉';

/** 一個會慢慢吐字的 OpenAI 相容端點，記下每一次請求與它送出了多少。 */
async function slowOpenAi() {
  const requests: { role: string; content: string }[][] = [];
  const sent: number[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
      const index = requests.length;
      requests.push(
        (parsed.messages ?? []).map((message) => ({
          role: message.role,
          content: String(message.content),
        })),
      );
      sent.push(0);
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: 'c',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '' }));
      let at = 0;
      const tick = setInterval(() => {
        if (res.destroyed) return clearInterval(tick);
        if (at < FULL.length) {
          res.write(chunk({ content: FULL[at] }));
          at += 1;
          sent[index] = at;
          return;
        }
        clearInterval(tick);
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
      }, 40);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
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

/** root 那一層、已經上了線的文字片段，照順序接起來——就是瀏覽器畫出來的那些字。 */
function rootTextOnWire(frames: readonly Event[]): string {
  return frames
    .filter((frame) => frame.method === 'messages' && frame.params.namespace.length <= 1)
    .map(
      (frame) => frame.params.data as { event?: string; delta?: { type?: string; text?: string } },
    )
    .filter((data) => data.event === 'content-block-delta' && data.delta?.type === 'text-delta')
    .map((data) => data.delta?.text ?? '')
    .join('');
}

describe('真的 ChatOpenAI 串到一半按停止', () => {
  it('上游請求被切斷；使用者看到的那半段回到對話，下一輪的請求帶著它', async () => {
    const upstream = await slowOpenAi();
    const built = await createNexusAgent({
      model: new ChatOpenAI({
        model: 'fake',
        apiKey: 'sk-loopback',
        maxRetries: 0,
        configuration: { baseURL: upstream.baseURL },
      }),
      checkpointer: new MemorySaver(),
      plugins: [],
    });
    const agent = built.agent as unknown as PumpAgent;
    const pump = new ThreadPump(agent, 'openai-cancel');
    const detach = built.attachSession(pump.sessions);
    const frames: Event[] = [];
    const line = new AbortController();
    const stream = pump.subscribe(['messages', 'lifecycle'], line.signal);
    const draining = (async () => {
      for await (const frame of stream) frames.push(frame);
    })();
    try {
      const turn = pump.submit({ kind: 'message', text: '說一串' });
      await until(() => rootTextOnWire(frames).length >= 3);
      expect(pump.cancel()).toBe('run');
      await turn;

      // **判準在 HTTP 那一層**：包裝換回 `withConfig` 的話，這一串會吐完 20 個字。
      // 看的是「送出的字數停住」，不是 `close` 事件（實測那個時刻不可靠）：伺服器那側只在連線被毀掉時
      // 才停寫，所以停住才證得了連線真的被切斷，不只是我們不讀了。
      const sentAtStop = upstream.sent[0] ?? 0;
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(upstream.sent[0]).toBe(sentAtStop);
      expect(sentAtStop).toBeLessThan(FULL.length);

      const events: readonly SessionEvent[] = pump.sessions.root.events;
      expect(events.at(-1)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted', cause: { kind: 'user' } } },
      });
      // 被切斷的那次照樣是一步：起訖一對，同 dsh 被取消的步照樣算。
      const types = events.map((event) => event.type);
      expect(types.filter((type) => type === 'model/start')).toHaveLength(1);
      expect(types.filter((type) => type === 'model/end')).toHaveLength(1);

      // 回到對話的那半段，逐字等於瀏覽器畫出來的那些。
      const shown = rootTextOnWire(frames);
      const state = await agent.getState({ configurable: { thread_id: 'openai-cancel' } });
      const last = ((state.values as { messages: unknown[] }).messages ?? []).at(-1);
      expect(AIMessage.isInstance(last)).toBe(true);
      expect((last as AIMessage).text).toBe(shown);
      expect((last as AIMessage).additional_kwargs[INTERRUPTED_REPLY_MARKER]).toBe(true);

      // 下一輪：送出去的請求依序是那句話、那半段、這句話。
      await pump.submit({ kind: 'message', text: '繼續' });
      const second = upstream.requests[1] ?? [];
      expect(second.filter((message) => message.role !== 'system')).toEqual([
        { role: 'user', content: '說一串' },
        { role: 'assistant', content: shown },
        { role: 'user', content: '繼續' },
      ]);
    } finally {
      line.abort();
      await draining;
      detach();
      await built.dispose();
      await upstream.close();
    }
  });
});
