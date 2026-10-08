/**
 * **帶附件的訊息走完產品路徑**（[#732](https://github.com/DemianLi/nexus-agent/issues/732) 第二刀：接線）。
 *
 * 真的 `createWireHandler`＋真的 wire client＋真的 `createNexusAgent`（`ThreadPump`、檢查點）＋**真的 `ChatOpenAI`**
 * （`createLiveModel`，對手方是本機的假 Chat Completions 端點）。`ScriptedChatModel` 驗不到這一層：它不經過請求轉換，
 * 看不到附件區塊被換成什麼。
 *
 * 釘的幾件事：
 *
 * - 檔案收據→日誌只有參照；送上線的是一行 handle 字，路徑讀得到。
 * - 圖→`image_url` data URL 位元組一致；**base64 不進日誌、不進存檔點**（這是這個設計成立的前提）。
 * - 收圖檢查：目前的模型宣告了純文字→`model_does_not_support_images`，日誌一個字不動、收據留著。
 * - 全有全無：一張不行整句拒收，收據放回去。
 * - 只有附件、沒有字也收。
 *
 * **零憑證、零外部連線**：附件根放 `/var/tmp`。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { MemorySaver } from '@langchain/langgraph';
import { createWireClient } from '@nexus/wire';
import type { PromptAttachment } from '@nexus/wire';
import type { SessionRegistry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import { ambientCredentials } from './credentials.js';
import { emptyCommandPoint, loopbackRequest, noSessions, TEST_BROWSER_AUTH } from './fixtures.js';
import { PNG_7X5 } from './image-fixtures.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { createModelSelectionHost } from './model-selection-host.js';
import type { PumpAgent } from './thread-pump.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://wire.test';
const THREAD = 'attachment-wire';

interface Recorded {
  readonly raw: string;
  readonly messages: { role: string; content: unknown }[];
}

let upstream: Server;
let requests: Recorded[];
let home: string;
let store: AttachmentStore;

beforeEach(async () => {
  requests = [];
  upstream = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages?: { role: string; content: unknown }[] };
      requests.push({ raw: body, messages: parsed.messages ?? [] });
      const index = requests.length;
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        `data: ${JSON.stringify({
          id: `resp_${index}`,
          object: 'chat.completion.chunk',
          created: 0,
          model: 'fake',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(chunk({ role: 'assistant', content: '收到。' }));
      res.write(chunk({}, 'stop'));
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
  home = await mkdtemp(join('/var/tmp', 'nexus-attwire-'));
  store = new AttachmentStore(attachmentsRootOf(home));
});

afterEach(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
});

/** 型錄：`vision` 宣告收圖、`texty` 宣告純文字、`silent` 沒宣告。 */
function config(modelId: 'vision' | 'texty' | 'silent') {
  const { port } = upstream.address() as AddressInfo;
  const entry = (id: string, input?: ('text' | 'image')[]) => ({
    id,
    contextWindow: 100_000,
    maxTokens: 1_000,
    ...(input === undefined ? {} : { input }),
  });
  return liveModelConfigSchema.parse({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    modelId,
    maxRetries: 0,
    models: [entry('vision', ['text', 'image']), entry('texty', ['text']), entry('silent')],
  });
}

function connect(modelId: 'vision' | 'texty' | 'silent') {
  const live = config(modelId);
  const credentials = ambientCredentials({ [LIVE_API_KEY_ENV]: 'sk-loopback' });
  let registry: SessionRegistry | undefined;
  const checkpointer = new MemorySaver();
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    attachments: store,
    createAgent: async () => {
      const built = await createNexusAgent({
        model: createLiveModel(live, undefined, credentials, { attachments: store }) as never,
        checkpointer,
        plugins: [],
        summarization: false,
        observationPolicy: false,
        attachments: store,
      });
      return {
        agent: built.agent as unknown as PumpAgent,
        attachSessions: (sessions, port) => {
          registry = sessions;
          const detach = built.attachSession(sessions, port);
          return { background: detach.background, detach: async () => detach() };
        },
        commands: emptyCommandPoint(),
        modelSelection: createModelSelectionHost({
          liveModel: live,
          credentials,
          attachments: store,
        }),
        dispose: built.dispose,
      };
    },
  });
  const fetchImpl: typeof globalThis.fetch = async (input, init) =>
    handler.handle(loopbackRequest(input as string, init));
  return {
    handler,
    client: createWireClient({ baseUrl: BASE_URL, fetch: fetchImpl }),
    checkpointer,
    events: () => registry?.root.events ?? [],
  };
}

