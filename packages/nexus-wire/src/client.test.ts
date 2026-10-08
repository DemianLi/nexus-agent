import { describe, expect, expectTypeOf, it } from 'vitest';
import { createWireClient } from './client.js';
import type { UplinkResult } from './client.js';
import { WIRE_CHANNELS, errorResponse, successResponse } from './protocol.js';
import { encodeSseFrame } from './sse.js';
import type { Event, WireErrorCode, WireErrorResponse } from './protocol.js';

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

describe('GET /threads 的釘選與封存集合（#633）', () => {
  const row = { threadId: 'a', updatedAt: 1, running: false, blank: false };
  const listWith = async (extra: Record<string, unknown>) => {
    // GET 沒有 body，`stub` 的 JSON.parse 吃不下，直接給 fetch 替身。
    const client = createWireClient({
      baseUrl: 'http://agent.test/',
      fetch: async () =>
        Response.json({ type: 'success', result: { items: [row], unreadable: 0, ...extra } }),
    });
    const outcome = await client.listThreads();
    if (outcome.kind !== 'ok') throw new Error('應該是 ok');
    return outcome.result;
  };

  it('兩格都是字串陣列就原樣帶出來，順序不動', async () => {
    const result = await listWith({ pinnedThreadIds: ['b', 'a'], archivedThreadIds: ['c'] });
    expect(result.pinnedThreadIds).toEqual(['b', 'a']);
    expect(result.archivedThreadIds).toEqual(['c']);
  });

  it('空陣列也帶：空集合不是缺席', async () => {
    const result = await listWith({ pinnedThreadIds: [], archivedThreadIds: [] });
    expect(result.pinnedThreadIds).toEqual([]);
    expect(result.archivedThreadIds).toEqual([]);
  });

  it('沒送、或不是字串陣列的那一格就省略（不帶 key），另一格不受影響', async () => {
    const absent = await listWith({});
    expect(absent).not.toHaveProperty('pinnedThreadIds');
    expect(absent).not.toHaveProperty('archivedThreadIds');
    for (const bad of [null, 'a', 3, { 0: 'a' }, ['a', 1], [null]]) {
      const result = await listWith({ pinnedThreadIds: bad, archivedThreadIds: ['c'] });
      expect(result).not.toHaveProperty('pinnedThreadIds');
      expect(result.archivedThreadIds).toEqual(['c']);
    }
  });
});

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

  it('中止這一輪走同一條 RPC family：路徑與封包各講一次 run.cancel，不帶 params', async () => {
    const { calls, client } = stub(() => Response.json(successResponse(1, { accepted: true })));
    const result = await client.runCancel('t 1');
    expect(calls[0]?.url).toBe('http://agent.test/threads/t%201/commands/run.cancel');
    expect(calls[0]?.body).toEqual({ id: 1, method: 'run.cancel' });
    expect(result).toMatchObject({ type: 'success', result: { accepted: true } });
  });

  it('改刪送出佇列走同一條 RPC family：路徑與封包各講一次 queue.update，params 原樣帶上', async () => {
    const { calls, client } = stub(() => Response.json(successResponse(1, { accepted: true })));
    const result = await client.queueUpdate('t 1', {
      item_id: 'r1',
      action: { kind: 'edit', text: '改過' },
    });
    await client.queueUpdate('t 1', { item_id: 'r2', action: { kind: 'remove' } });
    expect(calls[0]?.url).toBe('http://agent.test/threads/t%201/commands/queue.update');
    expect(calls[0]?.body).toEqual({
      id: 1,
      method: 'queue.update',
      params: { item_id: 'r1', action: { kind: 'edit', text: '改過' } },
    });
    expect(calls[1]?.body).toEqual({
      id: 2,
      method: 'queue.update',
      params: { item_id: 'r2', action: { kind: 'remove' } },
    });
    expect(result).toMatchObject({ type: 'success', result: { accepted: true } });
  });

  it('對單一背景子代理傳話與單獨停同一條 RPC family：路徑與封包各講一次 method，run_id 與 text 原樣帶上', async () => {
    const { calls, client } = stub(() => Response.json(successResponse(1, { accepted: true })));
    const sent = await client.subagentSend('t 1', 'bg-1', '  改看 b.ts\n');
    const stopped = await client.subagentInterrupt('t 1', 'bg-1');
    expect(calls[0]?.url).toBe('http://agent.test/threads/t%201/commands/subagent.send');
    expect(calls[0]?.body).toEqual({
      id: 1,
      method: 'subagent.send',
      params: { run_id: 'bg-1', text: '  改看 b.ts\n' },
    });
    expect(calls[1]?.url).toBe('http://agent.test/threads/t%201/commands/subagent.interrupt');
    expect(calls[1]?.body).toEqual({
      id: 2,
      method: 'subagent.interrupt',
      params: { run_id: 'bg-1' },
    });
    expect(sent).toMatchObject({ type: 'success', result: { accepted: true } });
    expect(stopped).toMatchObject({ type: 'success', result: { accepted: true } });
  });

  it('背景子代理的歷史走自己的路徑與同一套查詢；回來的一頁同 threadHistory，找不到是 rejected', async () => {
    const urls: string[] = [];
    const page = { events: [], firstSeq: 0, throughSeq: 0, hasMore: false, legacy: false };
    const client = createWireClient({
      baseUrl: 'http://agent.test/',
      fetch: async (input) => {
        urls.push(String(input));
        return String(input).includes('bg-gone')
          ? Response.json(errorResponse(null, 'subagent_not_found', '沒有這個子代理'))
          : Response.json({ type: 'success', result: page });
      },
    });
    const ok = await client.subagentHistory('t 1', 'bg-0123456789ab', { maxMessages: 5 });
    const missing = await client.subagentHistory('t 1', 'bg-gone');
    expect(urls[0]).toBe(
      'http://agent.test/threads/t%201/subagents/bg-0123456789ab/history?maxMessages=5',
    );
    expect(urls[1]).toBe('http://agent.test/threads/t%201/subagents/bg-gone/history');
    expect(ok).toEqual({ kind: 'ok', result: page });
    expect(missing).toEqual({
      kind: 'rejected',
      code: 'subagent_not_found',
      message: '沒有這個子代理',
    });
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

  it('斜線命令帶附件（#732）：descriptor 的 input.attachments 照實讀回；slashRun 的 attachments 非空才送', async () => {
    const { calls, client } = stub((seen) =>
      Response.json(
        String(seen.url).endsWith('slash.list')
          ? successResponse(1, {
              commands: [
                {
                  name: 'goal',
                  description: '目標',
                  input: { hint: '[<目標>]', attachments: true },
                },
                { name: 'plan', description: '計劃', input: { hint: '[off]', attachments: false } },
                { name: 'x', description: 'x', input: { hint: 'h', attachments: 'yes' } },
              ],
            })
          : successResponse(2, { kind: 'success', command_id: 'cmd-1' }),
      ),
    );
    const listed = await client.slashList('t5');
    expect(listed).toEqual({
      kind: 'ok',
      commands: [
        { name: 'goal', description: '目標', input: { hint: '[<目標>]', attachments: true } },
        { name: 'plan', description: '計劃', input: { hint: '[off]' } },
        { name: 'x', description: 'x', input: { hint: 'h' } },
      ],
    });
    const file = { type: 'file', receiptId: 'r1' } as const;
    await client.slashRun('t5', '/goal 目標', [file]);
    await client.slashRun('t5', '/goal 目標', []);
    expect(calls[1]?.body).toEqual({
      id: 2,
      method: 'slash.run',
      params: { line: '/goal 目標', attachments: [file] },
    });
    expect(calls[2]?.body).toEqual({ id: 3, method: 'slash.run', params: { line: '/goal 目標' } });
  });

  it('這條線拒絕發派與命令自己失敗，回來的是兩種形狀', async () => {
    const refused = stub(() =>
      Response.json(errorResponse(1, 'invalid_argument', '這條 thread 正在跑')),
    );
    expect(await refused.client.slashRun('t6', '/plan')).toEqual({
      kind: 'rejected',
      code: 'invalid_argument',
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

describe('列檔（#651）', () => {
  it('GET 路徑掛在 thread 底下，query 原文帶上，帶 JSON header 與呼叫者的 signal', async () => {
    const seen: { url: string; method?: string; type: string | null; signal?: AbortSignal }[] = [];
    const client = createWireClient({
      baseUrl: 'http://agent.test/',
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          method: init?.method,
          type: new Headers(init?.headers).get('content-type'),
          signal: init?.signal ?? undefined,
        });
        return Response.json(
          successResponse(0, {
            available: true,
            candidates: [{ path: '/a b/c.ts', kind: 'file' }],
          }),
        );
      },
    });
    const controller = new AbortController();
    const outcome = await client.fileReferences('t 1', '/a b/c', controller.signal);
    expect(seen).toEqual([
      {
        url: 'http://agent.test/threads/t%201/file-references?query=%2Fa+b%2Fc',
        method: 'GET',
        type: 'application/json',
        signal: controller.signal,
      },
    ]);
    expect(outcome).toEqual({
      kind: 'ok',
      result: { available: true, candidates: [{ path: '/a b/c.ts', kind: 'file' }] },
    });
  });

  it('「不提供」與協定層的拒絕是兩種形狀', async () => {
    const reply = (body: unknown) =>
      createWireClient({ baseUrl: 'http://agent.test', fetch: async () => Response.json(body) });
    expect(await reply(successResponse(0, { available: false })).fileReferences('t', '')).toEqual({
      kind: 'ok',
      result: { available: false },
    });
    expect(
      await reply(errorResponse(null, 'unknown_error', '建不起來')).fileReferences('t', ''),
    ).toEqual({ kind: 'rejected', code: 'unknown_error', message: '建不起來' });
  });
});

describe('列會話候選（#713）', () => {
  const candidate = {
    sessionId: 's/1',
    label: '標題',
    cwd: '/專案',
    sameWorkspace: true,
    createdAt: 1,
    updatedAt: 2,
    parentSessionId: 'p',
    parentLabel: '父',
    mention: '@[標題](nexus-session:x)',
  };

  it('GET 路徑掛在 thread 底下，query 原文帶上，帶 JSON header 與呼叫者的 signal', async () => {
    const seen: { url: string; method?: string; type: string | null; signal?: AbortSignal }[] = [];
    const client = createWireClient({
      baseUrl: 'http://agent.test/',
      fetch: async (input, init) => {
        seen.push({
          url: String(input),
          method: init?.method,
          type: new Headers(init?.headers).get('content-type'),
          signal: init?.signal ?? undefined,
        });
        return Response.json(
          successResponse(0, {
            available: true,
            candidates: [
              candidate,
              {
                ...candidate,
                sessionId: 'n',
                cwd: undefined,
                parentSessionId: undefined,
                parentLabel: undefined,
              },
            ],
          }),
        );
      },
    });
    const controller = new AbortController();
    const outcome = await client.sessionReferences('t 1', '標 題', controller.signal);
    expect(seen).toEqual([
      {
        url: 'http://agent.test/threads/t%201/session-references?query=%E6%A8%99+%E9%A1%8C',
        method: 'GET',
        type: 'application/json',
        signal: controller.signal,
      },
    ]);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok' || !outcome.result.available) throw new Error('不該走到這裡');
    expect(outcome.result.candidates[0]).toEqual(candidate);
    // 選填的欄位沒有就是沒有這個鍵，不是 undefined。
    expect(Object.keys(outcome.result.candidates[1] ?? {})).not.toContain('cwd');
    expect(Object.keys(outcome.result.candidates[1] ?? {})).not.toContain('parentSessionId');
  });

  it('「不提供」與協定層的拒絕是兩種形狀', async () => {
    const reply = (body: unknown) =>
      createWireClient({ baseUrl: 'http://agent.test', fetch: async () => Response.json(body) });
    expect(
      await reply(successResponse(0, { available: false })).sessionReferences('t', ''),
    ).toEqual({
      kind: 'ok',
      result: { available: false },
    });
    expect(
      await reply(errorResponse(null, 'unknown_error', '讀不了')).sessionReferences('t', ''),
    ).toEqual({ kind: 'rejected', code: 'unknown_error', message: '讀不了' });
  });

  it.each([
    { ...candidate, sessionId: 1 },
    { ...candidate, sameWorkspace: 'yes' },
    { ...candidate, cwd: 3 },
    { ...candidate, mention: undefined },
    null,
  ])('形狀不對的候選整個拒絕：%j', async (bad) => {
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => Response.json(successResponse(0, { available: true, candidates: [bad] })),
    });
    await expect(client.sessionReferences('t', '')).rejects.toThrow('不認得的候選');
  });
});

describe('被拒時把 server 的錯誤碼交給呼叫端（#764）', () => {
  // 每個會回 `rejected` 的方法一列：server 回什麼碼，呼叫端就拿到什麼碼，原樣、不改寫。
  // 回的碼刻意用每個方法不會自己合成的那一個，這樣「碼從哪來」只有一個答案。
  const rejectedCalls: readonly (readonly [
    string,
    (client: ReturnType<typeof createWireClient>) => Promise<unknown>,
  ])[] = [
    ['slashList', (c) => c.slashList('t')],
    ['slashRun', (c) => c.slashRun('t', '/plan')],
    ['feedbackPut', (c) => c.feedbackPut('t', {} as never)],
    ['feedbackDelete', (c) => c.feedbackDelete('t', {} as never)],
    ['feedbackList', (c) => c.feedbackList('t')],
    ['feedbackRecord', (c) => c.feedbackRecord('t', {} as never)],
    ['listThreads', (c) => c.listThreads()],
    ['searchThreads', (c) => c.searchThreads('q')],
    ['threadHistory', (c) => c.threadHistory('t')],
    ['subagentHistory', (c) => c.subagentHistory('t', 'bg-0123456789ab')],
    ['trajectoryTurn', (c) => c.trajectoryTurn('t', {} as never)],
    ['fileReferences', (c) => c.fileReferences('t', '')],
    ['sessionReferences', (c) => c.sessionReferences('t', '')],
  ];

  it.each(rejectedCalls)('%s 被拒時帶 server 的碼與原因', async (_name, call) => {
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => Response.json(errorResponse(1, 'not_supported', '這個部署沒開')),
    });
    expect(await call(client)).toEqual({
      kind: 'rejected',
      code: 'not_supported',
      message: '這個部署沒開',
    });
  });

  it('server 的錯誤缺 `error` 欄位時沒有碼，不拿字串頂；上行與 GET 兩條路都一樣', async () => {
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => Response.json({ type: 'error', id: 1, message: '沒說碼' }),
    });
    for (const outcome of [await client.slashList('t'), await client.listThreads()]) {
      expect(outcome).toEqual({ kind: 'rejected', message: '沒說碼' });
      expect(outcome).not.toHaveProperty('code');
    }
  });

  it('client 自己合成的拒絕（回饋的回應看不懂）沒有碼，不假造一個', async () => {
    const client = createWireClient({
      baseUrl: 'http://agent.test',
      fetch: async () => Response.json(successResponse(1, { nope: true })),
    });
    const outcome = await client.feedbackList('t');
    expect(outcome.kind).toBe('rejected');
    expect(outcome).not.toHaveProperty('code');
  });
});

