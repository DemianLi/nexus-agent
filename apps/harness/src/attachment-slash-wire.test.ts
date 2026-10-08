/**
 * **帶附件的斜線命令走完產品路徑**（[#732](https://github.com/DemianLi/nexus-agent/issues/732)，`CommandInvocation.attachments`）。
 *
 * 真 handler＋真 client＋真執行器＋真註冊表＋真 `ChatOpenAI`（打本機假端點）。命令是測試自己註冊的兩個：`attach` 宣告收附件
 * （handler 照 rawInput 決定 steer 帶附件、回 error，或什麼都不做），`plain` 沒宣告。
 *
 * 釘的幾件事：
 *
 * - 宣告收附件的命令：handler 收到參照；`steer(text, attachments)` 開出來的那一輪 `turn/start` 帶著同樣的參照，模型請求裡有檔案 handle 與圖。
 * - 命令回 error：收據放回去，之後還能用；日誌沒有 `turn/start`。
 * - 沒宣告的命令帶附件：error，`command/run`＋`command/done` 一對，收據與儲存一個字不動。
 * - 不是命令的一行帶附件：`unknown`，收據仍在（輸入框當一般訊息送）。
 * - `slash.list` 的 descriptor 帶 `input.attachments`。
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
import { createRegistry } from '@nexus/core';
import type { AttachmentRef, SessionRegistry } from '@nexus/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import { ambientCredentials } from './credentials.js';
import { loopbackRequest, TEST_BROWSER_AUTH } from './fixtures.js';
import { PNG_7X5 } from './image-fixtures.js';
import { createLiveModel, LIVE_API_KEY_ENV } from './live-model.js';
import { createModelSelectionHost } from './model-selection-host.js';
import type { PumpAgent } from './thread-pump.js';
import { liveModelConfigSchema } from './settings/live-model.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://wire.test';
const THREAD = 'attachment-slash';

/** `attach` handler 看到的附件，照呼叫順序。 */
let seen: (readonly AttachmentRef[])[];

/** `attach`（宣告收附件）與 `plain`（沒宣告）。`attach` 的行為由 rawInput 決定：` steer`／` fail`／空白什麼都不做。 */
function commandPoint() {
  const registry = createRegistry();
  registry.enter({ id: 'attach-test#0', name: 'attach-test' });
  const { commands } = registry;
  commands.register({
    name: 'attach',
    description: '收附件',
    input: { hint: '[steer|fail]', attachments: true },
    handler: ({ rawInput, attachments, steer }) => {
      seen.push(attachments);
      const mode = rawInput.trim();
      if (mode === 'fail') return { kind: 'error', text: '不成立' };
      if (mode === 'steer') steer('請看附件', attachments);
      return { kind: 'success' };
    },
  });
  commands.register({
    name: 'plain',
    description: '不收附件',
    input: { hint: '無' },
    handler: () => ({ kind: 'success' }),
  });
  return commands;
}

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
  seen = [];
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
        commands: commandPoint(),
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

