/**
 * 會投影附件的 `ChatOpenAI` 子類（[#732](https://github.com/DemianLi/nexus-agent/issues/732)）：基座有三條出請求的路
 * （`invoke`→`_generate`、串流→`_streamResponseChunks`、v3 串流→`_streamChatModelEvents`），加上 `withConfig`／`bindTools` 會
 * 重建實例——**每一條都得過投影**，漏一條就是附件區塊原樣進請求轉換。對手方是本機假端點，看的是線上的 body。
 *
 * 每個覆寫各有一個突變能讓對應那條紅（見各測試的註解）。
 */

import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { HumanMessage } from '@langchain/core/messages';
import type { BaseMessage } from '@langchain/core/messages';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AttachmentChatOpenAI } from './attachment-chat-openai.js';
import { projectAttachments } from './attachment-projection.js';
import type { AttachmentSource } from './attachment-projection.js';
import { PNG_7X5 } from './image-fixtures.js';

const IMAGE = {
  attachmentId: `sha256:${'d'.repeat(64)}`,
  mediaType: 'image/png' as const,
  bytes: 75,
  width: 7,
  height: 5,
};
const FILE = { attachmentId: `sha256:${'e'.repeat(64)}`, name: 'a.txt', bytes: 3 };

const BYTES = new Uint8Array(Buffer.from(PNG_7X5, 'base64'));

function source(overrides: Partial<AttachmentSource> = {}): AttachmentSource {
  return {
    hasFile: async () => true,
    readImage: async () => BYTES,
    ...overrides,
  };
}

function message(): HumanMessage {
  return new HumanMessage({
    content: [
      { type: 'nexus-file', attachment: FILE },
      { type: 'nexus-image', attachment: IMAGE },
      { type: 'text', text: '請看' },
    ] as never,
  });
}

let server: Server;
let bodies: { stream?: boolean; messages: { role: string; content: unknown }[] }[];

beforeEach(async () => {
  bodies = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as (typeof bodies)[number];
      bodies.push(parsed);
      if (parsed.stream === true) {
        const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
          `data: ${JSON.stringify({
            id: 'r',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'fake',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(chunk({ role: 'assistant', content: 'ok' }));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'r',
          object: 'chat.completion',
          created: 0,
          model: 'fake',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function model(imageSupport: 'accepts' | 'rejects' | 'undeclared', src = source()) {
  const { port } = server.address() as AddressInfo;
  return new AttachmentChatOpenAI(
    {
      model: 'fake',
      apiKey: 'sk-loopback',
      maxRetries: 0,
      configuration: { baseURL: `http://127.0.0.1:${port}/v1` },
    },
    (messages) => projectAttachments(messages, src, imageSupport),
  );
}

const userBlocks = () =>
  bodies.at(-1)!.messages.find((m) => m.role === 'user')!.content as {
    type: string;
    text?: string;
    image_url?: { url: string };
  }[];

describe('三條出請求的路都過投影', () => {
  it('invoke（非串流，_generate）', async () => {
    await model('accepts').invoke([message()]);
    expect(bodies.at(-1)!.stream).not.toBe(true);
    expect(userBlocks().map((b) => b.type)).toEqual(['text', 'image_url', 'text']);
    expect(userBlocks()[1]!.image_url!.url).toBe(`data:image/png;base64,${PNG_7X5}`);
  });

  it('stream（串流）', async () => {
    const chunks: unknown[] = [];
    for await (const chunk of await model('accepts').stream([message()])) chunks.push(chunk);
    expect(bodies.at(-1)!.stream).toBe(true);
    expect(userBlocks().map((b) => b.type)).toEqual(['text', 'image_url', 'text']);
  });

  it('v3 的事件串流（_streamChatModelEvents）', async () => {
    const llm = model('accepts') as unknown as {
      _streamChatModelEvents(m: BaseMessage[], o: object): AsyncGenerator<unknown>;
    };
    for await (const event of llm._streamChatModelEvents([message()], {})) void event;
    expect(userBlocks().map((b) => b.type)).toEqual(['text', 'image_url', 'text']);
  });

  it('withConfig／bindTools 建出來的新實例仍是子類，仍投影', async () => {
    const llm = model('accepts');
    const configured = llm.withConfig({ stop: ['END'] });
    expect(configured).toBeInstanceOf(AttachmentChatOpenAI);
    await configured.invoke([message()]);
    expect(userBlocks().map((b) => b.type)).toEqual(['text', 'image_url', 'text']);
    const bound = llm.bindTools([
      {
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object', properties: {} } },
      },
    ]);
    await bound.invoke([message()]);
    expect(userBlocks().map((b) => b.type)).toEqual(['text', 'image_url', 'text']);
  });
});