async function settled(events: () => readonly { type: string }[], turns: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const done = events().filter((e) => e.type === 'turn/end' || e.type === 'turn/failed').length;
    if (done >= turns) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等不到這一輪收尾');
}

const IMAGE: PromptAttachment = {
  type: 'image',
  mediaType: 'image/png',
  data: PNG_7X5,
  name: 's.png',
};

async function upload(client: ReturnType<typeof connect>['client'], text: string, name: string) {
  const outcome = await client.uploadFile(THREAD, new TextEncoder().encode(text), name);
  if (outcome.kind !== 'ok') throw new Error('上傳沒成功');
  return outcome.receipt;
}

describe('檔案收據', () => {
  it('日誌只留參照；送上線的是那一行 handle 字，路徑讀得到', async () => {
    const { client, handler, events } = connect('vision');
    try {
      const receipt = await upload(client, '暗號 MURASAKI-7391', '說明.txt');
      const result = await client.runStart(THREAD, '看這個檔', {
        attachments: [{ type: 'file', receiptId: receipt.receiptId }],
      });
      expect(result).toMatchObject({ type: 'success' });
      await settled(events, 1);

      const start = events().find((e) => e.type === 'turn/start');
      expect(start?.data).toMatchObject({
        kind: 'message',
        text: '看這個檔',
        attachments: [{ type: 'file', name: '說明.txt', bytes: receipt.bytes }],
      });
      const user = requests[0]!.messages.find((m) => m.role === 'user')!;
      const blocks = user.content as { type: string; text?: string }[];
      expect(blocks.map((b) => b.type)).toEqual(['text', 'text']);
      expect(blocks[0]!.text).toContain('File "說明.txt"');
      expect(blocks[0]!.text).toMatch(
        /saved at "\/attachments\/[0-9a-f]{2}\/[0-9a-f]{64}\/說明\.txt"/u,
      );
      expect(blocks[1]!.text).toBe('看這個檔');
    } finally {
      await handler.close();
    }
  });

  it('收據用過就失效；沒見過的收據拒收，日誌不動', async () => {
    const { client, handler, events } = connect('vision');
    try {
      const receipt = await upload(client, 'x', 'a.txt');
      const attachments: PromptAttachment[] = [{ type: 'file', receiptId: receipt.receiptId }];
      expect(await client.runStart(THREAD, '一', { attachments })).toMatchObject({
        type: 'success',
      });
      await settled(events, 1);
      const before = events().length;
      expect(await client.runStart(THREAD, '二', { attachments })).toMatchObject({
        type: 'error',
        error: 'invalid_argument',
      });
      expect(
        await client.runStart(THREAD, '三', {
          attachments: [{ type: 'file', receiptId: 'never-issued' }],
        }),
      ).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(events().length).toBe(before);
    } finally {
      await handler.close();
    }
  });

  it('全有全無：一張圖不行整句拒收，收據放回去，修了重送就成', async () => {
    const { client, handler, events } = connect('vision');
    try {
      const receipt = await upload(client, 'x', 'a.txt');
      const file: PromptAttachment = { type: 'file', receiptId: receipt.receiptId };
      const bad: PromptAttachment = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
      const rejected = await client.runStart(THREAD, '壞的', { attachments: [file, bad] });
      expect(rejected).toMatchObject({ type: 'error', error: 'invalid_argument' });
      expect(events().some((e) => e.type === 'turn/start')).toBe(false);
      expect(await client.runStart(THREAD, '好的', { attachments: [file] })).toMatchObject({
        type: 'success',
      });
      await settled(events, 1);
    } finally {
      await handler.close();
    }
  });

  it('同一句話把一份收據用兩次：拒收', async () => {
    const { client, handler } = connect('vision');
    try {
      const receipt = await upload(client, 'x', 'a.txt');
      const file: PromptAttachment = { type: 'file', receiptId: receipt.receiptId };
      expect(await client.runStart(THREAD, '重複', { attachments: [file, file] })).toMatchObject({
        type: 'error',
        error: 'invalid_argument',
      });
    } finally {
      await handler.close();
    }
  });
});

