import { describe, expect, it } from 'vitest';
import { createWireClient } from './client.js';
import { WIRE_CHANNELS, errorResponse, successResponse } from './protocol.js';
import { encodeSseFrame } from './sse.js';
import type { Event } from './protocol.js';

/**
 * 瀏覽器那一端。
 *
 * 這裡不需要 agent——驗的是 client 送出去的東西長什麼樣：路徑、media type、封包。
 * server 端那一半在 `@nexus/harness` 的 `wire.test.ts`，兩邊各驗各的，中間靠這份
 * 共用的協定接起來。
 */

interface Seen {
  readonly url: string;
  readonly contentType: string | null;
  readonly body: unknown;
}

function stub(respond: (seen: Seen) => Response) {
  const calls: Seen[] = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const seen: Seen = {
      url: String(input),
      contentType: new Headers(init?.headers).get('content-type'),
      body: JSON.parse(String(init?.body)),
    };
    calls.push(seen);
    return respond(seen);
  };
  return { calls, client: createWireClient({ baseUrl: 'http://agent.test/', fetch: fetchImpl }) };
}

function sseResponse(events: readonly Event[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(new TextEncoder().encode(encodeSseFrame(event)));
      }
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

const FRAME = {
  type: 'event',
  seq: 0,
  event_id: 't:0',
  method: 'lifecycle',
  params: { namespace: [], timestamp: 0, data: { event: 'running', graph_name: 'root' } },
} as Event;

describe('瀏覽器端的 client', () => {
  it('上行走路徑指名的 method，而且封包裡也帶同一個', async () => {
    const { calls, client } = stub(() => Response.json(successResponse(1, { run_id: 'r1' })));
    await client.runStart('t 1', '哈囉');
    await client.inputRespond('t 1', { namespace: [], interrupt_id: 'i1', response: { ok: true } });

    expect(calls[0]?.url).toBe('http://agent.test/threads/t%201/commands/run.start');
    expect(calls[0]?.contentType).toBe('application/json');
    expect(calls[0]?.body).toMatchObject({ id: 1, method: 'run.start' });
    expect(calls[1]?.url).toBe('http://agent.test/threads/t%201/commands/input.respond');
    // 封包 id 是遞增的，回應才對得回哪一個命令。
    expect(calls[1]?.body).toMatchObject({ id: 2, method: 'input.respond' });
  });

  it('下行預設訂全部放行的 channel，回來的是解好的封包', async () => {
    const { calls, client } = stub(() => sseResponse([FRAME]));
    const events = await client.openEvents('t2');
    const collected: Event[] = [];
    for await (const event of events) {
      collected.push(event);
    }
    expect(calls[0]?.url).toBe('http://agent.test/threads/t2/stream');
    expect(calls[0]?.body).toEqual({ channels: [...WIRE_CHANNELS] });
    expect(collected).toEqual([FRAME]);
  });

  it('協定層的拒絕拿得到原因，不是一條空的串流', async () => {
    const { client } = stub(() =>
      Response.json(errorResponse(null, 'not_supported', '不支援 since')),
    );
    await expect(client.openEvents('t3')).rejects.toThrow('不支援 since');
  });

  it('載體層的錯照 status 報出來', async () => {
    const { client } = stub(
      () => new Response('content type must be application/json', { status: 415 }),
    );
    await expect(client.openEvents('t4')).rejects.toThrow('415');
    const commands = stub(() => new Response('not found', { status: 404 }));
    await expect(commands.client.runStart('t4', '哈囉')).rejects.toThrow('404');
  });

  it('斜線命令走同一條 RPC family，路徑與封包各講一次 method', async () => {
    const { calls, client } = stub((seen) =>
      Response.json(
        String(seen.url).endsWith('slash.list')
          ? successResponse(1, { commands: [{ name: 'plan', description: '進出計劃模式' }] })
          : successResponse(2, { kind: 'success', command_id: 'cmd-1', text: '開了。' }),
      ),
    );

    expect(await client.slashList('t5')).toEqual({
      kind: 'ok',
      commands: [{ name: 'plan', description: '進出計劃模式' }],
    });
    expect(await client.slashRun('t5', '/plan')).toEqual({
      kind: 'success',
      command_id: 'cmd-1',
      text: '開了。',
    });

    expect(calls[0]?.url).toBe('http://agent.test/threads/t5/commands/slash.list');
    expect(calls[0]?.body).toEqual({ id: 1, method: 'slash.list' });
    expect(calls[1]?.url).toBe('http://agent.test/threads/t5/commands/slash.run');
    // **原文原樣送過去**：要不要 trim 是命令自己的文法決定的。
    expect(calls[1]?.body).toEqual({ id: 2, method: 'slash.run', params: { line: '/plan' } });
  });

  it('這條線拒絕發派與命令自己失敗，回來的是兩種形狀', async () => {
    const refused = stub(() =>
      Response.json(errorResponse(1, 'invalid_argument', '這條 thread 正在跑')),
    );
    expect(await refused.client.slashRun('t6', '/plan')).toEqual({
      kind: 'rejected',
      message: '這條 thread 正在跑',
    });

    // 命令自己失敗是**成功的發派**，所以它走 200 ＋ success 封包。
    const failed = stub(() =>
      Response.json(successResponse(1, { kind: 'error', command_id: 'cmd-2', text: '參數不對。' })),
    );
    expect(await failed.client.slashRun('t6', '/plan of')).toEqual({
      kind: 'error',
      command_id: 'cmd-2',
      text: '參數不對。',
    });

    // 拋錯路徑上沒有 command_id（執行器往外拋的是 handler 原本那顆錯誤）——**那不是
    // 壞掉的結果**，所以 client 收得下。
    const thrown = stub(() => Response.json(successResponse(1, { kind: 'error', text: '炸了。' })));
    expect(await thrown.client.slashRun('t6', '/boom')).toEqual({ kind: 'error', text: '炸了。' });
  });

  it('認不得的一行不是錯誤，是三值裡的 unknown', async () => {
    const { client } = stub(() => Response.json(successResponse(1, { kind: 'unknown' })));
    expect(await client.slashRun('t7', '/nope')).toEqual({ kind: 'unknown' });
  });

  it('線上回了認不得的形狀就當場說，不是靜靜當成別的東西', async () => {
    const badKind = stub(() => Response.json(successResponse(1, { kind: 'ok' })));
    await expect(badKind.client.slashRun('t8', '/plan')).rejects.toThrow('不認得的 kind');
    const noList = stub(() => Response.json(successResponse(1, {})));
    await expect(noList.client.slashList('t8')).rejects.toThrow('沒有 commands 陣列');
    const badDescriptor = stub(() => Response.json(successResponse(1, { commands: [{}] })));
    await expect(badDescriptor.client.slashList('t8')).rejects.toThrow('不認得的 descriptor');
  });
});
