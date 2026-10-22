/**
 * **上行命令的 `params` 只收協定定義的欄位**——[#1572](https://github.com/DemianLi/nexus-agent/issues/1572)（N1228）。
 *
 * 照 dsh 的 `assertExactArguments`（`packages/api/gateway/src/index.ts:1613-1640`，`687f282e`）：多一格就拒、訊息只指名欄位、不帶值。
 * 以前每個命令只讀自己認得的那幾格，拼錯的欄位名（例如 `request_id` 寫成 `request_Id`，重送去重就靜靜失效）沒有人看、沒有任何訊息。
 *
 * 四組：
 *
 * - **多一格就拒**：`run.start` 帶 `bogus` 回 `invalid_argument`、指名 `bogus`、不帶值、那句話沒進佇列；**對照**：拿掉那一格同一個請求照常受理
 *   （否則「整條線都在拒」也長這樣）。
 * - **今天的客戶端照樣過**：`createWireClient`＋`createDeliverableClient` 注入 fetch、對**真的 handler** 把每一支命令選填欄位全部填上送一遍，
 *   沒有一支被這道檢查擋下，而且送到的 method 集合就是 `RPC_PARAM_KEYS` 的全部（表漏登一格、或新增 method 忘了補客戶端呼叫，這裡都會紅）。
 * - **協定合法但沒實作的欄位**：`run.start` 的 `config`／`metadata`、`input.respond` 的 `update`／`goto`／`config`／`metadata` 有值就回
 *   `not_supported` 並指名欄位（Q2 (a)，同 `attachments`、`mention` 的既有模式），**空物件也算有值**。
 * - **逐支各一條**：24 個 method 每一支帶一個多餘欄位都回 `invalid_argument`。
 *
 * **零憑證、零外部連線**：模型是假 agent。
 */

import type { SessionEvent } from '@nexus/core';
import {
  RPC_PARAM_KEYS,
  createDeliverableClient,
  createWireClient,
  isRpcMethod,
  unknownParamKeys,
} from '@nexus/wire';
import type { RpcMethod } from '@nexus/wire';
import { afterEach, describe, expect, it } from 'vitest';