describe('內嵌的圖', () => {
  it('送上線的是 image_url（位元組與原圖一致）；base64 不進日誌、不進存檔點', async () => {
    const { client, handler, events, checkpointer } = connect('vision');
    try {
      const result = await client.runStart(THREAD, '這張圖是什麼', { attachments: [IMAGE] });
      expect(result).toMatchObject({ type: 'success' });
      await settled(events, 1);

      const user = requests[0]!.messages.find((m) => m.role === 'user')!;
      const blocks = user.content as { type: string; image_url?: { url: string } }[];
      expect(blocks.map((b) => b.type)).toEqual(['image_url', 'text']);
      expect(blocks[0]!.image_url!.url).toBe(`data:image/png;base64,${PNG_7X5}`);

      // 前提：base64 真的在這次請求裡，下面的「不在」才有意義。
      expect(requests[0]!.raw).toContain(PNG_7X5);
      expect(JSON.stringify(events())).not.toContain(PNG_7X5);
      // 日誌上是參照：id、媒體類型、寬高，沒有位元組。
      expect(JSON.stringify(events())).toContain('"mediaType":"image/png"');
      const tuple = await checkpointer.getTuple({ configurable: { thread_id: THREAD } });
      const state = JSON.stringify(tuple?.checkpoint.channel_values ?? {});
      expect(state).toContain('nexus-image');
      expect(state).not.toContain(PNG_7X5);
    } finally {
      await handler.close();
    }
  });

  it('只有圖、沒有字也收；沒宣告輸入種類的模型照收（同 dsh）', async () => {
    const { client, handler, events } = connect('silent');
    try {
      const result = await client.runStart(THREAD, '', { attachments: [IMAGE] });
      expect(result).toMatchObject({ type: 'success' });
      await settled(events, 1);
      const user = requests[0]!.messages.find((m) => m.role === 'user')!;
      expect((user.content as { type: string }[]).map((b) => b.type)).toEqual(['image_url']);
    } finally {
      await handler.close();
    }
  });

  it('目前的模型宣告純文字：model_does_not_support_images，日誌一個字不動，收據留著', async () => {
    const { client, handler, events } = connect('texty');
    try {
      const receipt = await upload(client, 'x', 'a.txt');
      const before = events().length;
      const rejected = await client.runStart(THREAD, '看圖', { attachments: [IMAGE] });
      expect(rejected).toMatchObject({ type: 'error', error: 'model_does_not_support_images' });
      expect(events().length).toBe(before);
      expect(requests).toHaveLength(0);
      // 只有檔案的話純文字模型照收，而且上面那張收據還能用。
      const ok = await client.runStart(THREAD, '只看檔', {
        attachments: [{ type: 'file', receiptId: receipt.receiptId }],
      });
      expect(ok).toMatchObject({ type: 'success' });
      await settled(events, 1);
    } finally {
      await handler.close();
    }
  });
});

describe('不支援附件的組裝', () => {
  it('沒有附件儲存：帶附件整句 not_supported', async () => {
    const live = config('vision');
    const handler = createWireHandler({
      auth: TEST_BROWSER_AUTH,
      createAgent: async () => {
        const built = await createNexusAgent({
          model: createLiveModel(
            live,
            undefined,
            ambientCredentials({ [LIVE_API_KEY_ENV]: 'k' }),
          ) as never,
          checkpointer: new MemorySaver(),
          plugins: [],
          summarization: false,
          observationPolicy: false,
        });
        return {
          agent: built.agent as unknown as PumpAgent,
          attachSessions: noSessions,
          commands: emptyCommandPoint(),
          dispose: built.dispose,
        };
      },
    });
    const client = createWireClient({
      baseUrl: BASE_URL,
      fetch: async (input, init) => handler.handle(loopbackRequest(input as string, init)),
    });
    try {
      expect(await client.runStart(THREAD, '圖', { attachments: [IMAGE] })).toMatchObject({
        type: 'error',
        error: 'not_supported',
      });
    } finally {
      await handler.close();
    }
  });
});