describe('投影的內容', () => {
  it('檔案：讀得到用可讀的措辭；讀不到用「無法存取，不要聲稱讀過」', async () => {
    await model('accepts').invoke([message()]);
    expect(userBlocks()[0]!.text).toContain('verbatim read-only copy saved at');
    await model('accepts', source({ hasFile: async () => false })).invoke([message()]);
    expect(userBlocks()[0]!.text).toContain('cannot access a readable path');
    expect(userBlocks()[0]!.text).toContain('do not claim to have read it');
  });

  it('模型宣告純文字：圖換成一行佔位字，不送位元組', async () => {
    await model('rejects').invoke([message()]);
    expect(userBlocks().map((b) => b.type)).toEqual(['text', 'text', 'text']);
    expect(userBlocks()[1]!.text).toBe(
      '[image omitted because this model accepts text only; attachment sha256:dddddddd]',
    );
    expect(bodies.at(-1)).not.toHaveProperty('messages.0.content.1.image_url');
  });

  it('沒宣告：照送圖', async () => {
    await model('undeclared').invoke([message()]);
    expect(userBlocks()[1]!.type).toBe('image_url');
  });

  it('圖的位元組讀不到：那一步不失敗，換成「請重新附上」的一行', async () => {
    await model(
      'accepts',
      source({
        readImage: async () => {
          throw new Error('沒了');
        },
      }),
    ).invoke([message()]);
    expect(userBlocks()[1]!.type).toBe('text');
    expect(userBlocks()[1]!.text).toContain('no longer available in attachment storage');
    expect(userBlocks()[1]!.text).toContain('Do not claim to have seen it');
  });

  it('被圖片額度省略的圖（#1270）：換成佔位字，不讀位元組；收圖、純文字、沒宣告都一樣', async () => {
    const omitted = new HumanMessage({
      content: [
        { type: 'nexus-image', attachment: IMAGE, offloaded: true },
        { type: 'text', text: '請看' },
      ] as never,
    });
    for (const support of ['accepts', 'rejects', 'undeclared'] as const) {
      let reads = 0;
      await model(
        support,
        source({
          readImage: async () => {
            reads += 1;
            return BYTES;
          },
        }),
      ).invoke([omitted]);
      expect(userBlocks().map((b) => b.type)).toEqual(['text', 'text']);
      expect(userBlocks()[0]!.text).toBe(
        '[image omitted to fit request image limits; image (sha256:dddddddd, 7x5). No local copy is available; ask the user to attach it again if needed.]',
      );
      expect(reads).toBe(0);
    }
  });

  it('沒有附件的訊息原樣通過（同一個陣列，不複製）', async () => {
    const plain = [new HumanMessage('嗨')];
    expect(await projectAttachments(plain, source(), 'accepts')).toBe(plain);
  });

  it('投影不動原訊息：參照還在', async () => {
    const original = message();
    await model('accepts').invoke([original]);
    expect((original.content as { type: string }[]).map((b) => b.type)).toEqual([
      'nexus-file',
      'nexus-image',
      'text',
    ]);
  });
});