/**
 * 型別層的釘子（[#1166](https://github.com/DemianLi/nexus-agent/issues/1166)）：`WireErrorResponse` 曾經對帶索引簽名的交集做
 * `Omit`，具名鍵全掉了，`UplinkResult` 在 `type === 'error'` 之後不收窄、`message` 讀出 `any`。
 * 這一組由 `pnpm -r run typecheck` 檢；跑起來只是無害的空操作。
 */
describe('WireErrorResponse 的型別', () => {
  it('具名鍵還在：message 是 string、error 是 WireErrorCode、type 是字面量 error', () => {
    expectTypeOf<WireErrorResponse['message']>().toEqualTypeOf<string>();
    expectTypeOf<WireErrorResponse['error']>().toEqualTypeOf<WireErrorCode>();
    expectTypeOf<WireErrorResponse['type']>().toEqualTypeOf<'error'>();
  });

  it('UplinkResult 在 type === error 之後收窄，message 是 string 不是 any', () => {
    const narrow = (result: UplinkResult) => {
      if (result.type === 'error') {
        expectTypeOf(result.message).toEqualTypeOf<string>();
      }
    };
    expect(typeof narrow).toBe('function');
    expect(errorResponse(1, 'invalid_argument', '壞了').message).toBe('壞了');
  });
});
