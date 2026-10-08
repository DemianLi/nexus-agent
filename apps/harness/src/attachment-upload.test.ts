/**
 * 上傳一份檔案、模型讀得到它（[#732](https://github.com/DemianLi/nexus-agent/issues/732) 第一張：儲存＋上傳路徑＋收據）。
 *
 * 走完產品路徑：真的 `createWireHandler`、真的 wire client、真的 `createNexusAgent`（掛附件路由），模型是腳本、用 `read_file`
 * 讀上傳的檔。「送出訊息時帶收據」是下一張，這裡只量到「收據發得出來、檔案存對、模型讀得到」。
 *
 * **零憑證、零外部連線**；附件根放 `/var/tmp`（見記憶「夾具在 tmpdir 會撞上暫存目錄規則」），不碰真的 `~/.nexus-agent`。
 */

import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { MemorySaver } from '@langchain/langgraph';
import type { BaseMessage, ToolMessage } from '@langchain/core/messages';
import { createWireClient, uploadPath } from '@nexus/wire';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNexusAgent } from './agent-factory.js';
import { AttachmentStore, attachmentsRootOf } from './attachment-store.js';
import { ContainedFilesystemBackend } from './contained-backend.js';
import { emptyCommandPoint, loopbackRequest, noSessions, TEST_BROWSER_AUTH } from './fixtures.js';
import { toAgentInvocation } from './messages.js';
import { ScriptedChatModel } from './scripted-model.js';
import type { PumpAgent } from './thread-pump.js';
import { createWireHandler } from './wire-handler.js';

const BASE_URL = 'http://wire.test';

let home: string;
let store: AttachmentStore;

