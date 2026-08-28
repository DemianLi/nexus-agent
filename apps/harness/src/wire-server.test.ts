import { tool } from '@langchain/core/tools';
import { createWireClient } from '@nexus/wire';
import type { Event } from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import { startWireServer } from './wire-server.js';
import type { WireServer } from './wire-server.js';

/**
 * 一次真的 loopback 往返。
 *
 * 其餘的協定行為都在 `wire.test.ts` 裡用 `(Request) => Response` 驗完了，不需要 socket；
 * 這一條驗的是**只有真的 socket 才驗得到的那一段**：`node:http` 的 stream 翻成 fetch
 * 型別、SSE 的 chunk 真的一顆一顆推出去而不是積到最後才吐。不需要任何憑證或外部服務
 * ——loopback 上自己開一個 port 就夠（[#31](https://github.com/DemianLi/nexus-agent/issues/31)）。
 */

let running: WireServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

describe('接上真的 socket', () => {
  it('開線就先吐一行 SSE 註解，代理層才不會把 header 壓著', async () => {
    const agent = createDeepAgent({
      model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
      tools: [],
      backend: new StateBackend(),
    }) as unknown as PumpAgent;
    const handler = createWireHandler({
      createAgent: async () => ({ agent, dispose: async () => undefined }),
    });
    running = await startWireServer({ handler });

    // 用裸 fetch 讀原始位元組——**這一條驗的是「還沒有任何封包時線上就有東西」**。
    // 少了它，直連看起來一切正常，而經過 dev server 的 proxy 就永遠停在「連線中」。
    const response = await fetch(`${running.url}/threads/prelude/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channels: ['lifecycle'] }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(': connected\n\n');
    await reader.cancel();
    await handler.close();
  });

  it('SSE 是邊跑邊推，不是收工才一次吐完', async () => {
    // 工具在這裡卡住，直到測試放行為止——**「串流」與「一次吐完」的差別因此是可判定的**，
    // 不必靠時間或運氣。
    let release = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];

    const agent = createDeepAgent({
      model: new ScriptedChatModel({
        turns: [
          { content: '我來記。', toolCalls: [{ name: 'take_note', args: { text: '第一筆' } }] },
          { content: '記好了。' },
        ],
      }),
      tools: [
        tool(
          async ({ text }: { text: string }) => {
            await blocked;
            calls.push(text);
            return `已記下：${text}`;
          },
          {
            name: 'take_note',
            description: '記一段文字。',
            schema: z.object({ text: z.string() }),
          },
        ),
      ],
      backend: new StateBackend(),
    }) as unknown as PumpAgent;

    const handler = createWireHandler({
      createAgent: async () => ({ agent, dispose: async () => undefined }),
    });
    running = await startWireServer({ handler });
    // 這裡刻意用全域的 fetch，不注入——走的是真的 HTTP。
    const client = createWireClient({ baseUrl: running.url });

    const events = await client.openEvents('socket', {
      channels: ['messages', 'tools', 'lifecycle'],
    });
    await client.runStart('socket', '記一筆。');

    const frames: Event[] = [];
    async function collectUntil(done: (collected: readonly Event[]) => boolean): Promise<void> {
      while (!done(frames)) {
        const next = await events.next();
        if (next.done === true) {
          return;
        }
        frames.push(next.value);
      }
    }

    // 工具還卡著的時候，前半段的 frame 已經越過 socket 到手了。
    await collectUntil((collected) =>
      collected.some(
        (frame) =>
          frame.method === 'tools' &&
          (frame.params.data as { event?: string }).event === 'tool-started',
      ),
    );
    expect(calls).toEqual([]);
    expect(
      frames
        .filter((frame) => frame.method === 'messages')
        .map((frame) => (frame.params.data as { delta?: { text?: string } }).delta?.text)
        .join(''),
    ).toBe('我來記。');

    release();
    await collectUntil((collected) =>
      collected.some((frame) => {
        const data = frame.params.data as { event?: string; graph_name?: string };
        return (
          frame.method === 'lifecycle' && data.event === 'completed' && data.graph_name === 'root'
        );
      }),
    );

    expect(calls).toEqual(['第一筆']);
    expect(
      frames
        .filter((frame) => frame.method === 'tools')
        .map((frame) => (frame.params.data as { tool_name?: string }).tool_name),
    ).toContain('take_note');
    handler.close();
  });
});