import { emptyCommandPoint, loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';
import type { WireHandler } from './wire-handler.js';

const COMPLETED = {
  type: 'event',
  seq: 0,
  method: 'lifecycle',
  params: { namespace: [], timestamp: 0, data: { event: 'completed', graph_name: 'root' } },
};

/** 假 agent：每一輪立刻收尾。`ran` 記下開了幾輪，驗「被拒的那句話沒進佇列」。 */
function fakeAgent() {
  const ran: string[] = [];
  const agent = {
    streamEvents: async (input: { messages?: { content?: unknown }[] }) => {
      ran.push(String(input.messages?.[0]?.content ?? ''));
      return (async function* () {
        yield COMPLETED;
      })();
    },
    getState: async () => ({ values: {} }),
    updateState: async () => ({}),
  };
  return { agent: agent as unknown as PumpAgent, ran };
}

const BASE_URL = 'http://exact-params.test';

const opened: WireHandler[] = [];
afterEach(async () => {
  for (const handler of opened.splice(0)) await handler.close();
});

interface Recorded {
  readonly method: string;
  readonly params: unknown;
  readonly response: unknown;
}

function wire() {
  const { agent, ran } = fakeAgent();
  let log: (() => readonly SessionEvent[]) | undefined;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => ({
      agent,
      commands: emptyCommandPoint(),
      dispose: async () => {},
      attachSessions: (sessions) => {
        log = () => sessions.root.events;
        return { detach: async () => {} };
      },
    }),
  });
  opened.push(handler);
  /** 送出去的每一個上行命令與它的回應，依序。 */
  const recorded: Recorded[] = [];
  const fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const response = await handler.handle(loopbackRequest(input as string, init));
    if (typeof init?.body === 'string' && String(input).includes('/commands/')) {
      const sent = JSON.parse(init.body) as { method: string; params?: unknown };
      recorded.push({
        method: sent.method,
        params: sent.params,
        response: await response.clone().json(),
      });
    }
    return response;
  };
  /** 直接 POST 一個原樣的 body（客戶端不會替你拼出多餘或缺漏的欄位）。 */
  const post = async (threadId: string, method: string, body: unknown): Promise<unknown> => {
    const response = await fetch(`${BASE_URL}/threads/${threadId}/commands/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    return response.json();
  };
  return {
    client: createWireClient({ baseUrl: BASE_URL, fetch }),
    deliverables: createDeliverableClient({ baseUrl: BASE_URL, fetch }),
    post,
    recorded,
    ran,
    turnStarts: () => (log?.() ?? []).filter((event) => event.type === 'turn/start').length,
  };
}

interface ErrorBody {
  readonly type: 'error';
  readonly error: string;
  readonly message: string;
}

const runStart = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  method: 'run.start',
  params: {
    assistant_id: 'nexus',
    input: { messages: [{ role: 'human', content: '嗨' }] },
    ...extra,
  },
});

/** 每一支命令一份合格的 params（只為了讓請求像樣；檢查排在所有命令之前，不看這些值）。 */
const MINIMAL_PARAMS: Record<RpcMethod, Record<string, unknown>> = {
  'run.start': runStart().params,
  'input.respond': { namespace: [], interrupt_id: 'i-1', response: {} },
  'slash.list': {},
  'slash.run': { line: '/nothing' },
  'run.cancel': {},
  'queue.update': { item_id: 'q-1', action: { kind: 'remove' } },
  'subagent.send': { run_id: 'bg-1', text: '嗨' },
  'subagent.interrupt': { run_id: 'bg-1' },
  'subagent.list': {},
  'feedback.put': { messageId: 'm-1', rating: 'positive', ifVersion: null },
  'feedback.delete': { messageId: 'm-1', ifVersion: 'v1' },
  'feedback.list': {},
  'feedback.record': { text: '好' },
  'goal.pause': { goalId: 'g-1', revision: 1 },
  'deliverable.read': { seq: 1, index: 0 },
  'deliverable.readBytes': { seq: 1, index: 0 },
  'model.catalog': {},
  'model.select': { modelId: 'm' },
  'permission.catalog': {},
  'thread.pin': {},
  'thread.unpin': {},
  'thread.archive': {},
  'thread.unarchive': {},
  'thread.rename': { title: '新名字' },
};

describe('wire：params 多一格就拒', () => {
  it('run.start 帶 bogus：回 invalid_argument、指名欄位、不帶值，那句話沒進佇列', async () => {
    const { post, ran, turnStarts } = wire();
    const secret = 'secret-value-7f3a';

    const rejected = (await post(
      'exact-bogus',
      'run.start',
      runStart({ bogus: secret }),
    )) as ErrorBody;

    expect(rejected.type).toBe('error');
    expect(rejected.error).toBe('invalid_argument');
    expect(rejected.message).toContain('bogus');
    expect(rejected.message).not.toContain(secret);
    expect(ran).toHaveLength(0);
    expect(turnStarts()).toBe(0);
  });

  it('對照：同一個請求拿掉那一格就照常受理（不是整條線都在拒）', async () => {
    const { post, ran } = wire();

    const accepted = (await post('exact-control', 'run.start', runStart())) as {
      type: string;
      result: { run_id: string };
    };

    expect(accepted.type).toBe('success');
    expect(typeof accepted.result.run_id).toBe('string');
    await expect.poll(() => ran.length).toBe(1);
  });

  it('拼錯的欄位名被指名：request_Id 不會再靜靜讓重送去重失效', async () => {
    const { post, ran } = wire();

    const rejected = (await post(
      'exact-typo',
      'run.start',
      runStart({ request_Id: 'req-1' }),
    )) as ErrorBody;

    expect(rejected.error).toBe('invalid_argument');
    expect(rejected.message).toContain('request_Id');
    expect(ran).toHaveLength(0);
  });

  it('多格一起指名，且 JSON 裡的 __proto__ 也是一格', async () => {
    const { post } = wire();

    const rejected = (await post(
      'exact-multi',
      'run.cancel',
      '{"id":1,"method":"run.cancel","params":{"__proto__":1,"extra":2}}',
    )) as ErrorBody;

    expect(rejected.error).toBe('invalid_argument');
    expect(rejected.message).toContain('__proto__');
    expect(rejected.message).toContain('extra');
  });

  it.each(Object.keys(RPC_PARAM_KEYS) as RpcMethod[])(
    '%s：帶一個多餘欄位回 invalid_argument',
    async (method) => {
      const { post } = wire();

      const rejected = (await post(`exact-each-${method}`, method, {
        id: 7,
        method,
        params: { ...MINIMAL_PARAMS[method], bogus: 1 },
      })) as ErrorBody & { id: number };

      expect(rejected.type).toBe('error');
      expect(rejected.error).toBe('invalid_argument');
      expect(rejected.message).toContain('bogus');
      expect(rejected.id).toBe(7);
    },
  );

  it.each(['run.cancel', 'slash.list', 'feedback.list', 'thread.pin'] as const)(
    '%s：params 省略或 {} 時，這道檢查不插手（各命令自己決定缺不缺）',
    async (method) => {
      const { post } = wire();
      const thread = `exact-empty-${method}`;
      for (const body of [
        { id: 1, method },
        { id: 2, method, params: {} },
      ]) {
        const response = (await post(thread, method, body)) as { type: string; message?: string };
        expect(response.message ?? '').not.toContain('不收這些欄位');
        expect(response.message ?? '').not.toContain('params 要是物件');
      }
    },
  );

  it.each([null, 5, 'x', [1], true])(
    '有給 params 卻不是物件（%j）：每一支命令都回 invalid_argument（dsh `args must be a plain object`）',
    async (params) => {
      const { post } = wire();
      for (const method of Object.keys(RPC_PARAM_KEYS) as RpcMethod[]) {
        const response = (await post(`exact-nonobject-${method}`, method, {
          id: 9,
          method,
          params,
        })) as ErrorBody & { id: number };
        expect(response.type, method).toBe('error');
        expect(response.error, method).toBe('invalid_argument');
        expect(response.message, method).toBe(`${method} 的 params 要是物件`);
        expect(response.id, method).toBe(9);
      }
    },
  );

  it('對照：同樣是 slash.list，省略 params 照收（success），給了 [1] 才被擋', async () => {
    const { post } = wire();
    const omitted = (await post('exact-omit-ok', 'slash.list', {
      id: 1,
      method: 'slash.list',
    })) as {
      type: string;
    };
    const given = (await post('exact-omit-ok', 'slash.list', {
      id: 2,
      method: 'slash.list',
      params: [1],
    })) as ErrorBody;
    expect(omitted.type).toBe('success');
    expect(given.error).toBe('invalid_argument');
  });

  it('鍵名加引號：空字串鍵、含換行與控制字元的鍵都讀得出來，也不會偽造出第二行訊息', async () => {
    const { post } = wire();

    const rejected = (await post(
      'exact-quoted',
      'run.cancel',
      JSON.stringify({ id: 1, method: 'run.cancel', params: { '': 1, 'a\nb': 2, 'c\u0001d': 3 } }),
    )) as ErrorBody;

    expect(rejected.error).toBe('invalid_argument');
    expect(rejected.message).toContain('""');
    expect(rejected.message).toContain('"a\\nb"');
    expect(rejected.message).toContain('"c\\u0001d"');
    expect(rejected.message).not.toContain('\n');
  });

  it('少一格不重報：run.start 缺 assistant_id 仍是各命令自己的訊息', async () => {
    const { post } = wire();

    const response = (await post('exact-missing', 'run.start', {
      id: 1,
      method: 'run.start',
      params: { input: { messages: [] } },
    })) as ErrorBody;

    expect(response.error).toBe('invalid_argument');
    expect(response.message).toBe('run.start 缺 assistant_id');
  });
});

describe('wire：今天的客戶端照樣過', () => {
  it('每一支命令選填欄位全部填上，送進真的 handler，沒有一支被這道檢查擋下', async () => {
    const { client, deliverables, recorded } = wire();
    const thread = 'exact-real-client';

    await client.runStart(thread, '嗨', {
      mode: 'queue',
      attachments: [{ type: 'file', receiptId: 'r-1' }],
      mention: { kind: 'subagent', name: 'worker' },
      requestId: 'req-1',
      clientTimeZone: 'Asia/Taipei',
    });
    await client.inputRespond(thread, { namespace: [], interrupt_id: 'i-1', response: {} });
    await client.slashList(thread);
    await client.slashRun(thread, '/nothing', [{ type: 'file', receiptId: 'r-2' }]);
    await client.runCancel(thread);
    await client.queueUpdate(thread, { item_id: 'q-1', action: { kind: 'edit', text: '改' } });
    await client.subagentSend(thread, 'bg-1', '嗨', { clientTimeZone: 'UTC' });
    await client.subagentInterrupt(thread, 'bg-1');
    await client.subagentList(thread);
    await client.feedbackPut(thread, {
      messageId: 'm-1',
      rating: 'positive',
      note: '好',
      category: 'task-result',
      ifVersion: null,
    });
    await client.feedbackDelete(thread, { messageId: 'm-1', ifVersion: 'v1' });
    await client.feedbackList(thread);
    await client.feedbackRecord(thread, { text: '好', category: 'task-result' });
    await client.goalPause(thread, { goalId: 'g-1', revision: 1 });
    await deliverables.read(thread, { seq: 1, index: 0, offset: 0, limit: 10 });
    await deliverables.readBytes(thread, { seq: 1, index: 0, offset: 0, length: 10 });
    await client.modelCatalog(thread);
    await client.selectModel(thread, { modelId: 'm', reasoningEffort: 'high' });
    await client.permissionCatalog(thread);
    await client.threadPin(thread);
    await client.threadUnpin(thread);
    await client.threadArchive(thread, { stopActivity: true });
    await client.threadUnarchive(thread);
    await client.threadRename(thread, '新名字');

    // 送到的 method 就是表上的全部：漏登一格、或新增 method 忘了補這裡的客戶端呼叫，都會紅。
    expect(new Set(recorded.map((entry) => entry.method))).toEqual(
      new Set(Object.keys(RPC_PARAM_KEYS)),
    );
    for (const entry of recorded) {
      const message = (entry.response as { message?: string }).message ?? '';
      expect(message, `${entry.method} 被精確鍵集擋下`).not.toContain('不收這些欄位');
      // 客戶端送的每一格都在表上（表的值域不比客戶端窄）。
      expect(unknownParamKeys(entry.method as RpcMethod, entry.params), entry.method).toEqual([]);
    }
  });
});

describe('wire：協定合法但這台 server 沒實作的欄位', () => {
  it.each([
    ['run.start', 'config'],
    ['run.start', 'metadata'],
    ['input.respond', 'update'],
    ['input.respond', 'goto'],
    ['input.respond', 'config'],
    ['input.respond', 'metadata'],
  ] as const)('%s 帶 %s（空物件也算有值）：回 not_supported 並指名欄位', async (method, key) => {
    const { post, ran } = wire();

    const rejected = (await post(`exact-unsupported-${method}-${key}`, method, {
      id: 3,
      method,
      params: { ...MINIMAL_PARAMS[method], [key]: {} },
    })) as ErrorBody;

    expect(rejected.type).toBe('error');
    expect(rejected.error).toBe('not_supported');
    expect(rejected.message).toContain(key);
    expect(ran).toHaveLength(0);
  });

  it('input.respond 的批次形 responses 仍走原本的 not_supported（它在表上）', async () => {
    const { post } = wire();

    const response = (await post('exact-batch', 'input.respond', {
      id: 1,
      method: 'input.respond',
      params: { responses: [] },
    })) as ErrorBody;

    expect(response.error).toBe('not_supported');
    expect(response.message).toBe('這一版只收單一 interrupt 的 input.respond');
  });
});

describe('RPC_PARAM_KEYS 與 isRpcMethod', () => {
  it('表上的每個 method 都是 isRpcMethod 認得的（不多出一個幽靈 method）', () => {
    for (const method of Object.keys(RPC_PARAM_KEYS))
      expect(isRpcMethod(method), method).toBe(true);
  });
});
