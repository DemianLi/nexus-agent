/**
 * 契約先合、實作還沒做的兩塊（#723 模型選擇、#732 上傳與收據）：**每一支未實作的方法都回 `not_supported`**。
 *
 * web 據這個碼把功能藏起來，所以「還沒做」必須是這個碼，不是 404、不是空結果、不是 `invalid_argument`。實作落地時，
 * 對應的那條在這裡換成真的行為測試——這條測試紅了就是有人實作了一半、忘了來更新契約這一側。
 *
 * 另外量：沒有為了回「還沒做」去建 agent（`createAgent` 一次都沒被叫），以及 `run.start` 帶附件被整句拒絕而不是悄悄
 * 收下文字、丟掉附件（使用者會以為檔案送出去了）。
 */

import { MemorySaver } from '@langchain/langgraph';
import {
  createWireClient,
  MODEL_METHODS,
  SUBAGENT_LIST_METHOD,
  THREAD_MANAGEMENT_METHODS,
  uploadPath,
} from '@nexus/wire';
import { createDeepAgent, StateBackend } from 'deepagents';
import { describe, expect, it } from 'vitest';

import { emptyCommandPoint, loopbackRequest, noSessions, TEST_BROWSER_AUTH } from './fixtures.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://wire.test';

function connect() {
  let created = 0;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    createAgent: async () => {
      created += 1;
      const agent = createDeepAgent({
        model: new ScriptedChatModel({ turns: [{ content: '好。' }] }),
        backend: new StateBackend(),
        checkpointer: new MemorySaver(),
      }) as unknown as PumpAgent;
      return {
        agent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        dispose: async () => undefined,
      };
    },
  });
  const fetchImpl: typeof globalThis.fetch = async (input, init) =>
    handler.handle(loopbackRequest(input as string, init));
  return {
    handler,
    fetch: fetchImpl,
    client: createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl }),
    created: () => created,
  };
}

const NOT_SUPPORTED = { kind: 'rejected', code: 'not_supported' } as const;

describe('每一支未實作的方法都回 not_supported', () => {
  it('RPC：model、thread 管理與子代理清單的每一支，而且不為它們建 agent', async () => {
    const { client, handler, created } = connect();
    try {
      // 清單與契約同步：新增一支 method 而沒有登記到這裡，這條先紅。
      expect([...MODEL_METHODS, ...THREAD_MANAGEMENT_METHODS, SUBAGENT_LIST_METHOD].sort()).toEqual(
        [
          'model.catalog',
          'model.select',
          'subagent.list',
          'thread.archive',
          'thread.pin',
          'thread.rename',
          'thread.unarchive',
          'thread.unpin',
        ],
      );
      const outcomes = [
        await client.modelCatalog('t'),
        await client.selectModel('t', { modelId: 'm', reasoningEffort: 'high' }),
        await client.threadPin('t'),
        await client.threadUnpin('t'),
        await client.threadArchive('t', { stopActivity: true }),
        await client.threadUnarchive('t'),
        await client.threadRename('t', '新標題'),
        await client.subagentList('t'),
      ];
      for (const outcome of outcomes) expect(outcome).toMatchObject(NOT_SUPPORTED);
      for (const outcome of outcomes) {
        expect(outcome.kind === 'rejected' && outcome.message !== '').toBe(true);
      }
      expect(created()).toBe(0);
    } finally {
      await handler.close();
    }
  });

  it('permission.catalog：組裝沒有權限組合（沒圍堵）回 not_supported，web 據此藏起選單（#437）', async () => {
    const { client, handler } = connect();
    try {
      const outcome = await client.permissionCatalog('t');
      expect(outcome).toMatchObject(NOT_SUPPORTED);
      expect(outcome.kind === 'rejected' && outcome.message !== '').toBe(true);
    } finally {
      await handler.close();
    }
  });

  it('上傳：POST 原始位元組回 not_supported；content-type 不對 415、GET 404', async () => {
    const { client, handler, fetch, created } = connect();
    try {
      expect(await client.uploadFile('t', new Uint8Array([1, 2, 3]), 'a.txt')).toMatchObject(
        NOT_SUPPORTED,
      );
      const wrongType = await fetch(`${BASE_URL}${uploadPath('t')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(wrongType.status).toBe(415);
      const get = await fetch(`${BASE_URL}${uploadPath('t')}`, {
        method: 'GET',
        headers: { 'content-type': 'application/octet-stream' },
      });
      expect(get.status).toBe(404);
      expect(created()).toBe(0);
    } finally {
      await handler.close();
    }
  });

  it('run.start 帶附件（收據或內嵌的圖）：整句拒絕，不收下文字', async () => {
    const { client, handler } = connect();
    try {
      for (const attachments of [
        [{ type: 'file', receiptId: 'r1' }],
        [{ type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'a.png' }],
      ] as const) {
        const response = await client.runStart('t', '看這個', { attachments });
        expect(response).toMatchObject({ type: 'error', error: 'not_supported' });
      }
      // 沒帶、帶空陣列照常收：契約先合不能弄壞今天的送出。
      for (const options of [undefined, { attachments: [] }] as const) {
        const response = await client.runStart('t', '沒附件', options);
        expect(response).toMatchObject({ type: 'success' });
      }
    } finally {
      await handler.close();
    }
  });

  it('run.start 帶 mention（點名子代理）：整句拒絕，不收下文字；沒帶照常收', async () => {
    const { client, handler } = connect();
    try {
      const response = await client.runStart('t', '請 reviewer 看一下', {
        mention: { kind: 'subagent', name: 'reviewer' },
      });
      expect(response).toMatchObject({ type: 'error', error: 'not_supported' });
      expect(await client.runStart('t', '沒點名')).toMatchObject({ type: 'success' });
    } finally {
      await handler.close();
    }
  });

  it('run.start 的 attachments 不是陣列：invalid_argument（不是 not_supported）', async () => {
    const { handler, fetch } = connect();
    try {
      const response = await fetch(`${BASE_URL}/threads/t/commands/run.start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 1,
          method: 'run.start',
          params: {
            assistant_id: 'nexus',
            input: { messages: [{ role: 'human', content: '嗨' }] },
            attachments: 'r1',
          },
        }),
      });
      expect(await response.json()).toMatchObject({ type: 'error', error: 'invalid_argument' });
    } finally {
      await handler.close();
    }
  });
});