describe('slash.run 帶附件', () => {
  it('slash.list 的 descriptor：宣告的有 input.attachments，沒宣告的沒有這一格', async () => {
    const { client, handler } = connect('vision');
    try {
      const listed = await client.slashList(THREAD);
      expect(listed.kind).toBe('ok');
      if (listed.kind !== 'ok') return;
      const byName = new Map(listed.commands.map((command) => [command.name, command]));
      expect(byName.get('attach')?.input).toEqual({ hint: '[steer|fail]', attachments: true });
      expect(byName.get('plain')?.input).toEqual({ hint: '無' });
    } finally {
      await handler.close();
    }
  });

  it('宣告收附件：handler 收到參照；steer 開的那一輪 turn/start 帶同樣的參照，模型請求裡有檔案 handle 與圖', async () => {
    const { client, handler, events } = connect('vision');
    try {
      const receipt = await upload(client, '暗號 MURASAKI-7391', '說明.txt');
      const result = await client.slashRun(THREAD, '/attach steer', [
        { type: 'file', receiptId: receipt.receiptId },
        IMAGE,
      ]);
      expect(result).toMatchObject({ kind: 'success' });
      await settled(events, 1);

      expect(seen).toHaveLength(1);
      expect(seen[0]!.map((ref) => ref.type)).toEqual(['file', 'image']);
      const start = events().find((e) => e.type === 'turn/start');
      expect(start?.data).toMatchObject({
        kind: 'message',
        text: '請看附件',
        attachments: [
          { type: 'file', name: '說明.txt' },
          { type: 'image', mediaType: 'image/png' },
        ],
      });
      expect((start?.data as { attachments: unknown }).attachments).toEqual(seen[0]);
      const user = requests[0]!.messages.find((m) => m.role === 'user')!;
      const blocks = user.content as { type: string; text?: string }[];
      expect(blocks.map((b) => b.type)).toEqual(['text', 'image_url', 'text']);
      expect(blocks[0]!.text).toContain('File "說明.txt"');
      expect(blocks[2]!.text).toBe('請看附件');
      // 日誌順序：command/run → command/done → turn/start。
      expect(
        events()
          .map((e) => e.type)
          .filter((t) => /^(command|turn)\/start|command\//u.test(t)),
      ).toEqual(['command/run', 'command/done', 'turn/start']);
    } finally {
      await handler.close();
    }
  });

  it('命令回 error：收據放回去（之後還能用），沒有 turn/start', async () => {
    const { client, handler, events } = connect('vision');
    try {
      const receipt = await upload(client, 'x', 'a.txt');
      const file: PromptAttachment = { type: 'file', receiptId: receipt.receiptId };
      expect(await client.slashRun(THREAD, '/attach fail', [file])).toMatchObject({
        kind: 'error',
        text: '不成立',
      });
      expect(events().some((e) => e.type === 'turn/start')).toBe(false);
      // 收據還在：同一份再用一次成功。
      expect(await client.slashRun(THREAD, '/attach', [file])).toMatchObject({ kind: 'success' });
      expect(seen.map((refs) => refs.length)).toEqual([1, 1]);
    } finally {
      await handler.close();
    }
  });

  it('沒宣告的命令帶附件：error，日誌一對，收據與儲存沒動，handler 沒跑', async () => {
    const { client, handler, events } = connect('vision');
    try {
      const receipt = await upload(client, 'x', 'a.txt');
      const file: PromptAttachment = { type: 'file', receiptId: receipt.receiptId };
      const result = await client.slashRun(THREAD, '/plain', [file, IMAGE]);
      expect(result).toMatchObject({ kind: 'error', text: '命令 "/plain" 不收附件。' });
      expect(
        events()
          .map((e) => e.type)
          .filter((t) => t.startsWith('command/')),
      ).toEqual(['command/run', 'command/done']);
      // handler 沒跑、收據還在（下一行用同一份收據成功）。
      expect(seen).toEqual([]);
      expect(await client.slashRun(THREAD, '/attach', [file])).toMatchObject({ kind: 'success' });
    } finally {
      await handler.close();
    }
  });

  it('不是命令的一行帶附件：unknown，收據仍在', async () => {
    const { client, handler, events } = connect('vision');
    try {
      const receipt = await upload(client, 'x', 'a.txt');
      const file: PromptAttachment = { type: 'file', receiptId: receipt.receiptId };
      expect(await client.slashRun(THREAD, '一般的一句話', [file])).toEqual({ kind: 'unknown' });
      expect(await client.slashRun(THREAD, '/nosuch', [file])).toEqual({ kind: 'unknown' });
      expect(events().filter((e) => e.type.startsWith('command/'))).toEqual([]);
      expect(await client.slashRun(THREAD, '/attach', [file])).toMatchObject({ kind: 'success' });
    } finally {
      await handler.close();
    }
  });

  it('目前的模型純文字：帶圖的命令呼叫 error（model 不收圖片），handler 沒跑，收據留著', async () => {
    const { client, handler } = connect('texty');
    try {
      const receipt = await upload(client, 'x', 'a.txt');
      const file: PromptAttachment = { type: 'file', receiptId: receipt.receiptId };
      const result = await client.slashRun(THREAD, '/attach', [file, IMAGE]);
      expect(result).toMatchObject({ kind: 'error' });
      expect((result as { text: string }).text).toContain('不收圖片');
      expect(seen).toEqual([]);
      expect(await client.slashRun(THREAD, '/attach', [file])).toMatchObject({ kind: 'success' });
    } finally {
      await handler.close();
    }
  });

  it('attachments 形狀壞：invalid_argument，不發派', async () => {
    const { client, handler, events } = connect('vision');
    try {
      const result = await client.slashRun(THREAD, '/attach', [
        { type: 'file', receiptId: 5 } as never,
      ]);
      expect(result).toMatchObject({ kind: 'rejected', code: 'invalid_argument' });
      expect(events().filter((e) => e.type.startsWith('command/'))).toEqual([]);
    } finally {
      await handler.close();
    }
  });
});