beforeEach(async () => {
  home = await mkdtemp(join('/var/tmp', 'nexus-upload-'));
  store = new AttachmentStore(attachmentsRootOf(home));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function connect(options: { maxUploadBytes?: number } = {}) {
  let created = 0;
  const handler = createWireHandler({
    auth: TEST_BROWSER_AUTH,
    attachments: store,
    ...options,
    createAgent: async () => {
      created += 1;
      const built = await createNexusAgent({
        model: new ScriptedChatModel({ turns: [{ content: '好。' }] }) as never,
        checkpointer: new MemorySaver(),
        plugins: [],
        summarization: false,
        observationPolicy: false,
        attachments: store,
      });
      return {
        agent: built.agent as unknown as PumpAgent,
        attachSessions: noSessions,
        commands: emptyCommandPoint(),
        dispose: built.dispose,
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

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe('上傳：發收據、存對', () => {
  it('回一張收據（id、清過的檔名、位元組數）；檔案原樣、唯讀、目錄 0700；為它建了這條 thread', async () => {
    const { client, handler, created } = connect();
    try {
      const text = '第一行\n第二行\n';
      const outcome = await client.uploadFile('t1', new TextEncoder().encode(text), 'notes.txt');
      expect(outcome.kind).toBe('ok');
      if (outcome.kind !== 'ok') return;
      expect(outcome.receipt).toMatchObject({
        name: 'notes.txt',
        bytes: Buffer.byteLength(text),
      });
      expect(outcome.receipt.receiptId).not.toBe('');
      expect(created()).toBe(1);

      const digest = sha(text);
      const stored = join(store.rootDir, 'files', digest.slice(0, 2), digest, 'notes.txt');
      expect(await modeOf(stored)).toBe(0o400);
      expect(await modeOf(store.rootDir)).toBe(0o700);
      expect(await modeOf(join(store.rootDir, 'files'))).toBe(0o700);
    } finally {
      await handler.close();
    }
  });

  it('每次上傳一張新的收據；同樣的內容只存一份；路徑樣的檔名被清成葉名', async () => {
    const { client, handler } = connect();
    try {
      const a = await client.uploadFile('t1', new TextEncoder().encode('same'), '../../a.txt');
      const b = await client.uploadFile('t1', new TextEncoder().encode('same'), 'b.txt');
      if (a.kind !== 'ok' || b.kind !== 'ok') throw new Error('上傳沒成功');
      expect(a.receipt.name).toBe('a.txt');
      expect(a.receipt.receiptId).not.toBe(b.receipt.receiptId);
      expect(await readdir(join(store.rootDir, 'file-objects', sha('same').slice(0, 2)))).toEqual([
        sha('same'),
      ]);
    } finally {
      await handler.close();
    }
  });

  it('沒帶檔名叫 file；空檔案也收', async () => {
    const { client, handler } = connect();
    try {
      const outcome = await client.uploadFile('t1', new Uint8Array(0));
      expect(outcome).toMatchObject({ kind: 'ok', receipt: { name: 'file', bytes: 0 } });
    } finally {
      await handler.close();
    }
  });

  it('超過單次上限：invalid_argument，暫存與物件都沒留下', async () => {
    const { client, handler } = connect({ maxUploadBytes: 4 });
    try {
      const outcome = await client.uploadFile('t1', new TextEncoder().encode('12345'), 'big.txt');
      expect(outcome).toMatchObject({ kind: 'rejected', code: 'invalid_argument' });
      expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
      expect(await readdir(join(store.rootDir, 'file-objects'))).toEqual([]);
    } finally {
      await handler.close();
    }
  });

  it('上傳到一半連線斷了（請求被中止）：沒有物件、暫存收掉', async () => {
    const { handler } = connect();
    try {
      const controller = new AbortController();
      const body = new ReadableStream<Uint8Array>({
        start(stream) {
          stream.enqueue(new TextEncoder().encode('half'));
          // 不關：模擬還在傳。
          controller.signal.addEventListener('abort', () => stream.error(new Error('斷線')));
        },
      });
      const request = new Request(`${BASE_URL}${uploadPath('t1')}?name=half.txt`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body,
        duplex: 'half',
        signal: controller.signal,
      } as RequestInit);
      const pending = handler.handle(
        loopbackRequest(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body,
          duplex: 'half',
          signal: controller.signal,
        } as RequestInit),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort(new Error('斷線'));
      const response = await pending;
      expect((await response.json()) as { type: string }).toMatchObject({ type: 'error' });
      expect(await readdir(join(store.rootDir, 'staging'))).toEqual([]);
      expect(await readdir(join(store.rootDir, 'file-objects'))).toEqual([]);
    } finally {
      await handler.close();
    }
  });
});

function toolText(prompt: readonly BaseMessage[] | undefined): string {
  const content = (prompt?.filter((message) => message.getType() === 'tool') as ToolMessage[]).at(
    -1,
  )?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

describe('模型用 read_file 讀得到上傳的檔案', () => {
  it('虛擬路徑讀得到原文；工作區是 read-only 圍堵也一樣；寫那個路徑被擋', async () => {
    const saved = await store.save({
      data: new TextEncoder().encode('暗號是 MURASAKI-7391\n第二行\n'),
      name: '說明 文件.txt',
    });
    const workspace = await mkdtemp(join('/var/tmp', 'nexus-upload-ws-'));
    try {
      const path = store.modelPathOf(saved);
      const model = new ScriptedChatModel({
        turns: [
          { content: '', toolCalls: [{ name: 'read_file', args: { file_path: path } }] },
          {
            content: '',
            toolCalls: [{ name: 'write_file', args: { file_path: path, content: '被改掉了' } }],
          },
          { content: '好。' },
        ],
      });
      const built = await createNexusAgent({
        model: model as never,
        checkpointer: new MemorySaver(),
        plugins: [],
        summarization: false,
        observationPolicy: false,
        backend: new ContainedFilesystemBackend({ rootDir: workspace, mode: 'read-only' }),
        attachments: store,
      });
      try {
        await built.agent.invoke(toAgentInvocation('讀那個檔案。'), {
          configurable: { thread_id: 'read-attachment' },
        });
      } finally {
        await built.dispose();
      }
      expect(model.prompts.length).toBeGreaterThanOrEqual(3);
      expect(toolText(model.prompts[1])).toContain('MURASAKI-7391');
      expect(toolText(model.prompts[2])).toContain('這個 backend 是唯讀的');
      // 檔案沒被動過。
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(store.pathOf(saved), 'utf8')).toContain('MURASAKI-7391');
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
